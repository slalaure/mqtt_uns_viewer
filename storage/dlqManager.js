/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025-2026 Sebastien Lalaurette
 *
 * DLQ (Dead Letter Queue) Manager
 *
 * Manages storage and retrieval of failed message batches that could not be inserted into the database.
 * [NEW] Implemented automatic exponential backoff retry mechanism.
 */

const fs = require('fs');
const path = require('path');
const { logError } = require('../core/errorUtils');

// --- Module-level State ---
let logger = null;
let config = null;
let DLQ_FILE_PATH = null;
let retryHandler = null; // Function to call for re-insertion: (repoName, message) => Promise<void>
let retryTimer = null;
const INITIAL_RETRY_DELAY_MS = 60000; // 1 minute
const MAX_RETRY_DELAY_MS = 3600000;  // 1 hour

/**
 * Initializes the DLQ Manager.
 */
function init(appLogger, appConfig) {
    logger = appLogger.child({ component: 'DLQManager' });
    config = appConfig;

    const dlqDir = path.join(__dirname, '../data/dlq');
    DLQ_FILE_PATH = path.join(dlqDir, 'failed_events.jsonl');

    if (!fs.existsSync(dlqDir)) {
        try {
            fs.mkdirSync(dlqDir, { recursive: true });
            logger.info(`✅ DLQ directory created: ${dlqDir}`);
        } catch (e) {
            logger.error({ err: e }, `❌ Failed to create DLQ directory: ${dlqDir}`);
        }
    }

    logger.info(`✅ DLQ Manager initialized. Target: ${DLQ_FILE_PATH}`);
    
    // Start the automatic retry job
    startRetryJob();
}

/**
 * Registers the function responsible for re-attempting the insertion.
 * Usually provided by DataManager to avoid circular dependencies.
 */
function registerRetryHandler(handler) {
    retryHandler = handler;
    logger.info("✅ DLQ retry handler registered.");
}

/**
 * Checks if the DLQ file exceeds the maximum allowed size and prunes the oldest lines.
 */
function checkAndPrune() {
    if (!fs.existsSync(DLQ_FILE_PATH)) return;
    
    const maxMB = config?.DLQ_MAX_SIZE_MB || 50;
    if (!maxMB || maxMB <= 0) return;

    try {
        const stats = fs.statSync(DLQ_FILE_PATH);
        const sizeMB = stats.size / (1024 * 1024);

        if (sizeMB > maxMB) {
            const chunkSize = config?.DLQ_PRUNE_CHUNK_SIZE || 1000;
            // Adaptive multiplier: If we are significantly over the limit, prune more aggressively
            let multiplier = 1;
            const overLimitRatio = sizeMB / maxMB;
            if (overLimitRatio > 2.0) multiplier = 20;
            else if (overLimitRatio > 1.5) multiplier = 10;
            else if (overLimitRatio > 1.2) multiplier = 5;
            else if (overLimitRatio > 1.1) multiplier = 2;

            const linesToDelete = chunkSize * multiplier;
            logger.warn(`⚠️ DLQ file size (${sizeMB.toFixed(2)} MB) exceeded limit (${maxMB} MB). Pruning oldest ${linesToDelete} messages to prevent OS failure...`);
            
            const content = fs.readFileSync(DLQ_FILE_PATH, 'utf8');
            const lines = content.split('\n');
            
            if (lines.length > 0 && lines[lines.length - 1] === '') {
                lines.pop();
            }

            if (lines.length <= linesToDelete) {
                clear();
                return;
            }

            const remainingLines = lines.slice(linesToDelete);
            const newContent = remainingLines.join('\n') + '\n';
            fs.writeFileSync(DLQ_FILE_PATH, newContent, 'utf8');
            
            logger.info(`✅ DLQ pruned successfully. Dropped ${linesToDelete} oldest batches. Remaining batches: ${remainingLines.length}.`);
        }
    } catch (err) {
        logError({
            logger,
            err,
            code: 'DLQ_PRUNE_ERROR',
            message: "❌ FATAL ERROR: Failed to prune DLQ file.",
            context: {}
        });
    }
}

