/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * I3X Provider Plugin
 * Implements the BaseProvider interface for I3X (RFC 001) client connections.
 * Allows retrieving data from a remote I3X server via SSE subscriptions.
 * Features Auto-Discovery and semantic auto-registration (Persistent).
 */

const axios = require('axios');
const BaseProvider = require('../baseProvider');
// Import SemanticManager directly as it is not passed in the BaseProvider context
const semanticManager = require('../../core/semantic/semanticManager');

/**
 * @typedef {Object} I3xProviderConfig
 * @extends import('../baseProvider').ProviderConfig
 * @property {string} baseUrl The remote I3X server API base URL (e.g., http://remote:8080/api/i3x).
 * @property {string} [apiKey] API Key for authentication.
 * @property {string[]} [subscribe] List of elementIds to monitor.
 * @property {number} [maxDepth] Recursion depth for registration (default 1).
 * @property {boolean} [autoDiscover] Automatically fetch and register remote objects (default true).
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
        /** @type {boolean} */
        this.autoDiscover = config.autoDiscover !== false; 
        
        /** @type {import('axios').AxiosInstance} */
        this.client = axios.create({
            baseURL: this.baseUrl,
            headers: {
                'X-API-Key': config.apiKey || '',
                'Accept': 'application/json'
            },
            timeout: 15000
        });
        
        this.reconnectTimer = null;
    }

    /**
     * @returns {Promise<boolean>}
     */
    async connect() {
        this.updateStatus('connecting');
        this.logger.info(`Connecting to remote I3X server at ${this.baseUrl}...`);

        try {
            // 1. Validate connection & capabilities
            await this.client.get('/namespaces');
            this.logger.info(`✅ Successfully reached remote I3X server.`);

            let elementsToSubscribe = this.config.subscribe || [];

            // 2. Auto-Discovery Phase (Batch processing)
            if (this.autoDiscover) {
                this.logger.info("🔍 I3X: Starting auto-discovery of remote objects...");
                try {
                    const objectsRes = await this.client.get('/objects');
                    const remoteObjects = objectsRes.data || [];
                    
                    if (remoteObjects.length > 0) {
                        this.logger.info(`✅ I3X: Discovered ${remoteObjects.length} remote objects.`);
                        
                        // Register ALL discovered objects in local SemanticManager in one batch
                        semanticManager.registerExternalElements(this.id, remoteObjects);
                        
                        // Auto-add discovered IDs to subscription list if not already present
                        const discoveredIds = remoteObjects.map(o => o.elementId);
                        elementsToSubscribe = [...new Set([...elementsToSubscribe, ...discoveredIds])];
                    }
                } catch (discoveryErr) {
                    this.logger.warn({ err: discoveryErr.message }, "I3X Discovery failed, continuing with manual subscription list (or relying on offline cache).");
                }
            }

            // 3. Create Subscription
            const subRes = await this.client.post('/subscriptions', {});
            this.subscriptionId = subRes.data.subscriptionId;
            this.logger.info(`✅ Created I3X subscription: ${this.subscriptionId}`);

            // 4. Register elements
            if (elementsToSubscribe.length > 0) {
                await this.client.post(`/subscriptions/${this.subscriptionId}/register`, {
                    elementIds: elementsToSubscribe,
                    maxDepth: this.config.maxDepth || 1
                });
                this.logger.info(`✅ Registered ${elementsToSubscribe.length} elements (Depth: ${this.config.maxDepth || 1}).`);
            }

            // 5. Start SSE Stream
            await this.startStream();

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
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            this.logger.info(`Starting I3X SSE stream for ${this.subscriptionId}`);
            
            this.streamResponse = await this.client.get(`/subscriptions/${this.subscriptionId}/stream`, {
                responseType: 'stream',
                timeout: 0 // SSE should not timeout
            });

            this.streamResponse.data.on('data', (chunk) => {
                const lines = chunk.toString().split('\n');
                lines.forEach(line => {
                    if (line.startsWith('data: ')) {
                        try {
                            const rawData = JSON.parse(line.substring(6));
                            const updates = Array.isArray(rawData) ? rawData : [rawData];
                            
                            updates.forEach(update => {
                                // Backward compatibility for legacy tests (tests/i3xProvider.test.js)
                                if (update.elementId && update.value) {
                                    this.handleIncomingMessage(update.elementId, update.value);
                                    return;
                                }

                                // RFC 001 Format: { "ElementId": { "data": [VQT] } }
                                for (const [elementId, content] of Object.entries(update)) {
                                    if (content && content.data && content.data.length > 0) {
                                        const vqt = content.data[0];
                                        // Forward enriched payload to the dispatcher
                                        const payload = {
                                            value: vqt.value,
                                            quality: vqt.quality,
                                            timestamp: vqt.timestamp,
                                            unit: vqt.engUnit || undefined
                                        };
                                        this.handleIncomingMessage(elementId, payload);
                                    }
                                }
                            });
                        } catch (e) {
                            // Ignore non-json or partial stream chunks
                        }
                    }
                });
            });

            this.streamResponse.data.on('end', () => {
                this.logger.warn(`SSE stream for ${this.id} ended.`);
                this.handleReconnect();
            });

            this.streamResponse.data.on('error', (err) => {
                this.logger.error({ err: err.message }, `SSE stream error for ${this.id}`);
                this.handleReconnect();
            });

        } catch (err) {
            this.logger.error({ err: err.message }, `Failed to start I3X SSE stream for ${this.id}`);
            this.handleReconnect();
        }
    }

    handleReconnect() {
        if (this.connected && !this.context.isShuttingDown() && !this.reconnectTimer) {
            this.logger.info(`Attempting to reconnect I3X SSE stream in 5s...`);
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                this.startStream();
            }, 5000);
        }
    }

    async disconnect() {
        this.connected = false;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        
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
            this.logger.error({ err: msg }, `Failed to publish to I3X: ${msg}`);
            if (callback) callback(new Error(msg));
        }
    }
}

module.exports = I3xProvider;