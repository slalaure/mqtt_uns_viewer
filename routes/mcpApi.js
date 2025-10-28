/**
 * @license MIT
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const express = require('express');

// Helper simple pour échapper les apostrophes
const escapeSQL = (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(/'/g, "''");
}

// Helper pour convertir le pattern MQTT en SQL LIKE
const mqttToSqlLike = (topicPattern) => {
    // 1. Échapper les caractères SQL LIKE
    let escaped = escapeSQL(topicPattern)
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
    
    // 2. Convertir les wildcards MQTT en wildcards SQL LIKE
    // Remplace '+' (un seul niveau) par '%' (tout sauf '/')
    // C'est une simplification, le vrai '%' de SQL matcherait '/'.
    // Une meilleure approche utilise REGEXP mais LIKE est plus simple.
    // Pour DuckDB, LIKE est suffisant.
    
    // Remplace '#' (multi-niveau) par '%'
    // 'a/#' -> 'a/%'
    escaped = escaped.replace(/#/g, '%');
    
    // Remplace '+' (un-niveau) par '%'
    // 'a/+/c' -> 'a/%/c'
    // C'est une approximation. Un vrai '+' ne matche pas '/'.
    // DuckDB supporte regexp_matches(topic, pattern) mais c'est plus lent.
    // Pour cette app, LIKE est suffisant.
    escaped = escaped.replace(/\+/g, '%');

    // S'il finit par '/%', on enlève le '/' pour matcher 'a/#' -> 'a'
    if (escaped.endsWith('/%')) {
        escaped = escaped.substring(0, escaped.length - 2) + '%';
    }
    
    return escaped;
}


module.exports = (db, getMainConnection, getSimulatorInterval, getDbStatus) => {
    const router = express.Router();

    // ... (les routes /status, /topics, /tree restent inchangées) ...
    router.get('/status', (req, res) => {
        getDbStatus(statusData => {
            const mainConnection = getMainConnection();
            const simulatorInterval = getSimulatorInterval();
            res.json({
                mqtt_connected: mainConnection ? mainConnection.connected : false,
                simulator_status: simulatorInterval ? 'running' : 'stopped',
                database_stats: {
                    total_messages: statusData.totalMessages,
                    size_mb: parseFloat(statusData.dbSizeMB.toFixed(2)),
                    size_limit_mb: statusData.dbLimitMB
                }
            });
        });
    });
    router.get('/topics', (req, res) => {
        db.all("SELECT DISTINCT topic FROM mqtt_events ORDER BY topic ASC", (err, rows) => {
            if (err) {
                return res.status(500).json({ error: "Failed to query topics from database." });
            }
            res.json(rows.map(r => r.topic));
        });
    });
    router.get('/tree', (req, res) => {
        db.all("SELECT DISTINCT topic FROM mqtt_events", (err, rows) => {
            if (err) {
                return res.status(500).json({ error: "Failed to query topics from database." });
            }
            const topics = rows.map(r => r.topic);
            const tree = {};
            topics.forEach(topic => {
                let currentLevel = tree;
                const parts = topic.split('/');
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


    
    router.get('/search', (req, res) => {
        const query = req.query.q;
        if (!query || query.length < 3) {
            return res.status(400).json({ error: "Search query must be at least 3 characters long." });
        }

        const safeSearchTerm = `%${escapeSQL(query)}%`;
        const limit = 5000;

        // Simplified Query + Explicit CAST to VARCHAR for all ->> operations
        const sqlQuery = `
            SELECT topic, payload, timestamp
            FROM mqtt_events
            WHERE
                topic ILIKE '${safeSearchTerm}' -- Search in topic name
                OR (json_valid(payload) AND ( -- Only check JSON fields if payload is valid JSON
                    -- Explicitly CAST results of ->> to VARCHAR before ILIKE
                    CAST(payload->>'description' AS VARCHAR) ILIKE '${safeSearchTerm}'
                    OR CAST(payload->>'raw_payload' AS VARCHAR) ILIKE '${safeSearchTerm}'
                    OR CAST(payload->>'value' AS VARCHAR) ILIKE '${safeSearchTerm}'
                    OR CAST(payload->>'status' AS VARCHAR) ILIKE '${safeSearchTerm}'
                    OR CAST(payload->>'name' AS VARCHAR) ILIKE '${safeSearchTerm}' -- Error occurred here previously
                   ))
            ORDER BY timestamp DESC
            LIMIT ${limit};
        `;

        // Log the query for debugging
        console.log(`[DEBUG] Full-Text Search Query: ${sqlQuery.replace(/\s+/g, ' ')}`);

        // Execute the query
        db.all(sqlQuery, (err, rows) => {
            if (err) {
                console.error("❌ Error search request DuckDB (Full-Text):", err);
                console.error("   Failed Query:", sqlQuery); // Log the failed query
                return res.status(500).json({ error: "Database search query failed." });
            }

            // Convert payload objects back to strings for the client
            const results = rows.map(row => {
                if (typeof row.payload === 'object' && row.payload !== null) {
                    try {
                        // Using standard stringify here as longReplacer isn't available in this scope
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

    // --- [VERSION 17 - CTE + ->>] ---
    router.post('/search/model', (req, res) => {
        const { topic_template, json_filter_key, json_filter_value } = req.body;

        if (!topic_template) {
            return res.status(400).json({ error: "Missing 'topic_template' (e.g., '%/erp/workorder')." });
        }

        const safe_topic = escapeSQL(topic_template);
        const limit = 5000;

        let sqlQuery;

        if (json_filter_key && json_filter_value) {
            const safe_json_key = "'" + escapeSQL(json_filter_key) + "'";
            const safe_json_value = "'" + escapeSQL(json_filter_value) + "'";
            
            // --- [LA CORRECTION EST ICI] ---
            // On utilise le CTE pour filtrer le topic d'abord,
            // PUIS on applique l'opérateur ->> sur le payload (qui est un OBJET)
            sqlQuery = `
                WITH FilteredTopics AS (
                    SELECT * FROM mqtt_events
                    WHERE topic LIKE '${safe_topic}'
                )
                SELECT topic, payload, timestamp
                FROM FilteredTopics
                WHERE CAST((CAST(payload AS VARCHAR)::JSON)->>${safe_json_key} AS VARCHAR) = ${safe_json_value}
                ORDER BY timestamp DESC
                LIMIT ${limit};
            `;
             // Note: On n'a plus besoin du CAST AS VARCHAR car ->> retourne du texte.

        } else {
             sqlQuery = `
                SELECT topic, payload, timestamp
                FROM mqtt_events
                WHERE topic LIKE '${safe_topic}'
                ORDER BY timestamp DESC
                LIMIT ${limit}
            `;
        }
        
        console.log(`[DEBUG] Model Search Query (V17 avec CTE + ->>): ${sqlQuery.replace(/\s+/g, ' ')}`);

        // Appel de la DB avec 2 arguments (sql, callback)
        db.all(sqlQuery, (err, rows) => {
            if (err) {
                console.error("❌ Erreur de la requête de recherche par modèle (V17):", err);
                return res.status(500).json({ error: "Database model search query failed." });
            }
             // [V17 Fix] Le payload est un OBJET, mais le client s'attend à un STRING
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

    // --- Endpoint to purger a topic from DB ---
    router.post('/prune-topic', (req, res) => {
        const { topicPattern } = req.body;
        if (!topicPattern) {
            return res.status(400).json({ error: "Missing 'topicPattern'." });
        }

        const sqlPattern = mqttToSqlLike(topicPattern);
        console.log(`[INFO] Pruning topics from DB matching pattern: ${topicPattern} (SQL: ${sqlPattern})`);

        const query = `DELETE FROM mqtt_events WHERE topic LIKE '${sqlPattern}';`;
        
        // how many lines affected
        db.run(query, function(err) { // Ne pas utiliser de fonction fléchée ici pour garder 'this'
            if (err) {
                console.error("❌ Erreur de la requête de purge (prune-topic):", err);
                return res.status(500).json({ error: "Database prune query failed." });
            }
            
            const changes = this.changes;
            console.log(`[INFO] Prune successful. Deleted ${changes} entries.`);

            // launch  checkpoint/vacuum in background
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


   
    router.get('/topic/:topic(.*)', (req, res) => {
        const topic = req.params.topic;
        if (!topic) {
            return res.status(400).json({ error: "Topic not specified." });
        }
        const safe_topic = escapeSQL(topic);
        db.all(`SELECT * FROM mqtt_events WHERE topic = '${safe_topic}' ORDER BY timestamp DESC LIMIT 1`, (err, rows) => {
            if (err) {
                return res.status(500).json({ error: "Database query failed." });
            }
            if (!rows || rows.length === 0) {
                return res.status(404).json({ error: `No data found for topic: ${topic}` });
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
    router.get('/history/:topic(.*)', (req, res) => {
        const topic = req.params.topic;
        const limit = parseInt(req.query.limit, 10) || 20;
        if (!topic) {
            return res.status(400).json({ error: "Topic not specified." });
        }
        const safe_topic = escapeSQL(topic);
        const safe_limit = isNaN(limit) ? 20 : limit;
        db.all(`SELECT * FROM mqtt_events WHERE topic = '${safe_topic}' ORDER BY timestamp DESC LIMIT ${safe_limit}`, (err, rows) => {
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