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
  
 */

// --- Imports ---
const pino = require('pino');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const mqtt = require('mqtt');
const duckdb = require('duckdb');
const { spawn } = require('child_process');
const basicAuth = require('basic-auth');
const spBv10Codec = require('sparkplug-payload').get("spBv1.0");
const mqttMatch = require('mqtt-match');

// --- Module Imports  ---
const wsManager = require('./websocket-manager');
const mqttHandler = require('./mqtt-handler');
const { createMqttClient } = require('./mqtt_client'); // [MODIFIED] New function name
const simulatorManager = require('./simulator');
const dataManager = require('./database/dataManager');
const externalApiRouter = require('./routes/externalApi'); 


// --- Constants & Paths ---
const DATA_PATH = path.join(__dirname, 'data');
const ENV_PATH = path.join(DATA_PATH, '.env');
const ENV_EXAMPLE_PATH = path.join(__dirname, '.env.example');
const CERTS_PATH = path.join(DATA_PATH, 'certs');
const DB_PATH = path.join(DATA_PATH, 'mqtt_events.duckdb');
const CHART_CONFIG_PATH = path.join(DATA_PATH, 'charts.json'); 
const API_KEYS_FILE_PATH = path.join(DATA_PATH, process.env.EXTERNAL_API_KEYS_FILE || 'api_keys.json');

// --- Logger Setup ---
const logger = pino({
    transport: {
        target: 'pino-pretty',
        options: { colorize: true }
    }
});

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

// --- Configuration from Environment ---
const config = {
    BROKER_CONFIGS: [],
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
    PG_DATABASE: process.env.PG_DATABASE?.trim() || 'mqtt_uns_viewer',
    PG_TABLE_NAME: process.env.PG_TABLE_NAME?.trim() || 'mqtt_events',
    PG_INSERT_BATCH_SIZE: process.env.PG_INSERT_BATCH_SIZE ? parseInt(process.env.PG_INSERT_BATCH_SIZE, 10) : 1000,
    PG_BATCH_INTERVAL_MS: process.env.PG_BATCH_INTERVAL_MS ? parseInt(process.env.PG_BATCH_INTERVAL_MS, 10) : 5000,
    HTTP_USER: process.env.HTTP_USER?.trim() || null,
    HTTP_PASSWORD: process.env.HTTP_PASSWORD?.trim() || null,
    VIEW_TREE_ENABLED: process.env.VIEW_TREE_ENABLED !== 'false',
    VIEW_SVG_ENABLED: process.env.VIEW_SVG_ENABLED !== 'false',
    VIEW_HISTORY_ENABLED: process.env.VIEW_HISTORY_ENABLED !== 'false',
    VIEW_MAPPER_ENABLED: process.env.VIEW_MAPPER_ENABLED !== 'false',
    VIEW_CHART_ENABLED: process.env.VIEW_CHART_ENABLED !== 'false',
    VIEW_PUBLISH_ENABLED: process.env.VIEW_PUBLISH_ENABLED !== 'false',
    VIEW_CHAT_ENABLED: process.env.VIEW_CHAT_ENABLED !== 'false',
    LLM_API_URL: process.env.LLM_API_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/',
    LLM_API_KEY: process.env.LLM_API_KEY || '',
    LLM_MODEL: process.env.LLM_MODEL || 'gemini-2.0-flash',
    SVG_FILE_PATH: process.env.SVG_FILE_PATH?.trim() || 'view.svg',
    BASE_PATH: process.env.BASE_PATH?.trim() || '/',
    VIEW_CONFIG_ENABLED: process.env.VIEW_CONFIG_ENABLED !== 'false',
    MAX_SAVED_CHART_CONFIGS: parseInt(process.env.MAX_SAVED_CHART_CONFIGS, 10) || 0,
    MAX_SAVED_MAPPER_VERSIONS: parseInt(process.env.MAX_SAVED_MAPPER_VERSIONS, 10) || 0,
    API_ALLOWED_IPS: process.env.API_ALLOWED_IPS?.trim() || null,
    EXTERNAL_API_ENABLED: process.env.EXTERNAL_API_ENABLED === 'true',
    EXTERNAL_API_KEYS_FILE: process.env.EXTERNAL_API_KEYS_FILE?.trim() || 'api_keys.json'
};


