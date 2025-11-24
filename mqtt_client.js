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
 * Creates and returns an MQTT client instance based on the config.
 * It does NOT wait for the connection to be established.
 * * @param {object} brokerConfig - The broker configuration object.
 * @param {pino.Logger} logger - The main pino logger.
 * @param {string} certsPath - The path to the /data/certs directory.
 * @returns {mqtt.MqttClient} The MQTT client instance.
 */
function createMqttClient(brokerConfig, logger, certsPath) {
    const {
        id,
        host,
        port,
        protocol,
        clientId,
        username,
        password,
        certFilename,
        keyFilename,
        caFilename,
        alpnProtocol,
        rejectUnauthorized = true
    } = brokerConfig;

    const options = {
        host: host,
        port: parseInt(port),
        protocol: protocol || 'mqtt',
        clientId: clientId,
        clean: true,
        reconnectPeriod: 5000, // Retry every 5 seconds automatically
        connectTimeout: 10000, // Wait 10s max for CONNACK
        servername: host,
        rejectUnauthorized: rejectUnauthorized
    };
    
    const brokerLogger = logger.child({ component: 'MQTTClient', broker: id });

    if (!rejectUnauthorized) {
        brokerLogger.warn("SECURITY WARNING: Certificate verification is DISABLED.");
    }

    if (username) options.username = username;
    if (password) options.password = password;

    // --- Certificate Logic ---
    if (certFilename && keyFilename && caFilename) {
        try {
            options.key = fs.readFileSync(path.join(certsPath, keyFilename));
            options.cert = fs.readFileSync(path.join(certsPath, certFilename));
            options.ca = fs.readFileSync(path.join(certsPath, caFilename));
            brokerLogger.info("✅ Configured with MTLS (Client Cert + Key + CA).");
        } catch (err) {
            brokerLogger.error({ err }, "FATAL ERROR: Could not read MTLS certificate files.");
            process.exit(1);
        }
    } else if (caFilename) {
         try {
            options.ca = fs.readFileSync(path.join(certsPath, caFilename));
            brokerLogger.info("✅ Configured with standard TLS (CA only).");
        } catch (err) {
            brokerLogger.error({ err }, "FATAL ERROR: Could not read CA certificate file.");
            process.exit(1);
        }
    }

    if (alpnProtocol) options.ALPNProtocols = [alpnProtocol];

    brokerLogger.info(`Initializing client for '${id}' at ${protocol}://${host}:${port}...`);
    
    // Create the client but let the caller attach event listeners
    return mqtt.connect(options);
}

module.exports = { createMqttClient };