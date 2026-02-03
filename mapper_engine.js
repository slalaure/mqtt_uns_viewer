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
 * Supports versioning, multi-target rules, JS/Mustache modes, and metrics.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mustache = require('mustache');
const mqttMatch = require('mqtt-match');
const spBv10Codec = require('sparkplug-payload').get("spBv10"); 
const MAPPINGS_FILE_PATH = path.join(__dirname, 'data', 'mappings.json');

let config = {
    versions: [],
    activeVersionId: null
};
let metrics = new Map(); 
let metricsUpdateTimer = null;
let activeConnections = new Map();
let broadcastCallback = (message) => {};
let engineLogger = null;
let payloadReplacer = null; 
let internalDb = null; 
//  Store server configuration for permission checks
let serverConfig = null;

const DEFAULT_JS_CODE = `// 'msg' object contains msg.topic, msg.payload (parsed JSON), and msg.brokerId.
// 'db' object is available with await db.all(sql) and await db.get(sql).
// Return the modified 'msg' object to publish.
// Return null or undefined to skip publishing.
/* // Example: Get average of last 5 values for this topic
try {
    const sql = \`
        SELECT AVG(CAST(payload->>'value' AS DOUBLE)) as avg_val 
        FROM (
            SELECT payload FROM mqtt_events 
            WHERE topic = '\${msg.topic}' AND broker_id = '\${msg.brokerId}'
            ORDER BY timestamp DESC 
            LIMIT 5
        )
    \`;
    const result = await db.get(sql);
    if (result && result.avg_val) {
        msg.payload.average_5 = result.avg_val;
    }
} catch (e) {
    console.error(\"DB query failed: \" + e.message);
}
*/
return msg;
`;

// Helper to create a new, empty version
const createNewVersion = (name) => {
    const newVersionId = `v_${Date.now()}`;
    return {
        id: newVersionId,
        name: name || `Version ${config.versions.length + 1}`,
        createdAt: new Date().toISOString(),
        rules: [] 
    };
};

const createSandbox = (msg) => {
    return {
        msg: msg,
        console: {
            log: (...args) => engineLogger.info({ vm_log: args }, "VM Log"),
            warn: (...args) => engineLogger.warn({ vm_log: args }, "VM Warn"),
            error: (...args) => engineLogger.error({ vm_log: args }, "VM Error")
        },
        JSON: JSON,
        db: {
            all: (sql) => new Promise((resolve, reject) => {
                if (!internalDb) return reject(new Error("Database not initialized"));
                if (!sql.trim().toUpperCase().startsWith('SELECT')) {
                    return reject(new Error("Database access is read-only (SELECT only)."));
                }
                internalDb.all(sql, (err, rows) => err ? reject(err) : resolve(rows));
            }),
            get: (sql) => new Promise((resolve, reject) => {
                if (!internalDb) return reject(new Error("Database not initialized"));
                if (!sql.trim().toUpperCase().startsWith('SELECT')) {
                    return reject(new Error("Database access is read-only (SELECT only)."));
                }
                internalDb.get(sql, (err, row) => err ? reject(err) : resolve(row));
            })
        }
    };
};

const loadMappings = () => {
    try {
        if (fs.existsSync(MAPPINGS_FILE_PATH)) {
            const data = fs.readFileSync(MAPPINGS_FILE_PATH, 'utf8');
            config = JSON.parse(data);
            if (!config.versions || !config.activeVersionId) {
                throw new Error("Invalid config structure.");
            }
            engineLogger.info(`✅ Mapper Engine: Loaded ${config.versions.length} versions. Active: ${config.activeVersionId}`);
        } else {
            engineLogger.info("Mapper Engine: No 'mappings.json' file found. Creating new default config.");
            const defaultVersion = createNewVersion("Initial Version");
            config = {
                versions: [defaultVersion],
                activeVersionId: defaultVersion.id
            };
            saveMappings(config);
        }
    } catch (err) {
        engineLogger.error({ err }, "❌ Mapper Engine: Failed to load mappings.json. Resetting to default.");
        const defaultVersion = createNewVersion("Recovery Version");
        config = {
            versions: [defaultVersion],
            activeVersionId: defaultVersion.id
        };
    }
};

