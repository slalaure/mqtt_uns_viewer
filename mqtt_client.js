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
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');

/**
 * Connects to a single MQTT broker based on a broker config object.
 * @param {object} brokerConfig - The broker configuration object from the JSON array.
 * @param {pino.Logger} logger - The main pino logger.
 * @param {string} certsPath - The path to the /data/certs directory.
 * @param {function} onConnectCallback - Callback executed on successful connection. (brokerId, connection) => {}
 */
function connectToMqttBroker(brokerConfig, logger, certsPath, onConnectCallback) {
    const {
        id,
        host,
        port,
        protocol,
        clientId,
        username,
        password,
        // [MODIFIED] Use new subscription topics array, fallback to old 'topics'
        subscribe,
        topics, 
        certFilename,
        keyFilename,
        caFilename,
        alpnProtocol,
        rejectUnauthorized = true // Default to true
    } = brokerConfig;

    const options = {
        host: host,
        port: parseInt(port),
        protocol: protocol || 'mqtt',
        clientId: clientId,
        clean: true,
        reconnectPeriod: 1000,
        servername: host,
        rejectUnauthorized: rejectUnauthorized
    };
    
    const brokerLogger = logger.child({ component: 'MQTTClient', broker: id });

    if (!rejectUnauthorized) {
        brokerLogger.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        brokerLogger.warn("SECURITY WARNING: rejectUnauthorized is false.");
        brokerLogger.warn("Certificate verification is DISABLED. This is insecure.");
        brokerLogger.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    }

    if (username) options.username = username;
    if (password) options.password = password;

    // --- Certificate Logic ---
    
    // Case 1: MTLS (Client Cert + Key + CA) - e.g., AWS IoT
    if (certFilename && keyFilename && caFilename) {
        try {
            options.key = fs.readFileSync(path.join(certsPath, keyFilename));
            options.cert = fs.readFileSync(path.join(certsPath, certFilename));
            options.ca = fs.readFileSync(path.join(certsPath, caFilename));
            brokerLogger.info("✅ Using certificate-based (MTLS) authentication.");
        } catch (err) {
            brokerLogger.error({ err }, "FATAL ERROR: Could not read MTLS certificate files (key, cert, or ca).");
            process.exit(1);
        }
    } 
    // Case 2: Standard TLS (Server verification only) - e.g., demo.flashmq.org
    else if (caFilename) {
         try {
            options.ca = fs.readFileSync(path.join(certsPath, caFilename));
            brokerLogger.info("✅ Using standard TLS authentication (verifying server with provided CA).");
        } catch (err) {
            brokerLogger.error({ err }, "FATAL ERROR: Could not read CA certificate file.");
            process.exit(1);
        }
    }
    // Case 3: No certs provided (using system CAs or rejectUnauthorized:false)
    else if (certFilename || keyFilename) {
        brokerLogger.warn("Incomplete certificate configuration. Both certFilename and keyFilename (and often caFilename) are required for MTLS. Ignoring partial certs.");
    }
    // --- [END] ---


    if (alpnProtocol) options.ALPNProtocols = [alpnProtocol];

    brokerLogger.info(`Connecting to broker '${id}' at ${protocol}://${host}:${port}...`);
    const connection = mqtt.connect(options);

    connection.on('connect', () => {
        brokerLogger.info(`✅ Connected to MQTT Broker '${id}'!`);
        
        // [MODIFIED] Prioritize specific 'subscribe' list, fallback to legacy 'topics'
        const rawTopics = (subscribe && subscribe.length > 0) ? subscribe : topics;
        const subscriptionTopics = Array.isArray(rawTopics) ? rawTopics.map(topic => topic.trim()) : [];
        
        if (subscriptionTopics.length === 0) {
            brokerLogger.warn("No subscription topics specified for this broker. No data will be received.");
            return;
        }

        connection.subscribe(subscriptionTopics, { qos: 1 }, (err, granted) => {
            if (err) {
                brokerLogger.error({ err }, '❌ Subscription failed:');
            } else {
                granted.forEach(grant => {
                    brokerLogger.info(`✅    -> Subscription to '${grant.topic}' successful (QoS ${grant.qos}).`);
                });
            }
        });
        
        //  Pass broker 'id' and 'connection' to the callback
        onConnectCallback(id, connection);
    });

    connection.on('error', (error) => brokerLogger.error({ err: error }, '❌ MQTT Client Error:'));
}

module.exports = { connectToMqttBroker };