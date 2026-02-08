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
 * [UPDATED] Uses data/ai_tools_manifest.json as SSOT for System Prompt and Tools.
 * [SECURITY] Ensures only non-sensitive Broker IDs and Permissions are sent to LLM.
 */
const express = require('express');
const axios = require('axios');
const mqttMatch = require('mqtt-match'); 
const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); // For UUIDs
const chrono = require('chrono-node');

// --- Constants ---
const MAX_AGENT_TURNS = 8; // Limit recursion to prevent infinite loops
const LLM_TIMEOUT_MS = 120000; // 120s timeout for LLM generation

// --- State for Abort Control ---
// Map<clientId, { abortController: AbortController, res: Response }>
const activeStreams = new Map();

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

module.exports = (db, logger, config, getBrokerConnection, simulatorManager, wsManager, mapperEngine) => {
    const router = express.Router();
    const DATA_PATH = path.join(__dirname, '..', 'data');
    const MANIFEST_PATH = path.join(DATA_PATH, 'ai_tools_manifest.json');
    const MODEL_MANIFEST_PATH = path.join(DATA_PATH, 'uns_model.json');
    const SESSIONS_DIR = path.join(DATA_PATH, 'sessions'); 

    // --- Load Tools Manifest ---
    let toolsManifest = { system_prompt_template: "", tools: [] };
    const loadManifest = () => {
        try {
            if (fs.existsSync(MANIFEST_PATH)) {
                const data = fs.readFileSync(MANIFEST_PATH, 'utf8');
                toolsManifest = JSON.parse(data);
                logger.info(`✅ [ChatAPI] Loaded AI Tools Manifest (${toolsManifest.tools.length} tools).`);
            } else {
                logger.error("❌ [ChatAPI] ai_tools_manifest.json not found.");
            }
        } catch (e) {
            logger.error({ err: e }, "❌ [ChatAPI] Error loading AI Tools Manifest.");
        }
    };
    loadManifest(); // Initial load

    // --- [NEW] Helper to send chunks via HTTP AND WebSocket with Deduplication ID ---
    const sendChunk = (res, type, content, clientId) => {
        // Check if stream was aborted before sending
        if (clientId && !activeStreams.has(clientId)) return;

        // Generate a unique ID for this chunk to allow frontend deduplication
        const chunkId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        const chunkData = { type, content, id: chunkId };
        const jsonStr = JSON.stringify(chunkData);

        // 1. HTTP Streaming (NDJSON)
        if (!res.writableEnded && res.writable) {
            res.write(jsonStr + '\n');
            if (res.flush) res.flush();
        }

        // 2. WebSocket Unicast
        if (clientId) {
            wsManager.sendToClient(clientId, {
                type: 'chat-stream',
                chunkType: type,
                content: content,
                id: chunkId 
            });
        }
    };

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

    // --- User Scoped Session Directory Helper ---
    const getUserChatsDir = (req) => {
        let basePath;
        if (req.user && req.user.id) {
            basePath = path.join(SESSIONS_DIR, req.user.id, 'chats');
        } else {
            basePath = path.join(DATA_PATH, 'sessions', 'global', 'chats');
        }
        if (!fs.existsSync(basePath)) {
            try { fs.mkdirSync(basePath, { recursive: true }); } catch (e) {}
        }
        return basePath;
    };

    // --- Session Management Routes ---
    
    // LIST Sessions
    router.get('/sessions', (req, res) => {
        const chatsDir = getUserChatsDir(req);
        try {
            const files = fs.readdirSync(chatsDir).filter(f => f.endsWith('.json'));
            const sessions = files.map(file => {
                const filePath = path.join(chatsDir, file);
                const stats = fs.statSync(filePath);
                let title = "New Chat";
                try {
                    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    // Find first user message for title
                    const firstUserMsg = content.find(m => m.role === 'user');
                    if (firstUserMsg) {
                        const txt = Array.isArray(firstUserMsg.content) 
                            ? firstUserMsg.content.find(c => c.type === 'text')?.text 
                            : firstUserMsg.content;
                        if (txt) title = txt.substring(0, 30) + (txt.length > 30 ? "..." : "");
                    }
                } catch(e) {}
                
                return {
                    id: file.replace('.json', ''),
                    title: title,
                    updatedAt: stats.mtime
                };
            });
            // Sort by newest first
            sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
            res.json(sessions);
        } catch (e) {
            logger.error({ err: e }, "Failed to list chat sessions");
            res.json([]);
        }
    });

    // LOAD Session History
    router.get('/session/:id', (req, res) => {
        const chatsDir = getUserChatsDir(req);
        const filePath = path.join(chatsDir, `${req.params.id}.json`);
        // Security check
        if (!filePath.startsWith(chatsDir)) return res.status(403).json({error: "Invalid path"});

        if (fs.existsSync(filePath)) {
            try {
                const history = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                res.json(history);
            } catch (e) {
                res.json([]);
            }
        } else {
            res.json([]); // New empty session
        }
    });

    // SAVE Session History
    router.post('/session/:id', (req, res) => {
        const history = req.body;
        if (!Array.isArray(history)) {
            return res.status(400).json({ error: "History must be an array" });
        }
        const chatsDir = getUserChatsDir(req);
        const filePath = path.join(chatsDir, `${req.params.id}.json`);
        // Security check
        if (!filePath.startsWith(chatsDir)) return res.status(403).json({error: "Invalid path"});

        fs.writeFile(filePath, JSON.stringify(history, null, 2), (err) => {
            if (err) {
                logger.error({ err }, "Failed to save chat history");
                return res.status(500).json({ error: "Save failed" });
            }
            res.json({ success: true });
        });
    });

    // DELETE Session
    router.delete('/session/:id', (req, res) => {
        const chatsDir = getUserChatsDir(req);
        const filePath = path.join(chatsDir, `${req.params.id}.json`);
        // Security check
        if (!filePath.startsWith(chatsDir)) return res.status(403).json({error: "Invalid path"});

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        res.json({ success: true });
    });

    // STOP Generation Endpoint
    router.post('/stop', (req, res) => {
        const { clientId } = req.body;
        if (clientId && activeStreams.has(clientId)) {
            const stream = activeStreams.get(clientId);
            if (stream.abortController) {
                stream.abortController.abort();
                logger.info(`[ChatAPI] Aborted generation for client ${clientId}`);
            }
            activeStreams.delete(clientId);
            res.json({ success: true, message: "Generation stopped." });
        } else {
            res.json({ success: false, message: "No active generation found." });
        }
    });

    // --- Legacy /history Route (Redirects to a 'default' session) ---
    router.get('/history', (req, res) => {
        req.params.id = 'default';
        const chatsDir = getUserChatsDir(req);
        const filePath = path.join(chatsDir, `default.json`);
        if (fs.existsSync(filePath)) {
            try { res.json(JSON.parse(fs.readFileSync(filePath, 'utf8'))); } 
            catch (e) { res.json([]); }
        } else { res.json([]); }
    });

    // --- 1. Prepare Tools for OpenAI ---
    // Filter enabled tools based on config AND get descriptions for system prompt
    const getEnabledToolsInfo = () => {
        const enabledTools = [];
        const descriptions = [];

        toolsManifest.tools.forEach(toolDef => {
            const flagKey = toolDef.category; // e.g. ENABLE_READ
            if (flagKey && config.AI_TOOLS && config.AI_TOOLS[flagKey] === false) {
                return; // Skip disabled tool
            }

            // Add to Function Definitions
            enabledTools.push({
                type: "function",
                function: {
                    name: toolDef.name,
                    description: toolDef.description,
                    parameters: toolDef.inputSchema
                }
            });

            // Add to Prompt Context
            descriptions.push(`- **${toolDef.name}**: ${toolDef.description}`);
        });

        return { tools: enabledTools, context: descriptions.join('\n') };
    };

    // --- 2. Tool Implementations ---
    const toolImplementations = {
        get_application_status: async () => {
            return new Promise((resolve, reject) => {
                db.serialize(() => {
                    db.all("SELECT COUNT(*) as count FROM mqtt_events", (err, rows) => {
                        if (err) return reject(err);
                        const count = rows[0]?.count || 0;
                        resolve({ status: "online", count: count, db_limit: config.DUCKDB_MAX_SIZE_MB });
                    });
                });
            });
        },
        list_topics: async () => {
            return new Promise((resolve, reject) => {
                db.serialize(() => {
                    db.all("SELECT DISTINCT topic FROM mqtt_events ORDER BY topic ASC LIMIT 200", (err, rows) => {
                        if (err) return reject(err);
                        resolve(rows.map(r => r.topic));
                    });
                });
            });
        },
        get_topics_list: async () => {
            return new Promise((resolve, reject) => {
                db.serialize(() => {
                    db.all("SELECT DISTINCT broker_id, topic FROM mqtt_events ORDER BY broker_id, topic ASC", (err, rows) => {
                        if (err) return reject(err);
                        resolve(rows);
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
                    return `(topic ILIKE '${safeWord}' OR CAST(payload AS VARCHAR) ILIKE '${safeWord}')`;
                });

                const timeWindow = parseTimeWindow(time_expression);
                if (timeWindow) {
                    whereClauses.push(`timestamp >= '${timeWindow.start.toISOString()}'`);
                    whereClauses.push(`timestamp <= '${timeWindow.end.toISOString()}'`);
                }

                const sql = `SELECT topic, payload, timestamp FROM mqtt_events WHERE ${whereClauses.join(' AND ')} ORDER BY timestamp DESC LIMIT ${safeLimit}`;
                
                db.serialize(() => {
                    db.all(sql, (err, rows) => {
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
                    db.all(sql, ...params, (err, rows) => {
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
                db.serialize(() => {
                    db.all(sql, ...params, (err, rows) => {
                        if (err) return reject(err);
                        resolve(rows[0] || null);
                    });
                });
            });
        },
        get_model_definition: async ({ concept }) => {
            loadUnsModel();
            const lowerConcept = concept.toLowerCase();
            const results = unsModel.filter(model => 
                model.concept.toLowerCase().includes(lowerConcept) ||
                (model.keywords && model.keywords.some(k => k.toLowerCase().includes(lowerConcept)))
            );
            return { definitions: results };
        },
        update_uns_model: async ({ model_json }, user) => {
            return new Promise((resolve) => {
                if (user && user.role !== 'admin') {
                    return resolve({ error: "Forbidden: Only admins can update the UNS Model." });
                }
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
                    db.all(sql, (err, rows) => {
                        if (err) return reject(err);
                        resolve(rows);
                    });
                });
            });
        },
        infer_schema: async ({ topic_pattern }) => {
            const safePattern = escapeSQL(topic_pattern).replace(/%/g, '\\%').replace(/#/g, '%').replace(/\+/g, '%');
            return new Promise((resolve, reject) => {
                const sql = `SELECT payload FROM mqtt_events WHERE topic LIKE '${safePattern}' ORDER BY timestamp DESC LIMIT 20`;
                db.serialize(() => {
                    db.all(sql, (err, rows) => {
                        if (err) return reject(err);
                        const schema = _inferSchema(rows);
                        resolve({ inferred_schema: schema });
                    });
                });
            });
        },
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
        list_project_files: async ({}, user) => {
            const rootFiles = fs.readdirSync(path.join(__dirname, '..')).filter(f => f.endsWith('.js') || f.endsWith('.json') || f.endsWith('.md'));
            const globalFiles = fs.existsSync(DATA_PATH) ? fs.readdirSync(DATA_PATH).filter(f => f.endsWith('.svg') || f.endsWith('.json') || f.endsWith('.js')) : [];
            let privateFiles = [];
            if (user && user.id) {
                const userDir = path.join(SESSIONS_DIR, user.id, 'svgs');
                if (fs.existsSync(userDir)) {
                    privateFiles = fs.readdirSync(userDir).map(f => `${f} (Private)`);
                }
            }
            return { root_files: rootFiles, data_files: [...globalFiles, ...privateFiles] };
        },
        get_file_content: async ({ filename }, user) => {
            let resolvedPath = null;
            if (user && user.id) {
                const userSvgDir = path.join(SESSIONS_DIR, user.id, 'svgs');
                const userFile = path.join(userSvgDir, filename); 
                if (fs.existsSync(userFile)) resolvedPath = userFile;
            }
            if (!resolvedPath) {
                const globalDataFile = path.join(DATA_PATH, filename);
                if (fs.existsSync(globalDataFile)) resolvedPath = globalDataFile;
            }
            if (!resolvedPath) {
                const rootFile = path.join(__dirname, '..', filename);
                if (fs.existsSync(rootFile)) resolvedPath = rootFile;
            }
            if (!resolvedPath) return { error: "File not found." };
            
            const relative = path.relative(path.join(__dirname, '..'), resolvedPath);
            if (relative.startsWith('..') && !path.isAbsolute(resolvedPath)) return { error: "Path traversal blocked." };

            return { filename, content: fs.readFileSync(resolvedPath, 'utf8') };
        },
        save_file_to_data_directory: async ({ filename, content }, user) => {
            let targetDir = DATA_PATH;
            let accessLevel = "Global";
            if (user && user.role !== 'admin') {
                targetDir = path.join(SESSIONS_DIR, user.id, 'svgs');
                if (!fs.existsSync(targetDir)) {
                    try { fs.mkdirSync(targetDir, { recursive: true }); } catch (e) {}
                }
                accessLevel = "Private";
            } else {
                if (!fs.existsSync(targetDir)) return { error: "Global Data directory not found." };
            }
            
            const resolvedPath = path.resolve(targetDir, path.basename(filename)); 
            if (!resolvedPath.startsWith(targetDir)) return { error: "Path traversal blocked." };

            fs.writeFileSync(resolvedPath, content, 'utf8');
            return { success: true, path: `${accessLevel}/data/${filename}`, note: accessLevel === "Private" ? "File saved to your private workspace." : "File saved globally." };
        },
        create_dynamic_view: async ({ view_name, svg_content, js_content }, user) => {
            try {
                const baseName = view_name.replace(/[^a-zA-Z0-9_-]/g, '_');
                const svgFilename = `${baseName}.svg`;
                const jsFilename = `${baseName}.svg.js`;
                
                let targetDir = DATA_PATH;
                let contextMessage = "Global";
                if (user && user.id) {
                    targetDir = path.join(SESSIONS_DIR, user.id, 'svgs');
                    contextMessage = "Private (User)";
                    if (!fs.existsSync(targetDir)) {
                        fs.mkdirSync(targetDir, { recursive: true });
                    }
                }

                const svgPath = path.join(targetDir, svgFilename);
                const jsPath = path.join(targetDir, jsFilename);

                fs.writeFileSync(svgPath, svg_content, 'utf8');
                fs.writeFileSync(jsPath, js_content, 'utf8');
                
                return { 
                    success: true, 
                    message: `View '${baseName}' created successfully in ${contextMessage} storage. Go to the SVG View tab to select it.` 
                };
            } catch (err) {
                logger.error({ err }, "[ChatAPI] create_dynamic_view error");
                return { error: err.message };
            }
        },
        get_available_svg_views: async ({}, user) => {
            const globalFiles = fs.readdirSync(DATA_PATH).filter(f => f.endsWith('.svg'));
            let allFiles = new Set(globalFiles);
            if (user && user.id) {
                const userDir = path.join(SESSIONS_DIR, user.id, 'svgs');
                if (fs.existsSync(userDir)) {
                    const privateFiles = fs.readdirSync(userDir).filter(f => f.endsWith('.svg'));
                    privateFiles.forEach(f => allFiles.add(f)); 
                }
            }
            return { svg_files: Array.from(allFiles).sort() };
        },
        get_mapper_config: async () => {
            if (!mapperEngine) return { error: "Mapper Engine not available." };
            return { config: mapperEngine.getMappings() };
        },
        update_mapper_rule: async ({ sourceTopic, targetTopic, targetCode }) => {
            if (!mapperEngine) return { error: "Mapper Engine not available." };
            const config = mapperEngine.getMappings();
            const activeVersion = config.versions.find(v => v.id === config.activeVersionId);
            if (!activeVersion) return { error: "No active mapper version found." };

            let rule = activeVersion.rules.find(r => r.sourceTopic.trim() === sourceTopic.trim());
            if (!rule) {
                rule = { sourceTopic: sourceTopic.trim(), targets: [] };
                activeVersion.rules.push(rule);
            }

            // SANITIZATION: Handle non-breaking spaces from LLMs
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
        const { messages, clientId } = req.body; 
        if (!messages) return res.status(400).json({ error: "Missing messages." });
        if (!config.LLM_API_KEY) return res.status(500).json({ error: "LLM_API_KEY is not configured." });

        // Setup Abort Controller for this request
        const abortController = new AbortController();
        if (clientId) {
            activeStreams.set(clientId, { abortController, res });
        }

        let apiUrl = config.LLM_API_URL;
        if (!apiUrl.endsWith('/')) apiUrl += '/';
        apiUrl += 'chat/completions';

        // Set Headers for Streaming Response
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (res.flushHeaders) res.flushHeaders();

        // Padding to force Proxy buffer flush
        const padding = " ".repeat(4096); 
        res.write(`{"type":"ping","content":"padding_ignored"}${padding}\n`);
        if (res.flush) res.flush();

        sendChunk(res, 'status', 'Processing request...', clientId);

        // --- SECURITY: Build Broker Context ---
        const brokerContext = config.BROKER_CONFIGS.map(b => {
            const pubRules = (b.publish && b.publish.length > 0) ? JSON.stringify(b.publish) : "READ-ONLY";
            return `- Broker '${b.id}': Publish Allowed=${pubRules}`;
        }).join('\n');

        // --- PREPARE TOOLS & CONTEXT ---
        const { tools: enabledTools, context: toolsContext } = getEnabledToolsInfo();

        // --- Use Template from Manifest ---
        let systemPromptText = toolsManifest.system_prompt_template;
        if (!systemPromptText) {
            // Fallback if manifest fails
            systemPromptText = "You are an expert UNS Architect. CONTEXT:\n{{BROKER_CONTEXT}}\n\nTOOLS:\n{{TOOLS_CONTEXT}}";
        }
        
        // Inject Dynamic Contexts
        systemPromptText = systemPromptText.replace('{{BROKER_CONTEXT}}', brokerContext);
        systemPromptText = systemPromptText.replace('{{TOOLS_CONTEXT}}', toolsContext);

        const systemMessage = { role: "system", content: systemPromptText };
        const safeUserMessages = messages.filter(m => m.role !== 'system');
        let conversation = [systemMessage, ...safeUserMessages];

        const headers = { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.LLM_API_KEY}`
        };

        // --- AGENT LOOP ---
        let turnCount = 0;
        let finalMessageSent = false;

        try {
            while (turnCount < MAX_AGENT_TURNS && !finalMessageSent) {
                if (abortController.signal.aborted) {
                    throw new Error("Generation cancelled by user.");
                }
                turnCount++;
                sendChunk(res, 'status', turnCount === 1 ? 'Thinking...' : `Analyzing results (Turn ${turnCount})...`, clientId);

                const requestPayload = {
                    model: config.LLM_MODEL,
                    messages: conversation,
                    stream: false, 
                    temperature: 0.1,
                    tools: enabledTools.length > 0 ? enabledTools : undefined,
                    tool_choice: enabledTools.length > 0 ? "auto" : undefined
                };

                const response = await axios.post(apiUrl, requestPayload, { 
                    headers, 
                    timeout: LLM_TIMEOUT_MS,
                    signal: abortController.signal 
                });

                const message = response.data.choices[0].message;

                // Case 1: The model wants to call tools
                if (message.tool_calls && message.tool_calls.length > 0) {
                    conversation.push(message); 
                    for (const toolCall of message.tool_calls) {
                        if (abortController.signal.aborted) throw new Error("Generation cancelled by user.");

                        const fnName = toolCall.function.name;
                        sendChunk(res, 'tool_start', { name: fnName }, clientId);
                        
                        let result;
                        let duration = 0;
                        const startTime = Date.now();

                        try {
                            if (toolImplementations[fnName]) { 
                                let args = {};
                                try { args = JSON.parse(toolCall.function.arguments); } catch(e) {}
                                result = await toolImplementations[fnName](args, req.user);
                                result = JSON.stringify(result);
                            } else {
                                result = JSON.stringify({ error: "Tool not implemented on server." });
                            }
                        } catch (err) {
                            logger.error({ err }, `[ChatAPI] Tool error ${fnName}`);
                            result = JSON.stringify({ error: err.message });
                        }
                        
                        duration = Date.now() - startTime;
                        sendChunk(res, 'tool_result', { name: fnName, result: "Done", duration }, clientId);

                        conversation.push({
                            tool_call_id: toolCall.id,
                            role: "tool",
                            name: fnName,
                            content: result
                        });
                    }
                } 
                // Case 2: The model generated a final text response
                else {
                    sendChunk(res, 'message', message, clientId);
                    finalMessageSent = true;
                }
            }

            if (!finalMessageSent) {
                sendChunk(res, 'error', "Max agent turns reached. Stopping execution.", clientId);
            }

        } catch (error) {
            if (error.message === "Generation cancelled by user." || error.code === 'ERR_CANCELED') {
                sendChunk(res, 'status', '⛔ Generation Stopped by User', clientId);
            } else if (error.response) {
                 const apiMsg = error.response.data?.error?.message || "Unknown Upstream Error";
                 sendChunk(res, 'error', `API Error ${error.response.status}: ${apiMsg}`, clientId);
            } else {
                 const msg = error.message;
                 if (msg.includes("timeout")) {
                    sendChunk(res, 'error', "The AI took too long to respond (Timeout).", clientId);
                } else {
                    sendChunk(res, 'error', msg, clientId);
                }
            }
        } finally {
            if (clientId) activeStreams.delete(clientId);
            res.end();
        }
    });

    return router;
};