const saveMappings = (newConfig) => {
    try {
        config = newConfig; 
        fs.writeFileSync(MAPPINGS_FILE_PATH, JSON.stringify(config, null, 2));
        engineLogger.info(`✅ Mapper Engine: Saved config. Active: ${config.activeVersionId}`);
        
        broadcastCallback(JSON.stringify({
            type: 'mapper-config-update',
            config: config
        }));
        return { success: true };
    } catch (err) {
        engineLogger.error({ err }, "❌ Mapper Engine: Failed to save mappings.json");
        return { success: false, error: err.message };
    }
};

const getMappings = () => {
    return config;
};

const getActiveRules = () => {
    const activeVersion = config.versions.find(v => v.id === config.activeVersionId);
    return activeVersion ? activeVersion.rules : [];
};

const getMetrics = () => {
    return Object.fromEntries(metrics);
};

const broadcastMetrics = () => {
    if (metricsUpdateTimer) return; 
    metricsUpdateTimer = setTimeout(() => {
        broadcastCallback(JSON.stringify({
            type: 'mapper-metrics-update',
            metrics: getMetrics()
        }));
        metricsUpdateTimer = null;
    }, 1500); 
};

const updateMetrics = (rule, target, inTopic, outPayloadStr, outTopic, errorMsg = null, debugMsg = null) => {
    const ruleId = `${rule.sourceTopic}::${target.id}`;
    if (!metrics.has(ruleId)) {
        metrics.set(ruleId, { count: 0, logs: [] });
    }
    const ruleMetrics = metrics.get(ruleId);
    
    if (!errorMsg && !debugMsg) {
        ruleMetrics.count++;
    }

    const logEntry = {
        ts: new Date().toISOString(),
        inTopic: inTopic,
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
        clearTimeout(metricsUpdateTimer); 
        metricsUpdateTimer = null;
        broadcastCallback(JSON.stringify({
            type: 'mapper-metrics-update',
            metrics: getMetrics()
        }));
    } else {
        broadcastMetrics();
    }
};

const rulesForTopicRequireDb = (topic) => {
    const activeRules = getActiveRules();
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
};

//  Helper to check if publishing is allowed based on server config
const isPublishAllowed = (brokerId, topic) => {
    if (!serverConfig || !serverConfig.BROKER_CONFIGS) return true; // Default allow if no config
    const brokerConfig = serverConfig.BROKER_CONFIGS.find(b => b.id === brokerId);
    if (!brokerConfig) return false; // Broker unknown
    const publishPatterns = brokerConfig.publish || [];
    if (publishPatterns.length === 0) return false; // Read-Only
    return publishPatterns.some(pattern => mqttMatch(pattern, topic));
};

