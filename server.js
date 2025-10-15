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


// Liste des adresses IP autorisées à accéder aux API (séparées par des virgules).
// Inclut localhost (IPv4, IPv6) et les passerelles Docker courantes.
const ALLOWED_IPS=["127.0.0.1","::1","172.17.0.1","172.18.0.1","::ffff:172.18.0.1"];

// --- Imports ---
const express = require('express');
const http_server = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const mqtt = require('mqtt');
const duckdb = require('duckdb');
const spBv10Codec = require('sparkplug-payload').get("spBv1.0");
const { spawn } = require('child_process'); // [NOUVEAU] Import du module pour les processus enfants

const dataPath = path.join(__dirname, 'data');
const envPath = path.join(dataPath, '.env');
const envExamplePath = path.join(dataPath, '.env.example');
const certsPath = path.join(dataPath, 'certs');
const dbPath = path.join(dataPath, 'mqtt_events.duckdb');
const svgPath = path.join(dataPath, 'view.svg');
// Si .env n'existe pas, le créer à partir de .env.example
if (!fs.existsSync(envPath)) {
    console.log("No .env file found in 'data' directory. Creating one from .env.example...");
    try {
        fs.copyFileSync(envExamplePath, envPath);
        console.log(".env file created successfully in ./data/");
    } catch (err) {
        console.error("FATAL ERROR: Could not create .env file. Make sure 'data/.env.example' exists.", err);
        process.exit(1);
    }
}
require('dotenv').config({ path: envPath });
// --- Global Variables ---
let mcpProcess = null; // [NOUVEAU] Variable pour stocker le processus enfant MCP

// --- Configuration from Environment Variables (with sanitization) ---
const MQTT_BROKER_HOST = process.env.MQTT_BROKER_HOST ? process.env.MQTT_BROKER_HOST.trim() : null;
const MQTT_PORT = process.env.MQTT_PORT ? process.env.MQTT_PORT.trim() : null;
const MQTT_PROTOCOL = process.env.MQTT_PROTOCOL ? process.env.MQTT_PROTOCOL.trim() : null;
const MQTT_USERNAME = process.env.MQTT_USERNAME ? process.env.MQTT_USERNAME.trim() : null;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD ? process.env.MQTT_PASSWORD.trim() : null;
const CLIENT_ID = process.env.CLIENT_ID ? process.env.CLIENT_ID.trim() : null;
const MQTT_TOPIC = process.env.MQTT_TOPIC ? process.env.MQTT_TOPIC.trim() : null;
const CERT_FILENAME = process.env.CERT_FILENAME ? process.env.CERT_FILENAME.trim() : null;
const KEY_FILENAME = process.env.KEY_FILENAME ? process.env.KEY_FILENAME.trim() : null;
const CA_FILENAME = process.env.CA_FILENAME ? process.env.CA_FILENAME.trim() : null;
const SIMULATOR_ENABLED = process.env.SIMULATOR_ENABLED;
const isSimulatorEnabled = SIMULATOR_ENABLED === 'true';
const SPARKPLUG_ENABLED = process.env.SPARKPLUG_ENABLED === 'true'; // Sparkplug flag
const MQTT_ALPN_PROTOCOL = process.env.MQTT_ALPN_PROTOCOL ? process.env.MQTT_ALPN_PROTOCOL.trim() : null;
const PORT = process.env.PORT || 8080;
const DUCKDB_MAX_SIZE_MB = process.env.DUCKDB_MAX_SIZE_MB ? parseInt(process.env.DUCKDB_MAX_SIZE_MB, 10) : null;
const DUCKDB_PRUNE_CHUNK_SIZE = process.env.DUCKDB_PRUNE_CHUNK_SIZE ? parseInt(process.env.DUCKDB_PRUNE_CHUNK_SIZE, 10) : 500;

// --- Validate Configuration ---
if (!MQTT_BROKER_HOST || !CLIENT_ID || !MQTT_TOPIC ) {
    console.error("FATAL ERROR: One or more required environment variables are not set. Please check your .env file.");
    process.exit(1);
}
if (SPARKPLUG_ENABLED) {
    console.log("🚀 Sparkplug B decoding is ENABLED.");
}

// --- Certificate Paths ---
const CERT_PATH = path.join(certsPath, CERT_FILENAME);
const KEY_PATH = path.join(certsPath, KEY_FILENAME);
const CA_PATH = path.join(certsPath, CA_FILENAME);

