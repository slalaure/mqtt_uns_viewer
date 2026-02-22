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
 * MQTT Message Handler
 * Orchestrates the processing of a new MQTT message.
 * [UPDATED] Added Smart Namespace Throttling to protect against high-frequency spam.
 */
const spBv10Codec = require('sparkplug-payload').get("spBv1.0");

// --- Helper Functions (from server.js) ---
function longReplacer(key, value) {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    return value;
}

function safeJsonParse(str) {
    try {
        return JSON.parse(str);
    } catch (e) {
        // If parsing fails, return an object indicating it's raw data
        return { raw_payload: str };
    }
}

// --- Module-Scoped Variables ---
let logger;
let config;
let wsManager;
let mapperEngine;
let dataManager;
let broadcastDbStatus;
let alertManager;

// Production Limit: Payloads larger than 2MB are dangerous for the event loop
const MAX_PAYLOAD_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB

// --- [NEW] Smart Throttling State ---
const namespaceCounts = new Map();
const MAX_MSGS_PER_SEC_PER_NAMESPACE = 50; // Threshold for identifying a "spammy" namespace
let throttleResetTimer = null;

/**
 * The main MQTT message processing logic.
 * This is the function that will be attached to mainConnection.on('message').
 * Now accepts brokerId as the first parameter.
 */
