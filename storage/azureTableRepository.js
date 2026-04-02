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
 * Azure Table Storage Repository
 *
 * Manages all WRITE operations for the perennial Azure Table database.
 * This is designed for high-throughput, non-blocking, fire-and-forget ingestion.
 * Implements transaction batching respecting Azure's 100-entity per PartitionKey limit.
 * [UPDATED] Added getSchema() and query() using OData to expose data to the AI Agent.
 */

const { TableClient } = require('@azure/data-tables');
const crypto = require('crypto');
const BaseRepository = require('./baseRepository');

const MAX_QUEUE_SIZE = 20000;
const FLUSH_CHUNK_SIZE = 5000;

class AzureTableRepository extends BaseRepository {
    constructor() {
        super({}, {}, 'AzureTableRepo');
        this.client = null;
        this.isConnected = false;
        this.isConnecting = false;
        this.dlqManager = null;
        this.tableName = 'mqttevents';
    }

    /**
     * Initializes the Azure Table repository.
     */
    async init(appLogger, appConfig, appDlqManager) {
        this.logger = appLogger.child({ component: 'AzureTableRepo' });
        this.config = appConfig;
        this.dlqManager = appDlqManager;
        
        // Azure limits transactions to 100 entities with the same PartitionKey
        this.batchSize = this.config.AZURE_INSERT_BATCH_SIZE || 1000;
        this.batchIntervalMs = this.config.AZURE_BATCH_INTERVAL_MS || 5000;

        this.logger.info("Initializing Azure Table Storage repository...");
        await this.connect();
        this.startBatchProcessor();
    }

    /**
     * Attempts to connect to Azure Table Storage and ensure the table exists.
     */
    async connect() {
        if (this.isConnected || this.isConnecting) return;
        this.isConnecting = true;

        try {
            const connectionString = this.config.AZURE_STORAGE_CONNECTION_STRING;
            this.tableName = this.config.AZURE_TABLE_NAME || 'mqttevents';

            if (!connectionString) {
                throw new Error("AZURE_STORAGE_CONNECTION_STRING is not defined in the configuration.");
            }

            this.client = TableClient.fromConnectionString(connectionString, this.tableName);
            
            // Create table if it doesn't exist
            await this.client.createTable();

            this.logger.info(`✅ ☁️ Connected to Azure Table Storage successfully (Table: ${this.tableName})!`);
            this.isConnected = true;
            this.isConnecting = false;

        } catch (err) {
            this.logger.error({ err: err.message }, "❌ Failed to connect to Azure Table Storage. Will retry...");
            this.isConnecting = false;
            this.isConnected = false;
        }
    }

    /**
     * Returns table information and querying dialect for the AI Agent.
     */
    async getSchema() {
        if (!this.isConnected) await this.connect();
        
        return {
            engine: 'Azure Table Storage',
            tableName: this.tableName,
            dialect: 'OData Filter String',
            notes: "Azure Table is a NoSQL Key-Value store. DO NOT send SQL. You must provide an OData filter string as the query parameter. Example: `PartitionKey eq 'default_broker_2026-04-02' and topic eq 'factory/line1/temp'`",
            schema: [
                { name: 'partitionKey', type: 'String (BrokerId_YYYY-MM-DD)' },
                { name: 'rowKey', type: 'String (UUID)' },
                { name: 'timestamp_val', type: 'String (ISO 8601)' },
                { name: 'topic', type: 'String' },
                { name: 'payload', type: 'String (JSON)' },
                { name: 'broker_id', type: 'String' },
                { name: 'correlation_id', type: 'String' }
            ]
        };
    }

    /**
     * Executes an OData query against Azure Table Storage.
     * @param {string} odataFilter - The OData filter string (e.g., "topic eq 'my/topic'")
     */
    async query(odataFilter) {
        if (!this.isConnected) await this.connect();
        
        try {
            // If the AI accidentally sends a full SQL query, reject it cleanly
            if (odataFilter.trim().toUpperCase().startsWith('SELECT')) {
                throw new Error("Azure Table Storage requires OData filter strings, not SQL queries. (e.g., \"topic eq 'test'\")");
            }

            let iterator = this.client.listEntities({
                queryOptions: { filter: odataFilter }
            });

            const results = [];
            // Iterate over pages to fetch a limited result set to prevent massive payloads
            for await (const entity of iterator) {
                results.push(entity);
                if (results.length >= 100) break; // Limit to 100 items for the LLM context window
            }

            return results;
        } catch (err) {
            this.logger.error({ err: err.message, filter: odataFilter }, "Azure Table AI query execution failed");
            throw err;
        }
    }

