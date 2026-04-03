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
 * Mapper Engine for real-time topic and payload transformation.
 * [UPDATED] Refactored into a pure ES6 Class (OOP Standardization).
 * [UPDATED] Reverted isolated-vm to native 'vm' to permanently fix C++ Segmentation Faults with DuckDB.
 * [UPDATED] V8 Scripts are strictly cached and Event Loop yielded for high throughput.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mustache = require('mustache');
const mqttMatch = require('mqtt-match');
const spBv10Codec = require('sparkplug-payload').get("spBv10"); 

const MAPPINGS_FILE_PATH = path.join(__dirname, '..', '..', 'data', 'mappings.json');

class MapperEngine {
    constructor(connectionsMap, broadcaster, logger, longReplacer, appServerConfig) {
        this.activeConnections = connectionsMap;
        this.broadcastCallback = broadcaster;
        this.engineLogger = logger.child({ component: 'MapperEngine' });
        this.payloadReplacer = longReplacer;
        this.serverConfig = appServerConfig;

        this.config = { versions: [], activeVersionId: null };
        this.metrics = new Map();
        this.metricsUpdateTimer = null;
        this.internalDb = null;
        
        // Native VM Script Cache
        this.scriptCache = new Map(); 

        this.DEFAULT_JS_CODE = `// 'msg' object contains msg.topic, msg.payload (parsed JSON), and msg.brokerId.
// 'db' object is available with await db.all(sql) and await db.get(sql).
// CASE 1: Single Output (Fan-out)
// Return 'msg' to automatically publish it to all Target Topic(s) defined above.
// return msg;

// CASE 2: Multiple Specific Outputs
// Return an array of messages to explicitly route different payloads to different topics.
/*
const msg1 = { topic: "uns/factory/temp", payload: { value: msg.payload.T1 } };
const msg2 = { topic: "uns/factory/press", payload: { value: msg.payload.P1 } };
return [msg1, msg2];
*/

return msg;
`;
        this.loadMappings();
    }

    setDb(dbConnection) {
        this.internalDb = dbConnection;
        this.engineLogger.info("✅ Database connection injected into Mapper Engine.");
    }

    createNewVersion(name) {
        const newVersionId = `v_${Date.now()}`;
        return {
            id: newVersionId,
            name: name || `Version ${this.config.versions.length + 1}`,
            createdAt: new Date().toISOString(),
            rules: [] 
        };
    }

    loadMappings() {
        try {
            if (fs.existsSync(MAPPINGS_FILE_PATH)) {
                const data = fs.readFileSync(MAPPINGS_FILE_PATH, 'utf8');
                this.config = JSON.parse(data);
                if (!this.config.versions || !this.config.activeVersionId) {
                    throw new Error("Invalid config structure.");
                }
                this.engineLogger.info(`✅ Mapper Engine: Loaded ${this.config.versions.length} versions. Active: ${this.config.activeVersionId}`);
            } else {
                this.engineLogger.info("Mapper Engine: No 'mappings.json' file found. Creating new default config.");
                const defaultVersion = this.createNewVersion("Initial Version");
                this.config = {
                    versions: [defaultVersion],
                    activeVersionId: defaultVersion.id
                };
                this.saveMappings(this.config);
            }
        } catch (err) {
            this.engineLogger.error({ err }, "❌ Mapper Engine: Failed to load mappings.json. Resetting to default.");
            const defaultVersion = this.createNewVersion("Recovery Version");
            this.config = {
                versions: [defaultVersion],
                activeVersionId: defaultVersion.id
            };
        }
    }

    saveMappings(newConfig) {
        try {
            // Clear script cache to ensure new code is compiled
            this.scriptCache.clear();

            this.config = newConfig; 
            fs.writeFileSync(MAPPINGS_FILE_PATH, JSON.stringify(this.config, null, 2));
            this.engineLogger.info(`✅ Mapper Engine: Saved config. Active: ${this.config.activeVersionId}`);
            
            this.broadcastCallback(JSON.stringify({
                type: 'mapper-config-update',
                config: this.config
            }));
            return { success: true };
        } catch (err) {
            this.engineLogger.error({ err }, "❌ Mapper Engine: Failed to save mappings.json");
            return { success: false, error: err.message };
        }
    }

    getMappings() { return this.config; }
    getConfig() { return this.config; }

    getActiveRules() {
        const activeVersion = this.config.versions.find(v => v.id === this.config.activeVersionId);
        return activeVersion ? activeVersion.rules : [];
    }

    getMetrics() {
        return Object.fromEntries(this.metrics);
    }

    broadcastMetrics() {
        if (this.metricsUpdateTimer) return; 
        this.metricsUpdateTimer = setTimeout(() => {
            this.broadcastCallback(JSON.stringify({
                type: 'mapper-metrics-update',
                metrics: this.getMetrics()
            }));
            this.metricsUpdateTimer = null;
        }, 1500); 
    }

