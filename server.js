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
const { connectToMqttBroker } = require('./mqtt_client');
const simulatorManager = require('./simulator');
const dataManager = require('./database/dataManager');
const externalApiRouter = require('./routes/externalApi'); 
// --- [END MODIFIED] ---


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
        logger.error({ err }, "❌ FATAL ERROR: Could not create .env file. Make sure '.env.example' exists in the project root.");
        process.exit(1);
    }
}
require('dotenv').config({ path: ENV_PATH });

// --- Initial charts.json File Setup ---
if (!fs.existsSync(CHART_CONFIG_PATH)) {
    logger.info("✅ No 'charts.json' file found in 'data' directory. Creating one...");
    try {
        fs.writeFileSync(CHART_CONFIG_PATH, JSON.stringify({ configurations: [] }, null, 2));
        logger.info("✅ charts.json file created successfully in ./data/");
    } catch (err) {
        logger.error({ err }, "❌ FATAL ERROR: Could not create charts.json file.");
        process.exit(1);
    }
}

// --- Helper Function for Sparkplug (handles BigInt) ---
function longReplacer(key, value) {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    return value;
}

// --- Global Variables ---
let mcpProcess = null;
let activeConnections = new Map(); //  Stores all active MQTT connections by brokerId
let brokerStatuses = new Map(); // Stores { status: string, error: string|null } by brokerId
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
        logger.info(`✅ Loaded ${config.BROKER_CONFIGS.length} broker configuration(s) from MQTT_BROKERS.`);
    } else if (config.MQTT_BROKER_HOST) {
        logger.warn("MQTT_BROKERS variable not set. Falling back to deprecated single-broker .env variables (MQTT_BROKER_HOST, etc.).");
        config.BROKER_CONFIGS = [
            {
                id: "default_broker",
                host: config.MQTT_BROKER_HOST,
                port: process.env.MQTT_PORT?.trim() || null,
                protocol: process.env.MQTT_PROTOCOL?.trim() || 'mqtt',
                clientId: config.CLIENT_ID,
                username: process.env.MQTT_USERNAME?.trim() || null,
                password: process.env.MQTT_PASSWORD?.trim() || null,
                topics: config.MQTT_TOPIC ? config.MQTT_TOPIC.split(',').map(t => t.trim()) : [],
                certFilename: process.env.CERT_FILENAME?.trim() || null,
                keyFilename: process.env.KEY_FILENAME?.trim() || null,
                caFilename: process.env.CA_FILENAME?.trim() || null,
                alpnProtocol: process.env.MQTT_ALPN_PROTOCOL?.trim() || null,
                rejectUnauthorized: process.env.MQTT_REJECT_UNAUTHORIZED !== 'false'
            }
        ];
    } else {
        throw new Error("No MQTT broker configuration found. Please set MQTT_BROKERS in your .env file.");
    }
    if (config.BROKER_CONFIGS.length === 0) {
        throw new Error("MQTT_BROKERS array is empty. At least one broker must be configured.");
    }
    for (const broker of config.BROKER_CONFIGS) {
        if (!broker.id || !broker.host || !broker.port || !broker.clientId || !broker.topics) {
            throw new Error(`Invalid broker config: 'id', 'host', 'port', 'clientId', and 'topics' are required. Problematic config: ${JSON.stringify(broker)}`);
        }
        // Initialize status
        brokerStatuses.set(broker.id, { status: 'connecting', error: null });
    }
} catch (err) {
    logger.error({ err }, "❌ FATAL ERROR: Could not parse MQTT_BROKERS JSON. Please check your .env file.");
    process.exit(1);
}

