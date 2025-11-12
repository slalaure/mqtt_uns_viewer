/**
 * @license MIT
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
const spBv10Codec = require('sparkplug-payload').get("spBv10"); // <-- Import Sparkplug codec

const MAPPINGS_FILE_PATH = path.join(__dirname, 'data', 'mappings.json');

let config = {
    versions: [],
    activeVersionId: null
};
let metrics = new Map(); // In-memory metrics: Map<ruleId, { count: 0, logs: [] }>
let metricsUpdateTimer = null;

let publishCallback = (topic, payload) => {};
let broadcastCallback = (message) => {};
let engineLogger = null;
let payloadReplacer = null; 
let internalDb = null; // <-- [MODIFIED] Will be injected by server.js

// [MODIFIED] Updated default code to show new async DB capability
const DEFAULT_JS_CODE = `// 'msg' object contains msg.topic and msg.payload (parsed JSON).
// 'db' object is available with await db.all(sql) and await db.get(sql).
// Return the modified 'msg' object to publish.
// Return null or undefined to skip publishing.

/* // Example: Get average of last 5 values for this topic
try {
    const sql = \`
        SELECT AVG(CAST(payload->>'value' AS DOUBLE)) as avg_val 
        FROM (
            SELECT payload FROM mqtt_events 
            WHERE topic = '\${msg.topic}' 
            ORDER BY timestamp DESC 
            LIMIT 5
        )
    \`;
    const result = await db.get(sql);
    if (result && result.avg_val) {
        msg.payload.average_5 = result.avg_val;
    }
} catch (e) {
    console.error("DB query failed: " + e.message);
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
        rules: [] // Rules are now attached to source topics
    };
};

// [MODIFIED] The sandbox for the user's VM
const createSandbox = (msg) => {
    return {
        msg: msg,
        console: {
            log: (...args) => engineLogger.info({ vm_log: args }, "VM Log"),
            warn: (...args) => engineLogger.warn({ vm_log: args }, "VM Warn"),
            error: (...args) => engineLogger.error({ vm_log: args }, "VM Error")
        },
        JSON: JSON,
        // [NEW] Expose safe, Promise-based DB functions
        db: {
            all: (sql) => new Promise((resolve, reject) => {
                if (!internalDb) return reject(new Error("Database not initialized"));
                // Add basic SQL query validation (prevent writing/deleting)
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
        config = newConfig; // Update in-memory cache
        fs.writeFileSync(MAPPINGS_FILE_PATH, JSON.stringify(config, null, 2));
        engineLogger.info(`✅ Mapper Engine: Saved config. Active: ${config.activeVersionId}`);

        // Broadcast the config update to all clients
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
    // Convert Map to a plain object for JSON serialization
    return Object.fromEntries(metrics);
};

// [MODIFIED] Debounced function to broadcast metrics updates
const broadcastMetrics = () => {
    if (metricsUpdateTimer) return; // Already scheduled

    metricsUpdateTimer = setTimeout(() => {
        broadcastCallback(JSON.stringify({
            type: 'mapper-metrics-update',
            metrics: getMetrics()
        }));
        metricsUpdateTimer = null;
    }, 1500); // Broadcast metrics at most every 1.5 seconds
};

// [MODIFIED] This function is now also used to log errors and debug traces
const updateMetrics = (rule, target, inTopic, outPayloadStr, outTopic, errorMsg = null, debugMsg = null) => {
    const ruleId = `${rule.sourceTopic}::${target.id}`;
    if (!metrics.has(ruleId)) {
        metrics.set(ruleId, { count: 0, logs: [] });
    }
    const ruleMetrics = metrics.get(ruleId);
    
    // Only increment count on success
    if (!errorMsg && !debugMsg) {
        ruleMetrics.count++;
    }

    // Add log entry
    const logEntry = {
        ts: new Date().toISOString(),
        inTopic: inTopic,
    };

    if (errorMsg) {
        logEntry.error = errorMsg.substring(0, 200); // Add error field
    } else if (debugMsg) {
        logEntry.debug = debugMsg; // Add debug field
    } else {
        logEntry.outTopic = outTopic;
        logEntry.outPayload = outPayloadStr.substring(0, 150) + (outPayloadStr.length > 150 ? '...' : '');
    }

    ruleMetrics.logs.unshift(logEntry);

    // Keep only the last 20 logs
    if (ruleMetrics.logs.length > 20) {
        ruleMetrics.logs.pop();
    }
    
    // [MODIFIED] Handle immediate broadcast for errors
    if (errorMsg) {
        // If it's an error, broadcast IMMEDIATELY.
        clearTimeout(metricsUpdateTimer); // Clear any pending (TRACE) broadcast
        metricsUpdateTimer = null;
        broadcastCallback(JSON.stringify({
            type: 'mapper-metrics-update',
            metrics: getMetrics()
        }));
    } else {
        // Otherwise, use the debouncer for TRACE and success logs
        broadcastMetrics();
    }
};

/**
 * [NEW] Checks if any active rule for a topic requires DB access.
 * @param {string} topic - The incoming MQTT topic.
 * @returns {boolean} - True if a matching rule uses 'await db'.
 */
const rulesForTopicRequireDb = (topic) => {
    const activeRules = getActiveRules();
    if (activeRules.length === 0) return false;

    for (const rule of activeRules) {
        if (mqttMatch(rule.sourceTopic.trim(), topic)) {
            for (const target of rule.targets) {
                // [FIX] Sanitize code here too, just in case
                const cleanCode = target.code ? target.code.replace(/\u00A0/g, " ") : "";
                if (target.enabled && cleanCode.includes('await db')) {
                    return true; // Found a rule that needs the DB
                }
            }
        }
    }
    return false; // No matching rules need the DB
};


