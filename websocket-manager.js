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
 * WebSocket Manager
 * Handles WebSocket server setup, client connections, and broadcasting.
 */

const { WebSocketServer } = require('ws');

let wss = null;
let db = null;
let logger = null;
let appBasePath = '/';
let longReplacer = null; 
let getDbStatus = null; 
let getBrokerStatuses = null; 

// Helper to escape single quotes for SQL strings
const escapeSQL = (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(/'/g, "''");
}

/**
 * Initializes the WebSocket Manager.
 * @param {http.Server} server - The HTTP server to attach to.
 * @param {duckdb.Database} database - The DuckDB instance.
 * @param {pino.Logger} appLogger - The main pino logger.
 * @param {string} basePath - The application's base path.
 * @param {function} getDbCallback - The getDbStatus function from db_manager.
 * @param {function} replacer - The longReplacer function for JSON stringify.
 * @param {function} getBrokerStatusesCallback - Callback to get current broker statuses.
 */
function initWebSocketManager(server, database, appLogger, basePath, getDbCallback, replacer, getBrokerStatusesCallback) {
    db = database;
    logger = appLogger.child({ component: 'WebSocketManager' });
    appBasePath = basePath;
    longReplacer = replacer; 
    getDbStatus = getDbCallback;
    getBrokerStatuses = getBrokerStatusesCallback;
    
    // [CRITICAL FIX] "noServer: true"
    // We detach the WebSocket server from the HTTP server's default routing.
    // We will handle the 'upgrade' event manually below. This solves issues where
    // reverse proxies strip paths (e.g. /webapp/foo -> /) causing 'ws' to reject the path.
    wss = new WebSocketServer({ noServer: true });
    
    // Manual Upgrade Handling
    server.on('upgrade', (request, socket, head) => {
        const reqUrl = request.url;
        
        // Log the exact URL received by Node.js (useful to debug what Redbird is sending)
        logger.info(`🔄 HTTP Upgrade Request received on path: '${reqUrl}'`);

        // We accept ALL upgrades on this server port, regardless of path.
        // This makes the server resilient to whatever path rewriting the proxy did.
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    });

    wss.on('connection', (ws, req) => {
        // Log successful connection
        logger.info('✅ ➡️ WebSocket client connected successfully.');

        // 0. Send Broker Statuses (Immediate UI feedback)
        if (getBrokerStatuses) {
            const statuses = getBrokerStatuses();
            // Convert Map to Object for JSON serialization
            const statusObj = Object.fromEntries(statuses);
            ws.send(JSON.stringify({ 
                type: 'broker-status-all', 
                data: statusObj 
            }));
        }

        // 1. Send DB Bounds (Absolute Min/Max)
        db.all("SELECT MIN(timestamp) as min_ts, MAX(timestamp) as max_ts FROM mqtt_events", (err, rows) => {
            if (!err && rows && rows.length > 0) {
                //  Use timestamp value instead of ISO string
                const min = rows[0].min_ts ? new Date(rows[0].min_ts).getTime() : 0;
                const max = rows[0].max_ts ? new Date(rows[0].max_ts).getTime() : Date.now();

                // Check if connection is still open before sending
                if (ws.readyState === ws.OPEN) {
                    ws.send(JSON.stringify({ 
                        type: 'db-bounds', 
                        min: min, 
                        max: max 
                    }));
                }
            }
        });

        // 2. Send initial batch (Latest 200)
        db.all("SELECT timestamp, topic, payload, broker_id FROM mqtt_events ORDER BY timestamp DESC LIMIT 200", (err, rows) => {
            if (!err && ws.readyState === ws.OPEN) {
                const processedRows = rows.map(row => processRow(row));
                // Reverse to chronological order for charts/history
                ws.send(JSON.stringify({ type: 'history-initial-data', data: processedRows }));
            }
        });

        // 3. Send initial tree state
        const treeStateQuery = `
            WITH RankedEvents AS (
                SELECT *, ROW_NUMBER() OVER(PARTITION BY broker_id, topic ORDER BY timestamp DESC) as rn
                FROM mqtt_events
            )
            SELECT topic, payload, timestamp, broker_id
            FROM RankedEvents
            WHERE rn = 1
            ORDER BY broker_id, topic ASC;
        `;
        db.all(treeStateQuery, (err, rows) => {
            if (!err && ws.readyState === ws.OPEN) {
                const processedRows = rows.map(row => processRow(row));
                ws.send(JSON.stringify({ type: 'tree-initial-state', data: processedRows }));
            }
        });

        // Handle messages from client
        ws.on('message', (message) => {
            try {
                const parsedMessage = JSON.parse(message);
                
                //  Handle Range Request with filter
                if (parsedMessage.type === 'get-history-range') {
                    const { start, end, filter } = parsedMessage;
                    
                    const safeStart = start || 0;
                    const safeEnd = end || Date.now();
                    
                    let whereClauses = [
                        // [CRITICAL FIX] Cast the numeric JavaScript timestamp (ms) to TIMESTAMPTZ (requires seconds)
                        `timestamp >= to_timestamp(${safeStart} / 1000.0)`, 
                        `timestamp <= to_timestamp(${safeEnd} / 1000.0)`
                    ];
                    let limit = 5000;
                    
                    if (filter && filter.length >= 3) {
                         const safeSearchTerm = `%${escapeSQL(filter)}%`;
                         
                         whereClauses.push(
                             `(topic ILIKE '${safeSearchTerm}' OR (json_valid(payload) AND (
                                CAST(payload->>'description' AS VARCHAR) ILIKE '${safeSearchTerm}'
                                OR CAST(payload->>'raw_payload' AS VARCHAR) ILIKE '${safeSearchTerm}'
                                OR CAST(payload->>'value' AS VARCHAR) ILIKE '${safeSearchTerm}'
                                OR CAST(payload->>'status' AS VARCHAR) ILIKE '${safeSearchTerm}'
                                OR CAST(payload->>'name' AS VARCHAR) ILIKE '${safeSearchTerm}'
                               )))`
                         );
                        // If filter is active, increase the limit but still cap it
                        limit = 10000;
                    }

                    const query = `
                        SELECT timestamp, topic, payload, broker_id 
                        FROM mqtt_events 
                        WHERE ${whereClauses.join(' AND ')}
                        ORDER BY timestamp DESC 
                        LIMIT ${limit};
                    `;

                    db.all(query, (err, rows) => {
                        if (err) {
                            logger.error({ err, query: query }, "Error fetching history range");
                            // Send an error message back
                            ws.send(JSON.stringify({ 
                                type: 'history-range-data', 
                                error: "Database query failed.",
                                data: []
                            }));
                        } else if (ws.readyState === ws.OPEN) {
                            const processedRows = rows.map(row => processRow(row));
                            ws.send(JSON.stringify({ 
                                type: 'history-range-data', 
                                data: processedRows,
                                requestStart: safeStart,
                                requestEnd: safeEnd,
                                filterApplied: filter
                            }));
                        }
                    });
                }

                if (parsedMessage.type === 'get-topic-history' && parsedMessage.topic) {
                    const topic = parsedMessage.topic;
                    let brokerId = parsedMessage.brokerId; 
                    
                    let query = "SELECT timestamp, topic, payload, broker_id FROM mqtt_events WHERE topic = ?";
                    let params = [topic];

                    if (brokerId) {
                        // [FIX] Alias 'default' to 'default_broker' to match DB migration
                        if (brokerId === 'default') brokerId = 'default_broker';
                        
                        query += " AND broker_id = ?";
                        params.push(brokerId);
                    }
                    query += " ORDER BY timestamp DESC LIMIT 20";

                    // [CRITICAL FIX] Use spread operator ...params because DuckDB node client 
                    // expects variadic arguments (sql, arg1, arg2, callback), NOT an array.
                    db.all(query, ...params, (err, rows) => {
                        if (err) {
                            logger.error({ err, query, params }, "❌ Error fetching recent topic history.");
                        } else if (ws.readyState === ws.OPEN) {
                            const processedRows = rows.map(row => processRow(row));
                            ws.send(JSON.stringify({ type: 'topic-history-data', topic: topic, brokerId: brokerId, data: processedRows }));
                        }
                    });
                }
            } catch (e) {
                logger.error({ err: e }, "❌ Error processing WebSocket message from client");
            }
        });
        
        if (getDbStatus) {
            getDbStatus((statusData) => {
                if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(statusData));
            });
        }
    });
    
    logger.info('✅ WebSocket Manager initialized (Manual Upgrade Mode).');
}