// --- Configuration Validation ---
if (config.IS_SPARKPLUG_ENABLED) logger.info("✅ 🚀 Sparkplug B decoding is ENABLED.");
if (config.HTTP_USER && config.HTTP_PASSWORD) logger.info("✅ 🔒 HTTP Basic Authentication is ENABLED.");
logger.info(`✅ UI Config: Tree[${config.VIEW_TREE_ENABLED}] SVG[${config.VIEW_SVG_ENABLED}] History[${config.VIEW_HISTORY_ENABLED}] Mapper[${config.VIEW_MAPPER_ENABLED}] Chart[${config.VIEW_CHART_ENABLED}] Publish[${config.VIEW_PUBLISH_ENABLED}]`);
logger.info(`✅ SVG Config: Path[${config.SVG_FILE_PATH}] `);
logger.info(`✅ ⚡ DuckDB batch insert is ENABLED (Size: ${config.DB_INSERT_BATCH_SIZE}, Interval: ${config.DB_BATCH_INTERVAL_MS}ms).`);
if (config.MAX_SAVED_CHART_CONFIGS > 0) logger.info(`✅ 🔒 DEMO LIMIT: Max saved charts set to ${config.MAX_SAVED_CHART_CONFIGS}.`);
if (config.MAX_SAVED_MAPPER_VERSIONS > 0) logger.info(`✅ 🔒 DEMO LIMIT: Max saved mapper versions set to ${config.MAX_SAVED_MAPPER_VERSIONS}.`);


// --- Normalize Base Path ---
let basePath = config.BASE_PATH;
if (!basePath.startsWith('/')) {
    basePath = '/' + basePath;
}
if (basePath.endsWith('/') && basePath.length > 1) {
    basePath = basePath.slice(0, -1);
}
logger.info(`✅ Application base path set to: ${basePath}`);

// ---  Load External API Keys ---
if (config.EXTERNAL_API_ENABLED) {
    const keysFilePath = path.join(DATA_PATH, config.EXTERNAL_API_KEYS_FILE);
    try {
        if (!fs.existsSync(keysFilePath)) {
            const examplePath = path.join(DATA_PATH, 'api_keys.json.example');
            if (fs.existsSync(examplePath)) {
                fs.copyFileSync(examplePath, keysFilePath);
                logger.info(`✅ Created 'api_keys.json' from example. Please edit this file to add your keys.`);
            } else {
                fs.writeFileSync(keysFilePath, JSON.stringify({ keys: [] }, null, 2));
                logger.info(`✅ Created empty 'api_keys.json'. Please edit this file to add your keys.`);
            }
        }
        const fileContent = fs.readFileSync(keysFilePath, 'utf8');
        apiKeysConfig = JSON.parse(fileContent);
        const enabledKeys = apiKeysConfig.keys.filter(k => k.enabled).length;
        logger.info(`✅ 🔒 External Publish API is ENABLED. Loaded ${enabledKeys} enabled key(s) from ${config.EXTERNAL_API_KEYS_FILE}.`);
    } catch (err) {
        logger.error({ err, path: keysFilePath }, `❌ FATAL ERROR: Could not read or parse API keys file. Disabling external API.`);
        config.EXTERNAL_API_ENABLED = false;
    }
} else {
    logger.info("✅ 🔒 External Publish API is DISABLED by .env settings.");
}

