/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 */

const path = require('path');
const fs = require('fs');

/**
 * @typedef {Object} AppConfig
 * @property {Array} BROKER_CONFIGS
 * @property {Array} DATA_PROVIDERS
 * @property {string} CERTS_PATH
 * @property {string|null} MQTT_BROKER_HOST
 * @property {string|null} MQTT_TOPIC
 * @property {string|null} CLIENT_ID
 * @property {boolean} IS_SIMULATOR_ENABLED
 * @property {boolean} IS_SPARKPLUG_ENABLED
 * @property {number|string} PORT
 * @property {number|null} DUCKDB_MAX_SIZE_MB
 * @property {number} DUCKDB_PRUNE_CHUNK_SIZE
 * @property {number} DB_INSERT_BATCH_SIZE
 * @property {number} DB_BATCH_INTERVAL_MS
 * @property {string} PERENNIAL_DRIVER
 * @property {string} PG_HOST
 * @property {number} PG_PORT
 * @property {string} PG_USER
 * @property {string} PG_PASSWORD
 * @property {string} PG_DATABASE
 * @property {string} PG_TABLE_NAME
 * @property {number} PG_INSERT_BATCH_SIZE
 * @property {number} PG_BATCH_INTERVAL_MS
 * @property {boolean} PG_SSL
 * @property {string|null} PG_CA_FILENAME
 * @property {string|null} PG_CERT_FILENAME
 * @property {string|null} PG_KEY_FILENAME
 * @property {boolean} PG_REJECT_UNAUTHORIZED
 * @property {string|null} HTTP_USER
 * @property {string|null} HTTP_PASSWORD
 * @property {boolean} VIEW_TREE_ENABLED
 * @property {boolean} VIEW_HMI_ENABLED
 * @property {boolean} VIEW_HISTORY_ENABLED
 * @property {boolean} VIEW_MODELER_ENABLED
 * @property {boolean} VIEW_MAPPER_ENABLED
 * @property {boolean} VIEW_CHART_ENABLED
 * @property {boolean} VIEW_PUBLISH_ENABLED
 * @property {boolean} VIEW_CHAT_ENABLED
 * @property {boolean} VIEW_ALERTS_ENABLED
 * @property {boolean} VIEW_CONFIG_ENABLED
 * @property {string} LLM_API_URL
 * @property {string} LLM_API_KEY
 * @property {string} LLM_MODEL
 * @property {string} HMI_FILE_PATH
 * @property {string} BASE_PATH
 * @property {number} MAX_SAVED_CHART_CONFIGS
 * @property {number} MAX_SAVED_MAPPER_VERSIONS
 * @property {string|null} API_ALLOWED_IPS
 * @property {boolean} EXTERNAL_API_ENABLED
 * @property {string} EXTERNAL_API_KEYS_FILE
 * @property {boolean} ANALYTICS_ENABLED
 * @property {Object} AI_TOOLS
 * @property {string} SESSION_SECRET
 * @property {string|undefined} GOOGLE_CLIENT_ID
 * @property {string|undefined} GOOGLE_CLIENT_SECRET
 * @property {string} PUBLIC_URL
 * @property {string|undefined} ADMIN_USERNAME
 * @property {string|undefined} ADMIN_PASSWORD
 */

// --- Helper Functions ---
function parseBoolEnv(val, defaultVal) {
    if (val === undefined || val === null) return defaultVal;
    return String(val).trim().toLowerCase() !== 'false';
}

function parseStrictBoolEnv(val, defaultVal) {
    if (val === undefined || val === null) return defaultVal;
    return String(val).trim().toLowerCase() === 'true';
}

/**
 * Load and parse application configuration from environment variables.
 * @param {Object} logger Pino logger instance.
 * @param {Object} paths Object containing important file paths.
 * @returns {AppConfig}
 */