// --- DuckDB Setup ---
const dbFile = dbPath;
const dbWalFile = dbFile + '.wal';
const db = new duckdb.Database(dbFile, (err) => {
    if (err) {
        console.error("❌ FATAL ERROR: Could not connect to DuckDB.", err);
        process.exit(1);
    }
    console.log("🦆 DuckDB database connected successfully at:", dbFile);
});
db.exec(`
  CREATE TABLE IF NOT EXISTS mqtt_events (
      timestamp TIMESTAMPTZ,
      topic VARCHAR,
      payload JSON
  );`, (err) => {
    if (err) {
        console.error("❌ Failed to create table in DuckDB.", err);
    } else {
        console.log("   -> Table 'mqtt_events' is ready.");
    }
});

// --- Simulator State & Logic ---
let simulatorInterval = null;
const SIMULATION_INTERVAL_MS = 1500;
const randomBetween = (min, max, decimals = 2) => parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
let simState = { step: 0, workOrders: { palladiumCore: null, vibraniumCasing: null }, operators: ["Pepper Potts", "Happy Hogan", "James Rhodes", "J.A.R.V.I.S.", "Peter Parker"], spSeq: 0 };
const scenario = [
    () => { simState.workOrders.palladiumCore = { id: `WO-PD${Math.floor(10000 + Math.random() * 90000)}`, facility: "malibu", itemNumber: "ARC-PD-CORE-01", status: "RELEASED" }; return { topic: `stark_industries/malibu_facility/erp/workorder`, payload: { ...simState.workOrders.palladiumCore, itemName: "Palladium Core" } }; },
    () => ({ topic: 'stark_industries/malibu_facility/assembly_line_01/palladium_core_cell/mes/operation', payload: { workOrderId: simState.workOrders.palladiumCore.id, step: 10, stepName: "Micro-particle assembly", operator: simState.operators[0], status: "IN_PROGRESS" } }),
    () => ({ topic: 'stark_industries/malibu_facility/assembly_line_01/palladium_core_cell/robotic_arm_01/torque', payload: { value: randomBetween(8.5, 9.2), unit: "Nm" } }),
    () => ({ topic: 'stark_industries/malibu_facility/assembly_line_01/mes/oee', payload: { availability: randomBetween(0.98, 0.99), performance: randomBetween(0.96, 0.99), quality: 1.0, oee: 0.95 } }),
    () => { simState.workOrders.vibraniumCasing = { id: `WO-VB${Math.floor(10000 + Math.random() * 90000)}`, facility: "malibu", itemNumber: "ARC-VB-CASE-03", status: "RELEASED" }; return { topic: `stark_industries/malibu_facility/erp/workorder`, payload: { ...simState.workOrders.vibraniumCasing, itemName: "Vibranium Casing" } }; },
    () => ({ topic: 'stark_industries/malibu_facility/assembly_line_01/vibranium_casing_cell/mes/operation', payload: { workOrderId: simState.workOrders.vibraniumCasing.id, step: 10, stepName: "Laser welding", operator: simState.operators[1], status: "IN_PROGRESS" } }),
    () => ({ topic: 'stark_industries/malibu_facility/assembly_line_01/vibranium_casing_cell/laser_welder_01/temperature', payload: { value: randomBetween(1200, 1500, 0), unit: "°C" } }),
    () => ({ topic: 'stark_industries/malibu_facility/assembly_line_01/palladium_core_cell/mes/operation', payload: { workOrderId: simState.workOrders.palladiumCore.id, step: 20, stepName: "Magnetic field stabilization", operator: simState.operators[2], status: "IN_PROGRESS" } }),
    () => ({ topic: 'stark_industries/malibu_facility/assembly_line_01/clean_room_01/humidity', payload: { value: randomBetween(25, 28, 1), unit: "%RH" } }),
    () => ({ topic: 'stark_industries/malibu_facility/assembly_line_01/vibranium_casing_cell/mes/operation', payload: { workOrderId: simState.workOrders.vibraniumCasing.id, step: 20, stepName: "5-axis CNC milling", operator: simState.operators[3], status: "IN_PROGRESS" } }),
    () => ({ topic: 'stark_industries/malibu_facility/assembly_line_01/vibranium_casing_cell/cnc_mill_05/vibration', payload: { value: randomBetween(0.2, 0.5), unit: "g" } }),
    () => ({ topic: 'stark_industries/malibu_facility/cmms/maintenance_request', payload: { equipmentId: "cnc_mill_05", equipmentPath: "malibu_facility/assembly_line_01/vibranium_casing_cell/cnc_mill_05", description: "Abnormal vibration detected by J.A.R.V.I.S.", priority: "HIGH" } }),
    () => { const isPass = Math.random() > 0.10; simState.workOrders.palladiumCore.quality_check = isPass ? "PASS" : "FAIL"; return { topic: 'stark_industries/malibu_facility/quality_control_station/qms/energy_output_test', payload: { workOrderId: simState.workOrders.palladiumCore.id, result: simState.workOrders.palladiumCore.quality_check, value: isPass ? randomBetween(2.9, 3.1) : randomBetween(1.5, 2.2), unit: "GJ/s" } }; },
    () => { if (simState.workOrders.palladiumCore.quality_check === "FAIL") { return { topic: 'stark_industries/malibu_facility/assembly_line_01/palladium_core_cell/mes/operation', payload: { workOrderId: simState.workOrders.palladiumCore.id, step: 25, stepName: "REWORK - Field recalibration", operator: simState.operators[4], status: "IN_PROGRESS" } }; } return null; },
    () => { if (simState.workOrders.palladiumCore.quality_check === "FAIL") { simState.workOrders.palladiumCore.quality_check = "PASS"; return { topic: 'stark_industries/malibu_facility/quality_control_station/qms/energy_output_test', payload: { workOrderId: simState.workOrders.palladiumCore.id, result: "PASS", value: randomBetween(3.0, 3.2), unit: "GJ/s", details: "Retest post-recalibration OK" } }; } return null; },
    () => { simState.workOrders.palladiumCore.status = "COMPLETED"; return { topic: `stark_industries/malibu_facility/erp/workorder`, payload: { ...simState.workOrders.palladiumCore, completionDate: new Date().toISOString() } }; },
    () => { simState.workOrders.vibraniumCasing.status = "COMPLETED"; return { topic: `stark_industries/malibu_facility/erp/workorder`, payload: { ...simState.workOrders.vibraniumCasing, completionDate: new Date().toISOString() } }; },
];
let mainConnection = null;

