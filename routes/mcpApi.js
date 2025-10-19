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

module.exports = (db, getMainConnection, getSimulatorInterval, getDbStatus) => {
    const router = express.Router();

    // Endpoint to get the overall status of the application
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

    // Endpoint to get a flat list of all unique topics
    router.get('/topics', (req, res) => {
        db.all("SELECT DISTINCT topic FROM mqtt_events ORDER BY topic ASC", (err, rows) => {
            if (err) {
                return res.status(500).json({ error: "Failed to query topics from database." });
            }
            res.json(rows.map(r => r.topic));
        });
    });

    // Endpoint to get all topics structured as a hierarchical tree
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

    // --- fulltext search ---
    router.get('/search', (req, res) => {
        const query = req.query.q;
        if (!query || query.length < 3) {
            return res.status(400).json({ error: "Search query must be at least 3 characters long." });
        }
        
        // 1. Simple sanitization to prevent SQL injection (double up single quotes)
        const safeQuery = query.replace(/'/g, "''");
        const searchTerm = `%${safeQuery}%`;
        
        // 2. Direct injection of the term into the query.
        // We are no longer using $1, $2 which caused the error.
        const sqlQuery = `
            SELECT topic, payload, timestamp
            FROM mqtt_events
            WHERE 
                topic ILIKE '${searchTerm}' OR 
                CAST(payload AS VARCHAR) ILIKE '${searchTerm}'
            ORDER BY timestamp DESC
            LIMIT 25;
        `;
        
        // --- [DEBUG] Add logs to see the exact query ---
        console.log(`[DEBUG] Search Term: ${searchTerm}`);
        console.log(`[DEBUG] Executed SQL Query: ${sqlQuery}`);
        // --- [END DEBUG] ---

        // 3. Execute the query without a parameter array
        db.all(sqlQuery, (err, rows) => {
            if (err) {
                console.error("❌ DuckDB search query error:", err);
                return res.status(500).json({ error: "Database search query failed." });
            }
            res.json(rows);
        });
    });

    // Endpoint to get the latest message for a specific topic
    router.get('/topic/:topic(.*)', (req, res) => {
        const topic = req.params.topic;
        if (!topic) {
            return res.status(400).json({ error: "Topic not specified." });
        }
        db.all("SELECT * FROM mqtt_events WHERE topic = ? ORDER BY timestamp DESC LIMIT 1", [topic], (err, rows) => {
            if (err) {
                return res.status(500).json({ error: "Database query failed." });
            }
            if (!rows || rows.length === 0) {
                return res.status(404).json({ error: `No data found for topic: ${topic}` });
            }
            res.json(rows[0]);
        });
    });
    
    // Endpoint to get history for a specific topic
    router.get('/history/:topic(.*)', (req, res) => {
        const topic = req.params.topic;
        const limit = parseInt(req.query.limit, 10) || 20;
        if (!topic) {
            return res.status(400).json({ error: "Topic not specified." });
        }
        db.all(`SELECT * FROM mqtt_events WHERE topic = ? ORDER BY timestamp DESC LIMIT ${limit}`, [topic], (err, rows) => {
            if (err) {
                console.error("History query failed:", err);
                return res.status(500).json({ error: "Database query failed." });
            }
            res.json(rows);
        });
    });

    return router;
};