async function handleMessage(brokerId, topic, payload) {
    const timestamp = new Date();
    let payloadObjectForMapper = null; // Object to pass to mapper
    let payloadStringForWs = null;     // String to broadcast via WS
    let payloadStringForDb = null;     // String to insert into DB
    let isSparkplugOrigin = false;
    let processingError = null;

    const handlerLogger = logger.child({ broker: brokerId }); // Create logger child for this broker

    try {
        // --- [NEW] 0.5. Smart Namespace Rate Limiting (Anti-Spam) ---
        // Group frequency by the first two levels of the topic (e.g., "factory/line1")
        const parts = topic.split('/');
        const namespace = parts.length > 1 ? `${brokerId}:${parts[0]}/${parts[1]}` : `${brokerId}:${parts[0]}`;
        
        const count = (namespaceCounts.get(namespace) || 0) + 1;
        namespaceCounts.set(namespace, count);

        // If this specific namespace is spamming, drop the message early to protect CPU/RAM
        if (count > MAX_MSGS_PER_SEC_PER_NAMESPACE) {
            if (count === MAX_MSGS_PER_SEC_PER_NAMESPACE + 1) {
                 handlerLogger.warn(`⚠️ High frequency detected on namespace '${namespace}' (> ${MAX_MSGS_PER_SEC_PER_NAMESPACE} msg/s). Throttling excess messages to protect system.`);
            }
            return; // Exit silently. Low-frequency topics are unaffected.
        }

        // --- 0. Payload Size Protection ---
        if (payload.length > MAX_PAYLOAD_SIZE_BYTES) {
            handlerLogger.warn({ topic, size: payload.length }, "⚠️ Payload too large. Truncating to prevent DoS.");
            const oversizeMsg = { 
                error: "PAYLOAD_TOO_LARGE", 
                original_size_bytes: payload.length, 
                message: "Payload exceeded safe limit (2MB) and was discarded." 
            };
            // We save the error object to DB/WS, but we DO NOT parse the massive buffer.
            payloadStringForWs = JSON.stringify(oversizeMsg);
            payloadStringForDb = payloadStringForWs;
            payloadObjectForMapper = oversizeMsg;
            // Skip decoding logic to save CPU
        } else {
            // --- 1. Decoding ---
            if (config.IS_SPARKPLUG_ENABLED && topic.startsWith('spBv1.0/')) {
                try {
                    const decodedPayload = spBv10Codec.decodePayload(payload);
                    isSparkplugOrigin = true;
                    payloadStringForWs = JSON.stringify(decodedPayload, longReplacer, 2);
                    payloadStringForDb = JSON.stringify(decodedPayload, longReplacer);
                    payloadObjectForMapper = decodedPayload;
                } catch (decodeErr) {
                    processingError = decodeErr;
                    handlerLogger.error({ msg: "❌ Error decoding Sparkplug payload", topic: topic, error_message: decodeErr.message });
                    payloadStringForWs = payload.toString('hex');
                    payloadStringForDb = JSON.stringify({ raw_payload_hex: payloadStringForWs, decode_error: decodeErr.message });
                    payloadObjectForMapper = safeJsonParse(payloadStringForDb);
                }
            } else {
                // Regular payload (try UTF-8)
                let tempPayloadString = '';
                try {
                    tempPayloadString = payload.toString('utf-8');
                    payloadStringForWs = tempPayloadString;
                    try {
                        payloadObjectForMapper = JSON.parse(tempPayloadString);
                        payloadStringForDb = tempPayloadString;
                    } catch (parseError) {
                         // Not JSON, treat as raw string
                         handlerLogger.warn(`Received non-JSON payload on topic ${topic}. Storing as raw string.`);
                         payloadObjectForMapper = { raw_payload: tempPayloadString };
                         payloadStringForDb = JSON.stringify(payloadObjectForMapper);
                    }
                } catch (utf8Err) {
                    processingError = utf8Err;
                    handlerLogger.error({ msg: "❌ Error converting payload to UTF-8", topic: topic, error_message: utf8Err.message });
                    payloadStringForWs = payload.toString('hex');
                    payloadStringForDb = JSON.stringify({ raw_payload_hex: payloadStringForWs, decode_error: utf8Err.message });
                    payloadObjectForMapper = safeJsonParse(payloadStringForDb);
                }
            }
        }

        // --- Safety Net ---
         if (payloadObjectForMapper === null) {
             handlerLogger.error(`payloadObjectForMapper remained null for topic ${topic}. This should not happen.`);
             payloadObjectForMapper = { error: "Payload processing failed unexpectedly", raw_hex: payload.slice(0, 50).toString('hex')};
             payloadStringForDb = JSON.stringify(payloadObjectForMapper);
             payloadStringForWs = payloadStringForDb;
         }
         if (payloadStringForDb === null) payloadStringForDb = JSON.stringify({ error: "DB Payload string is null"});
         if (payloadStringForWs === null) payloadStringForWs = JSON.stringify({ error: "WS Payload string is null"});

        // --- 3. Broadcast WebSocket ---
        const finalMessageObject = {
            type: 'mqtt-message',
            brokerId: brokerId, 
            topic,
            payload: payloadStringForWs,
            timestamp: timestamp.toISOString()
        };
        wsManager.broadcast(JSON.stringify(finalMessageObject));

        // --- 4. Smart DB/Mapper/Alert Execution ---
        const needsDb = mapperEngine.rulesForTopicRequireDb(topic);

        // 4a. Push to DataManager for asynchronous database writing
        dataManager.insertMessage({ 
            brokerId, 
            timestamp, 
            topic, 
            payloadStringForDb, 
            isSparkplugOrigin, 
            needsDb
        });

        // 4b. Run stateless mappers immediately for low latency
        if (!needsDb) {
            //  Pass brokerId to the mapper engine
            await mapperEngine.processMessage(brokerId, topic, payloadObjectForMapper, isSparkplugOrigin);
        }
        // If 'needsDb' is true, the mapper will be called *by the repository* after write.

        // 4c. Trigger Alert Evaluation
        if (alertManager) {
            alertManager.processMessage(brokerId, topic, payloadObjectForMapper);
        }

    } catch (err) { // Catch unexpected errors in this block's logic
        handlerLogger.error({ msg: `❌ UNEXPECTED FATAL ERROR during message processing logic for topic ${topic}`, topic: topic, error_message: err.message, error_stack: err.stack, rawPayloadStartHex: payload.slice(0, 30).toString('hex') });
    }
}

/**
 * Initializes the MQTT Handler.
 */
function init(appLogger, appConfig, appWsManager, appMapperEngine, appDataManager, appBroadcastDbStatus, appAlertManager) {
    logger = appLogger.child({ component: 'MQTTHandler' });
    config = appConfig;
    wsManager = appWsManager;
    mapperEngine = appMapperEngine;
    dataManager = appDataManager;
    broadcastDbStatus = appBroadcastDbStatus;
    alertManager = appAlertManager; 

    // Reset rate limiter every second
    if (!throttleResetTimer) {
        throttleResetTimer = setInterval(() => {
            namespaceCounts.clear();
        }, 1000);
    }

    logger.info("✅ MQTT Message Handler initialized (with Smart Throttling).");
    return handleMessage; 
}

module.exports = {
    init
};