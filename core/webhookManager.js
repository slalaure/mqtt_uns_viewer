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
            this.db.run(query, id, topic, url, method, min_interval_ms, (err) => {
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
            this.db.run("DELETE FROM webhooks WHERE id = ?", id, (err) => {
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

    trigger(topic, payload, correlationId = null) {
        const now = Date.now();
        const promises = [];
        
        for (const webhook of this.webhooks) {
            if (mqttMatch(webhook.topic, topic)) {
                // Anti-flood check
                const lastTime = this.lastTriggered.has(webhook.id) ? this.lastTriggered.get(webhook.id) : -Infinity;
                if (now - lastTime < webhook.min_interval_ms) {
                    // Too fast, skip
                    continue;
                }

                this.lastTriggered.set(webhook.id, now);
                promises.push(this.executeWebhook(webhook, topic, payload, correlationId));
            }
        }
        return Promise.all(promises);
    }

    async testWebhook(id) {
        const webhook = this.webhooks.find(w => w.id === id);
        if (!webhook) {
            // Check DB if not in active memory
            return new Promise((resolve, reject) => {
                this.db.all("SELECT * FROM webhooks WHERE id = ?", id, async (err, rows) => {
                    if (err) return reject(err);
                    if (rows.length === 0) return reject(new Error("Webhook not found"));
                    try {
                        const res = await this.executeWebhook(rows[0], "test/topic", { test: true, message: "Manual test trigger" }, "test-correlation-id");
                        resolve(res);
                    } catch (e) {
                        reject(e);
                    }
                });
            });
        }
        return this.executeWebhook(webhook, "test/topic", { test: true, message: "Manual test trigger" }, "test-correlation-id");
    }

    async executeWebhook(webhook, topic, payload, correlationId = null) {
        this.logger.debug({ webhookId: webhook.id, topic, correlationId }, `Executing webhook`);
        
        try {
            const response = await axios({
                method: webhook.method,
                url: webhook.url,
                data: {
                    topic,
                    payload,
                    timestamp: new Date().toISOString(),
                    webhookId: webhook.id,
                    correlationId // [NEW] Propagate trace ID to 3rd party systems
                },
                timeout: 5000
            });
            
            this.logger.debug({ webhookId: webhook.id, status: response.status, correlationId }, `Webhook executed successfully`);
            
            // Update last_triggered in DB (async, don't wait)
            this.db.run("UPDATE webhooks SET last_triggered = CURRENT_TIMESTAMP WHERE id = ?", webhook.id);
            
        } catch (err) {
            this.logger.warn({ err: err.message, url: webhook.url, correlationId }, `Webhook ${webhook.id} failed`);
        }
    }
}

module.exports = new WebhookManager();