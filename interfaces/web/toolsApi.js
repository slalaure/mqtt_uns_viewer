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
 * Tools API
 *
 * This router exposes helper functions specifically designed for external LLM agents
 * (like Prisme.ai, ChatGPT, etc.) to access project context via standard REST HTTP calls.
 * It replicates logic previously found only inside the MCP server only.
 * [UPDATED] Relocated to interfaces/mcp/ and updated relative paths.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = (logger) => {
    const router = express.Router();
    
    // [UPDATED] Paths adjusted for new location in /interfaces/mcp/
    const ROOT_PATH = path.join(__dirname, '..', '..');
    const DATA_PATH = path.join(ROOT_PATH, 'data');
    const MODEL_MANIFEST_PATH = path.join(DATA_PATH, 'uns_model.json');

    // Helper to load model
    const getUnsModel = () => {
        try {
            if (fs.existsSync(MODEL_MANIFEST_PATH)) {
                const data = fs.readFileSync(MODEL_MANIFEST_PATH, 'utf8');
                return JSON.parse(data);
            }
            return [];
        } catch (err) {
            logger.error({ err }, "Failed to load uns_model.json in Tools API");
            return [];
        }
    };

    /**
     * GET /api/tools/model/definitions
     * Concept: "Get UNS Model Definition"
     * Query Param: ?concept=workorder
     * Returns: Array of matching model definitions.
     */
    router.get('/model/definitions', (req, res) => {
        const concept = req.query.concept;
        const unsModel = getUnsModel();

        if (!concept) {
            // If no concept, return everything (or a summarized list)
            return res.json(unsModel);
        }

        const lowerConcept = concept.toLowerCase();
        const results = unsModel.filter(model => 
            model.concept.toLowerCase().includes(lowerConcept) ||
            (model.keywords && model.keywords.some(k => k.toLowerCase().includes(lowerConcept)))
        );

        res.json({ definitions: results });
    });

    /**
     * GET /api/tools/files/list
     * Concept: "List Project Files"
     * Returns: Lists of files in root and data directories.
     */
    router.get('/files/list', (req, res, next) => {
        try {
            // Filter for safe extensions to avoid exposing sensitive system files
            const safeExts = ['.js', '.mjs', '.json', '.md', '.svg'];
            
            const rootFiles = fs.readdirSync(ROOT_PATH)
                .filter(f => safeExts.includes(path.extname(f)));
            
            const dataFiles = fs.existsSync(DATA_PATH) 
                ? fs.readdirSync(DATA_PATH).filter(f => safeExts.includes(path.extname(f)))
                : [];

            res.json({ 
                root_files: rootFiles, 
                data_files: dataFiles.map(f => `data/${f}`) 
            });
        } catch (err) {
            next(err);
        }
    });

    /**
     * GET /api/tools/files/content
     * Concept: "Get File Content"
     * Query Param: ?filename=simulator-stark.js
     * Returns: Content of the file.
     */
    router.get('/files/content', (req, res, next) => {
        const filename = req.query.filename;

        if (!filename) {
            return res.status(400).json({ error: "Query parameter 'filename' is required." });
        }

        // Security: Prevent directory traversal
        const sanitizedPath = path.normalize(filename).replace(/^(\.\.[\/\\])+/, '');
        const fullPath = path.join(ROOT_PATH, sanitizedPath);

        // Security: Ensure it's within allowed directories
        if (!fullPath.startsWith(ROOT_PATH)) {
            return res.status(403).json({ error: "Access denied. Path traversal detected." });
        }

        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ error: "File not found." });
        }

        try {
            const content = fs.readFileSync(fullPath, 'utf8');
            res.json({ filename: sanitizedPath, content: content });
        } catch (err) {
            next(err);
        }
    });

    /**
     * POST /api/tools/files/save-data
     * Concept: "Save File to 'data' Directory"
     * Body: { "filename": "my_view.svg", "content": "<svg>...</svg>" }
     */
    router.post('/files/save-data', (req, res, next) => {
        const { filename, content } = req.body;

        if (!filename || !content) {
            return res.status(400).json({ error: "Missing 'filename' or 'content'." });
        }

        // Security: Enforce saving ONLY to DATA_PATH
        const sanitizedFilename = path.basename(filename); // Strips folders
        const targetPath = path.join(DATA_PATH, sanitizedFilename);

        try {
            fs.writeFileSync(targetPath, content, 'utf8');
            logger.info(`[ToolsAPI] Saved file to data/${sanitizedFilename}`);
            res.json({ success: true, path: `data/${sanitizedFilename}` });
        } catch (err) {
            next(err);
        }
    });

    return router;
};