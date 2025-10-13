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

require('dotenv').config();

// --- Imports ---
const express = require('express');
const http_server = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const mqtt = require('mqtt');
const duckdb = require('duckdb');

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
const MQTT_ALPN_PROTOCOL = process.env.MQTT_ALPN_PROTOCOL ? process.env.MQTT_ALPN_PROTOCOL.trim() : null;
const PORT = process.env.PORT || 8080;
const DUCKDB_MAX_SIZE_MB = process.env.DUCKDB_MAX_SIZE_MB ? parseInt(process.env.DUCKDB_MAX_SIZE_MB, 10) : null;
const DUCKDB_PRUNE_CHUNK_SIZE = process.env.DUCKDB_PRUNE_CHUNK_SIZE ? parseInt(process.env.DUCKDB_PRUNE_CHUNK_SIZE, 10) : 500;

// --- Validate Configuration ---
if (!MQTT_BROKER_HOST || !CLIENT_ID || !MQTT_TOPIC ) {
    console.error("FATAL ERROR: One or more required environment variables are not set. Please check your .env file.");
    process.exit(1);
}

// --- Certificate Paths ---
const CERT_PATH = path.join(__dirname, 'certs/', CERT_FILENAME);
const KEY_PATH = path.join(__dirname, 'certs/', KEY_FILENAME);
const CA_PATH = path.join(__dirname, 'certs/', CA_FILENAME);

// --- DuckDB Setup ---
const dbFile = path.join(__dirname, 'mqtt_events.duckdb');
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
const SIMULATION_INTERVAL_MS = 3000;
const randomBetween = (min, max, decimals = 2) => parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
let simState = { step: 0, workOrders: { palladiumCore: null, vibraniumCasing: null }, operators: ["Pepper Potts", "Happy Hogan", "James Rhodes", "J.A.R.V.I.S.", "Peter Parker"] };
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

// --- Web Server Setup ---
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http_server.createServer(app);
const wss = new WebSocketServer({ server });

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

    db.all("SELECT * FROM mqtt_events ORDER BY timestamp DESC LIMIT 200", (err, rows) => {
        if (!err && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'history-initial-data', data: rows }));
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
        do { msg = scenario[simState.step](); simState.step = (simState.step + 1) % scenario.length; } while (msg === null);
        msg.payload.emitted_at = new Date().toISOString();
        connection.publish(msg.topic, JSON.stringify(msg.payload), { qos: 1, retain: false });
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

// --- MQTT Connection Logic ---
function connectToMqttBroker() {
    const options = { host: MQTT_BROKER_HOST, port: parseInt(MQTT_PORT), protocol: (parseInt(MQTT_PORT) === 443 || parseInt(MQTT_PORT) === 8883) ? 'mqtts' : 'mqtt', clientId: CLIENT_ID, clean: true, reconnectPeriod: 1000, servername: MQTT_BROKER_HOST, rejectUnauthorized: true };
    if (MQTT_USERNAME) options.username = MQTT_USERNAME;
    if (MQTT_PASSWORD) options.password = MQTT_PASSWORD;
    if (CERT_FILENAME && KEY_FILENAME && CA_FILENAME) {
        try {
            const certsDir = path.join(__dirname, 'certs');
            options.key = fs.readFileSync(path.join(certsDir, KEY_FILENAME));
            options.cert = fs.readFileSync(path.join(certsDir, CERT_FILENAME));
            options.ca = fs.readFileSync(path.join(certsDir, CA_FILENAME));
            console.log("Using certificate-based (MTLS) authentication.");
        } catch (err) { console.error("FATAL ERROR: Could not read certificate files.", err); process.exit(1); }
    }
    if (MQTT_ALPN_PROTOCOL) options.ALPNProtocols = [MQTT_ALPN_PROTOCOL];

    mainConnection = mqtt.connect(options);
    mainConnection.on('connect', () => {
        console.log(`✅ Connected to MQTT Broker!`);
        mainConnection.subscribe(MQTT_TOPIC, { qos: 1 }, (err) => {
            if (err) console.error('❌ Subscription failed:', err);
            else console.log(`   -> Subscription to '${MQTT_TOPIC}' successful.`);
        });
    });

    mainConnection.on('message', (topic, payload) => {
        const timestamp = new Date();
        const payloadAsString = payload.toString('utf-8');
        broadcast(JSON.stringify({ type: 'mqtt-message', topic, payload: payloadAsString, timestamp: timestamp.toISOString() }));
        const stmt = db.prepare('INSERT INTO mqtt_events (timestamp, topic, payload) VALUES (?, ?, ?)');
        stmt.run(timestamp, topic, payloadAsString, (err) => {
            if (err) console.error("❌ DuckDB Insert Error:", err);
            else broadcastDbStatus(); // Real-time update
        });
        stmt.finalize();
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

// **[MODIFICATION]** A dedicated, safe function for periodic maintenance
function performMaintenance() {
    if (isPruning) {
        console.log("Maintenance skipped: pruning is already in progress.");
        return;
    }
    
    // First, merge the WAL file to get an accurate disk size
    db.exec("CHECKPOINT;", (err) => {
        if (err) {
            console.error("❌ Error during maintenance CHECKPOINT:", err.message);
        }
        
        // Then, get the updated status and check if pruning is needed
        getDbStatus((statusData) => {
            // Broadcast the latest size (this fixes the flickering)
            broadcast(JSON.stringify(statusData));

            if (DUCKDB_MAX_SIZE_MB && statusData.dbSizeMB > DUCKDB_MAX_SIZE_MB) {
                console.log(`Database size (${statusData.dbSizeMB.toFixed(2)} MB) exceeds limit of ${DUCKDB_MAX_SIZE_MB} MB.`);
                pruneOldEvents();
            }
        });
    });
}


// --- Start Server ---
server.listen(PORT, () => {
    console.log(`HTTP server started on http://localhost:${PORT}`);
    connectToMqttBroker();
    if (DUCKDB_MAX_SIZE_MB) {
        console.log(`Database auto-pruning enabled. Max size: ${DUCKDB_MAX_SIZE_MB} MB.`);
    }
    // **[MODIFICATION]** The interval now calls the safe maintenance function
    setInterval(performMaintenance, 15000); // Run every 15 seconds
});

// --- Graceful shutdown ---
process.on('SIGINT', () => {
    console.log("\nGracefully shutting down...");
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