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
 * AVEVA PI System Repository
 *
 * Manages all WRITE operations for the perennial AVEVA PI database.
 * Uses the PI Web API to batch insert time-series data using StreamSets.
 * Implements transaction batching and DLQ fallback.
 * [UPDATED] Added getSchema() and query() to expose the PI Web API REST interface to the AI Agent.
 */

const axios = require('axios');
const https = require('https');
const BaseRepository = require('./baseRepository');

const MAX_QUEUE_SIZE = 20000;
const FLUSH_CHUNK_SIZE = 5000;

class PiSystemRepository extends BaseRepository {
    constructor() {
        super({}, {}, 'PiSystemRepo');
        this.isConnected = false;
        this.isConnecting = false;
        this.dlqManager = null;
        this.axiosInstance = null;
    }

    /**
     * Initializes the AVEVA PI System repository.
     */
    async init(appLogger, appConfig, appDlqManager) {
        this.logger = appLogger.child({ component: 'PiSystemRepo' });
        this.config = appConfig;
        this.dlqManager = appDlqManager;
        
        this.batchSize = this.config.PI_INSERT_BATCH_SIZE || 1000;
        this.batchIntervalMs = this.config.PI_BATCH_INTERVAL_MS || 5000;

        this.logger.info("Initializing AVEVA PI System repository...");
        await this.connect();
        this.startBatchProcessor();
    }

    /**
     * Attempts to connect to the PI Web API and configures the HTTP client.
     */
    async connect() {
        if (this.isConnected || this.isConnecting) return;
        this.isConnecting = true;

        try {
            const baseUrl = this.config.PI_WEB_API_URL; 
            if (!baseUrl) {
                throw new Error("PI_WEB_API_URL is not defined in the configuration.");
            }

            const rejectUnauthorized = this.config.PI_REJECT_UNAUTHORIZED !== 'false';
            
            const axiosConfig = {
                baseURL: baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl,
                timeout: 10000,
                headers: {
                    'X-Requested-With': 'message/http',
                    'Content-Type': 'application/json'
                },
                httpsAgent: new https.Agent({
                    rejectUnauthorized: rejectUnauthorized
                })
            };

            // Basic Authentication for PI Web API
            if (this.config.PI_USERNAME && this.config.PI_PASSWORD) {
                axiosConfig.auth = {
                    username: this.config.PI_USERNAME,
                    password: this.config.PI_PASSWORD
                };
            }

            this.axiosInstance = axios.create(axiosConfig);

            // Test the connection by hitting the System endpoint
            await this.axiosInstance.get('/system/info');

            this.logger.info(`✅ 🏭 Connected to AVEVA PI Web API successfully!`);
            this.isConnected = true;
            this.isConnecting = false;

        } catch (err) {
            this.logger.error({ err: err.message }, "❌ Failed to connect to AVEVA PI Web API. Check URL, credentials, or certificate settings.");
            this.isConnecting = false;
            this.isConnected = false;
        }
    }

    /**
     * Returns schema information and querying instructions for the AI Agent.
     */
    async getSchema() {
        if (!this.isConnected) await this.connect();
        
        return {
            engine: 'AVEVA PI System (PI Web API)',
            dialect: 'REST API GET',
            notes: "AVEVA PI is a time-series historian. DO NOT send SQL. You must provide a relative PI Web API GET endpoint as the query parameter. To search for tags, use: `/search/query?q=name:*keyword*`. To get data, use the WebId returned from the search in: `/streams/{webId}/recorded`.",
            piDataArchive: this.config.PI_DATA_ARCHIVE || 'PISERVER'
        };
    }

