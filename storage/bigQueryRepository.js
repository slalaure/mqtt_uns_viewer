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
 * Google Cloud BigQuery Repository
 *
 * Manages all WRITE operations for the perennial BigQuery database.
 * Uses the BigQuery Streaming API for high-throughput ingestion.
 * Implements transaction batching and DLQ fallback for PartialFailureErrors.
 * [UPDATED] Added getSchema() and query() to expose data to the AI Agent.
 */

const { BigQuery } = require('@google-cloud/bigquery');
const BaseRepository = require('./baseRepository');

const MAX_QUEUE_SIZE = 20000;
const FLUSH_CHUNK_SIZE = 5000;

class BigQueryRepository extends BaseRepository {
    constructor() {
        super({}, {}, 'BigQueryRepo');
        this.bigquery = null;
        this.datasetId = 'korelate';
        this.tableName = 'mqtt_events';
        this.isConnected = false;
        this.isConnecting = false;
        this.dlqManager = null;
    }

    /**
     * Initializes the BigQuery repository.
     */
    async init(appLogger, appConfig, appDlqManager) {
        this.logger = appLogger.child({ component: 'BigQueryRepo' });
        this.config = appConfig;
        this.dlqManager = appDlqManager;
        
        this.datasetId = this.config.BQ_DATASET_ID || 'korelate';
        this.tableName = this.config.BQ_TABLE_NAME || 'mqtt_events';
        this.batchSize = this.config.BQ_INSERT_BATCH_SIZE || 1000;
        this.batchIntervalMs = this.config.BQ_BATCH_INTERVAL_MS || 5000;

        this.logger.info("Initializing Google Cloud BigQuery repository...");
        await this.connect();
        this.startBatchProcessor();
    }

    /**
     * Attempts to initialize the BigQuery client and ensure Dataset/Table exist.
     */
    async connect() {
        if (this.isConnected || this.isConnecting) return;
        this.isConnecting = true;

        try {
            const clientOptions = {};
            
            if (this.config.BQ_PROJECT_ID) clientOptions.projectId = this.config.BQ_PROJECT_ID;
            if (this.config.BQ_KEY_FILENAME) clientOptions.keyFilename = this.config.BQ_KEY_FILENAME;

            this.bigquery = new BigQuery(clientOptions);
            
            await this.createTableIfNotExists();

            this.logger.info(`✅ ☁️ Connected to Google Cloud BigQuery successfully (Dataset: ${this.datasetId}, Table: ${this.tableName})!`);
            this.isConnected = true;
            this.isConnecting = false;

        } catch (err) {
            this.logger.error({ err: err.message }, "❌ Failed to connect to BigQuery. Check your Application Default Credentials or Service Account Key.");
            this.isConnecting = false;
            this.isConnected = false;
        }
    }

    /**
     * Ensures the Dataset and Table exist, creating them with the proper schema if necessary.
     */
    async createTableIfNotExists() {
        try {
            // 1. Ensure Dataset Exists
            const dataset = this.bigquery.dataset(this.datasetId);
            const [datasetExists] = await dataset.exists();
            
            if (!datasetExists) {
                this.logger.info(`Dataset '${this.datasetId}' does not exist. Creating...`);
                await this.bigquery.createDataset(this.datasetId, { location: this.config.BQ_LOCATION || 'US' });
            }

            // 2. Ensure Table Exists
            const table = dataset.table(this.tableName);
            const [tableExists] = await table.exists();

            if (!tableExists) {
                this.logger.info(`Table '${this.tableName}' does not exist. Creating with schema...`);
                
                const schema = [
                    { name: 'timestamp', type: 'TIMESTAMP', mode: 'REQUIRED' },
                    { name: 'topic', type: 'STRING', mode: 'REQUIRED' },
                    { name: 'payload', type: 'STRING', mode: 'NULLABLE' }, 
                    { name: 'broker_id', type: 'STRING', mode: 'NULLABLE' },
                    { name: 'correlation_id', type: 'STRING', mode: 'NULLABLE' }
                ];

                await dataset.createTable(this.tableName, { schema: schema });
                this.logger.info(`✅    -> Table '${this.tableName}' created in BigQuery.`);
            } else {
                this.logger.info(`✅    -> Table '${this.tableName}' verified in BigQuery.`);
            }
        } catch (err) {
            this.logger.error({ err: err.message }, "❌ Failed to verify or create BigQuery schema.");
            throw err;
        }
    }

