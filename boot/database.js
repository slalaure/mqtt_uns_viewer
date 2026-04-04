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
                CREATE TABLE IF NOT EXISTS mqtt_events (
                    timestamp TIMESTAMPTZ,
                    topic VARCHAR,
                    payload JSON,
                    broker_id VARCHAR,
                    correlation_id VARCHAR
                );
                CREATE TABLE IF NOT EXISTS app_config (
                    key VARCHAR PRIMARY KEY,
                    value JSON,
                    updated_at TIMESTAMPTZ DEFAULT current_timestamp
                );
            `, (createErr) => {
                if (createErr) {
                    logger.error({ err: createErr }, "❌ FATAL: Failed to ensure tables exist.");
                    return reject(createErr); 
                }
                // Schema Migration: Add correlation_id if missing
                db.all("PRAGMA table_info(mqtt_events);", (pragmaErr, columns) => {
                    if (columns && !columns.some(col => col.name === 'correlation_id')) {
                        logger.warn("⚠️ Migrating 'mqtt_events': Adding 'correlation_id' column...");
                        db.run("ALTER TABLE mqtt_events ADD COLUMN correlation_id VARCHAR;");
                    }
                });
                resolve(db);
            });
        });
    });
}

module.exports = { initDatabase };