// Conditionally add Sparkplug B step to scenario
if (SPARKPLUG_ENABLED) {
    const sparkplugDeviceStep = () => {
        const topic = 'spBv1.0/stark_industries/NDATA/robot_arm_01';
        simState.spSeq = (simState.spSeq + 1) % 256;
        
        const payloadObject = {
            timestamp: new Date().getTime(),
            metrics: [
                { name: "Motor/Speed", value: Math.floor(randomBetween(1500, 1800)), type: "Int32" },
                { name: "Motor/Temp", value: randomBetween(80, 85, 1), type: "Float" }
            ],
            seq: simState.spSeq
        };

        const payloadBuffer = spBv10Codec.encodePayload(payloadObject);
        return { topic: topic, payload: payloadBuffer, isBinary: true };
    };

    scenario.splice(3, 0, sparkplugDeviceStep);
    console.log("   -> Sparkplug B demo step has been added to the simulator scenario.");
}


// --- Web Server Setup ---
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
const server = http_server.createServer(app);
const wss = new WebSocketServer({ server });

app.get('/view.svg', (req, res) => {
    if (fs.existsSync(svgPath)) {
        res.sendFile(svgPath);
    } else {
        res.status(404).send('SVG file not found in data directory.');
    }
});

// --- API Endpoints ---
app.get('/api/config', (req, res) => res.json({ isSimulatorEnabled }));
if (isSimulatorEnabled) {
    console.log("✅ Simulator is ENABLED. Creating API endpoints at /api/simulator/*");
    app.get('/api/simulator/status', (req, res) => res.json({ status: simulatorInterval ? 'running' : 'stopped' }));
    app.post('/api/simulator/start', (req, res) => res.status(200).json(startSimulator(mainConnection)));
    app.post('/api/simulator/stop', (req, res) => res.status(200).json(stopSimulator()));
}



