/**
 * @license MIT
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * API for external (non-MQTT) application publishing via API Key.
 */
const express = require('express');
const mqttMatch = require('mqtt-match');

/**
 * Creates a router for the external publish API.
 * @param {function} getMainConnection - A function that returns the current main MQTT connection.
 * @param {pino.Logger} logger - The main pino logger.
 * @param {object} apiKeysConfig - The loaded configuration from api_keys.json.
 * @param {function} longReplacer - The JSON replacer for BigInt.
 * @returns {express.Router}
 */
module.exports = (getMainConnection, logger, apiKeysConfig, longReplacer) => {
    const router = express.Router();

    // --- API Key Authentication Middleware ---
    const apiKeyAuthMiddleware = (req, res, next) => {
        // Note: The global EXTERNAL_API_ENABLED check is done in server.js
        // This middleware assumes the API is enabled.

        let providedKey = null;
        const authHeader = req.headers['authorization'];
        const keyHeader = req.headers['x-api-key'];

        if (authHeader && authHeader.startsWith('Bearer ')) {
            providedKey = authHeader.substring(7);
        } else if (keyHeader) {
            providedKey = keyHeader;
        }

        if (!providedKey) {
            logger.warn(`[API_KEY_AUTH] Failed auth from ${req.ip}: Missing API key.`);
            return res.status(401).json({ error: "Unauthorized: Missing API key." });
        }

        const foundKey = apiKeysConfig.keys.find(k => k.key === providedKey);

        if (!foundKey) {
            logger.warn(`[API_KEY_AUTH] Failed auth from ${req.ip}: Invalid API key.`);
            return res.status(401).json({ error: "Unauthorized: Invalid API key." });
        }

        if (!foundKey.enabled) {
            logger.warn(`[API_KEY_AUTH] Failed auth from ${req.ip}: API key '${foundKey.name}' is disabled.`);
            return res.status(403).json({ error: "Forbidden: This API key is disabled." });
        }

        // Attach key config to request for use in the endpoint
        req.apiKeyConfig = foundKey;
        next();
    };


    // --- External Publish Endpoint ---
    router.post('/publish', apiKeyAuthMiddleware, (req, res) => {
        // At this point, the client is IP-authorized (by server.js) and API key is valid
        const mainConnection = getMainConnection(); // Get the connection at request time
        
        if (!mainConnection || !mainConnection.connected) {
            return res.status(503).json({ error: "MQTT client is not connected." });
        }

        const { topic, payload, qos = 0, retain = false } = req.body;
        const apiKeyConfig = req.apiKeyConfig;

        // 1. Validate input
        if (!topic || !payload) {
            return res.status(400).json({ error: "Missing required fields: 'topic' and 'payload'." });
        }
        const qosLevel = parseInt(qos, 10);
        if (isNaN(qosLevel) || qosLevel < 0 || qosLevel > 2) {
            return res.status(400).json({ error: "Invalid QoS. Must be 0, 1, or 2." });
        }
        const retainFlag = retain === true;

        // 2. Authorize Topic
        const allowedTopics = apiKeyConfig.permissions.allow || [];
        const isAllowed = allowedTopics.some(pattern => mqttMatch(pattern, topic));

        if (!isAllowed) {
            logger.warn(`[API_KEY_AUTH] Forbidden publish attempt from '${apiKeyConfig.name}' (IP: ${req.ip}) to topic: ${topic}`);
            return res.status(403).json({ error: "Forbidden: This API key is not authorized to publish to this topic." });
        }

        // 3. Determine Payload Format (string or buffer)
        let finalPayload;
        if (typeof payload === 'object') {
            // If client sent JSON, stringify it
            finalPayload = JSON.stringify(payload, longReplacer);
        } else {
            // Otherwise, send as-is (string)
            finalPayload = payload.toString();
        }
        
        // 4. Publish
        mainConnection.publish(topic, finalPayload, { qos: qosLevel, retain: retainFlag }, (err) => {
            if (err) {
                logger.error({ err, topic: topic, apiKey: apiKeyConfig.name }, "❌ Error processing external API publish:");
                return res.status(500).json({ error: `Failed to publish. ${err.message}` });
            }
            
            // Note: We don't log the payload content here for security/privacy.
            logger.info(`✅ [API_KEY_AUTH] Published via API from '${apiKeyConfig.name}' to '${topic}'`);
            res.status(200).json({ success: true, message: `Published to ${topic}` });
        });
    });
    
    return router;
};