    /**
     * Pushes a new message object into the write queue.
     * Prevents OOM by offloading excess messages to the DLQ.
     */
    push(message) {
        super.push(message);

        if (this.writeQueue.length > MAX_QUEUE_SIZE) {
            this.logger.warn(`⚠️ Azure Table write queue exceeded ${MAX_QUEUE_SIZE}. Flushing ${FLUSH_CHUNK_SIZE} oldest messages to DLQ to prevent OOM.`);
            const excessMessages = this.writeQueue.splice(0, FLUSH_CHUNK_SIZE);
            if (this.dlqManager) {
                this.dlqManager.push(excessMessages);
            }
        }
    }

    /**
     * Processes one chunk of the write queue and inserts it into Azure Table Storage.
     */
    async processQueue() {
        if (!this.isConnected) {
            if (!this.isConnecting) {
                this.logger.warn(`Azure Table Storage is disconnected. Attempting to reconnect... Queue size: ${this.writeQueue.length}`);
                await this.connect();
            }
            return; // Skip this cycle if not connected
        }

        const batch = this.writeQueue.splice(0, this.batchSize);
        if (batch.length === 0) {
            return;
        }

        // Group by PartitionKey (Azure Requirement for Transactions)
        // We use BrokerID + Date as the partition key for optimized time-series querying
        const groupedByPartition = new Map();

        for (const msg of batch) {
            const dateObj = new Date(msg.timestamp);
            const partitionKey = `${msg.brokerId}_${dateObj.toISOString().split('T')[0]}`;
            const rowKey = msg.correlationId || crypto.randomUUID();

            const entity = {
                partitionKey: partitionKey,
                rowKey: rowKey,
                timestamp_val: dateObj.toISOString(), // Azure reserves 'Timestamp', so we use timestamp_val
                topic: msg.topic,
                payload: msg.payloadStringForDb,
                broker_id: msg.brokerId,
                correlation_id: msg.correlationId || null
            };

            if (!groupedByPartition.has(partitionKey)) {
                groupedByPartition.set(partitionKey, []);
            }
            groupedByPartition.get(partitionKey).push(['upsert', entity]);
        }

        let successCount = 0;

        for (const [pKey, actions] of groupedByPartition.entries()) {
            // Split actions into chunks of 100 max per PartitionKey per Transaction
            for (let i = 0; i < actions.length; i += 100) {
                const chunk = actions.slice(i, i + 100);
                try {
                    await this.client.submitTransaction(chunk);
                    successCount += chunk.length;
                } catch (err) {
                    this.logger.error({ err: err.message }, `❌ Azure Table batch insert failed for Partition ${pKey}. Sending ${chunk.length} messages to DLQ.`);
                    if (this.dlqManager) {
                        // Extract original messages from the chunk to send to DLQ
                        const failedMsgs = chunk.map(action => {
                            const ent = action[1];
                            return {
                                brokerId: ent.broker_id,
                                timestamp: new Date(ent.timestamp_val),
                                topic: ent.topic,
                                payloadStringForDb: ent.payload,
                                correlationId: ent.correlation_id,
                                isSparkplugOrigin: false,
                                needsDb: true
                            };
                        });
                        this.dlqManager.push(failedMsgs);
                    }
                }
            }
        }

        if (successCount > 0) {
            this.logger.info(`✅ ☁️ Batch inserted ${successCount} messages into Azure Table Storage. (Queue: ${this.writeQueue.length})`);
        }
    }

    /**
     * Closes the Azure Table connection.
     */
    async close(callback) {
        this.isConnected = false;
        this.logger.info("✅ ☁️ Azure Table Storage connection closed.");
        if (callback) callback();
    }
}

module.exports = new AzureTableRepository();