// ---  Helper to get the "primary" connection (for publishing) ---
function getPrimaryConnection() {
    if (activeConnections.size === 0) {
        return null;
    }
    const primaryBrokerId = config.BROKER_CONFIGS[0].id;
    return activeConnections.get(primaryBrokerId) || null;
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
// Pass the full connection map, not a callback
const mapperEngine = require('./mapper_engine')(
    activeConnections, 
    wsManager.broadcast, 
    logger,
    longReplacer
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
    logger.info("✅ 🦆 DuckDB database connected successfully at: %s", dbFile);
    
    // --- Post-Connection Initializations ---
    
    // 1. Create table
    db.exec(`
      CREATE TABLE IF NOT EXISTS mqtt_events (
          timestamp TIMESTAMPTZ,
          topic VARCHAR,
          payload JSON,
          broker_id VARCHAR
      );`, (err) => {
        if (err) {
            logger.error({ err }, "❌ Failed to create table in DuckDB.");
        } else {
            logger.info("✅    -> Table 'mqtt_events' is ready (schema includes broker_id).");
        }
    });

    // 2. Give the DB connection to the Mapper Engine
    mapperEngine.setDb(db);
    
    // 3. Initialize DB Maintenance
    const { getDbStatus, broadcastDbStatus, performMaintenance } = require('./db_manager')(db, dbFile, dbWalFile, wsManager.broadcast, logger, config.DUCKDB_MAX_SIZE_MB, config.DUCKDB_PRUNE_CHUNK_SIZE, () => isPruning, (status) => { isPruning = status; });

    // 4. Initialize Data Manager
    dataManager.init(config, logger, mapperEngine, db, broadcastDbStatus);

    // 5. Initialize WebSocket Manager (passes DB for READS)
    // Added getBrokerStatuses callback
    wsManager.initWebSocketManager(server, db, logger, basePath, getDbStatus, longReplacer, () => brokerStatuses);

    // 6. Start DB Maintenance Interval
    setInterval(performMaintenance, 15000);

    // 7.  Connect to ALL MQTT Brokers
    config.BROKER_CONFIGS.forEach(brokerConfig => {
        const connect = () => { // Function to handle connection and reconnection
            connectToMqttBroker(brokerConfig, logger, CERTS_PATH, (brokerId, connection) => {
                
                activeConnections.set(brokerId, connection);
                updateBrokerStatus(brokerId, 'connected');

                const handleMessage = mqttHandler.init(
                    logger,
                    config,
                    wsManager,
                    mapperEngine,
                    dataManager, 
                    broadcastDbStatus
                );

                connection.on('message', (topic, payload) => {
                    handleMessage(brokerId, topic, payload); 
                });

                // Error handling for status tracking
                connection.on('error', (err) => {
                    updateBrokerStatus(brokerId, 'error', err.message);
                });

                connection.on('offline', () => {
                    updateBrokerStatus(brokerId, 'offline');
                });

                //  Add event listener for actual closure
                connection.on('close', () => {
                    logger.warn(`🛑 MQTT Broker '${brokerId}' disconnected unexpectedly.`);
                    activeConnections.delete(brokerId);
                    updateBrokerStatus(brokerId, 'disconnected');
                    
                    // Attempt reconnection after a delay
                    if (!isShuttingDown) {
                        logger.info(`🔄 Attempting to reconnect to broker '${brokerId}' in 5 seconds...`);
                        setTimeout(connect, 5000);
                    }
                    
                    if (activeConnections.size === 0) {
                        logger.warn("All MQTT connections are down. Stopping all running simulators...");
                        const statuses = simulatorManager.getStatuses();
                        for (const name in statuses) {
                            if (statuses[name] === 'running') {
                                simulatorManager.stopSimulator(name);
                            }
                        }
                        wsManager.broadcast(JSON.stringify({ type: 'simulator-status', statuses: simulatorManager.getStatuses() }));
                    }
                });
                
                // Track reconnection success (if the 'close' handler initiated a reconnect)
                connection.on('reconnect', () => {
                     logger.info(`🔄 Reconnecting to MQTT Broker '${brokerId}'...`);
                     updateBrokerStatus(brokerId, 'connecting');
                });
                
            });
        };
        connect(); // Initial connection attempt
    });
});
// --- [END] DuckDB Init Block ---

// --- Middleware ---
const authMiddleware = (req, res, next) => {
    if (!config.HTTP_USER || !config.HTTP_PASSWORD) {
        return next();
    }
    const credentials = basicAuth(req);
    if (!credentials || credentials.name !== config.HTTP_USER || credentials.pass !== config.HTTP_PASSWORD) {
        logger.warn("[SECURITY] Failed authentication attempt from IP: %s", req.ip);
        res.setHeader('WWW-Authenticate', 'Basic realm="MQTT UNS Viewer"');
        return res.status(401).send('Authentication required.');
    }
    return next();
};

// --- Global Shutdown Flag  ---
let isShuttingDown = false;

// --- IP Filter Middleware (Configurable) ---
let ALLOWED_IPS = [];
if (config.API_ALLOWED_IPS) {
    ALLOWED_IPS = config.API_ALLOWED_IPS.split(',').map(ip => ip.trim());
    logger.info(`✅ 🔒 API IP Filtering is ENABLED. Allowed IPs: [${ALLOWED_IPS.join(', ')}]`);
} else {
    logger.info("✅ 🔓 API IP Filtering is DISABLED (API_ALLOWED_IPS is not set in .env).");
}


