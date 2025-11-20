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


//  Accept the 'config' object from server.js
module.exports = (db, getMainConnection, getSimulatorInterval, getDbStatus, config) => {
    const router = express.Router();
    const isMultiBroker = config.BROKER_CONFIGS.length > 1;

    router.get('/status', (req, res) => {
        getDbStatus(statusData => {
            const mainConnection = getMainConnection(); // This is the primary connection
            const simulatorStatuses = getSimulatorInterval(); // This is now getStatuses()
            
            // Check if *any* simulator is running
            const isSimRunning = Object.values(simulatorStatuses).some(s => s === 'running');

            res.json({
                mqtt_connected: mainConnection ? mainConnection.connected : false,
                //  Report simulator status correctly
                simulator_status: isSimRunning ? 'running' : 'stopped', 
                database_stats: {
                    total_messages: statusData.totalMessages,
                    size_mb: parseFloat(statusData.dbSizeMB.toFixed(2)),
                    size_limit_mb: statusData.dbLimitMB
                }
            });
        });
    });

    //  Returns list of objects { brokerId, topic }
    router.get('/topics', (req, res) => {
        db.all("SELECT DISTINCT broker_id, topic FROM mqtt_events ORDER BY broker_id, topic ASC", (err, rows) => {
            if (err) {
                return res.status(500).json({ error: "Failed to query topics from database." });
            }
            // Return full objects, not just strings
            res.json(rows);
        });
    });

    //  Builds a multi-broker tree if needed
    router.get('/tree', (req, res) => {
        db.all("SELECT DISTINCT broker_id, topic FROM mqtt_events", (err, rows) => {
            if (err) {
                return res.status(500).json({ error: "Failed to query topics from database." });
            }
            
            const tree = {};
            rows.forEach(row => {
                //  Conditionally add broker_id as root
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


    //  Accepts optional brokerId query param
    router.get('/search', (req, res) => {
        const query = req.query.q;
        const brokerId = req.query.brokerId; // [NEW]
        
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

        //  Add brokerId filter if provided
        if (brokerId) {
            whereClauses.push(`broker_id = '${escapeSQL(brokerId)}'`);
        }

        const sqlQuery = `
            SELECT topic, payload, timestamp, broker_id
            FROM mqtt_events
            WHERE ${whereClauses.join(' AND ')}
            ORDER BY timestamp DESC
            LIMIT ${limit};
        `;

        console.log(`[DEBUG] Full-Text Search Query: ${sqlQuery.replace(/\s+/g, ' ')}`);

        db.all(sqlQuery, (err, rows) => {
            if (err) {
                console.error("❌ Error search request DuckDB (Full-Text):", err);
                console.error("   Failed Query:", sqlQuery); 
                return res.status(500).json({ error: "Database search query failed." });
            }

            const results = rows.map(row => {
                if (typeof row.payload === 'object' && row.payload !== null) {
                    try {
                        row.payload = JSON.stringify(row.payload);
                    } catch (e) {
                         console.error("Error stringifying payload in /search:", e, row.payload);
                         row.payload = JSON.stringify({"error": "Failed to stringify payload"});
                    }
                } else if (row.payload === null) {
                    row.payload = 'null';
                }
                return row;
            });
            res.json(results);
        });
    });

    //  Accepts optional broker_id in body
    router.post('/search/model', (req, res) => {
        const { topic_template, filters, broker_id } = req.body; 

        if (!topic_template) {
            return res.status(400).json({ error: "Missing 'topic_template' (e.g., '%/erp/workorder')." });
        }

        const safe_topic = escapeSQL(topic_template);
        const limit = 5000;
        const useOptimizedQuery = config.DB_BATCH_INSERT_ENABLED === true;

        let whereClauses = [`topic LIKE '${safe_topic}'`];

        //  Add brokerId filter if provided
        if (broker_id) {
            whereClauses.push(`broker_id = '${escapeSQL(broker_id)}'`);
        }

        if (filters && typeof filters === 'object' && Object.keys(filters).length > 0) {
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
        
        const whereString = whereClauses.join(' AND ');

        let sqlQuery = `
            SELECT topic, payload, timestamp, broker_id
            FROM mqtt_events
            WHERE ${whereString}
            ORDER BY timestamp DESC
            LIMIT ${limit};
        `;
        
        if(useOptimizedQuery) {
            console.log(`[DEBUG] Model Search Query (Optimized): ${sqlQuery.replace(/\s+/g, ' ')}`);
        } else {
            console.log(`[DEBUG] Model Search Query (Legacy): ${sqlQuery.replace(/\s+/g, ' ')}`);
        }
        
        db.all(sqlQuery, (err, rows) => {
            if (err) {
                console.error("❌ Erreur de la requête de recherche par modèle:", err);
                return res.status(500).json({ error: "Database model search query failed." });
            }
            const results = rows.map(row => {
                if (typeof row.payload === 'object' && row.payload !== null) {
                     try {
                        row.payload = JSON.stringify(row.payload);
                    } catch (e) {
                         console.error("Error stringifying payload in /search/model:", e, row.payload);
                         row.payload = JSON.stringify({"error": "Failed to stringify payload"});
                    }
                } else if (row.payload === null) {
                    row.payload = 'null';
                }
                return row;
            });
            res.json(results);
        });
    });

    //  Accepts optional broker_id in body
    router.post('/prune-topic', (req, res) => {
        const { topicPattern, broker_id } = req.body;
        if (!topicPattern) {
            return res.status(400).json({ error: "Missing 'topicPattern'." });
        }

        const sqlPattern = mqttToSqlLike(topicPattern);
        let whereClauses = [`topic LIKE '${sqlPattern}'`];

        //  Add brokerId filter if provided
        if (broker_id) {
            whereClauses.push(`broker_id = '${escapeSQL(broker_id)}'`);
        }

        console.log(`[INFO] Pruning topics from DB matching: ${whereClauses.join(' AND ')}`);

        const query = `DELETE FROM mqtt_events WHERE ${whereClauses.join(' AND ')};`;
        
        db.run(query, function(err) { 
            if (err) {
                console.error("❌ Erreur de la requête de purge (prune-topic):", err);
                return res.status(500).json({ error: "Database prune query failed." });
            }
            
            const changes = this.changes;
            console.log(`[INFO] Prune successful. Deleted ${changes} entries.`);

            db.exec("CHECKPOINT; VACUUM;", (vacErr) => {
                if (vacErr) {
                    console.error("❌ Erreur durant le CHECKPOINT/VACUUM post-purge:", vacErr);
                } else {
                    console.log("[INFO] CHECKPOINT/VACUUM post-purge terminé.");
                }
            });

            res.json({ success: true, count: changes });
        });
    });


   
    //  Accepts optional brokerId query param
    router.get('/topic/:topic(.*)', (req, res) => {
        const topic = req.params.topic;
        const brokerId = req.query.brokerId; // [NEW]
        
        if (!topic) {
            return res.status(400).json({ error: "Topic not specified." });
        }

        let query = `SELECT * FROM mqtt_events WHERE topic = ?`;
        let params = [topic];

        //  Add brokerId filter if provided
        if (brokerId) {
            query += " AND broker_id = ?";
            params.push(brokerId);
        }
        
        query += " ORDER BY timestamp DESC LIMIT 1";
        
        db.all(query, params, (err, rows) => {
            if (err) {
                return res.status(500).json({ error: "Database query failed." });
            }
            if (!rows || rows.length === 0) {
                const errorMsg = brokerId ? `No data found for topic: ${topic} on broker: ${brokerId}` : `No data found for topic: ${topic}`;
                return res.status(404).json({ error: errorMsg });
            }

            const result = rows[0];
             if (typeof result.payload === 'object' && result.payload !== null) {
                 try {
                    result.payload = JSON.stringify(result.payload);
                } catch (e) {
                     console.error("Error stringifying payload in /topic:", e, result.payload);
                     result.payload = JSON.stringify({"error": "Failed to stringify payload"});
                }
            } else if (result.payload === null) {
                 result.payload = 'null';
            }
            res.json(result);
        });
    });

    //  Accepts optional brokerId query param
    router.get('/history/:topic(.*)', (req, res) => {
        const topic = req.params.topic;
        const brokerId = req.query.brokerId; // [NEW]
        const limit = parseInt(req.query.limit, 10) || 20;

        if (!topic) {
            return res.status(400).json({ error: "Topic not specified." });
        }
        
        const safe_limit = isNaN(limit) ? 20 : limit;

        let query = `SELECT * FROM mqtt_events WHERE topic = ?`;
        let params = [topic];

        //  Add brokerId filter if provided
        if (brokerId) {
            query += " AND broker_id = ?";
            params.push(brokerId);
        }

        query += " ORDER BY timestamp DESC LIMIT ?";
        params.push(safe_limit);
        
        db.all(query, params, (err, rows) => {
            if (err) {
                console.error("History query failed:", err);
                return res.status(500).json({ error: "Database query failed." });
            }

            const results = rows.map(row => {
                 if (typeof row.payload === 'object' && row.payload !== null) {
                     try {
                        row.payload = JSON.stringify(row.payload);
                    } catch (e) {
                         console.error("Error stringifying payload in /history:", e, row.payload);
                         row.payload = JSON.stringify({"error": "Failed to stringify payload"});
                    }
                } else if (row.payload === null) {
                    row.payload = 'null';
                }
                return row;
            });
            res.json(results);
        });
    });

    return router;
};