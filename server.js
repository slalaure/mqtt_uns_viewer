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
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY, EXPRESS OR
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
const { WebSocketServer } = require('ws');
const mqtt = require('mqtt');
const duckdb = require('duckdb');
const spBv10Codec = require('sparkplug-payload').get("spBv1.0");
const { spawn } = require('child_process');
const basicAuth = require('basic-auth');

// --- Constants & Paths ---
const ALLOWED_IPS = ["127.0.0.1", "::1", "172.17.0.1", "172.18.0.1", "::ffff:172.18.0.1","::ffff:172.21.0.1"];
const DATA_PATH = path.join(__dirname, 'data');
const ENV_PATH = path.join(DATA_PATH, '.env');
const ENV_EXAMPLE_PATH = path.join(__dirname, '.env.example');
const CERTS_PATH = path.join(DATA_PATH, 'certs');
const DB_PATH = path.join(DATA_PATH, 'mqtt_events.duckdb');
const SVG_PATH = path.join(DATA_PATH, 'view.svg');

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
    PORT: process.env.PORT || 8080,
    DUCKDB_MAX_SIZE_MB: process.env.DUCKDB_MAX_SIZE_MB ? parseInt(process.env.DUCKDB_MAX_SIZE_MB, 10) : null,
    DUCKDB_PRUNE_CHUNK_SIZE: process.env.DUCKDB_PRUNE_CHUNK_SIZE ? parseInt(process.env.DUCKDB_PRUNE_CHUNK_SIZE, 10) : 500,
    HTTP_USER: process.env.HTTP_USER?.trim() || null,
    HTTP_PASSWORD: process.env.HTTP_PASSWORD?.trim() || null
};


// --- Configuration Validation ---
if (!config.MQTT_BROKER_HOST || !config.CLIENT_ID || !config.MQTT_TOPIC) {
    logger.error("FATAL ERROR: One or more required environment variables are not set. Please check your .env file.");
    process.exit(1);
}
if (config.IS_SPARKPLUG_ENABLED) logger.info("✅ 🚀 Sparkplug B decoding is ENABLED.");
if (config.HTTP_USER && config.HTTP_PASSWORD) logger.info("✅ 🔒 HTTP Basic Authentication is ENABLED.");

// --- Helper Function for Sparkplug (handles BigInt) ---
function longReplacer(key, value) {
    if (typeof value === 'bigint') {
        return value.toString(); // Convert BigInt to string for JSON
    }
    return value;
}
// --- [NEW] Helper to safely parse potentially non-JSON ---
function safeJsonParse(str) {
    try {
        return JSON.parse(str);
    } catch (e) {
        // If parsing fails, return an object indicating it's raw data
        return { raw_payload: str };
    }
}

