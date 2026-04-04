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
 * Context API - Data & History Endpoints
 * [RENAMED] Formerly mcpApi.js to avoid confusion with the actual MCP server.
 * [MODIFIED] Ensures query returns the absolute last value known <= timestamp.
 * [MODIFIED] Added db.serialize() to prevent DuckDB locking errors.
 * [MODIFIED] Added 'startDate' and 'endDate' support for time filtering.
 * [MODIFIED] Added Admin check for Prune Topic.
 * [NEW] Added /aggregate endpoint for optimized time-bucketed charting.
 * [UPDATED] Eradicated silent catches on JSON.stringify failures to ensure API serialization issues are logged.
 */
const express = require('express');

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

module.exports = (db, getMainConnection, getSimulatorInterval, getDbStatus, config) => {
    const router = express.Router();
    const isMultiBroker = (config.DATA_PROVIDERS || []).length > 1;

    // Helper for logging
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
                            valExpr = `TRY_CAST(CAST(payload AS VARCHAR) AS DOUBLE)`;
                        } else {
                            const safePath = escapeSQL(v.path); // e.g. $.temperature_c
                            valExpr = `TRY_CAST(json_extract_string(payload, '${safePath}') AS DOUBLE)`;
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