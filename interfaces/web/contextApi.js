/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025-2026 Sebastien Lalaurette
 *
 * Context API - Data & History Endpoints
 * [MODIFIED] Added mqtt-match to properly link AI schema suggestions to wildcard instances.
 * [MODIFIED] Secured schema property injections against missing AI suggestion keys.
 */
const express = require('express');
const llmEngine = require('../../core/engine/llmEngine');
const mqttMatch = require('mqtt-match');

// Helper simple pour échapper les apostrophes
const escapeSQL = (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(/'/g, "''");
}

// Helper pour convertir le pattern MQTT en SQL LIKE
const mqttToSqlLike = (topicPattern) => {
    let escaped = escapeSQL(topicPattern)
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
    escaped = escaped.replace(/#/g, '%');
    escaped = escaped.replace(/\+/g, '%');

    if (escaped.endsWith('/%')) {
        escaped = escaped.substring(0, escaped.length - 2) + '%';
    }

    return escaped;
}

module.exports = (db, getMainConnection, getSimulatorInterval, getDbStatus, config, semanticManager, alertManager) => {
    const router = express.Router();
    const isMultiBroker = (config.DATA_PROVIDERS || []).length > 1;

    const log = (msg) => console.log(`[ContextAPI] ${msg}`);
    const logError = (msg, err) => console.error(`[ContextAPI] ❌ ${msg}`, err ? err.message : '');

    router.get('/status', (req, res) => {
        getDbStatus(statusData => {
            const mainConnection = getMainConnection();
            const simulatorStatuses = getSimulatorInterval(); 
            const isSimRunning = Object.values(simulatorStatuses).some(s => s === 'running');

            res.json({
                mqtt_connected: mainConnection ? mainConnection.connected : false,
                simulator_status: isSimRunning ? 'running' : 'stopped', 
                database_stats: {
                    total_messages: statusData.totalMessages,
                    size_mb: parseFloat(statusData.dbSizeMB.toFixed(2)),
                    size_limit_mb: statusData.dbLimitMB
                }
            });
        });
    });

    router.get('/topics', (req, res, next) => {
        log("Listing topics...");
        db.serialize(() => {
            db.all("SELECT DISTINCT source_id, topic FROM korelate_events ORDER BY source_id, topic ASC", (err, rows) => {
                if (err) {
                    return next(err);
                }
                res.json(rows);
            });
        });
    });

    router.get('/tree', (req, res, next) => {
        db.serialize(() => {
            db.all("SELECT DISTINCT source_id, topic FROM korelate_events", (err, rows) => {
                if (err) {
                    return next(err);
                }

                const tree = {};
                rows.forEach(row => {
                    const displayTopic = isMultiBroker ? `${row.source_id}/${row.topic}` : row.topic;
                    let currentLevel = tree;
                    const parts = displayTopic.split('/');

                    parts.forEach((part) => {
                        if (!currentLevel[part]) {
                            currentLevel[part] = {};
                        }
                        currentLevel = currentLevel[part];
                    });
                });

                res.json(tree);
            });
        });
    });

    // --- [NEW] Get Last Known State AS OF a specific timestamp ---
    // This implements the "State at Point in Time" logic.
    // Even if the last message was 6 hours ago, if it's the latest relative to the timestamp, it returns it.
    router.get('/last-known', (req, res, next) => {
        const timestampIso = req.query.timestamp;
        if (!timestampIso) {
            return res.status(400).json({ error: "Missing 'timestamp' query parameter (ISO 8601)." });
        }

        // Window Function explanation:
        // 1. Filter: Keep only messages OLDER or EQUAL to the requested time.
        // 2. Partition: Group by topic (and broker).
        // 3. Order: Sort by time DESC (newest first).
        // 4. Qualify: Keep only the 1st row (the newest) for each group.
        const query = `
            SELECT topic, payload, source_id, timestamp
            FROM korelate_events
            WHERE timestamp <= CAST(? AS TIMESTAMPTZ)
            QUALIFY ROW_NUMBER() OVER (PARTITION BY topic, source_id ORDER BY timestamp DESC) = 1
        `;

        db.serialize(() => {
            db.all(query, timestampIso, (err, rows) => {
                if (err) {
                    return next(err);
                }

                const results = rows.map(row => {
                    if (typeof row.payload === 'object' && row.payload !== null) {
                        try { 
                            row.payload = JSON.stringify(row.payload); 
                        } catch (e) {
                            logError(`Failed to stringify payload for topic ${row.topic}`, e);
                        }
                    }
                    return row;
                });
                res.json(results);
            });
        });
    });

    // --- [NEW] Backend Aggregation for Charts (TIME_BUCKET strategy) ---
    router.post('/aggregate', (req, res) => {
        const { topics, startDate, endDate, aggregation, maxPoints } = req.body;

        if (!topics || !startDate || !endDate) {
            return res.status(400).json({ error: "Missing required fields." });
        }

        const startMs = new Date(startDate).getTime();
        const endMs = new Date(endDate).getTime();
        const spanMs = endMs - startMs;
        
        // Limit to minimum 1s buckets, aiming for maxPoints
        const bucketMs = Math.max(1000, Math.floor(spanMs / (maxPoints || 500)));

        const aggFuncMap = {
            'AUTO': 'AVG',
            'MEAN': 'AVG',
            'MAX': 'MAX',
            'MIN': 'MIN',
            'MEDIAN': 'MEDIAN',
            'SD': 'STDDEV',
            'RANGE': 'RANGE',
            'SUM': 'SUM'
        };
        const aggType = aggFuncMap[aggregation] || 'AVG';

        db.serialize(() => {
            const promises = topics.map(t => {
                return new Promise((resolve) => {
                    let selectCols = `extract('epoch' FROM time_bucket(INTERVAL '${bucketMs} MILLISECONDS', timestamp)) * 1000 AS ts_ms`;
                    
                    t.variables.forEach(v => {
                        let valExpr;
                        if (v.path === '(value)') {
                            const p = `CAST(payload AS VARCHAR)`;
                            valExpr = `CASE WHEN lower(${p}) IN ('true', '1') THEN 1.0 WHEN lower(${p}) IN ('false', '0') THEN 0.0 ELSE TRY_CAST(${p} AS DOUBLE) END`;
                        } else {
                            const safePath = escapeSQL(v.path);
                            const p = `json_extract_string(payload, '${safePath}')`;
                            valExpr = `CASE WHEN lower(${p}) IN ('true', '1') THEN 1.0 WHEN lower(${p}) IN ('false', '0') THEN 0.0 ELSE TRY_CAST(${p} AS DOUBLE) END`;
                        }
                        
                        if (aggType === 'RANGE') {
                            selectCols += `, (MAX(${valExpr}) - MIN(${valExpr})) AS "${v.id}"`;
                        } else {
                            selectCols += `, ${aggType}(${valExpr}) AS "${v.id}"`;
                        }
                    });

                    const safeTopic = escapeSQL(t.topic);
                    const safeBroker = escapeSQL(t.sourceId);

                    const query = `
                        SELECT ${selectCols}
                        FROM korelate_events
                        WHERE topic = '${safeTopic}' 
                          AND source_id = '${safeBroker}'
                          AND timestamp >= CAST('${startDate}' AS TIMESTAMPTZ)
                          AND timestamp <= CAST('${endDate}' AS TIMESTAMPTZ)
                        GROUP BY 1 ORDER BY 1 ASC
                    `;

                    db.all(query, (err, rows) => {
                        if (err) resolve({ sourceId: t.sourceId, topic: t.topic, error: err.message });
                        else resolve({ sourceId: t.sourceId, topic: t.topic, data: rows });
                    });
                });
            });

            Promise.all(promises).then(results => res.json(results));
        });
    });

    // --- [NEW] Data Profiling for AI Learning Studio ---
    router.post('/profile', (req, res) => {
        const { topics, startDate, endDate } = req.body;

        if (!topics || !startDate || !endDate) {
            return res.status(400).json({ error: "Missing required fields." });
        }

        db.serialize(() => {
            const promises = topics.map(t => {
                return new Promise((resolve) => {
                    const variableProfiles = t.variables.map(v => {
                        return new Promise((vResolve) => {
                            let valExpr;
                            if (v.path === '(value)') {
                                const p = `CAST(payload AS VARCHAR)`;
                                valExpr = `CASE WHEN lower(${p}) IN ('true', '1') THEN 1.0 WHEN lower(${p}) IN ('false', '0') THEN 0.0 ELSE TRY_CAST(${p} AS DOUBLE) END`;
                            } else {
                                // Extract the path (e.g. $.temperature_c)
                                const safePath = escapeSQL(v.path); 
                                const p = `json_extract_string(payload, '${safePath}')`;
                                valExpr = `CASE WHEN lower(${p}) IN ('true', '1') THEN 1.0 WHEN lower(${p}) IN ('false', '0') THEN 0.0 ELSE TRY_CAST(${p} AS DOUBLE) END`;
                            }

                            const safeTopic = escapeSQL(t.topic);
                            const safeBroker = escapeSQL(t.sourceId);
                            const safeStart = escapeSQL(startDate);
                            const safeEnd = escapeSQL(endDate);

                            const query = `
                                WITH raw_data AS (
                                    SELECT 
                                        timestamp,
                                        ${valExpr} as val
                                    FROM korelate_events
                                    WHERE topic = '${safeTopic}' 
                                      AND source_id = '${safeBroker}'
                                      AND timestamp >= CAST('${safeStart}' AS TIMESTAMPTZ)
                                      AND timestamp <= CAST('${safeEnd}' AS TIMESTAMPTZ)
                                ),
                                stats AS (
                                    SELECT 
                                        MIN(val) as min_val,
                                        MAX(val) as max_val,
                                        AVG(val) as mean_val,
                                        STDDEV(val) as stddev_val,
                                        CAST(COUNT(*) FILTER (WHERE val IS NULL) AS INTEGER) as null_count,
                                        CAST(COUNT(*) AS INTEGER) as total_count
                                    FROM raw_data
                                ),
                                frequency AS (
                                    SELECT AVG(diff) as avg_freq
                                    FROM (
                                        SELECT extract('epoch' from timestamp - lag(timestamp) OVER (ORDER BY timestamp)) as diff
                                        FROM raw_data
                                    )
                                ),
                                chatter AS (
                                    SELECT CAST(COUNT(*) AS INTEGER) as crossings
                                    FROM (
                                        SELECT 
                                            val,
                                            lag(val) OVER (ORDER BY timestamp) as prev_val,
                                            (SELECT mean_val FROM stats) as m
                                        FROM raw_data
                                        WHERE val IS NOT NULL
                                    )
                                    WHERE (val > m AND prev_val <= m) OR (val < m AND prev_val >= m)
                                )
                                SELECT * FROM stats, frequency, chatter
                            `;

                            db.all(query, (err, rows) => {
                                if (err) vResolve({ id: v.id, path: v.path, error: err.message });
                                else vResolve({ id: v.id, path: v.path, stats: rows && rows[0] ? rows[0] : {} });
                            });
                        });
                    });

                    Promise.all(variableProfiles).then(vars => {
                        resolve({ sourceId: t.sourceId, topic: t.topic, variables: vars });
                    });
                });
            });

            Promise.all(promises).then(results => res.json(results));
        });
    });

    // --- [NEW] AI Synthesis for Data Profiling ---
    router.post('/learn', async (req, res) => {
        const { profileData, model } = req.body;
        if (!profileData) return res.status(400).json({ error: "Missing 'profileData'." });

        if (!config.LLM_API_KEY) {
            return res.status(503).json({ error: "AI Features not configured (Missing API Key)." });
        }

        try {
            // Get current model if possible
            let currentModelStr = "{}";
            if (semanticManager && semanticManager.getModel()) {
                currentModelStr = JSON.stringify(semanticManager.getModel(), null, 2);
            }

            const systemPrompt = llmEngine.generateDataProfilePrompt(profileData, currentModelStr);
            const conversation = [
                { role: "user", content: systemPrompt + "\n\nAnalyze the provided data profile. Check if the objects exist in the CURRENT UNS MODEL. If not, suggest creating them and guessing their relationships. Then suggest updates to the UNS model schema and alert rules." }
            ];

            const message = await llmEngine.fetchChatCompletion(conversation, config, [], null, model);
            let content = message.content;

            // Try to parse JSON from response (sometimes LLMs wrap it in markdown blocks)
            if (content.includes('```json')) {
                content = content.split('```json')[1].split('```')[0].trim();
            } else if (content.includes('```')) {
                const parts = content.split('```');
                if (parts.length >= 3) {
                    content = parts[1].trim();
                }
            }

            try {
                const suggestions = JSON.parse(content);
                
                // Inject meta for UI dropdowns
                let existingElementIds = [];
                let existingTypeIds = [];
                if (semanticManager && semanticManager.getModel()) {
                    const currentModel = semanticManager.getModel();
                    if (currentModel.instances) existingElementIds = currentModel.instances.map(o => o.elementId);
                    if (currentModel.objectTypes) existingTypeIds = currentModel.objectTypes.map(t => t.elementId);
                }
                suggestions.meta = {
                    existingElementIds,
                    existingTypeIds,
                    relTypes: ['HasParent', 'HasComponent', 'SuppliesTo', 'ReceivesFrom', 'Controls', 'Monitors']
                };

                res.json(suggestions);
            } catch (e) {
                // If it's not valid JSON, return the raw content but maybe it's an error
                res.json({ error: "AI failed to return valid JSON", raw: content });
            }
        } catch (err) {
            console.error("AI Profiling Error:", err.message);
            if (err.response && err.response.data) {
                console.error("AI Profiling Error Details:", JSON.stringify(err.response.data, null, 2));
            }
            res.status(500).json({ error: err.response?.data?.error?.message || err.message, details: err.response?.data });
        }
    });

    // --- [NEW] Apply AI Profiling Suggestions ---
    router.post('/apply-learn', async (req, res) => {
        const payload = req.body;
        if (!payload) return res.status(400).json({ error: "Missing payload." });

        try {
            let modelChanged = false;
            
            // 1. Update UNS Model (if semanticManager is available)
            if (semanticManager) {
                let currentModel = semanticManager.getModel() || {};
                if (!currentModel.instances) currentModel.instances = [];
                if (!currentModel.objectTypes) currentModel.objectTypes = [];

                const approvedNewObjects = (payload.new_objects || []).filter(o => o._approved);
                for (const o of approvedNewObjects) {
                    const newObj = {
                        elementId: o.elementId,
                        typeId: o.type,
                        displayName: o.description || o.elementId,
                        topic_mapping: o.topic_mapping || undefined,
                        namespaceUri: currentModel.namespaces?.[0]?.uri || "[https://cesmii.org/i3x](https://cesmii.org/i3x)",
                        isComposition: false
                    };
                    
                    if (o.relationships && Array.isArray(o.relationships)) {
                        newObj.relationships = {};
                        for (const rel of o.relationships) {
                            if (!rel.type || !rel.target) continue;
                            
                            // Map HasParent to the built-in parentId field
                            if (rel.type === 'HasParent') {
                                newObj.parentId = rel.target;
                            } else {
                                if (!newObj.relationships[rel.type]) newObj.relationships[rel.type] = [];
                                newObj.relationships[rel.type].push(rel.target);
                            }
                        }
                    }
                    
                    // Cleanup empty relationships object
                    if (Object.keys(newObj.relationships || {}).length === 0) delete newObj.relationships;

                    currentModel.instances.push(newObj);
                    modelChanged = true;

                    // Ensure the ObjectType exists for this new instance!
                    let targetType = currentModel.objectTypes.find(t => t.elementId === newObj.typeId);
                    if (!targetType) {
                        targetType = {
                            elementId: newObj.typeId,
                            displayName: `${newObj.typeId} (Auto-generated)`,
                            namespaceUri: currentModel.namespaces?.[0]?.uri || "[https://cesmii.org/i3x](https://cesmii.org/i3x)",
                            schema: { type: "object", properties: {} }
                        };
                        currentModel.objectTypes.push(targetType);
                    }
                }

                const approvedSchemaUpdates = (payload.schema_updates || []).filter(s => s._approved);
                for (const s of approvedSchemaUpdates) {
                    
                    // Allow wildcard resolution via mqttMatch to avoid dummy instance generation
                    let targetInstance = currentModel.instances.find(obj => 
                        obj.topic_mapping === s.topic || 
                        (obj.topic_mapping && mqttMatch(obj.topic_mapping, s.topic))
                    );
                    
                    if (!targetInstance) {
                        // Fallback: create a dummy instance if not found and not created above
                        const parts = s.topic.split('/');
                        const fallbackName = parts.length > 0 ? parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9_]/g, '_') : 'unknown';
                        const fallbackId = `${fallbackName}_${Date.now().toString().slice(-4)}`;
                        
                        targetInstance = {
                            elementId: fallbackId,
                            typeId: `${fallbackName.charAt(0).toUpperCase() + fallbackName.slice(1)}Type`,
                            displayName: `Generated for ${s.topic}`,
                            topic_mapping: s.topic,
                            namespaceUri: currentModel.namespaces?.[0]?.uri || "[https://cesmii.org/i3x](https://cesmii.org/i3x)",
                            isComposition: false
                        };
                        currentModel.instances.push(targetInstance);
                    }

                    // We need to apply schema properties to its Type, not the Instance itself.
                    let targetType = currentModel.objectTypes.find(t => t.elementId === targetInstance.typeId);
                    
                    if (!targetType) {
                        // If type doesn't exist, create it
                        targetType = {
                            elementId: targetInstance.typeId,
                            displayName: `${targetInstance.typeId} (Auto-generated)`,
                            namespaceUri: currentModel.namespaces?.[0]?.uri || "[https://cesmii.org/i3x](https://cesmii.org/i3x)",
                            schema: { type: "object", properties: {} }
                        };
                        currentModel.objectTypes.push(targetType);
                    }

                    if (!targetType.schema) targetType.schema = { type: "object", properties: {} };
                    if (!targetType.schema.properties) targetType.schema.properties = {};
                    
                    // Secure variable insertion against incomplete AI payload
                    const varName = s.variable || `var_${Date.now()}`;
                    if (!targetType.schema.properties[varName]) {
                        targetType.schema.properties[varName] = { type: "number" };
                    }
                    
                    s.suggestions = s.suggestions || {};
                    targetType.schema.properties[varName].nominal_value = s.suggestions.nominal_value;
                    targetType.schema.properties[varName].expected_range = s.suggestions.expected_range;
                    targetType.schema.properties[varName].data_frequency_seconds = s.suggestions.data_frequency_seconds;

                    if (s.suggestions.description !== undefined) targetType.schema.properties[varName].description = s.suggestions.description;
                    if (s.suggestions.pattern !== undefined) targetType.schema.properties[varName].pattern = s.suggestions.pattern;
                    if (s.suggestions.source !== undefined) targetType.schema.properties[varName].source = s.suggestions.source;
                    
                    modelChanged = true;
                }

                if (modelChanged) {
                    const saveResult = semanticManager.saveModel(currentModel);
                    if (saveResult.error) throw new Error("Failed to save UNS Model: " + saveResult.error);
                }
            }

            // 2. Create Alert Rules
            if (alertManager) {
                const approvedAlerts = (payload.alert_rules || []).filter(r => r._approved);
                for (const r of approvedAlerts) {
                    await alertManager.createRule({
                        name: r.name,
                        topic_pattern: "#", // Apply globally by default, user can restrict later
                        severity: r.severity || "warning",
                        condition_code: r.condition,
                        workflow_prompt: r.rationale || "Auto-generated from AI Learning Studio",
                        owner_id: req.user ? req.user.id : 'global'
                    });
                }
            }

            res.json({ success: true, modelChanged });
        } catch (err) {
            console.error("Apply Learn Error:", err);
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/search', (req, res, next) => {
        const query = req.query.q;
        const sourceId = req.query.sourceId;
        const startDate = req.query.startDate;
        const endDate = req.query.endDate;

        if (!query || query.length < 3) {
            return res.status(400).json({ error: "Search query must be at least 3 characters long." });
        }

        const safeSearchTerm = `%${escapeSQL(query)}%`;
        const limit = 5000;

        let whereClauses = [
            `(
                topic ILIKE '${safeSearchTerm}'
                OR (json_valid(payload) AND (
                    CAST(payload->>'description' AS VARCHAR) ILIKE '${safeSearchTerm}'
                    OR CAST(payload->>'raw_payload' AS VARCHAR) ILIKE '${safeSearchTerm}'
                    OR CAST(payload->>'value' AS VARCHAR) ILIKE '${safeSearchTerm}'
                    OR CAST(payload->>'status' AS VARCHAR) ILIKE '${safeSearchTerm}'
                    OR CAST(payload->>'name' AS VARCHAR) ILIKE '${safeSearchTerm}'
                   ))
            )`
        ];

        if (sourceId) {
            whereClauses.push(`source_id = '${escapeSQL(sourceId)}'`);
        }
        if (startDate) {
            whereClauses.push(`timestamp >= '${escapeSQL(startDate)}'`);
        }
        if (endDate) {
            whereClauses.push(`timestamp <= '${escapeSQL(endDate)}'`);
        }

        const sqlQuery = `
            SELECT topic, payload, timestamp, source_id
            FROM korelate_events
            WHERE ${whereClauses.join(' AND ')}
            ORDER BY timestamp DESC
            LIMIT ${limit};
        `;

        db.serialize(() => {
            db.all(sqlQuery, (err, rows) => {
                if (err) {
                    return next(err);
                }

                const results = rows.map(row => {
                    if (typeof row.payload === 'object' && row.payload !== null) {
                        try { 
                            row.payload = JSON.stringify(row.payload); 
                        } catch (e) {
                            logError(`Failed to stringify payload for topic ${row.topic} during search`, e);
                        }
                    } else if (row.payload === null) {
                        row.payload = 'null';
                    }
                    return row;
                });
                res.json(results);
            });
        });
    });

    router.post('/search/model', (req, res, next) => {
        const { topic_template, filters, source_id } = req.body; 

        if (!topic_template) {
            return res.status(400).json({ error: "Missing 'topic_template'." });
        }

        const safe_topic = escapeSQL(topic_template);
        const limit = 5000;
        const useOptimizedQuery = config.DB_BATCH_INSERT_ENABLED === true;

        let whereClauses = [`topic LIKE '${safe_topic}'`];

        if (source_id) {
            whereClauses.push(`source_id = '${escapeSQL(source_id)}'`);
        }

        if (filters && typeof filters === 'object') {
            for (const [key, value] of Object.entries(filters)) {
                const safe_key = "'" + escapeSQL(key) + "'";
                const safe_value = "'" + escapeSQL(value) + "'";
                
                if (useOptimizedQuery) {
                    whereClauses.push(`(payload->>${safe_key}) = ${safe_value}`);
                } else {
                    whereClauses.push(`CAST((CAST(payload AS VARCHAR)::JSON)->>${safe_key} AS VARCHAR) = ${safe_value}`);
                }
            }
        }

        const sqlQuery = `
            SELECT topic, payload, timestamp, source_id
            FROM korelate_events
            WHERE ${whereClauses.join(' AND ')}
            ORDER BY timestamp DESC
            LIMIT ${limit};
        `;

        if(useOptimizedQuery) {
            log(`Model Search Query (Optimized): ${sqlQuery.replace(/\s+/g, ' ')}`);
        } else {
            log(`Model Search Query (Legacy): ${sqlQuery.replace(/\s+/g, ' ')}`);
        }

        db.serialize(() => {
            db.all(sqlQuery, (err, rows) => {
                if (err) {
                    return next(err);
                }

                const results = rows.map(row => {
                    if (typeof row.payload === 'object' && row.payload !== null) {
                         try { 
                             row.payload = JSON.stringify(row.payload); 
                         } catch (e) {
                             logError(`Failed to stringify payload for topic ${row.topic} during model search`, e);
                         }
                    }
                    return row;
                });
                res.json(results);
            });
        });
    });

    router.post('/prune-topic', (req, res, next) => {
        // [SECURED] Admin Only Check
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: "Forbidden: Only Admins can prune database history." });
        }

        const { topicPattern, source_id } = req.body;

        if (!topicPattern) return res.status(400).json({ error: "Missing 'topicPattern'." });

        const sqlPattern = mqttToSqlLike(topicPattern);
        let whereClauses = [`topic LIKE '${sqlPattern}'`];
        
        if (source_id) whereClauses.push(`source_id = '${escapeSQL(source_id)}'`);

        const query = `DELETE FROM korelate_events WHERE ${whereClauses.join(' AND ')};`;

        db.serialize(() => {
            db.run(query, function(err) { 
                if (err) {
                    return next(err);
                }
                const changes = this.changes;
                db.exec("CHECKPOINT; VACUUM;", (vacErr) => {
                    if (vacErr) console.error("❌ Vacuum Error:", vacErr);
                });
                res.json({ success: true, count: changes });
            });
        });
    });

    router.get('/topic/:topic(*)', (req, res, next) => {
        const topic = req.params.topic;
        const sourceId = req.query.sourceId; 

        if (!topic) return res.status(400).json({ error: "Topic not specified." });

        let query = `SELECT * FROM korelate_events WHERE topic = ?`;
        let params = [topic];

        if (sourceId) {
            query += " AND source_id = ?";
            params.push(sourceId);
        }
        query += " ORDER BY timestamp DESC LIMIT 1";

        db.serialize(() => {
            db.all(query, ...params, (err, rows) => {
                if (err) {
                    return next(err);
                }

                if (!rows || rows.length === 0) {
                    return res.status(404).json({ error: "No data found." });
                }

                const result = rows[0];
                 if (typeof result.payload === 'object' && result.payload !== null) {
                     try { 
                         result.payload = JSON.stringify(result.payload); 
                     } catch (e) {
                         logError(`Failed to stringify payload for requested topic ${topic}`, e);
                     }
                }
                res.json(result);
            });
        });
    });

    router.get('/history/:topic(*)', (req, res, next) => {
        const topic = req.params.topic;
        const sourceId = req.query.sourceId; 
        const limit = parseInt(req.query.limit, 10) || 20;
        const startDate = req.query.startDate;
        const endDate = req.query.endDate;

        if (!topic) return res.status(400).json({ error: "Topic not specified." });

        let query = `SELECT * FROM korelate_events WHERE topic = ?`;
        let params = [topic];

        if (sourceId) {
            query += " AND source_id = ?";
            params.push(sourceId);
        }

        if (startDate) {
            query += " AND timestamp >= ?";
            params.push(startDate);
        }
        if (endDate) {
            query += " AND timestamp <= ?";
            params.push(endDate);
        }

        query += " ORDER BY timestamp DESC LIMIT ?";
        params.push(limit);

        db.serialize(() => {
            db.all(query, ...params, (err, rows) => {
                if (err) {
                    return next(err);
                }

                const results = rows.map(row => {
                     if (typeof row.payload === 'object' && row.payload !== null) {
                         try { 
                             row.payload = JSON.stringify(row.payload); 
                         } catch (e) {
                             logError(`Failed to stringify payload history for topic ${row.topic}`, e);
                         }
                    }
                    return row;
                });
                res.json(results);
            });
        });
    });

    return router;
};