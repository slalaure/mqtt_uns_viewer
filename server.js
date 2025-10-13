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

// --- Simulator State & Logic (Integrated) ---
let simulatorInterval = null;
const SIMULATION_INTERVAL_MS = 3000;
const randomBetween = (min, max, decimals = 2) => parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
let simState = {
    step: 0,
    workOrders: { palladiumCore: null, vibraniumCasing: null },
    operators: ["Pepper Potts", "Happy Hogan", "James Rhodes", "J.A.R.V.I.S.", "Peter Parker"],
};
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
app.get('/api/config', (req, res) => {
    res.json({ isSimulatorEnabled: isSimulatorEnabled });
});
if (isSimulatorEnabled) {
    console.log("✅ Simulator is ENABLED. Creating API endpoints at /api/simulator/*");
    app.get('/api/simulator/status', (req, res) => {
        const status = simulatorInterval ? 'running' : 'stopped';
        res.status(200).json({ status });
    });
    app.post('/api/simulator/start', (req, res) => {
        const result = startSimulator(mainConnection);
        res.status(200).json(result);
    });
    app.post('/api/simulator/stop', (req, res) => {
        const result = stopSimulator();
        res.status(200).json(result);
    });
}

console.log("WebSocket server started. Waiting for connections...");
wss.on('connection', (ws) => console.log('WebSocket client connected.'));

function broadcast(message) {
    wss.clients.forEach(client => {
        if (client.readyState === client.OPEN) {
            client.send(message);
        }
    });
}