    /**
     * Returns the table schema and dialect info for the AI Agent.
     */
    async getSchema() {
        if (!this.isConnected) await this.connect();
        
        const query = `
            SELECT column_name, data_type 
            FROM \`${this.datasetId}.INFORMATION_SCHEMA.COLUMNS\` 
            WHERE table_name = '${this.tableName}'
        `;

        try {
            const [rows] = await this.bigquery.query({ query });
            return {
                engine: 'BigQuery',
                datasetId: this.datasetId,
                tableName: this.tableName,
                dialect: 'Standard SQL',
                fullyQualifiedTableName: `\`${this.datasetId}.${this.tableName}\``,
                schema: rows
            };
        } catch (err) {
            this.logger.error({ err: err.message }, "Failed to get BigQuery schema for AI Agent");
            throw err;
        }
    }

    /**
     * Executes a native SQL query against BigQuery.
     */
    async query(sql) {
        if (!this.isConnected) await this.connect();
        try {
            const [rows] = await this.bigquery.query({ query: sql });
            return rows;
        } catch (err) {
            this.logger.error({ err: err.message, sql }, "BigQuery AI query execution failed");
            throw err;
        }
    }

    /**
     * Pushes a new message object into the write queue.
     */
    push(message) {
        super.push(message);

        if (this.writeQueue.length > MAX_QUEUE_SIZE) {
            this.logger.warn(`⚠️ BigQuery write queue exceeded ${MAX_QUEUE_SIZE}. Flushing ${FLUSH_CHUNK_SIZE} oldest messages to DLQ to prevent OOM.`);
            const excessMessages = this.writeQueue.splice(0, FLUSH_CHUNK_SIZE);
            if (this.dlqManager) {
                this.dlqManager.push(excessMessages, this.name);
            }
        }
    }

    /**
     * Processes one chunk of the write queue and streams it into BigQuery.
     */
    async processQueue() {
        if (!this.isConnected) {
            if (!this.isConnecting) {
                this.logger.warn(`BigQuery is disconnected. Attempting to reconnect... Queue size: ${this.writeQueue.length}`);
                await this.connect();
            }
            return;
        }

        const batch = this.writeQueue.splice(0, this.batchSize);
        if (batch.length === 0) return;

        const rows = batch.map(msg => ({
            timestamp: new Date(msg.timestamp).toISOString(),
            topic: msg.topic,
            payload: msg.payloadStringForDb,
            broker_id: msg.brokerId,
            correlation_id: msg.correlationId || null
        }));

        try {
            await this.bigquery
                .dataset(this.datasetId)
                .table(this.tableName)
                .insert(rows);

            this.logger.info(`✅ ☁️ Batch inserted ${batch.length} messages into BigQuery. (Queue: ${this.writeQueue.length})`);

        } catch (err) {
            if (err.name === 'PartialFailureError') {
                this.logger.error({ err: err.message }, `❌ BigQuery PartialFailureError. Sending ${batch.length} messages to DLQ.`);
            } else {
                this.logger.error({ err: err.message }, `❌ BigQuery batch insert failed. Sending ${batch.length} messages to DLQ.`);
            }

            if (this.dlqManager) {
                this.dlqManager.push(batch, this.name);
            }
        }
    }

    async close(callback) {
        this.isConnected = false;
        this.logger.info("✅ ☁️ Google Cloud BigQuery integration closed.");
        if (callback) callback();
    }
}

module.exports = new BigQueryRepository();