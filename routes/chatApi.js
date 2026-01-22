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
 * Chat API (LLM Agent Endpoint)
 * Implements a Multi-Turn Loop (Max 5 steps) to handle complex agentic workflows.
 * Added explicit timeouts to Axios calls to prevent indefinite hanging.
 */
const express = require('express');
const axios = require('axios');
const mqttMatch = require('mqtt-match'); 
const fs = require('fs');
const path = require('path');
const chrono = require('chrono-node');

// --- Constants ---
const MAX_AGENT_TURNS = 8; // Limit recursion to prevent infinite loops
const LLM_TIMEOUT_MS = 120000; // 120s timeout for LLM generation

// Helper to escape SQL string
const escapeSQL = (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(/'/g, "''");
};

// Helper to parse natural language time expression into SQL bounds
const parseTimeWindow = (timeExpression) => {
    if (!timeExpression || typeof timeExpression !== 'string') return null;
    const results = chrono.parse(timeExpression);
    if (results.length === 0) return null;
    const firstResult = results[0];
    let start = firstResult.start.date();
    let end = firstResult.end ? firstResult.end.date() : new Date(); 
    return { start, end };
};

// Helper to infer schema
function _inferSchema(messages) {
    const schema = {};
    let count = 0;
    for (const msg of messages) {
        if (count > 20) break;
        try {
            const payload = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
            if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) continue;
            for (const [key, value] of Object.entries(payload)) {
                if (!schema[key]) schema[key] = typeof value;
            }
            count++;
        } catch (e) { /* ignore */ }
    }
    return schema;
}

// Map Tools to Permission Categories
const TOOL_PERMISSIONS = {
    'get_application_status': 'ENABLE_READ',
    'list_topics': 'ENABLE_READ',
    'search_data': 'ENABLE_READ',
    'get_topic_history': 'ENABLE_READ',
    'get_latest_message': 'ENABLE_READ',
    'search_uns_concept': 'ENABLE_SEMANTIC',
    'infer_schema': 'ENABLE_SEMANTIC',
    'get_model_definition': 'ENABLE_SEMANTIC',
    'publish_message': 'ENABLE_PUBLISH',
    'list_project_files': 'ENABLE_FILES',
    'get_file_content': 'ENABLE_FILES',
    'save_file_to_data_directory': 'ENABLE_FILES',
    'create_dynamic_view': 'ENABLE_FILES',
    'get_available_svg_views': 'ENABLE_FILES',
    'get_simulator_status': 'ENABLE_SIMULATOR',
    'start_simulator': 'ENABLE_SIMULATOR',
    'stop_simulator': 'ENABLE_SIMULATOR',
    'get_mapper_config': 'ENABLE_MAPPER',
    'update_mapper_rule': 'ENABLE_MAPPER',
    'update_uns_model': 'ENABLE_ADMIN',
    'prune_topic_history': 'ENABLE_ADMIN',
    'restart_application_server': 'ENABLE_ADMIN'
};

// Helper to send NDJSON chunks
const sendChunk = (res, type, content) => {
    // Prevent writing to a closed stream
    if (res.writableEnded || !res.writable) return;
    res.write(JSON.stringify({ type, content }) + '\n');
};

