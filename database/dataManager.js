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
 * Data Manager
 *
 * Orchestrates all data write operations.
 * It acts as a single entry point for the mqtt-handler and abstracts
 * away the underlying storage, fanning out messages to one or more
 * repositories (e.g., DuckDB, TimescaleDB).
 */

// Import repository modules
const duckDbRepo = require('./duckdb_repository');
const timescaleRepo = require('./timescale_repository');

// --- Module-level State ---
let logger = null;
let config = null;
let isTimescaleEnabled = false;

/**
 * Initializes the Data Manager and all configured repositories.
 * @param {object} appConfig - The global application config.
 * @param {pino.Logger} appLogger - The main pino logger.
 * @param {object} appMapperEngine - The mapper engine instance.
 * @param {duckdb.Database} dbConnection - The *active* DuckDB connection from server.js.
 * @param {function} appBroadcastDbStatus - The callback to broadcast DB status.
 */
function init(appConfig, appLogger, appMapperEngine, dbConnection, appBroadcastDbStatus) {
    logger = appLogger.child({ component: 'DataManager' });
    config = appConfig;
    
    // 1. Initialize the DuckDB repository (always enabled for the UI)
    // We pass the active DB connection to it.
    duckDbRepo.init(appLogger, appConfig, dbConnection, appBroadcastDbStatus, appMapperEngine);
    
    // 2. Check and initialize the perennial repository (e.g., Timescale)
    isTimescaleEnabled = config.PERENNIAL_DRIVER === 'timescale';
    if (isTimescaleEnabled) {
        logger.info(`Perennial storage driver '${config.PERENNIAL_DRIVER}' is enabled. Initializing...`);
        timescaleRepo.init(appLogger, appConfig);
    } else {
        logger.info("Perennial storage driver is set to 'none'. Only writing to DuckDB.");
    }
    
    logger.info("✅ Data Manager initialized.");
}

/**
 * Inserts a message into all configured storage repositories.
 * This is a non-blocking, "fire-and-forget" function.
 * @param {object} message - The message object from mqtt-handler.
 */
function insertMessage(message) {
    // 1. Always push to DuckDB for the UI
    duckDbRepo.push(message);
    
    // 2. Push to perennial storage if enabled
    if (isTimescaleEnabled) {
        timescaleRepo.push(message);
    }
}

/**
 * Signals all repositories to stop their batch timers and process remaining queues.
 */
function stop() {
    logger.info("Stopping all repository batch processors...");
    duckDbRepo.stop();
    if (isTimescaleEnabled) {
        timescaleRepo.stop();
    }
}

/**
 * Asynchronously closes all active database connections.
 * @returns {Promise<void>}
 */
async function close() {
    logger.info("Closing all database connections...");
    
    // Create promises for each closing operation
    const duckDbClosePromise = new Promise((resolve) => {
        duckDbRepo.close(resolve);
    });
    
    const timescaleClosePromise = new Promise((resolve) => {
        if (isTimescaleEnabled) {
            timescaleRepo.close(resolve);
        } else {
            resolve(); // Resolve immediately if not enabled
        }
    });

    // Wait for both to complete
    await Promise.all([duckDbClosePromise, timescaleClosePromise]);
    logger.info("All database connections closed.");
}

module.exports = {
    init,
    insertMessage,
    stop,
    close
};