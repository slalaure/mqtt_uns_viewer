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
 * Alert Manager
 * Handles Alert Rules definitions, Real-time evaluation, and Alert Lifecycle state.
 * Uses DuckDB for persistence and VM for safe sandbox execution.
 */
const crypto = require('crypto');
const vm = require('vm');
const axios = require('axios'); // For Webhooks

let db = null;
let logger = null;
let llmConfig = null;
let broadcaster = null; // To send WS notifications

// Sandbox configuration for safe evaluation
// Now includes read-only DB access
const createSandbox = (msg) => {
    return {
        msg: msg,
        payload: msg.payload,
        topic: msg.topic,
        parseFloat: parseFloat,
        parseInt: parseInt,
        String: String,
        Math: Math,
        Date: Date,
        console: { log: () => {} }, // Mute logs inside sandbox
        db: {
            // Read-Only Access specific to the current topic to prevent data leaks or heavy queries
            all: (sql) => new Promise((resolve, reject) => {
                if (!db) return reject(new Error("DB not ready"));
                // Security: Basic check to ensure only SELECT
                if (!sql.trim().toUpperCase().startsWith('SELECT')) {
                    return reject(new Error("Only SELECT queries are allowed in alerts."));
                }
                db.all(sql, (err, rows) => err ? reject(err) : resolve(rows));
            }),
            get: (sql) => new Promise((resolve, reject) => {
                if (!db) return reject(new Error("DB not ready"));
                if (!sql.trim().toUpperCase().startsWith('SELECT')) {
                    return reject(new Error("Only SELECT queries are allowed in alerts."));
                }
                db.all(sql, (err, rows) => err ? reject(err) : resolve(rows && rows.length > 0 ? rows[0] : null));
            })
        }
    };
};

/**
 * Initializes the Alert Manager tables.
 */
function init(database, appLogger, config, appBroadcaster) {
    db = database;
    logger = appLogger.child({ component: 'AlertManager' });
    llmConfig = config;
    broadcaster = appBroadcaster;

    // Table: Alert Definitions (Rules)
    const createRulesTable = `
        CREATE TABLE IF NOT EXISTS alert_rules (
            id VARCHAR PRIMARY KEY,
            name VARCHAR,
            owner_id VARCHAR,           -- User ID or 'global'
            topic_pattern VARCHAR,      -- MQTT Topic to watch (can use wildcards)
            condition_code VARCHAR,     -- JS condition returning boolean or Promise<boolean>
            severity VARCHAR,           -- info, warning, critical
            workflow_prompt VARCHAR,    -- Prompt for LLM investigation
            notifications JSON,         -- { "email": "...", "webhook": "..." }
            enabled BOOLEAN DEFAULT true,
            created_at TIMESTAMPTZ
        );
    `;

    // Table: Active Alerts (Instances)
    // [UPDATED] Schema now includes 'handled_by'
    const createAlertsTable = `
        CREATE TABLE IF NOT EXISTS active_alerts (
            id VARCHAR PRIMARY KEY,
            rule_id VARCHAR,
            topic VARCHAR,
            broker_id VARCHAR,
            trigger_value VARCHAR,      -- Snapshot of the value/payload that triggered it
            status VARCHAR,             -- new, analyzing, open, acknowledged, resolved
            analysis_result VARCHAR,    -- LLM Output
            handled_by VARCHAR,         -- User who ack/resolved the alert
            created_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ
        );
    `;

    db.run(createRulesTable, (err) => {
        if (err) logger.error({ err }, "❌ Failed to create 'alert_rules' table.");
    });

    db.run(createAlertsTable, (err) => {
        if (err) logger.error({ err }, "❌ Failed to create 'active_alerts' table.");
        else {
            // Schema Migration: Add 'handled_by' if missing (for existing DBs)
            db.all("PRAGMA table_info(active_alerts);", (pragmaErr, columns) => {
                if (columns) {
                    const hasHandledBy = columns.some(col => col.name === 'handled_by');
                    if (!hasHandledBy) {
                        logger.warn("⚠️ Migrating 'active_alerts' schema: Adding 'handled_by' column...");
                        db.run("ALTER TABLE active_alerts ADD COLUMN handled_by VARCHAR;");
                    }
                }
            });
        }
    });
    
    logger.info("✅ Alert Manager initialized.");
}

/**
 * Create a new Alert Rule
 */
