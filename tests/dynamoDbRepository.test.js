/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the AWS DynamoDB Repository.
 * Verifies table creation, 25-item chunking, and UnprocessedItems handling.
 */

const dynamoDbRepo = require('../storage/dynamoDbRepository');
const { DynamoDBClient, BatchWriteItemCommand, CreateTableCommand } = require('@aws-sdk/client-dynamodb');

// Mock AWS SDK v3
jest.mock('@aws-sdk/client-dynamodb', () => {
    return {
        DynamoDBClient: jest.fn().mockImplementation(() => ({
            send: jest.fn().mockResolvedValue({})
        })),
        BatchWriteItemCommand: jest.fn(),
        CreateTableCommand: jest.fn()
    };
});

const createMockLogger = () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockImplementation(() => createMockLogger())
});

describe('DynamoDbRepository', () => {
    let mockLogger, mockConfig, mockDlqManager;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();

        mockLogger = createMockLogger();
        mockConfig = {
            AWS_REGION: 'eu-west-1',
            DYNAMODB_TABLE_NAME: 'korelate_test_events',
            DYNAMODB_INSERT_BATCH_SIZE: 1000
        };
        mockDlqManager = { push: jest.fn() };

        dynamoDbRepo.writeQueue = [];
        dynamoDbRepo.isConnected = false;
        dynamoDbRepo.isConnecting = false;
        if (dynamoDbRepo.batchTimer) {
            clearInterval(dynamoDbRepo.batchTimer);
            dynamoDbRepo.batchTimer = null;
        }
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should initialize and attempt to create table', async () => {
        await dynamoDbRepo.init(mockLogger, mockConfig, mockDlqManager);
        
        expect(DynamoDBClient).toHaveBeenCalledWith({ region: 'eu-west-1' });
        expect(dynamoDbRepo.client.send).toHaveBeenCalledTimes(1); // CreateTableCommand
        expect(dynamoDbRepo.isConnected).toBe(true);
    });

    test('should chunk inserts into batches of 25', async () => {
        await dynamoDbRepo.init(mockLogger, mockConfig, mockDlqManager);
        dynamoDbRepo.client.send.mockClear(); // Clear initialization calls

        // Create 60 messages
        for (let i = 0; i < 60; i++) {
            dynamoDbRepo.push({
                brokerId: 'aws_iot',
                topic: 'sensor/data',
                payloadStringForDb: JSON.stringify({ id: i }),
                timestamp: new Date(),
            });
        }

        await dynamoDbRepo.processQueue();

        // 60 items should be split into 3 BatchWriteItemCommands (25, 25, 10)
        expect(dynamoDbRepo.client.send).toHaveBeenCalledTimes(3);
        
        const call1 = BatchWriteItemCommand.mock.calls[0][0];
        const call2 = BatchWriteItemCommand.mock.calls[1][0];
        const call3 = BatchWriteItemCommand.mock.calls[2][0];

        expect(call1.RequestItems[mockConfig.DYNAMODB_TABLE_NAME].length).toBe(25);
        expect(call2.RequestItems[mockConfig.DYNAMODB_TABLE_NAME].length).toBe(25);
        expect(call3.RequestItems[mockConfig.DYNAMODB_TABLE_NAME].length).toBe(10);
    });

    test('should route UnprocessedItems to DLQ', async () => {
        await dynamoDbRepo.init(mockLogger, mockConfig, mockDlqManager);
        dynamoDbRepo.client.send.mockClear();

        // Mock DynamoDB returning some items as unprocessed (throttled)
        dynamoDbRepo.client.send.mockResolvedValueOnce({
            UnprocessedItems: {
                'mqtt_test_events': [
                    { PutRequest: { Item: { partition_key: { S: "fail1" } } } },
                    { PutRequest: { Item: { partition_key: { S: "fail2" } } } }
                ]
            }
        });

        // Push 10 items
        for (let i = 0; i < 10; i++) {
            dynamoDbRepo.push({
                brokerId: 'aws_iot',
                topic: 'sensor/data',
                payloadStringForDb: '{}',
                timestamp: new Date()
            });
        }

        await dynamoDbRepo.processQueue();

        // DLQ should receive the failed chunk
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('throttled 2 items'));
        expect(mockDlqManager.push).toHaveBeenCalledTimes(1);
        expect(mockDlqManager.push.mock.calls[0][0].length).toBe(10); // The whole chunk is sent to DLQ for safety
    });
});