const ipFilterMiddleware = (req, res, next) => {
    if (ALLOWED_IPS.length === 0) {
        return next(); 
    }

    const clientIp = req.ip;
    if (ALLOWED_IPS.includes(clientIp)) {
        return next(); 
    }

    logger.warn(`[SECURITY] Denied API access from IP: ${clientIp} (Not in ALLOWED_IPS list)`);
    res.status(403).json({ error: `Access denied. Your IP (${clientIp}) is not allowed.` });
};

// --- Main Router for Base Path ---
const mainRouter = express.Router();
mainRouter.use(express.json());
app.set('trust proxy', true);

// --- Simulator Logic  ---
simulatorManager.init(logger, (topic, payload, isBinary) => {
    const primaryConnection = getPrimaryConnection(); 
    if (primaryConnection) {
        primaryConnection.publish(topic, payload, { qos: 1, retain: false });
    } else {
        logger.warn(`[Simulator] Could not publish message: No primary MQTT connection is active.`);
    }
}, config.IS_SPARKPLUG_ENABLED);


// --- API Routes (Mounted on mainRouter) ---

mainRouter.get('/api/svg/file', (req, res) => {
    const filename = req.query.name;
    if (!filename || !filename.endsWith('.svg')) {
        return res.status(400).json({ error: 'Invalid or missing SVG file name.' });
    }
    const sanitizedName = path.basename(filename);
    const configuredSvgPath = path.join(DATA_PATH, sanitizedName);
    
    if (fs.existsSync(configuredSvgPath)) {
        res.sendFile(configuredSvgPath);
    } else {
        logger.error(`Requested SVG file not found at: ${configuredSvgPath}`);
        res.status(404).send(`SVG file not found. Checked path: ${configuredSvgPath}`);
    }
});

mainRouter.get('/api/svg/list', (req, res) => {
    try {
        const files = fs.readdirSync(DATA_PATH);
        const svgFiles = files.filter(file => file.endsWith('.svg'));
        res.json(svgFiles);
    } catch (err) {
        logger.error({ err }, "❌ Failed to read data directory to list SVGs.");
        res.status(500).json({ error: "Could not list SVG files." });
    }
});

mainRouter.get('/api/svg/bindings.js', (req, res) => {
    const filename = req.query.name;
    if (!filename || !filename.endsWith('.svg.js')) {
        return res.status(400).json({ error: 'Invalid or missing binding file name. Must end with .svg.js' });
    }
    const sanitizedName = path.basename(filename);
    const bindingsPath = path.join(DATA_PATH, sanitizedName);

    if (fs.existsSync(bindingsPath)) {
        res.setHeader('Content-Type', 'application/javascript');
        res.sendFile(bindingsPath);
    } else {
        res.setHeader('Content-Type', 'application/javascript');
        res.send(`// No custom binding file found at /data/${sanitizedName}. Using default logic.`);
    }
});


mainRouter.get('/api/config', (req, res) => {
    res.json({
        isSimulatorEnabled: config.IS_SIMULATOR_ENABLED,
        brokerConfigs: config.BROKER_CONFIGS.map(b => ({ id: b.id, host: b.host, port: b.port, topics: b.topics })), // [MODIFIED]
        isMultiBroker: config.BROKER_CONFIGS.length > 1,
        viewTreeEnabled: config.VIEW_TREE_ENABLED,
        viewSvgEnabled: config.VIEW_SVG_ENABLED,
        viewHistoryEnabled: config.VIEW_HISTORY_ENABLED,
        viewMapperEnabled: config.VIEW_MAPPER_ENABLED,
        viewChartEnabled: config.VIEW_CHART_ENABLED,
        viewPublishEnabled: config.VIEW_PUBLISH_ENABLED,
        basePath: basePath,
        viewConfigEnabled: config.VIEW_CONFIG_ENABLED,
        maxSavedChartConfigs: config.MAX_SAVED_CHART_CONFIGS,
        maxSavedMapperVersions: config.MAX_SAVED_MAPPER_VERSIONS,
        svgFilePath: config.SVG_FILE_PATH
    });
});

