/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025-2026 Sebastien Lalaurette
 * * Base Repository Interface
 * All storage repositories (DuckDB, TimescaleDB, InfluxDB, etc.) should extend this class
 * to ensure a standardized interaction with the Data Manager and reduce boilerplate queue logic.
 */

class BaseRepository {
    /**
     * @param {Object} config - The configuration for this repository instance.
     * @param {Object} context - The global application context (logger, dlqManager, etc.).
     * @param {string} repoName - The identifier for logging purposes.
     */
    constructor(config, context, repoName = 'BaseRepo') {
        this.config = config;
        this.context = context;
        this.logger = context.logger ? context.logger.child({ component: repoName }) : console;
        this.name = repoName;
        
        this.writeQueue = [];
        this.batchTimer = null;
        
        // Defaults - should be overridden by child class based on environment config
        this.batchSize = 1000; 
        this.batchIntervalMs = 2000; 
    }

    /**
     * Initializes the repository (e.g., connecting to the DB, verifying tables).
     * Must be implemented by child classes.
     */
    async init() {
        throw new Error("init() must be implemented by the repository plugin.");
    }

    /**
     * Pushes a message into the internal write queue.
     * Child classes can override this to implement smart compaction (like DuckDB currently does).
     * @param {Object} message - The standardized message object from the dispatcher.
     */
    push(message) {
        this.writeQueue.push(message);
    }

    /**
     * Starts the batch processing timer.
     * This eliminates the need for every plugin to write its own setInterval logic.
     */
    startBatchProcessor() {
        this.logger.info(`Starting batch processor for ${this.name} (Size: ${this.batchSize}, Interval: ${this.batchIntervalMs}ms)`);
        if (this.batchTimer) clearInterval(this.batchTimer);
        this.batchTimer = setInterval(() => this.processQueue(), this.batchIntervalMs);
    }

    /**
     * Processes a chunk of the queue.
     * Must be implemented by child classes to handle the actual database insertion syntax.
     */
    async processQueue() {
        throw new Error("processQueue() must be implemented by the repository plugin.");
    }

    /**
     * Stops the batch timer and attempts to flush the remaining queue.
     */
    async stop() {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
            this.batchTimer = null;
            this.logger.info(`Stopped batch timer for ${this.name}. Flushing remaining queue (${this.writeQueue.length} items)...`);
            if (this.writeQueue.length > 0) {
                await this.processQueue();
            }
        }
    }

    /**
     * Closes the database connection gracefully.
     * @param {Function} callback - Optional callback for framework compatibility.
     */
    async close(callback) {
        throw new Error("close() must be implemented by the repository plugin.");
    }
}

module.exports = BaseRepository;