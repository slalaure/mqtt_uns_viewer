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
 * [UPDATED] Implemented V8 Script/Regex caching and Event Loop yielding for extreme high-throughput.
 * [UPDATED] Prompt engineering delegated to the internal llmEngine.
 */
const crypto = require('crypto');
const vm = require('vm');
const axios = require('axios');
const llmEngine = require('./llmEngine');

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
            correlation_id VARCHAR,
            created_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ
        );
    `;
    
    db.run(createRulesTable);
    db.run(createAlertsTable, (err) => {
        if (!err) {
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
                    if (!columns.some(col => col.name === 'correlation_id')) {
                        logger.warn("⚠️ Migrating 'active_alerts': Adding 'correlation_id' column...");
                        db.run("ALTER TABLE active_alerts ADD COLUMN correlation_id VARCHAR;");
                    }
                }
            });
        }
    });
    
    logger.info("✅ Alert Manager initialized.");
    if (agentRunner) {
        logger.info("✅ Alert Manager: AI Agent capabilities (pre-registered) are active.");
    }
}

/**
 * Registers the AI Agent runner function from chatApi.js
 */
function registerAgentRunner(runnerFn) {
    agentRunner = runnerFn;
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
            const count = rows[0]?.count ? Number(rows[0].count) : 0;
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

async function processMessage(brokerId, topic, payload, correlationId = null) {
    if (!db) return;
    
    db.all("SELECT * FROM alert_rules WHERE enabled = true", async (err, rules) => {
        if (err || !rules || rules.length === 0) return;
        
        for (const rule of rules) {
            // Cache RegExp object to avoid recompilation overhead
            if (!rule._cachedRegex || rule._rawPattern !== rule.topic_pattern) {
                rule._cachedRegex = new RegExp("^" + rule.topic_pattern.replace(/\+/g, '[^/]+').replace(/#/g, '.*') + "$");
                rule._rawPattern = rule.topic_pattern;
            }

            if (rule._cachedRegex.test(topic)) {
                try {
                    const msgContext = { topic, brokerId, payload, correlationId };
                    
                    // Yield to Event Loop to prevent starvation during massive packet storms
                    await new Promise(setImmediate);
                    
                    const context = vm.createContext(createSandbox(msgContext), { microtaskMode: 'afterEvaluate' });
                    
                    // Cache compiled vm.Script to eliminate V8 compilation spike
                    if (!rule._cachedScript || rule._rawCode !== rule.condition_code) {
                        const wrappedCode = `(async () => { ${rule.condition_code} })()`;
                        rule._cachedScript = new vm.Script(wrappedCode);
                        rule._rawCode = rule.condition_code;
                    }
                    
                    const isTriggered = await rule._cachedScript.runInContext(context, { timeout: 1000 });
                    
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
            INSERT INTO active_alerts (id, rule_id, topic, broker_id, trigger_value, status, correlation_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?)
        `;
        
        db.run(insertQuery, alertId, rule.id, msgContext.topic, msgContext.brokerId, triggerVal, msgContext.correlationId || null, now, now, (insErr) => {
            if (insErr) return logger.error({ err: insErr, correlationId: msgContext.correlationId }, "Failed to persist alert.");
            
            logger.info({ msg: `🚨 New Alert Triggered: ${rule.name} on ${msgContext.topic}`, correlationId: msgContext.correlationId });
            
            if (broadcaster) {
                broadcaster(JSON.stringify({
                    type: 'alert-triggered',
                    alert: {
                        id: alertId, ruleName: rule.name, topic: msgContext.topic, severity: rule.severity, timestamp: now, correlationId: msgContext.correlationId
                    }
                }));
            }
            executeWorkflow(alertId, rule, msgContext);
        });
    });
}

async function executeWorkflow(alertId, rule, msgContext) {
    let finalAnalysis = "No analysis performed.";
    const correlationId = msgContext.correlationId;

    // 1. Execute LLM Analysis (if agent configured)
    if (rule.workflow_prompt && agentRunner) {
        if (logger) logger.info({ msg: `[AlertWorkflow] Starting AI Analysis for Alert ${alertId}...`, correlationId });
        
        updateAlertStatus(alertId, 'analyzing', 'System (AI)');
        
        const systemPrompt = llmEngine.generateAlertAnalysisPrompt(rule, msgContext);

        try {
            finalAnalysis = await agentRunner(systemPrompt, `Proceed with investigation for alert ${alertId}. Trace ID: ${correlationId || 'none'}`);
            updateAlertStatus(alertId, 'open', 'System (AI)', finalAnalysis);
            if (logger) logger.info({ msg: `[AlertWorkflow] AI Analysis complete for ${alertId}`, correlationId });
        } catch (aiError) {
            if (logger) logger.error({ err: aiError, correlationId }, `[AlertWorkflow] AI Analysis failed for ${alertId}`);
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
                      `*Value:* ${JSON.stringify(msgContext.payload)}\n` +
                      `*Trace ID:* ${correlationId || 'N/A'}\n\n` +
                      `*🤖 AI Analysis:*\n${finalAnalysis}`
            });
            if (logger) logger.info({ msg: `Webhook sent for alert ${alertId}`, correlationId });
        } catch (e) {
            if (logger) logger.error({ msg: `Webhook failed: ${e.message}`, correlationId });
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