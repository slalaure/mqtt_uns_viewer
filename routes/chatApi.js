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
 * Chat API (LLM Agent Endpoint) - Full Read/Write Capabilities
 */
const express = require('express');
const axios = require('axios');
const mqttMatch = require('mqtt-match'); //  Required for permission checks
const fs = require('fs');
const path = require('path');

// [MODIFIED] Accepted 'getBrokerConnection' instead of 'getPrimaryConnection'
module.exports = (db, logger, config, getBrokerConnection) => {
    const router = express.Router();
    const MODEL_MANIFEST_PATH = path.join(__dirname, '..', 'data', 'uns_model.json');

    // --- 1. Tool Definitions ---
    const tools = [
        {
            type: "function",
            function: {
                name: "get_application_status",
                description: "Get the current status of the MQTT connection and database.",
                parameters: { type: "object", properties: {}, required: [] }
            }
        },
        {
            type: "function",
            function: {
                name: "list_topics",
                description: "List all unique MQTT topics found in the database.",
                parameters: { type: "object", properties: {}, required: [] }
            }
        },
        {
            type: "function",
            function: {
                name: "search_data",
                description: "Search for messages containing specific keywords. IMPORTANT: Data is mostly in ENGLISH. If the user asks in French, translate keywords to English (e.g., 'panne' -> 'error', 'maintenance' -> 'maintenance'). Do not send full sentences, only 1-3 distinct keywords.",
                parameters: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "Space-separated English keywords (e.g., 'maintenance cmms')." },
                        limit: { type: "number" }
                    },
                    required: ["query"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "get_topic_history",
                description: "Get recent messages for a topic. Use this to inspect JSON structure.",
                parameters: {
                    type: "object",
                    properties: {
                        topic: { type: "string" },
                        limit: { type: "number" }
                    },
                    required: ["topic"]
                }
            }
        },
        // [MODIFIED TOOL] Publish Capability now supports broker_id
        {
            type: "function",
            function: {
                name: "publish_message",
                description: "Publish a NEW MQTT message. You MUST check 'Broker Permissions' in system prompt to choose the correct topic prefix and broker_id.",
                parameters: {
                    type: "object",
                    properties: {
                        topic: { type: "string", description: "Target topic (e.g., 'mqttunsviewer/site/crane/load')." },
                        payload: { type: "string", description: "JSON payload as a string." },
                        retain: { type: "boolean", description: "Retain the message? (default: false)" },
                        broker_id: { type: "string", description: "Optional. ID of the broker to use. Defaults to primary." }
                    },
                    required: ["topic", "payload"]
                }
            }
        },
        // Simulator Tools
        {
            type: "function",
            function: {
                name: "get_simulator_status",
                description: "Get the list of all available simulators and their current state (running/stopped).",
                parameters: { type: "object", properties: {}, required: [] }
            }
        },
        {
            type: "function",
            function: {
                name: "start_simulator",
                description: "Start a specific simulator by name.",
                parameters: {
                    type: "object",
                    properties: {
                        name: { type: "string", description: "The name of the simulator (e.g., 'stark_industries', 'paris_metro')." }
                    },
                    required: ["name"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "stop_simulator",
                description: "Stop a specific simulator by name.",
                parameters: {
                    type: "object",
                    properties: {
                        name: { type: "string", description: "The name of the simulator." }
                    },
                    required: ["name"]
                }
            }
        },
        // [NEW TOOL] UNS Model Update
        {
            type: "function",
            function: {
                name: "update_uns_model",
                description: "Updates the content of the 'uns_model.json' file. Use this to add new concepts, keywords, or topic templates to the semantic model.",
                parameters: {
                    type: "object",
                    properties: {
                        model_json: { type: "string", description: "The full JSON string representing the new model array. Must be a valid JSON array of definition objects." }
                    },
                    required: ["model_json"]
                }
            }
        }
    ];

    // --- 2. Tool Implementations ---
    const toolImplementations = {
        get_application_status: async () => {
            return new Promise((resolve, reject) => {
                db.all("SELECT COUNT(*) as count FROM mqtt_events", (err, rows) => {
                    if (err) return reject(err);
                    const count = rows[0]?.count || 0;
                    resolve({ status: "online", count: count, db_limit: config.DUCKDB_MAX_SIZE_MB });
                });
            });
        },
        list_topics: async () => {
            return new Promise((resolve, reject) => {
                db.all("SELECT DISTINCT topic FROM mqtt_events ORDER BY topic ASC LIMIT 200", (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows.map(r => r.topic));
                });
            });
        },
        search_data: async ({ query, limit }) => {
             return new Promise((resolve, reject) => {
                const safeLimit = (limit && !isNaN(parseInt(limit))) ? parseInt(limit) : 10;
                
                // [IMPROVED SEARCH] Split query into words for multi-keyword matching (AND logic)
                const words = query.split(/\s+/).filter(w => w.length > 0);
                
                if (words.length === 0) return resolve([]);

                // Build dynamic SQL for each word: (topic LIKE %word% OR payload LIKE %word%)
                const conditions = words.map(word => {
                    const safeWord = `%${word.replace(/'/g, "''")}%`;
                    return `(topic ILIKE '${safeWord}' OR CAST(payload AS VARCHAR) ILIKE '${safeWord}')`;
                });

                const whereClause = conditions.join(' AND ');
                
                // Fix for DuckDB driver limit issue
                const sql = `SELECT topic, payload, timestamp FROM mqtt_events WHERE ${whereClause} ORDER BY timestamp DESC LIMIT ${safeLimit}`;
                
                logger.info(`[ChatAPI] Enhanced Search SQL: ${sql}`);

                db.all(sql, (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows);
                });
            });
        },
        get_topic_history: async ({ topic, limit }) => {
            return new Promise((resolve, reject) => {
                const safeLimit = (limit && !isNaN(parseInt(limit))) ? parseInt(limit) : 10;
                if (!topic) return resolve({ error: "Topic is missing" });
                // Fix for DuckDB driver limit issue
                const sql = `SELECT topic, payload, timestamp FROM mqtt_events WHERE topic = ? ORDER BY timestamp DESC LIMIT ${safeLimit}`;
                db.all(sql, [topic], (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows);
                });
            });
        },
        // [NEW IMPL] Smart Publish Logic with Permission Checks
        publish_message: async ({ topic, payload, retain = false, broker_id }) => {
            return new Promise((resolve) => {
                // 1. Identify Broker
                let targetBrokerConfig = config.BROKER_CONFIGS[0]; // Default to first
                
                if (broker_id) {
                    targetBrokerConfig = config.BROKER_CONFIGS.find(b => b.id === broker_id);
                    if (!targetBrokerConfig) {
                        return resolve({ error: `Broker with ID '${broker_id}' not found.` });
                    }
                } else {
                    // Try to find a broker that allows this topic if no ID is specified
                    const capableBroker = config.BROKER_CONFIGS.find(b => {
                        return b.publish && b.publish.some(p => mqttMatch(p, topic));
                    });
                    if (capableBroker) {
                        targetBrokerConfig = capableBroker;
                    }
                }

                const usedBrokerId = targetBrokerConfig.id;

                // 2. Check Permissions (Critical!)
                const allowedPublishPatterns = targetBrokerConfig.publish || [];
                const isAllowed = allowedPublishPatterns.some(pattern => mqttMatch(pattern, topic));

                if (!isAllowed) {
                    const allowedList = allowedPublishPatterns.join(', ');
                    logger.warn(`[ChatAPI] ⛔ Blocked publish to '${topic}' on broker '${usedBrokerId}'.`);
                    return resolve({ 
                        error: `Forbidden: Publishing to '${topic}' is NOT allowed on broker '${usedBrokerId}'. Allowed patterns: [${allowedList}]. Please adjust your topic.` 
                    });
                }

                // 3. Get Connection
                const connection = getBrokerConnection(usedBrokerId);
                if (!connection || !connection.connected) {
                    return resolve({ error: `MQTT Client for broker '${usedBrokerId}' is not connected. Cannot publish.` });
                }

                // 4. Prepare Payload
                let finalPayload = payload;
                if (typeof payload === 'object') {
                    finalPayload = JSON.stringify(payload);
                }

                // 5. Publish
                connection.publish(topic, finalPayload, { qos: 1, retain: !!retain }, (err) => {
                    if (err) {
                        logger.error({ err }, `[ChatAPI] Failed to publish to ${topic}`);
                        resolve({ error: err.message });
                    } else {
                        logger.info(`[ChatAPI] 🤖 Agent published to '${topic}' on '${usedBrokerId}'`);
                        resolve({ success: true, message: `Published to ${topic} on ${usedBrokerId}` });
                    }
                });
            });
        },
        get_simulator_status: async () => {
            // Need to require simulatorManager dynamically or pass it from server.js
            // Assuming it is passed in via a closure in server.js or we need to access the global one
            // Since this module exports a function called by server.js, we assume simulatorManager functions are passed or accessible.
            // **Correction**: In `server.js`, we pass `simulatorManager` now? No, checking `server.js`...
            // `mainRouter.use('/api/chat', ..., require('./routes/chatApi')(..., simulatorManager, wsManager));`
            // We need to update the export signature below if not already done.
            // Assuming standard require:
            const simulatorManager = require('../simulator'); 
            return simulatorManager.getStatuses();
        },
        start_simulator: async ({ name }) => {
            const simulatorManager = require('../simulator');
            const wsManager = require('../websocket-manager');
            const result = simulatorManager.startSimulator(name);
            
            // Broadcast status
            wsManager.broadcast(JSON.stringify({ 
                type: 'simulator-status', 
                statuses: simulatorManager.getStatuses() 
            }));
            
            return result;
        },
        stop_simulator: async ({ name }) => {
            const simulatorManager = require('../simulator');
            const wsManager = require('../websocket-manager');
            const result = simulatorManager.stopSimulator(name);
            
            // Broadcast status
            wsManager.broadcast(JSON.stringify({ 
                type: 'simulator-status', 
                statuses: simulatorManager.getStatuses() 
            }));
            
            return result;
        },
        // [NEW IMPL] Update UNS Model
        update_uns_model: async ({ model_json }) => {
            return new Promise((resolve) => {
                try {
                    let newModel;
                    try {
                        newModel = JSON.parse(model_json);
                    } catch (e) {
                        return resolve({ error: "Invalid JSON format." });
                    }

                    if (!Array.isArray(newModel)) {
                        return resolve({ error: "Model must be a JSON Array." });
                    }

                    fs.writeFileSync(MODEL_MANIFEST_PATH, JSON.stringify(newModel, null, 2), 'utf8');
                    logger.info("✅ [ChatAPI] UNS Model Manifest updated by AI Agent.");
                    
                    resolve({ success: true, message: "UNS Model Manifest updated successfully." });
                } catch (error) {
                    logger.error({ err: error }, "[ChatAPI] Error updating UNS model");
                    resolve({ error: `Error updating model: ${error.message}` });
                }
            });
        }
    };

    /**
     * POST /api/chat/completion
     */
    router.post('/completion', async (req, res) => {
        // [MODIFIED] Ignore client-side config, use server-side config
        const { messages } = req.body;

        if (!messages) {
            return res.status(400).json({ error: "Missing messages." });
        }

        // Validate server-side config exists
        if (!config.LLM_API_KEY) {
            return res.status(500).json({ error: "LLM_API_KEY is not configured on the server." });
        }

        // Clean up API URL (handle trailing slash)
        let apiUrl = config.LLM_API_URL;
        if (!apiUrl.endsWith('/')) apiUrl += '/';
        apiUrl += 'chat/completions';
        
        // --- SYSTEM PROMPT (ARCHITECT MODE) ---
        //  Dynamically generate broker permission context
        const brokerContext = config.BROKER_CONFIGS.map(b => {
            const pubRules = (b.publish && b.publish.length > 0) ? JSON.stringify(b.publish) : "READ-ONLY";
            return `- Broker '${b.id}': Publish Allowed=${pubRules}`;
        }).join('\n');

        const systemMessage = {
            role: "system",
            content: `You are an expert UNS (Unified Namespace) Architect and Operator.

            SYSTEM CONTEXT (Broker Permissions):
            ${brokerContext}

            CAPABILITIES:
            1. **READ**: You can inspect the database (list topics, history, search).
            2. **WRITE**: You can CREATE data using 'publish_message'.
            3. **MANAGE**: You can UPDATE the UNS Semantic Model using 'update_uns_model'.

            DATA LANGUAGE & SEARCH STRATEGY:
            - **CRITICAL**: The machine data and UNS structure are primarily in **ENGLISH** (e.g., "maintenance_request", "error", "workorder").
            - If the user asks in French (e.g., "Y a-t-il des maintenances prévues ?"), you MUST **translate** the intent into English keywords before calling tools.
            - Example: User "panne sur le robot" -> Tool \`search_data({ query: "robot error" })\`.
            - Do NOT use stop words (le, la, de, for, the) in the search query. Use concise technical keywords.

            UNS NAVIGATION HINTS:
            - If the user asks for a physical asset (e.g., "plane", "machine"), consider the UNS hierarchy: 'Country/Region/Site/Area/Line/Cell'.
            - If exact search fails, think of synonyms.
            - A topic like "france/isere/grenoble/transport/aviation" is valid.
            
            SIMULATOR INSTRUCTIONS:
            - If asked to "stop all simulators", first use 'get_simulator_status' to see what is running, then call 'stop_simulator' for each running simulator.
            - If asked to "start simulation", check 'get_simulator_status' first to see what is available.

            INSTRUCTIONS:
            - **CRITICAL**: You MUST respect the Broker Permissions listed above.
            - If the user asks to simulate data, you MUST choose a topic that matches the "Publish Allowed" patterns.
            - If a broker is READ-ONLY, do not attempt to publish to it.
            - If you have multiple brokers, check which one allows the topic you want to create.
            - When creating a demo, invent a realistic UNS hierarchy (e.g., Enterprise/Site/Area/Line/Cell/Tag) BUT prefix it correctly if required by permissions (e.g., 'mqttunsviewer/Enterprise/...').
            - Publish multiple messages to create a complete structure if asked.
            - Always use JSON payloads for metrics (e.g., {"value": 123, "unit": "C"}).
            
            DEBUGGING:
            - If you look for data (using get_topic_history) and find a JSON object, READ IT before answering the user about specific values like "temperature".`
        };

        const conversation = [systemMessage, ...messages];

        const requestPayload = {
            model: config.LLM_MODEL,
            messages: conversation,
            tools: tools,
            tool_choice: "auto", 
            stream: false,
            temperature: 0.1 
        };

        const headers = { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.LLM_API_KEY}`
        };

        try {
            // --- Step 1: Send Request to LLM ---
            const response1 = await axios.post(apiUrl, requestPayload, { headers });
            const message1 = response1.data.choices[0].message;

            // --- Step 2: Check for Tool Calls ---
            if (message1.tool_calls && message1.tool_calls.length > 0) {
                logger.info(`[ChatAPI] 🛠️ Model requested tools: ${message1.tool_calls.map(t => t.function.name).join(', ')}`);
                
                const conversationWithTools = [...conversation, message1];

                for (const toolCall of message1.tool_calls) {
                    const fnName = toolCall.function.name;
                    let fnArgs = {};
                    
                    try {
                        fnArgs = JSON.parse(toolCall.function.arguments);
                    } catch (e) {
                        logger.warn(`[ChatAPI] Failed to parse arguments for ${fnName}`);
                    }

                    let toolResult = "";
                    try {
                        if (toolImplementations[fnName]) {
                            const result = await toolImplementations[fnName](fnArgs);
                            toolResult = JSON.stringify(result);
                        } else {
                            toolResult = JSON.stringify({ error: "Tool not found" });
                        }
                    } catch (err) {
                        logger.error({ err }, `[ChatAPI] Error executing ${fnName}`);
                        toolResult = JSON.stringify({ error: err.message });
                    }

                    conversationWithTools.push({
                        tool_call_id: toolCall.id,
                        role: "tool",
                        name: fnName,
                        content: toolResult
                    });
                }

                // --- Step 3: Final Answer ---
                const payload2 = { 
                    model: config.LLM_MODEL, // Use server-side model
                    messages: conversationWithTools 
                };

                const response2 = await axios.post(apiUrl, payload2, { headers });
                return res.json(response2.data);

            } else {
                return res.json(response1.data);
            }

        } catch (error) {
            const status = error.response ? error.response.status : 500;
            const msg = error.response?.data?.error?.message || error.message;
            logger.error({ status, msg }, "[ChatAPI] HTTP Error");
            return res.status(status).json({ error: msg });
        }
    });

    return router;
};