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
 * Server Entry Point
 * [UPDATED] Staggered simulator auto-start to prevent CPU spikes and event loop blocking.
 * [UPDATED] Configured Pino logger to write to both stdout and data/korelate.log for Admin UI.
 */

// --- Imports ---
const pino = require('pino');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const duckdb = require('duckdb');
const { EventEmitter } = require('events'); 

// --- Auth Module ---
const auth = require('./interfaces/web/middlewares/auth');

// --- Router Module ---
const { createRouter } = require('./interfaces/web/router');

// --- Module Imports  ---
const wsManager = require('./core/websocketManager');
const connectorManager = require('./connectors/connectorManager'); 
const simulatorManager = require('./core/simulatorManager');
const dataManager = require('./storage/dataManager'); 
const userManager = require('./storage/userManager'); 
const alertManager = require('./core/engine/alertManager'); 
const semanticManager = require('./core/semantic/semanticManager'); 
const webhookManager = require('./core/webhookManager');

// --- Constants & Paths ---
const DATA_PATH = path.join(__dirname, 'data');
const ENV_PATH = path.join(DATA_PATH, '.env');
const ENV_EXAMPLE_PATH = path.join(__dirname, '.env.example');
const CERTS_PATH = path.join(DATA_PATH, 'certs');
const DB_PATH = path.join(DATA_PATH, 'mqtt_events.duckdb');
const CHART_CONFIG_PATH = path.join(DATA_PATH, 'charts.json'); 
const SESSIONS_PATH = path.join(DATA_PATH, 'sessions');

// Ensure data directory exists early for the logger
if (!fs.existsSync(DATA_PATH)) {
    try { fs.mkdirSync(DATA_PATH, { recursive: true }); } catch (e) {}
}

// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_PATH)) {
    try { fs.mkdirSync(SESSIONS_PATH, { recursive: true }); } catch (e) {}
}

// --- Analytics Script ---
const ANALYTICS_SCRIPT = `
    <script type="text/javascript">
        (function(c,l,a,r,i,t,y){
            c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
            t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
            y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
        })(window, document, "clarity", "script", "u3mhr7cn0n");
    </script>
`;

// --- Logger Setup ---
const logFilePath = path.join(DATA_PATH, 'korelate.log');
const logger = pino(pino.transport({
    targets: [
        {
            target: 'pino-pretty',
            options: { colorize: true }
        },
        {
            target: 'pino-pretty',
            options: { 
                colorize: false,
                destination: logFilePath,
                mkdir: true,
                append: true
            }
        }
    ]
}));

// --- Initial .env File Setup ---
if (!fs.existsSync(ENV_PATH)) {
    logger.info("✅ No .env file found in 'data' directory. Creating one from project root .env.example...");
    try {
        fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
        logger.info("✅ .env file created successfully in ./data/");
    } catch (err) {
        logger.error({ err }, "❌ FATAL ERROR: Could not create .env file.");
        process.exit(1);
    }
}
require('dotenv').config({ path: ENV_PATH });

// --- Initial charts.json File Setup ---
if (!fs.existsSync(CHART_CONFIG_PATH)) {
    try {
        fs.writeFileSync(CHART_CONFIG_PATH, JSON.stringify({ configurations: [] }, null, 2));
    } catch (err) { /* ignore */ }
}

// --- Helper Function for Sparkplug (handles BigInt) ---
function longReplacer(key, value) {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    return value;
}

// --- Global Variables ---
let activeConnections = new Map(); 
let brokerStatuses = new Map(); 
let isPruning = false;
let apiKeysConfig = { keys: [] };
let isShuttingDown = false; // Global shutdown flag
const i3xEvents = new EventEmitter(); // Global Event Bus for I3X SSE

