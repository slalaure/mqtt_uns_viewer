/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 * * * Central Message Dispatcher
 * Orchestrates the processing of a new message from ANY data provider (MQTT, OPC UA, File, etc.).
 * [UPDATED] Handles ingress Correlation IDs or generates them if missing.
 * [UPDATED] Eradicated silent catches: Added logger tracking for deep JSON parsing failures.
 * [UPDATED] Delegated heavy JSON parsing and Sparkplug B decoding to a pool of Worker Threads to unblock Event Loop.
 */

const crypto = require('crypto');
const { Worker } = require('worker_threads');
const os = require('os');

// --- Helper Functions ---
function longReplacer(key, value) {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    return value;
}

function safeJsonParse(str, reqLogger) {
    try {
        return JSON.parse(str);
    } catch (e) {
        if (reqLogger) {
            reqLogger.debug({ err: e }, "safeJsonParse failed, falling back to raw string");
        }
        return { raw_payload: str };
    }
}

// --- Worker Pool Setup for Heavy Payload Parsing ---
const workerScript = `
    const { parentPort } = require('worker_threads');
    let spBv10Codec = null; // Lazy load to save memory if unused

    parentPort.on('message', (task) => {
        try {
            if (task.action === 'decode_sparkplug') {
                if (!spBv10Codec) spBv10Codec = require('sparkplug-payload').get("spBv1.0");
                const decoded = spBv10Codec.decodePayload(Buffer.from(task.payload));
                parentPort.postMessage({ id: task.id, result: decoded });
            } else if (task.action === 'parse_json') {
                const str = Buffer.isBuffer(task.payload) ? task.payload.toString('utf-8') : task.payload;
                const parsed = JSON.parse(str);
                parentPort.postMessage({ id: task.id, result: parsed });
            } else {
                throw new Error('Unknown action');
            }
        } catch (err) {
            parentPort.postMessage({ id: task.id, error: err.message });
        }
    });
`;

class PayloadWorkerPool {
    constructor(size) {
        this.workers = [];
        this.nextWorker = 0;
        this.callbacks = new Map();
        this.taskId = 0;

        for (let i = 0; i < size; i++) {
            const worker = new Worker(workerScript, { eval: true });
            worker.on('message', (msg) => {
                const cb = this.callbacks.get(msg.id);
                if (cb) {
                    this.callbacks.delete(msg.id);
                    if (msg.error) cb.reject(new Error(msg.error));
                    else cb.resolve(msg.result);
                }
            });
            worker.on('error', (err) => console.error('[PayloadWorkerPool] Worker Error:', err));
            this.workers.push(worker);
        }
    }

    execute(action, payload) {
        return new Promise((resolve, reject) => {
            const id = ++this.taskId;
            this.callbacks.set(id, { resolve, reject });
            const worker = this.workers[this.nextWorker];
            this.nextWorker = (this.nextWorker + 1) % this.workers.length;
            worker.postMessage({ id, action, payload });
        });
    }
}

// Instantiate pool matching CPU cores (capped at 4 to balance with other I/O tasks)
const poolSize = Math.max(2, Math.min(os.cpus().length - 1, 4));
const workerPool = new PayloadWorkerPool(poolSize);

// --- Module-Scoped Variables ---
let logger;
let config;
let wsManager;
let mapperEngine;
let dataManager;
let broadcastDbStatus;
let alertManager;
const semanticManager = require('./semantic/semanticManager'); // Semantic Engine

const MAX_PAYLOAD_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB

// --- Smart Throttling State ---
const namespaceCounts = new Map();
const MAX_MSGS_PER_SEC_PER_NAMESPACE = 50; 
let throttleResetTimer = null;

/**
 * The main message processing logic.
 * Receives messages from any BaseProvider implementation.
 * @param {string} providerId - The ID of the provider sending the data
 * @param {string} topic - The destination topic/node
 * @param {any} payload - The payload (String, Buffer, or parsed JS Object)
 * @param {Object} options - Metadata injected by the provider (e.g., isSparkplugOrigin, correlationId)
 */
