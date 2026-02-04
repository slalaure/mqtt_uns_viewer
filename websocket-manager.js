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
 * [UPDATED] Added Client ID generation and unicast (sendToClient) capability for Chat.
 */
const { WebSocketServer } = require('ws');
const crypto = require('crypto'); // Used for generating Client IDs

let wss = null;
let db = null;
let logger = null;
let appBasePath = '/';
let longReplacer = null; 
let getDbStatus = null; 
let getBrokerStatuses = null; 

// Map to store clients by ID: Map<string, WebSocket>
const clients = new Map();

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
    wss = new WebSocketServer({ noServer: true });

    // Manual Upgrade Handling
    server.on('upgrade', (request, socket, head) => {
        const reqUrl = request.url;
        logger.info(`🔄 HTTP Upgrade Request received on path: '${reqUrl}'`);
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    });

    wss.on('connection', (ws, req) => {
        // 1. Assign a Unique ID to this client
        const clientId = crypto.randomUUID();
        clients.set(clientId, ws);
        
        logger.info(`✅ ➡️ WebSocket client connected. Assigned ID: ${clientId}`);

        // 2. Send Welcome Message with ID (Handshake)
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ 
                type: 'welcome', 
                clientId: clientId,
                message: 'Connected to MQTT UNS Viewer Realtime Socket'
            }));
        }

        // 0. Send Broker Statuses (Immediate UI feedback)
        if (getBrokerStatuses) {
            const statuses = getBrokerStatuses();
            const statusObj = Object.fromEntries(statuses);
            ws.send(JSON.stringify({ 
                type: 'broker-status-all', 
                data: statusObj 
            }));
        }

        // 1. Send DB Bounds
        db.all("SELECT epoch_ms(MIN(timestamp)) as min_ts, epoch_ms(MAX(timestamp)) as max_ts FROM mqtt_events", (err, rows) => {
            if (!err && rows && rows.length > 0) {
                const min = rows[0].min_ts ? Number(rows[0].min_ts) : 0;
                const max = rows[0].max_ts ? Number(rows[0].max_ts) : Date.now();
                if (ws.readyState === ws.OPEN) {
                    ws.send(JSON.stringify({ type: 'db-bounds', min, max }));
                }
            }
        });

        // 2. Send initial batch
        logger.info("[WS] Fetching initial data batch (LIMIT 200)...");
        db.all("SELECT timestamp, topic, payload, broker_id FROM mqtt_events ORDER BY timestamp DESC LIMIT 200", (err, rows) => {
            if (err) logger.error({ err }, "❌ Error fetching initial data.");
            else if (ws.readyState === ws.OPEN) {
                const processedRows = rows.map(row => processRow(row));
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

        ws.on('message', (message) => {
            try {
                const parsedMessage = JSON.parse(message);

                // --- History Range Query ---
                if (parsedMessage.type === 'get-history-range') {
                    const { start, end, filter } = parsedMessage;
                    const safeStart = start || 0;
                    const safeEnd = end || Date.now();
                    const startIso = new Date(safeStart).toISOString();
                    const endIso = new Date(safeEnd).toISOString();

                    logger.info(`[WS Debug] Range Request: ${startIso} -> ${endIso}`);

                    let whereClauses = [
                        `timestamp >= CAST('${startIso}' AS TIMESTAMPTZ)`, 
                        `timestamp <= CAST('${endIso}' AS TIMESTAMPTZ)`
                    ];

                    let limit = 20000;
                    if (filter && filter.length >= 3) {
                         const safeSearchTerm = `%${escapeSQL(filter)}%`;
                         whereClauses.push(
                             `(topic ILIKE '${safeSearchTerm}' OR CAST(payload AS VARCHAR) ILIKE '${safeSearchTerm}')`
                         );
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
                            logger.error({ err, query }, "❌ Error fetching history range");
                            ws.send(JSON.stringify({ type: 'history-range-data', error: "Query failed.", data: [] }));
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
                        if (brokerId === 'default') brokerId = 'default_broker';
                        query += " AND broker_id = ?";
                        params.push(brokerId);
                    }
                    query += " ORDER BY timestamp DESC LIMIT 20";
                    
                    db.all(query, ...params, (err, rows) => {
                        if (!err && ws.readyState === ws.OPEN) {
                            const processedRows = rows.map(row => processRow(row));
                            ws.send(JSON.stringify({ type: 'topic-history-data', topic, brokerId, data: processedRows }));
                        }
                    });
                }
            } catch (e) {
                logger.error({ err: e }, "❌ Error processing WS message");
            }
        });

        // Cleanup on close
        ws.on('close', () => {
            clients.delete(clientId);
            // logger.info(`Client ${clientId} disconnected.`);
        });

        if (getDbStatus) {
            getDbStatus((statusData) => {
                if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(statusData));
            });
        }
    });

    logger.info('✅ WebSocket Manager initialized.');
}

// Helper to process row JSON/BigInt
function processRow(row) {
    if (typeof row.timestamp === 'string') {
        row.timestampMs = new Date(row.timestamp).getTime();
    } else if (typeof row.timestamp === 'object') {
         row.timestampMs = row.timestamp.getTime();
    } else {
         row.timestampMs = row.timestamp;
    }
    if (typeof row.payload === 'object' && row.payload !== null) {
        try { row.payload = JSON.stringify(row.payload, longReplacer); } 
        catch (e) { row.payload = JSON.stringify({ "error": "Failed to stringify" }); }
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
        if (client.readyState === client.OPEN) client.send(message);
    });
}

/**
 * Sends a message to a specific client by ID (Unicast).
 * @param {string} clientId - The ID of the target client.
 * @param {object} data - The JSON object to send.
 */
function sendToClient(clientId, data) {
    const client = clients.get(clientId);
    if (client && client.readyState === client.OPEN) {
        client.send(JSON.stringify(data));
        return true;
    }
    return false;
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
    sendToClient,
    close
};