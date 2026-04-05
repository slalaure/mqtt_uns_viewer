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
 * Server Entry Point
 */

// --- Imports ---
const pino = require('pino');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events'); 

// --- Boot Modules ---
const { loadConfig } = require('./boot/config');
const { initDatabase } = require('./boot/database');
const { setupAuth } = require('./boot/auth');
const { initServices } = require('./boot/services');

// --- Router Module ---
const { createRouter } = require('./interfaces/web/router');

// --- Constants & Paths ---
const DATA_PATH = path.join(__dirname, 'data');
const ENV_PATH = path.join(DATA_PATH, '.env');
const ENV_EXAMPLE_PATH = path.join(__dirname, '.env.example');
const CERTS_PATH = path.join(DATA_PATH, 'certs');
const DB_PATH = path.join(DATA_PATH, 'korelate_events.duckdb');
const CHART_CONFIG_PATH = path.join(DATA_PATH, 'charts.json'); 
const SESSIONS_PATH = path.join(DATA_PATH, 'sessions');

const paths = { DATA_PATH, ENV_PATH, ENV_EXAMPLE_PATH, CERTS_PATH, DB_PATH, CHART_CONFIG_PATH, SESSIONS_PATH };

// --- Ensure Directories Exist ---
[DATA_PATH, SESSIONS_PATH].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --- Logger Setup ---
const logFilePath = path.join(DATA_PATH, 'korelate.log');
const logger = pino(pino.transport({
    targets: [
        { target: 'pino-pretty', options: { colorize: true } },
        { target: 'pino-pretty', options: { colorize: false, destination: logFilePath, mkdir: true, append: true } }
    ]
}));

// --- Initial .env Setup ---
if (!fs.existsSync(ENV_PATH)) {
    try {
        fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
        logger.info("✅ .env file created in ./data/");
    } catch (err) {
        logger.error({ err }, "❌ FATAL: Could not create .env file.");
        process.exit(1);
    }
}
require('dotenv').config({ path: ENV_PATH });

// --- Initial charts.json Setup ---
if (!fs.existsSync(CHART_CONFIG_PATH)) {
    fs.writeFileSync(CHART_CONFIG_PATH, JSON.stringify({ configurations: [] }, null, 2));
}

// --- Helper Functions ---
function longReplacer(key, value) {
    return (typeof value === 'bigint') ? value.toString() : value;
}

// --- Global State ---
let isShuttingDown = false;
let isPruning = false;
const activeConnections = new Map(); 
const connectorStatuses = new Map(); 
const i3xEvents = new EventEmitter();

const state = {
    activeConnections,
    connectorStatuses,
    i3xEvents,
    longReplacer,
    isShuttingDown: () => isShuttingDown,
    isPruning: false,
    getPrimaryConnection: () => activeConnections.size > 0 ? activeConnections.values().next().value : null,
    getConnectorConnection: (id) => id ? activeConnections.get(id) : state.getPrimaryConnection(),
    updateConnectorStatus: (sourceId, status, error = null) => {
        const info = { status, error, timestamp: Date.now() };
        connectorStatuses.set(sourceId, info);
        if (services.wsManager) services.wsManager.broadcast(JSON.stringify({ type: 'connector-status', sourceId, ...info }));
    }
};

// --- Main Bootstrap ---
let services = {};

(async () => {
    try {
        // 1. Load Configuration
        const config = loadConfig(logger, paths);

        // 3. Setup Express & HTTP
        const app = express();
        const server = http.createServer(app);
        app.enable('trust proxy');

        // 4. Setup Auth
        const userManager = require('./storage/userManager');
        setupAuth(app, config, logger, userManager, paths);

        // 5. Initialize Database
        const wsManager = require('./core/websocketManager');
        const db = await initDatabase(logger, config, paths, wsManager);

        // 5.5 Merge Dynamic Configuration from DB
        const { mergeConfigFromDb } = require('./boot/config');
        await mergeConfigFromDb(config, db, logger);

        // 6. Initialize Services
        services = initServices(server, app, db, config, logger, paths, state);

        // 7. Initialize Router
        const router = createRouter({
            config, logger, db, dbFile: DB_PATH, dbWalFile: DB_PATH + '.wal',
            dataManager: require('./storage/dataManager'),
            DATA_PATH, SESSIONS_PATH, basePath: config.BASE_PATH,
            userManager, alertManager: require('./core/engine/alertManager'),
            semanticManager: require('./core/semantic/semanticManager'),
            i3xEvents, getPrimaryConnection: state.getPrimaryConnection,
            getConnectorConnection: state.getConnectorConnection,
            simulatorManager: services.simulatorManager,
            wsManager: services.wsManager,
            mapperEngine: services.mapperEngine,
            ENV_PATH, ENV_EXAMPLE_PATH, CHART_CONFIG_PATH, 
            longReplacer, auth: require('./interfaces/web/middlewares/auth'),
            ANALYTICS_SCRIPT: '', // Add if needed
            getIsPruning: () => state.isPruning,
            setIsPruning: (val) => { state.isPruning = val; }
        });

        app.use(config.BASE_PATH, router);
        if (config.BASE_PATH !== '/') app.use('/', router);

        app.get('/', (req, res) => {
            const dest = config.BASE_PATH === '/' ? '/tree/' : config.BASE_PATH + '/tree/';
            const login = config.BASE_PATH === '/' ? '/login' : config.BASE_PATH + '/login';
            res.redirect(req.isAuthenticated() ? dest : login);
        });

        // 9. Start Server
        server.listen(config.PORT, () => {
            logger.info(`✅ HTTP server started on http://localhost:${config.PORT}`);
        });

        // --- Graceful Shutdown ---
        const gracefulShutdown = async () => {
            if (isShuttingDown) return;
            isShuttingDown = true;
            logger.info("\n✅ Gracefully shutting down...");
            setTimeout(() => process.exit(1), 5000).unref();
            try {
                const dataManager = require('./storage/dataManager');
                await dataManager.stop();
                await new Promise(r => services.wsManager.close(r));
                await new Promise(r => server.close(r));
                services.connectorManager.closeAll(); 
                await dataManager.close();
                process.exit(0);
            } catch (err) {
                logger.error({ err }, "❌ Error during shutdown.");
                process.exit(1);
            }
        };

        process.on('SIGINT', gracefulShutdown);
        process.on('SIGTERM', gracefulShutdown);
    } catch (err) {
        logger.fatal({ err }, "❌ FATAL: Server failed to start.");
        process.exit(1);
    }
})();

process.on('uncaughtException', (err) => { logger.fatal({ err }, "❌ FATAL: Uncaught Exception."); process.exit(1); });
process.on('unhandledRejection', (reason) => { logger.fatal({ err: reason }, "❌ FATAL: Unhandled Rejection."); process.exit(1); });
