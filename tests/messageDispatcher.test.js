/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the Central Message Dispatcher.
 * Verifies rate limiting (anti-spam) and payload size protections.
 */

const messageDispatcher = require('../core/messageDispatcher');

// Helper to create a fully mockable logger that supports nested .child() calls
const createMockLogger = () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockImplementation(() => createMockLogger())
});

describe('MessageDispatcher', () => {
    let mockLogger, mockWsManager, mockMapperEngine, mockDataManager, mockAlertManager, mockConfig;
    let handleMessage;

    beforeEach(() => {
        // Use Jest's fake timers to control the 1-second throttling window
        jest.useFakeTimers();

        mockLogger = createMockLogger();
        mockConfig = {};
        mockWsManager = { broadcast: jest.fn() };
        mockMapperEngine = {
            rulesForTopicRequireDb: jest.fn().mockReturnValue(true),
            processMessage: jest.fn()
        };
        mockDataManager = { insertMessage: jest.fn() };
        mockAlertManager = { processMessage: jest.fn() };
        const mockBroadcastDbStatus = jest.fn();

        // Initialize the dispatcher and get the handleMessage function
        handleMessage = messageDispatcher.init(
            mockLogger, mockConfig, mockWsManager, mockMapperEngine, 
            mockDataManager, mockBroadcastDbStatus, mockAlertManager
        );
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should throttle messages exceeding 50 per second per namespace', async () => {
        const providerId = 'mqtt_local';
        const topic = 'factory/line1/fast_sensor';
        const payload = JSON.stringify({ value: 10 });

        // Simulate a packet storm: send 60 messages instantly
        for (let i = 0; i < 60; i++) {
            await handleMessage(providerId, topic, payload);
        }

        // Only 50 should have made it to the database
        expect(mockDataManager.insertMessage).toHaveBeenCalledTimes(50);

        // Advance time by slightly more than 1 second to trigger the interval clearing the counts
        jest.advanceTimersByTime(1050);

        // Send 10 more messages
        for (let i = 0; i < 10; i++) {
            await handleMessage(providerId, topic, payload);
        }

        // Now the total inserted should be 60 (50 from previous second + 10 from current)
        expect(mockDataManager.insertMessage).toHaveBeenCalledTimes(60);
    });

    test('should truncate payloads exceeding 2MB and emit an error payload', async () => {
        const providerId = 'mqtt_local';
        const topic = 'factory/camera/image';
        
        // Create a massive payload string (> 2.5 MB)
        const hugePayload = "A".repeat(2.5 * 1024 * 1024);

        await handleMessage(providerId, topic, hugePayload);

        // Check that the message was still inserted (to log the error)
        expect(mockDataManager.insertMessage).toHaveBeenCalledTimes(1);
        
        // Extract the argument passed to insertMessage
        const insertedArg = mockDataManager.insertMessage.mock.calls[0][0];
        
        // Verify the payload was replaced by the truncation warning
        const parsedDbPayload = JSON.parse(insertedArg.payloadStringForDb);
        expect(parsedDbPayload.error).toBe("PAYLOAD_TOO_LARGE");
        expect(parsedDbPayload.original_size_bytes).toBeGreaterThan(2 * 1024 * 1024);
    });
});