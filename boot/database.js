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

const duckdb = require('duckdb');
const userManager = require('../storage/userManager');
const alertManager = require('../core/engine/alertManager');
const webhookManager = require('../core/webhookManager');

/**
 * Initializes the database connection and ensures tables exist.
 * @param {Object} logger Pino logger instance.
 * @param {import('./config').AppConfig} config Application configuration.
 * @param {Object} paths File paths.
 * @param {Object} wsManager WebSocket manager.
 * @returns {Promise<Object>} The DuckDB connection.
 */
async function initDatabase(logger, config, paths, wsManager) {
    return new Promise((resolve, reject) => {
        const db = new duckdb.Database(paths.DB_PATH, (err) => {
            if (err) {
                logger.error({ err }, "❌ FATAL ERROR: Could not connect to DuckDB.");
                return reject(err);
            }
            logger.info("✅ 🦆 DuckDB database connected.");
            
            // 1. Initialize Managers that depend on DB
            userManager.init(db, logger, paths.SESSIONS_PATH);
            alertManager.init(db, logger, config, wsManager.broadcast);
            webhookManager.init(db, logger);
            
            // 2. Ensure Admin User Exists
            if (config.ADMIN_USERNAME && config.ADMIN_PASSWORD) {
                userManager.ensureAdminUser(config.ADMIN_USERNAME, config.ADMIN_PASSWORD);
            }
            
            // 3. Ensure tables exist
            db.exec(`
                -- Migration: Rename mqtt_events to korelate_events if it exists
                -- We use a TRY/CATCH style or check existence first. 
                -- DuckDB doesn't have RENAME TABLE IF EXISTS but we can check via pragma
                
                CREATE TABLE IF NOT EXISTS korelate_events (
                    timestamp TIMESTAMPTZ,
                    topic VARCHAR,
                    payload JSON,
                    source_id VARCHAR,
                    correlation_id VARCHAR,
                    connector_type VARCHAR
                );
                CREATE TABLE IF NOT EXISTS app_config (
                    key VARCHAR PRIMARY KEY,
                    value JSON,
                    updated_at TIMESTAMPTZ DEFAULT current_timestamp
                );
                CREATE TABLE IF NOT EXISTS api_keys (
                    id VARCHAR PRIMARY KEY,
                    api_key VARCHAR UNIQUE,
                    name VARCHAR,
                    scopes VARCHAR,
                    created_at TIMESTAMPTZ DEFAULT current_timestamp,
                    last_used_at TIMESTAMPTZ
                );
            `, (createErr) => {
                if (createErr) {
                    logger.error({ err: createErr }, "❌ FATAL: Failed to ensure tables exist.");
                    return reject(createErr); 
                }

                // Check if old table exists and migrate data
                db.all("PRAGMA table_info(mqtt_events);", (oldPragmaErr, oldColumns) => {
                    if (oldColumns && oldColumns.length > 0) {
                        logger.warn("⚠️ Migrating 'mqtt_events' to 'korelate_events'...");
                        db.run("INSERT INTO korelate_events (timestamp, topic, payload, source_id, correlation_id) SELECT timestamp, topic, payload, source_id, correlation_id FROM mqtt_events;", (insertErr) => {
                            if (!insertErr) {
                                db.run("DROP TABLE mqtt_events;");
                                logger.info("✅ Migration 'mqtt_events' -> 'korelate_events' completed.");
                                // set connector_type='mqtt' for legacy records? Let's default it
                                db.run("UPDATE korelate_events SET connector_type = 'mqtt' WHERE connector_type IS NULL;");
                            } else {
                                logger.error({ err: insertErr }, "❌ Failed to migrate data from 'mqtt_events' to 'korelate_events'.");
                            }
                        });
                    }
                });

                // Schema Migration: Add correlation_id if missing in korelate_events
                db.all("PRAGMA table_info(korelate_events);", (pragmaErr, columns) => {
                    if (columns && !columns.some(col => col.name === 'correlation_id')) {
                        logger.warn("⚠️ Migrating 'korelate_events': Adding 'correlation_id' column...");
                        db.run("ALTER TABLE korelate_events ADD COLUMN correlation_id VARCHAR;");
                    }
                    if (columns && !columns.some(col => col.name === 'connector_type')) {
                        logger.warn("⚠️ Migrating 'korelate_events': Adding 'connector_type' column...");
                        db.run("ALTER TABLE korelate_events ADD COLUMN connector_type VARCHAR;", (altErr) => {
                             if(!altErr) db.run("UPDATE korelate_events SET connector_type = 'mqtt' WHERE connector_type IS NULL;");
                        });
                    }
                });
                resolve(db);
            });
        });
    });
}

module.exports = { initDatabase };
