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
const spBv10Codec = require('sparkplug-payload').get("spBv1.0"); // <-- Import Sparkplug codec

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
let payloadReplacer = null; // <--- ADDED: To store the replacer function

const DEFAULT_JS_CODE = `// 'msg' object contains msg.topic and msg.payload (parsed JSON).
// Return the modified 'msg' object to publish.
// Return null or undefined to skip publishing.

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

// The sandbox for the user's VM
const createSandbox = (msg) => {
    return {
        msg: msg,
        console: {
            log: (...args) => engineLogger.info({ vm_log: args }, "VM Log"),
            warn: (...args) => engineLogger.warn({ vm_log: args }, "VM Warn"),
            error: (...args) => engineLogger.error({ vm_log: args }, "VM Error")
        },
        JSON: JSON,
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

// Debounced function to broadcast metrics updates
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

// Update metrics for a specific rule
const updateMetrics = (rule, target, inTopic, outTopic, outPayloadStr) => {
    const ruleId = `${rule.sourceTopic}::${target.id}`;
    if (!metrics.has(ruleId)) {
        metrics.set(ruleId, { count: 0, logs: [] });
    }
    const ruleMetrics = metrics.get(ruleId);
    ruleMetrics.count++;

    // Add log entry
    ruleMetrics.logs.unshift({
        ts: new Date().toISOString(),
        inTopic: inTopic,
        outTopic: outTopic,
        outPayload: outPayloadStr.substring(0, 150) + (outPayloadStr.length > 150 ? '...' : '')
    });

    // Keep only the last 20 logs
    if (ruleMetrics.logs.length > 20) {
        ruleMetrics.logs.pop();
    }

    broadcastMetrics();
};

const processMessage = (topic, payloadObject, isSparkplugOrigin = false) => {
    const activeRules = getActiveRules();
    if (activeRules.length === 0) return;

    const originalMsg = {
        topic: topic,
        payload: payloadObject
    };

    for (const rule of activeRules) {
        if (mqttMatch(rule.sourceTopic, topic)) {
            for (const target of rule.targets) {
                if (!target.enabled) continue;

                try {
                    let msgForSandbox;
                    try {
                        msgForSandbox = JSON.parse(JSON.stringify(originalMsg));
                    } catch(copyErr) {
                        engineLogger.error({ err: copyErr, topic: topic }, "Mapper Engine: Failed to deep copy message for sandbox.");
                        continue;
                    }

                    let resultMsg = null;
                    const context = vm.createContext(createSandbox(msgForSandbox));
                    const script = new vm.Script(`(function() { ${target.code} })();`);
                    resultMsg = script.runInContext(context, { timeout: 100 });

                    if (resultMsg && resultMsg.payload !== undefined) {
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
                                continue; // Skip if encoding fails
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

                        updateMetrics(rule, target, topic, outputTopic, outputPayloadForMetrics);
                    }
                } catch (err) {
                    engineLogger.error({ err, ruleName: rule.sourceTopic, targetId: target.id }, "❌ Mapper Engine: Error executing JS transform.");
                }
            }
        }
    }
};

module.exports = (publisher, broadcaster, logger, longReplacer) => {
    if (!publisher || !broadcaster || !logger || !longReplacer) {
        throw new Error("Mapper Engine V2 requires a publisher, broadcaster, logger, and longReplacer function.");
    }
    publishCallback = publisher;
    broadcastCallback = broadcaster;
    engineLogger = logger.child({ component: 'MapperEngineV2' });
    payloadReplacer = longReplacer;

    loadMappings();

    return {
        saveMappings,
        getMappings,
        getMetrics,
        processMessage,
        DEFAULT_JS_CODE
    };
};