// --- DuckDB Setup ---
const dbFile = DB_PATH;
const dbWalFile = dbFile + '.wal';
const db = new duckdb.Database(dbFile, (err) => {
    if (err) {
        logger.error({ err }, "❌ FATAL ERROR: Could not connect to DuckDB.");
        process.exit(1);
    }
    logger.info("✅ 🦆 DuckDB database connected successfully at: %s", dbFile);
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

// --- Express App & WebSocket Server Setup ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- WebSocket Logic ---
function broadcast(message) {
    wss.clients.forEach(client => {
        if (client.readyState === client.OPEN) {
            client.send(message);
        }
    });
}

// --- Database Maintenance ---
const { getDbStatus, broadcastDbStatus, performMaintenance } = require('./db_manager')(db, dbFile, dbWalFile, broadcast, logger, config.DUCKDB_MAX_SIZE_MB, config.DUCKDB_PRUNE_CHUNK_SIZE, () => isPruning, (status) => { isPruning = status; });

// ---  Mapper Engine Setup ---
const mapperEngine = require('./mapper_engine')(
    (topic, payload) => { // Publisher callback
        if (mainConnection) {
            // The payload here can be a String (JSON) or a Buffer (Sparkplug)
            mainConnection.publish(topic, payload, { qos: 1, retain: false });
        }
    },
    broadcast, // Pass the main broadcast function
    logger,    // Pass the main logger
    longReplacer // Pass the replacer function (still needed for JSON stringify)
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

const ipFilterMiddleware = (req, res, next) => {
    if (ALLOWED_IPS.length === 0) return next();
    const clientIp = req.ip;
    if (ALLOWED_IPS.includes(clientIp)) {
        next();
    } else {
        logger.warn(`[SECURITY] Denied access to API from IP: ${clientIp}`);
        res.status(403).json({ error: `Access denied. Your IP (${clientIp}) is not allowed.` });
    }
};

app.use(authMiddleware);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.set('trust proxy', true);

// --- Simulator Logic ---
const { startSimulator, stopSimulator, getStatus } = require('./simulator')(logger, (topic, payload, isBinary) => {
    if (mainConnection) {
        mainConnection.publish(topic, payload, { qos: 1, retain: false });
    }
}, config.IS_SPARKPLUG_ENABLED);


// --- API Routes ---
app.get('/view.svg', (req, res) => {
    if (fs.existsSync(SVG_PATH)) {
        res.sendFile(SVG_PATH);
    } else {
        res.status(404).send('SVG file not found in data directory.');
    }
});

app.get('/api/config', (req, res) => {
    res.json({
        isSimulatorEnabled: config.IS_SIMULATOR_ENABLED,
        // ADDED: Send subscription topics to frontend
        subscribedTopics: config.MQTT_TOPIC
    });
});

if (config.IS_SIMULATOR_ENABLED) {
    logger.info("✅ Simulator is ENABLED. Creating API endpoints at /api/simulator/*");
    app.get('/api/simulator/status', (req, res) => {
        res.json({ status: getStatus() });
    });
    app.post('/api/simulator/start', (req, res) => {
        const result = startSimulator();
        broadcast(JSON.stringify({ type: 'simulator-status', status: result.status }));
        res.status(200).json(result);
    });
    app.post('/api/simulator/stop', (req, res) => {
        const result = stopSimulator();
        broadcast(JSON.stringify({ type: 'simulator-status', status: result.status }));
        res.status(200).json(result);
    });
}

// MCP Context API Router
const mcpRouter = require('./routes/mcpApi')(db, () => mainConnection, getStatus, getDbStatus);
app.use('/api/context', ipFilterMiddleware, mcpRouter);

// Configuration API Router
const configRouter = require('./routes/configApi')(ENV_PATH, ENV_EXAMPLE_PATH, DATA_PATH, logger);
app.use('/api/env', ipFilterMiddleware, configRouter);

// [NEW V2] Mapper API Router
const mapperRouter = require('./routes/mapperApi')(mapperEngine);
app.use('/api/mapper', ipFilterMiddleware, mapperRouter);


// --- WebSocket Connection Handling ---
wss.on('connection', (ws) => {
    logger.info('✅ ➡️ WebSocket client connected.');

    // Send initial batch of historical data
    db.all("SELECT * FROM mqtt_events ORDER BY timestamp DESC LIMIT 200", (err, rows) => {
        if (!err && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'history-initial-data', data: rows }));
        }
    });

    // Handle messages from client (e.g., request for specific topic history)
    ws.on('message', (message) => {
        try {
            const parsedMessage = JSON.parse(message);
            if (parsedMessage.type === 'get-topic-history' && parsedMessage.topic) {
                db.all("SELECT * FROM mqtt_events WHERE topic = ? ORDER BY timestamp DESC LIMIT 20", [parsedMessage.topic], (err, rows) => {
                    if (err) {
                        logger.error({ err, topic: parsedMessage.topic }, `❌ DuckDB Error fetching history for topic`);
                    } else if (ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify({ type: 'topic-history-data', topic: parsedMessage.topic, data: rows }));
                    }
                });
            }
        } catch (e) {
            logger.error({ err: e }, "❌ Error processing WebSocket message from client");
        }
    });
    broadcastDbStatus();
});

