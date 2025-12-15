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
 * MCP API - Context & History Endpoints
 * [MODIFIED] Restored specific DEBUG logs and logic for 'search/model'.
 * [MODIFIED] Added db.serialize() to prevent DuckDB locking errors.
 * [MODIFIED] Added 'startDate' and 'endDate' support for time filtering.
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
    const isMultiBroker = config.BROKER_CONFIGS.length > 1;

    // Helper for logging
    const log = (msg) => console.log(`[MCPApi] ${msg}`);

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

    router.get('/topics', (req, res) => {
        log("Listing topics...");
        db.serialize(() => {
            db.all("SELECT DISTINCT broker_id, topic FROM mqtt_events ORDER BY broker_id, topic ASC", (err, rows) => {
                if (err) {
                    console.error("❌ Failed to query topics:", err);
                    return res.status(500).json({ error: "Failed to query topics from database." });
                }
                res.json(rows);
            });
        });
    });

    router.get('/tree', (req, res) => {
        db.serialize(() => {
            db.all("SELECT DISTINCT broker_id, topic FROM mqtt_events", (err, rows) => {
                if (err) {
                    return res.status(500).json({ error: "Failed to query topics from database." });
                }
                const tree = {};
                rows.forEach(row => {
                    const displayTopic = isMultiBroker ? `${row.broker_id}/${row.topic}` : row.topic;
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

    router.get('/search', (req, res) => {
        const query = req.query.q;
        const brokerId = req.query.brokerId;
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

        if (brokerId) {
            whereClauses.push(`broker_id = '${escapeSQL(brokerId)}'`);
        }
        if (startDate) {
            whereClauses.push(`timestamp >= '${escapeSQL(startDate)}'`);
        }
        if (endDate) {
            whereClauses.push(`timestamp <= '${escapeSQL(endDate)}'`);
        }

        const sqlQuery = `
            SELECT topic, payload, timestamp, broker_id
            FROM mqtt_events
            WHERE ${whereClauses.join(' AND ')}
            ORDER BY timestamp DESC
            LIMIT ${limit};
        `;

        db.serialize(() => {
            db.all(sqlQuery, (err, rows) => {
                if (err) {
                    console.error("❌ Search Error:", err);
                    return res.status(500).json({ error: "Database search query failed." });
                }
                const results = rows.map(row => {
                    if (typeof row.payload === 'object' && row.payload !== null) {
                        try { row.payload = JSON.stringify(row.payload); } catch (e) {}
                    } else if (row.payload === null) {
                        row.payload = 'null';
                    }
                    return row;
                });
                res.json(results);
            });
        });
    });

    router.post('/search/model', (req, res) => {
        const { topic_template, filters, broker_id } = req.body; 
        
        if (!topic_template) {
            return res.status(400).json({ error: "Missing 'topic_template'." });
        }

        const safe_topic = escapeSQL(topic_template);
        const limit = 5000;
        
        // [RESTORED LOGIC]
        const useOptimizedQuery = config.DB_BATCH_INSERT_ENABLED === true;

        let whereClauses = [`topic LIKE '${safe_topic}'`];
        
        if (broker_id) {
            whereClauses.push(`broker_id = '${escapeSQL(broker_id)}'`);
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
            SELECT topic, payload, timestamp, broker_id
            FROM mqtt_events
            WHERE ${whereClauses.join(' AND ')}
            ORDER BY timestamp DESC
            LIMIT ${limit};
        `;

        // [RESTORED LOGGING]
        if(useOptimizedQuery) {
            console.log(`[DEBUG] Model Search Query (Optimized): ${sqlQuery.replace(/\s+/g, ' ')}`);
        } else {
            console.log(`[DEBUG] Model Search Query (Legacy): ${sqlQuery.replace(/\s+/g, ' ')}`);
        }

        db.serialize(() => {
            db.all(sqlQuery, (err, rows) => {
                if (err) {
                    console.error("❌ Model Search Error:", err);
                    return res.status(500).json({ error: "Database model search query failed." });
                }
                const results = rows.map(row => {
                    if (typeof row.payload === 'object' && row.payload !== null) {
                         try { row.payload = JSON.stringify(row.payload); } catch (e) {}
                    }
                    return row;
                });
                res.json(results);
            });
        });
    });

    router.post('/prune-topic', (req, res) => {
        const { topicPattern, broker_id } = req.body;
        if (!topicPattern) return res.status(400).json({ error: "Missing 'topicPattern'." });

        const sqlPattern = mqttToSqlLike(topicPattern);
        let whereClauses = [`topic LIKE '${sqlPattern}'`];
        if (broker_id) whereClauses.push(`broker_id = '${escapeSQL(broker_id)}'`);

        const query = `DELETE FROM mqtt_events WHERE ${whereClauses.join(' AND ')};`;

        db.serialize(() => {
            db.run(query, function(err) { 
                if (err) {
                    console.error("❌ Prune Error:", err);
                    return res.status(500).json({ error: "Database prune query failed." });
                }
                const changes = this.changes;
                db.exec("CHECKPOINT; VACUUM;", (vacErr) => {
                    if (vacErr) console.error("❌ Vacuum Error:", vacErr);
                });
                res.json({ success: true, count: changes });
            });
        });
    });

    router.get('/topic/:topic(*)', (req, res) => {
        const topic = req.params.topic;
        const brokerId = req.query.brokerId; 
        
        if (!topic) return res.status(400).json({ error: "Topic not specified." });

        let query = `SELECT * FROM mqtt_events WHERE topic = ?`;
        let params = [topic];

        if (brokerId) {
            query += " AND broker_id = ?";
            params.push(brokerId);
        }

        query += " ORDER BY timestamp DESC LIMIT 1";

        db.serialize(() => {
            // [FIX] Use spread operator ...params
            db.all(query, ...params, (err, rows) => {
                if (err) {
                    console.error("❌ Topic Query Error:", err);
                    return res.status(500).json({ error: "Database query failed." });
                }
                if (!rows || rows.length === 0) {
                    return res.status(404).json({ error: "No data found." });
                }
                const result = rows[0];
                 if (typeof result.payload === 'object' && result.payload !== null) {
                     try { result.payload = JSON.stringify(result.payload); } catch (e) {}
                }
                res.json(result);
            });
        });
    });

    router.get('/history/:topic(*)', (req, res) => {
        const topic = req.params.topic;
        const brokerId = req.query.brokerId; 
        const limit = parseInt(req.query.limit, 10) || 20;
        const startDate = req.query.startDate;
        const endDate = req.query.endDate;

        if (!topic) return res.status(400).json({ error: "Topic not specified." });

        let query = `SELECT * FROM mqtt_events WHERE topic = ?`;
        let params = [topic];

        if (brokerId) {
            query += " AND broker_id = ?";
            params.push(brokerId);
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
            // [FIX] Use spread operator ...params
            db.all(query, ...params, (err, rows) => {
                if (err) {
                    console.error("❌ History Query Error:", err);
                    return res.status(500).json({ error: "Database query failed." });
                }
                const results = rows.map(row => {
                     if (typeof row.payload === 'object' && row.payload !== null) {
                         try { row.payload = JSON.stringify(row.payload); } catch (e) {}
                    }
                    return row;
                });
                res.json(results);
            });
        });
    });

    return router;
};