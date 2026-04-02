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
 * AWS DynamoDB Repository
 *
 * Manages all WRITE operations for the perennial AWS DynamoDB database.
 * This is designed for high-throughput, non-blocking, fire-and-forget ingestion.
 * Implements transaction batching respecting DynamoDB's 25-item per BatchWriteItem limit.
 * [UPDATED] Added getSchema() and query() using PartiQL to expose data to the AI Agent.
 */

const { DynamoDBClient, BatchWriteItemCommand, CreateTableCommand, DescribeTableCommand, ExecuteStatementCommand } = require('@aws-sdk/client-dynamodb');
const { unmarshall } = require('@aws-sdk/util-dynamodb');
const crypto = require('crypto');
const BaseRepository = require('./baseRepository');

const MAX_QUEUE_SIZE = 20000;
const FLUSH_CHUNK_SIZE = 5000;
const DYNAMODB_BATCH_LIMIT = 25; // AWS hard limit for BatchWriteItem

class DynamoDbRepository extends BaseRepository {
    constructor() {
        super({}, {}, 'DynamoDbRepo');
        this.client = null;
        this.isConnected = false;
        this.isConnecting = false;
        this.dlqManager = null;
        this.tableName = 'mqtt_events';
    }

    /**
     * Initializes the DynamoDB repository.
     */
    async init(appLogger, appConfig, appDlqManager) {
        this.logger = appLogger.child({ component: 'DynamoDbRepo' });
        this.config = appConfig;
        this.dlqManager = appDlqManager;
        
        this.tableName = this.config.DYNAMODB_TABLE_NAME || 'mqtt_events';
        this.batchSize = this.config.DYNAMODB_INSERT_BATCH_SIZE || 1000;
        this.batchIntervalMs = this.config.DYNAMODB_BATCH_INTERVAL_MS || 5000;

        this.logger.info("Initializing AWS DynamoDB repository...");
        await this.connect();
        this.startBatchProcessor();
    }

    /**
     * Attempts to connect to AWS DynamoDB and ensure the table exists.
     */
    async connect() {
        if (this.isConnected || this.isConnecting) return;
        this.isConnecting = true;

        try {
            const clientConfig = {
                region: this.config.AWS_REGION || 'us-east-1'
            };

            if (this.config.AWS_ACCESS_KEY_ID && this.config.AWS_SECRET_ACCESS_KEY) {
                clientConfig.credentials = {
                    accessKeyId: this.config.AWS_ACCESS_KEY_ID,
                    secretAccessKey: this.config.AWS_SECRET_ACCESS_KEY
                };
            }

            this.client = new DynamoDBClient(clientConfig);
            
            await this.createTableIfNotExists();

            this.logger.info(`✅ ☁️ Connected to AWS DynamoDB successfully (Table: ${this.tableName})!`);
            this.isConnected = true;
            this.isConnecting = false;

        } catch (err) {
            this.logger.error({ err: err.message }, "❌ Failed to connect to AWS DynamoDB. Check credentials or region.");
            this.isConnecting = false;
            this.isConnected = false;
        }
    }

    async createTableIfNotExists() {
        const params = {
            TableName: this.tableName,
            KeySchema: [
                { AttributeName: "partition_key", KeyType: "HASH" },
                { AttributeName: "sort_key", KeyType: "RANGE" }     
            ],
            AttributeDefinitions: [
                { AttributeName: "partition_key", AttributeType: "S" },
                { AttributeName: "sort_key", AttributeType: "S" }
            ],
            BillingMode: "PAY_PER_REQUEST"
        };

        try {
            await this.client.send(new CreateTableCommand(params));
            this.logger.info(`✅    -> Table '${this.tableName}' creation initiated in DynamoDB.`);
        } catch (err) {
            if (err.name === 'ResourceInUseException') {
                this.logger.info(`✅    -> Table '${this.tableName}' verified (already exists).`);
            } else {
                this.logger.error({ err: err.message }, `❌ Failed to create table '${this.tableName}'.`);
                throw err;
            }
        }
    }

