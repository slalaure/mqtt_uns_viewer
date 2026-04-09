/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the Kafka Provider.
 */
const KafkaProvider = require('../connectors/kafka/index');

jest.mock('kafkajs', () => {
    const mockProducer = {
        connect: jest.fn(),
        send: jest.fn().mockResolvedValue(true),
        disconnect: jest.fn()
    };
    
    const mockConsumer = {
        connect: jest.fn(),
        subscribe: jest.fn(),
        run: jest.fn(async ({ eachMessage }) => {
            // Simulate message
            await eachMessage({
                topic: 'kafka_topic',
                partition: 0,
                message: { value: Buffer.from('{"kafka":"data"}'), offset: '10' }
            });
        }),
        disconnect: jest.fn()
    };

    return {
        Kafka: jest.fn(() => ({
            producer: jest.fn(() => mockProducer),
            consumer: jest.fn(() => mockConsumer)
        }))
    };
}, { virtual: true });

const createMockLogger = () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    child: jest.fn().mockImplementation(() => createMockLogger())
});

describe('KafkaProvider', () => {
    let mockContext;

    beforeEach(() => {
        jest.clearAllMocks();
        mockContext = {
            logger: createMockLogger(),
            handleMessage: jest.fn(),
            updateConnectorStatus: jest.fn()
        };
    });

    test('should connect, consume and publish successfully', async () => {
        const config = {
            id: 'kafka_test',
            type: 'kafka',
            publish: ['#'],
            options: {
                brokers: ['localhost:9092'],
                topics: ['kafka_topic']
            }
        };

        const provider = new KafkaProvider(config, mockContext);
        
        const res = await provider.connect();
        expect(res).toBe(true);
        
        // Verify incoming message parsing
        expect(mockContext.handleMessage).toHaveBeenCalledWith(
            'kafka_test',
            'kafka_topic',
            { kafka: 'data' },
            expect.objectContaining({
                connectorType: 'kafka',
                kafkaPartition: 0,
                kafkaOffset: '10'
            })
        );
        
        // Verify publish logic
        await new Promise((resolve, reject) => {
            provider.publish('out_topic', { send: 'this' }, {}, (err) => {
                if (err) reject(err);
                resolve();
            });
        });
        
        const kafkajs = require('kafkajs');
        const producer = new kafkajs.Kafka().producer();
        
        expect(producer.send).toHaveBeenCalledWith({
            topic: 'out_topic',
            messages: [{ value: '{"send":"this"}' }]
        });
        
        await provider.disconnect();
    });
});