const processMessage = async (brokerId, topic, payloadObject, isSparkplugOrigin = false) => {
    const activeRules = getActiveRules();
    if (activeRules.length === 0) return;

    const originalMsg = {
        topic: topic,
        payload: payloadObject,
        brokerId: brokerId 
    };

    for (const rule of activeRules) {
        if (mqttMatch(rule.sourceTopic.trim(), topic)) {
            const targetPromises = rule.targets.map(async (target) => {
                if (!target.enabled) return;

                updateMetrics(rule, target, topic, null, null, null, "Rule matched. Attempting execution...");

                try {
                    let msgForSandbox;
                    try {
                        msgForSandbox = JSON.parse(JSON.stringify(originalMsg));
                    } catch(copyErr) {
                        engineLogger.error({ err: copyErr, topic: topic }, "Mapper Engine: Failed to deep copy message for sandbox.");
                        return; 
                    }

                    let resultMsg = null;
                    const context = vm.createContext(createSandbox(msgForSandbox));
                    
                    const cleanCode = target.code.replace(/\u00A0/g, " ");
                    const script = new vm.Script(`(async () => { ${cleanCode} })();`); 
                    
                    resultMsg = await script.runInContext(context, { timeout: 2000 }); 

                    if (resultMsg && resultMsg.payload !== undefined) {
                        //  Simplified view context (removed wildcard logic)
                        const viewContext = {
                            ...resultMsg.payload,
                            topic: topic,
                            brokerId: brokerId
                        };
                        const outputTopic = mustache.render(target.outputTopic, viewContext);
                        
                        let outputPayload; 
                        let outputPayloadForMetrics; 
                        const shouldOutputSparkplug = isSparkplugOrigin && outputTopic.startsWith('spBv1.0/');

                        if (shouldOutputSparkplug) {
                            try {
                                outputPayload = spBv10Codec.encodePayload(resultMsg.payload);
                                outputPayloadForMetrics = JSON.stringify(resultMsg.payload, payloadReplacer);
                            } catch (encodeErr) {
                                engineLogger.error({ err: encodeErr, rule: rule.sourceTopic, target: target.id, payload: resultMsg.payload }, "❌ Mapper Engine: Failed to re-encode payload as Sparkplug Protobuf.");
                                return; 
                            }
                        } else {
                            outputPayload = JSON.stringify(resultMsg.payload, payloadReplacer);
                            outputPayloadForMetrics = outputPayload;
                        }

                        // Default to the source broker if targetBrokerId is not specified
                        const targetBrokerId = target.targetBrokerId || brokerId; 
                        const connection = activeConnections.get(targetBrokerId);

                        // [MODIFIED] Check connection AND permissions
                        if (connection && connection.connected) {
                            if (isPublishAllowed(targetBrokerId, outputTopic)) {
                                connection.publish(outputTopic, outputPayload, { qos: 1, retain: false });
                                
                                broadcastCallback(JSON.stringify({
                                    type: 'mapped-topic-generated',
                                    brokerId: targetBrokerId, 
                                    topic: outputTopic
                                }));
                                
                                updateMetrics(rule, target, topic, outputPayloadForMetrics, outputTopic, null, null);
                            } else {
                                const errorMessage = `Target broker '${targetBrokerId}' does not allow publishing to '${outputTopic}'. Check config.`;
                                engineLogger.warn(errorMessage);
                                updateMetrics(rule, target, topic, null, null, errorMessage, null);
                            }
                        } else {
                            const errorMessage = `Target broker '${targetBrokerId}' not found or not connected. Cannot publish.`;
                            engineLogger.error(errorMessage);
                            updateMetrics(rule, target, topic, null, null, errorMessage, null);
                            return; 
                        }
                    } else if (resultMsg === null) {
                        updateMetrics(rule, target, topic, null, null, null, "Script executed and returned null (skipped publish).");
                    }
                } catch (err) {
                    engineLogger.error({ err, ruleName: rule.sourceTopic, targetId: target.id }, "❌ Mapper Engine: Error executing async JS transform.");
                    
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
                    updateMetrics(rule, target, topic, null, null, errorString, null);
                }
            }); 
            
            await Promise.all(targetPromises);
        }
    }
};

// [MODIFIED] Accept 'serverConfig' as 5th argument
module.exports = (connectionsMap, broadcaster, logger, longReplacer, appServerConfig) => {
    if (!connectionsMap || !broadcaster || !logger || !longReplacer) {
        throw new Error("Mapper Engine V2 requires a connections map, broadcaster, logger, and longReplacer function.");
    }
    
    activeConnections = connectionsMap; 
    broadcastCallback = broadcaster;
    engineLogger = logger.child({ component: 'MapperEngineV2' });
    payloadReplacer = longReplacer;
    serverConfig = appServerConfig; // Store config

    loadMappings();

    return {
        setDb: (dbConnection) => {
            internalDb = dbConnection;
            logger.info("✅ Database connection injected into Mapper Engine.");
        },
        saveMappings,
        getMappings,
        getConfig: getMappings, // [FIX] Add alias so API calls to getConfig() work
        getMetrics,
        processMessage,
        rulesForTopicRequireDb,
        DEFAULT_JS_CODE
    };
};