async function handleMessage(providerId, topic, payload, options = {}) {
    const timestamp = new Date();
    
    // Use ingress correlationId if provided, otherwise generate a new one
    const { isSparkplugOrigin = false, rawBuffer = null, decodeError = null, correlationId: ingressCorrelationId } = options;
    const correlationId = ingressCorrelationId || crypto.randomUUID(); 

    let payloadObjectForMapper = null; 
    let payloadStringForWs = null;     
    let payloadStringForDb = null;     

    // Include correlationId in all logs for this message
    const handlerLogger = logger.child({ provider: providerId, correlationId }); 

    try {
        // --- 1. Smart Namespace Rate Limiting (Anti-Spam) ---
        const parts = topic.split('/');
        const namespace = parts.length > 1 ? `${providerId}:${parts[0]}/${parts[1]}` : `${providerId}:${parts[0]}`;

        const count = (namespaceCounts.get(namespace) || 0) + 1;
        namespaceCounts.set(namespace, count);

        if (count > MAX_MSGS_PER_SEC_PER_NAMESPACE) {
            if (count === MAX_MSGS_PER_SEC_PER_NAMESPACE + 1) {
                 handlerLogger.warn(`⚠️ High frequency detected on namespace '${namespace}'. Throttling excess messages.`);
            }
            return; 
        }

        // --- 2. Payload Size Protection ---
        const payloadSize = rawBuffer ? rawBuffer.length : (Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(typeof payload === 'string' ? payload : JSON.stringify(payload) || '', 'utf8'));

        if (payloadSize > MAX_PAYLOAD_SIZE_BYTES) {
            handlerLogger.warn({ topic, size: payloadSize }, "⚠️ Payload too large. Truncating to prevent DoS.");
            const oversizeMsg = { 
                error: "PAYLOAD_TOO_LARGE", 
                original_size_bytes: payloadSize, 
                message: "Payload exceeded safe limit (2MB) and was discarded." 
            };
            payloadStringForWs = JSON.stringify(oversizeMsg);
            payloadStringForDb = payloadStringForWs;
            payloadObjectForMapper = oversizeMsg;
        } else {
            // --- 3. Payload Formatting & Normalization (Worker Pool Offloading) ---
            if (decodeError) {
                // The provider tried to decode it (e.g. Protobuf) but failed
                payloadStringForWs = rawBuffer ? rawBuffer.toString('hex') : "unknown_hex";
                payloadStringForDb = JSON.stringify({ raw_payload_hex: payloadStringForWs, decode_error: decodeError });
                payloadObjectForMapper = safeJsonParse(payloadStringForDb, handlerLogger);

            } else if (isSparkplugOrigin && rawBuffer && Buffer.isBuffer(rawBuffer)) {
                // [NEW] Offloaded Sparkplug decoding to Worker Thread
                try {
                    payloadObjectForMapper = await workerPool.execute('decode_sparkplug', rawBuffer);
                    payloadStringForWs = JSON.stringify(payloadObjectForMapper, longReplacer, 2);
                    payloadStringForDb = JSON.stringify(payloadObjectForMapper, longReplacer);
                } catch (err) {
                    handlerLogger.error({ err, topic }, "❌ Error decoding Sparkplug payload in Worker");
                    payloadStringForWs = rawBuffer.toString('hex');
                    payloadStringForDb = JSON.stringify({ raw_payload_hex: payloadStringForWs, decode_error: err.message });
                    payloadObjectForMapper = { raw_payload_hex: payloadStringForWs, decode_error: err.message };
                }
            } else if (typeof payload === 'object' && !Buffer.isBuffer(payload)) {
                // The Provider ALREADY decoded the payload into a JS Object (e.g. legacy Sparkplug logic or HTTP ingest)
                payloadObjectForMapper = payload;
                payloadStringForWs = JSON.stringify(payload, longReplacer, 2);
                payloadStringForDb = JSON.stringify(payload, longReplacer);
            } else {
                // Standard String/Buffer payload parsing
                let tempPayloadString = Buffer.isBuffer(payload) ? payload.toString('utf-8') : payload;
                payloadStringForWs = tempPayloadString;
                
                try {
                    // [NEW] Offloaded JSON parsing to Worker Thread
                    payloadObjectForMapper = await workerPool.execute('parse_json', payload);
                    payloadStringForDb = tempPayloadString;
                } catch (parseError) {
                     handlerLogger.debug({ err: parseError, topic }, `Received non-JSON payload. Storing as raw string.`);
                     payloadObjectForMapper = { raw_payload: tempPayloadString };
                     payloadStringForDb = JSON.stringify(payloadObjectForMapper);
                }
            }

            // --- 3.5 Semantic Enrichment (I3X) ---
            const semanticMatch = semanticManager.resolveTopic(topic);
            if (semanticMatch && payloadObjectForMapper && typeof payloadObjectForMapper === 'object') {
                payloadObjectForMapper._i3x = {
                    elementId: semanticMatch.elementId,
                    typeId: semanticMatch.typeId,
                    isComposition: semanticMatch.isComposition
                };
                try {
                    // Re-stringify so DuckDB and WebSockets receive the enriched payload
                    payloadStringForDb = JSON.stringify(payloadObjectForMapper, longReplacer);
                    payloadStringForWs = JSON.stringify(payloadObjectForMapper, longReplacer, 2);
                } catch (stringifyErr) {
                    handlerLogger.error({ err: stringifyErr }, "Failed to stringify enriched I3X payload");
                }
            }
        }

        // --- 4. Broadcast WebSocket ---
        const finalMessageObject = {
            type: 'mqtt-message',
            brokerId: providerId, 
            topic,
            payload: payloadStringForWs,
            timestamp: timestamp.toISOString(),
            correlationId // Send trace ID to UI if needed
        };
        wsManager.broadcast(JSON.stringify(finalMessageObject));

        // --- 5. DB / Mapper / Alert Execution ---
        const needsDb = mapperEngine.rulesForTopicRequireDb(topic);
        dataManager.insertMessage({ 
            brokerId: providerId, 
            timestamp, 
            topic, 
            payloadStringForDb, 
            isSparkplugOrigin, 
            needsDb,
            correlationId // Propagate to DB
        });

        if (!needsDb) {
            await mapperEngine.processMessage(providerId, topic, payloadObjectForMapper, isSparkplugOrigin, correlationId);
        }

        if (alertManager) {
            alertManager.processMessage(providerId, topic, payloadObjectForMapper, correlationId);
        }

        // --- 6. Webhook Execution ---
        const webhookManager = require('./webhookManager');
        webhookManager.trigger(topic, payloadObjectForMapper, correlationId);

    } catch (err) {
        handlerLogger.error({ msg: `❌ UNEXPECTED ERROR processing topic ${topic}`, error_message: err.message });
    }
}

/**
 * Initializes the Central Message Dispatcher.
 */
function init(appLogger, appConfig, appWsManager, appMapperEngine, appDataManager, appBroadcastDbStatus, appAlertManager) {
    logger = appLogger.child({ component: 'MessageDispatcher' });
    config = appConfig;
    wsManager = appWsManager;
    mapperEngine = appMapperEngine;
    dataManager = appDataManager;
    broadcastDbStatus = appBroadcastDbStatus;
    alertManager = appAlertManager; 

    if (!throttleResetTimer) {
        throttleResetTimer = setInterval(() => { namespaceCounts.clear(); }, 1000);
    }
    logger.info("✅ Central Message Dispatcher initialized (Protocol Agnostic).");

    return handleMessage; 
}

module.exports = { init };