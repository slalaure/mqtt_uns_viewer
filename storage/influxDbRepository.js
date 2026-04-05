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
 * InfluxDB v2 Repository Plugin
 * Uses pure HTTP (axios) to push to InfluxDB to minimize dependencies for Edge deployments.
 */

const axios = require('axios');
const BaseRepository = require('./baseRepository');

class InfluxDbRepository extends BaseRepository {
    constructor(logger, config, dlqManager) {
        super(config, { logger, dlqManager }, 'InfluxDbRepo');
        this.url = config.INFLUX_URL;
        this.token = config.INFLUX_TOKEN;
        this.org = config.INFLUX_ORG;
        this.bucket = config.INFLUX_BUCKET;
        this.measurement = config.INFLUX_MEASUREMENT || 'korelate_events';
        this.dlqManager = dlqManager;
        this.isConnected = false;

        this.batchSize = config.INFLUX_BATCH_SIZE || 1000;
        this.batchIntervalMs = config.INFLUX_BATCH_INTERVAL_MS || 2000;
        
        // Use ms precision to avoid converting timestamps to ns
        this.writeUrl = `${this.url}/api/v2/write?org=${encodeURIComponent(this.org)}&bucket=${encodeURIComponent(this.bucket)}&precision=ms`;
    }

    async init() {
        if (!this.url || !this.token || !this.org || !this.bucket) {
            this.logger.error("Missing required InfluxDB configuration. Check INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET.");
            return;
        }

        try {
            // Test connection using the health endpoint
            const healthUrl = `${this.url}/health`;
            await axios.get(healthUrl, { timeout: 5000 });
            this.isConnected = true;
            this.logger.info(`✅ Successfully connected to InfluxDB at ${this.url} (Org: ${this.org}, Bucket: ${this.bucket})`);
            
            this.startBatchProcessor();
        } catch (err) {
            this.logger.error({ err: err.message }, `❌ Failed to connect to InfluxDB at ${this.url}`);
            this.isConnected = false;
            // We still start the batch processor so items go to DLQ
            this.startBatchProcessor();
        }
    }

    escapeTag(str) {
        if (!str) return '';
        // InfluxDB tags cannot contain commas, equal signs, or spaces unescaped
        return String(str)
            .replace(/,/g, '\\,')
            .replace(/=/g, '\\=')
            .replace(/ /g, '\\ ')
            .replace(/\n/g, '\\n');
    }

    escapeStringField(str) {
        if (!str) return '""';
        // String fields must be enclosed in double quotes. Double quotes inside must be escaped.
        return '"' + String(str).replace(/"/g, '\\"') + '"';
    }

    /**
     * Converts a Korelate message into InfluxDB Line Protocol.
     * Format: measurement,tag_key=tag_value field_key=field_value timestamp_ms
     */
    convertToLineProtocol(message) {
        const { sourceId, topic, payloadStringForDb, timestamp, connectorType } = message;
        
        const safeSource = this.escapeTag(sourceId || 'unknown');
        const safeTopic = this.escapeTag(topic || 'unknown');
        const safeConnector = this.escapeTag(connectorType || 'unknown');
        
        const tsMs = timestamp ? new Date(timestamp).getTime() : Date.now();

        // Tags
        const tags = `source_id=${safeSource},topic=${safeTopic},connector_type=${safeConnector}`;
        
        // Field: payload (we store the raw JSON string)
        const payloadField = `payload=${this.escapeStringField(payloadStringForDb)}`;

        return `${this.measurement},${tags} ${payloadField} ${tsMs}`;
    }

    async processQueue() {
        if (this.writeQueue.length === 0) return;

        const batch = this.writeQueue.splice(0, this.batchSize);
        
        if (!this.isConnected) {
            this.logger.warn("InfluxDB disconnected. Sending batch to DLQ...");
            if (this.context.dlqManager) {
                this.context.dlqManager.push(batch, this.name);
            }
            return;
        }

        try {
            const lines = batch.map(msg => this.convertToLineProtocol(msg)).join('\n');
            
            await axios.post(this.writeUrl, lines, {
                headers: {
                    'Authorization': `Token ${this.token}`,
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Accept': 'application/json'
                },
                timeout: 5000
            });
            
            this.logger.debug(`Successfully wrote ${batch.length} points to InfluxDB.`);
        } catch (err) {
            this.logger.error({ err: err.message }, `Error writing batch to InfluxDB. Sending to DLQ.`);
            if (this.context.dlqManager) {
                this.context.dlqManager.push(batch, this.name);
            }
        }
    }

    async getSchema() {
        return "InfluxDB stores data in a schemaless format using Measurements, Tags, and Fields.";
    }

    async query(fluxQuery) {
        if (!this.isConnected) {
            throw new Error("InfluxDB is not connected.");
        }
        
        const queryUrl = `${this.url}/api/v2/query?org=${encodeURIComponent(this.org)}`;
        
        try {
            const response = await axios.post(queryUrl, { query: fluxQuery }, {
                headers: {
                    'Authorization': `Token ${this.token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/csv'
                }
            });
            return response.data;
        } catch (err) {
            this.logger.error({ err: err.message, query: fluxQuery }, "Error executing InfluxDB query.");
            throw err;
        }
    }

    close(callback) {
        this.stop().then(() => {
            this.isConnected = false;
            if (callback) callback();
        });
    }
}

// Ensure the singleton pattern is maintained similar to other repos
module.exports = {
    _instance: null,
    
    init(logger, config, dlqManager) {
        if (this._instance) {
            this._instance.close();
        }
        this._instance = new InfluxDbRepository(logger, config, dlqManager);
        this._instance.init();
    },

    push(message) {
        if (this._instance) this._instance.push(message);
    },

    stop() {
        if (this._instance) return this._instance.stop();
        return Promise.resolve();
    },

    close(callback) {
        if (this._instance) {
            this._instance.close(callback);
            this._instance = null;
        } else if (callback) {
            callback();
        }
    },
    
    get name() {
        return 'InfluxDbRepo';
    },

    get isConnected() {
        return this._instance ? this._instance.isConnected : false;
    },

    async getSchema() {
        if (this._instance) return await this._instance.getSchema();
        throw new Error("Repository not initialized");
    },

    async query(q) {
        if (this._instance) return await this._instance.query(q);
        throw new Error("Repository not initialized");
    }
};