// --- Simulator Control Functions ---
function startSimulator(connection) {
    if (simulatorInterval) {
        console.log("Simulator is already running.");
        return;
    }
    if (!connection) {
        console.error("Cannot start simulator: MQTT connection is not available.");
        return;
    }
    console.log(`Starting simulation loop. Publishing every ${SIMULATION_INTERVAL_MS / 1000}s.`);
    simulatorInterval = setInterval(() => {
        let msg = null;
        do {
            const messageGenerator = scenario[simState.step];
            msg = messageGenerator();
            simState.step = (simState.step + 1) % scenario.length;
        } while (msg === null);
        msg.payload.emitted_at = new Date().toISOString();
        const payloadStr = JSON.stringify(msg.payload);
        const options = { qos: 1, retain: false };
        connection.publish(msg.topic, payloadStr, options, (error) => {
            if (error) console.error('Error publishing simulation message:', error);
        });
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
    const host = MQTT_BROKER_HOST ? MQTT_BROKER_HOST.trim() : null;
    const port = MQTT_PORT ? parseInt(MQTT_PORT.trim()) : null;
    const protocol = (port === 443 || port === 8883) ? 'mqtts' : 'mqtt';
    console.log(`Attempting to connect to MQTT broker at ${protocol}://${host}:${port}...`);
    const options = { host, port, protocol, clientId: CLIENT_ID, clean: true, reconnectPeriod: 1000, servername: host, rejectUnauthorized: true };
    if (MQTT_USERNAME && MQTT_USERNAME.trim()) {
        options.username = MQTT_USERNAME.trim();
        options.password = MQTT_PASSWORD.trim();
        console.log("Using Username/Password authentication.");
    }
    if (CERT_FILENAME && KEY_FILENAME && CA_FILENAME) {
        try {
            const certsDir = path.join(__dirname, 'certs');
            options.key = fs.readFileSync(path.join(certsDir, KEY_FILENAME.trim()));
            options.cert = fs.readFileSync(path.join(certsDir, CERT_FILENAME.trim()));
            options.ca = fs.readFileSync(path.join(certsDir, CA_FILENAME.trim()));
            console.log("Using certificate-based (MTLS) authentication.");
        } catch (err) {
            console.error("FATAL ERROR: Could not read certificate files.", err);
            process.exit(1);
        }
    }
    if (MQTT_ALPN_PROTOCOL && MQTT_ALPN_PROTOCOL.trim() !== '') {
        options.ALPNProtocols = [MQTT_ALPN_PROTOCOL.trim()];
        console.log(`Using ALPN protocol(s): ${options.ALPNProtocols}`);
    }
    mainConnection = mqtt.connect(options);
    mainConnection.on('connect', () => {
        console.log(`✅ Connected to MQTT Broker!`);
        mainConnection.subscribe(MQTT_TOPIC, { qos: 1 }, (err) => {
            if (err) console.error('❌ Subscription failed:', err);
            else console.log(`   -> Subscription to '${MQTT_TOPIC}' successful. Waiting for messages...`);
        });
    });

    mainConnection.on('message', (topic, payload) => {
        const timestamp = new Date();
        const payloadAsString = payload.toString('utf-8');
        const messageForUI = {
            topic,
            payload: payloadAsString,
            timestamp: timestamp.toISOString()
        };
        broadcast(JSON.stringify(messageForUI));
        try {
            const stmt = db.prepare('INSERT INTO mqtt_events (timestamp, topic, payload) VALUES (?, ?, ?)');
            stmt.run(timestamp, topic, payloadAsString, (err) => {
                if (err) console.error("❌ DuckDB Insert Error:", err);
            });
            stmt.finalize();
        } catch(e) {
            console.warn(`Could not parse payload for topic '${topic}' as JSON. Storing as NULL.`);
            const stmt = db.prepare('INSERT INTO mqtt_events (timestamp, topic, payload) VALUES (?, ?, NULL)');
            stmt.run(timestamp, topic, (err) => {
                 if (err) console.error("❌ DuckDB Insert Error (with NULL payload):", err);
            });
            stmt.finalize();
        }
    });

    mainConnection.on('error', (error) => console.error('❌ MQTT Client Error:', error));
    mainConnection.on('close', () => {
        console.log('🔌 Disconnected from MQTT Broker.');
        stopSimulator();
    });
}

// --- Database Pruning Logic ---
let pruningInterval = null;
let isPruning = false;

function pruneOldEvents() {
    isPruning = true;
    const PRUNE_PERCENTAGE = 0.20; // Delete 20% of the oldest data
    db.get("SELECT COUNT(*) as count FROM mqtt_events", (err, row) => {
        if (err || !row) {
            console.error("❌ Could not get event count for pruning:", err);
            isPruning = false;
            return;
        }
        
        const rowsToDelete = Math.floor(row.count * PRUNE_PERCENTAGE);
        if (rowsToDelete <= 1) {
            isPruning = false;
            return; // Nothing to prune
        }

        console.log(`   -> Pruning ${rowsToDelete} oldest events from the database...`);
        const query = `DELETE FROM mqtt_events WHERE rowid IN (SELECT rowid FROM mqtt_events ORDER BY timestamp ASC LIMIT ?);`;
        db.run(query, [rowsToDelete], (err) => {
            if (err) {
                console.error("❌ Error during database pruning:", err.message);
                isPruning = false;
                return;
            }
            console.log("   -> Pruning complete. Reclaiming disk space with VACUUM...");
            db.run("VACUUM;", (err) => {
                if (err) {
                    console.error("❌ Error during VACUUM:", err.message);
                } else {
                    console.log("   -> VACUUM complete.");
                }
                isPruning = false; // Release the lock
            });
        });
    });
}

function checkAndPruneDatabase() {
    if (isPruning) {
        console.log("   -> Pruning already in progress, skipping check.");
        return;
    }
    try {
        const stats = fs.statSync(dbFile);
        const fileSizeInMB = stats.size / (1024 * 1024);

        if (fileSizeInMB > DUCKDB_MAX_SIZE_MB) {
            console.log(`Database size (${fileSizeInMB.toFixed(2)} MB) exceeds limit of ${DUCKDB_MAX_SIZE_MB} MB.`);
            pruneOldEvents();
        }
    } catch (err) {
        // This can happen if the file doesn't exist yet, which is fine.
        if (err.code !== 'ENOENT') {
            console.error("❌ Could not check database file size:", err.message);
        }
    }
}

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`HTTP server started on http://localhost:${PORT}`);
    connectToMqttBroker();

    if (DUCKDB_MAX_SIZE_MB && DUCKDB_MAX_SIZE_MB > 0) {
        const checkInterval = 5 * 60 * 1000; // 5 minutes
        console.log(`Database auto-pruning enabled. Max size: ${DUCKDB_MAX_SIZE_MB} MB. Checking every ${checkInterval / 60000} minutes.`);
        pruningInterval = setInterval(checkAndPruneDatabase, checkInterval);
    }
});

// --- Graceful shutdown (ROBUST VERSION) ---
process.on('SIGINT', () => {
    console.log("\nGracefully shutting down...");

    // 1. Stop all intervals
    stopSimulator();
    if(pruningInterval) clearInterval(pruningInterval);

    // 2. Close all WebSocket connections
    console.log(`Terminating ${wss.clients.size} WebSocket clients...`);
    wss.clients.forEach(ws => {
        ws.terminate();
    });

    // 3. Close the WebSocket server
    wss.close(() => {
        console.log("WebSocket server closed.");

        // 4. Close the HTTP server
        server.close(() => {
            console.log("HTTP server closed.");

            // 5. Close the MQTT connection
            if (mainConnection) {
                mainConnection.end(true, () => {
                    console.log("MQTT connection closed.");

                    // 6. Close the DuckDB connection
                    db.close((err) => {
                        if (err) {
                            console.error("Error closing DuckDB:", err.message);
                        } else {
                            console.log("🦆 DuckDB connection closed.");
                        }
                        console.log("Shutdown complete.");
                        process.exit(0);
                    });
                });
            } else {
                // If no MQTT connection, just close the DB
                db.close((err) => {
                    if (err) {
                        console.error("Error closing DuckDB:", err.message);
                    } else {
                        console.log("🦆 DuckDB connection closed.");
                    }
                    console.log("Shutdown complete.");
                    process.exit(0);
                });
            }
        });
    });
});