    /**
     * Executes a PI Web API GET request.
     * @param {string} endpoint - The relative REST endpoint (e.g., "/search/query?q=name:*")
     */
    async query(endpoint) {
        if (!this.isConnected) await this.connect();
        
        try {
            // Guard rail against hallucinations where the LLM tries to send SQL
            if (endpoint.trim().toUpperCase().startsWith('SELECT')) {
                throw new Error("AVEVA PI requires REST API endpoints, not SQL. Use endpoints like '/search/query?q=name:*' instead.");
            }

            const safeEndpoint = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
            this.logger.debug(`[PI AI Agent] Executing GET ${safeEndpoint}`);

            const response = await this.axiosInstance.get(safeEndpoint);
            
            // PI Web API responses can be huge. We truncate the Items array if it exceeds 100 
            // to protect the LLM context window.
            const data = response.data;
            if (data && Array.isArray(data.Items) && data.Items.length > 100) {
                data.Items = data.Items.slice(0, 100);
                data._warning = "Results truncated to 100 items to protect context limit.";
            }

            return data;
        } catch (err) {
            const errorMessage = err.response ? JSON.stringify(err.response.data) : err.message;
            this.logger.error({ err: errorMessage, endpoint }, "AVEVA PI Web API AI query failed");
            throw new Error(`PI Web API Error: ${errorMessage}`);
        }
    }

    /**
     * Helper to safely extract a numeric value if possible, otherwise returns a string.
     */
    parseValueForPi(payloadString) {
        try {
            const obj = JSON.parse(payloadString);
            if (obj && typeof obj === 'object') {
                if (obj.value !== undefined) return obj.value;
                if (obj.val !== undefined) return obj.val;
            }
            return payloadString;
        } catch (e) {
            const num = parseFloat(payloadString);
            return isNaN(num) ? payloadString : num;
        }
    }

    /**
     * Pushes a new message object into the write queue.
     */
    push(message) {
        super.push(message);

        if (this.writeQueue.length > MAX_QUEUE_SIZE) {
            this.logger.warn(`⚠️ PI System write queue exceeded ${MAX_QUEUE_SIZE}. Flushing ${FLUSH_CHUNK_SIZE} oldest messages to DLQ to prevent OOM.`);
            const excessMessages = this.writeQueue.splice(0, FLUSH_CHUNK_SIZE);
            if (this.dlqManager) {
                this.dlqManager.push(excessMessages, this.name);
            }
        }
    }

    /**
     * Processes one chunk of the write queue and inserts it into PI.
     */
    async processQueue() {
        if (!this.isConnected) {
            if (!this.isConnecting) {
                this.logger.warn(`PI System is disconnected. Attempting to reconnect... Queue size: ${this.writeQueue.length}`);
                await this.connect();
            }
            return;
        }

        const batch = this.writeQueue.splice(0, this.batchSize);
        if (batch.length === 0) return;

        const piDataArchiveName = this.config.PI_DATA_ARCHIVE || 'PISERVER';
        const itemsMap = new Map();

        for (const msg of batch) {
            const safeTopic = msg.topic.replace(/\//g, '.');
            const piPointPath = `pi:\\\\${piDataArchiveName}\\${safeTopic}`;

            if (!itemsMap.has(piPointPath)) {
                itemsMap.set(piPointPath, {
                    WebId: `?path=${piPointPath}`, 
                    Items: []
                });
            }

            itemsMap.get(piPointPath).Items.push({
                Timestamp: new Date(msg.timestamp).toISOString(),
                Value: this.parseValueForPi(msg.payloadStringForDb),
                Good: true
            });
        }

        const payload = Array.from(itemsMap.values());

        try {
            const response = await this.axiosInstance.post('/streamsets/recorded', payload);
            
            if (response.status >= 200 && response.status < 300) {
                this.logger.info(`✅ 🏭 Batch inserted ${batch.length} events into AVEVA PI System. (Queue: ${this.writeQueue.length})`);
            } else {
                throw new Error(`Unexpected HTTP status: ${response.status}`);
            }

        } catch (err) {
            this.logger.error({ err: err.message }, `❌ PI System batch insert failed. Sending ${batch.length} messages to DLQ.`);
            if (this.dlqManager) {
                this.dlqManager.push(batch, this.name);
            }
            this.isConnected = false;
        }
    }

    async close(callback) {
        this.isConnected = false;
        this.logger.info("✅ 🏭 AVEVA PI System connection closed.");
        if (callback) callback();
    }
}

module.exports = new PiSystemRepository();