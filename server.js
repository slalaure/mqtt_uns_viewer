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
const { WebSocketServer } = require('ws');
const { iot, mqtt } = require('aws-iot-device-sdk-v2');

// --- Configuration from Environment Variables (with sanitization) ---
// We use .trim() on each variable to remove any hidden whitespace or line breaks
const AWS_ENDPOINT = process.env.AWS_ENDPOINT ? process.env.AWS_ENDPOINT.trim() : null;
const CLIENT_ID = process.env.CLIENT_ID ? process.env.CLIENT_ID.trim() : null;
const MQTT_TOPIC = process.env.MQTT_TOPIC ? process.env.MQTT_TOPIC.trim() : null;
const AWS_CERT_FILENAME = process.env.AWS_CERT_FILENAME ? process.env.AWS_CERT_FILENAME.trim() : null;
const AWS_KEY_FILENAME = process.env.AWS_KEY_FILENAME ? process.env.AWS_KEY_FILENAME.trim() : null;
const AWS_CA_FILENAME = process.env.AWS_CA_FILENAME ? process.env.AWS_CA_FILENAME.trim() : null;

const PORT = process.env.PORT || 8080;

// --- Validate Configuration ---
if (!AWS_ENDPOINT || !CLIENT_ID || !MQTT_TOPIC || !AWS_CERT_FILENAME || !AWS_KEY_FILENAME || !AWS_CA_FILENAME) {
    console.error("FATAL ERROR: One or more required environment variables are not set. Please check your .env file.");
    process.exit(1);
}

// --- Certificate Paths ---
const CERT_PATH = path.join(__dirname, 'certs/', AWS_CERT_FILENAME);
const KEY_PATH = path.join(__dirname, 'certs/', AWS_KEY_FILENAME);
const CA_PATH = path.join(__dirname, 'certs/', AWS_CA_FILENAME);

// --- Web Server and WebSocket Setup ---
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http_server.createServer(app);
const wss = new WebSocketServer({ server });

console.log("WebSocket server started. Waiting for connections...");
wss.on('connection', (ws) => console.log('WebSocket client connected.'));

function broadcast(message) {
    wss.clients.forEach(client => {
        if (client.readyState === client.OPEN) {
            client.send(message);
        }
    });
}

// --- AWS IoT MQTT Connection Logic ---
async function connectToAwsIot() {
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
}

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`HTTP server started on http://localhost:${PORT}`);
    connectToAwsIot().catch(err => {
        console.error("--- FATAL ERROR during MQTT connection startup ---");
        console.error(err);
        console.error("----------------------------------------------------");
    });
});