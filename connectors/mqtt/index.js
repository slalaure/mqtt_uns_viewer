/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * MQTT Provider Plugin
 * Implements the BaseProvider interface for MQTT/MQTTS connections.
 * Handles MQTT-specific payload decoding (like Sparkplug B) and MQTT v5 properties.
 */

const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const spBv10Codec = require('sparkplug-payload').get("spBv1.0"); 
const BaseProvider = require('../baseProvider');

/**
 * @typedef {Object} MqttProviderConfig
 * @extends import('../baseProvider').ProviderConfig
 * @property {string} host Broker hostname.
 * @property {number|string} port Broker port.
 * @property {string} [protocol] Connection protocol ('mqtt', 'mqtts', 'ws', 'wss').
 * @property {string} clientId MQTT client identifier.
 * @property {string} [username] Authentication username.
 * @property {string} [password] Authentication password.
 * @property {string} [certFilename] Path to client certificate.
 * @property {string} [keyFilename] Path to client private key.
 * @property {string} [caFilename] Path to CA certificate.
 * @property {string} [alpnProtocol] ALPN protocol name.
 * @property {boolean} [rejectUnauthorized] Whether to reject unauthorized certificates.
 * @property {string[]} [subscribe] List of topics to subscribe to.
 * @property {string[]} [topics] Alias for subscribe.
 * @property {number} [keepalive] Keepalive interval in seconds.
 * @property {boolean} [clean] Whether to start a clean session.
 */

class MqttProvider extends BaseProvider {
    /**
     * @param {MqttProviderConfig} config 
     * @param {import('../baseProvider').ProviderContext} context 
     */
    constructor(config, context) {
        super(config, context);
        /** @type {import('mqtt').MqttClient|null} */
        this.client = null;
    }

    /**
     * @returns {Promise<boolean>}
     */
    async connect() {
        return new Promise((resolve) => {
            const {
                host, port, protocol, clientId, username, password,
                certFilename, keyFilename, caFilename, alpnProtocol,
                rejectUnauthorized = true, subscribe, topics,
                keepalive, clean
            } = this.config;

            /** @type {import('mqtt').IClientOptions} */
            const options = {
                host, 
                port: parseInt(port, 10), 
                protocol: protocol || 'mqtt',
                clientId, 
                clean: clean !== false, // Defaults to true if undefined
                keepalive: keepalive !== undefined ? parseInt(keepalive, 10) : 60,
                reconnectPeriod: 5000, 
                connectTimeout: 10000,
                servername: host, 
                rejectUnauthorized
            };

            if (!rejectUnauthorized) this.logger.warn("SECURITY WARNING: Certificate verification is DISABLED.");
            if (username) options.username = username;
            if (password) options.password = password;

            // --- Certificate (MTLS/TLS) Logic ---
            if (certFilename && keyFilename && caFilename) {
                try {
                    options.key = fs.readFileSync(path.join(this.context.CERTS_PATH, keyFilename));
                    options.cert = fs.readFileSync(path.join(this.context.CERTS_PATH, certFilename));
                    options.ca = fs.readFileSync(path.join(this.context.CERTS_PATH, caFilename));
                    this.logger.info("✅ Configured with MTLS (Client Cert + Key + CA).");
                } catch (err) {
                    this.logger.error({ err }, "❌ ERROR: Could not read MTLS certificates.");
                    this.updateStatus('error', 'MTLS Certs missing');
                    return resolve(false);
                }
            } else if (caFilename) {
                 try {
                    options.ca = fs.readFileSync(path.join(this.context.CERTS_PATH, caFilename));
                    this.logger.info("✅ Configured with standard TLS (CA only).");
                } catch (err) {
                    this.logger.error({ err }, "❌ ERROR: Could not read CA certificate.");
                    this.updateStatus('error', 'CA Cert missing');
                    return resolve(false);
                }
            }

            if (alpnProtocol) options.ALPNProtocols = [alpnProtocol];

            this.logger.info(`Connecting to ${options.protocol}://${host}:${options.port}...`);
            this.updateStatus('connecting');

            try {
                this.client = mqtt.connect(options);
            } catch (e) {
                this.logger.error({ err: e }, "❌ Unexpected error during MQTT connect.");
                this.updateStatus('error', e.message);
                return resolve(false);
            }

            // --- MQTT Event Bindings ---
            this.client.on('connect', () => {
                this.logger.info(`✅ Connected.`);
                this.connected = true;
                this.updateStatus('connected');

                const rawTopics = (subscribe && subscribe.length > 0) ? subscribe : topics;
                const subscriptionTopics = Array.isArray(rawTopics) ? rawTopics.map(t => t.trim()) : [];

                if (subscriptionTopics.length > 0) {
                    this.client.subscribe(subscriptionTopics, { qos: 1 }, (err) => {
                        if (err) this.logger.error({ err }, `❌ Subscription failed`);
                        else this.logger.info(`✅ Subscribed to topics`);
                    });
                }
                resolve(true);
            });

            this.client.on('message', (topic, payload, packet) => {
                let isSparkplugOrigin = false;
                let processedPayload = payload;
                let decodeError = null;

                // Protocol-Specific Decoding (Sparkplug B)
                if (this.context.config.IS_SPARKPLUG_ENABLED && topic.startsWith('spBv1.0/')) {
                    try {
                        processedPayload = spBv10Codec.decodePayload(payload);
                        isSparkplugOrigin = true;
                    } catch (err) {
                        this.logger.error({ err, topic }, "❌ Error decoding Sparkplug payload");
                        decodeError = err.message;
                    }
                }

                // Extract Correlation ID from MQTT v5 properties if available
                let correlationId = null;
                if (packet && packet.properties) {
                    if (packet.properties.userProperties && packet.properties.userProperties.correlationId) {
                        correlationId = packet.properties.userProperties.correlationId;
                    } else if (packet.properties.correlationData) {
                        correlationId = packet.properties.correlationData.toString();
                    }
                }

                // Pass the processed payload and metadata to the central engine
                if (this.context.handleMessage) {
                    this.context.handleMessage(this.id, topic, processedPayload, {
                        isSparkplugOrigin,
                        rawBuffer: payload,
                        decodeError,
                        correlationId
                    });
                } else {
                    this.logger.warn(`Message dropped: Central handler not bound for ${this.id}`);
                }
            });

            this.client.on('reconnect', () => { this.logger.info(`🔄 Reconnecting...`); this.updateStatus('connecting'); });
            this.client.on('offline', () => { this.connected = false; this.updateStatus('offline'); });
            this.client.on('error', (err) => { this.logger.error(`❌ MQTT Error: ${err.message}`); this.updateStatus('error', err.message); });
            this.client.on('close', () => {
                this.connected = false;
                if (!this.context.isShuttingDown()) this.updateStatus('disconnected');
            });
        });
    }

    async disconnect() {
        if (this.client) {
            this.client.end(true);
            this.client = null;
        }
        this.connected = false;
    }

    /**
     * @param {string} topic 
     * @param {Buffer|string} payload 
     * @param {import('mqtt').IClientPublishOptions} options 
     * @param {Function} [callback] 
     */
    publish(topic, payload, options = { qos: 1, retain: false }, callback) {
        if (this.client && this.connected) {
            this.client.publish(topic, payload, options, callback);
        } else if (callback) {
            callback(new Error("Provider disconnected"));
        }
    }
}

module.exports = MqttProvider;