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
const fs = require('fs'); // Added for reading certificate files
const { WebSocketServer } = require('ws');
const mqtt = require('mqtt'); // Replaced AWS SDK with the standard MQTT library


// --- Configuration from Environment Variables (with sanitization) ---
// We use .trim() on each variable to remove any hidden whitespace or line breaks
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

// --- Validate Configuration ---
if (!MQTT_BROKER_HOST || !CLIENT_ID || !MQTT_TOPIC ) {
    console.error("FATAL ERROR: One or more required environment variables are not set. Please check your .env file.");
    process.exit(1);
}

// --- Certificate Paths ---
const CERT_PATH = path.join(__dirname, 'certs/', CERT_FILENAME);
const KEY_PATH = path.join(__dirname, 'certs/', KEY_FILENAME);
const CA_PATH = path.join(__dirname, 'certs/', CA_FILENAME);

// --- Simulator State & Logic (Integrated) ---
let simulatorInterval = null; // Will hold the setInterval ID
const SIMULATION_INTERVAL_MS = 3000;

const randomBetween = (min, max, decimals = 2) => {
    const str = (Math.random() * (max - min) + min).toFixed(decimals);
    return parseFloat(str);
};

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

// Endpoint for the frontend to get public configuration
app.get('/api/config', (req, res) => {
    res.json({
        isSimulatorEnabled: isSimulatorEnabled
    });
});

// Create simulator control endpoints ONLY if the feature is enabled
if (isSimulatorEnabled) {
    console.log("✅ Simulator is ENABLED. Creating API endpoints at /api/simulator/*");

    // GET the current status of the simulator
    app.get('/api/simulator/status', (req, res) => {
        const status = simulatorInterval ? 'running' : 'stopped';
        res.status(200).json({ status });
    });

    // POST to start the simulator
    app.post('/api/simulator/start', (req, res) => {
        const result = startSimulator(mainConnection);
        res.status(200).json(result);
    });

    // POST to stop the simulator
    app.post('/api/simulator/stop', (req, res) => {
        const result = stopSimulator();
        res.status(200).json(result);
    });
}
// --- Web Server and WebSocket Setup ---

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

        const options = {
            qos: 1, // AtLeastOnce is QoS level 1
            retain: false
        };

        connection.publish(msg.topic, payloadStr, options, (error) => {
            if (error) {
                console.error('Error publishing simulation message:', error);
            }
        });

    }, SIMULATION_INTERVAL_MS);

    // Notify UI that simulator has started
    broadcast(JSON.stringify({ type: 'simulator-status', status: 'running' }));
}

function stopSimulator() {
    if (simulatorInterval) {
        console.log("Stopping simulation loop.");
        clearInterval(simulatorInterval);
        simulatorInterval = null;
        // Notify UI that simulator has stopped
        broadcast(JSON.stringify({ type: 'simulator-status', status: 'stopped' }));
    }
}

// --- MQTT Connection Logic (Final Version) ---
function connectToMqttBroker() {
    const host = MQTT_BROKER_HOST ? MQTT_BROKER_HOST.trim() : null;
    const port = MQTT_PORT ? parseInt(MQTT_PORT.trim()) : null;
    const protocol = (port === 443 || port === 8883) ? 'mqtts' : 'mqtt';

    console.log(`Attempting to connect to MQTT broker at ${protocol}://${host}:${port}...`);

    const options = {
        host,
        port,
        protocol,
        clientId: CLIENT_ID,
        clean: true,
        reconnectPeriod: 1000,
        // --- Explicit TLS options for robust connection ---
        // Option 1: SNI - Critical for multi-tenant services like AWS
        servername: host,
        // Option 2: Ensure we reject connections to unauthorized servers
        rejectUnauthorized: true,
    };

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
            if (err) {
                console.error('❌ Subscription failed:', err);
            } else {
                console.log(`   -> Subscription to '${MQTT_TOPIC}' successful. Waiting for messages...`);
            }
        });
    });
    mainConnection.on('message', (topic, payload) => {
        const payloadAsString = payload.toString('utf-8');
        const message = {
            topic,
            payload: payloadAsString,
            timestamp: new Date().toISOString()
        };
        broadcast(JSON.stringify(message));
    });

    mainConnection.on('error', (error) => console.error('❌ MQTT Client Error:', error));
    mainConnection.on('close', () => {
        console.log('🔌 Disconnected from MQTT Broker.');
        stopSimulator();
    });
}
// --- AWS IoT MQTT Connection Logic ---
/*async function connectToAwsIot() {
    console.log("Attempting to connect to AWS IoT Core...");

    const config = iot.AwsIotMqttConnectionConfigBuilder.new_mtls_builder_from_path(CERT_PATH, KEY_PATH)
        .with_certificate_authority_from_path(undefined, CA_PATH)
        .with_clean_session(true)
        .with_client_id(CLIENT_ID)
        .with_endpoint(AWS_ENDPOINT)
        .with_port(443)
        .build();

    const client = new mqtt.MqttClient();
    const connection = client.new_connection(config);

    // Assign the created connection to the globally accessible variable.
    mainConnection = connection;

    connection.on('connect', (session_present) => {
        console.log(`✅ Connected to AWS IoT Core! Session present: ${session_present}`);
        console.log(`Subscribing to topic: '${MQTT_TOPIC}'`);
        
        
        connection.subscribe(MQTT_TOPIC, mqtt.QoS.AtLeastOnce, (topic, payload) => {
            const payloadAsString = Buffer.from(payload).toString('utf-8');
            const message = {
                topic: topic,
                payload: payloadAsString,
                timestamp: new Date().toISOString()
            };
            console.log(`Message sent to frontend client(s): Topic=${topic}`);
            broadcast(JSON.stringify(message));
        });
        console.log("   -> Subscription request sent. Waiting for messages...");
    });

    connection.on('error', (error) => console.error('❌ Connection error:', error));
    connection.on('disconnect', () => console.log('🔌 Disconnected from AWS IoT Core.'));

    await connection.connect();
}*/

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`HTTP server started on http://localhost:${PORT}`);
    /*connectToAwsIot().catch(err => {
        console.error("--- FATAL ERROR during MQTT connection startup ---");
        console.error(err);
        console.error("----------------------------------------------------");
    });*/
    connectToMqttBroker();
});
