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
 * Protected routes for User Management, System Maintenance, HMI Asset Management, Simulators and Parsers.
 */
const express = require('express');
const userManager = require('../database/userManager');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const providerManager = require('../data-providers/provider-manager'); // [NEW] Import Provider Manager

module.exports = (logger, db, dataManager, dataPath) => {
    const router = express.Router();

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
    const uploadSimulator = multer({ 
        storage: storageHmi, 
        fileFilter: (req, file, cb) => {
            if (file.originalname.match(/^simulator-.*\.js$/i)) {
                cb(null, true);
            } else {
                cb(new Error('Simulator files must be javascript files named simulator-*.js'), false);
            }
        }
    });

    // --- [NEW] Multer Configuration for Data Parsers (CSV) ---
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
    router.get('/users', async (req, res) => {
        try {
            const users = await userManager.getAllUsers();
            res.json(users);
        } catch (err) {
            logger.error({ err }, "Failed to list users");
            res.status(500).json({ error: "Internal Server Error" });
        }
    });

    // --- Delete User ---
    router.delete('/users/:id', async (req, res) => {
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
            logger.error({ err }, "Failed to delete user");
            res.status(500).json({ error: "Failed to delete user." });
        }
    });

    // --- Database Maintenance ---
    // POST /api/admin/import-db
    router.post('/import-db', uploadJson.single('db_import'), async (req, res) => {
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
                    brokerId: entry.brokerId || entry.broker_id || 'default_broker',
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
            fs.unlinkSync(filePath); // Cleanup temp file
            res.json({ success: true, message: `Successfully queued ${count} entries for import.` });
        } catch (err) {
            logger.error({ err }, "[AdminAPI] Import failed.");
            try { if(fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(e) {}
            res.status(500).json({ error: `Import failed: ${err.message}` });
        }
    });

    router.post('/reset-db', (req, res) => {
        if (!db) return res.status(503).json({ error: "Database not available." });
        logger.warn(`⚠️ [AdminAPI] Admin ${req.user.username} initiated full DB RESET.`);
        db.serialize(() => {
            db.run("DELETE FROM mqtt_events;", (err) => {
                if (err) {
                    logger.error({ err }, "Failed to truncate mqtt_events");
                    return res.status(500).json({ error: "Failed to clear database." });
                }
                db.run("VACUUM;", (vacErr) => {
                    if (vacErr) logger.error({ err: vacErr }, "Failed to vacuum DB");
                    else logger.info("✅ Database truncated and vacuumed.");
                    res.json({ message: 'Database has been reset successfully.' });
                });
            });
        });
    });

    // --- HMI Assets Management ---
    // GET /api/admin/hmi-assets
    router.get('/hmi-assets', (req, res) => {
        try {
            if (!fs.existsSync(dataPath)) return res.json([]);
            // Filter out simulator files
            const files = fs.readdirSync(dataPath).filter(f => f.match(/\.(svg|html|htm|js|gltf|glb|bin|png|jpg|jpeg)$/i) && !f.toLowerCase().startsWith('simulator-'));
            const fileStats = files.map(f => {
                const stat = fs.statSync(path.join(dataPath, f));
                return {
                    name: f,
                    size: stat.size,
                    mtime: stat.mtime
                };
            });
            // Sort newest first
            fileStats.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
            res.json(fileStats);
        } catch (err) {
            logger.error({ err }, "Failed to list HMI assets");
            res.status(500).json({ error: "Failed to list assets." });
        }
    });

    // POST /api/admin/hmi-assets
    router.post('/hmi-assets', uploadHmi.array('assets', 20), (req, res) => {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No valid files uploaded. Check allowed extensions.' });
        }
        const fileNames = req.files.map(f => f.filename);
        logger.info(`[AdminAPI] HMI Assets uploaded: ${fileNames.join(', ')}`);
        res.json({ success: true, message: `Successfully uploaded ${req.files.length} assets.`, files: fileNames });
    });

    // DELETE /api/admin/hmi-assets/:filename
    router.delete('/hmi-assets/:filename', (req, res) => {
        const filename = path.basename(req.params.filename); // Prevent path traversal
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
            logger.error({ err }, `Failed to delete HMI Asset: ${filename}`);
            res.status(500).json({ error: err.message });
        }
    });

    // --- [NEW] Simulators Management ---
    // GET /api/admin/simulators
    router.get('/simulators', (req, res) => {
        try {
            if (!fs.existsSync(dataPath)) return res.json([]);
            // Only return simulator-*.js files
            const files = fs.readdirSync(dataPath).filter(f => f.match(/^simulator-.*\.js$/i));
            const fileStats = files.map(f => {
                const stat = fs.statSync(path.join(dataPath, f));
                return {
                    name: f,
                    size: stat.size,
                    mtime: stat.mtime
                };
            });
            // Sort newest first
            fileStats.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
            res.json(fileStats);
        } catch (err) {
            logger.error({ err }, "Failed to list simulators");
            res.status(500).json({ error: "Failed to list simulators." });
        }
    });

    // POST /api/admin/simulators
    router.post('/simulators', uploadSimulator.array('assets', 20), (req, res) => {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No valid simulator files uploaded.' });
        }
        const fileNames = req.files.map(f => f.filename);
        logger.info(`[AdminAPI] Simulators uploaded: ${fileNames.join(', ')}`);
        res.json({ success: true, message: `Successfully uploaded ${req.files.length} simulators. Restart server to activate.`, files: fileNames });
    });

    // DELETE /api/admin/simulators/:filename
    router.delete('/simulators/:filename', (req, res) => {
        const filename = path.basename(req.params.filename); // Prevent path traversal
        const filepath = path.join(dataPath, filename);
        try {
            if (fs.existsSync(filepath) && filename.toLowerCase().startsWith('simulator-')) {
                fs.unlinkSync(filepath);
                logger.info(`[AdminAPI] Simulator deleted: ${filename}`);
                res.json({ success: true, message: `Simulator '${filename}' deleted.` });
            } else {
                res.status(404).json({ error: "Simulator not found." });
            }
        } catch (err) {
            logger.error({ err }, `Failed to delete Simulator: ${filename}`);
            res.status(500).json({ error: err.message });
        }
    });

    // --- [NEW] Data Parsers Management (CSV) ---
    router.post('/data-parsers/csv', uploadCsv.single('csv_file'), async (req, res) => {
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

            // Dynamically load and start the provider using the abstraction layer
            providerManager.loadProvider(providerConfig);

            res.json({ 
                success: true, 
                message: "CSV Parser started successfully.",
                providerId: providerId
            });
        } catch (err) {
            logger.error({ err }, "[AdminAPI] Failed to start CSV Parser.");
            try { if(fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(e) {}
            res.status(500).json({ error: `Failed to start parser: ${err.message}` });
        }
    });

    return router;
};