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
 * TimescaleDB/PostgreSQL Repository
 *
 * Manages all WRITE operations for the perennial TimescaleDB database.
 * This is designed for high-throughput, non-blocking, fire-and-forget ingestion.
 * [UPDATED] Refactored to extend BaseRepository, inheriting batch queue logic.
 * [UPDATED] Hardened queue with MAX_QUEUE_SIZE and DLQ offloading to prevent OOM.
 */

const { Pool } = require('pg');
const BaseRepository = require('./baseRepository');

const MAX_QUEUE_SIZE = 20000;
const FLUSH_CHUNK_SIZE = 5000;

class TimescaleRepository extends BaseRepository {
    constructor() {
        super({}, {}, 'TimescaleRepo');
        this.pool = null;
        this.isConnected = false;
        this.isConnecting = false;
        this.dlqManager = null;
    }

    /**
     * Initializes the TimescaleDB repository.
     */
    async init(appLogger, appConfig, appDlqManager) {
        this.logger = appLogger.child({ component: 'TimescaleRepo' });
        this.config = appConfig;
        this.dlqManager = appDlqManager;
        
        this.batchSize = this.config.PG_INSERT_BATCH_SIZE || 1000;
        this.batchIntervalMs = this.config.PG_BATCH_INTERVAL_MS || 5000;

        this.logger.info("Initializing TimescaleDB repository...");
        await this.connect();
        this.startBatchProcessor();
    }

    /**
     * Attempts to connect to the PostgreSQL database.
     */
    async connect() {
        if (this.isConnected || this.isConnecting) return;
        this.isConnecting = true;

        try {
            this.pool = new Pool({
                host: this.config.PG_HOST,
                port: this.config.PG_PORT,
                user: this.config.PG_USER,
                password: this.config.PG_PASSWORD,
                database: this.config.PG_DATABASE,
                max: 5, // Max 5 connections in the pool
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 5000,
            });

            this.pool.on('error', (err, client) => {
                this.logger.error({ err }, '❌ Unexpected error on idle PostgreSQL client');
                this.isConnected = false;
            });

            // Test the connection
            const client = await this.pool.connect();
            this.logger.info("✅ 🐘 Connected to TimescaleDB/PostgreSQL successfully!");
            this.isConnected = true;
            this.isConnecting = false;

            // Create table if it doesn't exist
            await this.createTableIfNotExists(client);
            client.release();

        } catch (err) {
            this.logger.error({ err }, "❌ Failed to connect to TimescaleDB/PostgreSQL. Will retry...");
            this.isConnecting = false;
            this.isConnected = false;
            // Don't retry here, the batch processor will handle retries
        }
    }

    /**
     * Creates the target table and hypertables if they don't exist.
     */
    async createTableIfNotExists(client) {
        const tableName = this.config.PG_TABLE_NAME || 'mqtt_events';
        
        // 1. Create standard table
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS ${tableName} (
                timestamp TIMESTAMPTZ NOT NULL,
                topic     VARCHAR NOT NULL,
                payload   JSONB,
                broker_id VARCHAR,
                correlation_id VARCHAR
            );
        `;
        
        // 2. Create TimescaleDB hypertable (this will fail gracefully if not Timescale)
        const createHypertableQuery = `
            SELECT create_hypertable('${tableName}', 'timestamp', if_not_exists => TRUE);
        `;

        try {
            await client.query(createTableQuery);
            this.logger.info(`✅    -> Table '${tableName}' verified (schema includes broker_id).`);
            
            try {
                await client.query(createHypertableQuery);
                this.logger.info("✅    -> TimescaleDB hypertable verified.");
            } catch (hypertableError) {
                // This is expected if it's not TimescaleDB or extension isn't loaded
                if (hypertableError.code === '42704') { // undefined_function
                    this.logger.warn("🟡 'create_hypertable' function not found. Running in standard PostgreSQL mode.");
                } else {
                    this.logger.warn({ err: hypertableError }, "🟡 Could not create hypertable.");
                }
            }
        } catch (err) {
            this.logger.error({ err }, `❌ Failed to create table '${tableName}'.`);
            throw err;
        }
    }

    /**
     * Pushes a new message object into the TimescaleDB write queue.
     * Prevents OOM by offloading excess messages to the DLQ.
     */
    push(message) {
        super.push(message);

        if (this.writeQueue.length > MAX_QUEUE_SIZE) {
            this.logger.warn(`⚠️ TimescaleDB write queue exceeded ${MAX_QUEUE_SIZE}. Flushing ${FLUSH_CHUNK_SIZE} oldest messages to DLQ to prevent OOM.`);
            
            // Extract the oldest messages and push them to disk
            const excessMessages = this.writeQueue.splice(0, FLUSH_CHUNK_SIZE);
            if (this.dlqManager) {
                this.dlqManager.push(excessMessages);
            }
        }
    }

    /**
     * Formats a batch of messages for a single, parameterized INSERT query.
     */
    formatBatchForInsert(batch, tableName) {
        const values = [];
        let paramIndex = 1;
        
        const placeholders = batch.map(msg => {
            values.push(msg.timestamp, msg.topic, msg.payloadStringForDb, msg.brokerId, msg.correlationId || null);
            const p = `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4})`;
            paramIndex += 5;
            return p;
        }).join(',');

        const query = `INSERT INTO ${tableName} (timestamp, topic, payload, broker_id, correlation_id) VALUES ${placeholders}`;
        return { query, values };
    }

    /**
     * Processes one chunk of the write queue and inserts it into TimescaleDB.
     */
    async processQueue() {
        if (!this.isConnected) {
            if (!this.isConnecting) {
                this.logger.warn(`TimescaleDB is disconnected. Attempting to reconnect... Queue size: ${this.writeQueue.length}`);
                await this.connect();
            }
            return; // Skip this cycle if not connected
        }

        const batch = this.writeQueue.splice(0, this.batchSize);
        if (batch.length === 0) {
            return;
        }

        const tableName = this.config.PG_TABLE_NAME || 'mqtt_events';
        const { query, values } = this.formatBatchForInsert(batch, tableName);

        try {
            await this.pool.query(query, values);
            this.logger.info(`✅ 🐘 Batch inserted ${batch.length} messages into TimescaleDB. (Queue: ${this.writeQueue.length})`);
        } catch (err) {
            // Distinguish between transient connection errors and non-recoverable errors
            const isTransient = err.code && (err.code.startsWith('08') || err.code.startsWith('57') || err.code === 'ECONNRESET');
            
            if (isTransient) {
                this.logger.error({ err: err.message, code: err.code }, `❌ TimescaleDB batch insert failed (Transient). Re-queuing ${batch.length} messages.`);
                this.writeQueue.unshift(...batch);
                this.isConnected = false;
            } else {
                this.logger.error({ err: err.message, code: err.code }, `❌ TimescaleDB batch insert failed (Non-recoverable). Sending ${batch.length} messages to DLQ.`);
                if (this.dlqManager) {
                    this.dlqManager.push(batch);
                }
            }
        }
    }

    /**
     * Closes the TimescaleDB connection pool.
     */
    async close(callback) {
        if (this.pool) {
            await this.pool.end();
            this.logger.info("✅ 🐘 TimescaleDB connection pool closed.");
        }
        if (callback) callback();
    }
}

module.exports = new TimescaleRepository();