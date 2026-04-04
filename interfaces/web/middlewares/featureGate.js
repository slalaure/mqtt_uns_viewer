/**
 * @license Apache License, Version 2.0 (the "License")
 * @author Sebastien Lalaurette
 *
 * Feature Gate Middleware
 * Blocks access to API endpoints if the corresponding feature is disabled in config.
 */

/**
 * Creates a middleware that checks if a specific feature is enabled.
 * @param {string} configKey - The key in the config object to check (e.g., 'VIEW_MAPPER_ENABLED').
 * @returns {Function} Express middleware.
 */
const featureGate = (config, configKey) => {
    return (req, res, next) => {
        if (config[configKey] === false) {
            return res.status(503).json({
                error: "Feature Disabled",
                message: `The '${configKey}' feature is currently disabled on this server.`,
                code: "FEATURE_DISABLED"
            });
        }
        next();
    };
};

module.exports = featureGate;
