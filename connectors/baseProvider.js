/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Base Provider Interface
 * All data providers (MQTT, OPC UA, Kafka, CSV, etc.) must extend this class
 * to ensure a standardized interaction with the Korelate core engine.
 */

class BaseProvider {
    /**
     * @param {Object} config - The configuration for this specific provider instance
     * @param {Object} context - The global application context (logger, db, dataManager, etc.)
     */
    constructor(config, context) {
        this.config = config;
        this.context = context;
        this.id = config.id || 'default_provider';
        this.type = config.type || 'unknown';
        this.logger = context.logger.child({ component: `${this.type}-provider`, id: this.id });
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
     * @param {Object} options - Provider-specific options (e.g., QoS for MQTT)
     * @param {Function} [callback] - Optional callback
     */
    publish(topic, payload, options = {}, callback) {
        throw new Error("publish() must be implemented by the provider plugin");
    }

    /**
     * Core method to forward incoming messages from the source to the central engine.
     * @param {string} topic - The topic, address, or identifier of the data
     * @param {Buffer|string} payload - The raw payload
     */
    handleIncomingMessage(topic, payload) {
        if (this.context.handleMessage) {
            this.context.handleMessage(this.id, topic, payload);
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