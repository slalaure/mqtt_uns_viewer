/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * REST API Poller Provider Plugin
 * Implements the BaseProvider interface for polling HTTP GET endpoints.
 */
const BaseProvider = require('../baseProvider');
const axios = require('axios');

class RestPollerProvider extends BaseProvider {
    /**
     * @param {import('../baseProvider').ProviderConfig} config 
     * @param {import('../baseProvider').ProviderContext} context 
     */
    constructor(config, context) {
        super(config, context);
        this.options = config.options || {};
        this.endpoint = this.options.endpoint;
        this.interval = this.options.interval || 60000;
        this.topic = this.options.topic || `rest/${this.id}`;
        
        // Auth options: { type: 'basic', username: '', password: '' } 
        // or { type: 'bearer', token: '' } or { type: 'apikey', headerName: '', apiKey: '' }
        this.auth = this.options.auth || {};
        this.customHeaders = this.options.headers || {};
        
        this.timer = null;
        this.isPolling = false;
    }

    async connect() {
        this.logger.info(`Starting REST Poller for ${this.id} on ${this.endpoint}`);
        if (!this.endpoint) {
            this.updateStatus('error', 'Missing endpoint URL');
            return false;
        }
        this.connected = true;
        this.updateStatus('connected');
        this.startPolling();
        return true;
    }

    startPolling() {
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => this.poll(), this.interval);
        setImmediate(() => this.poll());
    }

    async poll() {
        if (this.isPolling || !this.connected) return;
        this.isPolling = true;

        try {
            const requestConfig = {
                headers: { ...this.customHeaders },
                timeout: 10000
            };

            if (this.auth.type === 'basic') {
                requestConfig.auth = {
                    username: this.auth.username,
                    password: this.auth.password
                };
            } else if (this.auth.type === 'bearer') {
                requestConfig.headers['Authorization'] = `Bearer ${this.auth.token}`;
            } else if (this.auth.type === 'apikey') {
                const headerName = this.auth.headerName || 'x-api-key';
                requestConfig.headers[headerName] = this.auth.apiKey;
            }

            const response = await axios.get(this.endpoint, requestConfig);
            
            // Forward JSON payload or raw text
            this.handleIncomingMessage(this.topic, response.data);
            
        } catch (err) {
            this.logger.error({ err: err.message }, `Error polling REST API for ${this.id}`);
        } finally {
            this.isPolling = false;
        }
    }

    async disconnect() {
        if (this.timer) clearInterval(this.timer);
        this.connected = false;
        this.updateStatus('disconnected');
    }

    publish(topic, payload, options, callback) {
        const err = new Error("REST Poller Provider does not support outbound publishing via MQTT-like publish. Use I3X or Webhooks.");
        this.logger.warn(err.message);
        if (callback) callback(err);
    }
}

module.exports = RestPollerProvider;
