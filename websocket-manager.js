/**
 * @license MIT
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

/**
 * Initializes the WebSocket Manager.
 * @param {http.Server} server - The HTTP server to attach to.
 * @param {duckdb.Database} database - The DuckDB instance.
 * @param {pino.Logger} appLogger - The main pino logger.
 * @param {string} basePath - The application's base path.
 * @param {function} getDbCallback - The getDbStatus function from db_manager.
 * @param {function} replacer - The longReplacer function for JSON stringify.
 */
function initWebSocketManager(server, database, appLogger, basePath, getDbCallback, replacer) {
    db = database;
    logger = appLogger.child({ component: 'WebSocketManager' });
    appBasePath = basePath;
    longReplacer = replacer; 
    getDbStatus = getDbCallback;
    
    wss = new WebSocketServer({ server });
    
    wss.on('connection', (ws, req) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (!url.pathname.startsWith(appBasePath)) {
            logger.warn(`WebSocket connection rejected: Path ${url.pathname} does not match base path ${appBasePath}`);
            ws.terminate();
            return;
        }
        
        logger.info('✅ ➡️ WebSocket client connected.');

        // Send initial batch of historical data
        db.all("SELECT * FROM mqtt_events ORDER BY timestamp DESC LIMIT 200", (err, rows) => {
            if (!err && ws.readyState === ws.OPEN) {
                const processedRows = rows.map(row => {
                    if (typeof row.payload === 'object' && row.payload !== null) {
                        try {
                            row.payload = JSON.stringify(row.payload, longReplacer);
                        } catch (e) {
                            logger.warn({ err: e, topic: row.topic }, "Failed to stringify history payload");
                            row.payload = JSON.stringify({ "error": "Failed to stringify payload" });
                        }
                    } else if (row.payload === null) {
                        row.payload = 'null';
                    }
                    return row;
                });
                ws.send(JSON.stringify({ type: 'history-initial-data', data: processedRows }));
            }
        });

        // Send initial tree state (latest message for EVERY topic)
        const treeStateQuery = `
            WITH RankedEvents AS (
                SELECT *, ROW_NUMBER() OVER(PARTITION BY topic ORDER BY timestamp DESC) as rn
                FROM mqtt_events
            )
            SELECT topic, payload, timestamp
            FROM RankedEvents
            WHERE rn = 1
            ORDER BY topic ASC;
        `;
        db.all(treeStateQuery, (err, rows) => {
            if (err) {
                logger.error({ err }, "❌ DuckDB Error fetching initial tree state");
            } else if (ws.readyState === ws.OPEN) {
                const processedRows = rows.map(row => {
                    if (typeof row.payload === 'object' && row.payload !== null) {
                        try {
                            row.payload = JSON.stringify(row.payload, longReplacer);
                        } catch (e) {
                            logger.warn({ err: e, topic: row.topic }, "Failed to stringify tree-state payload");
                            row.payload = JSON.stringify({ "error": "Failed to stringify payload" });
                        }
                    } else if (row.payload === null) {
                        row.payload = 'null';
                    }
                    return row;
                });
                ws.send(JSON.stringify({ type: 'tree-initial-state', data: processedRows }));
            }
        });

        // Handle messages from client
        ws.on('message', (message) => {
            try {
                const parsedMessage = JSON.parse(message);
                if (parsedMessage.type === 'get-topic-history' && parsedMessage.topic) {
                    db.all("SELECT * FROM mqtt_events WHERE topic = ? ORDER BY timestamp DESC LIMIT 20", [parsedMessage.topic], (err, rows) => {
                        if (err) {
                            logger.error({ err, topic: parsedMessage.topic }, `❌ DuckDB Error fetching history for topic`);
                        } else if (ws.readyState === ws.OPEN) {
                            const processedRows = rows.map(row => {
                                if (typeof row.payload === 'object' && row.payload !== null) {
                                    try {
                                        row.payload = JSON.stringify(row.payload, longReplacer);
                                    } catch (e) {
                                        logger.warn({ err: e, topic: row.topic }, "Failed to stringify topic-history payload");
                                        row.payload = JSON.stringify({ "error": "Failed to stringify payload" });
                                    }
                                } else if (row.payload === null) {
                                    row.payload = 'null';
                                }
                                return row;
                            });
                            ws.send(JSON.stringify({ type: 'topic-history-data', topic: parsedMessage.topic, data: processedRows }));
                        }
                    });
                }
            } catch (e) {
                logger.error({ err: e }, "❌ Error processing WebSocket message from client");
            }
        });
        
        // Send current DB status on connect
        if (getDbStatus) {
            getDbStatus((statusData) => {
                if (ws.readyState === ws.OPEN) {
                    ws.send(JSON.stringify(statusData));
                }
            });
        }
    });
    
    logger.info('✅ WebSocket Manager initialized.');
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