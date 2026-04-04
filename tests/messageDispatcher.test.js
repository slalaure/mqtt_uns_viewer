/**
 * @license Apache License, Version 2.0 (the "License")
 * @author Sebastien Lalaurette
 * * Unit tests for the Central Message Dispatcher.
 * Verifies rate limiting (anti-spam), payload size protections, and edge cases.
 */

// Mock worker_threads to prevent real workers from starting in tests
jest.mock('worker_threads', () => ({
    Worker: jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        postMessage: jest.fn(),
        terminate: jest.fn()
    })),
    parentPort: {
        postMessage: jest.fn(),
        on: jest.fn()
    }
}));

const messageDispatcher = require('../core/messageDispatcher');

// Helper to create a fully mockable logger
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

describe('MessageDispatcher', () => {
    let mockLogger, mockWsManager, mockMapperEngine, mockDataManager, mockAlertManager, mockConfig;
    let handleMessage, mockWorkerPool;

    beforeEach(() => {
        jest.clearAllMocks();
        messageDispatcher.resetThrottling();

        mockLogger = createMockLogger();
        mockConfig = {};
        mockWsManager = { broadcast: jest.fn(), sendToClient: jest.fn() };
        mockMapperEngine = {
            rulesForTopicRequireDb: jest.fn().mockReturnValue(true),
            processMessage: jest.fn().mockResolvedValue(null)
        };
        mockDataManager = { insertMessage: jest.fn() };
        mockAlertManager = { processMessage: jest.fn().mockResolvedValue(null) };
        const mockBroadcastDbStatus = jest.fn();

        // Mock Worker Pool - Synchronous resolution
        mockWorkerPool = {
            execute: jest.fn().mockImplementation((action, payload) => {
                if (action === 'parse_json') {
                    try {
                        const parsed = (typeof payload === 'string') ? JSON.parse(payload) : payload;
                        return Promise.resolve(parsed);
                    } catch (e) {
                        return Promise.resolve({ raw_payload: payload });
                    }
                }
                return Promise.resolve(payload);
            })
        };
        messageDispatcher.setWorkerPool(mockWorkerPool);

        // Initialize the dispatcher
        handleMessage = messageDispatcher.init(
            mockLogger, mockConfig, mockWsManager, mockMapperEngine, 
            mockDataManager, mockBroadcastDbStatus, mockAlertManager
        );
    });

    test('should allow exactly 50 messages per second without throttling', async () => {
        const providerId = 'mqtt_local';
        const topic = 'test/throttling/a';
        const payload = JSON.stringify({ value: 10 });

        const promises = [];
        for (let i = 0; i < 50; i++) {
            promises.push(handleMessage(providerId, topic, payload));
        }
        await Promise.all(promises);

        expect(mockDataManager.insertMessage).toHaveBeenCalledTimes(50);
    });

    test('should throttle the 51st message within the same second', async () => {
        const providerId = 'mqtt_local';
        const topic = 'test/throttling/b';
        const payload = JSON.stringify({ value: 10 });

        const promises = [];
        for (let i = 0; i < 55; i++) {
            promises.push(handleMessage(providerId, topic, payload));
        }
        await Promise.all(promises);

        expect(mockDataManager.insertMessage).toHaveBeenCalledTimes(50);
    });

    test('should allow payloads exactly at or just below 2MB', async () => {
        const providerId = 'mqtt_local';
        const topic = 'test/size/ok';
        const data = "A".repeat(1000);
        const payload = JSON.stringify({ raw_payload: data });

        await handleMessage(providerId, topic, payload);

        expect(mockDataManager.insertMessage).toHaveBeenCalledTimes(1);
    });

    test('should handle malformed JSON gracefully', async () => {
        const providerId = 'mqtt_local';
        const topic = 'test/malformed/json';
        const malformedPayload = "{ value: 25, broken_json: true"; 

        await handleMessage(providerId, topic, malformedPayload);

        expect(mockDataManager.insertMessage).toHaveBeenCalledTimes(1);
    });

    test('should generate and propagate correlationId', async () => {
        const providerId = 'mqtt_local';
        const topic = 'test/correlation/prop';
        const payload = JSON.stringify({ value: 25 });

        mockMapperEngine.rulesForTopicRequireDb.mockReturnValue(false);

        await handleMessage(providerId, topic, payload);

        expect(mockDataManager.insertMessage).toHaveBeenCalledWith(expect.objectContaining({
            correlationId: expect.any(String)
        }));
    });
});