// --- WebSocket Logic ---
console.log("WebSocket server started. Waiting for connections...");
wss.on('connection', (ws) => {
    console.log('➡️ WebSocket client connected.');

    // Send initial batch of historical data for the main history view
    db.all("SELECT * FROM mqtt_events ORDER BY timestamp DESC LIMIT 200", (err, rows) => {
        if (!err && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'history-initial-data', data: rows }));
        }
    });

    // Handle messages from the client (e.g., request for specific topic history)
    ws.on('message', (message) => {
        try {
            const parsedMessage = JSON.parse(message);
            if (parsedMessage.type === 'get-topic-history' && parsedMessage.topic) {
                db.all("SELECT timestamp, payload FROM mqtt_events WHERE topic = ? ORDER BY timestamp DESC LIMIT 20", [parsedMessage.topic], (err, rows) => {
                    if (err) {
                        console.error(`❌ DuckDB Error fetching history for topic ${parsedMessage.topic}:`, err);
                    } else if (ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify({ type: 'topic-history-data', topic: parsedMessage.topic, data: rows }));
                    }
                });
            }
        } catch (e) {
            console.error("❌ Error processing WebSocket message from client:", e);
        }
    });

    broadcastDbStatus(); // Send current status immediately
});


function broadcast(message) {
    wss.clients.forEach(client => {
        if (client.readyState === client.OPEN) {
            client.send(message);
        }
    });
}

// --- Simulator Control Functions ---
function startSimulator(connection) {
    if (simulatorInterval) return;
    if (!connection) { console.error("Cannot start simulator: MQTT connection is not available."); return; }
    console.log(`Starting simulation loop. Publishing every ${SIMULATION_INTERVAL_MS / 1000}s.`);
    simulatorInterval = setInterval(() => {
        let msg = null;
        do { 
            msg = scenario[simState.step](); 
            simState.step = (simState.step + 1) % scenario.length; 
        } while (msg === null);

        // Handle both binary and JSON payloads from the scenario
        if (msg.isBinary) {
            connection.publish(msg.topic, msg.payload, { qos: 1, retain: false });
        } else {
            msg.payload.emitted_at = new Date().toISOString();
            connection.publish(msg.topic, JSON.stringify(msg.payload), { qos: 1, retain: false });
        }
    }, SIMULATION_INTERVAL_MS);
    broadcast(JSON.stringify({ type: 'simulator-status', status: 'running' }));
}
function stopSimulator() {
    if (simulatorInterval) {
        console.log("Stopping simulation loop.");
        clearInterval(simulatorInterval);
        simulatorInterval = null;
        broadcast(JSON.stringify({ type: 'simulator-status', status: 'stopped' }));
    }
}

// Fonction "Replacer" pour JSON.stringify qui convertit les objets Long en nombres
function longReplacer(key, value) {
    if (value && typeof value === 'object' && value.constructor && value.constructor.name === 'Long') {
        return value.toNumber();
    }
    // Gère le cas où la valeur est dans une métrique
    if (value && value.hasOwnProperty('value') && value.hasOwnProperty('type') && value.value && value.value.constructor && value.value.constructor.name === 'Long') {
         value.value = value.value.toNumber();
    }
    return value;
}