// --- Configuration from Environment ---
const config = {
    BROKER_CONFIGS: [],
    DATA_PROVIDERS: [], // Extended generic data providers configuration
    MQTT_BROKER_HOST: process.env.MQTT_BROKER_HOST?.trim() || null,
    MQTT_TOPIC: process.env.MQTT_TOPIC?.trim() || null,
    CLIENT_ID: process.env.CLIENT_ID?.trim() || null,
    IS_SIMULATOR_ENABLED: process.env.SIMULATOR_ENABLED === 'true',
    IS_SPARKPLUG_ENABLED: process.env.SPARKPLUG_ENABLED === 'true',
    PORT: process.env.PORT || 8080,
    DUCKDB_MAX_SIZE_MB: process.env.DUCKDB_MAX_SIZE_MB ? parseInt(process.env.DUCKDB_MAX_SIZE_MB, 10) : null,
    DUCKDB_PRUNE_CHUNK_SIZE: process.env.DUCKDB_PRUNE_CHUNK_SIZE ? parseInt(process.env.DUCKDB_PRUNE_CHUNK_SIZE, 10) : 500,
    DB_INSERT_BATCH_SIZE: process.env.DB_INSERT_BATCH_SIZE ? parseInt(process.env.DB_INSERT_BATCH_SIZE, 10) : 5000,
    DB_BATCH_INTERVAL_MS: process.env.DB_BATCH_INTERVAL_MS ? parseInt(process.env.DB_BATCH_INTERVAL_MS, 10) : 2000,
    PERENNIAL_DRIVER: process.env.PERENNIAL_DRIVER?.trim() || 'none',
    PG_HOST: process.env.PG_HOST?.trim() || 'localhost',
    PG_PORT: process.env.PG_PORT ? parseInt(process.env.PG_PORT, 10) : 5432,
    PG_USER: process.env.PG_USER?.trim() || 'postgres',
    PG_PASSWORD: process.env.PG_PASSWORD?.trim() || 'password',
    PG_DATABASE: process.env.PG_DATABASE?.trim() || 'korelate',
    PG_TABLE_NAME: process.env.PG_TABLE_NAME?.trim() || 'mqtt_events',
    PG_INSERT_BATCH_SIZE: process.env.PG_INSERT_BATCH_SIZE ? parseInt(process.env.PG_INSERT_BATCH_SIZE, 10) : 1000,
    PG_BATCH_INTERVAL_MS: process.env.PG_BATCH_INTERVAL_MS ? parseInt(process.env.PG_BATCH_INTERVAL_MS, 10) : 5000,
    HTTP_USER: process.env.HTTP_USER?.trim() || null,
    HTTP_PASSWORD: process.env.HTTP_PASSWORD?.trim() || null,
    VIEW_TREE_ENABLED: process.env.VIEW_TREE_ENABLED !== 'false',
    VIEW_HMI_ENABLED: process.env.VIEW_HMI_ENABLED !== 'false', 
    VIEW_HISTORY_ENABLED: process.env.VIEW_HISTORY_ENABLED !== 'false',
    VIEW_MODELER_ENABLED: process.env.VIEW_MODELER_ENABLED !== 'false', 
    VIEW_MAPPER_ENABLED: process.env.VIEW_MAPPER_ENABLED !== 'false',
    VIEW_CHART_ENABLED: process.env.VIEW_CHART_ENABLED !== 'false',
    VIEW_PUBLISH_ENABLED: process.env.VIEW_PUBLISH_ENABLED !== 'false',
    VIEW_CHAT_ENABLED: process.env.VIEW_CHAT_ENABLED !== 'false',
    VIEW_ALERTS_ENABLED: process.env.VIEW_ALERTS_ENABLED !== 'false', 
    LLM_API_URL: process.env.LLM_API_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/',
    LLM_API_KEY: process.env.LLM_API_KEY || '',
    LLM_MODEL: process.env.LLM_MODEL || 'gemini-2.0-flash',
    HMI_FILE_PATH: process.env.HMI_FILE_PATH?.trim() || process.env.SVG_FILE_PATH?.trim() || 'view.html',
    BASE_PATH: process.env.BASE_PATH?.trim() || '/',
    VIEW_CONFIG_ENABLED: process.env.VIEW_CONFIG_ENABLED !== 'false',
    MAX_SAVED_CHART_CONFIGS: parseInt(process.env.MAX_SAVED_CHART_CONFIGS, 10) || 0,
    MAX_SAVED_MAPPER_VERSIONS: parseInt(process.env.MAX_SAVED_MAPPER_VERSIONS, 10) || 0,
    API_ALLOWED_IPS: process.env.API_ALLOWED_IPS?.trim() || null,
    EXTERNAL_API_ENABLED: process.env.EXTERNAL_API_ENABLED === 'true',
    EXTERNAL_API_KEYS_FILE: process.env.EXTERNAL_API_KEYS_FILE?.trim() || 'api_keys.json',
    ANALYTICS_ENABLED: process.env.ANALYTICS_ENABLED === 'true', 
    AI_TOOLS: {
        ENABLE_READ: process.env.LLM_TOOL_ENABLE_READ !== 'false',         
        ENABLE_SEMANTIC: process.env.LLM_TOOL_ENABLE_SEMANTIC !== 'false', 
        ENABLE_PUBLISH: process.env.LLM_TOOL_ENABLE_PUBLISH !== 'false',   
        ENABLE_FILES: process.env.LLM_TOOL_ENABLE_FILES !== 'false',       
        ENABLE_SIMULATOR: process.env.LLM_TOOL_ENABLE_SIMULATOR !== 'false', 
        ENABLE_MAPPER: process.env.LLM_TOOL_ENABLE_MAPPER !== 'false',     
        ENABLE_ADMIN: process.env.LLM_TOOL_ENABLE_ADMIN !== 'false'        
    },
    // Auth Config
    SESSION_SECRET: process.env.SESSION_SECRET || 'dev_secret_key_change_me',
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    PUBLIC_URL: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8080}`,
    ADMIN_USERNAME: process.env.ADMIN_USERNAME,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD
};

// --- Broker Configuration Parsing ---
try {
    if (process.env.MQTT_BROKERS) {
        try {
            config.BROKER_CONFIGS = JSON.parse(process.env.MQTT_BROKERS);
            config.BROKER_CONFIGS.forEach(broker => {
                if (!broker.subscribe) broker.subscribe = broker.topics || ['#'];
                if (!broker.publish) broker.publish = (broker.canPublish === false) ? [] : ['#'];
            });
            logger.info(`✅ Loaded ${config.BROKER_CONFIGS.length} legacy broker configuration(s).`);
        } catch (jsonErr) {
            logger.warn({ err: jsonErr }, "⚠️ Invalid JSON in MQTT_BROKERS.");
            config.BROKER_CONFIGS = [];
        }
    } else if (config.MQTT_BROKER_HOST) {
        logger.warn("Using deprecated single-broker env vars.");
        config.BROKER_CONFIGS = [{
            id: "default_broker",
            host: config.MQTT_BROKER_HOST,
            port: process.env.MQTT_PORT?.trim() || null,
            protocol: process.env.MQTT_PROTOCOL?.trim() || 'mqtt',
            clientId: config.CLIENT_ID,
            username: process.env.MQTT_USERNAME?.trim() || null,
            password: process.env.MQTT_PASSWORD?.trim() || null,
            subscribe: config.MQTT_TOPIC ? config.MQTT_TOPIC.split(',').map(t => t.trim()) : ['#'],
            publish: ['#'],
            certFilename: process.env.CERT_FILENAME?.trim() || null,
            keyFilename: process.env.KEY_FILENAME?.trim() || null,
            caFilename: process.env.CA_FILENAME?.trim() || null,
            alpnProtocol: process.env.MQTT_ALPN_PROTOCOL?.trim() || null,
            rejectUnauthorized: process.env.MQTT_REJECT_UNAUTHORIZED !== 'false'
        }];
    }

    if (config.BROKER_CONFIGS.length === 0 && process.env.ENABLE_LOCAL_MQTT_FALLBACK !== 'false') {
        const localBroker = {
            id: "local_mqtt",
            host: process.env.LOCAL_MQTT_HOST || "mqtt",
            port: parseInt(process.env.LOCAL_MQTT_PORT, 10) || 1883,
            protocol: "mqtt",
            clientId: "mqtt-uns-viewer-local",
            username: process.env.LOCAL_MQTT_USERNAME || "",
            password: process.env.LOCAL_MQTT_PASSWORD || "",
            subscribe: ["#"],
            publish: ["#"],
            certFilename: "",
            keyFilename: "",
            caFilename: "",
            alpnProtocol: "",
            rejectUnauthorized: false
        };

        config.BROKER_CONFIGS.push(localBroker);
        logger.info(`✅ No MQTT brokers configured; using local fallback ${localBroker.host}:${localBroker.port}`);
    }

    if (process.env.DATA_PROVIDERS) {
        try {
            config.DATA_PROVIDERS = JSON.parse(process.env.DATA_PROVIDERS);
            logger.info(`✅ Loaded ${config.DATA_PROVIDERS.length} custom data provider(s).`);
        } catch (jsonErr) {
            logger.warn({ err: jsonErr }, "⚠️ Invalid JSON in DATA_PROVIDERS.");
            config.DATA_PROVIDERS = [];
        }
    }
    for (const broker of config.BROKER_CONFIGS) {
        brokerStatuses.set(broker.id, { status: 'connecting', error: null });
    }
    for (const provider of config.DATA_PROVIDERS) {
        brokerStatuses.set(provider.id, { status: 'connecting', error: null });
    }
} catch (err) {
    logger.error({ err }, "❌ Unexpected error during configuration parsing.");
    config.BROKER_CONFIGS = [];
    config.DATA_PROVIDERS = [];
}

// --- Normalize Base Path ---
let basePath = config.BASE_PATH;
if (!basePath.startsWith('/')) basePath = '/' + basePath;
if (basePath.endsWith('/') && basePath.length > 1) basePath = basePath.slice(0, -1);

// --- Load External API Keys ---
if (config.EXTERNAL_API_ENABLED) {
    const keysFilePath = path.join(DATA_PATH, config.EXTERNAL_API_KEYS_FILE);
    try {
        if (fs.existsSync(keysFilePath)) {
            apiKeysConfig = JSON.parse(fs.readFileSync(keysFilePath, 'utf8'));
            logger.info(`✅ Loaded API keys.`);
        }
    } catch (err) {
        logger.error("❌ Failed to load API keys.");
    }
}

// --- Helper to get connections ---
function getPrimaryConnection() {
    if (activeConnections.size === 0) return null;
    return activeConnections.values().next().value || null;
}

function getBrokerConnection(brokerId) {
    if (!brokerId) return getPrimaryConnection();
    return activeConnections.get(brokerId) || null;
}

// --- Helper to update and broadcast broker status ---
function updateBrokerStatus(brokerId, status, error = null) {
    const info = { status, error, timestamp: Date.now() };
    brokerStatuses.set(brokerId, info);
    wsManager.broadcast(JSON.stringify({ type: 'broker-status', brokerId, ...info }));
}

// --- Express App & Server Setup ---
const app = express();
const server = http.createServer(app);
app.enable('trust proxy');

// --- Auth Setup ---
auth.configureAuth(app, config, logger, userManager, SESSIONS_PATH, basePath);

// --- CORS Middleware ---
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, content-type');
    next();
});

// --- Mapper Engine Setup ---
const mapperEngine = require('./core/engine/mapperEngine')( 
    activeConnections, 
    wsManager.broadcast, 
    logger,
    longReplacer,
    config 
);

// --- DuckDB Setup ---
const dbFile = DB_PATH;
const dbWalFile = dbFile + '.wal';
let db; 
db = new duckdb.Database(dbFile, (err) => {
    if (err) {
        logger.error({ err }, "❌ FATAL ERROR: Could not connect to DuckDB.");
        process.exit(1);
    }
    logger.info("✅ 🦆 DuckDB database connected.");
    
    // 1. Initialize Managers
    userManager.init(db, logger, SESSIONS_PATH);
    alertManager.init(db, logger, config, wsManager.broadcast);
    semanticManager.init({ logger, config });
    webhookManager.init(db, logger);
    
    // 2. Ensure Admin User Exists
    if (config.ADMIN_USERNAME && config.ADMIN_PASSWORD) {
        userManager.ensureAdminUser(config.ADMIN_USERNAME, config.ADMIN_PASSWORD);
    }
    
    // 3. Ensure tables exist
    db.exec(`
        CREATE TABLE IF NOT EXISTS mqtt_events (
            timestamp TIMESTAMPTZ,
            topic VARCHAR,
            payload JSON,
            broker_id VARCHAR,
            correlation_id VARCHAR
        );
    `, (createErr) => {
        if (createErr) {
            logger.error({ err: createErr }, "❌ FATAL: Failed to ensure tables exist.");
            return; 
        }
        // Schema Migration: Add correlation_id if missing
        db.all("PRAGMA table_info(mqtt_events);", (pragmaErr, columns) => {
            if (columns && !columns.some(col => col.name === 'correlation_id')) {
                logger.warn("⚠️ Migrating 'mqtt_events': Adding 'correlation_id' column...");
                db.run("ALTER TABLE mqtt_events ADD COLUMN correlation_id VARCHAR;");
            }
        });
    });
    
    mapperEngine.setDb(db);
    
    // 4. Initialize storage components
    const dbManager = require('./storage/dbManager')(db, dbFile, dbWalFile, wsManager.broadcast, logger, config.DUCKDB_MAX_SIZE_MB, config.DUCKDB_PRUNE_CHUNK_SIZE, () => isPruning, (status) => { isPruning = status; }); 
    dataManager.init(config, logger, mapperEngine, db, dbManager.broadcastDbStatus);
    
    // 5. Initialize WebSockets
    wsManager.initWebSocketManager(server, db, logger, basePath, dbManager.getDbStatus, longReplacer, () => brokerStatuses);
    
    // Intercept wsManager.broadcast to feed I3X Event Bus
    const originalBroadcast = wsManager.broadcast;
    wsManager.broadcast = (msgStr) => {
        originalBroadcast(msgStr);
        try {
            const msg = JSON.parse(msgStr);
            if (msg.type === 'mqtt-message') {
                let payloadObj = msg.payload;
                try { payloadObj = JSON.parse(msg.payload); } catch(e){}
                i3xEvents.emit('data', { topic: msg.topic, payloadObject: payloadObj });
            }
        } catch (e) {}
    };
    
    // 6. Maintenance & Connectors
    setInterval(dbManager.performMaintenance, 15000);
    connectorManager.init({ 
        config,
        logger,
        app,
        activeConnections,
        brokerStatuses,
        wsManager,
        mapperEngine,
        dataManager,
        alertManager,
        CERTS_PATH,
        broadcastDbStatus: dbManager.broadcastDbStatus,
        updateBrokerStatus,
        isShuttingDown: () => isShuttingDown
    });

    // --- Mount Router ---
    const router = createRouter({
        config,
        logger,
        db,
        dbFile,
        dbWalFile,
        dataManager,
        DATA_PATH,
        SESSIONS_PATH,
        basePath,
        userManager,
        alertManager,
        semanticManager,
        i3xEvents,
        getPrimaryConnection,
        getBrokerConnection,
        simulatorManager,
        wsManager,
        mapperEngine,
        ENV_PATH,
        ENV_EXAMPLE_PATH,
        CHART_CONFIG_PATH,
        apiKeysConfig,
        longReplacer,
        auth,
        ANALYTICS_SCRIPT,
        getIsPruning: () => isPruning,
        setIsPruning: (val) => { isPruning = val; }
    });

    // Apply global authentication middleware
    app.use(auth.authMiddleware);

    app.use(basePath, router);
    if (basePath !== '/') {
        logger.info(`✅ Enabling hybrid routing: listening on '${basePath}' AND '/'`);
        app.use('/', router);
    }

    app.get('/', (req, res) => {
        if (req.isAuthenticated()) {
            res.redirect(basePath === '/' ? '/tree/' : basePath + '/tree/');
        } else {
            res.redirect(basePath === '/' ? '/login' : basePath + '/login');
        }
    });
});

// --- Simulators ---
simulatorManager.init(logger, (topic, payload) => {
    const conn = getPrimaryConnection();
    if (conn && conn.connected) {
        conn.publish(topic, payload, { qos: 1 });
    }
}, config.IS_SPARKPLUG_ENABLED);

if (config.IS_SIMULATOR_ENABLED) {
    // Stagger the start of each simulator by 2 seconds to avoid CPU/Event Loop spikes
    ['stark', 'deathstar', 'paris_metro', 'hydrochem'].forEach((simName, index) => {
        setTimeout(() => {
            try {
                simulatorManager.startSimulator(simName);
            } catch (err) {
                logger.error({ err }, `Error auto-starting simulator ${simName}`);
            }
        }, 5000 + (index * 2000));
    });
}

// --- Server Start ---
server.listen(config.PORT, () => {
    logger.info(`✅ HTTP server started on http://localhost:${config.PORT}`);
});
server.timeout = 600000;
server.keepAliveTimeout = 600000;
server.headersTimeout = 600005;

// --- Graceful Shutdown ---
async function gracefulShutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info("\n✅ Gracefully shutting down...");
    setTimeout(() => {
        logger.error("❌ Shutdown timed out. Forcing exit.");
        process.exit(1);
    }, 5000).unref();
    try {
        await dataManager.stop();
        await new Promise(resolve => wsManager.close(resolve));
        await new Promise(resolve => server.close(resolve));
        connectorManager.closeAll(); 
        await dataManager.close();
        process.exit(0);
    } catch (err) {
        logger.error({ err }, "❌ Error during graceful shutdown.");
        process.exit(1);
    }
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('uncaughtException', (err) => {
    logger.fatal({ err }, "❌ FATAL: Uncaught Exception.");
    gracefulShutdown();
});
process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, "❌ FATAL: Unhandled Rejection.");
    gracefulShutdown();
});