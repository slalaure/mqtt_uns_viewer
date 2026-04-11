/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025-2026 Sebastien Lalaurette
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const multer = require('multer');
const { mergeConfigFromDb } = require('../../boot/config');

module.exports = (envPath, envExamplePath, dataPath, logger, db, dataManager, appConfig, connectorManager) => {
    const router = express.Router();
    const certsPath = path.join(dataPath, 'certs');
    const modelPath = path.join(dataPath, 'uns_model.json'); // Path to UNS Model

    // Ensure certs directory exists
    if (!fs.existsSync(certsPath)) {
        try {
            fs.mkdirSync(certsPath, { recursive: true });
        } catch (e) {
            logger.error({ err: e }, "Failed to create certs directory");
        }
    }

    // Configure Multer for file uploads (Certificates)
    const storageCerts = multer.diskStorage({
        destination: function (req, file, cb) {
            cb(null, certsPath);
        },
        filename: function (req, file, cb) {
            cb(null, path.basename(file.originalname));
        }
    });
    
    const fileFilterCerts = (req, file, cb) => {
        if (file.originalname.match(/\.(pem|crt|key|ca|cer|pfx|p12)$/)) {
            cb(null, true);
        } else {
            cb(new Error('Only certificate files are allowed!'), false);
        }
    };

    const uploadCerts = multer({ storage: storageCerts, fileFilter: fileFilterCerts });

    // Configure Multer for JSON imports (Model and History)
    const storageJson = multer.diskStorage({
        destination: function (req, file, cb) {
            cb(null, dataPath);
        },
        filename: function (req, file, cb) {
            cb(null, `import_${Date.now()}_${path.basename(file.originalname)}`);
        }
    });

    const fileFilterJson = (req, file, cb) => {
        if (file.originalname.match(/\.json$/i)) {
            cb(null, true);
        } else {
            cb(new Error('Only JSON files are allowed!'), false);
        }
    };

    const uploadJson = multer({ storage: storageJson, fileFilter: fileFilterJson });


    // --- Certificate Routes ---

    router.get('/certs', (req, res, next) => {
        try {
            if (!fs.existsSync(certsPath)) {
                return res.json([]);
            }
            const files = fs.readdirSync(certsPath);
            res.json(files);
        } catch (err) {
            next(err);
        }
    });

    router.post('/certs', uploadCerts.single('certificate'), (req, res) => {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded or invalid file type.' });
        }
        logger.info(`✅ Certificate uploaded: ${req.file.filename}`);
        res.json({ message: 'Certificate uploaded successfully', filename: req.file.filename });
    });

    // --- UNS Model Routes ---

    router.get('/model', (req, res, next) => {
        try {
            if (!fs.existsSync(modelPath)) {
                return res.json([]); 
            }
            const content = fs.readFileSync(modelPath, 'utf8');
            const json = JSON.parse(content);
            res.json(json);
        } catch (err) {
            next(err);
        }
    });

    router.post('/model', (req, res, next) => {
        try {
            const newModel = req.body;
            
            if (typeof newModel !== "object" || Array.isArray(newModel)) {
                return res.status(400).json({ error: "Invalid format. UNS Model must be a JSON Object." });
            }

            fs.writeFileSync(modelPath, JSON.stringify(newModel, null, 2), 'utf8');
            
            logger.info("✅ UNS Model (uns_model.json) updated via API.");
            res.json({ message: 'UNS Model saved successfully.' });
        } catch (err) {
            next(err);
        }
    });

    // --- Database Import Route ---
    
    router.post('/import-db', uploadJson.single('db_import'), async (req, res, next) => {
        if (!req.file) {
            return res.status(400).json({ error: 'No JSON file uploaded.' });
        }

        const filePath = req.file.path;
        logger.info(`[ImportDB] Starting import from ${req.file.originalname}...`);

        try {
            const fileContent = fs.readFileSync(filePath, 'utf8');
            const entries = JSON.parse(fileContent);

            if (!Array.isArray(entries)) {
                throw new Error("Invalid JSON structure. Expected an array of history entries.");
            }

            if (!dataManager) {
                throw new Error("DataManager is not available for import.");
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

            logger.info(`[ImportDB] Queued ${count} messages for insertion into active databases (DuckDB/TimescaleDB).`);
            
            fs.unlinkSync(filePath);

            res.json({ 
                success: true, 
                message: `Successfully queued ${count} entries for import. Data will appear shortly.` 
            });

        } catch (err) {
            try { if(fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(e) {}
            next(err);
        }
    });


    // --- Database-Backed Config Routes ---

    /**
     * Helper to get merged configuration (Env + DB).
     */
    async function getMergedConfig() {
        // 1. Start with values from .env
        if (!fs.existsSync(envPath)) return {};
        const envFileContent = fs.readFileSync(envPath, { encoding: 'utf8' });
        const config = dotenv.parse(envFileContent);

        // 2. Overwrite with values from DB
        return new Promise((resolve) => {
            db.all("SELECT key, value FROM app_config", (err, rows) => {
                if (!err && rows) {
                    rows.forEach(row => {
                        try {
                            config[row.key] = JSON.parse(row.value);
                        } catch (e) {
                            config[row.key] = row.value;
                        }
                    });
                }
                resolve(config);
            });
        });
    }

    router.get('/', async (req, res, next) => {
        try {
            const config = await getMergedConfig();
            res.json(config);
        } catch (err) {
            next(err);
        }
    });

    router.post('/', async (req, res, next) => {
        const newConfig = req.body;
        
        // List of keys that MUST stay in .env (immutable boot variables)
        const immutableKeys = ['PORT', 'SESSION_SECRET', 'BASE_PATH', 'DUCKDB_MAX_SIZE_MB'];
        
        const envUpdates = {};
        const dbUpdates = [];

        for (const [key, val] of Object.entries(newConfig)) {
            if (immutableKeys.includes(key)) {
                // Only mark for .env update if the value actually changed
                const currentVal = String(appConfig[key]);
                const newVal = String(val);
                if (currentVal !== newVal) {
                    envUpdates[key] = val;
                }
            } else {
                dbUpdates.push({ key, value: JSON.stringify(val) });
            }
        }

        try {
            let restartRequired = false;

            // 1. Update .env for immutable keys (if any)
            if (Object.keys(envUpdates).length > 0) {
                const tempPath = path.join(dataPath, '.env.tmp');
                let envFileContent = "";
                const exampleContent = fs.readFileSync(envExamplePath, { encoding: 'utf8' });

                exampleContent.split('\n').forEach(line => {
                    if (line.startsWith('#') || !line.trim()) {
                        envFileContent += line + '\n';
                    } else {
                        const firstEqual = line.indexOf('=');
                        if (firstEqual !== -1) {
                            const key = line.substring(0, firstEqual);
                            if (envUpdates.hasOwnProperty(key)) {
                                envFileContent += `${key}=${envUpdates[key]}\n`;
                            } else {
                                // Keep existing value for other keys in .env
                                envFileContent += line + '\n';
                            }
                        }
                    }
                });
                fs.writeFileSync(tempPath, envFileContent);
                fs.renameSync(tempPath, envPath);
                logger.info("✅ Updated immutable keys in .env");
                restartRequired = true; // Changes to .env always require a restart
            }

            // 2. Update DuckDB for dynamic keys
            if (dbUpdates.length > 0) {
                const stmt = db.prepare("INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, current_timestamp) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
                
                for (const update of dbUpdates) {
                    await new Promise((resolve, reject) => {
                        stmt.run(update.key, update.value, (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });
                }
                stmt.finalize();
                logger.info(`✅ Updated ${dbUpdates.length} dynamic keys in database.`);

                // Hot reload: Merge the new DB settings into the running appConfig object
                await mergeConfigFromDb(appConfig, db, logger);

                // If DATA_PROVIDERS were updated, trigger a refresh of the connector connections
                const hasProvidersUpdate = dbUpdates.some(u => u.key === 'DATA_PROVIDERS');
                if (hasProvidersUpdate) {
                    logger.info("📡 DATA_PROVIDERS change detected. Triggering hot-reload of connectors...");
                    if (connectorManager && typeof connectorManager.refreshProviders === 'function') {
                        try {
                            await connectorManager.refreshProviders();
                            logger.info("✅ Connectors hot-reload completed.");
                        } catch (reErr) {
                            logger.error({ err: reErr }, "❌ Failed to hot-reload connectors");
                        }
                    } else {
                        logger.warn("⚠️ Cannot hot-reload connectors: connectorManager not available or refreshProviders missing.");
                    }
                }
            }

            res.json({ 
                message: 'Configuration saved successfully.', 
                restartRequired: restartRequired 
            });
        } catch (err) {
            logger.error({ err }, "Failed to save configuration");
            next(err);
        }
    });

    router.post('/restart', (req, res) => {
        res.json({ message: 'Server is restarting...' });
        logger.info("Restart requested via API. Shutting down...");
        process.exit(0);
    });

    router.post('/reset-db', (req, res, next) => {
        if (!db) {
            return res.status(503).json({ error: "Database not connected/available." });
        }

        logger.warn("⚠️  User initiated full database reset (TRUNCATE).");

        db.serialize(() => {
            // Do NOT truncate app_config, only data
            db.run("DELETE FROM korelate_events;", (err) => {
                if (err) {
                    return next(err);
                }

                db.run("VACUUM;", (vacErr) => {
                    if (vacErr) {
                        logger.error({ err: vacErr }, "Failed to vacuum database after truncate");
                    } else {
                        logger.info("✅ Database truncated and vacuumed successfully.");
                    }
                    
                    res.json({ message: 'Database has been reset successfully.' });
                });
            });
        });
    });

    return router;
};