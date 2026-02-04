/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * Server Entry Point
 */
// --- Imports ---
const pino = require('pino');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const mqtt = require('mqtt');
const duckdb = require('duckdb');
const { spawn } = require('child_process');
const basicAuth = require('basic-auth');
const spBv10Codec = require('sparkplug-payload').get("spBv1.0");
const mqttMatch = require('mqtt-match');
// --- Auth Imports ---
const session = require('express-session');
const FileStore = require('session-file-store')(session); 
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
// --- Module Imports  ---
const wsManager = require('./websocket-manager');
const mqttHandler = require('./mqtt-handler');
const { createMqttClient } = require('./mqtt_client'); 
const simulatorManager = require('./simulator');
const dataManager = require('./database/dataManager');
const externalApiRouter = require('./routes/externalApi'); 
const userManager = require('./database/userManager'); // Import User Manager
// --- Constants & Paths ---
const DATA_PATH = path.join(__dirname, 'data');
const ENV_PATH = path.join(DATA_PATH, '.env');
const ENV_EXAMPLE_PATH = path.join(__dirname, '.env.example');
const CERTS_PATH = path.join(DATA_PATH, 'certs');
const DB_PATH = path.join(DATA_PATH, 'mqtt_events.duckdb');
const CHART_CONFIG_PATH = path.join(DATA_PATH, 'charts.json'); 
const API_KEYS_FILE_PATH = path.join(DATA_PATH, process.env.EXTERNAL_API_KEYS_FILE || 'api_keys.json');
const SESSIONS_PATH = path.join(DATA_PATH, 'sessions');
// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_PATH)) {
    try { fs.mkdirSync(SESSIONS_PATH, { recursive: true }); } catch (e) {}
}
// --- Analytics Script ---
// This script will only be injected if ANALYTICS_ENABLED=true
const ANALYTICS_SCRIPT = `
    <script type="text/javascript">
        (function(c,l,a,r,i,t,y){
            c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
            t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
            y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
        })(window, document, "clarity", "script", "u3mhr7cn0n");
    </script>
`;
// --- Logger Setup ---
const logger = pino({
    transport: {
        target: 'pino-pretty',
        options: { colorize: true }
    }
});
// --- Initial .env File Setup ---
if (!fs.existsSync(ENV_PATH)) {
    logger.info("✅ No .env file found in 'data' directory. Creating one from project root .env.example...");
    try {
        fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
        logger.info("✅ .env file created successfully in ./data/");
    } catch (err) {
        logger.error({ err }, "❌ FATAL ERROR: Could not create .env file.");
        process.exit(1);
    }
}
require('dotenv').config({ path: ENV_PATH });
// --- Initial charts.json File Setup ---
if (!fs.existsSync(CHART_CONFIG_PATH)) {
    try {
        fs.writeFileSync(CHART_CONFIG_PATH, JSON.stringify({ configurations: [] }, null, 2));
    } catch (err) { /* ignore */ }
}
// --- Helper Function for Sparkplug (handles BigInt) ---
function longReplacer(key, value) {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    return value;
}
// --- Global Variables ---
let activeConnections = new Map(); 
let brokerStatuses = new Map(); 
let isPruning = false;
let apiKeysConfig = { keys: [] };
let isShuttingDown = false; // Global shutdown flag
// --- Configuration from Environment ---
const config = {
    BROKER_CONFIGS: [],
    MQTT_BROKER_HOST: process.env.MQTT_BROKER_HOST?.trim() || null,
    MQTT_TOPIC: process.env.MQTT_TOPIC?.trim() || null,
    CLIENT_ID: process.env.CLIENT_ID?.trim() || null,
    IS_SIMULATOR_ENABLED: process.env.SIMULATOR_ENABLED === 'true',
    IS_SPARKPLUG_ENABLED: process.env.SPARKPLUG_ENABLED === 'true',
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
    PG_DATABASE: process.env.PG_DATABASE?.trim() || 'mqtt_uns_viewer',
    PG_TABLE_NAME: process.env.PG_TABLE_NAME?.trim() || 'mqtt_events',
    PG_INSERT_BATCH_SIZE: process.env.PG_INSERT_BATCH_SIZE ? parseInt(process.env.PG_INSERT_BATCH_SIZE, 10) : 1000,
    PG_BATCH_INTERVAL_MS: process.env.PG_BATCH_INTERVAL_MS ? parseInt(process.env.PG_BATCH_INTERVAL_MS, 10) : 5000,
    HTTP_USER: process.env.HTTP_USER?.trim() || null,
    HTTP_PASSWORD: process.env.HTTP_PASSWORD?.trim() || null,
    VIEW_TREE_ENABLED: process.env.VIEW_TREE_ENABLED !== 'false',
    VIEW_SVG_ENABLED: process.env.VIEW_SVG_ENABLED !== 'false',
    VIEW_HISTORY_ENABLED: process.env.VIEW_HISTORY_ENABLED !== 'false',
    VIEW_MAPPER_ENABLED: process.env.VIEW_MAPPER_ENABLED !== 'false',
    VIEW_CHART_ENABLED: process.env.VIEW_CHART_ENABLED !== 'false',
    VIEW_PUBLISH_ENABLED: process.env.VIEW_PUBLISH_ENABLED !== 'false',
    VIEW_CHAT_ENABLED: process.env.VIEW_CHAT_ENABLED !== 'false',
    LLM_API_URL: process.env.LLM_API_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/',
    LLM_API_KEY: process.env.LLM_API_KEY || '',
    LLM_MODEL: process.env.LLM_MODEL || 'gemini-2.0-flash',
    SVG_FILE_PATH: process.env.SVG_FILE_PATH?.trim() || 'view.svg',
    BASE_PATH: process.env.BASE_PATH?.trim() || '/',
    VIEW_CONFIG_ENABLED: process.env.VIEW_CONFIG_ENABLED !== 'false',
    MAX_SAVED_CHART_CONFIGS: parseInt(process.env.MAX_SAVED_CHART_CONFIGS, 10) || 0,
    MAX_SAVED_MAPPER_VERSIONS: parseInt(process.env.MAX_SAVED_MAPPER_VERSIONS, 10) || 0,
    API_ALLOWED_IPS: process.env.API_ALLOWED_IPS?.trim() || null,
    EXTERNAL_API_ENABLED: process.env.EXTERNAL_API_ENABLED === 'true',
    EXTERNAL_API_KEYS_FILE: process.env.EXTERNAL_API_KEYS_FILE?.trim() || 'api_keys.json',
    ANALYTICS_ENABLED: process.env.ANALYTICS_ENABLED === 'true', 
    AI_TOOLS: {
        ENABLE_READ: process.env.LLM_TOOL_ENABLE_READ !== 'false',         
        ENABLE_SEMANTIC: process.env.LLM_TOOL_ENABLE_SEMANTIC !== 'false', 
        ENABLE_PUBLISH: process.env.LLM_TOOL_ENABLE_PUBLISH !== 'false',   
        ENABLE_FILES: process.env.LLM_TOOL_ENABLE_FILES !== 'false',       
        ENABLE_SIMULATOR: process.env.LLM_TOOL_ENABLE_SIMULATOR !== 'false', 
        ENABLE_MAPPER: process.env.LLM_TOOL_ENABLE_MAPPER !== 'false',     
        ENABLE_ADMIN: process.env.LLM_TOOL_ENABLE_ADMIN !== 'false'        
    },
    // Auth Config
    SESSION_SECRET: process.env.SESSION_SECRET || 'dev_secret_key_change_me',
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    PUBLIC_URL: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8080}`,
    // [NEW] Admin Credentials
    ADMIN_USERNAME: process.env.ADMIN_USERNAME,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD
};
// ---  Broker Configuration Parsing ---
try {
    if (process.env.MQTT_BROKERS) {
        try {
            config.BROKER_CONFIGS = JSON.parse(process.env.MQTT_BROKERS);
            config.BROKER_CONFIGS.forEach(broker => {
                if (!broker.subscribe) broker.subscribe = broker.topics || ['#'];
                if (!broker.publish) broker.publish = (broker.canPublish === false) ? [] : ['#'];
            });
            logger.info(`✅ Loaded ${config.BROKER_CONFIGS.length} broker configuration(s).`);
        } catch (jsonErr) {
            logger.warn({ err: jsonErr }, "⚠️ Invalid JSON in MQTT_BROKERS. Starting without brokers (Simulator/Offline Mode).");
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
            rejectUnauthorized: process.env.MQTT_REJECT_UNAUTHORIZED !== 'false'
        }];
    } else {
        logger.warn("⚠️ No MQTT broker configuration found (MQTT_BROKERS or MQTT_BROKER_HOST). Starting in OFFLINE/SIMULATOR mode.");
        config.BROKER_CONFIGS = [];
    }
    // Initialize status for configured brokers
    for (const broker of config.BROKER_CONFIGS) {
        brokerStatuses.set(broker.id, { status: 'connecting', error: null });
    }
} catch (err) {
    logger.error({ err }, "❌ Unexpected error during broker configuration parsing. Proceeding without brokers.");
    config.BROKER_CONFIGS = [];
}
// --- Configuration Validation ---
if (config.IS_SPARKPLUG_ENABLED) logger.info("✅ 🚀 Sparkplug B decoding is ENABLED.");
if (config.ANALYTICS_ENABLED) logger.info("✅ 📈 Analytics (Clarity) tracking is ENABLED.");
// --- Normalize Base Path ---
let basePath = config.BASE_PATH;
if (!basePath.startsWith('/')) basePath = '/' + basePath;
if (basePath.endsWith('/') && basePath.length > 1) basePath = basePath.slice(0, -1);
// ---  Load External API Keys ---
if (config.EXTERNAL_API_ENABLED) {
    const keysFilePath = path.join(DATA_PATH, config.EXTERNAL_API_KEYS_FILE);
    try {
        if (fs.existsSync(keysFilePath)) {
            apiKeysConfig = JSON.parse(fs.readFileSync(keysFilePath, 'utf8'));
            logger.info(`✅ Loaded API keys.`);
        }
    } catch (err) {
        logger.error("❌ Failed to load API keys.");
    }
}
// ---  Helper to get connections ---
function getPrimaryConnection() {
    if (activeConnections.size === 0) return null;
    return activeConnections.values().next().value || null;
}
function getBrokerConnection(brokerId) {
    if (!brokerId) return getPrimaryConnection();
    return activeConnections.get(brokerId) || null;
}
// --- Helper to update and broadcast broker status ---
function updateBrokerStatus(brokerId, status, error = null) {
    const info = { status, error, timestamp: Date.now() };
    brokerStatuses.set(brokerId, info);
    wsManager.broadcast(JSON.stringify({ type: 'broker-status', brokerId, ...info }));
}
// --- Express App & Server Setup ---
const app = express();
const server = http.createServer(app);
// Enable trust proxy for Redbird/Traefik compatibility
app.enable('trust proxy');
// --- Session & Passport Setup ---
app.use(session({
    store: new FileStore({ path: SESSIONS_PATH, ttl: 86400 }), // 1 day persistence
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // Secure should be true in HTTPS
}));
app.use(passport.initialize());
app.use(passport.session());
// Passport Serialization
passport.serializeUser((user, done) => {
    done(null, user.id);
});
passport.deserializeUser(async (id, done) => {
    try {
        const user = await userManager.findById(id);
        done(null, user);
    } catch (err) {
        done(err);
    }
});
// Local Strategy
passport.use(new LocalStrategy(async (username, password, done) => {
    try {
        const user = await userManager.findByUsername(username);
        if (!user) { return done(null, false, { message: 'Incorrect username.' }); }
        const isValid = await userManager.verifyPassword(password, user.password_hash);
        if (!isValid) { return done(null, false, { message: 'Incorrect password.' }); }
        return done(null, user);
    } catch (err) { return done(err); }
}));
// Google Strategy
if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
    logger.info("✅ Google OAuth Strategy Enabled.");
    passport.use(new GoogleStrategy({
        clientID: config.GOOGLE_CLIENT_ID,
        clientSecret: config.GOOGLE_CLIENT_SECRET,
        callbackURL: `${config.PUBLIC_URL}${basePath === '/' ? '' : basePath}/auth/google/callback`
    },
    async (accessToken, refreshToken, profile, done) => {
        try {
            const user = await userManager.findOrCreateGoogleUser(profile);
            return done(null, user);
        } catch (err) { return done(err); }
    }));
}
// --- CORS Middleware ---
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, content-type');
    next();
});
// --- Mapper Engine Setup ---
const mapperEngine = require('./mapper_engine')(
    activeConnections, 
    wsManager.broadcast, 
    logger,
    longReplacer,
    config 
);
// ---  DuckDB Setup (Centralized Initialization) ---
const dbFile = DB_PATH;
const dbWalFile = dbFile + '.wal';
let db; 
db = new duckdb.Database(dbFile, (err) => {
    if (err) {
        logger.error({ err }, "❌ FATAL ERROR: Could not connect to DuckDB.");
        process.exit(1);
    }
    logger.info("✅ 🦆 DuckDB database connected.");
    // 1. Initialize User Manager Table (Passing Sessions Path now)
    userManager.init(db, logger, SESSIONS_PATH);
    // [NEW] 2. Ensure Admin User Exists
    if (config.ADMIN_USERNAME && config.ADMIN_PASSWORD) {
        userManager.ensureAdminUser(config.ADMIN_USERNAME, config.ADMIN_PASSWORD);
    }
    // 3. Ensure table exists
    db.exec(`
        CREATE TABLE IF NOT EXISTS mqtt_events (
            timestamp TIMESTAMPTZ,
            topic VARCHAR,
            payload JSON,
            broker_id VARCHAR
        );`, (createErr) => {
        if (createErr) {
            logger.error({ err: createErr }, "❌ FATAL: Failed to ensure table 'mqtt_events' exists.");
            return; 
        }
        // 4. Schema Migration Check
        db.all("PRAGMA table_info(mqtt_events);", (pragmaErr, columns) => {
            if (columns) {
                const hasBrokerId = columns.some(col => col.name === 'broker_id');
                if (!hasBrokerId) {
                    logger.warn("⚠️  Migrating schema: Adding 'broker_id'...");
                    db.exec("ALTER TABLE mqtt_events ADD COLUMN broker_id VARCHAR;", () => {
                        db.exec("UPDATE mqtt_events SET broker_id = 'default_broker' WHERE broker_id IS NULL;");
                    });
                }
            }
        });
    });
    mapperEngine.setDb(db);
    const { getDbStatus, broadcastDbStatus, performMaintenance } = require('./db_manager')(db, dbFile, dbWalFile, wsManager.broadcast, logger, config.DUCKDB_MAX_SIZE_MB, config.DUCKDB_PRUNE_CHUNK_SIZE, () => isPruning, (status) => { isPruning = status; });
    dataManager.init(config, logger, mapperEngine, db, broadcastDbStatus);
    wsManager.initWebSocketManager(server, db, logger, basePath, getDbStatus, longReplacer, () => brokerStatuses);
    setInterval(performMaintenance, 15000);
    // Connect to ALL MQTT Brokers
    config.BROKER_CONFIGS.forEach(brokerConfig => {
        const brokerId = brokerConfig.id;
        const connection = createMqttClient(brokerConfig, logger, CERTS_PATH);
        if (!connection) {
            logger.warn(`⚠️ Skipping broker '${brokerId}' due to initialization failure.`);
            updateBrokerStatus(brokerId, 'error', 'Initialization failed (Config/Certs)');
            return; // Skip this broker
        }
        activeConnections.set(brokerId, connection);
        // Initialize the handler logic once
        const handleMessage = mqttHandler.init(
            logger,
            config,
            wsManager,
            mapperEngine,
            dataManager, 
            broadcastDbStatus
        );
        // --- Event Listeners ---
        connection.on('connect', () => {
            logger.info(`✅ MQTT Broker '${brokerId}' connected.`);
            updateBrokerStatus(brokerId, 'connected');
            const rawTopics = (brokerConfig.subscribe && brokerConfig.subscribe.length > 0) ? brokerConfig.subscribe : brokerConfig.topics;
            const subscriptionTopics = Array.isArray(rawTopics) ? rawTopics.map(t => t.trim()) : [];
            if (subscriptionTopics.length > 0) {
                connection.subscribe(subscriptionTopics, { qos: 1 }, (err) => {
                    if (err) logger.error({ err }, `❌ Subscription failed for '${brokerId}'`);
                    else logger.info(`✅ Subscribed on '${brokerId}'`);
                });
            }
        });
        connection.on('message', (topic, payload) => {
            handleMessage(brokerId, topic, payload); 
        });
        connection.on('reconnect', () => {
            logger.info(`🔄 MQTT Broker '${brokerId}' reconnecting...`);
            updateBrokerStatus(brokerId, 'connecting');
        });
        connection.on('offline', () => {
            updateBrokerStatus(brokerId, 'offline');
        });
        connection.on('error', (err) => {
            logger.error(`❌ MQTT Error on '${brokerId}': ${err.message}`);
            updateBrokerStatus(brokerId, 'error', err.message);
        });
        connection.on('close', () => {
            if (!isShuttingDown) {
               updateBrokerStatus(brokerId, 'disconnected');
            }
        });
    });
});
// --- Middleware & Routes ---
const authMiddleware = (req, res, next) => {
    // 1. Allow if session is active (Passport)
    if (req.isAuthenticated()) return next();
    // 2. Allow if Asset file (css, js, etc) - Strict whitelisting
    const ext = path.extname(req.path).toLowerCase();
    const allowedExts = ['.css', '.js', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf'];
    if (allowedExts.includes(ext)) return next();
    // 3. Fallback to Basic Auth if Configured (for API/M2M or legacy usage)
    if (config.HTTP_USER && config.HTTP_PASSWORD) {
        const credentials = basicAuth(req);
        if (credentials && credentials.name === config.HTTP_USER && credentials.pass === config.HTTP_PASSWORD) {
            return next();
        }
        res.setHeader('WWW-Authenticate', 'Basic realm="MQTT UNS Viewer"');
        return res.status(401).send('Authentication required.');
    }
    // 4. If no Basic Auth configured, we redirect to login page (index.html handles this)
    // BUT we need to ensure we don't loop redirecting /auth routes
    if (req.path.startsWith('/auth') || req.path === '/login') {
        return next();
    }
    // Default: Allow if no auth configured at all, otherwise block
    if (!config.HTTP_USER && !config.HTTP_PASSWORD) return next();
    return res.status(401).send('Unauthorized. Please log in.');
};
// --- [NEW] Admin Middleware ---
const requireAdmin = (req, res, next) => {
    if (req.isAuthenticated() && req.user.role === 'admin') {
        return next();
    }
    // Also allow Basic Auth admin (legacy/API use case)
    if (config.HTTP_USER && config.HTTP_PASSWORD) {
        const credentials = basicAuth(req);
        if (credentials && credentials.name === config.HTTP_USER && credentials.pass === config.HTTP_PASSWORD) {
            // Implicitly treat env-configured Basic Auth user as admin for API tasks
            return next();
        }
    }
    logger.warn(`[Security] Admin access denied for ${req.user ? req.user.username : req.ip} on ${req.originalUrl}`);
    return res.status(403).send("Forbidden: Admin privileges required.");
};
let ALLOWED_IPS = config.API_ALLOWED_IPS ? config.API_ALLOWED_IPS.split(',').map(ip => ip.trim()) : [];
const ipFilterMiddleware = (req, res, next) => {
    if (ALLOWED_IPS.length === 0 || ALLOWED_IPS.includes(req.ip)) return next();
    res.status(403).json({ error: `Access denied for IP ${req.ip}` });
};
const mainRouter = express.Router();
mainRouter.use(express.json({ limit: '50mb' }));
app.set('trust proxy', true);
// Simulator
simulatorManager.init(logger, (topic, payload) => {
    const conn = getPrimaryConnection();
    if (conn && conn.connected) {
        conn.publish(topic, payload, { qos: 1 });
    }
}, config.IS_SPARKPLUG_ENABLED);
// --- Auth Routes ---
mainRouter.use('/auth', require('./routes/authApi')(logger));
// --- [NEW] Admin Routes ---
mainRouter.use('/api/admin', require('./routes/adminApi')(logger));
// --- [NEW] Layered File System Helper for SVGs ---
// Determines the priority file path (Private > Global)
function resolveSvgPath(filename, req) {
    const globalPath = path.join(DATA_PATH, filename);
    if (req.user && req.user.id) {
        const userSvgDir = path.join(SESSIONS_PATH, req.user.id, 'svgs');
        const userPath = path.join(userSvgDir, filename);
        // If user has a private copy, serve it
        if (fs.existsSync(userPath)) {
            return userPath;
        }
    }
    // Fallback to global
    return globalPath;
}
// --- API Routes ---
// [MODIFIED] Serve SVG file with precedence (Private > Global)
mainRouter.get('/api/svg/file', (req, res) => {
    const filename = path.basename(req.query.name || '');
    if (!filename.endsWith('.svg')) return res.status(400).send('Invalid file type');
    const filePath = resolveSvgPath(filename, req);
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('Not found');
    }
});
// [MODIFIED] List SVGs (Merge Global + Private)
mainRouter.get('/api/svg/list', (req, res) => {
    try {
        let files = new Set();
        // 1. Add Global Files
        if (fs.existsSync(DATA_PATH)) {
            fs.readdirSync(DATA_PATH).forEach(f => {
                if (f.endsWith('.svg')) files.add(f);
            });
        }
        // 2. Add Private Files (if logged in)
        if (req.user && req.user.id) {
            const userSvgDir = path.join(SESSIONS_PATH, req.user.id, 'svgs');
            if (fs.existsSync(userSvgDir)) {
                fs.readdirSync(userSvgDir).forEach(f => {
                    if (f.endsWith('.svg')) files.add(f);
                });
            }
        }
        res.json(Array.from(files).sort());
    } catch { 
        res.status(500).json([]); 
    }
});
// [MODIFIED] Serve Bindings JS with precedence
mainRouter.get('/api/svg/bindings.js', (req, res) => {
    const filename = path.basename(req.query.name || '');
    // filename comes in as "view.svg.js" likely, or we construct it? 
    // The client calls: bindings.js?name=view.svg.js
    const filePath = resolveSvgPath(filename, req);
    if (fs.existsSync(filePath)) { 
        res.setHeader('Content-Type', 'application/javascript'); 
        res.sendFile(filePath); 
    } else { 
        res.setHeader('Content-Type', 'application/javascript'); 
        res.send('// No bindings'); 
    }
});

// [NEW] Delete SVG View (File + JS)
mainRouter.delete('/api/svg/file', (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const filename = path.basename(req.query.name || '');
    if (!filename.endsWith('.svg')) return res.status(400).json({ error: "Invalid file type" });

    const globalPath = path.join(DATA_PATH, filename);
    let targetPath = null;
    let isPrivate = false;

    // Check for private file first
    if (req.user && req.user.id) {
        const userSvgDir = path.join(SESSIONS_PATH, req.user.id, 'svgs');
        const userPath = path.join(userSvgDir, filename);
        if (fs.existsSync(userPath)) {
            targetPath = userPath;
            isPrivate = true;
        }
    }

    // Fallback to global if private not found
    if (!targetPath && fs.existsSync(globalPath)) {
        targetPath = globalPath;
        isPrivate = false;
    }

    if (!targetPath) {
        return res.status(404).json({ error: "File not found" });
    }

    // Permission Logic
    if (!isPrivate) {
        // Only Admin can delete global files
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: "Forbidden: Only Admins can delete Global SVG views." });
        }
    }

    try {
        // Delete .svg
        fs.unlinkSync(targetPath);
        logger.info(`Deleted SVG: ${targetPath}`);
        
        // Try delete .svg.js
        const jsPath = targetPath + ".js";
        if (fs.existsSync(jsPath)) {
            fs.unlinkSync(jsPath);
            logger.info(`Deleted SVG JS: ${jsPath}`);
        }
        
        res.json({ success: true, message: "View deleted successfully." });
    } catch (err) {
        logger.error({ err }, "Error deleting SVG");
        res.status(500).json({ error: "Failed to delete file" });
    }
});

mainRouter.get('/api/config', (req, res) => {
    res.json({
        isSimulatorEnabled: config.IS_SIMULATOR_ENABLED,
        brokerConfigs: config.BROKER_CONFIGS.map(b => ({ id: b.id, host: b.host, port: b.port, subscribe: b.subscribe, publish: b.publish })),
        isMultiBroker: config.BROKER_CONFIGS.length > 1,
        viewTreeEnabled: config.VIEW_TREE_ENABLED,
        viewSvgEnabled: config.VIEW_SVG_ENABLED,
        viewHistoryEnabled: config.VIEW_HISTORY_ENABLED,
        viewMapperEnabled: config.VIEW_MAPPER_ENABLED,
        viewChartEnabled: config.VIEW_CHART_ENABLED,
        viewPublishEnabled: config.VIEW_PUBLISH_ENABLED,
        viewChatEnabled: config.VIEW_CHAT_ENABLED,
        basePath: basePath,
        viewConfigEnabled: config.VIEW_CONFIG_ENABLED,
        maxSavedChartConfigs: config.MAX_SAVED_CHART_CONFIGS,
        maxSavedMapperVersions: config.MAX_SAVED_MAPPER_VERSIONS,
        svgFilePath: config.SVG_FILE_PATH
    });
});
if (config.IS_SIMULATOR_ENABLED) {
    mainRouter.get('/api/simulator/status', (req, res) => {
        // [FIX] Ensure we return an object with "statuses" property
        res.json({ statuses: simulatorManager.getStatuses() });
    });
    // [SECURED] Require Admin to start/stop
    mainRouter.post('/api/simulator/start/:name', requireAdmin, (req, res) => {
        const r = simulatorManager.startSimulator(req.params.name);
        wsManager.broadcast(JSON.stringify({ type: 'simulator-status', statuses: simulatorManager.getStatuses() }));
        res.json(r);
    });
    mainRouter.post('/api/simulator/stop/:name', requireAdmin, (req, res) => {
        const r = simulatorManager.stopSimulator(req.params.name);
        wsManager.broadcast(JSON.stringify({ type: 'simulator-status', statuses: simulatorManager.getStatuses() }));
        res.json(r);
    });
}
mainRouter.use('/api/context', (req, res, next) => {
    if (!db) return res.status(503).json({ error: "DB not ready" });
    const dbManager = require('./db_manager')(db, dbFile, dbWalFile, wsManager.broadcast, logger, config.DUCKDB_MAX_SIZE_MB, config.DUCKDB_PRUNE_CHUNK_SIZE, () => isPruning, (status) => { isPruning = status; });
    require('./routes/mcpApi')(db, getPrimaryConnection, simulatorManager.getStatuses, dbManager.getDbStatus, config)(req, res, next);
});
mainRouter.use('/api/tools', ipFilterMiddleware, require('./routes/toolsApi')(logger));
if (config.VIEW_CHAT_ENABLED) {
    mainRouter.use('/api/chat', ipFilterMiddleware, require('./routes/chatApi')(db, logger, config, getBrokerConnection, simulatorManager, wsManager, mapperEngine));
}
if (config.VIEW_CONFIG_ENABLED) {
    // [SECURED] Apply Admin Middleware for Environment Config Access
    mainRouter.use('/api/env', ipFilterMiddleware, requireAdmin, require('./routes/configApi')(ENV_PATH, ENV_EXAMPLE_PATH, DATA_PATH, logger, db, dataManager));
}
mainRouter.use('/api/mapper', ipFilterMiddleware, require('./routes/mapperApi')(mapperEngine));
mainRouter.use('/api/chart', ipFilterMiddleware, require('./routes/chartApi')(CHART_CONFIG_PATH, logger));
mainRouter.post('/api/publish/message', ipFilterMiddleware, (req, res) => {
    const { topic, payload, format, qos, retain, brokerId } = req.body;
    const conn = getBrokerConnection(brokerId);
    if (!conn || !conn.connected) return res.status(503).json({ error: "Broker not connected" });
    let finalPayload = payload;
    if (format === 'json' || typeof payload === 'object') {
        try { finalPayload = JSON.stringify(typeof payload === 'string' ? JSON.parse(payload) : payload); } catch(e) {}
    } else if (format === 'sparkplugb') {
        try { finalPayload = spBv10Codec.encodePayload(JSON.parse(payload)); } catch(e) { return res.status(400).json({ error: e.message }); }
    }
    conn.publish(topic, finalPayload, { qos: parseInt(qos)||0, retain: !!retain }, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});
if (config.EXTERNAL_API_ENABLED) {
    mainRouter.use('/api/external', ipFilterMiddleware, require('./routes/externalApi')(getPrimaryConnection, logger, apiKeysConfig, longReplacer));
}
// [SECURED] Explicitly protect the configuration page
if (config.VIEW_CONFIG_ENABLED) {
    mainRouter.get('/config.html', requireAdmin);
    mainRouter.get('/config.js', requireAdmin);
} else {
    mainRouter.get('/config.html', (req, res) => res.status(403).send('Disabled'));
    mainRouter.get('/config.js', (req, res) => res.status(403).send('Disabled'));
}
// Disable internal redirect for static files to allow Redbird to handle slashes
mainRouter.use(express.static(path.join(__dirname, 'public'), { redirect: false, index: false }));
// Helper to serve index.html with dynamic base tag injection.
const serveSPA = (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(indexPath, 'utf8', (err, data) => {
        if (err) {
            logger.error({ err }, "Failed to read index.html");
            return res.status(500).send("Server Error");
        }
        const safeBasePath = basePath.endsWith('/') ? basePath : basePath + '/';
        let modifiedHtml = data;
        // 1. Inject <base href="...">
        modifiedHtml = modifiedHtml.replace('<head>', `<head>\n    <base href="${safeBasePath}">`);
        // 2. Inject User Session State (Global Variable)
        let userState = 'null';
        if (req.isAuthenticated && req.isAuthenticated()) {
            userState = JSON.stringify({
                id: req.user.id,
                username: req.user.username,
                displayName: req.user.display_name,
                avatar: req.user.avatar_url,
                role: req.user.role // Inject role for frontend checks
            });
        }
        modifiedHtml = modifiedHtml.replace('</head>', `<script>window.currentUser = ${userState};</script>\n</head>`);
        // 3. Analytics
        const analyticsPlaceholder = '';
        if (config.ANALYTICS_ENABLED) {
            modifiedHtml = modifiedHtml.replace(analyticsPlaceholder, ANALYTICS_SCRIPT);
        } else {
            modifiedHtml = modifiedHtml.replace(analyticsPlaceholder, ''); 
        }
        res.send(modifiedHtml);
    });
};
// Apply the dynamic SPA handler to all client routes
const clientRoutes = ['tree', 'chart', 'svg', 'map', 'mapper', 'history', 'publish', 'login', 'admin'];
clientRoutes.forEach(route => {
    mainRouter.get('/' + route, serveSPA);
    mainRouter.get('/' + route + '/', serveSPA);
});
// Protect SPA with Auth Middleware
app.use(authMiddleware);
// Hybrid Routing Strategy
app.use(basePath, mainRouter);
if (basePath !== '/') {
    logger.info(`✅ Enabling hybrid routing: listening on '${basePath}' AND '/' to support path-stripping proxies.`);
    app.use('/', mainRouter);
}
// Handle Reverse Proxy Trailing Slash logic + Default to /tree/
app.get('/', (req, res) => {
    if (req.isAuthenticated()) {
        const target = basePath === '/' ? '/tree/' : basePath + '/tree/';
        res.redirect(target);
    } else {
        // Serve login page logic (handled by SPA/Frontend later)
        serveSPA(req, res);
    }
});
// --- Server Start ---
server.listen(config.PORT, () => {
    logger.info(`✅ HTTP server started on http://localhost:${config.PORT}`);
});
server.timeout = 600000;
server.keepAliveTimeout = 600000;
server.headersTimeout = 600005;
// --- Graceful Shutdown Logic ---
async function gracefulShutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info("\n✅ Gracefully shutting down...");
    setTimeout(() => {
        logger.error("❌ Shutdown timed out. Forcing exit.");
        process.exit(1);
    }, 5000).unref();
    try {
        dataManager.stop();
        simulatorManager.getStatuses();
        await new Promise(resolve => wsManager.close(resolve));
        await new Promise((resolve) => {
            server.close(() => {
                logger.info("✅ HTTP Server closed.");
                resolve();
            });
        });
        activeConnections.forEach((conn) => {
            if (conn) conn.end(true); 
        });
        logger.info("✅ MQTT Connections closed.");
        await dataManager.close();
        logger.info("✅ Database closed.");
        logger.info("✅ Shutdown complete.");
        process.exit(0);
    } catch (err) {
        logger.error({ err }, "❌ Error during graceful shutdown.");
        process.exit(1);
    }
}
// --- Process Signal Handling ---
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('uncaughtException', (err) => {
    logger.fatal({ err }, "❌ FATAL: Uncaught Exception. Shutting down...");
    gracefulShutdown();
});
process.on('unhandledRejection', (reason, promise) => {
    logger.fatal({ err: reason }, "❌ FATAL: Unhandled Rejection. Shutting down...");
    gracefulShutdown();
});