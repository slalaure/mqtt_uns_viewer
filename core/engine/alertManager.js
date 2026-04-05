/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025-2026 Sebastien Lalaurette
 *
 * Alert Manager (Root Service)
 */
const crypto = require('crypto');
const axios = require('axios');
const llmEngine = require('./llmEngine');

class AlertManager {
    constructor() {
        this.db = null;
        this.logger = null;
        this.llmConfig = null;
        this.broadcaster = null;
        this.agentRunner = null;
        this.sandboxPool = null;
    }

    init(database, appLogger, config, appBroadcaster) {
        this.db = database;
        this.logger = appLogger.child({ component: 'AlertManager' });
        this.llmConfig = config;
        this.broadcaster = appBroadcaster;
        
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
                source_id VARCHAR,
                trigger_value VARCHAR,
                status VARCHAR,
                analysis_result VARCHAR,
                handled_by VARCHAR,
                correlation_id VARCHAR,
                created_at TIMESTAMPTZ,
                updated_at TIMESTAMPTZ
            );
        `;
        
        this.db.run(createRulesTable);
        this.db.run(createAlertsTable, (err) => {
            if (!err) {
                this.db.all("PRAGMA table_info(active_alerts);", (pragmaErr, columns) => {
                    if (columns) {
                        if (!columns.some(col => col.name === 'handled_by')) {
                            this.logger.warn("⚠️ Migrating 'active_alerts': Adding 'handled_by' column...");
                            this.db.run("ALTER TABLE active_alerts ADD COLUMN handled_by VARCHAR;");
                        }
                        if (!columns.some(col => col.name === 'analysis_result')) {
                            this.logger.warn("⚠️ Migrating 'active_alerts': Adding 'analysis_result' column...");
                            this.db.run("ALTER TABLE active_alerts ADD COLUMN analysis_result VARCHAR;");
                        }
                        if (!columns.some(col => col.name === 'correlation_id')) {
                            this.logger.warn("⚠️ Migrating 'active_alerts': Adding 'correlation_id' column...");
                            this.db.run("ALTER TABLE active_alerts ADD COLUMN correlation_id VARCHAR;");
                        }
                    }
                });
            }
        });
        
        this.logger.info("✅ Alert Manager initialized (ES6 Class Mode).");
        if (this.agentRunner) {
            this.logger.info("✅ Alert Manager: AI Agent capabilities (pre-registered) are active.");
        }
    }

    setSandbox(sandboxPool) {
        this.sandboxPool = sandboxPool;
        if (this.logger) {
            this.logger.info("✅ Alert Manager: Sandbox Pool registered.");
        }
    }

    registerAgentRunner(runnerFn) {
        this.agentRunner = runnerFn;
        if (this.logger) {
            this.logger.info("✅ Alert Manager: AI Agent capabilities registered.");
        }
    }

    createRule(ruleData) {
        return new Promise((resolve, reject) => {
            const id = `rule_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
            const now = new Date().toISOString();
            const query = `
                INSERT INTO alert_rules (id, name, owner_id, topic_pattern, condition_code, severity, workflow_prompt, notifications, enabled, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            const notificationsJson = JSON.stringify(ruleData.notifications || {});
            this.db.run(query, id, ruleData.name, ruleData.owner_id || 'global', ruleData.topic_pattern, 
                   ruleData.condition_code, ruleData.severity, ruleData.workflow_prompt, notificationsJson, 
                   true, now, (err) => {
                if (err) return reject(err);
                resolve({ id, ...ruleData });
            });
        });
    }

    updateRule(id, userId, ruleData, isAdmin) {
        return new Promise((resolve, reject) => {
            this.db.all("SELECT owner_id FROM alert_rules WHERE id = ?", id, (err, rows) => {
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
                this.db.run(query, ruleData.name, ruleData.topic_pattern, ruleData.condition_code, 
                       ruleData.severity, ruleData.workflow_prompt, notificationsJson, id, (updateErr) => {
                    if (updateErr) return reject(updateErr);
                    resolve({ id, ...ruleData });
                });
            });
        });
    }

    getRules(userId) {
        return new Promise((resolve, reject) => {
            let query = "SELECT * FROM alert_rules WHERE owner_id = 'global'";
            const params = [];
            if (userId) {
                query += " OR owner_id = ?";
                params.push(userId);
            }
            this.db.all(query, ...params, (err, rows) => {
                if (err) return reject(err);
                const rules = rows.map(r => {
                    try { r.notifications = JSON.parse(r.notifications); } 
                    catch(e) { r.notifications = {}; }
                    return r;
                });
                resolve(rules);
            });
        });
    }

    deleteRule(ruleId, userId, isAdmin) {
        return new Promise((resolve, reject) => {
            this.db.all("SELECT owner_id FROM alert_rules WHERE id = ?", ruleId, (err, rows) => {
                if (err) return reject(err);
                if (rows.length === 0) return reject(new Error("Rule not found"));
                const rule = rows[0];
                if (rule.owner_id !== userId && !isAdmin) {
                    return reject(new Error("Forbidden: Cannot delete rules you do not own."));
                }

                this.db.run("DELETE FROM alert_rules WHERE id = ?", ruleId, (delErr) => {
                    if (delErr) return reject(delErr);
                    resolve({ success: true });
                });
            });
        });
    }

    getActiveAlerts(userId) {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT a.*, r.name as rule_name, r.severity 
                FROM active_alerts a
                JOIN alert_rules r ON a.rule_id = r.id
                WHERE r.owner_id = 'global' OR r.owner_id = ?
                ORDER BY a.created_at DESC
                LIMIT 200
            `;
            this.db.all(query, userId || 'guest', (err, rows) => {
                if (err) return reject(err);
                resolve(rows);
            });
        });
    }

    updateAlertStatus(alertId, status, username, analysisResult = null) {
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
            this.db.run(query, ...params, (err) => {
                if (err) return reject(err);
                if (this.broadcaster) {
                    this.broadcaster(JSON.stringify({ type: 'alert-updated', alertId, status, analysisResult }));
                }
                resolve({ id: alertId, status, handled_by: username });
            });
        });
    }

    getResolvedAlertsStats() {
        return new Promise((resolve, reject) => {
            this.db.all("SELECT COUNT(*) as count FROM active_alerts WHERE status = 'resolved'", (err, rows) => {
                if (err) return reject(err);
                const count = rows[0]?.count ? Number(rows[0].count) : 0;
                const estimatedSizeMb = (count / 1024).toFixed(2); 
                resolve({ count, estimatedSizeMb });
            });
        });
    }

    purgeResolvedAlerts() {
        return new Promise((resolve, reject) => {
            this.db.run("DELETE FROM active_alerts WHERE status = 'resolved'", (err) => {
                if (err) return reject(err);
                this.db.exec("CHECKPOINT; VACUUM;", () => {});
                resolve({ success: true });
            });
        });
    }

    async purgeResolvedAlerts() {
        if (!this.db) return { success: false, error: "Database not available" };
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run("DELETE FROM resolved_alerts_history;", (err) => {
                    if (err) return resolve({ success: false, error: err.message });
                    
                    this.db.run("VACUUM;", (vacErr) => {
                        if (vacErr) this.logger.error({ err: vacErr }, "Failed to vacuum DB after alert purge");
                        resolve({ success: true });
                    });
                });
            });
        });
    }

    async processMessage(sourceId, topic, payload, correlationId = null) {
        if (!this.db) return;
        if (this.llmConfig && this.llmConfig.VIEW_ALERTS_ENABLED === false) return;

        try {            const rules = await new Promise((resolve, reject) => {
                this.db.all("SELECT * FROM alert_rules WHERE enabled = true", (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                });
            });

            if (!rules || rules.length === 0) return;
            
            for (const rule of rules) {
                if (!rule._cachedRegex || rule._rawPattern !== rule.topic_pattern) {
                    rule._cachedRegex = new RegExp("^" + rule.topic_pattern.replace(/\+/g, '[^/]+').replace(/#/g, '.*') + "$");
                    rule._rawPattern = rule.topic_pattern;
                }

                if (rule._cachedRegex.test(topic)) {
                    try {
                        const msgContext = { topic, sourceId, payload, correlationId };
                        
                        await new Promise(setImmediate); // Yield to Event Loop
                        
                        if (!this.sandboxPool) {
                            this.logger.error("Sandbox Pool not available for Alert Manager.");
                            continue;
                        }

                        // Offload to SandboxPool for secure execution with memory limits
                        const wrappedCode = `(async () => { ${rule.condition_code} })()`;
                        const isTriggered = await this.sandboxPool.execute(wrappedCode, { msg: msgContext }, 1000);
                        
                        if (isTriggered === true) {
                            await this.triggerAlert(rule, msgContext);
                        }
                    } catch (evalErr) { 
                        this.logger.error({ err: evalErr, ruleId: rule.id, topic }, "Alert Manager: Failed to evaluate condition script.");
                    }
                }
            }
        } catch (dbErr) {
            this.logger.error({ err: dbErr }, "Alert Manager: Failed to load rules from DB.");
        }
    }

    async triggerAlert(rule, msgContext) {
        return new Promise((resolve) => {
            const dedupQuery = `
                SELECT id FROM active_alerts 
                WHERE rule_id = ? AND topic = ? AND status NOT IN ('resolved')
            `;
            this.db.all(dedupQuery, rule.id, msgContext.topic, (err, rows) => {
                if (err) return resolve();
                if (rows.length > 0) return resolve();
                
                const alertId = `alert_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
                const now = new Date().toISOString();
                const triggerVal = JSON.stringify(msgContext.payload).substring(0, 200);
                
                const insertQuery = `
                    INSERT INTO active_alerts (id, rule_id, topic, source_id, trigger_value, status, correlation_id, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?)
                `;
                
                this.db.run(insertQuery, alertId, rule.id, msgContext.topic, msgContext.sourceId, triggerVal, msgContext.correlationId || null, now, now, (insErr) => {
                    if (insErr) {
                        this.logger.error({ err: insErr, correlationId: msgContext.correlationId }, "Failed to persist alert.");
                        return resolve();
                    }
                    
                    this.logger.info({ msg: `🚨 New Alert Triggered: ${rule.name} on ${msgContext.topic}`, correlationId: msgContext.correlationId });
                    
                    if (this.broadcaster) {
                        this.broadcaster(JSON.stringify({
                            type: 'alert-triggered',
                            alert: {
                                id: alertId, ruleName: rule.name, topic: msgContext.topic, severity: rule.severity, timestamp: now, correlationId: msgContext.correlationId
                            }
                        }));
                    }
                    this.executeWorkflow(alertId, rule, msgContext).then(resolve);
                });
            });
        });
    }

    async executeWorkflow(alertId, rule, msgContext) {
        let finalAnalysis = "No analysis performed.";
        const correlationId = msgContext.correlationId;

        if (rule.workflow_prompt && this.agentRunner) {
            if (this.logger) this.logger.info({ msg: `[AlertWorkflow] Starting AI Analysis for Alert ${alertId}...`, correlationId });
            
            this.updateAlertStatus(alertId, 'analyzing', 'System (AI)');
            const systemPrompt = llmEngine.generateAlertAnalysisPrompt(rule, msgContext);

            try {
                // [UPDATED] Passing correlationId as 3rd arg for end-to-end tracing
                finalAnalysis = await this.agentRunner(systemPrompt, `Proceed with investigation for alert ${alertId}. Trace ID: ${correlationId || 'none'}`, correlationId);
                this.updateAlertStatus(alertId, 'open', 'System (AI)', finalAnalysis);
                if (this.logger) this.logger.info({ msg: `[AlertWorkflow] AI Analysis complete for ${alertId}`, correlationId });
            } catch (aiError) {
                if (this.logger) this.logger.error({ err: aiError, correlationId }, `[AlertWorkflow] AI Analysis failed for ${alertId}`);
                finalAnalysis = `## TRIGGER\nUnknown Error\n## ACTION\nCheck logs manually\n## REPORT\nAI Analysis Failed: ${aiError.message}`;
                this.updateAlertStatus(alertId, 'open', 'System (AI)', finalAnalysis);
            }
        }
        
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
                if (this.logger) this.logger.info({ msg: `Webhook sent for alert ${alertId}`, correlationId });
            } catch (e) {
                if (this.logger) this.logger.error({ msg: `Webhook failed: ${e.message}`, correlationId });
            }
        }
    }
}

// Export as singleton to maintain backward compatibility with server.js require interface
module.exports = new AlertManager();
