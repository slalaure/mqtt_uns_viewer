/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Connector Manager (formerly ConnectorManager)
 * Abstraction layer to manage different data providers dynamically (Southbound).
 */
const fs = require('fs');
const path = require('path');
const messageDispatcher = require('../core/messageDispatcher');
const BaseProvider = require('./baseProvider.js');

class ConnectorManager {
    constructor() {
        this.providers = new Map();
        this.context = null;
        this._defaultLogger = console; // Fallback to console if init not called
    }

    get logger() {
        return (this.context && this.context.logger) ? this.context.logger.child({ component: 'ConnectorManager' }) : this._defaultLogger;
    }

    /**
     * Initializes the Connector Manager and loads configured data providers.
     * @param {Object} context - Global application context
     */
    init(context) {
        this.context = context;
        this.app = context.app;
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
     * Resolves a provider class based on type, checking external then internal paths.
     * @param {string} type - The provider type (e.g., 'mqtt', 'kafka')
     * @returns {typeof BaseProvider|null} The resolved provider class or null
     * @private
     */
    _resolveProvider(type) {
        const candidates = [
            `korelate-plugin-${type}`,              // 1. Prefixed external plugin
            type,                                  // 2. Direct package name
            path.join(__dirname, type, 'index.js'), // 3. Internal connector (explicit)
            path.join(__dirname, type)              // 4. Internal connector (folder-based)
        ];

        for (const candidate of candidates) {
            try {
                this.logger.debug(`Attempting to load connector candidate: ${candidate}`);
                const ProviderClass = require(candidate);

                // Interface Validation: must be a class/function extending BaseProvider
                if (typeof ProviderClass === 'function' && 
                    (ProviderClass.prototype instanceof BaseProvider || ProviderClass === BaseProvider)) {
                    this.logger.info(`Successfully resolved connector [${type}] from: ${candidate}`);
                    return ProviderClass;
                } else {
                    this.logger.warn(`Found module at ${candidate}, but it does not extend BaseProvider. Skipping...`);
                }
            } catch (err) {
                // Ignore MODULE_NOT_FOUND, but log other actual errors in the plugin code
                if (err.code !== 'MODULE_NOT_FOUND') {
                    this.logger.error({ err, candidate }, `Error loading connector candidate [${type}]`);
                }
            }
        }

        return null;
    }

    /**
     * Routes the configuration to the appropriate provider plugin.
     * @param {Object} providerConfig - Configuration object for the specific provider
     */
    loadProvider(providerConfig) {
        const type = providerConfig.type || 'unknown';
        const providerId = providerConfig.id;
        
        if (!providerId) {
            this.logger.error("Cannot load provider: Missing 'id' in configuration.");
            return;
        }

        this.logger.info(`Loading data connector plugin [${type}] for ID: ${providerId}`);

        const ProviderClass = this._resolveProvider(type);
        
        if (!ProviderClass) {
            this.logger.warn(`Unsupported or missing connector plugin: ${type}. Ensure it is installed as korelate-plugin-${type} or exists in connectors/${type}/index.js`);
            return;
        }

        try {
            const providerInstance = new ProviderClass(providerConfig, this.context);
            
            // Expose a standard connection object to activeConnections for backward compatibility 
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