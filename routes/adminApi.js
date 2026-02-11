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
 * Protected routes for User Management and System Maintenance.
 * [UPDATED] Added Database Maintenance routes (Import/Reset).
 */
const express = require('express');
const userManager = require('../database/userManager');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

module.exports = (logger, db, dataManager, dataPath) => {
    const router = express.Router();

    // --- Multer Configuration for Imports ---
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

    // POST /api/admin/reset-db
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

    return router;
};