function loadConfig(logger, paths) {
    const config = {
        BROKER_CONFIGS: [],
        DATA_PROVIDERS: [],
        CERTS_PATH: paths.CERTS_PATH,
        MQTT_BROKER_HOST: process.env.MQTT_BROKER_HOST?.trim() || null,
        MQTT_TOPIC: process.env.MQTT_TOPIC?.trim() || null,
        CLIENT_ID: process.env.CLIENT_ID?.trim() || null,
        IS_SIMULATOR_ENABLED: parseStrictBoolEnv(process.env.SIMULATOR_ENABLED, false),
        IS_SPARKPLUG_ENABLED: parseStrictBoolEnv(process.env.SPARKPLUG_ENABLED, false),
        PORT: process.env.PORT || 8080,
        DUCKDB_MAX_SIZE_MB: process.env.DUCKDB_MAX_SIZE_MB ? parseInt(process.env.DUCKDB_MAX_SIZE_MB, 10) : null,
        DUCKDB_PRUNE_CHUNK_SIZE: process.env.DUCKDB_PRUNE_CHUNK_SIZE ? parseInt(process.env.DUCKDB_PRUNE_CHUNK_SIZE, 10) : 500,
        DB_INSERT_BATCH_SIZE: process.env.DB_INSERT_BATCH_SIZE ? parseInt(process.env.DB_INSERT_BATCH_SIZE, 10) : 5000,
        DB_BATCH_INTERVAL_MS: process.env.DB_BATCH_INTERVAL_MS ? parseInt(process.env.DB_BATCH_INTERVAL_MS, 10) : 2000,
        PERENNIAL_DRIVER: process.env.PERENNIAL_DRIVER?.trim() || 'none',
        PG_HOST: process.env.PG_HOST?.trim() || 'localhost',
        PG_PORT: process.env.PG_PORT ? parseInt(process.env.PG_PORT, 10) : 5432,
        PG_USER: process.env.PG_USER?.trim() || 'postgres',
        PG_PASSWORD: process.env.PG_PASSWORD?.trim() || 'password',
        PG_DATABASE: process.env.PG_DATABASE?.trim() || 'korelate',
        PG_TABLE_NAME: process.env.PG_TABLE_NAME?.trim() || 'mqtt_events',
        PG_INSERT_BATCH_SIZE: process.env.PG_INSERT_BATCH_SIZE ? parseInt(process.env.PG_INSERT_BATCH_SIZE, 10) : 1000,
        PG_BATCH_INTERVAL_MS: process.env.PG_BATCH_INTERVAL_MS ? parseInt(process.env.PG_BATCH_INTERVAL_MS, 10) : 5000,
        PG_SSL: parseStrictBoolEnv(process.env.PG_SSL, false),
        PG_CA_FILENAME: process.env.PG_CA_FILENAME?.trim() || null,
        PG_CERT_FILENAME: process.env.PG_CERT_FILENAME?.trim() || null,
        PG_KEY_FILENAME: process.env.PG_KEY_FILENAME?.trim() || null,
        PG_REJECT_UNAUTHORIZED: parseBoolEnv(process.env.PG_REJECT_UNAUTHORIZED, true),
        HTTP_USER: process.env.HTTP_USER?.trim() || null,
        HTTP_PASSWORD: process.env.HTTP_PASSWORD?.trim() || null,
        VIEW_TREE_ENABLED: parseBoolEnv(process.env.VIEW_TREE_ENABLED, true),
        VIEW_HMI_ENABLED: parseBoolEnv(process.env.VIEW_HMI_ENABLED, true), 
        VIEW_HISTORY_ENABLED: parseBoolEnv(process.env.VIEW_HISTORY_ENABLED, true),
        VIEW_MODELER_ENABLED: parseBoolEnv(process.env.VIEW_MODELER_ENABLED, true), 
        VIEW_MAPPER_ENABLED: parseBoolEnv(process.env.VIEW_MAPPER_ENABLED, true),
        VIEW_CHART_ENABLED: parseBoolEnv(process.env.VIEW_CHART_ENABLED, true),
        VIEW_PUBLISH_ENABLED: parseBoolEnv(process.env.VIEW_PUBLISH_ENABLED, true),
        VIEW_CHAT_ENABLED: parseBoolEnv(process.env.VIEW_CHAT_ENABLED, true),
        VIEW_ALERTS_ENABLED: parseBoolEnv(process.env.VIEW_ALERTS_ENABLED, true), 
        VIEW_CONFIG_ENABLED: parseBoolEnv(process.env.VIEW_CONFIG_ENABLED, true),
        LLM_API_URL: process.env.LLM_API_URL?.trim() || 'https://generativelanguage.googleapis.com/v1beta/openai/',
        LLM_API_KEY: process.env.LLM_API_KEY?.trim() || '',
        LLM_MODEL: process.env.LLM_MODEL?.trim() || 'gemini-2.0-flash',
        HMI_FILE_PATH: process.env.HMI_FILE_PATH?.trim() || process.env.SVG_FILE_PATH?.trim() || 'view.html',
        BASE_PATH: process.env.BASE_PATH?.trim() || '/',
        MAX_SAVED_CHART_CONFIGS: parseInt(process.env.MAX_SAVED_CHART_CONFIGS, 10) || 0,
        MAX_SAVED_MAPPER_VERSIONS: parseInt(process.env.MAX_SAVED_MAPPER_VERSIONS, 10) || 0,
        API_ALLOWED_IPS: process.env.API_ALLOWED_IPS?.trim() || null,
        EXTERNAL_API_ENABLED: parseStrictBoolEnv(process.env.EXTERNAL_API_ENABLED, false),
        EXTERNAL_API_KEYS_FILE: process.env.EXTERNAL_API_KEYS_FILE?.trim() || 'api_keys.json',
        ANALYTICS_ENABLED: parseStrictBoolEnv(process.env.ANALYTICS_ENABLED, false), 
        AI_TOOLS: {
            ENABLE_READ: parseBoolEnv(process.env.LLM_TOOL_ENABLE_READ, true),         
            ENABLE_SEMANTIC: parseBoolEnv(process.env.LLM_TOOL_ENABLE_SEMANTIC, true), 
            ENABLE_PUBLISH: parseBoolEnv(process.env.LLM_TOOL_ENABLE_PUBLISH, true),   
            ENABLE_FILES: parseBoolEnv(process.env.LLM_TOOL_ENABLE_FILES, true),       
            ENABLE_SIMULATOR: parseBoolEnv(process.env.LLM_TOOL_ENABLE_SIMULATOR, true), 
            ENABLE_MAPPER: parseBoolEnv(process.env.LLM_TOOL_ENABLE_MAPPER, true),     
            ENABLE_ADMIN: parseBoolEnv(process.env.LLM_TOOL_ENABLE_ADMIN, true)        
        },
        SESSION_SECRET: process.env.SESSION_SECRET || 'dev_secret_key_change_me',
        GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
        PUBLIC_URL: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8080}`,
        ADMIN_USERNAME: process.env.ADMIN_USERNAME,
        ADMIN_PASSWORD: process.env.ADMIN_PASSWORD
    };

    // --- Broker Configuration Parsing ---
    try {
        if (process.env.MQTT_BROKERS) {
            try {
                config.BROKER_CONFIGS = JSON.parse(process.env.MQTT_BROKERS);
                config.BROKER_CONFIGS.forEach(broker => {
                    if (!broker.subscribe) broker.subscribe = broker.topics || ['#'];
                    if (!broker.publish) broker.publish = (broker.canPublish === false) ? [] : ['#'];
                });
                logger.info(`✅ Loaded ${config.BROKER_CONFIGS.length} legacy broker configuration(s).`);
            } catch (jsonErr) {
                logger.warn({ err: jsonErr }, "⚠️ Invalid JSON in MQTT_BROKERS.");
                config.BROKER_CONFIGS = [];
            }
        } else if (config.MQTT_BROKER_HOST) {
            logger.warn("Using deprecated single-broker env vars.");
            config.BROKER_CONFIGS = [{
                id: "default_broker",
                host: config.MQTT_BROKER_HOST,
                port: process.env.MQTT_PORT?.trim() || null,
                protocol: process.env.MQTT_PROTOCOL?.trim() || 'mqtt',
                clientId: config.CLIENT_ID,
                username: process.env.MQTT_USERNAME?.trim() || null,
                password: process.env.MQTT_PASSWORD?.trim() || null,
                subscribe: config.MQTT_TOPIC ? config.MQTT_TOPIC.split(',').map(t => t.trim()) : ['#'],
                publish: ['#'],
                certFilename: process.env.CERT_FILENAME?.trim() || null,
                keyFilename: process.env.KEY_FILENAME?.trim() || null,
                caFilename: process.env.CA_FILENAME?.trim() || null,
                alpnProtocol: process.env.MQTT_ALPN_PROTOCOL?.trim() || null,
                rejectUnauthorized: parseBoolEnv(process.env.MQTT_REJECT_UNAUTHORIZED, true)
            }];
        }

        if (config.BROKER_CONFIGS.length === 0 && parseBoolEnv(process.env.ENABLE_LOCAL_MQTT_FALLBACK, true)) {
            const localBroker = {
                id: "local_mqtt",
                host: process.env.LOCAL_MQTT_HOST || "mqtt",
                port: parseInt(process.env.LOCAL_MQTT_PORT, 10) || 1883,
                protocol: "mqtt",
                clientId: "mqtt-uns-viewer-local",
                username: process.env.LOCAL_MQTT_USERNAME || "",
                password: process.env.LOCAL_MQTT_PASSWORD || "",
                subscribe: ["#"],
                publish: ["#"],
                certFilename: "",
                keyFilename: "",
                caFilename: "",
                alpnProtocol: "",
                rejectUnauthorized: false
            };

            config.BROKER_CONFIGS.push(localBroker);
            logger.info(`✅ No MQTT brokers configured; using local fallback ${localBroker.host}:${localBroker.port}`);
        }

        if (process.env.DATA_PROVIDERS) {
            try {
                config.DATA_PROVIDERS = JSON.parse(process.env.DATA_PROVIDERS);
                logger.info(`✅ Loaded ${config.DATA_PROVIDERS.length} custom data provider(s).`);
            } catch (jsonErr) {
                logger.warn({ err: jsonErr }, "⚠️ Invalid JSON in DATA_PROVIDERS.");
                config.DATA_PROVIDERS = [];
            }
        }
    } catch (err) {
        logger.error({ err }, "❌ Unexpected error during configuration parsing.");
        config.BROKER_CONFIGS = [];
        config.DATA_PROVIDERS = [];
    }

    // --- Normalize Base Path ---
    let basePath = config.BASE_PATH;
    if (!basePath.startsWith('/')) basePath = '/' + basePath;
    if (basePath.endsWith('/') && basePath.length > 1) basePath = basePath.slice(0, -1);
    config.BASE_PATH = basePath;

    return config;
}

module.exports = { loadConfig };
