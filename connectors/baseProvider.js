/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Base Provider Interface
 * All data providers (MQTT, OPC UA, Kafka, CSV, etc.) must extend this class
 * to ensure a standardized interaction with the Korelate core engine.
 */

/**
 * @typedef {Object} ProviderContext
 * @property {Object} logger Logger instance.
 * @property {Function} handleMessage Central message handler function.
 * @property {Function} [updateBrokerStatus] Callback to update status in UI.
 * @property {Object} [dataManager] Data manager instance.
 */

/**
 * @typedef {Object} ProviderConfig
 * @property {string} [id] Unique identifier for the provider.
 * @property {string} [type] Type of the provider (e.g., 'mqtt', 'opcua').
 * @property {string[]} [publish] Allowed publish patterns.
 * @property {Object} [options] Provider-specific configuration options.
 */

class BaseProvider {
    /**
     * @param {ProviderConfig} config - The configuration for this specific provider instance
     * @param {ProviderContext} context - The global application context (logger, db, dataManager, etc.)
     */
    constructor(config, context) {
        /** @type {ProviderConfig} */
        this.config = config;
        /** @type {ProviderContext} */
        this.context = context;
        /** @type {string} */
        this.id = config.id || 'default_provider';
        /** @type {string} */
        this.type = config.type || 'unknown';
        /** @type {Object} */
        this.logger = context.logger.child({ component: `${this.type}-provider`, id: this.id });
        /** @type {boolean} */
        this.connected = false;
    }

    /**
     * Initialize the connection/stream. Must be implemented by child classes.
     * @returns {Promise<boolean>}
     */
    async connect() {
        throw new Error("connect() must be implemented by the provider plugin");
    }

    /**
     * Gracefully close the connection/stream. Must be implemented by child classes.
     * @returns {Promise<void>}
     */
    async disconnect() {
        throw new Error("disconnect() must be implemented by the provider plugin");
    }

    /**
     * Publish or write data back to the source. Must be implemented by child classes.
     * @param {string} topic - The destination topic/node/address
     * @param {Buffer|string} payload - The data to write
     * @param {Object} [options] - Provider-specific options (e.g., QoS for MQTT)
     * @param {Function} [callback] - Optional callback
     */
    publish(topic, payload, options = {}, callback) {
        throw new Error("publish() must be implemented by the provider plugin");
    }

    /**
     * Core method to forward incoming messages from the source to the central engine.
     * @param {string} topic - The topic, address, or identifier of the data
     * @param {Buffer|string} payload - The raw payload
     * @param {import('../core/messageDispatcher').MessageOptions} [options] - Metadata injected by the provider (e.g., correlationId)
     */
    handleIncomingMessage(topic, payload, options = {}) {
        if (this.context.handleMessage) {
            this.context.handleMessage(this.id, topic, payload, options);
        } else {
            this.logger.warn(`Message dropped: Central handler not bound for ${this.id}`);
        }
    }

    /**
     * Update the visual status of this provider in the frontend.
     * @param {string} status - 'connecting', 'connected', 'offline', 'error', 'disconnected'
     * @param {string} [error] - Error message if applicable
     */
    updateStatus(status, error = null) {
        if (this.context.updateBrokerStatus) {
            this.context.updateBrokerStatus(this.id, status, error);
        }
    }
}

module.exports = BaseProvider;