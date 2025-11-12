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
const spBv10Codec = require('sparkplug-payload').get("spBv1.0"); // [NEW] For manual publish

// --- Module Imports [MODIFIED] ---
const wsManager = require('./websocket-manager');
const mqttHandler = require('./mqtt-handler');
const { connectToMqttBroker } = require('./mqtt_client');
const simulatorManager = require('./simulator'); // [MODIFIED] Import the manager
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
        fs.writeFileSync(CHART_CONFIG_PATH, JSON.stringify([], null, 2)); // Default to empty array
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
let dbWriteQueue = []; // Queue for batch inserts
let dbBatchTimer = null; // Timer for batch processor

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
    // [REMOVED] DB_BATCH_INSERT_ENABLED: process.env.DB_BATCH_INSERT_ENABLED === 'true',
    DB_INSERT_BATCH_SIZE: process.env.DB_INSERT_BATCH_SIZE ? parseInt(process.env.DB_INSERT_BATCH_SIZE, 10) : 5000, // [NEW]
    DB_BATCH_INTERVAL_MS: process.env.DB_BATCH_INTERVAL_MS ? parseInt(process.env.DB_BATCH_INTERVAL_MS, 10) : 2000,
    HTTP_USER: process.env.HTTP_USER?.trim() || null,
    HTTP_PASSWORD: process.env.HTTP_PASSWORD?.trim() || null,
    VIEW_TREE_ENABLED: process.env.VIEW_TREE_ENABLED !== 'false', // Default to true
    VIEW_SVG_ENABLED: process.env.VIEW_SVG_ENABLED !== 'false', // Default to true
    VIEW_HISTORY_ENABLED: process.env.VIEW_HISTORY_ENABLED !== 'false', // Default to true
    VIEW_MAPPER_ENABLED: process.env.VIEW_MAPPER_ENABLED !== 'false', // Default to true
    VIEW_CHART_ENABLED: process.env.VIEW_CHART_ENABLED !== 'false', // Default to true
    VIEW_PUBLISH_ENABLED: process.env.VIEW_PUBLISH_ENABLED !== 'false', // [NEW] Default to true
    SVG_FILE_PATH: process.env.SVG_FILE_PATH?.trim() || 'view.svg',
    BASE_PATH: process.env.BASE_PATH?.trim() || '/',
    VIEW_CONFIG_ENABLED: process.env.VIEW_CONFIG_ENABLED !== 'false', // Default to true
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
// [MODIFIED] Added Publish view to log
logger.info(`✅ UI Config: Tree[${config.VIEW_TREE_ENABLED}] SVG[${config.VIEW_SVG_ENABLED}] History[${config.VIEW_HISTORY_ENABLED}] Mapper[${config.VIEW_MAPPER_ENABLED}] Chart[${config.VIEW_CHART_ENABLED}] Publish[${config.VIEW_PUBLISH_ENABLED}]`);
logger.info(`✅ SVG Config: Path[${config.SVG_FILE_PATH}] `);
// [MODIFIED] Log new batch config
logger.info(`✅ ⚡ Database batch insert is ENABLED (Size: ${config.DB_INSERT_BATCH_SIZE}, Interval: ${config.DB_BATCH_INTERVAL_MS}ms).`);
// [NEW] Log demo limits
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

// --- DuckDB Setup ---
const dbFile = DB_PATH;
const dbWalFile = dbFile + '.wal';
const db = new duckdb.Database(dbFile, (err) => {
    if (err) {
        logger.error({ err }, "❌ FATAL ERROR: Could not connect to DuckDB.");
        process.exit(1);
    }
    logger.info("✅ 🦆 DuckDB database connected successfully at: %s", dbFile);
    startDbBatchProcessor();
});

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

// --- Database Maintenance ---
const { getDbStatus, broadcastDbStatus, performMaintenance } = require('./db_manager')(db, dbFile, dbWalFile, wsManager.broadcast, logger, config.DUCKDB_MAX_SIZE_MB, config.DUCKDB_PRUNE_CHUNK_SIZE, () => isPruning, (status) => { isPruning = status; });

// --- Initialize WebSocket Manager ---
wsManager.initWebSocketManager(server, db, logger, basePath, getDbStatus, longReplacer);

