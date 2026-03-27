/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the Mapper Engine.
 * Verifies sandbox execution, database requirement detection, and message routing.
 */

const fs = require('fs');
const mapperEngineFactory = require('../core/engine/mapperEngine');

// Mock the file system
jest.mock('fs');

// Helper to create a fully mockable logger
const createMockLogger = () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockImplementation(() => createMockLogger())
});

describe('MapperEngine', () => {
    let mockConnections, mockBroadcaster, mockLogger, mockReplacer, engine;

    beforeEach(() => {
        jest.clearAllMocks();

        mockConnections = new Map();
        mockBroadcaster = jest.fn();
        mockLogger = createMockLogger();
        mockReplacer = (k, v) => v; // Simple passthrough for JSON.stringify

        // Create a mock mappings.json configuration
        const mockConfig = {
            activeVersionId: 'v1',
            versions: [{
                id: 'v1',
                rules: [
                    {
                        sourceTopic: 'test/source',
                        targets: [
                            {
                                id: 'target_1',
                                enabled: true,
                                outputTopic: 'test/target',
                                routingMode: 'code',
                                // Script that multiplies the value by 2
                                code: 'return [{ topic: "test/target", payload: { new_val: msg.payload.val * 2 } }];'
                            },
                            {
                                id: 'target_2',
                                enabled: true,
                                outputTopic: 'test/db',
                                routingMode: 'code',
                                // Script containing a DB call
                                code: 'await db.all("SELECT 1"); return msg;'
                            }
                        ]
                    }
                ]
            }]
        };

        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify(mockConfig));

        // Initialize the engine
        engine = mapperEngineFactory(mockConnections, mockBroadcaster, mockLogger, mockReplacer, {});
        
        // Inject a mock Database that uses callbacks, matching the duckdb API
        // This prevents the sandbox's 'await db.all' from hanging indefinitely
        engine.setDb({
            all: jest.fn((sql, ...args) => {
                const cb = args[args.length - 1]; // Callback is always the last argument
                if (typeof cb === 'function') cb(null, [{ 1: 1 }]);
            }),
            get: jest.fn((sql, ...args) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') cb(null, { 1: 1 });
            })
        });
    });

    test('rulesForTopicRequireDb should detect "await db" usage in target scripts', () => {
        // The rule for 'test/source' has a target that uses 'await db'
        expect(engine.rulesForTopicRequireDb('test/source')).toBe(true);
        
        // Unmapped topic should not require DB
        expect(engine.rulesForTopicRequireDb('other/topic')).toBe(false);
    });

    test('processMessage should execute JS code in sandbox and call publish', async () => {
        const mockPublish = jest.fn();
        mockConnections.set('default_broker', {
            connected: true,
            publish: mockPublish
        });

        // Trigger the mapper with a payload of { val: 21 }
        await engine.processMessage('default_broker', 'test/source', { val: 21 }, false);

        // Target 1 should have multiplied the value by 2 (21 * 2 = 42)
        expect(mockPublish).toHaveBeenCalledWith(
            'test/target',
            JSON.stringify({ new_val: 42 }),
            expect.any(Object) // options object { qos: 1, retain: false }
        );
        
        // Verify that metrics were correctly updated for Target 1
        const metrics = engine.getMetrics();
        expect(metrics['test/source::target_1'].count).toBe(1);
    });

    test('processMessage should handle execution errors gracefully', async () => {
        // Modify the config to inject a syntax error
        const badConfig = {
            activeVersionId: 'v1',
            versions: [{
                id: 'v1',
                rules: [{
                    sourceTopic: 'test/error',
                    targets: [{
                        id: 'err_target',
                        enabled: true,
                        routingMode: 'code',
                        code: 'throw new Error("Sandbox boom!");' // Deliberate crash
                    }]
                }]
            }]
        };
        fs.readFileSync.mockReturnValue(JSON.stringify(badConfig));
        engine = mapperEngineFactory(mockConnections, mockBroadcaster, mockLogger, mockReplacer, {});

        // This should NOT crash the Node process
        await engine.processMessage('default_broker', 'test/error', { val: 1 }, false);

        // Verify the error was caught and logged into the metrics system
        const metrics = engine.getMetrics();
        const logs = metrics['test/error::err_target'].logs;
        expect(logs.length).toBeGreaterThan(0);
        expect(logs[0].error).toContain("Sandbox boom!");
    });
});