// ---  Broker Configuration Parsing ---
try {
    if (process.env.MQTT_BROKERS) {
        config.BROKER_CONFIGS = JSON.parse(process.env.MQTT_BROKERS);
        config.BROKER_CONFIGS.forEach(broker => {
            if (!broker.subscribe) broker.subscribe = broker.topics || ['#'];
            if (!broker.publish) broker.publish = (broker.canPublish === false) ? [] : ['#'];
        });
        logger.info(`✅ Loaded ${config.BROKER_CONFIGS.length} broker configuration(s).`);
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
    } else {
        throw new Error("No MQTT broker configuration found.");
    }
    
    for (const broker of config.BROKER_CONFIGS) {
        // Initialize status
        brokerStatuses.set(broker.id, { status: 'connecting', error: null });
    }
} catch (err) {
    logger.error({ err }, "❌ FATAL ERROR: Invalid Broker Configuration.");
    process.exit(1);
}

// --- Configuration Validation ---
if (config.IS_SPARKPLUG_ENABLED) logger.info("✅ 🚀 Sparkplug B decoding is ENABLED.");

// --- Normalize Base Path ---
let basePath = config.BASE_PATH;
if (!basePath.startsWith('/')) basePath = '/' + basePath;
if (basePath.endsWith('/') && basePath.length > 1) basePath = basePath.slice(0, -1);

// ---  Load External API Keys ---
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