// --- DB Batch Insert Processor ---
function processDbQueue() {
    // [MODIFIED] Process a fixed-size chunk, not the whole queue
    const batch = dbWriteQueue.splice(0, config.DB_INSERT_BATCH_SIZE);
    if (batch.length === 0) {
        return;
    }

    db.serialize(() => {
        db.run('BEGIN TRANSACTION;', (err) => {
            if (err) return logger.error({ err }, "DB Batch: Failed to BEGIN TRANSACTION");
        });

        const stmt = db.prepare('INSERT INTO mqtt_events (timestamp, topic, payload) VALUES (?, ?, ?)');
        let errorCount = 0;

        for (const msg of batch) {
            stmt.run(msg.timestamp, msg.topic, msg.payloadStringForDb, (runErr) => {
                if (runErr) {
                    logger.warn({ err: runErr, topic: msg.topic }, "DB Batch: Failed to insert one message");
                    errorCount++;
                }
            });
        }

        stmt.finalize((finalizeErr) => {
            if (finalizeErr) {
                 logger.error({ err: finalizeErr }, "DB Batch: Failed to finalize statement");
                 db.run('ROLLBACK;'); 
                 return;
            }

            if (errorCount > 0) {
                logger.warn(`DB Batch: ${errorCount} errors, rolling back transaction.`);
                db.run('ROLLBACK;');
            } else {
                db.run('COMMIT;', (commitErr) => {
                    if (commitErr) {
                        logger.error({ err: commitErr }, "DB Batch: Failed to COMMIT transaction");
                    } else {
                        // [MODIFIED] Log with chunk size
                        logger.info(`✅ 🦆 Batch inserted ${batch.length} messages into DuckDB.`);
                        broadcastDbStatus();
                        
                        (async () => {
                            for (const msg of batch) {
                                if (msg.needsDb) { 
                                    try {
                                        // [MODIFIED] Parse from payloadStringForDb to ensure correct object
                                        const payloadObject = JSON.parse(msg.payloadStringForDb);
                                        await mapperEngine.processMessage(
                                            msg.topic, 
                                            payloadObject,
                                            msg.isSparkplugOrigin
                                        );
                                    } catch (mapperErr) {
                                        logger.error({ err: mapperErr, topic: msg.topic }, "Mapper trigger failed after batch.");
                                    }
                                }
                            }
                        })();
                    }
                });
            }
        });
    });
}

function startDbBatchProcessor() {
    // [MODIFIED] This logic is no longer conditional
    logger.info(`Starting DB batch processor (interval: ${config.DB_BATCH_INTERVAL_MS}ms)`);
    if (dbBatchTimer) clearInterval(dbBatchTimer);
    dbBatchTimer = setInterval(processDbQueue, config.DB_BATCH_INTERVAL_MS);
}

// --- Mapper Engine Setup ---
const mapperEngine = require('./mapper_engine')(
    db, 
    (topic, payload) => {
        if (mainConnection) {
            mainConnection.publish(topic, payload, { qos: 1, retain: false });
        }
    },
    wsManager.broadcast, 
    logger,
    longReplacer
);

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

// --- Simulator Logic [MODIFIED] ---
// Initialize the Simulator Manager
simulatorManager.init(logger, (topic, payload, isBinary) => {
    if (mainConnection) {
        mainConnection.publish(topic, payload, { qos: 1, retain: false });
    }
}, config.IS_SPARKPLUG_ENABLED);
// --- [END MODIFIED] ---


// --- API Routes (Mounted on mainRouter) ---

// [MODIFIED] This route is now dynamic based on a query parameter
mainRouter.get('/api/svg/file', (req, res) => {
    const filename = req.query.name;

    // Security: Validate and sanitize the filename
    if (!filename || !filename.endsWith('.svg')) {
        return res.status(400).json({ error: 'Invalid or missing SVG file name.' });
    }
    // Prevent directory traversal: path.basename strips directory info
    const sanitizedName = path.basename(filename);
    
    const configuredSvgPath = path.join(DATA_PATH, sanitizedName);
    
    if (fs.existsSync(configuredSvgPath)) {
        res.sendFile(configuredSvgPath);
    } else {
        logger.error(`Requested SVG file not found at: ${configuredSvgPath}`);
        res.status(404).send(`SVG file not found. Checked path: ${configuredSvgPath}`);
    }
});

