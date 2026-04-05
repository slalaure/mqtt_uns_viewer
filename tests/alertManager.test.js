/**
 * @license Apache License, Version 2.0 (the "License")
 * @author Sebastien Lalaurette
 * * Unit tests for the Alert Manager.
 * Verifies rule evaluation, VM sandbox isolation, and state transitions.
 */

// Mock axios
jest.mock('axios', () => ({
    post: jest.fn().mockResolvedValue({ status: 200 })
}));
const axios = require('axios');
const alertManager = require('../core/engine/alertManager');

// Helper to create a fully mockable logger
const createMockLogger = () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockImplementation(() => createMockLogger())
});

describe('AlertManager', () => {
    let mockDb, mockLogger, mockConfig, mockBroadcaster, mockSandboxPool;

    beforeEach(() => {
        jest.clearAllMocks();

        mockLogger = createMockLogger();
        mockConfig = {};
        mockBroadcaster = jest.fn();

        // Mock SandboxPool
        mockSandboxPool = {
            execute: jest.fn().mockImplementation(async (code, contextData) => {
                if (code.includes('msg.payload.val > 50')) {
                    return contextData.msg.payload.val > 50;
                }
                return false;
            })
        };

        // Create a Mock DB simulating DuckDB's run and all methods
        mockDb = {
            run: jest.fn((sql, ...args) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') cb(null);
            }),
            all: jest.fn((sql, ...args) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') cb(null, []);
            }),
            exec: jest.fn((sql, cb) => {
                if (typeof cb === 'function') cb(null);
            }),
            serialize: jest.fn(cb => cb())
        };

        // Initialize the Alert Manager
        alertManager.init(mockDb, mockLogger, mockConfig, mockBroadcaster);
        alertManager.setSandbox(mockSandboxPool);
    });

    test('createRule should insert a new rule into the database', async () => {
        const ruleData = {
            name: "High Temp Alert",
            topic_pattern: "factory/+/temp",
            condition_code: "return msg.payload.value > 80;",
            severity: "critical",
            owner_id: "user_123"
        };

        const result = await alertManager.createRule(ruleData);

        expect(result).toHaveProperty('id');
        expect(result.name).toBe("High Temp Alert");
        expect(mockDb.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO alert_rules'),
            expect.any(String), // id
            "High Temp Alert",
            "user_123",
            "factory/+/temp",
            "return msg.payload.value > 80;",
            "critical",
            undefined, // workflow_prompt
            "{}",      // notifications
            true,      // enabled
            expect.any(String), // created_at
            expect.any(Function)
        );
    });

    test('updateAlertStatus should update the database and emit a broadcast', async () => {
        const alertId = 'alert_999';
        const status = 'acknowledged';
        const username = 'AdminUser';

        const result = await alertManager.updateAlertStatus(alertId, status, username);

        expect(result).toEqual({ id: alertId, status: 'acknowledged', handled_by: username });
        expect(mockDb.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE active_alerts SET status = ?, handled_by = ?, updated_at = ?'),
            'acknowledged',
            'AdminUser',
            expect.any(String),
            alertId,
            expect.any(Function)
        );

        // Verify the websocket broadcast fired
        expect(mockBroadcaster).toHaveBeenCalledWith(expect.stringContaining('"type":"alert-updated"'));
    });

    test('processMessage should evaluate a matching rule and trigger an alert if true', async () => {
        // Mock the DB to return an active rule when processMessage checks for rules
        mockDb.all.mockImplementation((sql, ...args) => {
            const cb = args[args.length - 1];
            if (sql.includes('SELECT * FROM alert_rules')) {
                cb(null, [{
                    id: 'rule_1',
                    name: 'Test Rule',
                    topic_pattern: 'test/sensor',
                    condition_code: 'return msg.payload.val > 50;',
                    severity: 'warning'
                }]);
            } else if (sql.includes('SELECT id FROM active_alerts')) {
                // Deduplication check: return empty array (no existing active alert)
                cb(null, []);
            } else {
                cb(null, []);
            }
        });

        // Trigger processing
        await alertManager.processMessage('default', 'test/sensor', { val: 75 }, 'trace-123');

        // Wait for all async tasks (including processQueue microtasks and sandbox execution)
        await new Promise(resolve => setTimeout(resolve, 50));

        // Verify that the alert insertion was triggered
        expect(mockDb.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO active_alerts'),
            expect.any(String), // alert id
            'rule_1',
            'test/sensor',
            'default',
            '{"val":75}',
            'trace-123',
            expect.any(String), // created_at
            expect.any(String), // updated_at
            expect.any(Function)
        );

        // Verify broadcast was triggered
        expect(mockBroadcaster).toHaveBeenCalledWith(expect.stringContaining('"type":"alert-triggered"'));
    });

    test('processMessage should NOT trigger an alert if condition evaluates to false', async () => {
        mockDb.all.mockImplementation((sql, ...args) => {
            const cb = args[args.length - 1];
            if (sql.includes('SELECT * FROM alert_rules')) {
                cb(null, [{
                    id: 'rule_2',
                    topic_pattern: 'test/sensor',
                    condition_code: 'return msg.payload.val > 50;'
                }]);
            } else {
                cb(null, []);
            }
        });

        // Trigger processing with a value that does not satisfy the condition
        await alertManager.processMessage('default', 'test/sensor', { val: 30 });

        await new Promise(resolve => setTimeout(resolve, 50));

        // Should not insert an alert
        expect(mockDb.run).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO active_alerts'), expect.anything());
        expect(mockBroadcaster).not.toHaveBeenCalled();
    });

    test('should trigger a webhook if configured in notifications', async () => {
        const webhookUrl = 'http://webhook.test/alert';
        mockDb.all.mockImplementation((sql, ...args) => {
            const cb = args[args.length - 1];
            if (sql.includes('SELECT * FROM alert_rules')) {
                cb(null, [{
                    id: 'rule_webhook',
                    name: 'Webhook Rule',
                    topic_pattern: 'test/sensor',
                    condition_code: 'return msg.payload.val > 50;',
                    severity: 'critical',
                    notifications: JSON.stringify({ webhook: webhookUrl })
                }]);
            } else if (sql.includes('SELECT id FROM active_alerts')) {
                cb(null, []);
            } else {
                cb(null, []);
            }
        });

        // Trigger processing
        await alertManager.processMessage('default', 'test/sensor', { val: 75 }, 'trace-999');

        // Wait for all async tasks (including triggerAlert -> executeWorkflow)
        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify axios.post was called with correct data
        expect(axios.post).toHaveBeenCalledWith(
            webhookUrl,
            expect.objectContaining({
                text: expect.stringContaining('Webhook Rule')
            })
        );
        expect(axios.post).toHaveBeenCalledWith(
            webhookUrl,
            expect.objectContaining({
                text: expect.stringContaining('trace-999')
            })
        );
    });

    test('purgeResolvedAlerts should delete old alerts and vacuum the database', async () => {
        const result = await alertManager.purgeResolvedAlerts();

        expect(result).toEqual({ success: true });
        // Should delete from resolved_alerts_history
        expect(mockDb.run).toHaveBeenCalledWith(
            expect.stringContaining('DELETE FROM resolved_alerts_history'),
            expect.any(Function)
        );
        // Should also vacuum
        expect(mockDb.run).toHaveBeenCalledWith(
            "VACUUM;",
            expect.any(Function)
        );
    });
});
