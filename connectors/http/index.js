/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * HTTP Provider Plugin
 * Implements the BaseProvider interface for receiving data via HTTP POST.
 * Allows ingesting data into the UNS via a RESTful endpoint.
 */
const BaseProvider = require('../baseProvider');
const express = require('express');
const mqttMatch = require('mqtt-match');
const webhookManager = require('../../core/webhookManager');
const { v4: uuidv4 } = require('uuid');

class HttpProvider extends BaseProvider {
    constructor(config, context) {
        super(config, context);
        this.app = context.app;
        this.routeMounted = false;
        this.pathPrefix = config.pathPrefix || `/api/ingest/${this.id}`;
        
        // Define allowed topics from config
        this.allowedPublish = config.publish || ['#']; // For ingestion
        this.allowedSubscribe = config.subscribe || ['#']; // For webhooks
    }

    async connect() {
        if (!this.app) {
            this.logger.error("Express app not found in context. Cannot mount HTTP routes.");
            this.updateStatus('error', 'Express app missing');
            return false;
        }

        if (this.routeMounted) return true;

        this.logger.info(`Mounting HTTP routes for ${this.id}`);
        
        // --- 1. Ingestion Route (Pseudo-Publish) ---
        // Use a wildcard to capture the topic hierarchy
        this.app.post(`${this.pathPrefix}/*`, express.text({ type: '*/*' }), (req, res) => {
            if (!this.connected) return res.status(503).json({ error: "Provider disconnected" });

            try {
                // Extract and clean topic
                const fullPath = req.params[0];
                if (!fullPath) return res.status(400).json({ error: "Missing topic in path" });

                const topicParts = fullPath.split('/').filter(p => p.length > 0);
                const topic = topicParts.join('/');

                // Check Permissions (Publish = Ingestion for HTTP Provider)
                const isAllowed = this.allowedPublish.some(pattern => mqttMatch(pattern, topic));
                if (!isAllowed) {
                    return res.status(403).json({ error: `Publish (ingestion) forbidden for topic: ${topic}` });
                }

                // Handle Payload
                let payload = req.body;
                const contentType = req.headers['content-type'] || '';
                if (contentType.includes('application/json')) {
                    try { payload = JSON.parse(req.body); } catch (e) { this.logger.warn(`JSON parse fail for ${topic}`); }
                }

                // Forward to Central Engine
                this.handleIncomingMessage(topic, payload);
                res.status(200).json({ success: true, topic, provider: this.id });
            } catch (err) {
                this.logger.error({ err }, "Error handling HTTP ingestion");
                res.status(500).json({ error: "Internal Server Error" });
            }
        });

        // --- 2. Subscription Route (Webhook Registration) ---
        // POST /api/subscribe/my-http-provider
        this.app.post(`/api/subscribe/${this.id}`, express.json(), async (req, res) => {
            if (!this.connected) return res.status(503).json({ error: "Provider disconnected" });

            try {
                const { topic, url, method = 'POST', min_interval_ms = 1000 } = req.body;

                if (!topic || !url) {
                    return res.status(400).json({ error: "Missing topic or url" });
                }

                // Check Permissions (Subscribe = Webhook Registration)
                const isAllowed = this.allowedSubscribe.some(pattern => mqttMatch(pattern, topic));
                if (!isAllowed) {
                    return res.status(403).json({ error: `Subscription forbidden for topic pattern: ${topic}` });
                }

                const webhookId = `webhook-${uuidv4().slice(0, 8)}`;
                await webhookManager.addWebhook({
                    id: webhookId,
                    topic,
                    url,
                    method,
                    min_interval_ms
                });

                this.logger.info(`New webhook registered: ${webhookId} for topic ${topic} -> ${url}`);
                res.status(201).json({ success: true, id: webhookId, topic, url });

            } catch (err) {
                this.logger.error({ err }, "Error registering webhook");
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
        const err = new Error("HTTP Provider does not support outbound publishing via standard publish method. Use Webhooks.");
        this.logger.warn(err.message);
        if (callback) callback(err);
    }
}

module.exports = HttpProvider;