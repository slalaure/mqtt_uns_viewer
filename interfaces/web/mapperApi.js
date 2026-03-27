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
 * Implements Layered Storage (Global vs Private) and Role-Based Access Control.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = (mapperEngine) => {
    const router = express.Router();
    
    const DATA_DIR = path.join(process.cwd(), 'data');
    const GLOBAL_VERSIONS_DIR = path.join(DATA_DIR, 'mapper_versions');
    const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

    // Ensure global versions directory exists
    if (!fs.existsSync(GLOBAL_VERSIONS_DIR)) {
        try { fs.mkdirSync(GLOBAL_VERSIONS_DIR, { recursive: true }); } catch (e) {}
    }

    /**
     * Helper: Get the Private directory for the current user.
     */
    function getUserVersionsDir(req) {
        if (req.user && req.user.id) {
            const userDir = path.join(SESSIONS_DIR, req.user.id, 'mapper_versions');
            if (!fs.existsSync(userDir)) {
                try { fs.mkdirSync(userDir, { recursive: true }); } catch (e) {}
            }
            return userDir;
        }
        return null;
    }

    /**
     * Helper: Resolve file path with priority (Private > Global).
     */
    function resolveVersionPath(name, req) {
        const safeName = path.basename(name); // Security sanitization
        const userDir = getUserVersionsDir(req);
        
        // 1. Try Private
        if (userDir) {
            const privatePath = path.join(userDir, `${safeName}.json`);
            if (fs.existsSync(privatePath)) return { path: privatePath, type: 'private' };
        }

        // 2. Try Global
        const globalPath = path.join(GLOBAL_VERSIONS_DIR, `${safeName}.json`);
        if (fs.existsSync(globalPath)) return { path: globalPath, type: 'global' };

        return null;
    }

    // --- Metrics (Global - Read Only) ---
    router.get('/metrics', (req, res) => {
        res.json(mapperEngine.getMetrics());
    });

    // --- Active Config (Read Only for everyone) ---
    router.get('/config', (req, res) => {
        res.json(mapperEngine.getConfig());
    });

    // --- Update Active Config (Live Deploy) ---
    // [SECURED] Only Admins can change the live running logic of the server
    router.post('/config', (req, res) => {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: "Forbidden: Only Administrators can deploy live mapping rules." });
        }
        try {
            mapperEngine.saveMappings(req.body); // Save to mappings.json and update memory
            res.json({ success: true, message: "Configuration deployed to Live Engine." });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // --- Saved Versions (Layered) ---
    
    // List versions (Merge Global + Private)
    router.get('/versions', (req, res) => {
        const versions = new Set();

        // 1. Add Global Versions
        if (fs.existsSync(GLOBAL_VERSIONS_DIR)) {
            fs.readdirSync(GLOBAL_VERSIONS_DIR).forEach(f => {
                if (f.endsWith('.json')) versions.add(f.replace('.json', ''));
            });
        }

        // 2. Add Private Versions (if logged in)
        const userDir = getUserVersionsDir(req);
        if (userDir && fs.existsSync(userDir)) {
            fs.readdirSync(userDir).forEach(f => {
                if (f.endsWith('.json')) versions.add(f.replace('.json', ''));
            });
        }

        res.json(Array.from(versions).sort());
    });

    // Save a version
    router.post('/version/:name', (req, res) => {
        const name = req.params.name;
        // Basic sanitization
        if (!name || name.includes('/') || name.includes('\\')) {
            return res.status(400).json({ error: "Invalid version name" });
        }

        const config = req.body;
        let targetDir = GLOBAL_VERSIONS_DIR;
        let contextMsg = "Global";

        // [LOGIC] Non-admins FORCE save to private
        if (!req.user || req.user.role !== 'admin') {
            targetDir = getUserVersionsDir(req);
            contextMsg = "Private";
            if (!targetDir) return res.status(401).json({ error: "Authentication required to save private versions." });
        }

        const filePath = path.join(targetDir, `${name}.json`);
        
        fs.writeFile(filePath, JSON.stringify(config, null, 2), (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: `Version saved (${contextMsg}).` });
        });
    });

    // Load a version (Priority: Private > Global)
    router.get('/version/:name', (req, res) => {
        const name = req.params.name;
        const resolved = resolveVersionPath(name, req);

        if (!resolved) {
            return res.status(404).json({ error: "Version not found" });
        }

        fs.readFile(resolved.path, 'utf8', (err, data) => {
            if (err) return res.status(500).json({ error: err.message });
            try {
                const json = JSON.parse(data);
                // Inject metadata so UI knows source
                json._metadata = { source: resolved.type }; 
                res.json(json);
            } catch (e) {
                res.status(500).json({ error: "Invalid file content" });
            }
        });
    });

    // Delete a version
    router.delete('/version/:name', (req, res) => {
        const name = req.params.name;
        const safeName = path.basename(name);
        
        // 1. Try to delete Private first (User ownership)
        const userDir = getUserVersionsDir(req);
        if (userDir) {
            const privatePath = path.join(userDir, `${safeName}.json`);
            if (fs.existsSync(privatePath)) {
                fs.unlinkSync(privatePath);
                return res.json({ success: true, message: "Private version deleted." });
            }
        }

        // 2. Try to delete Global (Admin only)
        if (req.user && req.user.role === 'admin') {
            const globalPath = path.join(GLOBAL_VERSIONS_DIR, `${safeName}.json`);
            if (fs.existsSync(globalPath)) {
                fs.unlinkSync(globalPath);
                return res.json({ success: true, message: "Global version deleted." });
            }
        } else {
            // Check if it exists globally to give correct error
            const globalPath = path.join(GLOBAL_VERSIONS_DIR, `${safeName}.json`);
            if (fs.existsSync(globalPath)) {
                return res.status(403).json({ error: "Forbidden: Only Admins can delete Global versions." });
            }
        }

        res.status(404).json({ error: "Version not found (or access denied)." });
    });

    return router;
};