// [MODIFIED] This function now processes rules asynchronously
const processMessage = async (topic, payloadObject, isSparkplugOrigin = false) => {
    const activeRules = getActiveRules();
    if (activeRules.length === 0) return;

    const originalMsg = {
        topic: topic,
        payload: payloadObject
    };

    for (const rule of activeRules) {
        // [FIX] Add .trim() for robustness against whitespace errors
        if (mqttMatch(rule.sourceTopic.trim(), topic)) {
            
            // [MODIFIED] Process targets in parallel
            const targetPromises = rule.targets.map(async (target) => {
                if (!target.enabled) return;

                // --- [NEW] Add Debug Trace Log ---
                // Send a log *before* the try block to prove we matched the rule
                updateMetrics(rule, target, topic, null, null, null, "Rule matched. Attempting execution...");
                // --- [END NEW] ---

                try {
                    let msgForSandbox;
                    try {
                        msgForSandbox = JSON.parse(JSON.stringify(originalMsg));
                    } catch(copyErr) {
                        engineLogger.error({ err: copyErr, topic: topic }, "Mapper Engine: Failed to deep copy message for sandbox.");
                        return; // Don't process this target
                    }

                    let resultMsg = null;
                    const context = vm.createContext(createSandbox(msgForSandbox));
                    
                    // [FIX] Sanitize code to remove non-breaking spaces (U+000A)
                    const cleanCode = target.code.replace(/\u00A0/g, " ");

                    // [MODIFIED] Wrap code in an async IIFE to allow 'await'
                    const script = new vm.Script(`(async () => { ${cleanCode} })();`); // Use cleanCode
                    
                    // [MODIFIED] The script now returns a Promise
                    // Increased timeout for potential DB queries
                    resultMsg = await script.runInContext(context, { timeout: 2000 }); 

                    if (resultMsg && resultMsg.payload !== undefined) {
                        // The script returns the modified 'msg' object
                        const outputTopic = mustache.render(target.outputTopic, resultMsg.payload);

                        let outputPayload; // Can be String or Buffer
                        let outputPayloadForMetrics; // Always string for metrics

                        // Determine if the *output* should be Sparkplug Protobuf
                        const shouldOutputSparkplug = isSparkplugOrigin && outputTopic.startsWith('spBv1.0/');

                        if (shouldOutputSparkplug) {
                             // Source was SPB AND Target is SPB -> Re-encode Protobuf
                            try {
                                outputPayload = spBv10Codec.encodePayload(resultMsg.payload);
                                outputPayloadForMetrics = JSON.stringify(resultMsg.payload, payloadReplacer);
                            } catch (encodeErr) {
                                engineLogger.error({ err: encodeErr, rule: rule.sourceTopic, target: target.id, payload: resultMsg.payload }, "❌ Mapper Engine: Failed to re-encode payload as Sparkplug Protobuf.");
                                return; // Skip if encoding fails
                            }
                        } else {
                            // Source was SPB -> Target is JSON OR Source was JSON (Target can be JSON or SPB, but we output JSON)
                            // Output as JSON String
                            outputPayload = JSON.stringify(resultMsg.payload, payloadReplacer);
                            outputPayloadForMetrics = outputPayload;
                        }

                        // Publish (payload can be Buffer or String)
                        publishCallback(outputTopic, outputPayload);

                        broadcastCallback(JSON.stringify({
                            type: 'mapped-topic-generated',
                            topic: outputTopic
                        }));

                        // [MODIFIED] Call updateMetrics with success parameters
                        updateMetrics(rule, target, topic, outputPayloadForMetrics, outputTopic, null, null);
                    
                    } else if (resultMsg === null) {
                        // [NEW] The script ran successfully but returned null, log this as a trace
                        updateMetrics(rule, target, topic, null, null, null, "Script executed and returned null (skipped publish).");
                    }

                } catch (err) {
                    // [MODIFIED] Log error to server AND to UI metrics
                    engineLogger.error({ err, ruleName: rule.sourceTopic, targetId: target.id }, "❌ Mapper Engine: Error executing async JS transform.");
                    
                    // --- [ THIS IS THE FIX ] ---
                    // Send the full error string/stack, not just .message
                    let errorString = "Unknown execution error"; // Default
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
                    // --- [ END OF FIX ] ---
                }
            }); // end map
            
            // [MODIFIED] Wait for all targets of this rule to finish
            await Promise.all(targetPromises);
        }
    }
};


// [MODIFIED] Constructor now accepts publisher, broadcaster, logger, longReplacer
module.exports = (publisher, broadcaster, logger, longReplacer) => {
    if (!publisher || !broadcaster || !logger || !longReplacer) {
        throw new Error("Mapper Engine V2 requires a publisher, broadcaster, logger, and longReplacer function.");
    }
    // [REMOVED] DB connection - will be injected
    publishCallback = publisher;
    broadcastCallback = broadcaster;
    engineLogger = logger.child({ component: 'MapperEngineV2' });
    payloadReplacer = longReplacer;

    loadMappings();

    return {
        // [NEW] Function to inject the DB connection post-init
        setDb: (dbConnection) => {
            internalDb = dbConnection;
            logger.info("✅ Database connection injected into Mapper Engine.");
        },
        saveMappings,
        getMappings,
        getMetrics,
        processMessage,
        rulesForTopicRequireDb,
        DEFAULT_JS_CODE
    };
};