// Helper to process row JSON/BigInt
function processRow(row) {
    // DuckDB returns timestamps as strings, convert to milliseconds since epoch
    if (typeof row.timestamp === 'string') {
        row.timestampMs = new Date(row.timestamp).getTime();
    } else {
         row.timestampMs = row.timestamp;
    }
    
    if (typeof row.payload === 'object' && row.payload !== null) {
        try {
            row.payload = JSON.stringify(row.payload, longReplacer);
        } catch (e) {
            row.payload = JSON.stringify({ "error": "Failed to stringify payload" });
        }
    } else if (row.payload === null) {
        row.payload = 'null';
    }
    return row;
}

/**
 * Broadcasts a message to all connected WebSocket clients.
 * @param {string} message - The JSON string to send.
 */
function broadcast(message) {
    if (!wss) return;
    wss.clients.forEach(client => {
        if (client.readyState === client.OPEN) {
            client.send(message);
        }
    });
}

/**
 * Closes all WebSocket connections.
 * @param {function} callback - Callback to run when server is closed.
 */
function close(callback) {
    if (wss) {
        logger.info('Closing WebSocket server...');
        wss.clients.forEach(ws => ws.terminate());
        wss.close(() => {
            logger.info('✅ WebSocket server closed.');
            if (callback) callback();
        });
    } else {
        if (callback) callback();
    }
}

module.exports = {
    initWebSocketManager,
    broadcast,
    close
};