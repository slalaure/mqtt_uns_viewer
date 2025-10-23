/**
 * @license MIT
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * API for managing Mappings Config (V2).
 */
const express = require('express');

module.exports = (mapperEngine) => {
    const router = express.Router();

    // GET /api/mapper/config
    // Retrieve the entire versioned config object
    router.get('/config', (req, res) => {
        try {
            const config = mapperEngine.getMappings();
            res.json(config);
        } catch (err) {
            res.status(500).json({ error: "Failed to get mappings config." });
        }
    });

    // POST /api/mapper/config
    // Save/update the entire versioned config object
    router.post('/config', (req, res) => {
        try {
            const newConfig = req.body;
            if (!newConfig || !Array.isArray(newConfig.versions) || !newConfig.activeVersionId) {
                return res.status(400).json({ error: "Invalid payload. Expected a valid config object." });
            }
            const result = mapperEngine.saveMappings(newConfig);
            if (result.success) {
                res.json({ status: "ok", message: `Saved config.` });
            } else {
                res.status(500).json({ error: result.error || "Failed to save config." });
            }
        } catch (err) {
            res.status(500).json({ error: "Server error while saving config." });
        }
    });

    // GET /api/mapper/metrics
    // Retrieve all current in-memory metrics
    router.get('/metrics', (req, res) => {
         try {
            const metrics = mapperEngine.getMetrics();
            res.json(metrics);
        } catch (err) {
            res.status(500).json({ error: "Failed to get metrics." });
        }
    });
    
    return router;
};