if (config.IS_SIMULATOR_ENABLED) {
    logger.info("✅ Simulator is ENABLED. Creating API endpoints at /api/simulator/*");
    mainRouter.get('/api/simulator/status', (req, res) => {
        res.json({ statuses: simulatorManager.getStatuses() });
    });
    mainRouter.post('/api/simulator/start/:name', (req, res) => {
        const name = req.params.name;
        const result = simulatorManager.startSimulator(name);
        wsManager.broadcast(JSON.stringify({ type: 'simulator-status', statuses: simulatorManager.getStatuses() }));
        res.status(200).json(result);
    });
    mainRouter.post('/api/simulator/stop/:name', (req, res) => {
        const name = req.params.name;
        const result = simulatorManager.stopSimulator(name);
        wsManager.broadcast(JSON.stringify({ type: 'simulator-status', statuses: simulatorManager.getStatuses() }));
        res.status(200).json(result);
    });
}

//  MCP Context API Router
mainRouter.use('/api/context', (req, res, next) => {
    if (!db) {
        return res.status(503).json({ error: "Database is not yet initialized." });
    }
    const dbManager = require('./db_manager')(db, dbFile, dbWalFile, wsManager.broadcast, logger, config.DUCKDB_MAX_SIZE_MB, config.DUCKDB_PRUNE_CHUNK_SIZE, () => isPruning, (status) => { isPruning = status; });
    const mcpRouter = require('./routes/mcpApi')(
        db, 
        getPrimaryConnection, 
        simulatorManager.getStatuses,
        dbManager.getDbStatus,
        config
    );
    ipFilterMiddleware(req, res, () => mcpRouter(req, res, next));
});

// This exposes uns_model.json and file helpers via REST for easy bot integration.
const toolsRouter = require('./routes/toolsApi')(logger);
mainRouter.use('/api/tools', ipFilterMiddleware, toolsRouter);

if (config.VIEW_CONFIG_ENABLED) {
    logger.info("✅ Configuration editor UI is ENABLED.");
    const configRouter = require('./routes/configApi')(ENV_PATH, ENV_EXAMPLE_PATH, DATA_PATH, logger);
    mainRouter.use('/api/env', ipFilterMiddleware, configRouter);
} else {
    logger.info("✅ 🔒 Configuration editor UI is DISABLED by .env settings.");
    mainRouter.use('/api/env', (req, res) => {
        res.status(403).json({ error: "Configuration API is disabled by server settings." });
    });
}

const mapperRouter = require('./routes/mapperApi')(mapperEngine);
mainRouter.use('/api/mapper', ipFilterMiddleware, mapperRouter);

const chartRouter = require('./routes/chartApi')(CHART_CONFIG_PATH, logger);
mainRouter.use('/api/chart', ipFilterMiddleware, chartRouter);


