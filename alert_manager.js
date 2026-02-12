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
 * Alert Manager (Root Service)
 * Handles Alert Rules definitions, Real-time evaluation, and Alert Lifecycle state.
 * Integrated with Autonomous AI Agent Workflow.
 */
const crypto = require('crypto');
const vm = require('vm');
const axios = require('axios');
let db = null;
let logger = null;
let llmConfig = null;
let broadcaster = null;
let agentRunner = null; // Holds the AI Agent function
// Sandbox configuration for safe evaluation
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
        console: { log: () => {} },
        db: {
            all: (sql) => new Promise((resolve, reject) => {
                if (!db) return reject(new Error("DB not ready"));
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
function init(database, appLogger, config, appBroadcaster) {
    db = database;
    logger = appLogger.child({ component: 'AlertManager' });
    llmConfig = config;
    broadcaster = appBroadcaster;
    const createRulesTable = `
        CREATE TABLE IF NOT EXISTS alert_rules (
            id VARCHAR PRIMARY KEY,
            name VARCHAR,
            owner_id VARCHAR,
            topic_pattern VARCHAR,
            condition_code VARCHAR,
            severity VARCHAR,
            workflow_prompt VARCHAR,
            notifications JSON,
            enabled BOOLEAN DEFAULT true,
            created_at TIMESTAMPTZ
        );
    `;
    const createAlertsTable = `
        CREATE TABLE IF NOT EXISTS active_alerts (
            id VARCHAR PRIMARY KEY,
            rule_id VARCHAR,
            topic VARCHAR,
            broker_id VARCHAR,
            trigger_value VARCHAR,
            status VARCHAR,
            analysis_result VARCHAR,
            handled_by VARCHAR,
            created_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ
        );
    `;
    db.run(createRulesTable);
    db.run(createAlertsTable, (err) => {
        if (!err) {
            // [UPDATED] Schema Migration for existing databases
            db.all("PRAGMA table_info(active_alerts);", (pragmaErr, columns) => {
                if (columns) {
                    if (!columns.some(col => col.name === 'handled_by')) {
                        logger.warn("⚠️ Migrating 'active_alerts': Adding 'handled_by' column...");
                        db.run("ALTER TABLE active_alerts ADD COLUMN handled_by VARCHAR;");
                    }
                    if (!columns.some(col => col.name === 'analysis_result')) {
                        logger.warn("⚠️ Migrating 'active_alerts': Adding 'analysis_result' column...");
                        db.run("ALTER TABLE active_alerts ADD COLUMN analysis_result VARCHAR;");
                    }
                }
            });
        }
    });
    logger.info("✅ Alert Manager initialized.");
    // [FIX] Log here if agent was registered before init
    if (agentRunner) {
        logger.info("✅ Alert Manager: AI Agent capabilities (pre-registered) are active.");
    }
}
/**
 * Registers the AI Agent runner function from chatApi.js
 */
function registerAgentRunner(runnerFn) {
    agentRunner = runnerFn;
    // [FIX] Only log if logger is initialized, otherwise init() will log it.
    if (logger) {
        logger.info("✅ Alert Manager: AI Agent capabilities registered.");
    }
}
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
function updateRule(id, userId, ruleData, isAdmin) {
    return new Promise((resolve, reject) => {
        db.all("SELECT owner_id FROM alert_rules WHERE id = ?", id, (err, rows) => {
            if (err) return reject(err);
            if (rows.length === 0) return reject(new Error("Rule not found"));
            const rule = rows[0];
            if (rule.owner_id !== userId && !isAdmin) {
                return reject(new Error("Forbidden: Cannot edit rules you do not own."));
            }
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
            const rules = rows.map(r => {
                try { r.notifications = JSON.parse(r.notifications); } catch(e) { r.notifications = {}; }
                return r;
            });
            resolve(rules);
        });
    });
}
function deleteRule(ruleId, userId, isAdmin) {
    return new Promise((resolve, reject) => {
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
function getActiveAlerts(userId) {
    return new Promise((resolve, reject) => {
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
function updateAlertStatus(alertId, status, username, analysisResult = null) {
    return new Promise((resolve, reject) => {
        const now = new Date().toISOString();
        let query = "UPDATE active_alerts SET status = ?, handled_by = ?, updated_at = ?";
        const params = [status, username, now];
        if (analysisResult) {
            query += ", analysis_result = ?";
            params.push(analysisResult);
        }
        query += " WHERE id = ?";
        params.push(alertId);
        db.run(query, ...params, (err) => {
            if (err) return reject(err);
            // Broadcast update
            if (broadcaster) {
                broadcaster(JSON.stringify({ type: 'alert-updated', alertId, status, analysisResult }));
            }
            resolve({ id: alertId, status, handled_by: username });
        });
    });
}
function getResolvedAlertsStats() {
    return new Promise((resolve, reject) => {
        db.all("SELECT COUNT(*) as count FROM active_alerts WHERE status = 'resolved'", (err, rows) => {
            if (err) return reject(err);
            // [CRITICAL FIX] Convert DuckDB BigInt to Number before math operations
            const count = rows[0]?.count ? Number(rows[0].count) : 0;
            // Estimated size (approx 1KB per alert record)
            const estimatedSizeMb = (count / 1024).toFixed(2); 
            resolve({ count, estimatedSizeMb });
        });
    });
}
function purgeResolvedAlerts() {
    return new Promise((resolve, reject) => {
        db.run("DELETE FROM active_alerts WHERE status = 'resolved'", function(err) {
            if (err) return reject(err);
            db.exec("CHECKPOINT; VACUUM;", () => {});
            resolve({ success: true });
        });
    });
}
async function processMessage(brokerId, topic, payload) {
    if (!db) return;
    db.all("SELECT * FROM alert_rules WHERE enabled = true", async (err, rules) => {
        if (err || !rules || rules.length === 0) return;
        for (const rule of rules) {
            const regex = new RegExp("^" + rule.topic_pattern.replace(/\+/g, '[^/]+').replace(/#/g, '.*') + "$");
            if (regex.test(topic)) {
                try {
                    const msgContext = { topic, brokerId, payload };
                    const context = vm.createContext(createSandbox(msgContext));
                    const wrappedCode = `(async () => { ${rule.condition_code} })()`;
                    const script = new vm.Script(wrappedCode);
                    const isTriggered = await script.runInContext(context, { timeout: 1000 });
                    if (isTriggered === true) {
                        triggerAlert(rule, msgContext);
                    }
                } catch (evalErr) { }
            }
        }
    });
}
function triggerAlert(rule, msgContext) {
    const dedupQuery = `
        SELECT id FROM active_alerts 
        WHERE rule_id = ? AND topic = ? AND status NOT IN ('resolved')
    `;
    db.all(dedupQuery, rule.id, msgContext.topic, (err, rows) => {
        if (err) return;
        if (rows.length > 0) return;
        const alertId = `alert_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const now = new Date().toISOString();
        const triggerVal = JSON.stringify(msgContext.payload).substring(0, 200);
        const insertQuery = `
            INSERT INTO active_alerts (id, rule_id, topic, broker_id, trigger_value, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'new', ?, ?)
        `;
        db.run(insertQuery, alertId, rule.id, msgContext.topic, msgContext.brokerId, triggerVal, now, now, (insErr) => {
            if (insErr) return logger.error({ err: insErr }, "Failed to persist alert.");
            logger.info(`🚨 New Alert Triggered: ${rule.name} on ${msgContext.topic}`);
            if (broadcaster) {
                broadcaster(JSON.stringify({
                    type: 'alert-triggered',
                    alert: {
                        id: alertId, ruleName: rule.name, topic: msgContext.topic, severity: rule.severity, timestamp: now
                    }
                }));
            }
            executeWorkflow(alertId, rule, msgContext);
        });
    });
}
async function executeWorkflow(alertId, rule, msgContext) {
    let finalAnalysis = "No analysis performed.";
    // 1. Execute LLM Analysis (if agent configured)
    if (rule.workflow_prompt && agentRunner) {
        if (logger) logger.info(`[AlertWorkflow] Starting AI Analysis for Alert ${alertId}...`);
        // Update status to analyzing
        updateAlertStatus(alertId, 'analyzing', 'System (AI)');
        
        // [MODIFIED] Structured Prompt for Section Extraction
        const systemPrompt = `
            You are an Autonomous Industrial Alert Analyst.
            An alert triggered with the following context:
            - Rule: "${rule.name}" (${rule.severity})
            - Topic: ${msgContext.topic}
            - Trigger Payload: ${JSON.stringify(msgContext.payload)}
            
            USER INSTRUCTION: ${rule.workflow_prompt}
            
            Investigate using available tools to find the root cause.
            
            CRITICAL: You MUST end your response with the following structured sections exactly:

            ## TRIGGER
            [One short sentence explaining exactly WHY the alert triggered. Example: "Temp 75C > Threshold 70C" or "Sensor X reported Fault code 99"]

            ## ACTION
            [One short, imperative sentence for the operator. Example: "Inspect cooling fan motor" or "Evacuate area immediately"]

            ## REPORT
            [Your full detailed analysis in Markdown, including findings, history analysis, and reasoning.]
        `;
        try {
            // Run the Agent Loop (Max 10 turns)
            finalAnalysis = await agentRunner(systemPrompt, "Proceed with investigation and provide the structured report.");
            // Save result to DB and set status to Open (Action required)
            updateAlertStatus(alertId, 'open', 'System (AI)', finalAnalysis);
            if (logger) logger.info(`[AlertWorkflow] AI Analysis complete for ${alertId}`);
        } catch (aiError) {
            if (logger) logger.error({ err: aiError }, `[AlertWorkflow] AI Analysis failed for ${alertId}`);
            finalAnalysis = `## TRIGGER\nUnknown Error\n## ACTION\nCheck logs manually\n## REPORT\nAI Analysis Failed: ${aiError.message}`;
            updateAlertStatus(alertId, 'open', 'System (AI)', finalAnalysis);
        }
    }
    // 2. Send Notifications (Webhook) with Analysis
    let notifications = {};
    try { notifications = JSON.parse(rule.notifications); } catch(e){}
    if (notifications.webhook) {
        try {
            await axios.post(notifications.webhook, {
                text: `🚨 *${rule.severity.toUpperCase()}: ${rule.name}*\n` +
                      `*Topic:* ${msgContext.topic}\n` +
                      `*Value:* ${JSON.stringify(msgContext.payload)}\n\n` +
                      `*🤖 AI Analysis:*\n${finalAnalysis}`
            });
            if (logger) logger.info(`Webhook sent for alert ${alertId}`);
        } catch (e) {
            if (logger) logger.error(`Webhook failed: ${e.message}`);
        }
    }
}
module.exports = {
    init,
    registerAgentRunner,
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