// --- MQTT Connection Logic ---
function connectToMqttBroker() {
    const options = { host: MQTT_BROKER_HOST, port: parseInt(MQTT_PORT), protocol: (parseInt(MQTT_PORT) === 443 || parseInt(MQTT_PORT) === 8883) ? 'mqtts' : 'mqtt', clientId: CLIENT_ID, clean: true, reconnectPeriod: 1000, servername: MQTT_BROKER_HOST, rejectUnauthorized: true };
    if (MQTT_USERNAME) options.username = MQTT_USERNAME;
    if (MQTT_PASSWORD) options.password = MQTT_PASSWORD;
    if (CERT_FILENAME && KEY_FILENAME && CA_FILENAME) {
        try {
            // [MODIFIÉ] Use the 'certsPath' variable defined at the top of the file
            options.key = fs.readFileSync(path.join(certsPath, KEY_FILENAME));
            options.cert = fs.readFileSync(path.join(certsPath, CERT_FILENAME));
            options.ca = fs.readFileSync(path.join(certsPath, CA_FILENAME));
            console.log("Using certificate-based (MTLS) authentication.");
        } catch (err) { console.error("FATAL ERROR: Could not read certificate files.", err); process.exit(1); }
    }
    if (MQTT_ALPN_PROTOCOL) options.ALPNProtocols = [MQTT_ALPN_PROTOCOL];

    mainConnection = mqtt.connect(options);
    mainConnection.on('connect', () => {
        console.log(`✅ Connected to MQTT Broker!`);
        
        const topics = MQTT_TOPIC.split(',').map(topic => topic.trim());
        
        mainConnection.subscribe(topics, { qos: 1 }, (err, granted) => {
            if (err) {
                console.error('❌ Subscription failed:', err);
            } else {
                granted.forEach(grant => {
                    console.log(`   -> Subscription to '${grant.topic}' successful (QoS ${grant.qos}).`);
                });
            }
        });
    });

    mainConnection.on('message', (topic, payload) => {
        const timestamp = new Date();
        let payloadAsString;
        let finalMessageObject;

        try {
            if (SPARKPLUG_ENABLED && topic.startsWith('spBv1.0/')) {
                const decodedPayload = spBv10Codec.decodePayload(payload);
                payloadAsString = JSON.stringify(decodedPayload, longReplacer, 2); 
            } else {
                payloadAsString = payload.toString('utf-8');
            }
            
            finalMessageObject = { 
                type: 'mqtt-message', 
                topic, 
                payload: payloadAsString, 
                timestamp: timestamp.toISOString() 
            };
            
            const messageToSend = JSON.stringify(finalMessageObject);
            broadcast(messageToSend);
            
            const stmt = db.prepare('INSERT INTO mqtt_events (timestamp, topic, payload) VALUES (?, ?, ?)');
            stmt.run(timestamp, topic, payloadAsString, (err) => {
                if (err) console.error("❌ DuckDB Insert Error:", err);
                else broadcastDbStatus();
            });
            stmt.finalize();

        } catch (err) {
            console.error(`❌ FATAL ERROR during message processing for topic ${topic}:`, err);
        }
    });

    mainConnection.on('error', (error) => console.error('❌ MQTT Client Error:', error));
    mainConnection.on('close', () => { console.log('🔌 Disconnected from MQTT Broker.'); stopSimulator(); });
}

// --- Database Monitoring & Pruning Logic ---
let isPruning = false;

function pruneOldEvents() {
    isPruning = true;
    broadcast(JSON.stringify({ type: 'pruning-status', status: 'started' }));
    console.log(`   -> Pruning ${DUCKDB_PRUNE_CHUNK_SIZE} oldest events...`);
    const query = `DELETE FROM mqtt_events WHERE rowid IN (SELECT rowid FROM mqtt_events ORDER BY timestamp ASC LIMIT ?);`;
    db.run(query, [DUCKDB_PRUNE_CHUNK_SIZE], (err) => {
        if (err) console.error("❌ Error during pruning:", err.message);
        console.log("   -> Pruning complete. Reclaiming disk space...");
        db.exec("VACUUM; CHECKPOINT;", (err) => {
            if (err) console.error("❌ Error during VACUUM/CHECKPOINT:", err.message);
            else console.log("   -> Space reclaimed.");
            isPruning = false;
            broadcast(JSON.stringify({ type: 'pruning-status', status: 'finished' }));
            broadcastDbStatus(); // Update UI with the new, smaller size
        });
    });
}

function getDbStatus(callback) {
    let totalSize = 0;
    try { totalSize += fs.statSync(dbFile).size; } catch (e) {}
    try { totalSize += fs.statSync(dbWalFile).size; } catch (e) {}
    const fileSizeInMB = totalSize / (1024 * 1024);

    db.all("SELECT COUNT(*) as count FROM mqtt_events", (err, rows) => {
        const totalMessages = (!err && rows && rows[0]) ? Number(rows[0].count) : 0;
        callback({
            type: 'db-status-update',
            totalMessages,
            dbSizeMB: fileSizeInMB,
            dbLimitMB: DUCKDB_MAX_SIZE_MB || 0
        });
    });
}

function broadcastDbStatus() {
    getDbStatus((statusData) => {
        broadcast(JSON.stringify(statusData));
    });
}

function performMaintenance() {
    if (isPruning) {
        console.log("Maintenance skipped: pruning is already in progress.");
        return;
    }
    
    db.exec("CHECKPOINT;", (err) => {
        if (err) {
            console.error("❌ Error during maintenance CHECKPOINT:", err.message);
        }
        
        getDbStatus((statusData) => {
            broadcast(JSON.stringify(statusData));

            if (DUCKDB_MAX_SIZE_MB && statusData.dbSizeMB > DUCKDB_MAX_SIZE_MB) {
                console.log(`Database size (${statusData.dbSizeMB.toFixed(2)} MB) exceeds limit of ${DUCKDB_MAX_SIZE_MB} MB.`);
                pruneOldEvents();
            }
        });
    });
}

