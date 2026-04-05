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
 * Mapper Engine for real-time topic and payload transformation.
 */

const fs = require('fs');
const path = require('path');
const mustache = require('mustache');
const mqttMatch = require('mqtt-match');
const spBv10Codec = require('sparkplug-payload').get("spBv10"); 

const MAPPINGS_FILE_PATH = path.join(__dirname, '..', '..', 'data', 'mappings.json');

class MapperEngine {
    /**
     * @param {Map<string, import('mqtt').MqttClient>} connectionsMap Map of active MQTT connections.
     * @param {Function} broadcaster Callback function for broadcasting messages to clients.
     * @param {Object} logger Logger instance (Pino).
     * @param {Function} longReplacer Function to handle BigInt/Long serialization in JSON.
     * @param {Object} appServerConfig Application server configuration object.
     * @param {Object} sandboxPool Worker Pool for script execution.
     */
    constructor(connectionsMap, broadcaster, logger, longReplacer, appServerConfig, sandboxPool) {
        /** @type {Map<string, import('mqtt').MqttClient>} */
        this.activeConnections = connectionsMap;
        /** @type {Function} */
        this.broadcastCallback = broadcaster;
        /** @type {Object} */
        this.engineLogger = logger.child({ component: 'MapperEngine' });
        /** @type {Function} */
        this.payloadReplacer = longReplacer;
        /** @type {Object} */
        this.serverConfig = appServerConfig;
        /** @type {Object} */
        this.sandboxPool = sandboxPool;

        /** @type {MapperConfig} */
        this.config = { versions: [], activeVersionId: null };
        /** @type {Map<string, MapperMetricsEntry>} */
        this.metrics = new Map();
        /** @type {NodeJS.Timeout|null} */
        this.metricsUpdateTimer = null;
        /** @type {Object|null} */
        this.internalDb = null;
        
        this.loadMappings();
    }

    /**
     * Injects a database connection for use within mapper scripts.
     * @param {Object} dbConnection Database connection object.
     */
    setDb(dbConnection) {
        this.internalDb = dbConnection;
        this.engineLogger.info("✅ Database connection injected into Mapper Engine.");
    }

    /**
     * Creates a new mapper version structure.
     * @param {string} name Name of the version.
     * @returns {MapperVersion}
     */
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

    /**
     * Deletes a mapper version if it is not active.
     * @param {string} versionId ID of the version to delete.
     * @returns {boolean} True if deleted, false if active or not found.
     */
    deleteVersion(versionId) {
        if (versionId === this.config.activeVersionId) {
            this.engineLogger.warn(`[MapperEngine] Attempted to delete active version: ${versionId}`);
            return false;
        }

        const initialLength = this.config.versions.length;
        this.config.versions = this.config.versions.filter(v => v.id !== versionId);

        if (this.config.versions.length < initialLength) {
            this.saveMappings(this.config);
            this.engineLogger.info(`[MapperEngine] Deleted version: ${versionId}`);
            return true;
        }
        return false;
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

    isPublishAllowed(sourceId, topic) {
        if (!this.serverConfig) return true; 
        
        const allConfigs = this.serverConfig.DATA_PROVIDERS || [];
        
        const providerConfig = allConfigs.find(b => b.id === sourceId);
        
        if (!providerConfig) {
            if (this.activeConnections.has(sourceId)) return true;
            return false; 
        }
        
        const publishPatterns = providerConfig.publish || [];
        if (publishPatterns.length === 0) return false; 
        return publishPatterns.some(pattern => mqttMatch(pattern, topic));
    }

    async processMessage(sourceId, topic, payloadObject, isSparkplugOrigin = false, correlationId = null) {
        if (this.serverConfig && this.serverConfig.VIEW_MAPPER_ENABLED === false) return;

        const activeRules = this.getActiveRules();
        if (activeRules.length === 0) return;

        const originalMsg = {
            topic: topic,
            payload: payloadObject,
            sourceId: sourceId,
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

                        // Offload to SandboxPool for secure execution with memory limits
                        const cleanCode = target.code.replace(/\u00A0/g, " ");
                        const wrappedCode = `(async () => { ${cleanCode} })()`;
                        
                        const resultMsg = await this.sandboxPool.execute(wrappedCode, { msg: msgForSandbox }, 2000);

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
                                        sourceId: sourceId,
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

                                    const targetConnectorId = target.targetConnectorId || sourceId; 
                                    const connection = this.activeConnections.get(targetConnectorId);
                                    
                                    if (connection && connection.connected) {
                                        if (this.isPublishAllowed(targetConnectorId, outputTopic)) {
                                            const publishOptions = { qos: 1, retain: false };
                                            if (correlationId) {
                                                publishOptions.properties = {
                                                    userProperties: { correlationId: correlationId }
                                                };
                                            }

                                            connection.publish(outputTopic, outputPayload, publishOptions);
                                            
                                            this.broadcastCallback(JSON.stringify({
                                                type: 'mapped-topic-generated',
                                                sourceId: targetConnectorId, 
                                                topic: outputTopic,
                                                correlationId
                                            }));

                                            this.updateMetrics(rule, target, topic, outputPayloadForMetrics, outputTopic, null, null, correlationId);
                                        } else {
                                            const errorMessage = `Target connector '${targetConnectorId}' does not allow publishing to '${outputTopic}'. Check config.`;
                                            this.engineLogger.warn({ msg: errorMessage, correlationId });
                                            this.updateMetrics(rule, target, topic, null, null, errorMessage, null, correlationId);
                                        }
                                    } else {
                                        const errorMessage = `Target connector '${targetConnectorId}' not found or not connected. Cannot publish.`;
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
module.exports = (connectionsMap, broadcaster, logger, longReplacer, appServerConfig, sandboxPool) => {
    return new MapperEngine(connectionsMap, broadcaster, logger, longReplacer, appServerConfig, sandboxPool);
};