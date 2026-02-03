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
 * Chart API
 * Handles saving and loading of chart configurations.
 * Implements Layered Storage: Merges Global (Read-Only for users) and Private configs.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = (defaultConfigPath, logger) => {
    const router = express.Router();
    const DATA_ROOT = path.dirname(defaultConfigPath);
    const SESSIONS_DIR = path.join(DATA_ROOT, 'sessions');

    /**
     * Helper: Read a JSON file safely. Returns object with 'configurations' array.
     */
    function readChartFile(filePath) {
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                const json = JSON.parse(content);
                // Ensure valid structure
                if (!json.configurations) json.configurations = [];
                return json;
            }
        } catch (e) {
            logger.error({ err: e, path: filePath }, "Error reading chart file");
        }
        return { configurations: [] };
    }

    /**
     * Helper: Get User Private File Path
     */
    function getUserChartPath(req) {
        if (req.user && req.user.id) {
            const userDir = path.join(SESSIONS_DIR, req.user.id);
            if (!fs.existsSync(userDir)) {
                try { fs.mkdirSync(userDir, { recursive: true }); } catch (e) {}
            }
            return path.join(userDir, 'charts.json');
        }
        return null;
    }

    // --- GET Configuration (Merged) ---
    // [FIX] Route updated to /config to match frontend and tests
    router.get('/config', (req, res) => {
        // 1. Load Global Configs
        const globalData = readChartFile(defaultConfigPath);
        // Mark global items
        globalData.configurations.forEach(c => {
            c._isGlobal = true; // Flag for Frontend UI
            c.name = `[GLOBAL] ${c.name}`; // Visual cue
        });

        // 2. Load Private Configs (if user logged in)
        let privateData = { configurations: [] };
        const userPath = getUserChartPath(req);
        if (userPath) {
            privateData = readChartFile(userPath);
        }

        // 3. Merge: Private items appear after Global items
        // Note: We do NOT override Global items with Private ones here to prevent confusion.
        // Users must save as a new copy if they want to edit a global chart.
        const mergedConfigs = [
            ...globalData.configurations,
            ...privateData.configurations
        ];

        res.json({ configurations: mergedConfigs });
    });

    // --- SAVE Configuration (Partitioned) ---
    // [FIX] Route updated to /config to match frontend and tests
    router.post('/config', (req, res) => {
        const incomingConfig = req.body;
        if (!incomingConfig || !Array.isArray(incomingConfig.configurations)) {
            return res.status(400).json({ error: "Invalid configuration format" });
        }

        const isAdmin = req.user && req.user.role === 'admin';
        const userPath = getUserChartPath(req);

        // Load existing Global configs to check IDs
        const existingGlobal = readChartFile(defaultConfigPath);
        const globalIds = new Set(existingGlobal.configurations.map(c => c.id));

        // Lists to save
        const newGlobalList = [];
        const newPrivateList = [];

        // Distribute incoming configs
        incomingConfig.configurations.forEach(config => {
            // Remove the metadata flag before saving
            delete config._isGlobal;

            // Remove [GLOBAL] prefix if present (sanitize name)
            if (config.name.startsWith('[GLOBAL] ')) {
                config.name = config.name.replace('[GLOBAL] ', '');
            }

            if (globalIds.has(config.id)) {
                // It's an existing Global chart
                if (isAdmin) {
                    newGlobalList.push(config); // Admin updates Global
                } else {
                    // User cannot touch Global. 
                    // If they tried to edit it, the Frontend should have forced a new ID (Save As).
                    // If we receive a Global ID from a non-admin, we IGNORE the change to protect the global file,
                    // or strictly speaking, we just don't put it in the private file.
                    // Ideally, we keep it in global list (read-only persistence)
                }
            } else {
                // It's a New chart or an existing Private chart
                if (isAdmin) {
                    // Admin saves EVERYTHING to Global (Promote private to global)
                    newGlobalList.push(config);
                } else {
                    // User saves to Private
                    newPrivateList.push(config);
                }
            }
        });

        try {
            // 1. Admin Write: Update Global File
            if (isAdmin) {
                // Admin replaces the global list entirely with the current view
                fs.writeFileSync(defaultConfigPath, JSON.stringify({ configurations: newGlobalList }, null, 2));
                // Admin also clears their private file to avoid duplicates? 
                // Or keeps them? Let's clear private if Admin promotes everything.
                if (userPath) {
                    fs.writeFileSync(userPath, JSON.stringify({ configurations: [] }, null, 2));
                }
                logger.info(`✅ Admin updated Global Charts (${newGlobalList.length} items).`);
            } 
            // 2. User Write: Update Private File ONLY
            else if (userPath) {
                // User only saves what is NOT in the global set
                fs.writeFileSync(userPath, JSON.stringify({ configurations: newPrivateList }, null, 2));
                logger.info(`✅ User ${req.user.username} saved Private Charts (${newPrivateList.length} items).`);
            } else {
                return res.status(401).json({ error: "Guest cannot save charts." });
            }

            res.json({ success: true });
        } catch (err) {
            logger.error({ err }, "Error saving chart config");
            res.status(500).json({ error: "Failed to save configuration" });
        }
    });

    return router;
};