// --- MCP (Model Context Protocol) API Endpoints ---
console.log("🤖 MCP (Model Context Protocol) is ENABLED. Creating API endpoints at /api/context/*");

// Middleware de sécurité basé sur une liste blanche configurable
const ipFilterMiddleware = (req, res, next) => {
    // Si la liste est vide, on ne bloque rien pour la facilité d'utilisation hors-Docker
    if (ALLOWED_IPS.length === 0) {
        return next();
    }
    
    // Récupère l'IP du client, en tenant compte des proxies (important pour Docker)
    const clientIp = req.ip;

    if (ALLOWED_IPS.includes(clientIp)) {
        next(); // L'IP est autorisée
    } else {
        console.warn(`[SECURITY] Denied access to API from IP: ${clientIp}`);
        res.status(403).json({ error: `Access denied. Your IP (${clientIp}) is not allowed.` });
    }
};

// Use a router to group MCP routes and apply the middleware
const mcpRouter = express.Router();
mcpRouter.use(ipFilterMiddleware); // Apply middleware to all routes in this router

// Endpoint to get the overall status of the application
mcpRouter.get('/status', (req, res) => {
    getDbStatus(statusData => {
        res.json({
            mqtt_connected: mainConnection ? mainConnection.connected : false,
            simulator_status: simulatorInterval ? 'running' : 'stopped',
            database_stats: {
                total_messages: statusData.totalMessages,
                size_mb: parseFloat(statusData.dbSizeMB.toFixed(2)),
                size_limit_mb: statusData.dbLimitMB
            }
        });
    });
});

// Endpoint to get a flat list of all unique topics
mcpRouter.get('/topics', (req, res) => {
    db.all("SELECT DISTINCT topic FROM mqtt_events ORDER BY topic ASC", (err, rows) => {
        if (err) {
            return res.status(500).json({ error: "Failed to query topics from database." });
        }
        res.json(rows.map(r => r.topic));
    });
});

// Endpoint to get all topics structured as a hierarchical tree
mcpRouter.get('/tree', (req, res) => {
    db.all("SELECT DISTINCT topic FROM mqtt_events", (err, rows) => {
        if (err) {
            return res.status(500).json({ error: "Failed to query topics from database." });
        }
        const topics = rows.map(r => r.topic);
        const tree = {};
        topics.forEach(topic => {
            let currentLevel = tree;
            const parts = topic.split('/');
            parts.forEach((part, index) => {
                if (!currentLevel[part]) {
                    currentLevel[part] = {};
                }
                currentLevel = currentLevel[part];
            });
        });
        res.json(tree);
    });
});

mcpRouter.get('/topic/:topic(.*)', (req, res) => {
    const topic = req.params.topic;
    if (!topic) {
        return res.status(400).json({ error: "Topic not specified." });
    }
    db.all("SELECT * FROM mqtt_events WHERE topic = ? ORDER BY timestamp DESC LIMIT 1", [topic], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: "Database query failed." });
        }
        if (!rows || rows.length === 0) {
            return res.status(404).json({ error: `No data found for topic: ${topic}` });
        }
        res.json(rows[0]);
    });
});

mcpRouter.get('/history/:topic(.*)', (req, res) => {
    const topic = req.params.topic;
    const limit = parseInt(req.query.limit, 10) || 20;
    if (!topic) {
        return res.status(400).json({ error: "Topic not specified." });
    }
    db.all(`SELECT * FROM mqtt_events WHERE topic = ? ORDER BY timestamp DESC LIMIT ${limit}`, [topic], (err, rows) => {
        if (err) {
            console.error("History query failed:", err);
            return res.status(500).json({ error: "Database query failed." });
        }
        res.json(rows);
    });
});

// Mount the secured router on the base API path
app.use('/api/context', mcpRouter);

// [NOUVEAU] Fonction pour démarrer le serveur MCP comme processus enfant
function startMcpServer() {
    console.log('---');
    console.log("🚀 Starting MCP Server as a child process...");
    
    // Démarre 'node mcp_server.js'
    mcpProcess = spawn('node', ['mcp_server.js'], {
        // 'inherit' redirige la sortie (stdout, stderr) du processus enfant vers la console du parent
        stdio: 'inherit' 
    });

    mcpProcess.on('close', (code) => {
        console.log(`MCP Server process exited with code ${code}`);
    });

    mcpProcess.on('error', (err) => {
        console.error('❌ Failed to start MCP Server process:', err);
    });
}

