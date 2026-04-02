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
 * [UPDATED] Refactored to extend BaseRepository, inheriting batch queue logic.
 * [UPDATED] Implemented Smart Queue Compaction to prevent OOM without losing rare events.
 */

const BaseRepository = require('./baseRepository');

const MAX_QUEUE_SIZE = 20000;

class DuckDBRepository extends BaseRepository {
    constructor() {
        super({}, {}, 'DuckDBRepo');
        this.db = null;
        this.mapperEngine = null;
        this.broadcastDbStatus = null;
        this.dlqManager = null;
    }

    /**
     * Initializes the DuckDB repository.
     */
    init(appLogger, appConfig, dbConnection, appBroadcastDbStatus, appMapperEngine, appDlqManager) {
        this.logger = appLogger.child({ component: 'DuckDBRepo' });
        this.config = appConfig;
        this.db = dbConnection; 
        this.broadcastDbStatus = appBroadcastDbStatus;
        this.mapperEngine = appMapperEngine;
        this.dlqManager = appDlqManager;

        this.batchSize = this.config.DB_INSERT_BATCH_SIZE || 5000;
        this.batchIntervalMs = this.config.DB_BATCH_INTERVAL_MS || 2000;

        this.logger.info("✅ 🦆 DuckDB Repository initialized.");
        this.startBatchProcessor();
    }

    /**
     * Pushes a new message object into the DuckDB write queue.
     * Includes Smart Compaction to prevent OOM.
     */
    push(message) {
        super.push(message);

        // Smart Compaction: Protect against OOM by deduplicating high-frequency spam
        // while perfectly preserving rare/low-frequency events (like alarms).
        if (this.writeQueue.length > MAX_QUEUE_SIZE) {
            this.logger.warn(`⚠️ DuckDB write queue reached ${MAX_QUEUE_SIZE}. Triggering Smart Compaction...`);
            const compactedMap = new Map();
            
            // Loop through the queue. Map.set will overwrite older messages 
            // with the same topic, keeping only the latest state per topic.
            for (const msg of this.writeQueue) {
                compactedMap.set(msg.brokerId + '|' + msg.topic, msg);
            }
            
            const oldLength = this.writeQueue.length;
            this.writeQueue = Array.from(compactedMap.values());
            this.logger.info(`✅ Queue compacted from ${oldLength} to ${this.writeQueue.length} unique topics.`);
            
            // Fallback: If there are legitimately > 20000 unique topics bursting at once
            if (this.writeQueue.length > MAX_QUEUE_SIZE) {
                 this.writeQueue.splice(0, this.writeQueue.length - 15000);
                 this.logger.warn(`⚠️ Hard limit applied. Dropped oldest messages.`);
            }
        }

        // We only broadcast status on push, not on write
        if (this.broadcastDbStatus) this.broadcastDbStatus();
    }

    /**
     * Processes one chunk of the write queue and inserts it into DuckDB.
     */
    async processQueue() {
        const batch = this.writeQueue.splice(0, this.batchSize);
        
        if (batch.length === 0) {
            return;
        }

        if (!this.db) {
            this.logger.error("DuckDB processQueue skipped, DB connection not ready.");
            this.writeQueue.unshift(...batch);
            return;
        }

        this.db.serialize(() => {
            this.db.run('BEGIN TRANSACTION;', (err) => {
                if (err) return this.logger.error({ err }, "DB Batch: Failed to BEGIN TRANSACTION");
            });

            // Use CAST(? AS TIMESTAMPTZ) in the SQL.
            // We will pass the ISO string directly. DuckDB handles ISO strings with 'Z' correctly 
            // as UTC when cast to TIMESTAMPTZ, preventing the 1h offset.
            const stmt = this.db.prepare('INSERT INTO mqtt_events (timestamp, topic, payload, broker_id, correlation_id) VALUES (CAST(? AS TIMESTAMPTZ), ?, ?, ?, ?)');
            let errorCount = 0;

            for (const msg of batch) {
                const timestampIso = msg.timestamp.toISOString();
                
                stmt.run(timestampIso, msg.topic, msg.payloadStringForDb, msg.brokerId, msg.correlationId || null, (runErr) => {
                    if (runErr) {
                        this.logger.warn({ err: runErr, topic: msg.topic }, "DB Batch: Failed to insert one message");
                        errorCount++;
                    }
                });
            }

            stmt.finalize((finalizeErr) => {
                if (finalizeErr) {
                     this.logger.error({ err: finalizeErr }, "DB Batch: Failed to finalize statement");
                     this.db.run('ROLLBACK;'); 
                     if (this.dlqManager) this.dlqManager.push(batch);
                     return;
                }

                if (errorCount > 0) {
                    this.logger.warn(`DB Batch: ${errorCount} errors, rolling back transaction.`);
                    this.db.run('ROLLBACK;');
                    if (this.dlqManager) this.dlqManager.push(batch);
                } else {
                    this.db.run('COMMIT;', (commitErr) => {
                        if (commitErr) {
                            this.logger.error({ err: commitErr }, "DB Batch: Failed to COMMIT transaction");
                            if (this.dlqManager) this.dlqManager.push(batch);
                        } else {
                            this.logger.info(`✅ 🦆 Batch inserted ${batch.length} messages into DuckDB.`);

                            // Trigger mappers that were waiting for this data
                            (async () => {
                                for (const msg of batch) {
                                    if (msg.needsDb) { 
                                        try {
                                            const payloadObject = JSON.parse(msg.payloadStringForDb);
                                            await this.mapperEngine.processMessage(
                                                msg.brokerId,
                                                msg.topic, 
                                                payloadObject,
                                                msg.isSparkplugOrigin,
                                                msg.correlationId
                                            );
                                        } catch (mapperErr) {
                                            this.logger.error({ err: mapperErr, topic: msg.topic }, "Mapper trigger failed after batch.");
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
     * Closes the DuckDB connection.
     */
    async close(callback) {
        this.logger.info("Closing DuckDB connection...");
        if (this.db) {
            this.db.close((err) => {
                if (err) this.logger.error({ err }, "Error closing DuckDB:");
                else this.logger.info("✅ 🦆 DuckDB connection closed.");
                if (callback) callback();
            });
        } else {
            if (callback) callback();
        }
    }
}

module.exports = new DuckDBRepository();