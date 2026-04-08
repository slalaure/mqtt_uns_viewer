/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * I3X Provider Plugin
 * Implements the BaseProvider interface for I3X (RFC 001) client connections.
 * Allows retrieving data from a remote I3X server via SSE subscriptions.
 */

const axios = require('axios');
const BaseProvider = require('../baseProvider');

/**
 * @typedef {Object} I3xProviderConfig
 * @extends import('../baseProvider').ProviderConfig
 * @property {string} baseUrl The remote I3X server API base URL (e.g., http://remote:8080/api/i3x).
 * @property {string} [apiKey] API Key for authentication.
 * @property {string[]} [subscribe] List of elementIds to monitor.
 */

class I3xProvider extends BaseProvider {
    /**
     * @param {I3xProviderConfig} config 
     * @param {import('../baseProvider').ProviderContext} context 
     */
    constructor(config, context) {
        super(config, context);
        /** @type {string} */
        this.baseUrl = config.baseUrl;
        /** @type {string|null} */
        this.subscriptionId = null;
        /** @type {import('axios').AxiosResponse|null} */
        this.streamResponse = null;
        /** @type {import('axios').AxiosInstance} */
        this.client = axios.create({
            baseURL: this.baseUrl,
            headers: {
                'X-API-Key': config.apiKey || '',
                'Accept': 'application/json'
            },
            timeout: 10000
        });
    }

    /**
     * @returns {Promise<boolean>}
     */
    async connect() {
        this.updateStatus('connecting');
        this.logger.info(`Connecting to remote I3X server at ${this.baseUrl}...`);

        try {
            // 1. Validate connection
            await this.client.get('/namespaces');
            this.logger.info(`✅ Successfully reached remote I3X server.`);

            // 2. Create Subscription
            const subRes = await this.client.post('/subscriptions', {});
            this.subscriptionId = subRes.data.subscriptionId;
            this.logger.info(`✅ Created subscription: ${this.subscriptionId}`);

            // 3. Register elements
            const elementsToSubscribe = this.config.subscribe || [];
            if (elementsToSubscribe.length > 0) {
                await this.client.post(`/subscriptions/${this.subscriptionId}/register`, {
                    elementIds: elementsToSubscribe,
                    maxDepth: 1
                });
                this.logger.info(`✅ Registered ${elementsToSubscribe.length} elements.`);
            }

            // 4. Start SSE Stream
            this.startStream();

            this.connected = true;
            this.updateStatus('connected');
            return true;
        } catch (err) {
            const msg = err.response?.data?.error || err.message;
            this.logger.error({ err }, `❌ Failed to connect to I3X server: ${msg}`);
            this.updateStatus('error', msg);
            return false;
        }
    }

    async startStream() {
        if (!this.subscriptionId) return;

        try {
            this.logger.info(`Starting SSE stream for ${this.subscriptionId}`);
            
            this.streamResponse = await this.client.get(`/subscriptions/${this.subscriptionId}/stream`, {
                responseType: 'stream',
                timeout: 0 // SSE should not timeout
            });

            this.streamResponse.data.on('data', (chunk) => {
                const lines = chunk.toString().split('\n');
                lines.forEach(line => {
                    if (line.startsWith('data: ')) {
                        try {
                            const payload = JSON.parse(line.substring(6));
                            // I3X payloads usually look like: { elementId, value: { value, quality, timestamp } }
                            if (payload.elementId) {
                                // Map to UNS topic - for I3X client, topic is the elementId
                                this.handleIncomingMessage(payload.elementId, payload.value || payload);
                            }
                        } catch (e) {
                            // Ignore non-json or partial lines
                        }
                    }
                });
            });

            this.streamResponse.data.on('end', () => {
                this.logger.warn(`SSE stream for ${this.id} ended.`);
                if (this.connected && !this.context.isShuttingDown()) {
                    this.logger.info(`Attempting to reconnect SSE stream...`);
                    setTimeout(() => this.startStream(), 5000);
                }
            });

            this.streamResponse.data.on('error', (err) => {
                this.logger.error({ err }, `SSE stream error for ${this.id}`);
            });

        } catch (err) {
            this.logger.error({ err }, `Failed to start SSE stream for ${this.id}`);
        }
    }

    async disconnect() {
        this.connected = false;
        if (this.subscriptionId) {
            try {
                // Try to delete subscription on remote
                await this.client.delete(`/subscriptions/${this.subscriptionId}`);
                this.logger.info(`Deleted remote subscription ${this.subscriptionId}`);
            } catch (e) {
                this.logger.warn(`Failed to delete remote subscription: ${e.message}`);
            }
        }
        
        if (this.streamResponse && this.streamResponse.data) {
            this.streamResponse.data.destroy();
        }

        this.subscriptionId = null;
        this.updateStatus('disconnected');
    }

    /**
     * @param {string} topic - The elementId in I3X context
     * @param {Buffer|string} payload 
     * @param {Object} options 
     * @param {Function} [callback] 
     */
    async publish(topic, payload, options, callback) {
        if (!this.connected) {
            const err = new Error("I3X Provider disconnected");
            if (callback) callback(err);
            return;
        }

        try {
            let valueToPut = payload;
            // If payload is a string, try to parse it
            if (typeof payload === 'string') {
                try { valueToPut = JSON.parse(payload); } catch(e) {}
            }

            // I3X Standard: PUT /objects/:elementId/value
            await this.client.put(`/objects/${topic}/value`, valueToPut);
            if (callback) callback(null);
        } catch (err) {
            const msg = err.response?.data?.error || err.message;
            this.logger.error({ err }, `Failed to publish to I3X: ${msg}`);
            if (callback) callback(err);
        }
    }
}

module.exports = I3xProvider;