const configRouter = express.Router();
configRouter.use(ipFilterMiddleware); // Sécurise l'accès à localhost

// GET: Lit et parse le fichier .env
configRouter.get('/', (req, res) => {
    try {
        const envFileContent = fs.readFileSync(envPath, { encoding: 'utf8' });
        const config = {};
        envFileContent.split('\n').forEach(line => {
            if (line && !line.startsWith('#')) {
                const firstEqual = line.indexOf('=');
                if (firstEqual !== -1) {
                    const key = line.substring(0, firstEqual);
                    const value = line.substring(firstEqual + 1);
                    config[key] = value;
                }
            }
        });
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: 'Could not read .env file.' });
    }
});

configRouter.post('/', (req, res) => {
    const newConfig = req.body;
    const tempPath = path.join(dataPath, '.env.tmp'); // Creates temp file inside the 'data' volume
    let envFileContent = "";

    try {
        // Rebuild the file content from the example, preserving comments and order
        const exampleContent = fs.readFileSync(envExamplePath, { encoding: 'utf8' });
        exampleContent.split('\n').forEach(line => {
            if (line.startsWith('#') || !line.trim()) {
                envFileContent += line + '\n';
            } else {
                const firstEqual = line.indexOf('=');
                if (firstEqual !== -1) {
                    const key = line.substring(0, firstEqual);
                    if (newConfig.hasOwnProperty(key)) {
                        envFileContent += `${key}=${newConfig[key]}\n`;
                    } else {
                        envFileContent += line + '\n';
                    }
                }
            }
        });

        // Step 1: Write to the temporary file first
        fs.writeFileSync(tempPath, envFileContent);

        // Step 2: If the write is successful, rename the temp file to .env
        fs.renameSync(tempPath, envPath);

        res.json({ message: 'Configuration saved successfully.' });
    } catch (err) {
        // [MODIFIED] Add detailed logging to the console to see the real error
        console.error("Error writing to .env file:", err);
        res.status(500).json({ error: 'Could not write to .env file. Check server logs for details.' });
    }
});

configRouter.post('/restart', (req, res) => {
    res.json({ message: 'Server is restarting...' });
    console.log("Restart requested via API. Shutting down...");
    // Arrête le processus. Docker (avec restart:always) le redémarrera.
    process.exit(0); 
});

app.use('/api/env', configRouter);

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`HTTP server started on http://localhost:${PORT}`);
    app.set('trust proxy', true);
    connectToMqttBroker();
    if (DUCKDB_MAX_SIZE_MB) {
        console.log(`Database auto-pruning enabled. Max size: ${DUCKDB_MAX_SIZE_MB} MB.`);
    }
    setInterval(performMaintenance, 15000); // Run every 15 seconds

    // [NOUVEAU] Démarrer le serveur MCP une fois que le serveur principal est prêt
    startMcpServer();
});

// --- Graceful shutdown ---
process.on('SIGINT', () => {
    console.log("\nGracefully shutting down...");
    
    // [NOUVEAU] Arrêter le processus enfant MCP s'il est en cours
    if (mcpProcess) {
        console.log("   -> Stopping MCP Server process...");
        mcpProcess.kill('SIGINT');
    }

    stopSimulator();
    wss.clients.forEach(ws => ws.terminate());

    const shutdown = () => {
        console.log("Forcing final database checkpoint...");
        db.exec("CHECKPOINT;", (err) => {
            if (err) console.error("❌ Error during final CHECKPOINT:", err.message);
            else console.log("   -> Checkpoint successful.");
            db.close((err) => {
                if (err) console.error("Error closing DuckDB:", err.message);
                else console.log("🦆 DuckDB connection closed.");
                console.log("Shutdown complete.");
                process.exit(0);
            });
        });
    };

    wss.close(() => {
        console.log("WebSocket server closed.");
        server.close(() => {
            console.log("HTTP server closed.");
            if (mainConnection && mainConnection.connected) {
                mainConnection.end(true, () => {
                    console.log("MQTT connection closed.");
                    shutdown();
                });
            } else {
                shutdown();
            }
        });
    });
});