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
 * Mapper API
 * Handles metrics, live config updates, and saved versions.
 * Implements User-Scoped storage for Saved Versions.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = (mapperEngine) => {
    const router = express.Router();
    
    // We assume the mapper engine runs from the root or has access to data.
    // We'll resolve the Data path relative to the process CWD for now, 
    // or we can safely assume ./data exists based on server.js logic.
    const DATA_DIR = path.join(process.cwd(), 'data');
    const GLOBAL_VERSIONS_DIR = path.join(DATA_DIR, 'mapper_versions');

    // Ensure global versions directory exists
    if (!fs.existsSync(GLOBAL_VERSIONS_DIR)) {
        try { fs.mkdirSync(GLOBAL_VERSIONS_DIR, { recursive: true }); } catch (e) {}
    }

    /**
     * Helper: Get the directory for storing mapper versions.
     * @param {object} req 
     * @returns {string} Path to directory
     */
    function getVersionsDir(req) {
        if (req.user && req.user.id) {
            const userDir = path.join(DATA_DIR, 'sessions', req.user.id, 'mapper_versions');
            if (!fs.existsSync(userDir)) {
                try { fs.mkdirSync(userDir, { recursive: true }); } catch (e) {}
            }
            return userDir;
        }
        return GLOBAL_VERSIONS_DIR;
    }

    // --- Metrics (Global) ---
    router.get('/metrics', (req, res) => {
        res.json(mapperEngine.getMetrics());
    });

    // --- Active Config (Global) ---
    // Returns the currently running configuration in memory
    router.get('/config', (req, res) => {
        res.json(mapperEngine.getConfig());
    });

    // --- Update Active Config (Global) ---
    // Applies a new configuration to the live engine
    router.post('/config', (req, res) => {
        try {
            mapperEngine.setConfig(req.body);
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // --- Saved Versions (User Scoped) ---

    // List saved versions
    router.get('/versions', (req, res) => {
        const dir = getVersionsDir(req);
        fs.readdir(dir, (err, files) => {
            if (err) {
                return res.status(500).json({ error: "Failed to list versions" });
            }
            // Filter only JSON files and remove extension
            const versions = files
                .filter(f => f.endsWith('.json'))
                .map(f => f.replace('.json', ''));
            res.json(versions);
        });
    });

    // Save a version
    router.post('/version/:name', (req, res) => {
        const name = req.params.name;
        // Basic sanitization
        if (!name || name.includes('/') || name.includes('\\')) {
            return res.status(400).json({ error: "Invalid version name" });
        }

        const dir = getVersionsDir(req);
        const filePath = path.join(dir, `${name}.json`);
        const config = req.body;

        fs.writeFile(filePath, JSON.stringify(config, null, 2), (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });

    // Load a version (Returns JSON, client must then POST to /config to apply it)
    router.get('/version/:name', (req, res) => {
        const name = req.params.name;
        const dir = getVersionsDir(req);
        const filePath = path.join(dir, `${name}.json`);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: "Version not found" });
        }

        fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                res.json(JSON.parse(data));
            } catch (e) {
                res.status(500).json({ error: "Invalid file content" });
            }
        });
    });

    // Delete a version
    router.delete('/version/:name', (req, res) => {
        const name = req.params.name;
        const dir = getVersionsDir(req);
        const filePath = path.join(dir, `${name}.json`);

        if (fs.existsSync(filePath)) {
            fs.unlink(filePath, (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true });
            });
        } else {
            res.status(404).json({ error: "Version not found" });
        }
    });

    return router;
};