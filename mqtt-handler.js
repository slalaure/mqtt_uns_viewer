/**
 * @license MIT
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * MQTT Message Handler
 * Orchestrates the processing of a new MQTT message.
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
let db;
let dbWriteQueue; // This will be the array from server.js
let broadcastDbStatus;

/**
 * The main MQTT message processing logic.
 * This is the function that will be attached to mainConnection.on('message').
 */
async function handleMessage(topic, payload) {
    const timestamp = new Date();
   
    let payloadObjectForMapper = null; // Object to pass to mapper
    let payloadStringForWs = null;     // String to broadcast via WS
    let payloadStringForDb = null;     // String to insert into DB
    let isSparkplugOrigin = false;
    let processingError = null;

    try {
        // --- 1. Decoding ---
        if (config.IS_SPARKPLUG_ENABLED && topic.startsWith('spBv1.0/')) {
            try {
                const decodedPayload = spBv10Codec.decodePayload(payload);
                isSparkplugOrigin = true;
                // Use replacer for WS/DB string representation
                payloadStringForWs = JSON.stringify(decodedPayload, longReplacer, 2);
                payloadStringForDb = JSON.stringify(decodedPayload, longReplacer); // DB doesn't need pretty print
                payloadObjectForMapper = decodedPayload; // Pass the raw decoded object
            } catch (decodeErr) {
                processingError = decodeErr;
                logger.error({ msg: "❌ Error decoding Sparkplug payload", topic: topic, error_message: decodeErr.message });
                payloadStringForWs = payload.toString('hex'); // Fallback hex string for WS
                payloadStringForDb = JSON.stringify({ raw_payload_hex: payloadStringForWs, decode_error: decodeErr.message });
                payloadObjectForMapper = safeJsonParse(payloadStringForDb); // Pass error info to mapper
            }
        } else {
            // Regular payload (try UTF-8)
            let tempPayloadString = '';
            try {
                tempPayloadString = payload.toString('utf-8');
                payloadStringForWs = tempPayloadString; // Assume UTF-8 for WS initially
                 // Try to parse as JSON for DB and Mapper
                try {
                    payloadObjectForMapper = JSON.parse(tempPayloadString);
                    payloadStringForDb = tempPayloadString; // It's valid JSON, store as is
                } catch (parseError) {
                     // Not JSON, treat as raw string
                     logger.warn(`Received non-JSON payload on topic ${topic}. Storing as raw string.`);
                     payloadObjectForMapper = { raw_payload: tempPayloadString }; // Wrap for mapper
                     payloadStringForDb = JSON.stringify(payloadObjectForMapper); // Store wrapped object in DB
                }

            } catch (utf8Err) {
                processingError = utf8Err;
                logger.error({ msg: "❌ Error converting payload to UTF-8", topic: topic, error_message: utf8Err.message });
                payloadStringForWs = payload.toString('hex'); // Fallback hex string
                payloadStringForDb = JSON.stringify({ raw_payload_hex: payloadStringForWs, decode_error: utf8Err.message });
                payloadObjectForMapper = safeJsonParse(payloadStringForDb);
            }
        }

        // --- Safety Net (Should ideally not be needed now) ---
         if (payloadObjectForMapper === null) {
             logger.error(`payloadObjectForMapper remained null for topic ${topic}. This should not happen.`);
             // Create a fallback object
             payloadObjectForMapper = { error: "Payload processing failed unexpectedly", raw_hex: payload.toString('hex')};
             payloadStringForDb = JSON.stringify(payloadObjectForMapper);
             payloadStringForWs = payloadStringForDb; // Send error via WS too
         }
         if (payloadStringForDb === null) payloadStringForDb = JSON.stringify({ error: "DB Payload string is null"});
         if (payloadStringForWs === null) payloadStringForWs = JSON.stringify({ error: "WS Payload string is null"});


        // --- 3. Broadcast WebSocket ---
        const finalMessageObject = {
            type: 'mqtt-message',
            topic,
            payload: payloadStringForWs, // Send string representation
            timestamp: timestamp.toISOString()
        };
        wsManager.broadcast(JSON.stringify(finalMessageObject));

        // --- 4. Smart DB/Mapper Execution ---
        // [MODIFIED] Removed the if/else for batch mode. We *always* use the batch queue now.
        
        // Check if any rule for this topic needs the DB
        const needsDb = mapperEngine.rulesForTopicRequireDb(topic);
        
        // Add all data to the queue.
        dbWriteQueue.push({ 
            timestamp, 
            topic, 
            payloadStringForDb, 
            payloadObjectForMapper, // Store the object
            isSparkplugOrigin, 
            needsDb // <-- Tell the queue if this message needs deferred mapping
        });
        broadcastDbStatus();

        if (!needsDb) {
            // This mapper is simple/stateless. Run it IMMEDIATELY for low latency.
            // It won't see its own message in the DB, but it doesn't care.
            await mapperEngine.processMessage(topic, payloadObjectForMapper, isSparkplugOrigin);
        }
        // If 'needsDb' is true, the mapper will be called inside 'processDbQueue'
            
    } catch (err) { // Catch unexpected errors in this block's logic
        logger.error({ msg: `❌ UNEXPECTED FATAL ERROR during message processing logic for topic ${topic}`, topic: topic, error_message: err.message, error_stack: err.stack, rawPayloadStartHex: payload.slice(0, 30).toString('hex') });
    }
}

/**
 * Initializes the MQTT Handler.
 * @param {pino.Logger} appLogger - The main pino logger.
 * @param {object} appConfig - The application config object.
 * @param {object} appWsManager - The WebSocket Manager instance.
 * @param {object} appMapperEngine - The Mapper Engine instance.
 * @param {duckdb.Database} appDb - The DuckDB instance.
 *Ai @param {Array} appDbWriteQueue - The reference to the server's write queue.
 * @param {function} appBroadcastDbStatus - The function to broadcast DB status.
 * @returns {function} The async handleMessage function.
 */
function init(appLogger, appConfig, appWsManager, appMapperEngine, appDb, appDbWriteQueue, appBroadcastDbStatus) {
    logger = appLogger.child({ component: 'MQTTHandler' });
    config = appConfig;
    wsManager = appWsManager;
    mapperEngine = appMapperEngine;
    db = appDb;
    dbWriteQueue = appDbWriteQueue;
    broadcastDbStatus = appBroadcastDbStatus;

    logger.info("✅ MQTT Message Handler initialized.");
    return handleMessage; // Return the function itself
}

module.exports = {
    init
};