// [NEW] API endpoint to list available SVG files
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
        svgFilePath: config.SVG_FILE_PATH // [NEW] Pass default SVG path
    });
});

// --- [MODIFIED] Simulator API Routes ---
if (config.IS_SIMULATOR_ENABLED) {
    logger.info("✅ Simulator is ENABLED. Creating API endpoints at /api/simulator/*");
    
    // GET /api/simulator/status
    // Returns the status of all available simulators
    mainRouter.get('/api/simulator/status', (req, res) => {
        res.json({ statuses: simulatorManager.getStatuses() });
    });

    // POST /api/simulator/start/:name
    // Starts a specific simulator by name
    mainRouter.post('/api/simulator/start/:name', (req, res) => {
        const name = req.params.name;
        const result = simulatorManager.startSimulator(name);
        wsManager.broadcast(JSON.stringify({ type: 'simulator-status', statuses: simulatorManager.getStatuses() }));
        res.status(200).json(result);
    });

    // POST /api/simulator/stop/:name
    // Stops a specific simulator by name
    mainRouter.post('/api/simulator/stop/:name', (req, res) => {
        const name = req.params.name;
        const result = simulatorManager.stopSimulator(name);
        wsManager.broadcast(JSON.stringify({ type: 'simulator-status', statuses: simulatorManager.getStatuses() }));
        res.status(200).json(result);
    });
}
// --- [END MODIFIED] ---

// MCP Context API Router
// [MODIFIED] Pass getStatuses function from the manager
const mcpRouter = require('./routes/mcpApi')(db, () => mainConnection, simulatorManager.getStatuses, getDbStatus, config);
mainRouter.use('/api/context', ipFilterMiddleware, mcpRouter);

// --- [MODIFIED] Configuration API Router (Conditional) ---
if (config.VIEW_CONFIG_ENABLED) {
    logger.info("✅ Configuration editor UI is ENABLED.");
    const configRouter = require('./routes/configApi')(ENV_PATH, ENV_EXAMPLE_PATH, DATA_PATH, logger);
    mainRouter.use('/api/env', ipFilterMiddleware, configRouter);
} else {
    logger.info("✅ 🔒 Configuration editor UI is DISABLED by .env settings.");
    // Block the API if the UI is disabled
    mainRouter.use('/api/env', (req, res) => {
        res.status(403).json({ error: "Configuration API is disabled by server settings." });
    });
}
// --- [END MODIFIED] ---

// Mapper API Router
const mapperRouter = require('./routes/mapperApi')(mapperEngine);
mainRouter.use('/api/mapper', ipFilterMiddleware, mapperRouter);

// Chart API Router
const chartRouter = require('./routes/chartApi')(CHART_CONFIG_PATH, logger);
mainRouter.use('/api/chart', ipFilterMiddleware, chartRouter);


// [NEW] API Route for Manual Publishing
mainRouter.post('/api/publish/message', ipFilterMiddleware, (req, res) => {
    if (!mainConnection || !mainConnection.connected) {
        return res.status(503).json({ error: "MQTT client is not connected." });
    }

    const { topic, payload, format, qos, retain } = req.body;

    // --- Validation ---
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
                // Client sends payload as a string from a textarea.
                // We parse it to validate, then re-stringify for the broker.
                finalPayload = JSON.stringify(JSON.parse(payload));
                break;
            case 'sparkplugb':
                // Assume payload is JSON text representing a Sparkplug payload object
                const spPayloadObj = JSON.parse(payload);
                
                // Add timestamp if not present
                if (!spPayloadObj.timestamp) {
                    spPayloadObj.timestamp = Date.now();
                }
                // Add seq if not present
                if (spPayloadObj.seq === undefined) {
                    spPayloadObj.seq = 0;
                }
                // Handle BigInts in metrics (e.g., if user types "10n")
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
                finalPayload = payload; // Send as raw string
                break;
        }
    } catch (err) {
        logger.error({ err, topic: topic }, "❌ Error processing manual publish payload:");
        return res.status(400).json({ error: `Invalid payload format for '${format}'. ${err.message}` });
    }

    // --- Publish ---
    mainConnection.publish(topic, finalPayload, { qos: qosLevel, retain: retainFlag }, (err) => {
        if (err) {
            logger.error({ err, topic: topic }, "❌ Error manually publishing message:");
            return res.status(500).json({ error: `Failed to publish. ${err.message}` });
        }
        logger.info(`✅ Manually published to '${topic}' (QoS: ${qosLevel}, Retain: ${retainFlag})`);
        res.status(200).json({ success: true, message: `Published to ${topic}` });
    });
});


