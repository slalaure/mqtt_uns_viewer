/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Connector Manager (formerly ConnectorManager)
 * Abstraction layer to manage different data providers dynamically (Southbound).
 */
const fs = require('fs');
const path = require('path');
const messageDispatcher = require('../core/messageDispatcher'); // [UPDATED] Points to core

class ConnectorManager {
    constructor() {
        this.providers = new Map();
        this.context = null;
        this.logger = null;
    }

    /**
     * Initializes the Connector Manager and loads configured data providers.
     * @param {Object} context - Global application context
     */
    init(context) {
        this.context = context;
        this.app = context.app;
        this.logger = context.logger.child({ component: 'ConnectorManager' });
        this.logger.info("Initializing Data Connectors Abstraction Layer...");

        // Initialize the central message dispatcher
        this.context.handleMessage = messageDispatcher.init(
            context.logger,
            context.config,
            context.wsManager,
            context.mapperEngine,
            context.dataManager,
            context.broadcastDbStatus,
            context.alertManager
        );

        // 1. Load generic DATA_PROVIDERS
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
        this.logger.info(`Loading data connector plugin [${type}] for ID: ${providerId}`);

        let ProviderClass;
        try {
            // Dynamically load the plugin from its specific folder
            ProviderClass = require(`./${type}/index.js`);
        } catch (err) {
            this.logger.warn(`Unsupported or missing connector plugin: ${type}. Expected at connectors/${type}/index.js`);
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
        this.logger.info("Closing all data connectors...");
        this.providers.forEach((provider, id) => {
            try {
                provider.disconnect();
            } catch(e) {
                this.logger.error({ err: e }, `Error disconnecting provider ${id}`);
            }
        });
        this.providers.clear();
        this.context.activeConnections.clear();
    }

    /**
     * Re-initializes providers by closing current ones and reloading from config.
     */
    async refreshProviders() {
        this.logger.info("🔄 Refreshing Data Connectors from updated configuration...");
        this.closeAll();
        
        // Reload generic DATA_PROVIDERS from the current config
        if (this.context.config.DATA_PROVIDERS) {
            this.context.config.DATA_PROVIDERS.forEach(providerConfig => {
                this.loadProvider(providerConfig);
            });
        }
    }
}

module.exports = new ConnectorManager();