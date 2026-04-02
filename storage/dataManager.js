/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025-2026 Sebastien Lalaurette
 *
 * Data Manager
 *
 * Orchestrates all data write operations.
 * It acts as a single entry point for the mqtt-handler and abstracts
 * away the underlying storage, fanning out messages to one or more
 * repositories (e.g., DuckDB, TimescaleDB, Azure Tables, DynamoDB, AVEVA PI, BigQuery).
 * [UPDATED] Uses camelCase repository filenames.
 * [UPDATED] Refactored to fully abstract repositories into a dynamic registry for easier testing and extension.
 * [UPDATED] Added getPerennialSchema and queryPerennial to expose long-term storage to the LLM agent.
 */
// Import repository modules
const duckDbRepo = require('./duckdbRepository');
const timescaleRepo = require('./timescaleRepository');
const azureTableRepo = require('./azureTableRepository');
const dynamoDbRepo = require('./dynamoDbRepository');
const piSystemRepo = require('./piSystemRepository');
const bigQueryRepo = require('./bigQueryRepository');
const dlqManager = require('./dlqManager');

// --- Module-level State ---
let logger = null;
let config = null;
let activeRepositories = [];
let perennialRepository = null; // [NEW] Stores the active perennial driver for querying

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
    perennialRepository = null;

    // 0. Initialize the DLQ (Dead Letter Queue) manager
    dlqManager.init(appLogger, appConfig);

    // Clear any previously registered repos (useful for testing re-initialization)
    activeRepositories = [];

    // 1. Initialize the DuckDB repository (always enabled for the UI)
    // We pass the active DB connection to it.
    duckDbRepo.init(appLogger, appConfig, dbConnection, appBroadcastDbStatus, appMapperEngine, dlqManager);
    registerRepository(duckDbRepo);

    // 2. Check and initialize the perennial repository
    if (config.PERENNIAL_DRIVER === 'timescale') {
        logger.info(`Perennial storage driver '${config.PERENNIAL_DRIVER}' is enabled. Initializing...`);
        timescaleRepo.init(appLogger, appConfig, dlqManager);
        registerRepository(timescaleRepo);
        perennialRepository = timescaleRepo;
    } else if (config.PERENNIAL_DRIVER === 'azure_table') {
        logger.info(`Perennial storage driver '${config.PERENNIAL_DRIVER}' is enabled. Initializing...`);
        azureTableRepo.init(appLogger, appConfig, dlqManager);
        registerRepository(azureTableRepo);
        perennialRepository = azureTableRepo;
    } else if (config.PERENNIAL_DRIVER === 'dynamodb') {
        logger.info(`Perennial storage driver '${config.PERENNIAL_DRIVER}' is enabled. Initializing...`);
        dynamoDbRepo.init(appLogger, appConfig, dlqManager);
        registerRepository(dynamoDbRepo);
        perennialRepository = dynamoDbRepo;
    } else if (config.PERENNIAL_DRIVER === 'aveva_pi') {
        logger.info(`Perennial storage driver '${config.PERENNIAL_DRIVER}' is enabled. Initializing...`);
        piSystemRepo.init(appLogger, appConfig, dlqManager);
        registerRepository(piSystemRepo);
        perennialRepository = piSystemRepo;
    } else if (config.PERENNIAL_DRIVER === 'bigquery') {
        logger.info(`Perennial storage driver '${config.PERENNIAL_DRIVER}' is enabled. Initializing...`);
        bigQueryRepo.init(appLogger, appConfig, dlqManager);
        registerRepository(bigQueryRepo);
        perennialRepository = bigQueryRepo;
    } else {
        logger.info(`Perennial storage driver is set to '${config.PERENNIAL_DRIVER || 'none'}'. Only writing to default repositories.`);
    }

    logger.info("✅ Data Manager initialized.");
}

/**
 * Registers a new storage repository dynamically.
 * @param {object} repo - The repository module (must expose at least a push() method).
 */
function registerRepository(repo) {
    if (repo && typeof repo.push === 'function') {
        activeRepositories.push(repo);
    } else if (logger) {
        logger.warn("Attempted to register an invalid repository. It must implement a push() method.");
    }
}

/**
 * Clears all active repositories. Useful for teardown in unit tests.
 */
function clearRepositories() {
    activeRepositories = [];
    perennialRepository = null;
}

/**
 * Inserts a message into all configured storage repositories.
 * This is a non-blocking, "fire-and-forget" function fanning out to the registry.
 * @param {object} message - The message object from mqtt-handler.
 */
function insertMessage(message) {
    for (const repo of activeRepositories) {
        try {
            repo.push(message);
        } catch (err) {
            if (logger) logger.error({ err, repoName: repo.name || 'unknown' }, "Error pushing message to repository.");
        }
    }
}

/**
 * Retrieves the schema/dialect of the active perennial storage.
 * @returns {Promise<Object>}
 */
async function getPerennialSchema() {
    if (!perennialRepository) {
        throw new Error("No perennial storage driver is currently enabled.");
    }
    if (typeof perennialRepository.getSchema !== 'function') {
        throw new Error(`The active perennial driver '${config.PERENNIAL_DRIVER}' does not support schema inspection yet.`);
    }
    return await perennialRepository.getSchema();
}

/**
 * Executes a native query against the active perennial storage.
 * @param {string} query - The native query (SQL, PartiQL, etc.)
 * @returns {Promise<Array>}
 */
async function queryPerennial(query) {
    if (!perennialRepository) {
        throw new Error("No perennial storage driver is currently enabled.");
    }
    if (typeof perennialRepository.query !== 'function') {
        throw new Error(`The active perennial driver '${config.PERENNIAL_DRIVER}' does not support direct querying yet.`);
    }
    return await perennialRepository.query(query);
}

/**
 * Signals all repositories to stop their batch timers and process remaining queues.
 * @returns {Promise<void>}
 */
async function stop() {
    logger.info("Stopping all repository batch processors...");
    const stopPromises = activeRepositories.map(repo => {
        if (typeof repo.stop === 'function') {
            const result = repo.stop();
            // Handle both sync and async stop methods gracefully
            return result instanceof Promise ? result : Promise.resolve(result);
        }
        return Promise.resolve();
    });

    await Promise.all(stopPromises);
}

/**
 * Asynchronously closes all active database connections.
 * @returns {Promise<void>}
 */
async function close() {
    logger.info("Closing all database connections...");

    const closePromises = activeRepositories.map(repo => {
        return new Promise((resolve) => {
            if (typeof repo.close === 'function') {
                repo.close(resolve);
            } else {
                resolve(); // Resolve immediately if the repo has no close method
            }
        });
    });

    await Promise.all(closePromises);
    logger.info("All database connections closed.");
}

module.exports = {
    init,
    insertMessage,
    getPerennialSchema,
    queryPerennial,
    stop,
    close,
    registerRepository,
    clearRepositories
};