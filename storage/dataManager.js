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
 */
function init(appConfig, appLogger, appMapperEngine, dbConnection, appBroadcastDbStatus) {
    logger = appLogger.child({ component: 'DataManager' });
    config = appConfig;
    perennialRepository = null;

    // 0. Initialize the DLQ (Dead Letter Queue) manager
    dlqManager.init(appLogger, appConfig);
    
    // Register the retry handler to allow DLQ to re-attempt insertions
    dlqManager.registerRetryHandler(retryMessage);

    // Clear any previously registered repos
    activeRepositories = [];

    // 1. Initialize the DuckDB repository
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
 */
function registerRepository(repo) {
    if (repo && typeof repo.push === 'function') {
        activeRepositories.push(repo);
    } else if (logger) {
        logger.warn("Attempted to register an invalid repository. It must implement a push() method.");
    }
}

/**
 * Clears all active repositories.
 */
function clearRepositories() {
    activeRepositories = [];
    perennialRepository = null;
}

/**
 * Inserts a message into all configured storage repositories.
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
 * Re-attempts to insert a message into a specific repository (used by DLQ).
 * @param {string} repoName - The name of the repository to target.
 * @param {Object} message - The original message object.
 */
async function retryMessage(repoName, message) {
    const repo = activeRepositories.find(r => r.name === repoName);
    if (!repo) {
        throw new Error(`Repository ${repoName} not found or not active.`);
    }
    
    // Most repos use a background batch processor. 
    // For retries, we want to know if it succeeded.
    // However, repo.push() is usually sync and just adds to a queue.
    
    // We'll call push() and assume it succeeded in queuing.
    // If the repo is disconnected, it might throw or the next batch will fail again.
    // To properly support exponential backoff, the repo should ideally provide a way 
    // to check its health or perform a sync insert.
    
    // For now, if the repo is a TimescaleRepo or similar, check its isConnected status.
    if (Object.prototype.hasOwnProperty.call(repo, 'isConnected') && !repo.isConnected) {
        throw new Error(`Repository ${repoName} is currently disconnected.`);
    }

    if (Object.prototype.hasOwnProperty.call(repo, 'db') && !repo.db && repo.name === 'DuckDBRepo') {
        throw new Error(`Repository ${repoName} is not ready (DuckDB connection null).`);
    }

    repo.push(message);
}

/**
 * Retrieves the schema/dialect of the active perennial storage.
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
 */
async function stop() {
    logger.info("Stopping all repository batch processors...");
    const stopPromises = activeRepositories.map(repo => {
        if (typeof repo.stop === 'function') {
            const result = repo.stop();
            return result instanceof Promise ? result : Promise.resolve(result);
        }
        return Promise.resolve();
    });

    await Promise.all(stopPromises);
}

/**
 * Asynchronously closes all active database connections.
 */
async function close() {
    logger.info("Closing all database connections...");

    const closePromises = activeRepositories.map(repo => {
        return new Promise((resolve) => {
            if (typeof repo.close === 'function') {
                repo.close(resolve);
            } else {
                resolve();
            }
        });
    });

    await Promise.all(closePromises);
    logger.info("All database connections closed.");
}

module.exports = {
    init,
    insertMessage,
    retryMessage,
    getPerennialSchema,
    queryPerennial,
    stop,
    close,
    registerRepository,
    clearRepositories
};