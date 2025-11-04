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
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');

function connectToMqttBroker(config, logger, certsPath, onConnectCallback) {
    const options = {
        host: config.MQTT_BROKER_HOST,
        port: parseInt(config.MQTT_PORT),
        protocol: (parseInt(config.MQTT_PORT) === 443 || parseInt(config.MQTT_PORT) === 8883) ? 'mqtts' : 'mqtt',
        clientId: config.CLIENT_ID,
        clean: true,
        reconnectPeriod: 1000,
        servername: config.MQTT_BROKER_HOST,
        rejectUnauthorized: config.MQTT_REJECT_UNAUTHORIZED // Use config value
    };

    if (!config.MQTT_REJECT_UNAUTHORIZED) {
        logger.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        logger.warn("SECURITY WARNING: MQTT_REJECT_UNAUTHORIZED is false.");
        logger.warn("Certificate verification is DISABLED. This is insecure.");
        logger.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    }

    if (config.MQTT_USERNAME) options.username = config.MQTT_USERNAME;
    if (config.MQTT_PASSWORD) options.password = config.MQTT_PASSWORD;

    // --- [MODIFIED] Certificate Logic ---
    
    // Case 1: MTLS (Client Cert + Key + CA) - e.g., AWS IoT
    if (config.CERT_FILENAME && config.KEY_FILENAME && config.CA_FILENAME) {
        try {
            options.key = fs.readFileSync(path.join(certsPath, config.KEY_FILENAME));
            options.cert = fs.readFileSync(path.join(certsPath, config.CERT_FILENAME));
            options.ca = fs.readFileSync(path.join(certsPath, config.CA_FILENAME));
            logger.info("✅ Using certificate-based (MTLS) authentication.");
        } catch (err) {
            logger.error({ err }, "FATAL ERROR: Could not read MTLS certificate files (key, cert, or ca).");
            process.exit(1);
        }
    } 
    // Case 2: Standard TLS (Server verification only) - e.g., demo.flashmq.org
    else if (config.CA_FILENAME) {
         try {
            options.ca = fs.readFileSync(path.join(certsPath, config.CA_FILENAME));
            logger.info("✅ Using standard TLS authentication (verifying server with provided CA).");
        } catch (err) {
            logger.error({ err }, "FATAL ERROR: Could not read CA certificate file.");
            process.exit(1);
        }
    }
    // Case 3: No certs provided (using system CAs or rejectUnauthorized:false)
    else if (config.CERT_FILENAME || config.KEY_FILENAME) {
        logger.warn("Incomplete certificate configuration. Both CERT_FILENAME and KEY_FILENAME (and often CA_FILENAME) are required for MTLS. Ignoring partial certs.");
    }
    // --- [END MODIFIED] ---


    if (config.MQTT_ALPN_PROTOCOL) options.ALPNProtocols = [config.MQTT_ALPN_PROTOCOL];

    const connection = mqtt.connect(options);

    connection.on('connect', () => {
        logger.info(`✅ Connected to MQTT Broker!`);
        const topics = config.MQTT_TOPIC.split(',').map(topic => topic.trim());
        connection.subscribe(topics, { qos: 1 }, (err, granted) => {
            if (err) {
                logger.error({ err }, '❌ Subscription failed:');
            } else {
                granted.forEach(grant => {
                    logger.info(`✅    -> Subscription to '${grant.topic}' successful (QoS ${grant.qos}).`);
                });
            }
        });
        onConnectCallback(connection);
    });

    connection.on('error', (error) => logger.error({ err: error }, '❌ MQTT Client Error:'));
}

module.exports = { connectToMqttBroker };