    /**
     * Returns table information and querying dialect for the AI Agent.
     */
    async getSchema() {
        if (!this.isConnected) await this.connect();
        
        try {
            const command = new DescribeTableCommand({ TableName: this.tableName });
            const response = await this.client.send(command);
            
            return {
                engine: 'AWS DynamoDB',
                tableName: this.tableName,
                dialect: 'PartiQL',
                notes: `DynamoDB is a NoSQL store. Use PartiQL syntax (e.g., SELECT * FROM "${this.tableName}" WHERE "partition_key" = '...'). The schema is flexible, but expected attributes are: partition_key (S), sort_key (S), topic (S), payload (S), broker_id (S), timestamp_val (S).`,
                keySchema: response.Table.KeySchema,
                attributeDefinitions: response.Table.AttributeDefinitions
            };
        } catch (err) {
            this.logger.error({ err: err.message }, "Failed to get DynamoDB schema for AI Agent");
            throw err;
        }
    }

    /**
     * Executes a PartiQL query against DynamoDB and unmarshalls the result.
     */
    async query(statement) {
        if (!this.isConnected) await this.connect();
        
        try {
            const command = new ExecuteStatementCommand({ Statement: statement });
            const response = await this.client.send(command);
            
            // Convert DynamoDB JSON ({"S": "value"}) back into standard JSON objects
            if (response.Items && response.Items.length > 0) {
                return response.Items.map(item => unmarshall(item));
            }
            return [];
            
        } catch (err) {
            this.logger.error({ err: err.message, statement }, "DynamoDB PartiQL AI execution failed");
            throw err;
        }
    }

    push(message) {
        super.push(message);

        if (this.writeQueue.length > MAX_QUEUE_SIZE) {
            this.logger.warn(`⚠️ DynamoDB write queue exceeded ${MAX_QUEUE_SIZE}. Flushing ${FLUSH_CHUNK_SIZE} oldest messages to DLQ to prevent OOM.`);
            const excessMessages = this.writeQueue.splice(0, FLUSH_CHUNK_SIZE);
            if (this.dlqManager) {
                this.dlqManager.push(excessMessages);
            }
        }
    }

    async processQueue() {
        if (!this.isConnected) {
            if (!this.isConnecting) {
                this.logger.warn(`DynamoDB is disconnected. Attempting to reconnect... Queue size: ${this.writeQueue.length}`);
                await this.connect();
            }
            return;
        }

        const batch = this.writeQueue.splice(0, this.batchSize);
        if (batch.length === 0) return;

        let successCount = 0;

        for (let i = 0; i < batch.length; i += DYNAMODB_BATCH_LIMIT) {
            const chunk = batch.slice(i, i + DYNAMODB_BATCH_LIMIT);
            
            const putRequests = chunk.map(msg => {
                const dateObj = new Date(msg.timestamp);
                const isoDate = dateObj.toISOString().split('T')[0];
                const isoTimestamp = dateObj.toISOString();
                const uniqueId = msg.correlationId || crypto.randomUUID();

                const item = {
                    partition_key: { S: `${msg.brokerId}#${isoDate}` },
                    sort_key: { S: `${isoTimestamp}#${uniqueId}` },
                    topic: { S: msg.topic },
                    payload: { S: msg.payloadStringForDb },
                    broker_id: { S: msg.brokerId },
                    timestamp_val: { S: isoTimestamp }
                };

                if (msg.correlationId) {
                    item.correlation_id = { S: msg.correlationId };
                }

                return { PutRequest: { Item: item } };
            });

            const params = { RequestItems: { [this.tableName]: putRequests } };

            try {
                const command = new BatchWriteItemCommand(params);
                const response = await this.client.send(command);
                
                if (response.UnprocessedItems && Object.keys(response.UnprocessedItems).length > 0) {
                    const unprocessedArray = response.UnprocessedItems[this.tableName] || [];
                    this.logger.warn(`⚠️ DynamoDB throttled ${unprocessedArray.length} items. Sending chunk to DLQ.`);
                    if (this.dlqManager) this.dlqManager.push(chunk);
                    successCount += (chunk.length - unprocessedArray.length);
                } else {
                    successCount += chunk.length;
                }

            } catch (err) {
                this.logger.error({ err: err.message }, `❌ DynamoDB batch insert failed. Sending ${chunk.length} messages to DLQ.`);
                if (this.dlqManager) this.dlqManager.push(chunk);
            }
        }

        if (successCount > 0) {
            this.logger.info(`✅ ☁️ Batch inserted ${successCount} messages into AWS DynamoDB. (Queue: ${this.writeQueue.length})`);
        }
    }

    async close(callback) {
        if (this.client) {
            this.client.destroy();
        }
        this.isConnected = false;
        this.logger.info("✅ ☁️ AWS DynamoDB connection closed.");
        if (callback) callback();
    }
}

module.exports = new DynamoDbRepository();