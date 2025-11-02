/**
 * @license MIT
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * API for managing Chart Configuration.
 */
const express = require('express');
const fs = require('fs');

module.exports = (chartConfigPath, logger) => {
    const router = express.Router();

    // Helper to get a default config object
    const getDefaultConfig = () => ({
        configurations: []
    });

    // Helper to read the config file
    const readChartConfig = () => {
        try {
            if (!fs.existsSync(chartConfigPath)) {
                fs.writeFileSync(chartConfigPath, JSON.stringify(getDefaultConfig(), null, 2));
                logger.info("Created missing charts.json on GET request.");
                return getDefaultConfig();
            }
            
            const fileContent = fs.readFileSync(chartConfigPath, 'utf8');
            const config = JSON.parse(fileContent);

            // [MODIFIED] Migration logic for old array-based format
            if (Array.isArray(config)) {
                logger.warn("Old array-based charts.json format detected. Migrating to new object format.");
                const newConfig = {
                    configurations: [
                        {
                            id: `chart_${Date.now()}`,
                            name: "Migrated Chart",
                            chartType: "line",
                            connectNulls: false,
                            variables: config // The old array is now the 'variables'
                        }
                    ]
                };
                fs.writeFileSync(chartConfigPath, JSON.stringify(newConfig, null, 2));
                logger.info("✅ Migration complete.");
                return newConfig;
            }

            if (config && Array.isArray(config.configurations)) {
                return config; // Valid new format
            }
            
            // File is corrupt or invalid format
            throw new Error("Invalid config structure. Expected { configurations: [...] }");

        } catch (err) {
            logger.error({ err }, "Failed to read or parse charts.json. Resetting to default.");
            fs.writeFileSync(chartConfigPath, JSON.stringify(getDefaultConfig(), null, 2));
            return getDefaultConfig();
        }
    };


    // GET /api/chart/config
    // [MODIFIED] Retrieve the entire config object
    router.get('/config', (req, res) => {
        try {
            const config = readChartConfig();
            res.json(config);
        } catch (err) {
            logger.error({ err }, "Failed to read charts.json");
            res.status(500).json({ error: "Failed to get chart config." });
        }
    });

    // POST /api/chart/config
    // [MODIFIED] Save/update the entire config object
    router.post('/config', (req, res) => {
        try {
            const newConfig = req.body;
            // [MODIFIED] Validate new structure
            if (!newConfig || !Array.isArray(newConfig.configurations)) {
                return res.status(400).json({ error: "Invalid payload. Expected an object with a 'configurations' array." });
            }
            
            fs.writeFileSync(chartConfigPath, JSON.stringify(newConfig, null, 2));
            logger.info("✅ Chart config saved.");
            res.json({ status: "ok", message: "Saved chart config." });

        } catch (err) {
            logger.error({ err }, "Failed to write charts.json");
            res.status(500).json({ error: "Server error while saving chart config." });
        }
    });
    
    return router;
};