module.exports = (db, logger, config, getBrokerConnection, simulatorManager, wsManager, mapperEngine) => {
    const router = express.Router();
    const DATA_PATH = path.join(__dirname, '..', 'data');
    const MODEL_MANIFEST_PATH = path.join(DATA_PATH, 'uns_model.json');

    // Helper to load model
    let unsModel = [];
    const loadUnsModel = () => {
        try {
            if (fs.existsSync(MODEL_MANIFEST_PATH)) {
                unsModel = JSON.parse(fs.readFileSync(MODEL_MANIFEST_PATH, 'utf8'));
            } else {
                unsModel = [];
            }
        } catch (e) {
            logger.error({ err: e }, "[ChatAPI] Error loading UNS model.");
            unsModel = [];
        }
    };
    loadUnsModel();

    // --- 1. Tool Definitions ---
    const allTools = [
        {
            type: "function",
            function: {
                name: "get_application_status",
                description: "Get the current status of the MQTT connection and database.",
                parameters: { type: "object", properties: {}, required: [] }
            }
        },
        // --- Topic & Data ---
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
                description: "Search for messages containing specific keywords with optional time filtering. IMPORTANT: Data is mostly in ENGLISH. Translate keywords if needed.",
                parameters: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "Space-separated English keywords (e.g., 'maintenance cmms')." },
                        time_expression: { type: "string", description: "Natural language time range (e.g., 'last 24 hours', 'since yesterday')." },
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
                description: "Get historical messages for a topic, optionally filtered by a time range.",
                parameters: {
                    type: "object",
                    properties: {
                        topic: { type: "string" },
                        time_expression: { type: "string", description: "Natural language time range (e.g., 'last week', 'from 2pm to 4pm')." },
                        limit: { type: "number" }
                    },
                    required: ["topic"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "get_latest_message",
                description: "Retrieves the most recent message for a single, exact MQTT topic.",
                parameters: {
                    type: "object",
                    properties: {
                        topic: { type: "string" },
                        broker_id: { type: "string", description: "Optional. Broker ID." }
                    },
                    required: ["topic"]
                }
            }
        },
        // --- Semantic Search & Schema ---
        {
            type: "function",
            function: {
                name: "search_uns_concept",
                description: "Performs a precise, structured search based on a UNS concept (e.g., 'Work Order') defined in the model.",
                parameters: {
                    type: "object",
                    properties: {
                        concept: { type: "string", description: "The concept (e.g., 'Work Order')." },
                        filters: { type: "object", description: "Key-value pairs to filter payload." },
                        broker_id: { type: "string", description: "Optional. Broker ID." }
                    },
                    required: ["concept"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "infer_schema",
                description: "Analyzes recent messages for a topic pattern and returns the inferred JSON schema.",
                parameters: {
                    type: "object",
                    properties: {
                        topic_pattern: { type: "string", description: "Topic pattern (e.g., 'factory/line1/%')." }
                    },
                    required: ["topic_pattern"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "get_model_definition",
                description: "Get the definition (schema, topic template) for a concept from the UNS Model Manifest.",
                parameters: {
                    type: "object",
                    properties: {
                        concept: { type: "string", description: "Keyword or concept name." }
                    },
                    required: ["concept"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "update_uns_model",
                description: "Updates the content of the 'uns_model.json' file.",
                parameters: {
                    type: "object",
                    properties: {
                        model_json: { type: "string", description: "The full JSON string array." }
                    },
                    required: ["model_json"]
                }
            }
        },
        // --- Control & Publish ---
        {
            type: "function",
            function: {
                name: "publish_message",
                description: "Publish a NEW MQTT message. You MUST check 'Broker Permissions' in system prompt to choose the correct topic prefix and broker_id.",
                parameters: {
                    type: "object",
                    properties: {
                        topic: { type: "string", description: "Target topic (e.g., 'mqttunsviewer/site/crane/load')." },
                        payload: { type: "string", description: "JSON string payload." },
                        retain: { type: "boolean" },
                        broker_id: { type: "string", description: "Optional. ID of the broker to use." }
                    },
                    required: ["topic", "payload"]
                }
            }
        },
        // --- File System ---
        {
            type: "function",
            function: {
                name: "list_project_files",
                description: "Lists files in root and /data directory.",
                parameters: { type: "object", properties: {}, required: [] }
            }
        },
        {
            type: "function",
            function: {
                name: "get_file_content",
                description: "Reads a file (SVG, JS, JSON).",
                parameters: {
                    type: "object",
                    properties: {
                        filename: { type: "string", description: "Relative path (e.g., 'data/view.svg')." }
                    },
                    required: ["filename"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "save_file_to_data_directory",
                description: "Saves content to a file in the /data directory (e.g., new SVG or Simulator).",
                parameters: {
                    type: "object",
                    properties: {
                        filename: { type: "string" },
                        content: { type: "string" }
                    },
                    required: ["filename", "content"]
                }
            }
        },
        // --- [NEW] Advanced View Creation Tool ---
        {
            type: "function",
            function: {
                name: "create_dynamic_view",
                description: "Creates a new interactive SVG dashboard by saving TWO files: the SVG graphic (.svg) and its logic script (.svg.js). Use this when the user asks for a 'diagram', 'synoptic', or 'view' of data. Ensure you have identified the relevant MQTT topics first.",
                parameters: {
                    type: "object",
                    properties: {
                        view_name: { type: "string", description: "Filename without extension (e.g., 'pump_station')." },
                        svg_content: { type: "string", description: "The complete XML SVG code. Must include unique IDs for dynamic elements." },
                        js_content: { type: "string", description: "The JavaScript code using 'window.registerSvgBindings({...})' to animate the SVG based on MQTT data." }
                    },
                    required: ["view_name", "svg_content", "js_content"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "get_available_svg_views",
                description: "Lists available SVG files.",
                parameters: { type: "object", properties: {}, required: [] }
            }
        },
        // --- Mapper & Pruning ---
        {
            type: "function",
            function: {
                name: "get_mapper_config",
                description: "Get the current ETL/Mapper configuration.",
                parameters: { type: "object", properties: {}, required: [] }
            }
        },
        {
            type: "function",
            function: {
                name: "update_mapper_rule",
                description: "Adds or updates a mapping rule in the active configuration.",
                parameters: {
                    type: "object",
                    properties: {
                        sourceTopic: { type: "string" },
                        targetTopic: { type: "string" },
                        targetCode: { type: "string", description: "JS Code for transformation." }
                    },
                    required: ["sourceTopic", "targetTopic", "targetCode"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "prune_topic_history",
                description: "Deletes history for a specific topic pattern.",
                parameters: {
                    type: "object",
                    properties: {
                        topic_pattern: { type: "string" },
                        broker_id: { type: "string" }
                    },
                    required: ["topic_pattern"]
                }
            }
        },
        // --- Simulator Control ---
        {
            type: "function",
            function: {
                name: "get_simulator_status",
                description: "Get status of simulators.",
                parameters: { type: "object", properties: {}, required: [] }
            }
        },
        {
            type: "function",
            function: { name: "start_simulator", description: "Start simulator.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }
        },
        {
            type: "function",
            function: { name: "stop_simulator", description: "Stop simulator.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }
        },
        {
            type: "function",
            function: {
                name: "restart_application_server",
                description: "Triggers a restart of the main server.",
                parameters: { type: "object", properties: {}, required: [] }
            }
        }
    ];

    const enabledTools = allTools.filter(tool => {
        const permissionKey = TOOL_PERMISSIONS[tool.function.name];
        if (permissionKey && config.AI_TOOLS) {
            return config.AI_TOOLS[permissionKey] === true;
        }
        return true;
    });

    // --- 2. Tool Implementations (Promises) ---
    const toolImplementations = {
        get_application_status: async () => {
            return new Promise((resolve, reject) => {
                logger.info("[ChatAPI:get_application_status] 1. Starting request");
                db.serialize(() => {
                    logger.info("[ChatAPI:get_application_status] 2. Inside Serialize");
                    db.all("SELECT COUNT(*) as count FROM mqtt_events", (err, rows) => {
                        logger.info("[ChatAPI:get_application_status] 3. Query Finished");
                        if (err) return reject(err);
                        const count = rows[0]?.count || 0;
                        resolve({ status: "online", count: count, db_limit: config.DUCKDB_MAX_SIZE_MB });
                    });
                });
            });
        },
        list_topics: async () => {
            return new Promise((resolve, reject) => {
                logger.info("[ChatAPI:list_topics] 1. Starting request");
                db.serialize(() => {
                    logger.info("[ChatAPI:list_topics] 2. Inside Serialize");
                    db.all("SELECT DISTINCT topic FROM mqtt_events ORDER BY topic ASC LIMIT 200", (err, rows) => {
                        logger.info(`[ChatAPI:list_topics] 3. Query Finished. Found ${rows ? rows.length : 0} rows.`);
                        if (err) return reject(err);
                        resolve(rows.map(r => r.topic));
                    });
                });
            });
        },
        search_data: async ({ query, time_expression, limit }) => {
             return new Promise((resolve, reject) => {
                const safeLimit = (limit && !isNaN(parseInt(limit))) ? parseInt(limit) : 10;
                const words = query.split(/\s+/).filter(w => w.length > 0);
                if (words.length === 0) return resolve([]);
                
                let whereClauses = words.map(word => {
                    const safeWord = `%${escapeSQL(word)}%`;
                    return `(topic ILIKE '%${safeWord}%' OR CAST(payload AS VARCHAR) ILIKE '%${safeWord}%')`;
                });

                const timeWindow = parseTimeWindow(time_expression);
                if (timeWindow) {
                    whereClauses.push(`timestamp >= '${timeWindow.start.toISOString()}'`);
                    whereClauses.push(`timestamp <= '${timeWindow.end.toISOString()}'`);
                }

                const sql = `SELECT topic, payload, timestamp FROM mqtt_events WHERE ${whereClauses.join(' AND ')} ORDER BY timestamp DESC LIMIT ${safeLimit}`;
                db.serialize(() => {
                    logger.info("[ChatAPI:search_data] 2. Inside Serialize");
                    db.all(sql, (err, rows) => {
                        logger.info("[ChatAPI:search_data] 3. Query Finished");
                        if (err) return reject(err);
                        resolve(rows);
                    });
                });
            });
        },
        get_topic_history: async ({ topic, time_expression, limit }) => {
            return new Promise((resolve, reject) => {
                const safeLimit = (limit && !isNaN(parseInt(limit))) ? parseInt(limit) : 20;
                let sql = `SELECT topic, payload, timestamp, broker_id FROM mqtt_events WHERE topic = ?`;
                let params = [topic];

                const timeWindow = parseTimeWindow(time_expression);
                if (timeWindow) {
                    sql += ` AND timestamp >= ? AND timestamp <= ?`;
                    params.push(timeWindow.start.toISOString(), timeWindow.end.toISOString());
                }

                sql += ` ORDER BY timestamp DESC LIMIT ${safeLimit}`;
                db.serialize(() => {
                    logger.info("[ChatAPI:get_topic_history] 2. Inside Serialize");
                    // Using spread operator for dynamic params
                    db.all(sql, ...params, (err, rows) => {
                        logger.info("[ChatAPI:get_topic_history] 3. Query Finished");
                        if (err) return reject(err);
                        resolve(rows);
                    });
                });
            });
        },
        get_latest_message: async ({ topic, broker_id }) => {
            return new Promise((resolve, reject) => {
                let sql = `SELECT * FROM mqtt_events WHERE topic = ?`;
                let params = [topic];
                if (broker_id) { sql += " AND broker_id = ?"; params.push(broker_id); }
                sql += " ORDER BY timestamp DESC LIMIT 1";
                logger.info(`[ChatAPI:get_latest_message] 1. Topic: ${topic}`);
                db.serialize(() => {
                    logger.info("[ChatAPI:get_latest_message] 2. Inside Serialize");
                    db.all(sql, ...params, (err, rows) => {
                        logger.info("[ChatAPI:get_latest_message] 3. Query Finished");
                        if (err) return reject(err);
                        resolve(rows[0] || null);
                    });
                });
            });
        },
        get_model_definition: async ({ concept }) => {
            logger.info(`[ChatAPI:get_model_definition] Concept: ${concept}`);
            loadUnsModel();
            const lowerConcept = concept.toLowerCase();
            const results = unsModel.filter(model => 
                model.concept.toLowerCase().includes(lowerConcept) ||
                (model.keywords && model.keywords.some(k => k.toLowerCase().includes(lowerConcept)))
            );
            return { definitions: results };
        },
        update_uns_model: async ({ model_json }) => {
            return new Promise((resolve) => {
                logger.info("[ChatAPI:update_uns_model] Writing file...");
                try {
                    const newModel = JSON.parse(model_json);
                    if (!Array.isArray(newModel)) return resolve({ error: "Model must be a JSON Array." });
                    fs.writeFileSync(MODEL_MANIFEST_PATH, JSON.stringify(newModel, null, 2), 'utf8');
                    resolve({ success: true, message: "UNS Model Manifest updated successfully." });
                } catch (error) {
                    resolve({ error: `Error updating model: ${error.message}` });
                }
            });
        },
        search_uns_concept: async ({ concept, filters, broker_id }) => {
            loadUnsModel();
            logger.info(`[ChatAPI:search_uns_concept] 1. Concept: ${concept}`);
            const lowerConcept = concept.toLowerCase();
            const model = unsModel.find(m => m.concept.toLowerCase().includes(lowerConcept) || (m.keywords && m.keywords.some(k => k.toLowerCase().includes(lowerConcept))));
            if (!model) return { error: `Concept '${concept}' not found in model.` };

            const safeTopic = escapeSQL(model.topic_template).replace(/%/g, '\\%').replace(/_/g, '\\_').replace(/#/g, '%').replace(/\+/g, '%');
            let whereClauses = [`topic LIKE '${safeTopic}'`];
            if (broker_id) whereClauses.push(`broker_id = '${escapeSQL(broker_id)}'`);
            
            if (filters) {
                for (const [key, value] of Object.entries(filters)) {
                    whereClauses.push(`(payload->>'${escapeSQL(key)}') = '${escapeSQL(value)}'`);
                }
            }

            return new Promise((resolve, reject) => {
                const sql = `SELECT topic, payload, timestamp FROM mqtt_events WHERE ${whereClauses.join(' AND ')} ORDER BY timestamp DESC LIMIT 50`;
                db.serialize(() => {
                    logger.info("[ChatAPI:search_uns_concept] 2. Inside Serialize");
                    db.all(sql, (err, rows) => {
                        logger.info("[ChatAPI:search_uns_concept] 3. Query Finished");
                        if (err) return reject(err);
                        resolve(rows);
                    });
                });
            });
        },
        infer_schema: async ({ topic_pattern }) => {
            logger.info(`[ChatAPI:infer_schema] 1. Pattern: ${topic_pattern}`);
            const safePattern = escapeSQL(topic_pattern).replace(/%/g, '\\%').replace(/#/g, '%').replace(/\+/g, '%');
            return new Promise((resolve, reject) => {
                const sql = `SELECT payload FROM mqtt_events WHERE topic LIKE '${safePattern}' ORDER BY timestamp DESC LIMIT 20`;
                db.serialize(() => {
                    logger.info("[ChatAPI:infer_schema] 2. Inside Serialize");
                    db.all(sql, (err, rows) => {
                        logger.info("[ChatAPI:infer_schema] 3. Query Finished");
                        if (err) return reject(err);
                        const schema = _inferSchema(rows);
                        resolve({ inferred_schema: schema });
                    });
                });
            });
        },
        update_uns_model: async ({ model_json }) => {
            return new Promise((resolve) => {
                try {
                    const newModel = JSON.parse(model_json);
                    if (!Array.isArray(newModel)) return resolve({ error: "Model must be a JSON Array." });
                    fs.writeFileSync(MODEL_MANIFEST_PATH, JSON.stringify(newModel, null, 2), 'utf8');
                    resolve({ success: true, message: "UNS Model Manifest updated successfully." });
                } catch (error) {
                    resolve({ error: `Error updating model: ${error.message}` });
                }
            });
        },
        // ... (Publish & File tools) ...
        publish_message: async ({ topic, payload, retain = false, broker_id }) => {
            return new Promise((resolve) => {
                logger.info(`[ChatAPI:publish] Topic: ${topic}`);
                
                let targetBrokerConfig = config.BROKER_CONFIGS[0];
                if (broker_id) {
                    targetBrokerConfig = config.BROKER_CONFIGS.find(b => b.id === broker_id);
                    if (!targetBrokerConfig) return resolve({ error: `Broker '${broker_id}' not found.` });
                } else {
                    const capableBroker = config.BROKER_CONFIGS.find(b => b.publish && b.publish.some(p => mqttMatch(p, topic)));
                    if (capableBroker) targetBrokerConfig = capableBroker;
                }

                const usedBrokerId = targetBrokerConfig.id;
                const allowed = targetBrokerConfig.publish && targetBrokerConfig.publish.some(p => mqttMatch(p, topic));
                
                if (!allowed) return resolve({ error: `Forbidden: Publishing to '${topic}' not allowed on '${usedBrokerId}'.` });

                const connection = getBrokerConnection(usedBrokerId);
                if (!connection || !connection.connected) return resolve({ error: `Broker '${usedBrokerId}' disconnected.` });

                let finalPayload = payload;
                if (typeof payload === 'object') finalPayload = JSON.stringify(payload);

                connection.publish(topic, finalPayload, { qos: 1, retain: !!retain }, (err) => {
                    if (err) resolve({ error: err.message });
                    else resolve({ success: true, message: `Published to ${topic} on ${usedBrokerId}` });
                });
            });
        },
        list_project_files: async () => {
            logger.info("[ChatAPI] Listing files...");
            const rootFiles = fs.readdirSync(path.join(__dirname, '..')).filter(f => f.endsWith('.js') || f.endsWith('.json') || f.endsWith('.md'));
            const dataFiles = fs.existsSync(DATA_PATH) ? fs.readdirSync(DATA_PATH).filter(f => f.endsWith('.svg') || f.endsWith('.json') || f.endsWith('.js')) : [];
            return { root_files: rootFiles, data_files: dataFiles };
        },
        get_file_content: async ({ filename }) => {
            logger.info(`[ChatAPI] Reading file: ${filename}`);
            const resolvedPath = path.resolve(path.join(__dirname, '..'), filename);
            if (!resolvedPath.startsWith(path.join(__dirname, '..'))) return { error: "Path traversal blocked." };
            if (!fs.existsSync(resolvedPath)) return { error: "File not found." };
            return { filename, content: fs.readFileSync(resolvedPath, 'utf8') };
        },
        save_file_to_data_directory: async ({ filename, content }) => {
            logger.info(`[ChatAPI] Saving file: ${filename}`);
            const resolvedPath = path.resolve(DATA_PATH, filename);
            if (!resolvedPath.startsWith(DATA_PATH)) return { error: "Path traversal blocked. Can only save to /data." };
            fs.writeFileSync(resolvedPath, content, 'utf8');
            return { success: true, path: `data/${filename}` };
        },
        create_dynamic_view: async ({ view_name, svg_content, js_content }) => {
            try {
                // Ensure nice filenames
                const baseName = view_name.replace(/[^a-zA-Z0-9_-]/g, '_');
                const svgFilename = `${baseName}.svg`;
                const jsFilename = `${baseName}.svg.js`;
                const svgPath = path.join(DATA_PATH, svgFilename);
                const jsPath = path.join(DATA_PATH, jsFilename);

                // Write SVG
                fs.writeFileSync(svgPath, svg_content, 'utf8');
                // Write JS
                fs.writeFileSync(jsPath, js_content, 'utf8');

                logger.info(`[ChatAPI] Created dynamic view '${baseName}' in /data.`);
                return { 
                    success: true, 
                    message: `View '${baseName}' created successfully. Two files saved: data/${svgFilename} and data/${jsFilename}. Go to the SVG View tab to select it.` 
                };
            } catch (err) {
                logger.error({ err }, "[ChatAPI] create_dynamic_view error");
                return { error: err.message };
            }
        },
        get_available_svg_views: async () => {
            const files = fs.readdirSync(DATA_PATH).filter(f => f.endsWith('.svg'));
            return { svg_files: files };
        },
        get_mapper_config: async () => {
            if (!mapperEngine) return { error: "Mapper Engine not available." };
            return { config: mapperEngine.getMappings() };
        },
        update_mapper_rule: async ({ sourceTopic, targetTopic, targetCode }) => {
            logger.info("[ChatAPI] Updating mapper rule...");
            if (!mapperEngine) return { error: "Mapper Engine not available." };
            
            const config = mapperEngine.getMappings();
            const activeVersion = config.versions.find(v => v.id === config.activeVersionId);
            if (!activeVersion) return { error: "No active mapper version found." };

            let rule = activeVersion.rules.find(r => r.sourceTopic.trim() === sourceTopic.trim());
            if (!rule) {
                rule = { sourceTopic: sourceTopic.trim(), targets: [] };
                activeVersion.rules.push(rule);
            }

            const sanitizedCode = targetCode.replace(/\u00A0/g, " ").trim();
            const newTarget = {
                id: `tgt_${Date.now()}`,
                enabled: true,
                outputTopic: targetTopic.trim(),
                mode: "js",
                code: sanitizedCode
            };
            rule.targets.push(newTarget);

            const result = mapperEngine.saveMappings(config);
            return result.success ? { success: true, message: "Rule updated" } : { error: result.error };
        },
        prune_topic_history: async ({ topic_pattern, broker_id }) => {
            return new Promise((resolve) => {
                const sqlPattern = topic_pattern.replace(/'/g, "''").replace(/#/g, '%').replace(/\+/g, '%');
                let whereClauses = [`topic LIKE '${sqlPattern}'`];
                if (broker_id) whereClauses.push(`broker_id = '${escapeSQL(broker_id)}'`);
                
                db.serialize(() => {
                    db.run(`DELETE FROM mqtt_events WHERE ${whereClauses.join(' AND ')}`, function(err) {
                        if (err) resolve({ error: err.message });
                        else {
                            db.exec("CHECKPOINT; VACUUM;", () => {});
                            resolve({ success: true, count: this.changes });
                        }
                    });
                });
            });
        },
        get_simulator_status: async () => simulatorManager.getStatuses(),
        start_simulator: async ({ name }) => {
            const res = simulatorManager.startSimulator(name);
            wsManager.broadcast(JSON.stringify({ type: 'simulator-status', statuses: simulatorManager.getStatuses() }));
            return res;
        },
        stop_simulator: async ({ name }) => {
            const res = simulatorManager.stopSimulator(name);
            wsManager.broadcast(JSON.stringify({ type: 'simulator-status', statuses: simulatorManager.getStatuses() }));
            return res;
        },
        restart_application_server: async () => {
            setTimeout(() => process.exit(0), 1000);
            return { message: "Server restarting..." };
        }
    };

    // --- 3. Streamed POST Endpoint ---
    router.post('/completion', async (req, res) => {
        const { messages } = req.body;
        if (!messages) return res.status(400).json({ error: "Missing messages." });
        if (!config.LLM_API_KEY) return res.status(500).json({ error: "LLM_API_KEY is not configured." });

        let apiUrl = config.LLM_API_URL;
        if (!apiUrl.endsWith('/')) apiUrl += '/';
        apiUrl += 'chat/completions';

        // Set Headers for Streaming Response
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Initial Heartbeat
        sendChunk(res, 'status', 'Processing request...');

        const brokerContext = config.BROKER_CONFIGS.map(b => {
            const pubRules = (b.publish && b.publish.length > 0) ? JSON.stringify(b.publish) : "READ-ONLY";
            return `- Broker '${b.id}': Publish Allowed=${pubRules}`;
        }).join('\n');

        const systemMessage = {
            role: "system",
            content: `You are an expert UNS Architect and Operator.
            SYSTEM CONTEXT:
            ${brokerContext}

            DEVELOPER GUIDE FOR DYNAMIC SVG VIEWS:
            When the user asks for a diagram, use 'create_dynamic_view'.
            1. You MUST generate valid SVG XML with unique 'id' attributes for dynamic elements.
            2. You MUST generate a matching JavaScript file using this API signature:
            \`\`\`javascript
            window.registerSvgBindings({
              // Called once when SVG loads
              initialize: (svgRoot) => {
                 // Cache DOM elements here (e.g., using svgRoot.getElementById)
                 console.log("SVG initialized");
              },
              // Called on EVERY MQTT message
              update: (brokerId, topic, payload, svgRoot) => {
                 // Check if topic matches your elements
                 // Example: if (topic === 'my/sensor') { ... }
                 // 'payload' is usually a JSON object (automatically parsed).
                 // Manipulate SVG: element.setAttribute('fill', 'red') or element.textContent = ...
              },
              // Called when leaving the view or resetting history
              reset: (svgRoot) => {
                 // Reset visuals to default state
              }
            });
            \`\`\`

            CAPABILITIES:
            - READ: Inspect database, search data, infer schemas, view files.
            - WRITE: Create simulators, **create dynamic views (SVG+JS)**, map topics, publish messages.
            - MANAGE: Update UNS Model, Prune History.

            DATA LANGUAGE: English (translate user queries if needed).

            INSTRUCTIONS:
            - Use 'search_data' to find relevant topics before creating a view.
            - Use 'create_dynamic_view' to build dashboards (generate SVG XML + JS Bindings).
            - Check broker permissions before publishing or starting sims.
            - When creating mapping rules, ensure target topic is valid.
            - Use 'infer_schema' before creating complex mappings if schema is unknown.
            - Use 'search_uns_concept' for semantic queries.`
        };

        let conversation = [systemMessage, ...messages];
        const headers = { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.LLM_API_KEY}`
        };

        // --- AGENT LOOP ---
        let turnCount = 0;
        let finalMessageSent = false;

        try {
            while (turnCount < MAX_AGENT_TURNS && !finalMessageSent) {
                turnCount++;
                sendChunk(res, 'status', turnCount === 1 ? 'Thinking...' : `Analyzing results (Turn ${turnCount})...`);

                const requestPayload = {
                    model: config.LLM_MODEL,
                    messages: conversation,
                    stream: false, 
                    temperature: 0.1,
                    tools: enabledTools.length > 0 ? enabledTools : undefined,
                    tool_choice: enabledTools.length > 0 ? "auto" : undefined
                };

                // [CRITICAL] Added Timeout to prevent hanging
                const response = await axios.post(apiUrl, requestPayload, { headers, timeout: LLM_TIMEOUT_MS });
                const message = response.data.choices[0].message;

                // Case 1: The model wants to call tools
                if (message.tool_calls && message.tool_calls.length > 0) {
                    conversation.push(message); // Add assistant's message to history
                    
                    for (const toolCall of message.tool_calls) {
                        const fnName = toolCall.function.name;
                        sendChunk(res, 'tool_start', { name: fnName });
                        
                        let result;
                        let duration = 0;
                        const startTime = Date.now();

                        try {
                            if (toolImplementations[fnName]) {
                                let args = {};
                                try { args = JSON.parse(toolCall.function.arguments); } catch(e) {}
                                result = await toolImplementations[fnName](args);
                                result = JSON.stringify(result);
                            } else {
                                result = JSON.stringify({ error: "Tool not implemented on server." });
                            }
                        } catch (err) {
                            logger.error({ err }, `[ChatAPI] Tool error ${fnName}`);
                            result = JSON.stringify({ error: err.message });
                        }
                        
                        duration = Date.now() - startTime;
                        sendChunk(res, 'tool_result', { name: fnName, result: "Done", duration });

                        conversation.push({
                            tool_call_id: toolCall.id,
                            role: "tool",
                            name: fnName,
                            content: result
                        });
                    }
                    // Loop continues...
                } 
                // Case 2: The model generated a final text response
                else {
                    sendChunk(res, 'message', message);
                    finalMessageSent = true;
                }
            }

            if (!finalMessageSent) {
                sendChunk(res, 'error', "Max agent turns reached. Stopping execution.");
            }

        } catch (error) {
            const msg = error.response?.data?.error?.message || error.message;
            if (msg.includes("timeout")) {
                logger.error("LLM Timeout");
                sendChunk(res, 'error', "The AI took too long to respond (Timeout).");
            } else {
                logger.error({ err: msg }, "[ChatAPI] Stream Error");
                sendChunk(res, 'error', msg);
            }
        } finally {
            res.end();
        }
    });

    return router;
};