// --- [MODIFIED] Static Assets (with conditional block) ---

// Conditionally block config page if disabled in .env
if (!config.VIEW_CONFIG_ENABLED) {
    mainRouter.get('/config.html', (req, res) => {
        res.status(403).send('Access to the configuration page is disabled by server settings.');
    });
    mainRouter.get('/config.js', (req, res) => {
        res.status(403).send('Access to configuration scripts is disabled.');
    });
}

mainRouter.use(express.static(path.join(__dirname, 'public')));
// --- [END MODIFIED] ---

// --- Mount Everything ---
app.use(authMiddleware);
app.use(basePath, mainRouter);

// --- Root Redirect ---
if (basePath !== '/') {
    app.get('/', (req, res) => {
        res.redirect(basePath);
    });
}

// --- MQTT Connection Logic ---
connectToMqttBroker(config, logger, CERTS_PATH, (connection) => {
    mainConnection = connection;

    // Initialize the message handler
    const handleMessage = mqttHandler.init(
        logger,
        config,
        wsManager,
        mapperEngine,
        db,
        dbWriteQueue,
        broadcastDbStatus
    );

    // Attach the single handler function
    mainConnection.on('message', handleMessage);

    // --- [MODIFIED] Disconnect handler to stop all sims ---
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
    // --- [END MODIFIED] ---
});

// --- Child Process Management (MCP) ---
/*function startMcpServer() {
    logger.info("✅ 🚀 Starting MCP Server as a child process...");
    mcpProcess = spawn('node', ['mcp_server.mjs'], { stdio: 'inherit' });
    mcpProcess.on('close', (code) => logger.info(`MCP Server process exited with code ${code}`));
    mcpProcess.on('error', (err) => logger.error({ err }, '❌ Failed to start MCP Server process:'));
}
*/

// --- Server Start ---
server.listen(config.PORT, () => {
    logger.info(`✅ HTTP server started on http://localhost:${config.PORT}`);
    if (config.DUCKDB_MAX_SIZE_MB) {
        logger.info(`Database auto-pruning enabled. Max size: ${config.DUCKDB_MAX_SIZE_MB} MB.`);
    }
    setInterval(performMaintenance, 15000);
    //startMcpServer();
});

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
    logger.info("\n✅ Gracefully shutting down...");
    /*if (mcpProcess) {
        logger.info("✅    -> Stopping MCP Server process...");
        mcpProcess.kill('SIGINT');
    }*/

    if (dbBatchTimer) {
        clearInterval(dbBatchTimer);
        logger.info("✅    -> Stopped DB batch timer.");
        logger.info("✅    -> Processing final DB write queue...");
        processDbQueue(); 
    }
    
    // --- [MODIFIED] Stop all running simulators ---
    const statuses = simulatorManager.getStatuses();
    for (const name in statuses) {
        if (statuses[name] === 'running') {
            logger.info(`✅    -> Stopping simulator [${name}]...`);
            simulatorManager.stopSimulator(name);
        }
    }
    // --- [END MODIFIED] ---
    
    const finalShutdown = () => {
        logger.info("✅ Forcing final database checkpoint...");
        db.exec("CHECKPOINT;", (err) => {
            if (err) logger.error({ err }, "❌ Error during final CHECKPOINT:");
            else logger.info("✅    -> Checkpoint successful.");
            db.close((err) => {
                if (err) logger.error({ err }, "Error closing DuckDB:");
                else logger.info("✅ 🦆 DuckDB connection closed.");
                logger.info("✅ Shutdown complete.");
                process.exit(0);
            });
        });
    };
    
    const shutdownDelay = config.DB_BATCH_INTERVAL_MS + 1000;
    
    wsManager.close(() => {
        logger.info("✅ WebSocket server closed.");
        server.close(() => {
            logger.info("✅ HTTP server closed.");
            if (mainConnection?.connected) {
                mainConnection.end(true, () => {
                    logger.info("✅ MQTT connection closed.");
                    setTimeout(finalShutdown, shutdownDelay);
                });
            } else {
                setTimeout(finalShutdown, shutdownDelay);
            }
        });
    });
});