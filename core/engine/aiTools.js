/**
 * @license Apache License, Version 2.0 (the "License")
 * @author Sebastien Lalaurette
 * * AI Tools Centralized Implementations
 * Extracted to ensure exact parity in business logic between internal Chat and external MCP.
 * Requires context injection to perform direct database and file operations securely.
 */
const fs = require('fs');
const path = require('path');
const chrono = require('chrono-node');
const mqttMatch = require('mqtt-match');

// --- Helpers ---
const escapeSQL = (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(/'/g, "''");
};

const parseTimeWindow = (timeExpression) => {
    if (!timeExpression || typeof timeExpression !== 'string') return null;
    const results = chrono.parse(timeExpression);
    if (results.length === 0) return null;
    const firstResult = results[0];
    let start = firstResult.start.date();
    let end = firstResult.end ? firstResult.end.date() : new Date(); 
    return { start, end };
};

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

class AiTools {
    constructor(context) {
        this.db = context.db;
        this.logger = context.logger;
        this.config = context.config;
        this.getConnectorConnection = context.getConnectorConnection;
        this.simulatorManager = context.simulatorManager;
        this.wsManager = context.wsManager;
        this.mapperEngine = context.mapperEngine;
        this.dataManager = context.dataManager;
        this.alertManager = context.alertManager;
        this.aiActionManager = context.aiActionManager;
        
        this.ROOT_PATH = context.ROOT_PATH;
        this.DATA_PATH = context.DATA_PATH;
        this.SESSIONS_DIR = context.SESSIONS_DIR;
        this.MODEL_MANIFEST_PATH = context.MODEL_MANIFEST_PATH;

        this.unsModel = [];
        this.loadUnsModel();
    }

    loadUnsModel() {
        try {
            if (fs.existsSync(this.MODEL_MANIFEST_PATH)) {
                this.unsModel = JSON.parse(fs.readFileSync(this.MODEL_MANIFEST_PATH, 'utf8'));
            } else {
                this.unsModel = [];
            }
        } catch (e) {
            this.logger.error({ err: e }, "[AiTools] Error loading UNS model.");
            this.unsModel = [];
        }
    }

    getImplementations() {
        return {
            // --- Perennial Storage Tools ---
            describe_perennial_storage: async () => {
                if (!this.dataManager || typeof this.dataManager.getPerennialSchema !== 'function') {
                    return { error: "Perennial storage schema inspection is not implemented or no perennial storage is currently active." };
                }
                try {
                    const schemaInfo = await this.dataManager.getPerennialSchema();
                    return { content: [{ type: "text", text: JSON.stringify(schemaInfo, null, 2) }] };
                } catch (e) {
                    return { error: `Failed to describe storage: ${e.message}` };
                }
            },
            
            get_dlq_status: async () => {
                try {
                    const dlqManager = require('../../storage/dlqManager');
                    const messages = dlqManager.getMessages();
                    return { 
                        content: [{ 
                            type: "text", 
                            text: JSON.stringify({ 
                                total_failed_messages: messages.length,
                                messages: messages.slice(-50) 
                            }, null, 2) 
                        }] 
                    };
                } catch (e) {
                    return { error: `Failed to get DLQ status: ${e.message}` };
                }
            },

            get_system_logs: async ({ lines = 50 }, user) => {
                if (!user || user.role !== 'admin') {
                    return { error: "Forbidden: Only admins can read system logs." };
                }
                try {
                    const logPath = path.join(this.DATA_PATH, 'korelate.log');
                    if (!fs.existsSync(logPath)) return { error: "Log file not found." };
                    
                    const content = fs.readFileSync(logPath, 'utf8').split('\n');
                    const requestedLines = Math.min(Math.max(parseInt(lines) || 50, 1), 100);
                    const lastLines = content.slice(-requestedLines).join('\n');
                    
                    return { content: [{ type: "text", text: lastLines }] };
                } catch (e) {
                    return { error: `Failed to read logs: ${e.message}` };
                }
            },
            
            query_perennial_storage: async ({ query }) => {
                if (!this.dataManager || typeof this.dataManager.queryPerennial !== 'function') {
                    return { error: "Perennial storage querying is not implemented or no perennial storage is currently active." };
                }
                try {
                    const results = await this.dataManager.queryPerennial(query);
                    // Limit results to prevent context window explosion
                    const limit = 100;
                    const isTruncated = results.length > limit;
                    const safeResults = isTruncated ? results.slice(0, limit) : results;
                    
                    return { 
                        content: [{ 
                            type: "text", 
                            text: JSON.stringify({ 
                                query_executed: query, 
                                count: results.length, 
                                results_truncated: isTruncated, 
                                data: safeResults 
                            }, null, 2) 
                        }] 
                    };
                } catch (e) {
                    return { error: `Query execution failed: ${e.message}` };
                }
            },

            // --- Read & Search Tools ---
            get_application_status: async () => {
                return new Promise((resolve, reject) => {
                    this.db.serialize(() => {
                        this.db.all("SELECT COUNT(*) as count FROM korelate_events", (err, rows) => {
                            if (err) return reject(err);
                            const count = rows[0]?.count || 0;
                            resolve({ status: "online", count: count, db_limit: this.config.DUCKDB_MAX_SIZE_MB });
                        });
                    });
                });
            },
            list_topics: async () => {
                return new Promise((resolve, reject) => {
                    this.db.serialize(() => {
                        this.db.all("SELECT DISTINCT topic FROM korelate_events ORDER BY topic ASC LIMIT 200", (err, rows) => {
                            if (err) return reject(err);
                            resolve(rows.map(r => r.topic));
                        });
                    });
                });
            },
            get_topics_list: async () => {
                return new Promise((resolve, reject) => {
                    this.db.serialize(() => {
                        this.db.all("SELECT DISTINCT source_id, topic FROM korelate_events ORDER BY source_id, topic ASC", (err, rows) => {
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

                    const sql = `SELECT topic, payload, timestamp FROM korelate_events WHERE ${whereClauses.join(' AND ')} ORDER BY timestamp DESC LIMIT ${safeLimit}`;
                    this.db.serialize(() => {
                        this.db.all(sql, (err, rows) => {
                            if (err) return reject(err);
                            resolve(rows);
                        });
                    });
                });
            },
            get_topic_history: async ({ topic, time_expression, limit }) => {
                return new Promise((resolve, reject) => {
                    const safeLimit = (limit && !isNaN(parseInt(limit))) ? parseInt(limit) : 20;
                    let sql = `SELECT topic, payload, timestamp, source_id FROM korelate_events WHERE topic = ?`;
                    let params = [topic];

                    const timeWindow = parseTimeWindow(time_expression);
                    if (timeWindow) {
                        sql += ` AND timestamp >= ? AND timestamp <= ?`;
                        params.push(timeWindow.start.toISOString(), timeWindow.end.toISOString());
                    }

                    sql += ` ORDER BY timestamp DESC LIMIT ${safeLimit}`;
                    this.db.serialize(() => {
                        this.db.all(sql, ...params, (err, rows) => {
                            if (err) return reject(err);
                            resolve(rows);
                        });
                    });
                });
            },
            aggregate_time_series: async ({ topic, variables, time_expression, aggregation = 'MEAN', source_id }) => {
                return new Promise((resolve, reject) => {
                    const timeWindow = parseTimeWindow(time_expression);
                    if (!timeWindow) return resolve({ error: "Could not parse time_expression into a valid date range." });
                    if (!variables || variables.length === 0) return resolve({ error: "Variables array is required." });

                    const startMs = timeWindow.start.getTime();
                    const endMs = timeWindow.end.getTime();
                    const spanMs = endMs - startMs;
                    
                    const bucketMs = Math.max(1000, Math.floor(spanMs / 500));
                    
                    const aggFuncMap = { 'MEAN': 'AVG', 'MAX': 'MAX', 'MIN': 'MIN', 'MEDIAN': 'MEDIAN', 'SD': 'STDDEV', 'RANGE': 'RANGE', 'SUM': 'SUM' };
                    const aggType = aggFuncMap[aggregation] || 'AVG';

                    let selectCols = `extract('epoch' FROM time_bucket(INTERVAL '${bucketMs} MILLISECONDS', timestamp)) * 1000 AS ts_ms`;
                    
                    variables.forEach((v, idx) => {
                        let valExpr;
                        if (v === '(value)') {
                            valExpr = `TRY_CAST(CAST(payload AS VARCHAR) AS DOUBLE)`;
                        } else {
                            let safePath = escapeSQL(v);
                            if (!safePath.startsWith('$')) {
                                 safePath = safePath.startsWith('[') ? '$' + safePath : '$.' + safePath;
                            }
                            valExpr = `TRY_CAST(json_extract_string(payload, '${safePath}') AS DOUBLE)`;
                        }

                        const alias = `var_${idx}`;
                        
                        if (aggType === 'RANGE') {
                            selectCols += `, (MAX(${valExpr}) - MIN(${valExpr})) AS "${alias}"`;
                        } else {
                            selectCols += `, ${aggType}(${valExpr}) AS "${alias}"`;
                        }
                    });

                    const safeTopic = escapeSQL(topic);
                    let whereClauses = [
                        `topic = '${safeTopic}'`, 
                        `timestamp >= CAST('${timeWindow.start.toISOString()}' AS TIMESTAMPTZ)`, 
                        `timestamp <= CAST('${timeWindow.end.toISOString()}' AS TIMESTAMPTZ)`
                    ];
                    if (source_id) whereClauses.push(`source_id = '${escapeSQL(source_id)}'`);

                    const sql = `SELECT ${selectCols} FROM korelate_events WHERE ${whereClauses.join(' AND ')} GROUP BY 1 ORDER BY 1 ASC`;

                    this.db.serialize(() => {
                        this.db.all(sql, (err, rows) => {
                            if (err) return reject(err);
                            resolve({ 
                                aggregation_type: aggType, 
                                bucket_size_ms: bucketMs, 
                                variables_mapped: variables, 
                                data_points: rows 
                            });
                        });
                    });
                });
            },
            get_latest_message: async ({ topic, source_id }) => {
                return new Promise((resolve, reject) => {
                    let sql = `SELECT * FROM korelate_events WHERE topic = ?`;
                    let params = [topic];
                    if (source_id) { sql += " AND source_id = ?"; params.push(source_id); }
                    sql += " ORDER BY timestamp DESC LIMIT 1";
                    this.db.serialize(() => {
                        this.db.all(sql, ...params, (err, rows) => {
                            if (err) return reject(err);
                            resolve(rows[0] || null);
                        });
                    });
                });
            },

            // --- Semantic & Admin Tools ---
            get_model_definition: async ({ concept }) => {
                this.loadUnsModel();
                const lowerConcept = concept.toLowerCase();
                const results = this.unsModel.filter(model => 
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
                        if (typeof newModel !== "object" || Array.isArray(newModel)) {
                            return resolve({ error: "Model must be a JSON Object with 'namespaces', 'objectTypes', and 'instances'." });
                        }

                        const backupPath = this.aiActionManager.backupFile(this.MODEL_MANIFEST_PATH);
                        fs.writeFileSync(this.MODEL_MANIFEST_PATH, JSON.stringify(newModel, null, 2), 'utf8');
                        this.aiActionManager.logAction(user, 'update_uns_model', {}, { backupPath, originalPath: this.MODEL_MANIFEST_PATH });

                        // Force SemanticManager to reload if present
                        if (this.appContext && this.appContext.semanticManager) {
                            this.appContext.semanticManager.loadModel();
                        }

                        resolve({ success: true, message: "UNS Model Manifest updated successfully." });
                    } catch (error) {
                        resolve({ error: `Error updating model: ${error.message}` });
                    }
                });
            },            search_uns_concept: async ({ concept, filters, source_id }) => {
                this.loadUnsModel();
                const lowerConcept = concept.toLowerCase();
                const model = this.unsModel.find(m => m.concept.toLowerCase().includes(lowerConcept) || (m.keywords && m.keywords.some(k => k.toLowerCase().includes(lowerConcept))));
                if (!model) return { error: `Concept '${concept}' not found in model.` };

                const safeTopic = escapeSQL(model.topic_template).replace(/%/g, '\\%').replace(/_/g, '\\_').replace(/#/g, '%').replace(/\+/g, '%');
                let whereClauses = [`topic LIKE '${safeTopic}'`];
                
                if (source_id) whereClauses.push(`source_id = '${escapeSQL(source_id)}'`);

                if (filters) {
                    for (const [key, value] of Object.entries(filters)) {
                        whereClauses.push(`(payload->>'${escapeSQL(key)}') = '${escapeSQL(value)}'`);
                    }
                }

                return new Promise((resolve, reject) => {
                    const sql = `SELECT topic, payload, timestamp FROM korelate_events WHERE ${whereClauses.join(' AND ')} ORDER BY timestamp DESC LIMIT 50`;
                    this.db.serialize(() => {
                        this.db.all(sql, (err, rows) => {
                            if (err) return reject(err);
                            resolve(rows);
                        });
                    });
                });
            },
            infer_schema: async ({ topic_pattern }) => {
                const safePattern = escapeSQL(topic_pattern).replace(/%/g, '\\%').replace(/#/g, '%').replace(/\+/g, '%');
                return new Promise((resolve, reject) => {
                    const sql = `SELECT payload FROM korelate_events WHERE topic LIKE '${safePattern}' ORDER BY timestamp DESC LIMIT 20`;
                    this.db.serialize(() => {
                        this.db.all(sql, (err, rows) => {
                            if (err) return reject(err);
                            const schema = _inferSchema(rows);
                            resolve({ inferred_schema: schema });
                        });
                    });
                });
            },
            
            // --- Publish Tool ---
            publish_message: async ({ topic, payload, retain = false, source_id }) => {
                return new Promise((resolve) => {
                    this.logger.info(`[AiTools:publish] Topic: ${topic}`);
                    
                    const allProviders = this.config.DATA_PROVIDERS || [];
                    let targetConnectorConfig = allProviders[0]; 

                    if (source_id) {
                        targetConnectorConfig = allProviders.find(b => b.id === source_id);
                        if (!targetConnectorConfig) return resolve({ error: `Source '${source_id}' not found.` });
                    } else {
                        const capableConnector = allProviders.find(b => {
                            const pubs = b.publish || ((b.type === 'file' || b.type === 'dynamic') ? ['#'] : []);
                            return pubs.some(p => mqttMatch(p, topic));
                        });
                        if (capableConnector) targetConnectorConfig = capableConnector;
                    }

                    const usedConnectorId = targetConnectorConfig.id;
                    
                    const allowedTopics = targetConnectorConfig.publish || ((targetConnectorConfig.type === 'file' || targetConnectorConfig.type === 'dynamic') ? ['#'] : []);
                    const allowed = allowedTopics.some(p => mqttMatch(p, topic));

                    if (!allowed) return resolve({ error: `Forbidden: Publishing to '${topic}' not allowed on '${usedConnectorId}'.` });

                    const connection = this.getConnectorConnection(usedConnectorId);
                    if (!connection || !connection.connected) return resolve({ error: `Source '${usedConnectorId}' disconnected.` });

                    let finalPayload = payload;
                    if (typeof payload === 'object') finalPayload = JSON.stringify(payload);

                    connection.publish(topic, finalPayload, { qos: 1, retain: !!retain }, (err) => {
                        if (err) resolve({ error: err.message });
                        else resolve({ success: true, message: `Published to ${topic} on ${usedConnectorId}` });
                    });
                });
            },

            // --- Files & HMI Tools ---
            list_project_files: async ({}, user) => {
                const rootFiles = fs.readdirSync(this.ROOT_PATH).filter(f => f.endsWith('.js') || f.endsWith('.json') || f.endsWith('.md'));
                const globalFiles = fs.existsSync(this.DATA_PATH) ? fs.readdirSync(this.DATA_PATH).filter(f => f.match(/\.(svg|html|htm|js|json|gltf|glb|bin)$/i)) : [];
                
                let privateFiles = [];
                if (user && user.id) {
                    const userDir = path.join(this.SESSIONS_DIR, user.id, 'hmis');
                    if (fs.existsSync(userDir)) {
                        privateFiles = fs.readdirSync(userDir).map(f => `${f} (Private)`);
                    }
                }

                return { root_files: rootFiles, data_files: [...globalFiles, ...privateFiles] };
            },
            get_file_content: async ({ filename }, user) => {
                let resolvedPath = null;
                
                if (user && user.id) {
                    const userHmiDir = path.join(this.SESSIONS_DIR, user.id, 'hmis'); 
                    const userFile = path.join(userHmiDir, filename); 
                    if (fs.existsSync(userFile)) resolvedPath = userFile;
                }
                if (!resolvedPath) {
                    const globalDataFile = path.join(this.DATA_PATH, filename);
                    if (fs.existsSync(globalDataFile)) resolvedPath = globalDataFile;
                }
                if (!resolvedPath) {
                    const rootFile = path.join(this.ROOT_PATH, filename);
                    if (fs.existsSync(rootFile)) resolvedPath = rootFile;
                }

                if (!resolvedPath) return { error: "File not found." };

                const relative = path.relative(this.ROOT_PATH, resolvedPath);
                if (relative.startsWith('..') && !path.isAbsolute(resolvedPath)) return { error: "Path traversal blocked." };
                
                if (resolvedPath.match(/\.(glb|bin|png|jpg|jpeg|ico)$/i)) {
                     return { error: "Cannot read binary file contents." };
                }
                
                return { filename, content: fs.readFileSync(resolvedPath, 'utf8') };
            },
            save_file_to_data_directory: async ({ filename, content }, user) => {
                let targetDir = this.DATA_PATH;
                let accessLevel = "Global";

                if (user && user.role !== 'admin') {
                    targetDir = path.join(this.SESSIONS_DIR, user.id, 'hmis'); 
                    if (!fs.existsSync(targetDir)) {
                        try { fs.mkdirSync(targetDir, { recursive: true }); } catch (e) {}
                    }
                    accessLevel = "Private";
                } else {
                    if (!fs.existsSync(targetDir)) return { error: "Global Data directory not found." };
                }

                const resolvedPath = path.resolve(targetDir, path.basename(filename)); 
                if (!resolvedPath.startsWith(targetDir)) return { error: "Path traversal blocked." };
                
                const backupPath = this.aiActionManager.backupFile(resolvedPath);
                fs.writeFileSync(resolvedPath, content, 'utf8');
                this.aiActionManager.logAction(user, 'save_file_to_data_directory', { filename }, { backupPath, originalPath: resolvedPath });
                
                return { success: true, path: `${accessLevel}/data/${filename}`, note: accessLevel === "Private" ? "File saved to your private workspace." : "File saved globally." };
            },
            create_hmi_view: async ({ view_name, hmi_content, js_content }, user) => {
                try {
                    let ext = path.extname(view_name).toLowerCase();
                    let baseName = path.basename(view_name, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
                    if (ext !== '.svg' && ext !== '.html' && ext !== '.htm') {
                        ext = '.html'; 
                    }
                    
                    const hmiFilename = `${baseName}${ext}`;
                    const jsFilename = `${baseName}${ext}.js`;
                    
                    let targetDir = this.DATA_PATH;
                    let contextMessage = "Global";

                    if (user && user.id) {
                        targetDir = path.join(this.SESSIONS_DIR, user.id, 'hmis');
                        contextMessage = "Private (User)";
                        if (!fs.existsSync(targetDir)) {
                            fs.mkdirSync(targetDir, { recursive: true });
                        }
                    }

                    const hmiPath = path.join(targetDir, hmiFilename);
                    const jsPath = path.join(targetDir, jsFilename);
                    
                    let originalState = {};
                    if (fs.existsSync(hmiPath)) originalState.hmiBackup = this.aiActionManager.backupFile(hmiPath);
                    if (fs.existsSync(jsPath)) originalState.jsBackup = this.aiActionManager.backupFile(jsPath);
                    originalState.hmiPath = hmiPath;
                    originalState.jsPath = jsPath;

                    fs.writeFileSync(hmiPath, hmi_content, 'utf8');
                    fs.writeFileSync(jsPath, js_content, 'utf8');
                    
                    this.aiActionManager.logAction(user, 'create_hmi_view', { view_name }, originalState);

                    return { 
                        success: true, 
                        message: `HMI View '${hmiFilename}' created successfully in ${contextMessage} storage. Go to the HMI Dashboard tab to select it.` 
                    };
                } catch (err) {
                    this.logger.error({ err }, "[AiTools] create_hmi_view error");
                    return { error: err.message };
                }
            },
            get_available_hmi_views: async ({}, user) => {
                const globalFiles = fs.readdirSync(this.DATA_PATH).filter(f => f.match(/\.(svg|html|htm)$/i));
                let allFiles = new Set(globalFiles);

                if (user && user.id) {
                    const userDir = path.join(this.SESSIONS_DIR, user.id, 'hmis');
                    if (fs.existsSync(userDir)) {
                        const privateFiles = fs.readdirSync(userDir).filter(f => f.match(/\.(svg|html|htm)$/i));
                        privateFiles.forEach(f => allFiles.add(f)); 
                    }
                }

                return { hmi_files: Array.from(allFiles).sort() };
            },

            // --- Mapper Tools ---
            get_mapper_config: async () => {
                if (!this.mapperEngine) return { error: "Mapper Engine not available." };
                return { config: this.mapperEngine.getMappings() };
            },
            update_mapper_rule: async ({ sourceTopic, targetTopic, targetCode }, user) => {
                if (!this.mapperEngine) return { error: "Mapper Engine not available." };
                const config = this.mapperEngine.getMappings();
                const activeVersion = config.versions.find(v => v.id === config.activeVersionId);
                if (!activeVersion) return { error: "No active mapper version found." };
                
                let rule = activeVersion.rules.find(r => r.sourceTopic.trim() === sourceTopic.trim());
                let ruleBackup = rule ? JSON.stringify(rule) : null;

                if (!rule) {
                    rule = { sourceTopic: sourceTopic.trim(), targets: [] };
                    activeVersion.rules.push(rule);
                }

                const sanitizedCode = targetCode.replace(/\u00A0/g, " ").trim();
                rule.targets.push({
                    id: `tgt_${Date.now()}`,
                    enabled: true,
                    outputTopic: targetTopic.trim(),
                    mode: "js",
                    code: sanitizedCode
                });

                this.aiActionManager.logAction(user, 'update_mapper_rule', { sourceTopic, targetTopic }, { activeVersionId: config.activeVersionId, ruleBackup });
                const result = this.mapperEngine.saveMappings(config);
                return result.success ? { success: true, message: "Rule updated" } : { error: result.error };
            },

            // --- Admin / Simulators Tools ---
            prune_topic_history: async ({ topic_pattern, source_id }) => {
                return new Promise((resolve) => {
                    const sqlPattern = topic_pattern.replace(/'/g, "''").replace(/#/g, '%').replace(/\+/g, '%');
                    let whereClauses = [`topic LIKE '${sqlPattern}'`];
                    if (source_id) whereClauses.push(`source_id = '${escapeSQL(source_id)}'`);
                    
                    this.db.serialize(() => {
                        this.db.run(`DELETE FROM korelate_events WHERE ${whereClauses.join(' AND ')}`, function(err) {
                            if (err) resolve({ error: err.message });
                            else {
                                this.db.exec("CHECKPOINT; VACUUM;", () => {});
                                resolve({ success: true, count: this.changes });
                            }
                        }.bind(this)); // bind this to preserve DuckDB context for this.changes
                    });
                });
            },
            get_simulator_status: async () => this.simulatorManager.getStatuses(),
            start_simulator: async ({ name }) => {
                const res = this.simulatorManager.startSimulator(name);
                this.wsManager.broadcast(JSON.stringify({ type: 'simulator-status', statuses: this.simulatorManager.getStatuses() }));
                return res;
            },
            stop_simulator: async ({ name }) => {
                const res = this.simulatorManager.stopSimulator(name);
                this.wsManager.broadcast(JSON.stringify({ type: 'simulator-status', statuses: this.simulatorManager.getStatuses() }));
                return res;
            },
            restart_application_server: async () => {
                setTimeout(() => process.exit(0), 1000);
                return { message: "Server restarting..." };
            },

            // --- Alert Manager Tools ---
            list_alert_rules: async ({}, user) => {
                const userId = user ? user.id : null;
                const rules = await this.alertManager.getRules(userId);
                return { rules };
            },
            list_active_alerts: async ({}, user) => {
                const userId = user ? user.id : null;
                const alerts = await this.alertManager.getActiveAlerts(userId);
                return { alerts };
            },
            create_alert_rule: async (args, user) => {
                if (!user) return { error: "Authentication required." };
                const ruleData = { ...args };
                ruleData.owner_id = user.id;
                if (user.role === 'admin' && args.is_global) {
                    ruleData.owner_id = 'global';
                }
                try {
                    const result = await this.alertManager.createRule(ruleData);
                    this.aiActionManager.logAction(user, 'create_alert_rule', args, { createdId: result.id });
                    return { success: true, rule: result };
                } catch (e) {
                    return { error: e.message };
                }
            },
            update_alert_rule: async ({ id, ...updates }, user) => {
                if (!user) return { error: "Authentication required." };
                try {
                    const isAdmin = user.role === 'admin';
                    const existingRules = await this.alertManager.getRules(user.id);
                    const ruleBackup = existingRules.find(r => r.id === id);
                    
                    const result = await this.alertManager.updateRule(id, user.id, updates, isAdmin);
                    this.aiActionManager.logAction(user, 'update_alert_rule', { id, ...updates }, { ruleBackup });
                    return { success: true, rule: result };
                } catch (e) {
                    return { error: e.message };
                }
            },
            delete_alert_rule: async ({ id }, user) => {
                if (!user) return { error: "Authentication required." };
                try {
                    const isAdmin = user.role === 'admin';
                    const existingRules = await this.alertManager.getRules(user.id);
                    const ruleBackup = existingRules.find(r => r.id === id);

                    await this.alertManager.deleteRule(id, user.id, isAdmin);
                    this.aiActionManager.logAction(user, 'delete_alert_rule', { id }, { ruleBackup });
                    return { success: true, message: "Rule deleted." };
                } catch (e) {
                    return { error: e.message };
                }
            },
            update_alert_status: async ({ alert_id, status }, user) => {
                if (!user) return { error: "Authentication required." };
                try {
                    const username = user.displayName || user.username || 'AI Assistant';
                    await this.alertManager.updateAlertStatus(alert_id, status, username);
                    return { success: true, message: `Alert ${alert_id} marked as ${status}.` };
                } catch (e) {
                    return { error: e.message };
                }
            },

            // --- History Revert Tools ---
            get_ai_action_history: async ({ limit = 10 }, user) => {
                let history = this.aiActionManager.getHistory();
                if (user && user.role !== 'admin') {
                    history = history.filter(h => h.user === user.username);
                }
                return { history: history.slice(0, limit) };
            },
            revert_ai_action: async ({ action_id }, user) => {
                const action = this.aiActionManager.getHistory().find(a => a.id === action_id);
                if (!action) return { error: `Action '${action_id}' not found.` };
                if (user && user.role !== 'admin' && action.user !== user.username) return { error: "Forbidden: You did not initiate this action." };

                const { toolName, originalState } = action;
                if (!originalState) return { error: "No backup available for this action." };

                try {
                    if (toolName === 'create_hmi_view') {
                        this.aiActionManager.restoreFile(originalState.hmiBackup, originalState.hmiPath);
                        this.aiActionManager.restoreFile(originalState.jsBackup, originalState.jsPath);
                        return { success: true, message: "HMI files reverted." };
                    } else if (toolName === 'save_file_to_data_directory') {
                        this.aiActionManager.restoreFile(originalState.backupPath, originalState.originalPath);
                        return { success: true, message: "File reverted." };
                    } else if (toolName === 'update_uns_model') {
                        this.aiActionManager.restoreFile(originalState.backupPath, originalState.originalPath);
                        this.loadUnsModel();
                        return { success: true, message: "UNS model reverted." };
                    } else if (toolName === 'update_mapper_rule') {
                        if (!this.mapperEngine) return { error: "Mapper unavailable." };
                        const config = this.mapperEngine.getMappings();
                        const activeVersion = config.versions.find(v => v.id === originalState.activeVersionId);
                        if (!activeVersion) return { error: "Mapper version missing." };
                        
                        const oldRule = originalState.ruleBackup ? JSON.parse(originalState.ruleBackup) : null;
                        const { sourceTopic } = action.args;
                        activeVersion.rules = activeVersion.rules.filter(r => r.sourceTopic.trim() !== sourceTopic.trim());
                        if (oldRule) activeVersion.rules.push(oldRule);
                        
                        this.mapperEngine.saveMappings(config);
                        return { success: true, message: "Mapper rule reverted." };
                    } else if (toolName === 'delete_alert_rule') {
                        if (originalState.ruleBackup) {
                            const { id, ...ruleRest } = originalState.ruleBackup;
                            await this.alertManager.createRule({ ...ruleRest, override_id: id });
                            return { success: true, message: "Alert rule restored." };
                        }
                    } else if (toolName === 'create_alert_rule') {
                        await this.alertManager.deleteRule(originalState.createdId, user.id, true);
                        return { success: true, message: "Alert rule removed." };
                    } else if (toolName === 'update_alert_rule') {
                        if (originalState.ruleBackup) {
                            const { id, ...ruleRest } = originalState.ruleBackup;
                            await this.alertManager.updateRule(id, user.id, ruleRest, true);
                            return { success: true, message: "Alert rule reverted." };
                        }
                    }

                    return { error: `Revert logic not implemented for ${toolName}.` };
                } catch (e) {
                    return { error: `Failed to revert: ${e.message}` };
                }
            }
        };
    }
}

module.exports = AiTools;