    updateMetrics(rule, target, inTopic, outPayloadStr, outTopic, errorMsg = null, debugMsg = null, correlationId = null) {
        const ruleId = `${rule.sourceTopic}::${target.id}`;
        if (!this.metrics.has(ruleId)) {
            this.metrics.set(ruleId, { count: 0, logs: [] });
        }
        const ruleMetrics = this.metrics.get(ruleId);
        if (!errorMsg && !debugMsg) {
            ruleMetrics.count++;
        }
        const logEntry = {
            ts: new Date().toISOString(),
            inTopic: inTopic,
            correlationId: correlationId 
        };

        if (errorMsg) {
            logEntry.error = errorMsg.substring(0, 200); 
        } else if (debugMsg) {
            logEntry.debug = debugMsg; 
        } else {
            logEntry.outTopic = outTopic;
            logEntry.outPayload = outPayloadStr.substring(0, 150) + (outPayloadStr.length > 150 ? '...' : '');
        }

        ruleMetrics.logs.unshift(logEntry);
        if (ruleMetrics.logs.length > 20) {
            ruleMetrics.logs.pop();
        }

        if (errorMsg) {
            clearTimeout(this.metricsUpdateTimer); 
            this.metricsUpdateTimer = null;
            this.broadcastCallback(JSON.stringify({
                type: 'mapper-metrics-update',
                metrics: this.getMetrics()
            }));
        } else {
            this.broadcastMetrics();
        }
    }

    rulesForTopicRequireDb(topic) {
        const activeRules = this.getActiveRules();
        if (activeRules.length === 0) return false;
        for (const rule of activeRules) {
            if (mqttMatch(rule.sourceTopic.trim(), topic)) {
                for (const target of rule.targets) {
                    const cleanCode = target.code ? target.code.replace(/\u00A0/g, " ") : "";
                    if (target.enabled && cleanCode.includes('await db')) {
                        return true; 
                    }
                }
            }
        }
        return false; 
    }

    isPublishAllowed(brokerId, topic) {
        if (!this.serverConfig) return true; 
        
        const allConfigs = [
            ...(this.serverConfig.BROKER_CONFIGS || []),
            ...(this.serverConfig.DATA_PROVIDERS || [])
        ];
        
        const providerConfig = allConfigs.find(b => b.id === brokerId);
        
        if (!providerConfig) {
            if (this.activeConnections.has(brokerId)) return true;
            return false; 
        }
        
        const publishPatterns = providerConfig.publish || [];
        if (publishPatterns.length === 0) return false; 
        return publishPatterns.some(pattern => mqttMatch(pattern, topic));
    }

