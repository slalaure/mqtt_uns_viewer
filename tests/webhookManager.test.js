/**
 * @license Apache License, Version 2.0 (the "License")
 * @author Sebastien Lalaurette
 * * Unit tests for the Webhook Manager.
 * Verifies database persistence, dynamic triggering based on topics, and the anti-flood mechanism.
 */

// --- Mock Dependencies ---
jest.mock('axios', () => {
    const fn = jest.fn();
    fn.post = jest.fn();
    fn.get = jest.fn();
    return fn;
});
const axios = require('axios');
const webhookManager = require('../core/webhookManager');

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

describe('WebhookManager', () => {
    let mockDb;
    let mockLogger;

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Mock DuckDB Interface
        mockDb = {
            exec: jest.fn((query, cb) => { if (cb) cb(null); }),
            run: jest.fn(function() {
                const args = Array.from(arguments);
                const cb = args.find(a => typeof a === 'function');
                if (cb) cb(null);
            }),
            all: jest.fn(function() {
                const args = Array.from(arguments);
                const cb = args.find(a => typeof a === 'function');
                if (cb) cb(null, []);
            })
        };

        mockLogger = createMockLogger();

        // Reset the internal state of the singleton
        webhookManager.webhooks = [];
        webhookManager.lastTriggered = new Map();
        
        // Set fixed time for deterministic anti-flood testing
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should initialize and create the webhooks table if missing', () => {
        webhookManager.init(mockDb, mockLogger);
        
        expect(mockDb.exec).toHaveBeenCalledWith(
            expect.stringContaining('CREATE TABLE IF NOT EXISTS webhooks'),
            expect.any(Function)
        );
    });

    test('should add a webhook and reload the state from DB', async () => {
        webhookManager.init(mockDb, mockLogger);
        
        // Mock loadWebhooks behavior
        mockDb.all.mockImplementation((query, cb) => {
            if (query.includes('SELECT * FROM webhooks WHERE active = true')) {
                cb(null, [{ id: 'wh_1', topic: 'alert/#', url: 'http://test.com', method: 'POST', min_interval_ms: 1000 }]);
            } else {
                cb(null, []);
            }
        });

        const newWebhook = {
            id: 'wh_1',
            topic: 'alert/#',
            url: 'http://test.com',
            min_interval_ms: 1000
        };

        await webhookManager.addWebhook(newWebhook);

        expect(mockDb.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO webhooks'),
            'wh_1', 'alert/#', 'http://test.com', 'POST', 1000,
            expect.any(Function)
        );
        expect(webhookManager.webhooks.length).toBe(1);
    });

    test('should trigger webhook if the topic matches and anti-flood passes', async () => {
        webhookManager.init(mockDb, mockLogger);
        
        // Inject a webhook into the memory state manually
        webhookManager.webhooks = [{
            id: 'wh_test',
            topic: 'factory/line1/alarms/+',
            url: 'http://api.internal/notify',
            method: 'POST',
            min_interval_ms: 5000,
            active: true
        }];

        axios.mockResolvedValue({ status: 200 });

        const payload = { severity: 'critical', msg: 'Belt jammed' };
        const correlationId = 'trace-x-123';

        // Fire trigger
        await webhookManager.trigger('factory/line1/alarms/belt', payload, correlationId);

        expect(axios).toHaveBeenCalledTimes(1);
        expect(axios).toHaveBeenCalledWith(expect.objectContaining({
            method: 'POST',
            url: 'http://api.internal/notify',
            data: expect.objectContaining({
                topic: 'factory/line1/alarms/belt',
                payload: payload,
                webhookId: 'wh_test',
                correlationId: correlationId
            })
        }));

        // Verify DB update for last_triggered was called
        expect(mockDb.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE webhooks SET last_triggered'),
            'wh_test'
        );
    });

    test('should block triggers due to anti-flood rate limits', async () => {
        webhookManager.init(mockDb, mockLogger);
        
        webhookManager.webhooks = [{
            id: 'wh_flood',
            topic: 'sensors/#',
            url: 'http://api.internal/metrics',
            method: 'POST',
            min_interval_ms: 2000, // 2 seconds limit
            active: true
        }];

        axios.mockResolvedValue({ status: 200 });

        // Trigger 1 (T=0ms) - Should Pass
        await webhookManager.trigger('sensors/temp', { val: 20 });
        
        // Trigger 2 (T=500ms) - Should be Blocked
        jest.advanceTimersByTime(500);
        await webhookManager.trigger('sensors/temp', { val: 21 });
        
        // Trigger 3 (T=1000ms) - Should be Blocked
        jest.advanceTimersByTime(500);
        await webhookManager.trigger('sensors/temp', { val: 22 });

        // Trigger 4 (T=2500ms) - Should Pass (2500ms > 2000ms limit)
        jest.advanceTimersByTime(1500);
        await webhookManager.trigger('sensors/temp', { val: 25 });

        expect(axios).toHaveBeenCalledTimes(2);
    });

    test('should not crash if axios webhook delivery fails', async () => {
        webhookManager.init(mockDb, mockLogger);
        
        webhookManager.webhooks = [{
            id: 'wh_fail',
            topic: 'test',
            url: 'http://api.broken/endpoint',
            method: 'POST',
            min_interval_ms: 0,
            active: true
        }];

        // Mock a network failure
        axios.mockRejectedValue(new Error("Network timeout"));

        await webhookManager.trigger('test', { data: 1 }, 'corr-123');

        // Expect the warning to be logged with correlationId
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ err: "Network timeout", url: 'http://api.broken/endpoint', correlationId: 'corr-123' }),
            expect.stringContaining('failed')
        );
    });

    test('should allow manual testing of a specific webhook', async () => {
        webhookManager.init(mockDb, mockLogger);
        
        webhookManager.webhooks = [{
            id: 'wh_manual',
            topic: 'some/topic',
            url: 'http://api.internal/test',
            method: 'POST',
            min_interval_ms: 1000,
            active: true
        }];

        axios.mockResolvedValue({ status: 200 });

        await webhookManager.testWebhook('wh_manual');

        expect(axios).toHaveBeenCalledWith(expect.objectContaining({
            url: 'http://api.internal/test',
            data: expect.objectContaining({
                topic: 'test/topic',
                payload: expect.objectContaining({ test: true }),
                correlationId: 'test-correlation-id'
            })
        }));
    });
});