/**
 * Appends a batch of failed messages to the DLQ file.
 * [UPDATED] Now accepts repoName to allow targeted retries.
 * @param {Array} batch - Array of message objects.
 * @param {string} repoName - The identifier of the repository that failed.
 */
function push(batch, repoName = 'unknown') {
    if (!batch || batch.length === 0) return;

    try {
        const now = Date.now();
        const content = batch.map(msg => {
            // Wrap message with DLQ metadata
            const dlqEnvelope = {
                repoName,
                retryCount: 0,
                lastRetry: now,
                nextRetry: now + INITIAL_RETRY_DELAY_MS,
                message: msg
            };
            return JSON.stringify(dlqEnvelope);
        }).join('\n') + '\n';
        
        fs.appendFileSync(DLQ_FILE_PATH, content, 'utf8');
        logger.warn({ repoName, count: batch.length }, `📥 Pushed messages to DLQ due to failure in ${repoName}.`);
        
        // Enforce max disk size limit immediately after pushing
        checkAndPrune();
    } catch (err) {
        logError({
            logger,
            err,
            code: 'DLQ_WRITE_ERROR',
            message: "❌ FATAL ERROR: Failed to write to DLQ file. Data loss occurred!",
            context: { repoName }
        });
    }
}

/**
 * Reads and returns the contents of the DLQ.
 * @returns {Array} Array of DLQ envelopes.
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
                    return JSON.parse(line);
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
 * Periodically attempts to replay messages from the DLQ.
 */
function startRetryJob() {
    if (retryTimer) clearInterval(retryTimer);
    
    // Check every 30 seconds for messages ready to be retried
    retryTimer = setInterval(async () => {
        // Enforce max disk size limits periodically in case push is inactive
        checkAndPrune();
        
        if (!retryHandler) return;
        
        const envelopes = getMessages();
        if (envelopes.length === 0) return;

        const now = Date.now();
        const readyToRetry = [];
        const stillWaiting = [];

        for (const env of envelopes) {
            if (now >= env.nextRetry) {
                readyToRetry.push(env);
            } else {
                stillWaiting.push(env);
            }
        }

        if (readyToRetry.length === 0) return;

        logger.info(`🔄 DLQ Retry Job: Attempting to replay ${readyToRetry.length} messages...`);

        const failedAgain = [];
        
        for (const env of readyToRetry) {
            try {
                await retryHandler(env.repoName, env.message);
                // Success! (Implicitly removed by not being in stillWaiting or failedAgain)
            } catch (err) {
                // Exponential Backoff
                env.retryCount++;
                const delay = Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(2, env.retryCount), MAX_RETRY_DELAY_MS);
                env.lastRetry = now;
                env.nextRetry = now + delay;
                failedAgain.push(env);
                
                logger.debug({ repoName: env.repoName, retryCount: env.retryCount, nextRetryIn: Math.round(delay/1000) }, `Retry failed for message.`);
            }
        }

        // Rewrite DLQ file with remaining messages
        const remaining = [...stillWaiting, ...failedAgain];
        if (remaining.length === 0) {
            clear();
        } else {
            try {
                const content = remaining.map(env => JSON.stringify(env)).join('\n') + '\n';
                fs.writeFileSync(DLQ_FILE_PATH, content, 'utf8');
                if (failedAgain.length > 0) {
                    logger.warn(`🔁 DLQ Retry Job: ${readyToRetry.length - failedAgain.length} replayed, ${failedAgain.length} failed again.`);
                } else {
                    logger.info(`✅ DLQ Retry Job: All ${readyToRetry.length} messages replayed successfully.`);
                }
            } catch (err) {
                logger.error({ err }, "Failed to update DLQ file after retry job.");
            }
        }
    }, 30000);
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

/**
 * Stops the retry job and clears the interval.
 */
function stop() {
    if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
    }
}

module.exports = {
    init,
    push,
    getMessages,
    clear,
    stop,
    registerRetryHandler
};