    async processMessage(brokerId, topic, payloadObject, isSparkplugOrigin = false, correlationId = null) {
        const activeRules = this.getActiveRules();
        if (activeRules.length === 0) return;

        const originalMsg = {
            topic: topic,
            payload: payloadObject,
            brokerId: brokerId,
            correlationId: correlationId 
        };

        for (const rule of activeRules) {
            if (mqttMatch(rule.sourceTopic.trim(), topic)) {
                
                const targetPromises = rule.targets.map(async (target) => {
                    if (!target.enabled) return;

                    this.updateMetrics(rule, target, topic, null, null, null, "Rule matched. Attempting execution...", correlationId);

                    try {
                        let msgForSandbox;
                        try {
                            msgForSandbox = JSON.parse(JSON.stringify(originalMsg));
                        } catch(copyErr) {
                            this.engineLogger.error({ err: copyErr, topic: topic, correlationId }, "Mapper Engine: Failed to deep copy message for sandbox.");
                            this.updateMetrics(rule, target, topic, null, null, `Failed to deep copy message: ${copyErr.message}`, null, correlationId);
                            return; 
                        }

                        await new Promise(setImmediate); // Yield to Event Loop

                        let resultMsg = null;
                        
                        // Native VM execution context
                        const context = vm.createContext({
                            msg: msgForSandbox,
                            console: {
                                log: (...args) => this.engineLogger.info({ vm_log: args }, "VM Log"),
                                warn: (...args) => this.engineLogger.warn({ vm_log: args }, "VM Warn"),
                                error: (...args) => this.engineLogger.error({ vm_log: args }, "VM Error")
                            },
                            db: {
                                all: async (sql) => new Promise((resolve, reject) => {
                                    if (!this.internalDb) return reject(new Error("Database not initialized"));
                                    if (!sql.trim().toUpperCase().startsWith('SELECT')) return reject(new Error("Database access is read-only."));
                                    this.internalDb.all(sql, (err, rows) => err ? reject(err) : resolve(rows));
                                }),
                                get: async (sql) => new Promise((resolve, reject) => {
                                    if (!this.internalDb) return reject(new Error("Database not initialized"));
                                    if (!sql.trim().toUpperCase().startsWith('SELECT')) return reject(new Error("Database access is read-only."));
                                    this.internalDb.all(sql, (err, rows) => err ? reject(err) : resolve(rows && rows.length > 0 ? rows[0] : null));
                                })
                            }
                        });

                        // Compile and Cache the V8 Script
                        let cached = this.scriptCache.get(target.id);
                        if (!cached || cached.rawCode !== target.code) {
                            const cleanCode = target.code.replace(/\u00A0/g, " ");
                            cached = {
                                script: new vm.Script(`(async () => { ${cleanCode} })()`),
                                rawCode: target.code
                            };
                            this.scriptCache.set(target.id, cached);
                        }
                        
                        // Execute with strict timeout
                        resultMsg = await cached.script.runInContext(context, { timeout: 2000 }); 

                        if (resultMsg !== null && resultMsg !== undefined) {
                            const results = Array.isArray(resultMsg) ? resultMsg : [resultMsg];
                            const declaredTopics = target.outputTopic ? target.outputTopic.split(',').map(t => t.trim()).filter(t => t) : [];

                            for (const res of results) {
                                if (!res || res.payload === undefined) continue;

                                let outputTopicsToPublish = [];

                                if (Array.isArray(resultMsg)) {
                                    if (res.topic) {
                                        outputTopicsToPublish.push(res.topic);
                                    } else {
                                        this.engineLogger.warn("Mapper Engine: Array item missing 'topic' property. Skipping.");
                                        continue;
                                    }
                                } else {
                                    const viewContext = {
                                        ...res.payload,
                                        topic: topic,
                                        brokerId: brokerId,
                                        correlationId: correlationId
                                    };

                                    if (declaredTopics.length > 0) {
                                        for (const dt of declaredTopics) {
                                            outputTopicsToPublish.push(mustache.render(dt, viewContext));
                                        }
                                    } else {
                                        if (res.topic && res.topic !== topic) {
                                             outputTopicsToPublish.push(res.topic);
                                        }
                                    }
                                }

                                for (const outputTopic of outputTopicsToPublish) {
                                    let outputPayload; 
                                    let outputPayloadForMetrics; 

                                    const shouldOutputSparkplug = isSparkplugOrigin && outputTopic.startsWith('spBv1.0/');
                                    
                                    if (shouldOutputSparkplug) {
                                        try {
                                            outputPayload = spBv10Codec.encodePayload(res.payload);
                                            outputPayloadForMetrics = JSON.stringify(res.payload, this.payloadReplacer);
                                        } catch (encodeErr) {
                                            this.engineLogger.error({ err: encodeErr, rule: rule.sourceTopic, target: target.id, payload: res.payload, correlationId }, "❌ Mapper Engine: Failed to re-encode payload as Sparkplug Protobuf.");
                                            this.updateMetrics(rule, target, topic, null, null, `Sparkplug Encoding Error: ${encodeErr.message}`, null, correlationId);
                                            continue; 
                                        }
                                    } else {
                                        outputPayload = JSON.stringify(res.payload, this.payloadReplacer);
                                        outputPayloadForMetrics = outputPayload;
                                    }

                                    const targetBrokerId = target.targetBrokerId || brokerId; 
                                    const connection = this.activeConnections.get(targetBrokerId);
                                    
                                    if (connection && connection.connected) {
                                        if (this.isPublishAllowed(targetBrokerId, outputTopic)) {
                                            const publishOptions = { qos: 1, retain: false };
                                            if (correlationId) {
                                                publishOptions.properties = {
                                                    userProperties: { correlationId: correlationId }
                                                };
                                            }

                                            connection.publish(outputTopic, outputPayload, publishOptions);
                                            
                                            this.broadcastCallback(JSON.stringify({
                                                type: 'mapped-topic-generated',
                                                brokerId: targetBrokerId, 
                                                topic: outputTopic,
                                                correlationId
                                            }));

                                            this.updateMetrics(rule, target, topic, outputPayloadForMetrics, outputTopic, null, null, correlationId);
                                        } else {
                                            const errorMessage = `Target broker '${targetBrokerId}' does not allow publishing to '${outputTopic}'. Check config.`;
                                            this.engineLogger.warn({ msg: errorMessage, correlationId });
                                            this.updateMetrics(rule, target, topic, null, null, errorMessage, null, correlationId);
                                        }
                                    } else {
                                        const errorMessage = `Target broker '${targetBrokerId}' not found or not connected. Cannot publish.`;
                                        this.engineLogger.error({ msg: errorMessage, correlationId });
                                        this.updateMetrics(rule, target, topic, null, null, errorMessage, null, correlationId);
                                    }
                                }
                            }
                        } else if (resultMsg === null) {
                            this.updateMetrics(rule, target, topic, null, null, null, "Script executed and returned null (skipped publish).", correlationId);
                        }

                    } catch (err) {
                        this.engineLogger.error({ err, ruleName: rule.sourceTopic, targetId: target.id, correlationId }, "❌ Mapper Engine: Error executing async JS transform.");
                        let errorString = "Unknown execution error"; 
                        if (err) {
                            if (err.stack) {
                                errorString = err.stack;
                            } else if (err.message) {
                                errorString = err.message;
                            } else {
                                errorString = err.toString();
                            }
                        }
                        this.updateMetrics(rule, target, topic, null, null, errorString, null, correlationId);
                    }
                }); 
                await Promise.all(targetPromises);
            }
        }
    }
}

// Wrapper to export an instance to maintain compatibility with server.js
module.exports = (connectionsMap, broadcaster, logger, longReplacer, appServerConfig) => {
    return new MapperEngine(connectionsMap, broadcaster, logger, longReplacer, appServerConfig);
};