/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Webhook Manager
 * Manages webhook subscriptions and execution with anti-flood protection.
 */
const mqttMatch = require('mqtt-match');
const axios = require('axios');

class WebhookManager {
    constructor() {
        this.db = null;
        this.logger = null;
        this.webhooks = [];
        this.lastTriggered = new Map(); // id -> timestamp
    }

    init(db, logger) {
        this.db = db;
        this.logger = logger.child({ component: 'WebhookManager' });

        // Ensure table exists before loading
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS webhooks (
                id VARCHAR PRIMARY KEY,
                topic VARCHAR,
                url VARCHAR,
                method VARCHAR DEFAULT 'POST',
                last_triggered TIMESTAMPTZ,
                min_interval_ms INTEGER DEFAULT 1000,
                active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `, (err) => {
            if (err) {
                this.logger.error({ err }, "Failed to ensure webhooks table exists");
                return;
            }
            this.loadWebhooks();
        });
    }

    async loadWebhooks() {
        return new Promise((resolve, reject) => {
            this.db.all("SELECT * FROM webhooks WHERE active = true", (err, rows) => {
                if (err) {
                    this.logger.error({ err }, "Failed to load webhooks from DB");
                    return reject(err);
                }
                this.webhooks = rows || [];
                this.logger.info(`Loaded ${this.webhooks.length} active webhooks.`);
                resolve(this.webhooks);
            });
        });
    }

    async addWebhook(webhook) {
        const { id, topic, url, method = 'POST', min_interval_ms = 1000 } = webhook;
        return new Promise((resolve, reject) => {
            const query = `
                INSERT INTO webhooks (id, topic, url, method, min_interval_ms, active, created_at)
                VALUES (?, ?, ?, ?, ?, true, CURRENT_TIMESTAMP)
            `;
            this.db.run(query, [id, topic, url, method, min_interval_ms], (err) => {
                if (err) {
                    this.logger.error({ err }, "Failed to add webhook to DB");
                    return reject(err);
                }
                this.loadWebhooks();
                resolve();
            });
        });
    }

    async deleteWebhook(id) {
        return new Promise((resolve, reject) => {
            this.db.run("DELETE FROM webhooks WHERE id = ?", [id], (err) => {
                if (err) {
                    this.logger.error({ err }, "Failed to delete webhook from DB");
                    return reject(err);
                }
                this.loadWebhooks();
                resolve();
            });
        });
    }

    async listAllWebhooks() {
        return new Promise((resolve, reject) => {
            this.db.all("SELECT * FROM webhooks ORDER BY created_at DESC", (err, rows) => {
                if (err) return reject(err);
                resolve(rows);
            });
        });
    }

    async clearAllWebhooks() {
        return new Promise((resolve, reject) => {
            this.db.run("DELETE FROM webhooks", (err) => {
                if (err) return reject(err);
                this.loadWebhooks();
                resolve();
            });
        });
    }

    trigger(topic, payload) {
        const now = Date.now();
        
        for (const webhook of this.webhooks) {
            if (mqttMatch(webhook.topic, topic)) {
                // Anti-flood check
                const lastTime = this.lastTriggered.get(webhook.id) || 0;
                if (now - lastTime < webhook.min_interval_ms) {
                    // Too fast, skip
                    continue;
                }

                this.lastTriggered.set(webhook.id, now);
                this.executeWebhook(webhook, topic, payload);
            }
        }
    }

    async executeWebhook(webhook, topic, payload) {
        this.logger.debug(`Executing webhook ${webhook.id} for topic ${topic} -> ${webhook.url}`);
        
        try {
            const response = await axios({
                method: webhook.method,
                url: webhook.url,
                data: {
                    topic,
                    payload,
                    timestamp: new Date().toISOString(),
                    webhookId: webhook.id
                },
                timeout: 5000
            });
            
            this.logger.debug(`Webhook ${webhook.id} responded with status ${response.status}`);
            
            // Update last_triggered in DB (async, don't wait)
            this.db.run("UPDATE webhooks SET last_triggered = CURRENT_TIMESTAMP WHERE id = ?", [webhook.id]);
            
        } catch (err) {
            this.logger.warn({ err: err.message, url: webhook.url }, `Webhook ${webhook.id} failed`);
        }
    }
}

module.exports = new WebhookManager();