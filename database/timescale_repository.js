/**
 * @license MIT
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * TimescaleDB/PostgreSQL Repository
 *
 * Manages all WRITE operations for the perennial TimescaleDB database.
 * This is designed for high-throughput, non-blocking, fire-and-forget ingestion.
 * It will queue messages in memory and periodically batch-insert them.
 * If the connection fails, it will pause ingestion and attempt to reconnect.
 */

const { Pool } = require('pg');

// --- Module-level State ---
let logger = null;
let config = null;
let pool = null;
let isConnected = false;
let isConnecting = false;

let timescaleWriteQueue = []; // Queue for batch inserts
let timescaleBatchTimer = null; // Timer for batch processor

/**
 * Initializes the TimescaleDB repository.
 * @param {pino.Logger} appLogger
 * @param {object} appConfig
 */
async function init(appLogger, appConfig) {
    logger = appLogger.child({ component: 'TimescaleRepo' });
    config = appConfig;

    logger.info("Initializing TimescaleDB repository...");
    await connect();
    startTimescaleBatchProcessor();
}

/**
 * Attempts to connect to the PostgreSQL database.
 */
async function connect() {
    if (isConnected || isConnecting) return;
    isConnecting = true;

    try {
        pool = new Pool({
            host: config.PG_HOST,
            port: config.PG_PORT,
            user: config.PG_USER,
            password: config.PG_PASSWORD,
            database: config.PG_DATABASE,
            max: 5, // Max 5 connections in the pool
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        });

        pool.on('error', (err, client) => {
            logger.error({ err }, '❌ Unexpected error on idle PostgreSQL client');
            isConnected = false;
        });

        // Test the connection
        const client = await pool.connect();
        logger.info("✅ 🐘 Connected to TimescaleDB/PostgreSQL successfully!");
        isConnected = true;
        isConnecting = false;

        // Create table if it doesn't exist
        await createTableIfNotExists(client);
        client.release();

    } catch (err) {
        logger.error({ err }, "❌ Failed to connect to TimescaleDB/PostgreSQL. Will retry...");
        isConnecting = false;
        isConnected = false;
        // Don't retry here, the batch processor will handle retries
    }
}

/**
 * Creates the target table and hypertables if they don't exist.
 * @param {pg.Client} client - A connected client from the pool.
 */
async function createTableIfNotExists(client) {
    const tableName = config.PG_TABLE_NAME || 'mqtt_events';
    
    // 1. Create standard table
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS ${tableName} (
            timestamp TIMESTAMPTZ NOT NULL,
            topic     VARCHAR NOT NULL,
            payload   JSONB
        );
    `;
    
    // 2. Create TimescaleDB hypertable (this will fail gracefully if not Timescale)
    const createHypertableQuery = `
        SELECT create_hypertable('${tableName}', 'timestamp', if_not_exists => TRUE);
    `;

    try {
        await client.query(createTableQuery);
        logger.info(`✅    -> Table '${tableName}' verified.`);
        
        try {
            await client.query(createHypertableQuery);
            logger.info("✅    -> TimescaleDB hypertable verified.");
        } catch (hypertableError) {
            // This is expected if it's not TimescaleDB or extension isn't loaded
            if (hypertableError.code === '42704') { // undefined_function
                logger.warn("🟡 'create_hypertable' function not found. Running in standard PostgreSQL mode.");
            } else {
                logger.warn({ err: hypertableError }, "🟡 Could not create hypertable.");
            }
        }
    } catch (err) {
        logger.error({ err }, `❌ Failed to create table '${tableName}'.`);
        throw err;
    }
}

/**
 * Pushes a new message object into the TimescaleDB write queue.
 * @param {object} message - The message object from mqtt-handler.
 */
function push(message) {
    timescaleWriteQueue.push(message);
}

/**
 * Starts the interval timer for the batch processor.
 */
function startTimescaleBatchProcessor() {
    const interval = config.PG_BATCH_INTERVAL_MS || 5000;
    logger.info(`Starting TimescaleDB batch processor (Size: ${config.PG_INSERT_BATCH_SIZE}, Interval: ${interval}ms)`);
    if (timescaleBatchTimer) clearInterval(timescaleBatchTimer);
    timescaleBatchTimer = setInterval(processTimescaleQueue, interval);
}

/**
 * Formats a batch of messages for a single, parameterized INSERT query.
 * @param {Array} batch - Array of message objects.
 * @param {string} tableName - The name of the target table.
 * @returns {{query: string, values: Array}}
 */
function formatBatchForInsert(batch, tableName) {
    const values = [];
    let paramIndex = 1;
    
    const placeholders = batch.map(msg => {
        values.push(msg.timestamp, msg.topic, msg.payloadStringForDb);
        const p = `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2})`;
        paramIndex += 3;
        return p;
    }).join(',');

    const query = `INSERT INTO ${tableName} (timestamp, topic, payload) VALUES ${placeholders}`;
    return { query, values };
}

/**
 * Processes one chunk of the write queue and inserts it into TimescaleDB.
 */
async function processTimescaleQueue() {
    if (!isConnected) {
        if (!isConnecting) {
            logger.warn(`TimescaleDB is disconnected. Attempting to reconnect... Queue size: ${timescaleWriteQueue.length}`);
            await connect();
        }
        return; // Skip this cycle if not connected
    }

    const batchSize = config.PG_INSERT_BATCH_SIZE || 1000;
    const batch = timescaleWriteQueue.splice(0, batchSize);
    if (batch.length === 0) {
        return;
    }

    const tableName = config.PG_TABLE_NAME || 'mqtt_events';
    const { query, values } = formatBatchForInsert(batch, tableName);

    try {
        await pool.query(query, values);
        logger.info(`✅ 🐘 Batch inserted ${batch.length} messages into TimescaleDB. (Queue: ${timescaleWriteQueue.length})`);
    } catch (err) {
        logger.error({ err }, `❌ TimescaleDB batch insert failed. Re-queuing ${batch.length} messages.`);
        // Add the failed batch back to the *front* of the queue
        timescaleWriteQueue.unshift(...batch);
        
        // Handle connection errors
        if (err.code === 'ECONNRESET' || err.code === '57P01') { // 57P01 = admin shutdown
            logger.warn("TimescaleDB connection lost. Setting status to disconnected.");
            isConnected = false;
        }
    }
}

/**
 * Stops the batch processor and drains the queue.
 */
async function stop() {
    if (timescaleBatchTimer) {
        clearInterval(timescaleBatchTimer);
        logger.info("✅    -> Stopped TimescaleDB batch timer.");
    }
    
    if (timescaleWriteQueue.length > 0) {
        logger.info(`✅    -> Processing final ${timescaleWriteQueue.length} messages for TimescaleDB...`);
        await processTimescaleQueue(); // Process any remaining messages
    }
}

/**
 * Closes the TimescaleDB connection pool.
 * @param {function} callback
 */
async function close(callback) {
    if (pool) {
        await pool.end();
        logger.info("✅ 🐘 TimescaleDB connection pool closed.");
    }
    if (callback) callback();
}

module.exports = {
    init,
    push,
    stop,
    close
};