/**
 * @license Apache License, Version 2.0 (the "License")
 * @author Sebastien Lalaurette
 * * Unit tests for the Mapper Engine.
 * Verifies sandbox execution, database requirement detection, and message routing.
 */

// Mock the file system
jest.mock('fs');

const fs = require('fs');
const mapperEngineFactory = require('../core/engine/mapperEngine');

// Helper to create a fully mockable logger
const createMockLogger = () => {
    const logger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    };
    logger.child = jest.fn().mockReturnValue(logger);
    return logger;
};

describe('MapperEngine', () => {
    let mockConnections, mockBroadcaster, mockLogger, mockReplacer, engine, mockSandboxPool;

    beforeEach(() => {
        jest.clearAllMocks();

        mockConnections = new Map();
        mockBroadcaster = jest.fn();
        mockLogger = createMockLogger();
        mockReplacer = (k, v) => v; // Simple passthrough for JSON.stringify

        // Mock SandboxPool
        mockSandboxPool = {
            execute: jest.fn().mockImplementation(async (code, contextData) => {
                // Basic mock execution logic for tests
                if (code.includes('throw new Error("Sandbox boom!");')) {
                    throw new Error("Sandbox boom!");
                }
                if (code.includes('msg.payload.val * 2')) {
                    return [{ topic: "test/target", payload: { new_val: contextData.msg.payload.val * 2 } }];
                }
                return contextData.msg;
            })
        };

        // Create a mock mappings.json configuration
        const mockConfig = {
            activeVersionId: 'v1',
            versions: [
                {
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
                },
                {
                    id: 'v2',
                    name: 'Version 2',
                    rules: []
                }
            ]
        };

        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify(mockConfig));

        // Initialize the engine with the mock sandbox pool
        engine = mapperEngineFactory(mockConnections, mockBroadcaster, mockLogger, mockReplacer, {}, mockSandboxPool);
        
        // Inject a mock Database
        engine.setDb({
            all: jest.fn((sql, ...args) => {
                const cb = args[args.length - 1]; 
                if (typeof cb === 'function') cb(null, [{ 1: 1 }]);
            }),
            get: jest.fn((sql, ...args) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') cb(null, { 1: 1 });
            })
        });
    });

    test('rulesForTopicRequireDb should detect "await db" usage in target scripts', () => {
        expect(engine.rulesForTopicRequireDb('test/source')).toBe(true);
        expect(engine.rulesForTopicRequireDb('other/topic')).toBe(false);
    });

    test('processMessage should execute JS code in sandbox and call publish', async () => {
        const mockPublish = jest.fn();
        mockConnections.set('default_connector', {
            connected: true,
            publish: mockPublish
        });

        // Trigger the mapper with a payload of { val: 21 }
        await engine.processMessage('default_connector', 'test/source', { val: 21 }, false);

        // Target 1 should have multiplied the value by 2 (21 * 2 = 42)
        expect(mockPublish).toHaveBeenCalledWith(
            'test/target',
            JSON.stringify({ new_val: 42 }),
            expect.any(Object)
        );
        
        const metrics = engine.getMetrics();
        expect(metrics['test/source::target_1'].count).toBe(1);
    });

    test('processMessage should handle execution errors gracefully', async () => {
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
                        code: 'throw new Error("Sandbox boom!");'
                    }]
                }]
            }]
        };
        fs.readFileSync.mockReturnValue(JSON.stringify(badConfig));
        engine = mapperEngineFactory(mockConnections, mockBroadcaster, mockLogger, mockReplacer, {}, mockSandboxPool);

        await engine.processMessage('default_connector', 'test/error', { val: 1 }, false);

        const metrics = engine.getMetrics();
        const logs = metrics['test/error::err_target'].logs;
        expect(logs.length).toBeGreaterThan(0);
        expect(logs[0].error).toContain("Sandbox boom!");
    });

    test('deleteVersion should delete a non-active version', () => {
        const result = engine.deleteVersion('v2'); // Note: v2 doesn't exist in our mock but logic should handle it
        expect(result).toBe(true);
        expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('deleteVersion should NOT delete the active version', () => {
        const result = engine.deleteVersion('v1'); // activeVersionId is v1
        expect(result).toBe(false);
        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
});
