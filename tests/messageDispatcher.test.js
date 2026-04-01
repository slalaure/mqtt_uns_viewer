/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the Central Message Dispatcher.
 * Verifies rate limiting (anti-spam), payload size protections, and edge cases.
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
        mockWsManager = { broadcast: jest.fn(), sendToClient: jest.fn() };
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

    test('should allow exactly 50 messages per second without throttling', async () => {
        const providerId = 'mqtt_local';
        const topic = 'factory/line1/sensor_a';
        const payload = JSON.stringify({ value: 10 });

        for (let i = 0; i < 50; i++) {
            await handleMessage(providerId, topic, payload);
        }

        expect(mockDataManager.insertMessage).toHaveBeenCalledTimes(50);
    });

    test('should throttle the 51st message within the same second', async () => {
        const providerId = 'mqtt_local';
        const topic = 'factory/line1/sensor_b';
        const payload = JSON.stringify({ value: 10 });

        for (let i = 0; i < 51; i++) {
            await handleMessage(providerId, topic, payload);
        }

        expect(mockDataManager.insertMessage).toHaveBeenCalledTimes(50);
    });

    test('should reset throttle count after 1 second interval', async () => {
        const providerId = 'mqtt_local';
        const topic = 'factory/line1/sensor_c';
        const payload = JSON.stringify({ value: 10 });

        // Send 60 messages instantly (50 pass, 10 dropped)
        for (let i = 0; i < 60; i++) {
            await handleMessage(providerId, topic, payload);
        }

        expect(mockDataManager.insertMessage).toHaveBeenCalledTimes(50);

        // Advance time by 1.1 seconds to clear the interval
        jest.advanceTimersByTime(1100);

        // Send 10 more messages
        for (let i = 0; i < 10; i++) {
            await handleMessage(providerId, topic, payload);
        }

        // Total inserted should be 60 (50 from first burst + 10 from second burst)
        expect(mockDataManager.insertMessage).toHaveBeenCalledTimes(60);
    });

    test('should allow payloads exactly at or just below 2MB', async () => {
        const providerId = 'mqtt_local';
        const topic = 'factory/camera/image_ok';
        
        // Exactly 2MB string
        const exactPayload = "A".repeat(2 * 1024 * 1024);

        await handleMessage(providerId, topic, exactPayload);

        expect(mockDataManager.insertMessage).toHaveBeenCalledTimes(1);
        const insertedArg = mockDataManager.insertMessage.mock.calls[0][0];
        
        // Verify it was NOT truncated
        const parsedDbPayload = JSON.parse(insertedArg.payloadStringForDb);
        expect(parsedDbPayload.raw_payload).toBe(exactPayload);
    });

    test('should truncate payloads strictly exceeding 2MB and emit an error payload', async () => {
        const providerId = 'mqtt_local';
        const topic = 'factory/camera/image_large';
        
        // Massive payload string (> 2.5 MB)
        const hugePayload = "A".repeat(2.5 * 1024 * 1024);

        await handleMessage(providerId, topic, hugePayload);

        expect(mockDataManager.insertMessage).toHaveBeenCalledTimes(1);
        
        const insertedArg = mockDataManager.insertMessage.mock.calls[0][0];
        
        // Verify the payload was replaced by the truncation warning
        const parsedDbPayload = JSON.parse(insertedArg.payloadStringForDb);
        expect(parsedDbPayload.error).toBe("PAYLOAD_TOO_LARGE");
        expect(parsedDbPayload.original_size_bytes).toBeGreaterThan(2 * 1024 * 1024);
    });

    test('should handle malformed JSON gracefully and store as raw string', async () => {
        const providerId = 'mqtt_local';
        const topic = 'factory/legacy/sensor';
        const malformedPayload = "{ value: 25, broken_json: true"; // Missing quotes and brace

        await handleMessage(providerId, topic, malformedPayload);

        expect(mockDataManager.insertMessage).toHaveBeenCalledTimes(1);
        const insertedArg = mockDataManager.insertMessage.mock.calls[0][0];

        const parsedDbPayload = JSON.parse(insertedArg.payloadStringForDb);
        expect(parsedDbPayload.raw_payload).toBe(malformedPayload);
    });

    test('should generate and propagate a unique correlationId if not provided', async () => {
        const providerId = 'mqtt_local';
        const topic = 'sensors/temp';
        const payload = JSON.stringify({ value: 25 });

        mockMapperEngine.rulesForTopicRequireDb.mockReturnValue(false);

        await handleMessage(providerId, topic, payload);

        expect(mockDataManager.insertMessage).toHaveBeenCalledWith(expect.objectContaining({
            correlationId: expect.any(String)
        }));

        const correlationId = mockDataManager.insertMessage.mock.calls[0][0].correlationId;
        expect(correlationId).toHaveLength(36); // standard UUID length

        expect(mockMapperEngine.processMessage).toHaveBeenCalledWith(
            providerId, topic, expect.any(Object), false, correlationId
        );

        expect(mockAlertManager.processMessage).toHaveBeenCalledWith(
            providerId, topic, expect.any(Object), correlationId
        );
    });

    test('should preserve an ingress correlationId if provided in options', async () => {
        const providerId = 'mqtt_local';
        const topic = 'sensors/pressure';
        const payload = JSON.stringify({ value: 1.5 });
        const ingressId = 'custom-trace-id-999';

        mockMapperEngine.rulesForTopicRequireDb.mockReturnValue(false);

        await handleMessage(providerId, topic, payload, { correlationId: ingressId });

        expect(mockDataManager.insertMessage).toHaveBeenCalledWith(expect.objectContaining({
            correlationId: ingressId
        }));
    });
});