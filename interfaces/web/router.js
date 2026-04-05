/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025-2026 Sebastien Lalaurette
 *
 * Main Application Router
 *
 * Aggregates all API and View routes, separating them from the server entry point.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const spBv10Codec = require('sparkplug-payload').get("spBv1.0");
const featureGate = require('./middlewares/featureGate');
const metricsManager = require('../../core/metricsManager');

/**
 * Configures and returns the main application router.
 */
function createRouter(deps) {
    const {
        config,
        logger,
        db,
        dataManager,
        DATA_PATH,
        SESSIONS_PATH,
        basePath,
        userManager,
        alertManager,
        semanticManager,
        i3xEvents,
        getPrimaryConnection,
        getConnectorConnection,
        simulatorManager,
        wsManager,
        mapperEngine,
        ENV_PATH,
        ENV_EXAMPLE_PATH,
        CHART_CONFIG_PATH,
        
        longReplacer,
        auth,
        ANALYTICS_SCRIPT
    } = deps;

    const router = express.Router();
    router.use(express.json({ limit: '50mb' }));

    // --- Helper Middleware for IP Filtering ---
    let ALLOWED_IPS = config.API_ALLOWED_IPS ? config.API_ALLOWED_IPS.split(',').map(ip => ip.trim()) : [];
    const ipFilterMiddleware = (req, res, next) => {
        if (ALLOWED_IPS.length === 0 || ALLOWED_IPS.includes(req.ip)) return next();
        res.status(403).json({ error: `Access denied for IP ${req.ip}` });
    };

    /**
     * Helper to resolve the correct physical path for an HMI or Simulator asset.
     */
    function resolveHmiPath(filename, req) {
        const isSimulator = filename.toLowerCase().startsWith('simulator-');
        if (isSimulator) {
            return path.join(DATA_PATH, 'simulators', filename);
        }
        const globalPath = path.join(DATA_PATH, filename);
        if (req.user && req.user.id) {
            const userHmiDir = path.join(SESSIONS_PATH, req.user.id, 'hmis');
            const userPath = path.join(userHmiDir, filename);
            if (fs.existsSync(userPath)) {
                return userPath;
            }
        }
        return globalPath;
    }

    /**
     * Helper to serve the SPA (Single Page Application) with injected state.
     */
    const serveSPA = (req, res, next) => {
        const indexPath = path.join(__dirname, '../../public', 'index.html');
        fs.readFile(indexPath, 'utf8', (err, data) => {
            if (err) {
                logger.error({ err }, "Failed to read index.html");
                return next(err);
            }
            const safeBasePath = basePath.endsWith('/') ? basePath : basePath + '/';
            let modifiedHtml = data;
            
            // 1. Inject Base Path
            modifiedHtml = modifiedHtml.replace('<head>', `<head>\n    <base href="${safeBasePath}">`);
            
            // 2. Inject Current User State
            let userState = 'null';
            if (req.isAuthenticated && req.isAuthenticated()) {
                userState = JSON.stringify({
                    id: req.user.id,
                    username: req.user.username,
                    displayName: req.user.display_name,
                    avatar: req.user.avatar_url,
                    role: req.user.role 
                });
            }
            const stateScript = `<script>window.currentUser = ${userState};</script>`;
            
            // 3. Inject Analytics if enabled
            let headEndInjection = stateScript + '\n';
            if (config.ANALYTICS_ENABLED) {
                headEndInjection += ANALYTICS_SCRIPT + '\n';
            }
            
            modifiedHtml = modifiedHtml.replace('</head>', headEndInjection + '</head>');
            
            res.send(modifiedHtml);
        });
    };

    // --- Auth Routes ---
    router.use('/auth', require('./authApi')(logger)); 

    // --- Admin Routes ---
    router.use('/api/admin', auth.requireAdmin, require('./adminApi')(logger, db, dataManager, DATA_PATH)); 
    router.use('/api/admin/ai_history', auth.requireAdmin, require('./aiHistoryApi')());

    // --- Alert API Routes ---
    router.use('/api/alerts', featureGate(config, 'VIEW_ALERTS_ENABLED'), ipFilterMiddleware, require('./alertApi')(logger, auth)); 

    // --- [NEW] I3X API Standard Routes ---
    router.use('/api/i3x', featureGate(config, 'VIEW_TREE_ENABLED'), ipFilterMiddleware, require('../i3x/i3xRouter')(db, semanticManager, logger, i3xEvents, auth)); 
    // --- [NEW] Frontend Error Logs ---
    router.post('/api/logs/frontend', ipFilterMiddleware, (req, res) => {
        logger.error({ frontend: req.body }, `[Frontend Error] ${req.body.type}: ${req.body.message}`);
        res.status(200).json({ success: true });
    });

    // --- [NEW] Metrics API ---
    router.get('/api/metrics', ipFilterMiddleware, (req, res) => {
        const metrics = metricsManager.getPrometheusMetrics();
        res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.send(metrics);
    });

    // --- API Routes for HMI ---
    router.get('/api/hmi/file', featureGate(config, 'VIEW_HMI_ENABLED'), (req, res) => {
        const filename = path.basename(req.query.name || '');
        if (!filename.match(/\.(svg|html|htm|js|gltf|glb|bin|png|jpg|jpeg)$/i)) return res.status(400).send('Invalid file type');
        const filePath = resolveHmiPath(filename, req);
        if (fs.existsSync(filePath)) {
            if (filename.endsWith('.glb')) res.setHeader('Content-Type', 'model/gltf-binary');
            if (filename.endsWith('.gltf')) res.setHeader('Content-Type', 'model/gltf+json');
            if (filename.endsWith('.bin')) res.setHeader('Content-Type', 'application/octet-stream');
            res.sendFile(filePath);
        } else {
            res.status(404).send('Not found');
        }
    });

    router.get('/api/hmi/list', featureGate(config, 'VIEW_HMI_ENABLED'), (req, res, next) => {
        try {
            let files = new Set();
            if (fs.existsSync(DATA_PATH)) {
                fs.readdirSync(DATA_PATH).forEach(f => {
                    if (f.match(/\.(svg|html|htm)$/i)) files.add(f);
                });
            }
            if (req.user && req.user.id) {
                const userHmiDir = path.join(SESSIONS_PATH, req.user.id, 'hmis');
                if (fs.existsSync(userHmiDir)) {
                    fs.readdirSync(userHmiDir).forEach(f => {
                        if (f.match(/\.(svg|html|htm)$/i)) files.add(f);
                    });
                }
            }
            res.json(Array.from(files).sort());
        } catch (err) {
            next(err);
        }
    });

    router.get('/api/hmi/bindings.js', featureGate(config, 'VIEW_HMI_ENABLED'), (req, res) => {
        const filename = path.basename(req.query.name || '');
        const filePath = resolveHmiPath(filename, req);
        res.setHeader('Content-Type', 'application/javascript');
        if (fs.existsSync(filePath)) {
            res.sendFile(filePath);
        } else {
            res.send('// No bindings');
        }
    });

    router.delete('/api/hmi/file', featureGate(config, 'VIEW_HMI_ENABLED'), (req, res, next) => {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });
        const filename = path.basename(req.query.name || '');
        if (!filename.match(/\.(svg|html|htm|js|gltf|glb|bin|png|jpg|jpeg)$/i)) return res.status(400).send('Invalid file type');
        const isSimulator = filename.toLowerCase().startsWith('simulator-');
        const globalPath = path.join(DATA_PATH, isSimulator ? 'simulators' : '', filename);
        let targetPath = null;
        let isPrivate = false;
        if (req.user && req.user.id && !isSimulator) {
            const userHmiDir = path.join(SESSIONS_PATH, req.user.id, 'hmis');
            const userPath = path.join(userHmiDir, filename);
            if (fs.existsSync(userPath)) { targetPath = userPath; isPrivate = true; }
        }
        if (!targetPath && fs.existsSync(globalPath)) {
            targetPath = globalPath;
            isPrivate = false;
        }
        if (!targetPath) return res.status(404).json({ error: "File not found" });
        if (!isPrivate && req.user.role !== 'admin') {
            return res.status(403).json({ error: "Forbidden: Only Admins can delete Global HMI views or Simulators." });
        }
        try {
            fs.unlinkSync(targetPath);
            logger.info(`Deleted Asset: ${targetPath}`);
            const jsPath = targetPath + ".js";
            if (fs.existsSync(jsPath)) {
                fs.unlinkSync(jsPath);
                logger.info(`Deleted Asset JS: ${jsPath}`);
            }
            res.json({ success: true, message: "Asset deleted successfully." });
        } catch (err) {
            next(err);
        }
    });

    router.get('/api/svg/file', (req, res) => { res.redirect(3.1, req.originalUrl.replace('/api/svg', '/api/hmi')); });
    router.get('/api/svg/list', (req, res) => { res.redirect(3.1, req.originalUrl.replace('/api/svg', '/api/hmi')); });
    router.get('/api/svg/bindings.js', (req, res) => { res.redirect(3.1, req.originalUrl.replace('/api/svg', '/api/hmi')); });

    router.get('/api/config', (req, res) => {
        res.json({
            isSimulatorEnabled: config.IS_SIMULATOR_ENABLED,
            brokerConfigs: config.DATA_PROVIDERS.map(b => ({ id: b.id, host: b.host, port: b.port, subscribe: b.subscribe, publish: b.publish, type: b.type || 'mqtt' })),
            dataProviders: config.DATA_PROVIDERS.map(p => ({ id: p.id, type: p.type, subscribe: p.subscribe, publish: p.publish })),
            isMultiBroker: (config.DATA_PROVIDERS || []).length > 1,
            viewTreeEnabled: config.VIEW_TREE_ENABLED,
            viewHmiEnabled: config.VIEW_HMI_ENABLED,
            viewHistoryEnabled: config.VIEW_HISTORY_ENABLED,
            viewModelerEnabled: config.VIEW_MODELER_ENABLED, 
            viewMapperEnabled: config.VIEW_MAPPER_ENABLED,
            viewChartEnabled: config.VIEW_CHART_ENABLED,
            viewPublishEnabled: config.VIEW_PUBLISH_ENABLED,
            viewChatEnabled: config.VIEW_CHAT_ENABLED,
            viewAlertsEnabled: config.VIEW_ALERTS_ENABLED, 
            basePath: basePath,
            viewConfigEnabled: config.VIEW_CONFIG_ENABLED,
            maxSavedChartConfigs: config.MAX_SAVED_CHART_CONFIGS,
            maxSavedMapperVersions: config.MAX_SAVED_MAPPER_VERSIONS,
            hmiFilePath: config.HMI_FILE_PATH 
        });
    });

    if (config.IS_SIMULATOR_ENABLED) {
        router.get('/api/simulator/status', (req, res) => {
            res.json({ statuses: simulatorManager.getStatuses() });
        });
        router.post('/api/simulator/start/:name', auth.requireAdmin, (req, res) => {
            const r = simulatorManager.startSimulator(req.params.name);
            wsManager.broadcast(JSON.stringify({ type: 'simulator-status', statuses: simulatorManager.getStatuses() }));
            res.json(r);
        });
        router.post('/api/simulator/stop/:name', auth.requireAdmin, (req, res) => {
            const r = simulatorManager.stopSimulator(req.params.name);
            wsManager.broadcast(JSON.stringify({ type: 'simulator-status', statuses: simulatorManager.getStatuses() }));
            res.json(r);
        });
    }

    router.use('/api/context', (req, res, next) => {
        if (!db) return res.status(503).json({ error: "DB not ready" });
        const dbManager = require('../../storage/dbManager')(db, deps.dbFile, deps.dbWalFile, wsManager.broadcast, logger, config.DUCKDB_MAX_SIZE_MB, config.DUCKDB_PRUNE_CHUNK_SIZE, deps.getIsPruning, deps.setIsPruning); 
        require('./contextApi')(db, getPrimaryConnection, simulatorManager.getStatuses, dbManager.getDbStatus, config)(req, res, next); 
    });

    router.use('/api/tools', ipFilterMiddleware, require('./toolsApi')(logger));
    
    if (config.VIEW_CHAT_ENABLED) {
        router.use('/api/chat', ipFilterMiddleware, require('./chatApi')(db, logger, config, getConnectorConnection, simulatorManager, wsManager, mapperEngine));
    }
    
    if (config.VIEW_CONFIG_ENABLED) {
        router.use('/api/env', ipFilterMiddleware, auth.requireAdmin, require('./configApi')(ENV_PATH, ENV_EXAMPLE_PATH, DATA_PATH, logger, db, dataManager, config, deps.connectorManager)); 
    }
    
    router.use('/api/mapper', featureGate(config, 'VIEW_MAPPER_ENABLED'), ipFilterMiddleware, require('./mapperApi')(mapperEngine, config, auth)); 
    router.use('/api/chart', featureGate(config, 'VIEW_CHART_ENABLED'), ipFilterMiddleware, require('./chartApi')(CHART_CONFIG_PATH, logger)); 

    router.post('/api/publish/message', featureGate(config, 'VIEW_PUBLISH_ENABLED'), ipFilterMiddleware, auth.requireRole('operator'), (req, res, next) => {
        const { topic, payload, format, qos, retain, sourceId } = req.body;
        const conn = getConnectorConnection(sourceId);
        if (!conn || !conn.connected) return res.status(503).json({ error: "Provider not connected" });
        let finalPayload = payload;
        if (format === 'json' || typeof payload === 'object') {
            try { finalPayload = JSON.stringify(typeof payload === 'string' ? JSON.parse(payload) : payload); } catch(e) {}
        } else if (format === 'sparkplugb') {
            try { finalPayload = spBv10Codec.encodePayload(JSON.parse(payload)); } catch(e) { return res.status(400).json({ error: e.message }); }
        }
        conn.publish(topic, finalPayload, { qos: parseInt(qos)||0, retain: !!retain }, (err) => {
            if (err) return next(err);
            res.json({ success: true });
        });
    });

    if (deps.config.EXTERNAL_API_ENABLED) {
        router.use('/api/external', ipFilterMiddleware, require('./externalApi')(getPrimaryConnection, logger, db, longReplacer)); 
    }

    if (config.VIEW_CONFIG_ENABLED) {
        router.get('/config.html', auth.requireAdmin);
        router.get('/config.js', auth.requireAdmin);
    } else {
        router.get('/config.html', (req, res) => res.status(403).send('Disabled'));
        router.get('/config.js', (req, res) => res.status(403).send('Disabled'));
    }

    // --- Static Files ---
    router.use(express.static(path.join(__dirname, '../../public'), { redirect: false, index: false }));

    // --- SPA Client Routes ---
    const clientRoutes = ['tree', 'chart', 'hmi', 'mapper', 'history', 'publish', 'login', 'admin', 'alerts', 'modeler'];
    clientRoutes.forEach(route => {
        router.get('/' + route, serveSPA);
        router.get('/' + route + '/', serveSPA);
    });

    // --- Centralized Error Handling ---
    const errorHandler = require('./middlewares/errorHandler')(logger);
    router.use(errorHandler);

    return router;
}

module.exports = {
    createRouter
};
