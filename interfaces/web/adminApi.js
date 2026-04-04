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
 * Admin API
 * Protected routes for User Management, System Maintenance, HMI Asset Management, Simulators, Data Parsers and System Logs.
 * [UPDATED] Corrected simulator paths to /data/simulators subfolder.
 * [UPDATED] Added /logs endpoint to fetch recent backend and frontend logs.
 */
const express = require('express');
const userManager = require('../../storage/userManager');
const dlqManager = require('../../storage/dlqManager');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const connectorManager = require('../../connectors/connectorManager');
const webhookManager = require('../../core/webhookManager');
const { exec } = require('child_process');

module.exports = (logger, db, dataManager, dataPath) => {
    const router = express.Router();
    const simulatorsPath = path.join(dataPath, 'simulators');

    // Ensure simulators directory exists
    if (!fs.existsSync(simulatorsPath)) {
        try { fs.mkdirSync(simulatorsPath, { recursive: true }); } catch (e) {}
    }

    // --- Multer Configuration for Imports (JSON) ---
    const storageJson = multer.diskStorage({
        destination: function (req, file, cb) {
            cb(null, dataPath);
        },
        filename: function (req, file, cb) {
            cb(null, `import_${Date.now()}_${path.basename(file.originalname)}`);
        }
    });

    const uploadJson = multer({ 
        storage: storageJson, 
        fileFilter: (req, file, cb) => {
            if (file.originalname.match(/\.json$/i)) {
                cb(null, true);
            } else {
                cb(new Error('Only JSON files are allowed!'), false);
            }
        }
    });

    // --- Multer Configuration for HMI Assets ---
    const storageHmi = multer.diskStorage({
        destination: function (req, file, cb) {
            cb(null, dataPath); 
        },
        filename: function (req, file, cb) {
            cb(null, path.basename(file.originalname)); 
        }
    });

    const uploadHmi = multer({ 
        storage: storageHmi, 
        fileFilter: (req, file, cb) => {
            if (file.originalname.match(/\.(svg|html|htm|js|gltf|glb|bin|png|jpg|jpeg)$/i)) {
                if (file.originalname.toLowerCase().startsWith('simulator-')) {
                    cb(new Error('Simulator files must be uploaded in the Simulators tab.'), false);
                } else {
                    cb(null, true);
                }
            } else {
                cb(new Error('Invalid HMI asset file type! Only svg, html, js, and 3d formats allowed.'), false);
            }
        }
    });

    // --- Multer Configuration for Simulators ---
    const storageSim = multer.diskStorage({
        destination: function (req, file, cb) {
            cb(null, simulatorsPath); 
        },
        filename: function (req, file, cb) {
            cb(null, path.basename(file.originalname));
        }
    });

    const uploadSimulator = multer({ 
        storage: storageSim, 
        fileFilter: (req, file, cb) => {
            if (file.originalname.match(/^simulator-.*\.js$/i)) {
                cb(null, true);
            } else {
                cb(new Error('Simulator files must be javascript files named simulator-*.js'), false);
            }
        }
    });

    // --- Multer Configuration for Data Parsers (CSV) ---
    const storageCsv = multer.diskStorage({
        destination: function (req, file, cb) {
            cb(null, dataPath);
        },
        filename: function (req, file, cb) {
            cb(null, `parser_${Date.now()}_${path.basename(file.originalname)}`);
        }
    });

    const uploadCsv = multer({ 
        storage: storageCsv, 
        fileFilter: (req, file, cb) => {
            if (file.originalname.match(/\.csv$/i)) {
                cb(null, true);
            } else {
                cb(new Error('Only CSV files are allowed!'), false);
            }
        }
    });

    // --- Admin Middleware ---
    const requireAdmin = (req, res, next) => {
        if (req.isAuthenticated() && req.user.role === 'admin') {
            return next();
        }
        logger.warn(`[AdminAPI] Unauthorized access attempt by user: ${req.user ? req.user.username : 'Guest'} IP: ${req.ip}`);
        return res.status(403).json({ error: "Forbidden: Admin privileges required." });
    };

    router.use(requireAdmin);

    // --- List All Users ---
    router.get('/users', async (req, res, next) => {
        try {
            const users = await userManager.getAllUsers();
            res.json(users);
        } catch (err) {
            next(err);
        }
    });

    // --- Delete User ---
    router.delete('/users/:id', async (req, res, next) => {
        const userIdToDelete = req.params.id;

        // Prevent self-deletion
        if (userIdToDelete === req.user.id) {
            return res.status(400).json({ error: "You cannot delete your own account while logged in." });
        }

        try {
            await userManager.deleteUser(userIdToDelete);
            logger.info(`[AdminAPI] User ${userIdToDelete} deleted by admin ${req.user.username}`);
            res.json({ success: true, message: "User and associated data deleted." });
        } catch (err) {
            next(err);
        }
    });

    // --- Database Maintenance ---

    router.post('/import-db', uploadJson.single('db_import'), async (req, res, next) => {
        if (!req.file) {
            return res.status(400).json({ error: 'No JSON file uploaded.' });
        }

        const filePath = req.file.path;
        logger.info(`[AdminAPI] Starting DB import from ${req.file.originalname}...`);

        try {
            const fileContent = fs.readFileSync(filePath, 'utf8');
            const entries = JSON.parse(fileContent);

            if (!Array.isArray(entries)) {
                throw new Error("Invalid JSON structure. Expected an array.");
            }

            if (!dataManager) {
                throw new Error("DataManager is not available.");
            }

            let count = 0;
            for (const entry of entries) {
                const message = {
                    sourceId: entry.sourceId || entry.source_id || 'default_connector',
                    timestamp: new Date(entry.timestamp || entry.timestampMs || Date.now()),
                    topic: entry.topic,
                    payloadStringForDb: typeof entry.payload === 'string' ? entry.payload : JSON.stringify(entry.payload),
                    isSparkplugOrigin: false,
                    needsDb: true
                };

                if (message.topic) {
                    dataManager.insertMessage(message);
                    count++;
                }
            }

            logger.info(`[AdminAPI] Queued ${count} messages for import.`);
            fs.unlinkSync(filePath); 
            res.json({ success: true, message: `Successfully queued ${count} entries for import.` });

        } catch (err) {
            try { if(fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(e) {}
            next(err);
        }
    });

    router.post('/reset-db', (req, res, next) => {
        if (!db) return res.status(503).json({ error: "Database not available." });
        logger.warn(`⚠️ [AdminAPI] Admin ${req.user.username} initiated full DB RESET.`);

        db.serialize(() => {
            db.run("DELETE FROM korelate_events;", (err) => {
                if (err) {
                    return next(err);
                }

                db.run("VACUUM;", (vacErr) => {
                    if (vacErr) logger.error({ err: vacErr }, "Failed to vacuum DB");
                    else logger.info("✅ Database truncated and vacuumed.");
                    res.json({ message: 'Database has been reset successfully.' });
                });
            });
        });
    });

    // --- DLQ Management ---

    router.get('/dlq/status', (req, res, next) => {
        try {
            const messages = dlqManager.getMessages();
            res.json({ count: messages.length });
        } catch (err) {
            next(err);
        }
    });

    router.post('/dlq/replay', async (req, res, next) => {
        try {
            const messages = dlqManager.getMessages();
            
            if (messages.length === 0) {
                return res.json({ success: true, message: "DLQ is empty, nothing to replay." });
            }

            logger.info(`[AdminAPI] Replaying ${messages.length} messages from DLQ...`);

            for (const msg of messages) {
                dataManager.insertMessage(msg);
            }

            dlqManager.clear();
            logger.info(`[AdminAPI] Successfully replayed ${messages.length} messages and cleared DLQ.`);
            res.json({ success: true, message: `Successfully replayed ${messages.length} messages.` });
        } catch (err) {
            next(err);
        }
    });

    router.post('/dlq/clear', (req, res, next) => {
        try {
            dlqManager.clear();
            logger.info("[AdminAPI] DLQ cleared by admin.");
            res.json({ success: true, message: "DLQ cleared successfully." });
        } catch (err) {
            next(err);
        }
    });

    // --- Alerts Maintenance Functions ---
    router.get('/admin/stats', async (req, res, next) => {
        // Handled by alertApi natively now, but keeping proxy route for safety
        res.status(501).json({ error: "Use /api/alerts/admin/stats instead" });
    });

    // --- HMI Assets Management ---

    router.get('/hmi-assets', (req, res, next) => {
        try {
            if (!fs.existsSync(dataPath)) return res.json([]);
            // Filter out simulator files
            const files = fs.readdirSync(dataPath).filter(f => f.match(/\.(svg|html|htm|js|gltf|glb|bin|png|jpg|jpeg)$/i) && !f.toLowerCase().startsWith('simulator-'));
            const fileStats = files.map(f => {
                const stat = fs.statSync(path.join(dataPath, f));
                return { name: f, size: stat.size, mtime: stat.mtime };
            });
            // Sort newest first
            fileStats.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
            res.json(fileStats);
        } catch (err) {
            next(err);
        }
    });

    router.post('/hmi-assets', uploadHmi.array('assets', 20), (req, res, next) => {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No valid files uploaded.' });
        }
        const fileNames = req.files.map(f => f.filename);
        logger.info(`[AdminAPI] HMI Assets uploaded: ${fileNames.join(', ')}`);
        res.json({ success: true, message: `Successfully uploaded ${req.files.length} assets.`, files: fileNames });
    });

    router.delete('/hmi-assets/:filename', (req, res, next) => {
        const filename = path.basename(req.params.filename);
        const filepath = path.join(dataPath, filename);

        try {
            if (fs.existsSync(filepath) && !filename.toLowerCase().startsWith('simulator-')) {
                fs.unlinkSync(filepath);
                logger.info(`[AdminAPI] HMI Asset deleted: ${filename}`);
                res.json({ success: true, message: `Asset '${filename}' deleted.` });
            } else {
                res.status(404).json({ error: "Asset not found." });
            }
        } catch (err) {
            next(err);
        }
    });

    // --- Simulators Management ---

    router.get('/simulators', (req, res, next) => {
        try {
            if (!fs.existsSync(simulatorsPath)) return res.json([]);
            // Scans the simulators subfolder
            const files = fs.readdirSync(simulatorsPath).filter(f => f.match(/^simulator-.*\.js$/i));
            const fileStats = files.map(f => {
                const stat = fs.statSync(path.join(simulatorsPath, f));
                return { name: f, size: stat.size, mtime: stat.mtime };
            });
            fileStats.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
            res.json(fileStats);
        } catch (err) {
            next(err);
        }
    });

    router.post('/simulators', uploadSimulator.array('assets', 20), (req, res, next) => {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No valid simulator files uploaded.' });
        }
        const fileNames = req.files.map(f => f.filename);
        logger.info(`[AdminAPI] Simulators uploaded: ${fileNames.join(', ')}`);
        res.json({ success: true, message: `Successfully uploaded ${req.files.length} simulators. Restart server to activate.`, files: fileNames });
    });

    router.delete('/simulators/:filename', (req, res, next) => {
        const filename = path.basename(req.params.filename);
        const filepath = path.join(simulatorsPath, filename); // Correctly points to simulators folder

        try {
            if (fs.existsSync(filepath) && filename.toLowerCase().startsWith('simulator-')) {
                fs.unlinkSync(filepath);
                logger.info(`[AdminAPI] Simulator deleted: ${filename}`);
                res.json({ success: true, message: `Simulator '${filename}' deleted.` });
            } else {
                res.status(404).json({ error: "Simulator not found." });
            }
        } catch (err) {
            next(err);
        }
    });

    // --- Data Parsers Management (CSV) ---
    router.post('/data-parsers/csv', uploadCsv.single('csv_file'), async (req, res, next) => {
        if (!req.file) {
            return res.status(400).json({ error: 'No CSV file uploaded.' });
        }

        const { defaultTopic, streamRateMs, loop } = req.body;
        const filePath = req.file.path;
        const providerId = `csv_parser_${Date.now()}`;

        logger.info(`[AdminAPI] Starting CSV parser: ${providerId} for file ${req.file.originalname}`);

        try {
            const providerConfig = {
                id: providerId,
                type: 'file',
                filePath: filePath,
                defaultTopic: defaultTopic || 'factory/csv/data',
                streamRateMs: parseInt(streamRateMs, 10) || 1000,
                loop: loop === 'true'
            };

            connectorManager.loadProvider(providerConfig);

            res.json({ 
                success: true, 
                message: "CSV Parser started successfully.",
                providerId: providerId
            });

        } catch (err) {
            try { if(fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(e) {}
            next(err);
        }
    });

    // --- Webhook Management ---

    router.get('/webhooks', async (req, res, next) => {
        try {
            const webhooks = await webhookManager.listAllWebhooks();
            res.json(webhooks);
        } catch (err) {
            next(err);
        }
    });

    router.post('/webhooks', async (req, res, next) => {
        try {
            const { topic, url, method, min_interval_ms } = req.body;
            const id = `webhook-${Date.now()}`;
            await webhookManager.addWebhook({ id, topic, url, method, min_interval_ms });
            res.json({ success: true, id });
        } catch (err) {
            next(err);
        }
    });

    router.delete('/webhooks/:id', async (req, res, next) => {
        try {
            await webhookManager.deleteWebhook(req.params.id);
            res.json({ success: true });
        } catch (err) {
            next(err);
        }
    });

    router.post('/webhooks/clear', async (req, res, next) => {
        try {
            await webhookManager.clearAllWebhooks();
            res.json({ success: true });
        } catch (err) {
            next(err);
        }
    });

    // --- System Logs ---
    router.get('/logs', (req, res, next) => {
        const logPath = path.join(dataPath, 'korelate.log');
        
        if (!fs.existsSync(logPath)) {
            return res.json({ 
                logs: `Log file not found at: ${logPath}\n\nTo enable this feature, configure your Pino logger in server.js or your container environment to persist logs to this file path.` 
            });
        }
        
        exec(`tail -n 500 "${logPath}"`, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
            if (error) {
                // Safe Fallback to native Node.js reading if tail is unavailable (e.g., Windows/certain Alpine builds)
                try {
                    const content = fs.readFileSync(logPath, 'utf8');
                    const lines = content.split('\n');
                    const last500 = lines.slice(-500).join('\n');
                    return res.json({ logs: last500 });
                } catch (fallbackErr) {
                    return next(fallbackErr);
                }
            }
            res.json({ logs: stdout });
        });
    });

    // --- API Key Management ---
    router.get("/api_keys", (req, res, next) => {
        db.all("SELECT id, api_key, name, scopes, created_at, last_used_at FROM api_keys", (err, rows) => {
            if (err) return next(err);
            // Mask the keys for preview
            const maskedRows = rows.map(r => {
                const preview = r.api_key.substring(0, 8) + "***";
                const { api_key, ...rest } = r;
                return { ...rest, api_key_preview: preview };
            });
            res.json(maskedRows);
        });
    });

    router.post("/api_keys", (req, res, next) => {
        const { name, scopes } = req.body;
        if (!name) return res.status(400).json({ error: "Name is required" });
        const crypto = require("crypto");
        const rawKey = "krl_" + crypto.randomBytes(32).toString("hex");
        const id = "key_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex");
        const scopesJson = JSON.stringify(scopes || []);
        db.run("INSERT INTO api_keys (id, api_key, name, scopes) VALUES (?, ?, ?, ?)", id, rawKey, name, scopesJson, (err) => {
            if (err) return next(err);
            res.json({ success: true, api_key: rawKey, message: "Save this key now! It will never be shown again." });
        });
    });

    router.delete("/api_keys/:id", (req, res, next) => {
        db.run("DELETE FROM api_keys WHERE id = ?", req.params.id, function(err) {
            if (err) return next(err);
            res.json({ success: true });
        });
    });
    return router;
};