// --- MQTT Connection Logic ---
const { connectToMqttBroker } = require('./mqtt_client');
connectToMqttBroker(config, logger, CERTS_PATH, (connection) => {
    mainConnection = connection;

    // MQTT Message Handler
    mainConnection.on('message', (topic, payload) => {
        const timestamp = new Date();
        let payloadObjectForMapper = null; // Object to pass to mapper
        let payloadStringForWs = null;     // String to broadcast via WS
        let payloadStringForDb = null;     // String to insert into DB
        let isSparkplugOrigin = false;
        let processingError = null;

        try {
            // --- 1. Decoding ---
            if (config.IS_SPARKPLUG_ENABLED && topic.startsWith('spBv1.0/')) {
                try {
                    const decodedPayload = spBv10Codec.decodePayload(payload);
                    isSparkplugOrigin = true;
                    // Use replacer for WS/DB string representation
                    payloadStringForWs = JSON.stringify(decodedPayload, longReplacer, 2);
                    payloadStringForDb = JSON.stringify(decodedPayload, longReplacer); // DB doesn't need pretty print
                    payloadObjectForMapper = decodedPayload; // Pass the raw decoded object
                } catch (decodeErr) {
                    processingError = decodeErr;
                    logger.error({ msg: "❌ Error decoding Sparkplug payload", topic: topic, error_message: decodeErr.message });
                    payloadStringForWs = payload.toString('hex'); // Fallback hex string for WS
                    payloadStringForDb = JSON.stringify({ raw_payload_hex: payloadStringForWs, decode_error: decodeErr.message });
                    payloadObjectForMapper = safeJsonParse(payloadStringForDb); // Pass error info to mapper
                }
            } else {
                // Regular payload (try UTF-8)
                let tempPayloadString = '';
                try {
                    tempPayloadString = payload.toString('utf-8');
                    payloadStringForWs = tempPayloadString; // Assume UTF-8 for WS initially
                     // Try to parse as JSON for DB and Mapper
                    try {
                        payloadObjectForMapper = JSON.parse(tempPayloadString);
                        payloadStringForDb = tempPayloadString; // It's valid JSON, store as is
                    } catch (parseError) {
                         // Not JSON, treat as raw string
                         logger.warn(`Received non-JSON payload on topic ${topic}. Storing as raw string.`);
                         payloadObjectForMapper = { raw_payload: tempPayloadString }; // Wrap for mapper
                         payloadStringForDb = JSON.stringify(payloadObjectForMapper); // Store wrapped object in DB
                    }

                } catch (utf8Err) {
                    processingError = utf8Err;
                    logger.error({ msg: "❌ Error converting payload to UTF-8", topic: topic, error_message: utf8Err.message });
                    payloadStringForWs = payload.toString('hex'); // Fallback hex string
                    payloadStringForDb = JSON.stringify({ raw_payload_hex: payloadStringForWs, decode_error: utf8Err.message });
                    payloadObjectForMapper = safeJsonParse(payloadStringForDb);
                }
            }

            // --- Safety Net (Should ideally not be needed now) ---
             if (payloadObjectForMapper === null) {
                 logger.error(`payloadObjectForMapper remained null for topic ${topic}. This should not happen.`);
                 // Create a fallback object
                 payloadObjectForMapper = { error: "Payload processing failed unexpectedly", raw_hex: payload.toString('hex')};
                 payloadStringForDb = JSON.stringify(payloadObjectForMapper);
                 payloadStringForWs = payloadStringForDb; // Send error via WS too
             }
             if (payloadStringForDb === null) payloadStringForDb = JSON.stringify({ error: "DB Payload string is null"});
             if (payloadStringForWs === null) payloadStringForWs = JSON.stringify({ error: "WS Payload string is null"});


            // --- 3. Broadcast WebSocket ---
            const finalMessageObject = {
                type: 'mqtt-message',
                topic,
                payload: payloadStringForWs, // Send string representation
                timestamp: timestamp.toISOString()
            };
            broadcast(JSON.stringify(finalMessageObject));

            // --- 4. Insert into DuckDB ---
            const stmt = db.prepare('INSERT INTO mqtt_events (timestamp, topic, payload) VALUES (?, ?, ?)');
            stmt.run(timestamp, topic, payloadStringForDb, (err) => { // Insert string representation
                if (err) {
                    logger.error({ msg: "❌ DuckDB Insert Error", error: err, topic: topic, payloadAttempted: (payloadStringForDb || '').substring(0, 200) + '...' });
                } else {
                    broadcastDbStatus();
                }
                 stmt.finalize();
            });

            // --- [MODIFIED V2] 5. Process Message through Mapper Engine ---
            // Pass the original topic, the decoded/parsed object, and the flag
            mapperEngine.processMessage(topic, payloadObjectForMapper, isSparkplugOrigin);


        } catch (err) { // Catch unexpected errors in this block's logic
            logger.error({ msg: `❌ UNEXPECTED FATAL ERROR during message processing logic for topic ${topic}`, topic: topic, error_message: err.message, error_stack: err.stack, rawPayloadStartHex: payload.slice(0, 30).toString('hex') });
        }
    });

    // Disconnect handler
    mainConnection.on('close', () => {
        logger.info('✅ Disconnected from MQTT Broker.');
        const result = stopSimulator();
        broadcast(JSON.stringify({ type: 'simulator-status', status: result.status }));
    });
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
    stopSimulator();
    wss.clients.forEach(ws => ws.terminate());
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
    wss.close(() => {
        logger.info("✅ WebSocket server closed.");
        server.close(() => {
            logger.info("✅ HTTP server closed.");
            if (mainConnection?.connected) {
                mainConnection.end(true, () => {
                    logger.info("✅ MQTT connection closed.");
                    finalShutdown();
                });
            } else {
                finalShutdown();
            }
        });
    });
});