/**
 * @license MIT
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * DuckDB Repository
 *
 * Manages all WRITE operations for the embedded DuckDB database.
 * This includes batch inserting for performance.
 * READ operations are still performed directly on the 'db' object for now.
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

    // [MODIFIED] Check if db connection is valid
    if (!db) {
        logger.error("DuckDB processQueue skipped, DB connection not ready.");
        // Put items back in queue
        dbWriteQueue.unshift(...batch);
        return;
    }

    db.serialize(() => {
        db.run('BEGIN TRANSACTION;', (err) => {
            if (err) return logger.error({ err }, "DB Batch: Failed to BEGIN TRANSACTION");
        });

        const stmt = db.prepare('INSERT INTO mqtt_events (timestamp, topic, payload) VALUES (?, ?, ?)');
        let errorCount = 0;

        for (const msg of batch) {
            stmt.run(msg.timestamp, msg.topic, msg.payloadStringForDb, (runErr) => {
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
                        // Note: broadcastDbStatus() is now called on push() for better UI feedback
                        
                        // Trigger mappers that were waiting for this data
                        (async () => {
                            for (const msg of batch) {
                                if (msg.needsDb) { 
                                    try {
                                        const payloadObject = JSON.parse(msg.payloadStringForDb);
                                        await mapperEngine.processMessage(
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
    // Checkpoint is good practice, but close() handles WAL
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