mainRouter.post('/api/publish/message', ipFilterMiddleware, (req, res) => {
    const primaryConnection = getPrimaryConnection(); 
    if (!primaryConnection || !primaryConnection.connected) { 
        return res.status(503).json({ error: "MQTT client (primary) is not connected." });
    }
    const { topic, payload, format, qos, retain, brokerId } = req.body;
    
    let connectionToUse = primaryConnection;
    let brokerIdUsed = config.BROKER_CONFIGS[0].id;

    if (brokerId && brokerId !== brokerIdUsed) {
        const targetConnection = activeConnections.get(brokerId);
        if (targetConnection && targetConnection.connected) {
            connectionToUse = targetConnection;
            brokerIdUsed = brokerId;
        } else {
             return res.status(404).json({ error: `Broker with id '${brokerId}' not found or not connected.` });
        }
    }

    if (!topic || topic.trim() === '') {
        return res.status(400).json({ error: "Topic is required." });
    }
    const qosLevel = parseInt(qos, 10);
    if (isNaN(qosLevel) || qosLevel < 0 || qosLevel > 2) {
        return res.status(400).json({ error: "Invalid QoS. Must be 0, 1, or 2." });
    }
    const retainFlag = retain === true;
    let finalPayload;
    try {
        switch (format) {
            case 'json':
                finalPayload = JSON.stringify(JSON.parse(payload));
                break;
            case 'sparkplugb':
                const spPayloadObj = JSON.parse(payload);
                if (!spPayloadObj.timestamp) spPayloadObj.timestamp = Date.now();
                if (spPayloadObj.seq === undefined) spPayloadObj.seq = 0;
                if (spPayloadObj.metrics) {
                    spPayloadObj.metrics.forEach(m => {
                        if (typeof m.value === 'string' && /^\d+n$/.test(m.value)) {
                            m.value = BigInt(m.value.slice(0, -1));
                        }
                    });
                }
                finalPayload = spBv10Codec.encodePayload(spPayloadObj);
                break;
            case 'string':
            default:
                finalPayload = payload;
                break;
        }
    } catch (err) {
        logger.error({ err, topic: topic }, "❌ Error processing manual publish payload:");
        return res.status(400).json({ error: `Invalid payload format for '${format}'. ${err.message}` });
    }
    connectionToUse.publish(topic, finalPayload, { qos: qosLevel, retain: retainFlag }, (err) => {
        if (err) {
            logger.error({ err, topic: topic }, "❌ Error manually publishing message:");
            return res.status(500).json({ error: `Failed to publish. ${err.message}` });
        }
        logger.info(`✅ Manually published to '${topic}' on broker '${brokerIdUsed}' (QoS: ${qosLevel}, Retain: ${retainFlag})`);
        res.status(200).json({ success: true, message: `Published to ${topic} on ${brokerIdUsed}` });
    });
});

// ---  Mount the External API Router ---
if (config.EXTERNAL_API_ENABLED) {
    const extApiRouter = externalApiRouter(
        getPrimaryConnection, //  Pass the getter
        logger,
        apiKeysConfig,
        longReplacer
    );
    mainRouter.use('/api/external', ipFilterMiddleware, extApiRouter);
} else {
    mainRouter.use('/api/external', (req, res) => {
        res.status(503).json({ error: "External API is disabled by server configuration." });
    });
}


if (!config.VIEW_CONFIG_ENABLED) {
    mainRouter.get('/config.html', (req, res) => {
        res.status(403).send('Access to the configuration page is disabled by server settings.');
    });
    mainRouter.get('/config.js', (req, res) => {
        res.status(403).send('Access to configuration scripts is disabled.');
    });
}
mainRouter.use(express.static(path.join(__dirname, 'public')));
app.use(authMiddleware);
app.use(basePath, mainRouter);
if (basePath !== '/') {
    app.get('/', (req, res) => {
        res.redirect(basePath);
    });
}

// --- Server Start ---
server.listen(config.PORT, () => {
    logger.info(`✅ HTTP server started on http://localhost:${config.PORT}`);
});

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
    logger.info("\n✅ Gracefully shutting down...");
    isShuttingDown = true; // Set flag to stop reconnection attempts
    
    dataManager.stop();
    
    const statuses = simulatorManager.getStatuses();
    for (const name in statuses) {
        if (statuses[name] === 'running') {
            logger.info(`✅    -> Stopping simulator [${name}]...`);
            simulatorManager.stopSimulator(name);
        }
    }
    const finalShutdown = async () => {
        await dataManager.close(); 
        logger.info("✅ Shutdown complete.");
        process.exit(0);
    };
    
    wsManager.close(() => {
        logger.info("✅ WebSocket server closed.");
        server.close(() => {
            logger.info("✅ HTTP server closed.");
            
            //  Close all MQTT connections
            const connectionClosePromises = [];
            activeConnections.forEach((connection, brokerId) => {
                if (connection?.connected) {
                    connectionClosePromises.push(new Promise((resolve) => {
                        // Use false for graceful close, prevents sending Will Message
                        connection.end(false, () => { 
                            logger.info(`✅ MQTT connection to '${brokerId}' closed.`);
                            resolve();
                        });
                    }));
                }
            });

            if (connectionClosePromises.length > 0) {
                Promise.all(connectionClosePromises).then(finalShutdown);
            } else {
                finalShutdown(); 
            }
        });
    });
});