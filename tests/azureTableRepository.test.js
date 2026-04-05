/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the Azure Table Storage Repository.
 * Verifies connection handling, batch limits (100 per partition), and DLQ fallback.
 */

// Mock the Azure SDK
jest.mock('@azure/data-tables', () => {
    const mockClientInstance = {
        createTable: jest.fn().mockResolvedValue(true),
        submitTransaction: jest.fn().mockResolvedValue(true)
    };
    return {
        TableClient: {
            fromConnectionString: jest.fn(() => mockClientInstance)
        }
    };
});

const azureTableRepo = require('../storage/azureTableRepository');
const { TableClient } = require('@azure/data-tables');

const createMockLogger = () => {
    const logger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    };
    logger.child = jest.fn().mockReturnValue(logger);
    return logger;
};

describe('AzureTableRepository', () => {
    let mockLogger, mockConfig, mockDlqManager;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();

        mockLogger = createMockLogger();
        mockConfig = {
            AZURE_STORAGE_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=test;EndpointSuffix=core.windows.net',
            AZURE_TABLE_NAME: 'korelate_test_events',
            AZURE_INSERT_BATCH_SIZE: 1000,
            AZURE_BATCH_INTERVAL_MS: 5000
        };
        mockDlqManager = { push: jest.fn() };

        // Reset internal state
        azureTableRepo.writeQueue = [];
        azureTableRepo.isConnected = false;
        azureTableRepo.isConnecting = false;
        if (azureTableRepo.batchTimer) {
            clearInterval(azureTableRepo.batchTimer);
            azureTableRepo.batchTimer = null;
        }
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should initialize and create table on connect', async () => {
        await azureTableRepo.init(mockLogger, mockConfig, mockDlqManager);
        
        expect(TableClient.fromConnectionString).toHaveBeenCalledWith(
            mockConfig.AZURE_STORAGE_CONNECTION_STRING, 
            mockConfig.AZURE_TABLE_NAME
        );
        expect(azureTableRepo.client.createTable).toHaveBeenCalledTimes(1);
        expect(azureTableRepo.isConnected).toBe(true);
    });

    test('should push messages to queue and offload to DLQ if max size exceeded', () => {
        azureTableRepo.dlqManager = mockDlqManager;
        azureTableRepo.logger = mockLogger;

        // Push messages to exceed MAX_QUEUE_SIZE (20000)
        for (let i = 0; i < 20005; i++) {
            azureTableRepo.push({ topic: 'test', payloadStringForDb: '{}', timestamp: new Date() });
        }

        // 5000 oldest messages should be flushed to DLQ
        expect(mockDlqManager.push).toHaveBeenCalledTimes(1);
        expect(mockDlqManager.push.mock.calls[0][0].length).toBe(5000);
        expect(azureTableRepo.writeQueue.length).toBe(15005);
    });

    test('should group transactions by PartitionKey and respect 100-item limits', async () => {
        await azureTableRepo.init(mockLogger, mockConfig, mockDlqManager);
        
        const testDate = new Date('2025-01-01T12:00:00Z');
        
        // Create 250 messages for the exact same broker and date (Same PartitionKey)
        for (let i = 0; i < 250; i++) {
            azureTableRepo.push({
                sourceId: 'sourceA',
                topic: 'test/topic',
                payloadStringForDb: JSON.stringify({ val: i }),
                timestamp: testDate,
                correlationId: `trace-${i}`
            });
        }

        await azureTableRepo.processQueue();

        // 250 items should be split into 3 transactions (100, 100, 50)
        expect(azureTableRepo.client.submitTransaction).toHaveBeenCalledTimes(3);
        expect(azureTableRepo.client.submitTransaction.mock.calls[0][0].length).toBe(100);
        expect(azureTableRepo.client.submitTransaction.mock.calls[1][0].length).toBe(100);
        expect(azureTableRepo.client.submitTransaction.mock.calls[2][0].length).toBe(50);
    });

    test('should send failed chunks to DLQ', async () => {
        await azureTableRepo.init(mockLogger, mockConfig, mockDlqManager);
        
        // Mock a transaction failure
        azureTableRepo.client.submitTransaction.mockRejectedValueOnce(new Error("Azure Throttling"));

        azureTableRepo.push({
            sourceId: 'sourceA',
            topic: 'fail/topic',
            payloadStringForDb: '{}',
            timestamp: new Date(),
            correlationId: '123'
        });

        await azureTableRepo.processQueue();

        // Ensure DLQ was called with the failed chunk formatted correctly
        expect(mockDlqManager.push).toHaveBeenCalledTimes(1);
        const dlqPayload = mockDlqManager.push.mock.calls[0][0];
        expect(dlqPayload[0].topic).toBe('fail/topic');
    });
});