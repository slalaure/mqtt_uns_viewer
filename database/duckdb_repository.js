/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * DuckDB Repository
 *
 * Manages all WRITE operations for the embedded DuckDB database.
 * [UPDATED] Forces ISO String insertion to fix Timezone shift (1h delay).
 */
// --- Module-level State ---
let logger = null;
let config = null;
let db = null; // The database connection
let mapperEngine = null;
let broadcastDbStatus = null;

let dbWriteQueue = []; // Queue for batch inserts
let dbBatchTimer = null; // Timer for batch processor

/**
 * Initializes the DuckDB repository.
 * @param {pino.Logger} appLogger
 * @param {object} appConfig
 * @param {duckdb.Database} dbConnection - The active DuckDB connection.
 * @param {function} appBroadcastDbStatus
 * @param {object} appMapperEngine
 */
function init(appLogger, appConfig, dbConnection, appBroadcastDbStatus, appMapperEngine) {
    logger = appLogger.child({ component: 'DuckDBRepo' });
    config = appConfig;
    db = dbConnection; // Use the connection from server.js
    broadcastDbStatus = appBroadcastDbStatus;
    mapperEngine = appMapperEngine;

    logger.info("✅ 🦆 DuckDB Repository initialized.");
    startDbBatchProcessor();
}

/**
 * Pushes a new message object into the DuckDB write queue.
 * @param {object} message - The message object from mqtt-handler.
 */
function push(message) {
    dbWriteQueue.push(message);
    // We only broadcast status on push, not on write,
    // to give a more immediate feeling of ingestion.
    broadcastDbStatus();
}

/**
 * Starts the interval timer for the batch processor.
 */
function startDbBatchProcessor() {
    logger.info(`Starting DB batch processor (Size: ${config.DB_INSERT_BATCH_SIZE}, Interval: ${config.DB_BATCH_INTERVAL_MS}ms)`);
    if (dbBatchTimer) clearInterval(dbBatchTimer);
    dbBatchTimer = setInterval(processDbQueue, config.DB_BATCH_INTERVAL_MS);
}

/**
 * Processes one chunk of the write queue and inserts it into DuckDB.
 */
function processDbQueue() {
    const batch = dbWriteQueue.splice(0, config.DB_INSERT_BATCH_SIZE);
    if (batch.length === 0) {
        return;
    }

    if (!db) {
        logger.error("DuckDB processQueue skipped, DB connection not ready.");
        dbWriteQueue.unshift(...batch);
        return;
    }

    // [DEBUG] Log the timestamp of the first item to verify system time vs data time
    // const firstItemTs = batch[0].timestamp;
    // const now = new Date();
    // logger.info(`[DB Debug] Inserting batch. First TS: ${firstItemTs.toISOString()} (System: ${now.toISOString()})`);

    db.serialize(() => {
        db.run('BEGIN TRANSACTION;', (err) => {
            if (err) return logger.error({ err }, "DB Batch: Failed to BEGIN TRANSACTION");
        });

        // [CRITICAL FIX] Use CAST(? AS TIMESTAMPTZ) in the SQL.
        // We will pass the ISO string directly. DuckDB handles ISO strings with 'Z' correctly 
        // as UTC when cast to TIMESTAMPTZ, preventing the 1h offset.
        const stmt = db.prepare('INSERT INTO mqtt_events (timestamp, topic, payload, broker_id) VALUES (CAST(? AS TIMESTAMPTZ), ?, ?, ?)');
        let errorCount = 0;

        for (const msg of batch) {
            // [CRITICAL FIX] Explicitly convert Date object to ISO String.
            // This ensures "2026-02-03T16:30:00.000Z" is passed, preserving the 'Z'.
            const timestampIso = msg.timestamp.toISOString();

            stmt.run(timestampIso, msg.topic, msg.payloadStringForDb, msg.brokerId, (runErr) => {
                if (runErr) {
                    logger.warn({ err: runErr, topic: msg.topic }, "DB Batch: Failed to insert one message");
                    errorCount++;
                }
            });
        }

        stmt.finalize((finalizeErr) => {
            if (finalizeErr) {
                 logger.error({ err: finalizeErr }, "DB Batch: Failed to finalize statement");
                 db.run('ROLLBACK;'); 
                 return;
            }

            if (errorCount > 0) {
                logger.warn(`DB Batch: ${errorCount} errors, rolling back transaction.`);
                db.run('ROLLBACK;');
            } else {
                db.run('COMMIT;', (commitErr) => {
                    if (commitErr) {
                        logger.error({ err: commitErr }, "DB Batch: Failed to COMMIT transaction");
                    } else {
                        logger.info(`✅ 🦆 Batch inserted ${batch.length} messages into DuckDB.`);
                        
                        // Trigger mappers that were waiting for this data
                        (async () => {
                            for (const msg of batch) {
                                if (msg.needsDb) { 
                                    try {
                                        const payloadObject = JSON.parse(msg.payloadStringForDb);
                                        //  Pass brokerId to mapper
                                        await mapperEngine.processMessage(
                                            msg.brokerId,
                                            msg.topic, 
                                            payloadObject,
                                            msg.isSparkplugOrigin
                                        );
                                    } catch (mapperErr) {
                                        logger.error({ err: mapperErr, topic: msg.topic }, "Mapper trigger failed after batch.");
                                    }
                                }
                            }
                        })();
                    }
                });
            }
        });
    });
}

/**
 * Stops the batch processor.
 */
function stop() {
    if (dbBatchTimer) {
        clearInterval(dbBatchTimer);
        logger.info("✅    -> Stopped DuckDB batch timer.");
        logger.info("✅    -> Processing final DuckDB write queue...");
        processDbQueue(); // Process any remaining messages
    }
}

/**
 * Closes the DuckDB connection.
 * @param {function} callback
 */
function close(callback) {
    logger.info("Closing DuckDB connection...");
    db.close((err) => {
        if (err) logger.error({ err }, "Error closing DuckDB:");
        else logger.info("✅ 🦆 DuckDB connection closed.");
        if (callback) callback();
    });
}

module.exports = {
    init,
    push,
    stop,
    close,
    processDbQueue
};