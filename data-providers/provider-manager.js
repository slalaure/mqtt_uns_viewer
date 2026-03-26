/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Provider Manager
 * Abstraction layer to manage different data providers dynamically.
 */
const fs = require('fs');
const path = require('path');

const messageHandler = require('../message-handler');

class ProviderManager {
    constructor() {
        this.providers = new Map();
        this.context = null;
        this.logger = null;
    }

    /**
     * Initializes the Provider Manager and loads configured data providers.
     * @param {Object} context - Global application context
     */
    init(context) {
        this.context = context;
        this.logger = context.logger.child({ component: 'ProviderManager' });
        this.logger.info("Initializing Data Providers Abstraction Layer...");

        // Initialize the central message handler
        this.context.handleMessage = messageHandler.init(
            context.logger,
            context.config,
            context.wsManager,
            context.mapperEngine,
            context.dataManager,
            context.broadcastDbStatus,
            context.alertManager
        );

        // 1. Backward compatibility: Load Legacy MQTT Brokers from .env configuration
        if (this.context.config.BROKER_CONFIGS && this.context.config.BROKER_CONFIGS.length > 0) {
            this.context.config.BROKER_CONFIGS.forEach(brokerConfig => {
                const providerConfig = { type: 'mqtt', ...brokerConfig };
                this.loadProvider(providerConfig);
            });
        }

        // 2. Future implementation: Load other providers if configured in config
        if (this.context.config.DATA_PROVIDERS) {
            this.context.config.DATA_PROVIDERS.forEach(providerConfig => {
                this.loadProvider(providerConfig);
            });
        }
    }

    /**
     * Routes the configuration to the appropriate provider plugin.
     * @param {Object} providerConfig - Configuration object for the specific provider
     */
    loadProvider(providerConfig) {
        const type = providerConfig.type || 'unknown';
        const providerId = providerConfig.id;

        this.logger.info(`Loading data provider plugin [${type}] for ID: ${providerId}`);

        let ProviderClass;
        try {
            // Dynamically load the plugin from its specific folder
            ProviderClass = require(`./${type}/index.js`);
        } catch (err) {
            this.logger.warn(`Unsupported or missing provider plugin: ${type}. Expected at data-providers/${type}/index.js`);
            return;
        }

        try {
            const providerInstance = new ProviderClass(providerConfig, this.context);
            
            // Expose a standard connection object to activeConnections for backward compatibility 
            // This ensures external APIs (Publish API, Simulators, Mapper) still work flawlessly
            this.context.activeConnections.set(providerId, {
                get connected() { return providerInstance.connected; },
                publish: (topic, payload, options, callback) => {
                    providerInstance.publish(topic, payload, options, callback);
                },
                end: (force) => providerInstance.disconnect()
            });

            this.providers.set(providerId, providerInstance);
            
            // Connect the provider
            providerInstance.connect().catch(err => {
                this.logger.error({ err }, `Failed to connect provider ${providerId}`);
            });

        } catch (err) {
            this.logger.error({ err }, `Error instantiating provider ${providerId}`);
        }
    }

    /**
     * Gracefully closes all loaded data providers.
     */
    closeAll() {
        this.logger.info("Closing all data providers...");
        this.providers.forEach((provider, id) => {
            try {
                provider.disconnect();
            } catch(e) {
                this.logger.error({ err: e }, `Error disconnecting provider ${id}`);
            }
        });
        this.providers.clear();
    }
}

module.exports = new ProviderManager();