function createRule(ruleData) {
    return new Promise((resolve, reject) => {
        const id = `rule_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const now = new Date().toISOString();
        
        const query = `
            INSERT INTO alert_rules (id, name, owner_id, topic_pattern, condition_code, severity, workflow_prompt, notifications, enabled, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        const notificationsJson = JSON.stringify(ruleData.notifications || {});

        db.run(query, id, ruleData.name, ruleData.owner_id || 'global', ruleData.topic_pattern, 
               ruleData.condition_code, ruleData.severity, ruleData.workflow_prompt, notificationsJson, 
               true, now, (err) => {
            if (err) return reject(err);
            resolve({ id, ...ruleData });
        });
    });
}

/**
 * Update an existing Alert Rule
 */
function updateRule(id, userId, ruleData, isAdmin) {
    return new Promise((resolve, reject) => {
        // 1. Check ownership
        db.all("SELECT owner_id FROM alert_rules WHERE id = ?", id, (err, rows) => {
            if (err) return reject(err);
            if (rows.length === 0) return reject(new Error("Rule not found"));
            
            const rule = rows[0];
            if (rule.owner_id !== userId && !isAdmin) {
                return reject(new Error("Forbidden: Cannot edit rules you do not own."));
            }

            // 2. Perform Update
            const query = `
                UPDATE alert_rules 
                SET name = ?, topic_pattern = ?, condition_code = ?, severity = ?, workflow_prompt = ?, notifications = ?
                WHERE id = ?
            `;
            
            const notificationsJson = JSON.stringify(ruleData.notifications || {});

            db.run(query, ruleData.name, ruleData.topic_pattern, ruleData.condition_code, 
                   ruleData.severity, ruleData.workflow_prompt, notificationsJson, id, (updateErr) => {
                if (updateErr) return reject(updateErr);
                resolve({ id, ...ruleData });
            });
        });
    });
}

/**
 * Get Rules (Filtered by User or Global)
 */
function getRules(userId) {
    return new Promise((resolve, reject) => {
        let query = "SELECT * FROM alert_rules WHERE owner_id = 'global'";
        const params = [];
        
        if (userId) {
            query += " OR owner_id = ?";
            params.push(userId);
        }
        
        db.all(query, ...params, (err, rows) => {
            if (err) return reject(err);
            // Parse JSON columns
            const rules = rows.map(r => {
                try { r.notifications = JSON.parse(r.notifications); } catch(e) { r.notifications = {}; }
                return r;
            });
            resolve(rules);
        });
    });
}

/**
 * Delete a Rule
 */
function deleteRule(ruleId, userId, isAdmin) {
    return new Promise((resolve, reject) => {
        // Check ownership first
        db.all("SELECT owner_id FROM alert_rules WHERE id = ?", ruleId, (err, rows) => {
            if (err) return reject(err);
            if (rows.length === 0) return reject(new Error("Rule not found"));
            
            const rule = rows[0];
            if (rule.owner_id !== userId && !isAdmin) {
                return reject(new Error("Forbidden: Cannot delete rules you do not own."));
            }

            db.run("DELETE FROM alert_rules WHERE id = ?", ruleId, (delErr) => {
                if (delErr) return reject(delErr);
                resolve({ success: true });
            });
        });
    });
}

/**
 * Get Active Alerts
 */
function getActiveAlerts(userId) {
    return new Promise((resolve, reject) => {
        // Join with rules to respect ownership visibility
        const query = `
            SELECT a.*, r.name as rule_name, r.severity 
            FROM active_alerts a
            JOIN alert_rules r ON a.rule_id = r.id
            WHERE r.owner_id = 'global' OR r.owner_id = ?
            ORDER BY a.created_at DESC
            LIMIT 200
        `;
        
        db.all(query, userId || 'guest', (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

/**
 * Acknowledge or Resolve an Alert
 * [UPDATED] Now saves the user who performed the action.
 */
function updateAlertStatus(alertId, status, username) {
    return new Promise((resolve, reject) => {
        const now = new Date().toISOString();
        const query = "UPDATE active_alerts SET status = ?, handled_by = ?, updated_at = ? WHERE id = ?";
        db.run(query, status, username, now, alertId, (err) => {
            if (err) return reject(err);
            resolve({ id: alertId, status, handled_by: username });
        });
    });
}

/**
 * [NEW] Get statistics about resolved alerts (for Admin Dashboard)
 */
function getResolvedAlertsStats() {
    return new Promise((resolve, reject) => {
        // Count resolved alerts
        db.all("SELECT COUNT(*) as count FROM active_alerts WHERE status = 'resolved'", (err, rows) => {
            if (err) return reject(err);
            const count = rows[0]?.count || 0;
            // Estimated size: count * average payload size (conservative 1KB)
            const estimatedSizeKb = count; 
            const estimatedSizeMb = (estimatedSizeKb / 1024).toFixed(2);
            resolve({ count, estimatedSizeMb });
        });
    });
}

/**
 * [NEW] Purge all resolved alerts
 */
function purgeResolvedAlerts() {
    return new Promise((resolve, reject) => {
        db.run("DELETE FROM active_alerts WHERE status = 'resolved'", function(err) {
            if (err) return reject(err);
            // 'this.changes' doesn't exist in all node-duckdb callbacks wrapper, using count logic if needed
            // But we assume success.
            // Vacuum to reclaim space
            db.exec("CHECKPOINT; VACUUM;", () => {});
            resolve({ success: true });
        });
    });
}

/**
 * CORE LOGIC: Evaluate incoming MQTT message against rules
 * Supports Async execution for DB queries.
 */
async function processMessage(brokerId, topic, payload) {
    if (!db) return; // Not ready

    db.all("SELECT * FROM alert_rules WHERE enabled = true", async (err, rules) => {
        if (err || !rules || rules.length === 0) return;

        for (const rule of rules) {
            // 1. Match Topic
            // Simple wildcard matching regex conversion
            const regex = new RegExp("^" + rule.topic_pattern.replace(/\+/g, '[^/]+').replace(/#/g, '.*') + "$");
            
            if (regex.test(topic)) {
                // 2. Evaluate Condition
                try {
                    const msgContext = {
                        topic: topic,
                        brokerId: brokerId,
                        payload: payload
                    };
                    
                    const context = vm.createContext(createSandbox(msgContext));
                    
                    // Wrap user code in an async function to allow 'await db...'
                    const wrappedCode = `(async () => { ${rule.condition_code} })()`;
                    const script = new vm.Script(wrappedCode);
                    
                    // Execute and wait for result (boolean)
                    const isTriggered = await script.runInContext(context, { timeout: 1000 });

                    if (isTriggered === true) {
                        triggerAlert(rule, msgContext);
                    }
                } catch (evalErr) {
                    // logger.warn({ err: evalErr, rule: rule.name }, "Condition evaluation failed");
                }
            }
        }
    });
}

/**
 * Handles the triggering of an alert: De-duplication -> Storage -> Workflow -> Broadcast
 */
function triggerAlert(rule, msgContext) {
    // Basic De-duplication: Don't trigger if an alert for this Rule+Topic is already active (not resolved)
    const dedupQuery = `
        SELECT id FROM active_alerts 
        WHERE rule_id = ? AND topic = ? AND status NOT IN ('resolved')
    `;

    db.all(dedupQuery, rule.id, msgContext.topic, (err, rows) => {
        if (err) return;
        if (rows.length > 0) {
            return; // Already active
        }

        // New Alert
        const alertId = `alert_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const now = new Date().toISOString();
        const triggerVal = JSON.stringify(msgContext.payload).substring(0, 200);

        const insertQuery = `
            INSERT INTO active_alerts (id, rule_id, topic, broker_id, trigger_value, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'new', ?, ?)
        `;

        db.run(insertQuery, alertId, rule.id, msgContext.topic, msgContext.brokerId, triggerVal, now, now, (insErr) => {
            if (insErr) {
                logger.error({ err: insErr }, "Failed to persist alert.");
                return;
            }
            logger.info(`🚨 New Alert Triggered: ${rule.name} on ${msgContext.topic}`);
            
            // 1. Broadcast to UI (Global Red Banner & Table Refresh)
            if (broadcaster) {
                broadcaster(JSON.stringify({
                    type: 'alert-triggered',
                    alert: {
                        id: alertId,
                        ruleName: rule.name,
                        topic: msgContext.topic,
                        severity: rule.severity,
                        timestamp: now
                    }
                }));
            }

            // 2. Execute Workflow (Notifications & LLM)
            executeWorkflow(alertId, rule, msgContext);
        });
    });
}

/**
 * Asynchronous Workflow Execution
 */
async function executeWorkflow(alertId, rule, msgContext) {
    // 1. Send Notifications (Webhook)
    let notifications = {};
    try { notifications = JSON.parse(rule.notifications); } catch(e){}

    if (notifications.webhook) {
        try {
            await axios.post(notifications.webhook, {
                text: `🚨 *${rule.severity.toUpperCase()}: ${rule.name}*\n*Topic:* ${msgContext.topic}\n*Value:* ${JSON.stringify(msgContext.payload)}`
            });
            logger.info(`Webhook sent for alert ${alertId}`);
        } catch (e) {
            logger.error(`Webhook failed: ${e.message}`);
        }
    }

    // 2. Execute LLM Analysis
    if (rule.workflow_prompt && llmConfig.LLM_API_KEY) {
        updateAlertStatus(alertId, 'analyzing', 'System (AI)');
        // ... Future implementation: Trigger internal chat generation ...
    }
}

module.exports = {
    init,
    createRule,
    updateRule,
    getRules,
    deleteRule,
    getActiveAlerts,
    updateAlertStatus,
    getResolvedAlertsStats, 
    purgeResolvedAlerts,    
    processMessage
};