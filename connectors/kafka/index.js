/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Apache Kafka Provider Plugin
 * Implements the BaseProvider interface for Apache Kafka.
 */
const BaseProvider = require('../baseProvider');
const mqttMatch = require('mqtt-match');

class KafkaProvider extends BaseProvider {
    /**
     * @param {import('../baseProvider').ProviderConfig} config 
     * @param {import('../baseProvider').ProviderContext} context 
     */
    constructor(config, context) {
        super(config, context);
        this.options = config.options || {};
        this.brokers = this.options.brokers || ['localhost:9092'];
        this.clientId = this.options.clientId || `korelate-${this.id}`;
        this.groupId = this.options.groupId || `korelate-group-${this.id}`;
        
        // Allowed topic patterns for publishing and subscribing (using MQTT wildcard logic for simplicity if wanted)
        this.allowedPublish = this.config.publish || ['#'];
        this.allowedSubscribe = this.config.subscribe || ['#'];
        
        this.kafka = null;
        this.producer = null;
        this.consumer = null;
    }

    async connect() {
        this.logger.info(`Connecting to Kafka brokers ${this.brokers.join(', ')} for ${this.id}`);
        try {
            const { Kafka } = require('kafkajs');
            this.kafka = new Kafka({
                clientId: this.clientId,
                brokers: this.brokers,
                ssl: this.options.ssl,
                sasl: this.options.sasl // e.g. { mechanism: 'plain', username: '', password: '' }
            });

            this.producer = this.kafka.producer();
            await this.producer.connect();

            this.consumer = this.kafka.consumer({ groupId: this.groupId });
            await this.consumer.connect();

            // Subscribe to configured topics
            if (this.options.topics && Array.isArray(this.options.topics)) {
                for (const topic of this.options.topics) {
                    await this.consumer.subscribe({ topic, fromBeginning: this.options.fromBeginning || false });
                }
            }

            // Start consuming
            await this.consumer.run({
                eachMessage: async ({ topic, partition, message }) => {
                    const payload = message.value ? message.value.toString() : '';
                    let parsedPayload = payload;
                    try {
                        parsedPayload = JSON.parse(payload);
                    } catch (e) { /* ignore, keep as string */ }
                    
                    this.handleIncomingMessage(topic, parsedPayload, {
                        kafkaPartition: partition,
                        kafkaOffset: message.offset
                    });
                },
            });

            this.connected = true;
            this.updateStatus('connected');
            return true;
        } catch (err) {
            if (err.code === 'MODULE_NOT_FOUND') {
                this.logger.error("Missing dependency 'kafkajs'. Please install it using: npm install kafkajs");
                this.updateStatus('error', 'Missing kafkajs library');
            } else {
                this.logger.error({ err }, `Failed to connect to Kafka`);
                this.updateStatus('error', err.message);
            }
            return false;
        }
    }

    async disconnect() {
        this.connected = false;
        try {
            if (this.producer) await this.producer.disconnect();
            if (this.consumer) await this.consumer.disconnect();
        } catch (err) {
            this.logger.error({ err }, 'Error disconnecting from Kafka');
        }
        this.updateStatus('disconnected');
    }

    publish(topic, payload, options, callback) {
        if (!this.connected || !this.producer) {
            const err = new Error('Kafka provider is not connected');
            if (callback) callback(err);
            return;
        }

        const isAllowed = this.allowedPublish.some(pattern => mqttMatch(pattern, topic));
        if (!isAllowed) {
            const err = new Error(`Publish forbidden for topic: ${topic}`);
            this.logger.warn(err.message);
            if (callback) callback(err);
            return;
        }

        const stringPayload = Buffer.isBuffer(payload) ? payload.toString() : (typeof payload === 'object' ? JSON.stringify(payload) : String(payload));

        this.producer.send({
            topic,
            messages: [
                { value: stringPayload }
            ],
        }).then(() => {
            if (callback) callback();
        }).catch(err => {
            this.logger.error({ err }, `Error publishing to Kafka topic ${topic}`);
            if (callback) callback(err);
        });
    }
}

module.exports = KafkaProvider;
