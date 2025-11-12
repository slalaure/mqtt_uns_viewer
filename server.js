/**
 * @license MIT
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
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

// --- Module Imports [MODIFIED] ---
const wsManager = require('./websocket-manager');
const mqttHandler = require('./mqtt-handler');
const { connectToMqttBroker } = require('./mqtt_client');
const simulatorManager = require('./simulator');
const dataManager = require('./database/dataManager'); // [NEW] Import Data Manager
// --- [END MODIFIED] ---


// --- Constants & Paths ---
const DATA_PATH = path.join(__dirname, 'data');
const ENV_PATH = path.join(DATA_PATH, '.env');
const ENV_EXAMPLE_PATH = path.join(__dirname, '.env.example');
const CERTS_PATH = path.join(DATA_PATH, 'certs');
const DB_PATH = path.join(DATA_PATH, 'mqtt_events.duckdb');
const CHART_CONFIG_PATH = path.join(DATA_PATH, 'charts.json'); 

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
        fs.writeFileSync(CHART_CONFIG_PATH, JSON.stringify({ configurations: [] }, null, 2)); // [MODIFIED] Default to new object format
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
let mainConnection = null;
let isPruning = false;
// [REMOVED] dbWriteQueue and dbBatchTimer are now managed by duckdb_repository.js

// --- Configuration from Environment ---
const config = {
    MQTT_BROKER_HOST: process.env.MQTT_BROKER_HOST?.trim() || null,
    MQTT_PORT: process.env.MQTT_PORT?.trim() || null,
    MQTT_PROTOCOL: process.env.MQTT_PROTOCOL?.trim() || null,
    MQTT_USERNAME: process.env.MQTT_USERNAME?.trim() || null,
    MQTT_PASSWORD: process.env.MQTT_PASSWORD?.trim() || null,
    CLIENT_ID: process.env.CLIENT_ID?.trim() || null,
    MQTT_TOPIC: process.env.MQTT_TOPIC?.trim() || null,
    CERT_FILENAME: process.env.CERT_FILENAME?.trim() || null,
    KEY_FILENAME: process.env.KEY_FILENAME?.trim() || null,
    CA_FILENAME: process.env.CA_FILENAME?.trim() || null,
    IS_SIMULATOR_ENABLED: process.env.SIMULATOR_ENABLED === 'true',
    IS_SPARKPLUG_ENABLED: process.env.SPARKPLUG_ENABLED === 'true',
    MQTT_ALPN_PROTOCOL: process.env.MQTT_ALPN_PROTOCOL?.trim() || null,
    MQTT_REJECT_UNAUTHORIZED: process.env.MQTT_REJECT_UNAUTHORIZED !== 'false', // Default to true
    PORT: process.env.PORT || 8080,
    DUCKDB_MAX_SIZE_MB: process.env.DUCKDB_MAX_SIZE_MB ? parseInt(process.env.DUCKDB_MAX_SIZE_MB, 10) : null,
    DUCKDB_PRUNE_CHUNK_SIZE: process.env.DUCKDB_PRUNE_CHUNK_SIZE ? parseInt(process.env.DUCKDB_PRUNE_CHUNK_SIZE, 10) : 500,
    DB_INSERT_BATCH_SIZE: process.env.DB_INSERT_BATCH_SIZE ? parseInt(process.env.DB_INSERT_BATCH_SIZE, 10) : 5000,
    DB_BATCH_INTERVAL_MS: process.env.DB_BATCH_INTERVAL_MS ? parseInt(process.env.DB_BATCH_INTERVAL_MS, 10) : 2000,
    // [NEW] Perennial Storage Config
    PERENNIAL_DRIVER: process.env.PERENNIAL_DRIVER?.trim() || 'none',
    PG_HOST: process.env.PG_HOST?.trim() || 'localhost',
    PG_PORT: process.env.PG_PORT ? parseInt(process.env.PG_PORT, 10) : 5432,
    PG_USER: process.env.PG_USER?.trim() || 'postgres',
    PG_PASSWORD: process.env.PG_PASSWORD?.trim() || 'password',
    PG_DATABASE: process.env.PG_DATABASE?.trim() || 'mqtt_uns_viewer',
    PG_TABLE_NAME: process.env.PG_TABLE_NAME?.trim() || 'mqtt_events',
    PG_INSERT_BATCH_SIZE: process.env.PG_INSERT_BATCH_SIZE ? parseInt(process.env.PG_INSERT_BATCH_SIZE, 10) : 1000,
    PG_BATCH_INTERVAL_MS: process.env.PG_BATCH_INTERVAL_MS ? parseInt(process.env.PG_BATCH_INTERVAL_MS, 10) : 5000,
    // [END NEW]
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
    API_ALLOWED_IPS: process.env.API_ALLOWED_IPS?.trim() || null
};


// --- Configuration Validation ---
if (!config.MQTT_BROKER_HOST || !config.CLIENT_ID || !config.MQTT_TOPIC) {
    logger.error("FATAL ERROR: One or more required environment variables are not set. Please check your .env file.");
    process.exit(1);
}
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

// --- Express App & Server Setup ---
const app = express();
const server = http.createServer(app);

// --- [MODIFIED] Mapper Engine Setup (Must be initialized before DB logic) ---
const mapperEngine = require('./mapper_engine')(
    (topic, payload) => {
        if (mainConnection) {
            mainConnection.publish(topic, payload, { qos: 1, retain: false });
        }
    },
    wsManager.broadcast, 
    logger,
    longReplacer
);

// --- [MODIFIED] DuckDB Setup (Centralized Initialization) ---
const dbFile = DB_PATH;
const dbWalFile = dbFile + '.wal';
let db; // db connection is now top-level
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
          payload JSON
      );`, (err) => {
        if (err) {
            logger.error({ err }, "❌ Failed to create table in DuckDB.");
        } else {
            logger.info("✅    -> Table 'mqtt_events' is ready.");
        }
    });

    // 2. Give the DB connection to the Mapper Engine
    mapperEngine.setDb(db);
    
    // 3. Initialize DB Maintenance
    const { getDbStatus, broadcastDbStatus, performMaintenance } = require('./db_manager')(db, dbFile, dbWalFile, wsManager.broadcast, logger, config.DUCKDB_MAX_SIZE_MB, config.DUCKDB_PRUNE_CHUNK_SIZE, () => isPruning, (status) => { isPruning = status; });

    // 4. Initialize Data Manager
    // This manager will orchestrate all writes
    dataManager.init(config, logger, mapperEngine, db, broadcastDbStatus);

    // 5. Initialize WebSocket Manager (passes DB for READS)
    wsManager.initWebSocketManager(server, db, logger, basePath, getDbStatus, longReplacer);

    // 6. Start DB Maintenance Interval
    setInterval(performMaintenance, 15000);

    // 7. Connect to MQTT Broker (now that all DB/Data logic is ready)
    connectToMqttBroker(config, logger, CERTS_PATH, (connection) => {
        mainConnection = connection;

        // Initialize the message handler
        const handleMessage = mqttHandler.init(
            logger,
            config,
            wsManager,
            mapperEngine,
            dataManager, // [MODIFIED] Pass dataManager
            broadcastDbStatus
        );

        // Attach the single handler function
        mainConnection.on('message', handleMessage);

        mainConnection.on('close', () => {
            logger.info('✅ Disconnected from MQTT Broker. Stopping all running simulators...');
            const statuses = simulatorManager.getStatuses();
            for (const name in statuses) {
                if (statuses[name] === 'running') {
                    simulatorManager.stopSimulator(name);
                }
            }
            wsManager.broadcast(JSON.stringify({ type: 'simulator-status', statuses: simulatorManager.getStatuses() }));
        });
    });
});
// --- [END] DuckDB Init Block ---

// [REMOVED] Old DB exec, db_manager.js init, wsManager.init (moved up)
// [REMOVED] All batch processing logic (processDbQueue, startDbBatchProcessor)
// [REMOVED] Old Mapper Engine init (moved up)

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
        return next(); // Filtre désactivé
    }

    const clientIp = req.ip;
    if (ALLOWED_IPS.includes(clientIp)) {
        return next(); // IP autorisée
    }

    logger.warn(`[SECURITY] Denied API access from IP: ${clientIp} (Not in ALLOWED_IPS list)`);
    res.status(403).json({ error: `Access denied. Your IP (${clientIp}) is not allowed.` });
};

// --- Main Router for Base Path ---
const mainRouter = express.Router();
mainRouter.use(express.json());
app.set('trust proxy', true);

// --- Simulator Logic ---
simulatorManager.init(logger, (topic, payload, isBinary) => {
    if (mainConnection) {
        mainConnection.publish(topic, payload, { qos: 1, retain: false });
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
        subscribedTopics: config.MQTT_TOPIC,
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

// [MODIFIED] MCP Context API Router
// We must delay its requirement until *after* db is initialized
mainRouter.use('/api/context', (req, res, next) => {
    if (!db) {
        return res.status(503).json({ error: "Database is not yet initialized." });
    }
    // Lazy-load the router to ensure 'db' is initialized
    // We also need to get `getDbStatus` from the db_manager
    const dbManager = require('./db_manager')(db, dbFile, dbWalFile, wsManager.broadcast, logger, config.DUCKDB_MAX_SIZE_MB, config.DUCKDB_PRUNE_CHUNK_SIZE, () => isPruning, (status) => { isPruning = status; });
    const mcpRouter = require('./routes/mcpApi')(
        db, // The live DB connection
        () => mainConnection,
        simulatorManager.getStatuses,
        dbManager.getDbStatus, // The getDbStatus function
        config
    );
    // Apply IP filter *before* the router
    ipFilterMiddleware(req, res, () => mcpRouter(req, res, next));
});

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
    if (!mainConnection || !mainConnection.connected) {
        return res.status(503).json({ error: "MQTT client is not connected." });
    }
    const { topic, payload, format, qos, retain } = req.body;
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
    mainConnection.publish(topic, finalPayload, { qos: qosLevel, retain: retainFlag }, (err) => {
        if (err) {
            logger.error({ err, topic: topic }, "❌ Error manually publishing message:");
            return res.status(500).json({ error: `Failed to publish. ${err.message}` });
        }
        logger.info(`✅ Manually published to '${topic}' (QoS: ${qosLevel}, Retain: ${retainFlag})`);
        res.status(200).json({ success: true, message: `Published to ${topic}` });
    });
});

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

// [REMOVED] MQTT Connection Logic - moved inside DB callback

// --- Server Start ---
server.listen(config.PORT, () => {
    logger.info(`✅ HTTP server started on http://localhost:${config.PORT}`);
    // [REMOVED] Maintenance interval, moved inside DB callback
});

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
    logger.info("\n✅ Gracefully shutting down...");
    
    // [MODIFIED] Stop data manager batching
    dataManager.stop();
    
    const statuses = simulatorManager.getStatuses();
    for (const name in statuses) {
        if (statuses[name] === 'running') {
            logger.info(`✅    -> Stopping simulator [${name}]...`);
            simulatorManager.stopSimulator(name);
        }
    }
    
    // [MODIFIED] finalShutdown is now async to wait for DB close
    const finalShutdown = async () => {
        // [MODIFIED] Call the dataManager to close all DB connections
        await dataManager.close(); 
        logger.info("✅ Shutdown complete.");
        process.exit(0);
    };
    
    wsManager.close(() => {
        logger.info("✅ WebSocket server closed.");
        server.close(() => {
            logger.info("✅ HTTP server closed.");
            if (mainConnection?.connected) {
                mainConnection.end(true, () => {
                    logger.info("✅ MQTT connection closed.");
                    finalShutdown(); // [MODIFIED] Call directly
                });
            } else {
                finalShutdown(); // [MODIFIED] Call directly
            }
        });
    });
});