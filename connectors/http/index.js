/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * HTTP Provider Plugin
 * Implements the BaseProvider interface for receiving data via HTTP POST.
 * Allows ingesting data into the UNS via a RESTful endpoint.
 */
const BaseProvider = require('../base-provider');
const express = require('express');

class HttpProvider extends BaseProvider {
    constructor(config, context) {
        super(config, context);
        this.app = context.app;
        this.routeMounted = false;
        this.pathPrefix = config.pathPrefix || `/api/ingest/${this.id}`;
    }

    async connect() {
        if (!this.app) {
            this.logger.error("Express app not found in context. Cannot mount HTTP routes.");
            this.updateStatus('error', 'Express app missing');
            return false;
        }

        if (this.routeMounted) return true;

        this.logger.info(`Mounting HTTP ingestion route at POST ${this.pathPrefix}/*`);
        
        // Use a wildcard to capture the topic hierarchy
        // Example: POST /api/ingest/my-http-provider/factory/line1/temp
        this.app.post(`${this.pathPrefix}/*`, express.text({ type: '*/*' }), (req, res) => {
            try {
                // 1. Extract topic from wildcard path
                const fullPath = req.params[0]; // capture the '*' part
                if (!fullPath) {
                    return res.status(400).json({ error: "Missing topic in path" });
                }

                // 2. Clean and validate topic depth (max 10 levels)
                const topicParts = fullPath.split('/').filter(p => p.length > 0);
                if (topicParts.length > 10) {
                    return res.status(400).json({ error: "Topic depth exceeds limit of 10" });
                }
                const topic = topicParts.join('/');

                // 3. Handle Payload
                let payload = req.body;
                let options = {};

                // Basic content-type detection
                const contentType = req.headers['content-type'] || '';
                if (contentType.includes('application/json')) {
                    try {
                        payload = JSON.parse(req.body);
                    } catch (e) {
                        // If parsing fails, keep it as raw string
                        this.logger.warn(`Failed to parse JSON body for topic ${topic}`);
                    }
                }
                // Note: XML parsing would require a library like xml2js. 
                // For now, we pass it as a string, and the central dispatcher 
                // will wrap it in a { raw_payload: ... } object if it's not JSON.

                // 4. Forward to Central Engine
                this.handleIncomingMessage(topic, payload);

                res.status(200).json({ success: true, topic, provider: this.id });
            } catch (err) {
                this.logger.error({ err }, "Error handling HTTP ingestion");
                res.status(500).json({ error: "Internal Server Error" });
            }
        });

        this.routeMounted = true;
        this.connected = true;
        this.updateStatus('connected');
        return true;
    }

    async disconnect() {
        // Express routes cannot be easily unmounted at runtime.
        // We just mark as disconnected.
        this.connected = false;
        this.updateStatus('disconnected');
    }

    publish(topic, payload, options, callback) {
        // HTTP Provider is primarily for ingestion (Southbound -> Northbound).
        // Sending data back to the HTTP source (Northbound -> Southbound) 
        // is not supported in this simple implementation.
        const err = new Error("HTTP Provider does not support outbound publishing");
        this.logger.warn(err.message);
        if (callback) callback(err);
    }
}

module.exports = HttpProvider;