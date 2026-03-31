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
 * DLQ (Dead Letter Queue) Manager
 *
 * Manages storage and retrieval of failed message batches that could not be inserted into the database.
 * This prevents data loss during transient database failures or schema mismatches.
 */

const fs = require('fs');
const path = require('path');

// --- Module-level State ---
let logger = null;
let config = null;
let DLQ_FILE_PATH = null;

/**
 * Initializes the DLQ Manager.
 * @param {pino.Logger} appLogger
 * @param {object} appConfig
 */
function init(appLogger, appConfig) {
    logger = appLogger.child({ component: 'DLQManager' });
    config = appConfig;

    const dlqDir = path.join(__dirname, '../data/dlq');
    DLQ_FILE_PATH = path.join(dlqDir, 'failed_events.jsonl');

    // Ensure DLQ directory exists
    if (!fs.existsSync(dlqDir)) {
        try {
            fs.mkdirSync(dlqDir, { recursive: true });
            logger.info(`✅ DLQ directory created: ${dlqDir}`);
        } catch (e) {
            logger.error({ err: e }, `❌ Failed to create DLQ directory: ${dlqDir}`);
        }
    }

    logger.info(`✅ DLQ Manager initialized. Target: ${DLQ_FILE_PATH}`);
}

/**
 * Appends a batch of failed messages to the DLQ file.
 * @param {Array} batch - Array of message objects.
 */
function push(batch) {
    if (!batch || batch.length === 0) return;

    try {
        // Convert batch to JSONL (one JSON object per line)
        const content = batch.map(msg => JSON.stringify(msg)).join('\n') + '\n';
        
        fs.appendFileSync(DLQ_FILE_PATH, content, 'utf8');
        logger.warn(`📥 Pushed ${batch.length} messages to DLQ due to DB failure.`);
    } catch (err) {
        logger.error({ err }, "❌ FATAL ERROR: Failed to write to DLQ file. Data loss occurred!");
    }
}

/**
 * Reads and returns the contents of the DLQ.
 * @returns {Array} Array of message objects from the DLQ.
 */
function getMessages() {
    if (!fs.existsSync(DLQ_FILE_PATH)) return [];

    try {
        const content = fs.readFileSync(DLQ_FILE_PATH, 'utf8');
        if (!content) return [];

        return content
            .split('\n')
            .filter(line => line.trim() !== '')
            .map(line => {
                try {
                    const msg = JSON.parse(line);
                    // Restore Date objects if needed (batch push might have stringified them)
                    if (msg.timestamp) msg.timestamp = new Date(msg.timestamp);
                    return msg;
                } catch (e) {
                    logger.error({ err: e, line }, "Failed to parse DLQ line");
                    return null;
                }
            })
            .filter(msg => msg !== null);
    } catch (err) {
        logger.error({ err }, "Failed to read DLQ file.");
        return [];
    }
}

/**
 * Clears the DLQ file.
 */
function clear() {
    try {
        if (fs.existsSync(DLQ_FILE_PATH)) {
            fs.unlinkSync(DLQ_FILE_PATH);
            logger.info("🗑️ DLQ cleared.");
        }
    } catch (err) {
        logger.error({ err }, "Failed to clear DLQ file.");
    }
}

module.exports = {
    init,
    push,
    getMessages,
    clear
};