// ---  Helper to get connections ---
function getPrimaryConnection() {
    if (activeConnections.size === 0) return null;
    const primaryBrokerId = config.BROKER_CONFIGS[0].id;
    return activeConnections.get(primaryBrokerId) || null;
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

// ---  Mapper Engine Setup ---
const mapperEngine = require('./mapper_engine')(
    activeConnections, 
    wsManager.broadcast, 
    logger,
    longReplacer,
    config 
);

// ---  DuckDB Setup (Centralized Initialization) ---
const dbFile = DB_PATH;
const dbWalFile = dbFile + '.wal';
let db; 
db = new duckdb.Database(dbFile, (err) => {
    if (err) {
        logger.error({ err }, "❌ FATAL ERROR: Could not connect to DuckDB.");
        process.exit(1);
    }
    logger.info("✅ 🦆 DuckDB database connected.");
    
    // 1. Ensure table exists
    db.exec(`
        CREATE TABLE IF NOT EXISTS mqtt_events (
            timestamp TIMESTAMPTZ,
            topic VARCHAR,
            payload JSON,
            broker_id VARCHAR
        );`, (createErr) => {
        if (createErr) {
            logger.error({ err: createErr }, "❌ FATAL: Failed to ensure table 'mqtt_events' exists.");
            return; 
        }
        
        // 2. Schema Migration Check
        db.all("PRAGMA table_info(mqtt_events);", (pragmaErr, columns) => {
            if (columns) {
                const hasBrokerId = columns.some(col => col.name === 'broker_id');
                if (!hasBrokerId) {
                    logger.warn("⚠️  Migrating schema: Adding 'broker_id'...");
                    db.exec("ALTER TABLE mqtt_events ADD COLUMN broker_id VARCHAR;", () => {
                        db.exec("UPDATE mqtt_events SET broker_id = 'default_broker' WHERE broker_id IS NULL;");
                    });
                }
            }
        });
    });

    mapperEngine.setDb(db);
    
    const { getDbStatus, broadcastDbStatus, performMaintenance } = require('./db_manager')(db, dbFile, dbWalFile, wsManager.broadcast, logger, config.DUCKDB_MAX_SIZE_MB, config.DUCKDB_PRUNE_CHUNK_SIZE, () => isPruning, (status) => { isPruning = status; });

    dataManager.init(config, logger, mapperEngine, db, broadcastDbStatus);

    wsManager.initWebSocketManager(server, db, logger, basePath, getDbStatus, longReplacer, () => brokerStatuses);

    setInterval(performMaintenance, 15000);

    // 7.  Connect to ALL MQTT Brokers
    // [CRITICAL FIX] Loop once, create client once. No recursive calls.
    config.BROKER_CONFIGS.forEach(brokerConfig => {
        const brokerId = brokerConfig.id;
        
        // Create client immediately (reconnection managed by library)
        const connection = createMqttClient(brokerConfig, logger, CERTS_PATH);
        
        activeConnections.set(brokerId, connection);
        
        // Initialize the handler logic once
        const handleMessage = mqttHandler.init(
            logger,
            config,
            wsManager,
            mapperEngine,
            dataManager, 
            broadcastDbStatus
        );

        // --- Event Listeners ---

        connection.on('connect', () => {
            logger.info(`✅ MQTT Broker '${brokerId}' connected.`);
            updateBrokerStatus(brokerId, 'connected');
            
            // Subscribe
            const rawTopics = (brokerConfig.subscribe && brokerConfig.subscribe.length > 0) ? brokerConfig.subscribe : brokerConfig.topics;
            const subscriptionTopics = Array.isArray(rawTopics) ? rawTopics.map(t => t.trim()) : [];
            
            if (subscriptionTopics.length > 0) {
                connection.subscribe(subscriptionTopics, { qos: 1 }, (err) => {
                    if (err) logger.error({ err }, `❌ Subscription failed for '${brokerId}'`);
                    else logger.info(`✅ Subscribed on '${brokerId}'`);
                });
            }
        });

        connection.on('message', (topic, payload) => {
            handleMessage(brokerId, topic, payload); 
        });

        connection.on('reconnect', () => {
            logger.info(`🔄 MQTT Broker '${brokerId}' reconnecting...`);
            updateBrokerStatus(brokerId, 'connecting');
        });

        connection.on('offline', () => {
            updateBrokerStatus(brokerId, 'offline');
        });

        connection.on('error', (err) => {
            logger.error(`❌ MQTT Error on '${brokerId}': ${err.message}`);
            updateBrokerStatus(brokerId, 'error', err.message);
        });

        connection.on('close', () => {
            if (!isShuttingDown) {
               // Log but DO NOT call connect() manually. The library will emit 'reconnect'.
               logger.warn(`⚠️ MQTT Broker '${brokerId}' connection closed.`);
               updateBrokerStatus(brokerId, 'disconnected');
            }
        });
    });
});

// --- Middleware & Routes ---
const authMiddleware = (req, res, next) => {
    if (!config.HTTP_USER || !config.HTTP_PASSWORD) return next();
    const credentials = basicAuth(req);
    if (!credentials || credentials.name !== config.HTTP_USER || credentials.pass !== config.HTTP_PASSWORD) {
        res.setHeader('WWW-Authenticate', 'Basic realm="MQTT UNS Viewer"');
        return res.status(401).send('Authentication required.');
    }
    return next();
};

let isShuttingDown = false;

let ALLOWED_IPS = config.API_ALLOWED_IPS ? config.API_ALLOWED_IPS.split(',').map(ip => ip.trim()) : [];
const ipFilterMiddleware = (req, res, next) => {
    if (ALLOWED_IPS.length === 0 || ALLOWED_IPS.includes(req.ip)) return next();
    res.status(403).json({ error: `Access denied for IP ${req.ip}` });
};

const mainRouter = express.Router();
mainRouter.use(express.json());
app.set('trust proxy', true);

// Simulator
simulatorManager.init(logger, (topic, payload) => {
    const conn = getPrimaryConnection();
    if (conn && conn.connected) conn.publish(topic, payload, { qos: 1 });
}, config.IS_SPARKPLUG_ENABLED);

// --- API Routes (Simplified for brevity, logic mostly unchanged) ---
mainRouter.get('/api/svg/file', (req, res) => {
    const filePath = path.join(DATA_PATH, path.basename(req.query.name || ''));
    if (fs.existsSync(filePath) && filePath.endsWith('.svg')) res.sendFile(filePath);
    else res.status(404).send('Not found');
});

mainRouter.get('/api/svg/list', (req, res) => {
    try {
        res.json(fs.readdirSync(DATA_PATH).filter(f => f.endsWith('.svg')));
    } catch { res.status(500).json([]); }
});

mainRouter.get('/api/svg/bindings.js', (req, res) => {
    const filePath = path.join(DATA_PATH, path.basename(req.query.name || ''));
    if (fs.existsSync(filePath)) { res.setHeader('Content-Type', 'application/javascript'); res.sendFile(filePath); }
    else { res.setHeader('Content-Type', 'application/javascript'); res.send('// No bindings'); }
});

mainRouter.get('/api/config', (req, res) => {
    res.json({
        isSimulatorEnabled: config.IS_SIMULATOR_ENABLED,
        brokerConfigs: config.BROKER_CONFIGS.map(b => ({ id: b.id, host: b.host, port: b.port, subscribe: b.subscribe, publish: b.publish })),
        isMultiBroker: config.BROKER_CONFIGS.length > 1,
        viewTreeEnabled: config.VIEW_TREE_ENABLED,
        viewSvgEnabled: config.VIEW_SVG_ENABLED,
        viewHistoryEnabled: config.VIEW_HISTORY_ENABLED,
        viewMapperEnabled: config.VIEW_MAPPER_ENABLED,
        viewChartEnabled: config.VIEW_CHART_ENABLED,
        viewPublishEnabled: config.VIEW_PUBLISH_ENABLED,
        viewChatEnabled: config.VIEW_CHAT_ENABLED,
        basePath: basePath,
        viewConfigEnabled: config.VIEW_CONFIG_ENABLED,
        maxSavedChartConfigs: config.MAX_SAVED_CHART_CONFIGS,
        maxSavedMapperVersions: config.MAX_SAVED_MAPPER_VERSIONS,
        svgFilePath: config.SVG_FILE_PATH
    });
});

if (config.IS_SIMULATOR_ENABLED) {
    mainRouter.get('/api/simulator/status', (req, res) => res.json({ statuses: simulatorManager.getStatuses() }));
    mainRouter.post('/api/simulator/start/:name', (req, res) => {
        const r = simulatorManager.startSimulator(req.params.name);
        wsManager.broadcast(JSON.stringify({ type: 'simulator-status', statuses: simulatorManager.getStatuses() }));
        res.json(r);
    });
    mainRouter.post('/api/simulator/stop/:name', (req, res) => {
        const r = simulatorManager.stopSimulator(req.params.name);
        wsManager.broadcast(JSON.stringify({ type: 'simulator-status', statuses: simulatorManager.getStatuses() }));
        res.json(r);
    });
}

mainRouter.use('/api/context', (req, res, next) => {
    if (!db) return res.status(503).json({ error: "DB not ready" });
    const dbManager = require('./db_manager')(db, dbFile, dbWalFile, wsManager.broadcast, logger, config.DUCKDB_MAX_SIZE_MB, config.DUCKDB_PRUNE_CHUNK_SIZE, () => isPruning, (status) => { isPruning = status; });
    require('./routes/mcpApi')(db, getPrimaryConnection, simulatorManager.getStatuses, dbManager.getDbStatus, config)(req, res, next);
});

mainRouter.use('/api/tools', ipFilterMiddleware, require('./routes/toolsApi')(logger));

if (config.VIEW_CHAT_ENABLED) {
    mainRouter.use('/api/chat', ipFilterMiddleware, require('./routes/chatApi')(db, logger, config, getBrokerConnection));
}

if (config.VIEW_CONFIG_ENABLED) {
    mainRouter.use('/api/env', ipFilterMiddleware, require('./routes/configApi')(ENV_PATH, ENV_EXAMPLE_PATH, DATA_PATH, logger));
}

mainRouter.use('/api/mapper', ipFilterMiddleware, require('./routes/mapperApi')(mapperEngine));
mainRouter.use('/api/chart', ipFilterMiddleware, require('./routes/chartApi')(CHART_CONFIG_PATH, logger));

mainRouter.post('/api/publish/message', ipFilterMiddleware, (req, res) => {
    const { topic, payload, format, qos, retain, brokerId } = req.body;
    const conn = getBrokerConnection(brokerId);
    if (!conn || !conn.connected) return res.status(503).json({ error: "Broker not connected" });
    
    // Determine payload
    let finalPayload = payload;
    if (format === 'json' || typeof payload === 'object') {
        try { finalPayload = JSON.stringify(typeof payload === 'string' ? JSON.parse(payload) : payload); } catch(e) {}
    } else if (format === 'sparkplugb') {
        try { finalPayload = spBv10Codec.encodePayload(JSON.parse(payload)); } catch(e) { return res.status(400).json({ error: e.message }); }
    }

    conn.publish(topic, finalPayload, { qos: parseInt(qos)||0, retain: !!retain }, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

if (config.EXTERNAL_API_ENABLED) {
    mainRouter.use('/api/external', ipFilterMiddleware, require('./routes/externalApi')(getPrimaryConnection, logger, apiKeysConfig, longReplacer));
}

if (!config.VIEW_CONFIG_ENABLED) {
    mainRouter.get('/config.html', (req, res) => res.status(403).send('Disabled'));
    mainRouter.get('/config.js', (req, res) => res.status(403).send('Disabled'));
}

mainRouter.use(express.static(path.join(__dirname, 'public')));
app.use(authMiddleware);
app.use(basePath, mainRouter);
if (basePath !== '/') app.get('/', (req, res) => res.redirect(basePath));

// --- Server Start ---
server.listen(config.PORT, () => {
    logger.info(`✅ HTTP server started on http://localhost:${config.PORT}`);
});

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
    logger.info("\n✅ Gracefully shutting down...");
    isShuttingDown = true;
    
    // Force exit after 5 seconds if stuck
    setTimeout(() => {
        logger.error("❌ Shutdown timed out. Forcing exit.");
        process.exit(1);
    }, 5000).unref();

    dataManager.stop();
    simulatorManager.getStatuses(); // Stop sims logic embedded in manager
    
    wsManager.close(() => {
        server.close(() => {
            // Close MQTT connections forcefully
            activeConnections.forEach((conn) => {
                if (conn) conn.end(true); // Force close
            });
            dataManager.close().then(() => {
                logger.info("✅ Shutdown complete.");
                process.exit(0);
            });
        });
    });
});