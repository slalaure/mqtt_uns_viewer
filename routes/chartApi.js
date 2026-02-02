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
 * Supports Global (default) and User-Scoped configurations.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = (defaultConfigPath, logger) => {
    const router = express.Router();
    
    // Determine the data root directory based on the passed default file path
    const DATA_ROOT = path.dirname(defaultConfigPath);

    /**
     * Helper: Get the correct chart config file path for the current request.
     * @param {object} req - Express request object
     * @returns {string} Path to charts.json
     */
    function getChartFilePath(req) {
        if (req.user && req.user.id) {
            // User Scoped: data/sessions/<userId>/charts.json
            const userDir = path.join(DATA_ROOT, 'sessions', req.user.id);
            if (!fs.existsSync(userDir)) {
                try {
                    fs.mkdirSync(userDir, { recursive: true });
                } catch (err) {
                    logger.error({ err }, `Failed to create user directory: ${userDir}`);
                    return defaultConfigPath; // Fallback
                }
            }
            return path.join(userDir, 'charts.json');
        }
        // Fallback / Guest: Global charts.json
        return defaultConfigPath;
    }

    // --- GET Configuration ---
    router.get('/', (req, res) => {
        const filePath = getChartFilePath(req);
        
        fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) {
                // If user file doesn't exist, try loading global default as a starting point? 
                // Or just return empty. Let's return empty structure.
                if (err.code === 'ENOENT') {
                    return res.json({ configurations: [] });
                }
                logger.error({ err }, "Error reading chart config");
                return res.status(500).json({ error: "Failed to read configuration" });
            }
            try {
                res.json(JSON.parse(data));
            } catch (parseErr) {
                logger.error({ err: parseErr }, "Error parsing chart config");
                res.status(500).json({ error: "Invalid configuration file" });
            }
        });
    });

    // --- SAVE Configuration ---
    router.post('/', (req, res) => {
        const config = req.body;
        if (!config || !config.configurations) {
            return res.status(400).json({ error: "Invalid configuration format" });
        }

        const filePath = getChartFilePath(req);

        fs.writeFile(filePath, JSON.stringify(config, null, 2), (err) => {
            if (err) {
                logger.error({ err }, "Error saving chart config");
                return res.status(500).json({ error: "Failed to save configuration" });
            }
            
            const context = req.user ? `User ${req.user.username}` : "Global";
            logger.info(`✅ Chart configuration saved (${context}).`);
            res.json({ success: true });
        });
    });

    return router;
};