/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 */

const wsManager = require('../core/websocketManager');
const connectorManager = require('../connectors/connectorManager'); 
const simulatorManager = require('../core/simulatorManager');
const dataManager = require('../storage/dataManager'); 
const alertManager = require('../core/engine/alertManager'); 
const semanticManager = require('../core/semantic/semanticManager'); 
const { EventEmitter } = require('events');

/**
 * Initializes and wires all application services.
 * @param {Object} server HTTP Server.
 * @param {Object} app Express App.
 * @param {Object} db Database connection.
 * @param {import('./config').AppConfig} config App configuration.
 * @param {Object} logger Logger instance.
 * @param {Object} paths File paths.
 * @param {Object} state Global state objects (activeConnections, brokerStatuses, etc.)
 * @returns {Object} Initialized managers and services.
 */
function initServices(server, app, db, config, logger, paths, state) {
    const { 
        activeConnections, 
        brokerStatuses, 
        i3xEvents,
        longReplacer,
        updateBrokerStatus,
        isShuttingDown
    } = state;

    // 1. Initialize Semantic Manager
    semanticManager.init({ logger, config });

    // 2. Initialize Mapper Engine
    const mapperEngine = require('../core/engine/mapperEngine')( 
        activeConnections, 
        wsManager.broadcast, 
        logger,
        longReplacer,
        config 
    );
    mapperEngine.setDb(db);

    // 3. Initialize DB Manager for maintenance
    const dbManager = require('../storage/dbManager')(
        db, 
        paths.DB_PATH, 
        paths.DB_PATH + '.wal', 
        wsManager.broadcast, 
        logger, 
        config.DUCKDB_MAX_SIZE_MB, 
        config.DUCKDB_PRUNE_CHUNK_SIZE, 
        () => state.isPruning, 
        (status) => { state.isPruning = status; }
    );

    // 4. Initialize Data Manager
    dataManager.init(config, logger, mapperEngine, db, dbManager.broadcastDbStatus);

    // 5. Initialize WebSockets
    wsManager.initWebSocketManager(
        server, 
        db, 
        logger, 
        config.BASE_PATH, 
        dbManager.getDbStatus, 
        longReplacer, 
        () => brokerStatuses
    );

    // 6. Intercept wsManager.broadcast to feed I3X Event Bus
    const originalBroadcast = wsManager.broadcast;
    wsManager.broadcast = (msgStr) => {
        originalBroadcast(msgStr);
        try {
            const msg = JSON.parse(msgStr);
            if (msg.type === 'mqtt-message') {
                let payloadObj = msg.payload;
                try { 
                    payloadObj = JSON.parse(msg.payload); 
                } catch(e){
                    logger.debug({ err: e, topic: msg.topic }, "I3X broadcast interceptor: Payload is not standard JSON, forwarding raw.");
                }
                i3xEvents.emit('data', { topic: msg.topic, payloadObject: payloadObj });
            }
        } catch (e) {
            logger.error({ err: e }, "I3X broadcast interceptor: Failed to parse WebSocket envelope message");
        }
    };

    // 7. Initialize Connector Manager
    connectorManager.init({ 
        config,
        logger,
        app,
        activeConnections,
        brokerStatuses,
        wsManager,
        mapperEngine,
        dataManager,
        alertManager,
        CERTS_PATH: paths.CERTS_PATH,
        broadcastDbStatus: dbManager.broadcastDbStatus,
        updateBrokerStatus,
        isShuttingDown
    });

    // 8. Initialize Simulators
    simulatorManager.init(logger, (topic, payload) => {
        const conn = state.getPrimaryConnection();
        if (conn && conn.connected) {
            conn.publish(topic, payload, { qos: 1 });
        }
    }, config.IS_SPARKPLUG_ENABLED);

    // 9. Maintenance Intervals
    const maintenanceTimer = setInterval(dbManager.performMaintenance, 15000);

    return {
        mapperEngine,
        dbManager,
        wsManager,
        connectorManager,
        simulatorManager,
        maintenanceTimer
    };
}

module.exports = { initServices };
