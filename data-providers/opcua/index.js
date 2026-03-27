/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * OPC UA Provider Plugin
 * Implements the BaseProvider interface for OPC UA connections.
 */
const { 
    OPCUAClient, 
    AttributeIds, 
    ClientSubscription, 
    TimestampsToReturn, 
    ClientMonitoredItem, 
    DataType 
} = require("node-opcua");
const BaseProvider = require('../base-provider');

class OpcUaProvider extends BaseProvider {
    constructor(config, context) {
        super(config, context);
        this.client = null;
        this.session = null;
        this.subscription = null;
        this.endpointUrl = config.endpointUrl || "opc.tcp://localhost:4840";
        // Map nodeId -> topic for two-way communication
        this.nodeTopicMap = new Map();
    }

    async connect() {
        return new Promise(async (resolve) => {
            this.updateStatus('connecting');
            this.logger.info(`Connecting to OPC UA server at ${this.endpointUrl}...`);

            try {
                this.client = OPCUAClient.create({
                    endpointMustExist: false,
                    connectionStrategy: {
                        maxRetry: 10,
                        initialDelay: 2000,
                        maxDelay: 10000
                    }
                });

                this.client.on("backoff", (retry, delay) => {
                    this.logger.warn(`OPC UA connection backoff: retrying in ${delay}ms...`);
                    this.updateStatus('connecting', `Retrying... (${retry})`);
                });

                await this.client.connect(this.endpointUrl);
                this.logger.info(`✅ Connected to OPC UA server.`);

                this.session = await this.client.createSession();
                this.logger.info(`✅ OPC UA Session created.`);

                this.connected = true;
                this.updateStatus('connected');

                // Setup Subscription
                this.subscription = ClientSubscription.create(this.session, {
                    requestedPublishingInterval: this.config.publishingInterval || 1000,
                    requestedLifetimeCount: 100,
                    requestedMaxKeepAliveCount: 10,
                    maxNotificationsPerPublish: 100,
                    publishingEnabled: true,
                    priority: 10
                });

                this.subscription.on("started", () => {
                    this.logger.info(`✅ OPC UA Subscription started.`);
                    this.monitorItems();
                }).on("terminated", () => {
                    this.logger.warn(`OPC UA Subscription terminated.`);
                });

                resolve(true);
            } catch (err) {
                this.logger.error({ err }, "❌ Failed to connect to OPC UA server.");
                this.updateStatus('error', err.message);
                resolve(false);
            }
        });
    }

    monitorItems() {
        const subscribeList = this.config.subscribe || [];
        
        subscribeList.forEach(item => {
            let nodeId = item;
            let topic = item;

            // Allow mapping: { "nodeId": "ns=1;s=Temperature", "topic": "factory/line1/temp" }
            if (typeof item === 'object') {
                nodeId = item.nodeId;
                topic = item.topic || nodeId;
            }

            if (!nodeId) return;

            this.nodeTopicMap.set(nodeId, topic);

            const itemToMonitor = {
                nodeId: nodeId,
                attributeId: AttributeIds.Value
            };

            const parameters = {
                samplingInterval: this.config.samplingInterval || 500,
                discardOldest: true,
                queueSize: 10
            };

            const monitoredItem = ClientMonitoredItem.create(
                this.subscription,
                itemToMonitor,
                parameters,
                TimestampsToReturn.Both
            );

            monitoredItem.on("changed", (dataValue) => {
                let val = dataValue.value.value;
                
                // Format the payload as JSON to match the UNS Viewer expectations
                const payloadObj = {
                    value: val,
                    quality: dataValue.statusCode.name,
                    timestamp: dataValue.sourceTimestamp || new Date()
                };
                
                // Forward the structured data to the central Korelate engine
                this.handleIncomingMessage(topic, payloadObj);
            });
            
            this.logger.info(`Monitoring OPC UA Node: ${nodeId} -> Topic: ${topic}`);
        });
    }

    async disconnect() {
        this.connected = false;
        try {
            if (this.subscription) {
                await this.subscription.terminate();
                this.subscription = null;
            }
            if (this.session) {
                await this.session.close();
                this.session = null;
            }
            if (this.client) {
                await this.client.disconnect();
                this.client = null;
            }
            this.updateStatus('disconnected');
            this.logger.info(`OPC UA connection closed.`);
        } catch (err) {
            this.logger.error({ err }, "Error disconnecting OPC UA client.");
        }
    }

    publish(topic, payload, options, callback) {
        // Find the original NodeId matching the requested UNS topic
        let targetNodeId = topic;
        for (let [nodeId, mappedTopic] of this.nodeTopicMap.entries()) {
            if (mappedTopic === topic) {
                targetNodeId = nodeId;
                break;
            }
        }

        if (!this.session) {
            const err = new Error("OPC UA session not active");
            this.logger.warn(err.message);
            if (callback) callback(err);
            return;
        }

        let parsedValue = payload;
        try {
            // Extract core value if the user sent a JSON object
            const obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
            if (obj && obj.value !== undefined) {
                parsedValue = obj.value;
            }
        } catch(e) {}

        // Basic DataType inference
        let dataType = DataType.String;
        if (typeof parsedValue === 'number') {
            dataType = Number.isInteger(parsedValue) ? DataType.Int32 : DataType.Double;
        } else if (typeof parsedValue === 'boolean') {
            dataType = DataType.Boolean;
        }

        const nodeToWrite = {
            nodeId: targetNodeId,
            attributeId: AttributeIds.Value,
            value: {
                value: {
                    dataType: dataType,
                    value: parsedValue
                }
            }
        };

        this.session.write(nodeToWrite, (err, statusCode) => {
            if (err) {
                this.logger.error({ err, topic }, "Failed to write to OPC UA node.");
                if (callback) callback(err);
            } else if (statusCode.value !== 0) {
                const error = new Error(`OPC UA Write failed with status: ${statusCode.name}`);
                this.logger.error({ topic, status: statusCode.name }, "Failed to write to OPC UA node.");
                if (callback) callback(error);
            } else {
                if (callback) callback(null);
            }
        });
    }
}

module.exports = OpcUaProvider;