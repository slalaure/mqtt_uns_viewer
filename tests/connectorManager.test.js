/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit Tests for ConnectorManager (Plugin Loader)
 */

// 1. Mock messageDispatcher FIRST to avoid worker pool initialization
jest.mock('../core/messageDispatcher', () => ({
    init: jest.fn().mockReturnValue(jest.fn())
}));

const path = require('path');
const connectorManager = require('../connectors/connectorManager');
const BaseProvider = require('../connectors/baseProvider');

// Mock Dependencies
const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis()
};

const mockContext = {
    logger: mockLogger,
    config: { DATA_PROVIDERS: [] },
    activeConnections: new Map(),
    wsManager: {},
    mapperEngine: {},
    dataManager: {},
    broadcastDbStatus: jest.fn(),
    alertManager: {}
};

describe('ConnectorManager Plugin Loading', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        connectorManager.providers.clear();
        mockContext.activeConnections.clear();
        connectorManager.init(mockContext); // Ensure logger is always initialized
    });

    test('should resolve internal connector if external not found', () => {
        // We know 'mqtt' exists internally
        const ProviderClass = connectorManager._resolveProvider('mqtt');
        expect(ProviderClass).toBeDefined();
        expect(ProviderClass.prototype).toBeInstanceOf(BaseProvider);
    });

    test('should return null for non-existent connector', () => {
        const ProviderClass = connectorManager._resolveProvider('non-existent-protocol');
        expect(ProviderClass).toBeNull();
    });

    test('should validate that plugin extends BaseProvider', () => {
        // Mock a module that does NOT extend BaseProvider
        jest.mock('korelate-plugin-invalid', () => {
            return class NotABaseProvider {};
        }, { virtual: true });

        const ProviderClass = connectorManager._resolveProvider('invalid');
        expect(ProviderClass).toBeNull();
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('does not extend BaseProvider'));
    });

    test('should favor korelate-plugin- prefix over internal', () => {
        // Mock a plugin that would override internal 'mqtt'
        class MockMqttPlugin extends BaseProvider {
            async connect() { return true; }
        }
        
        jest.mock('korelate-plugin-mqtt', () => MockMqttPlugin, { virtual: true });

        const ProviderClass = connectorManager._resolveProvider('mqtt');
        expect(ProviderClass).toBe(MockMqttPlugin);
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Successfully resolved connector [mqtt] from: korelate-plugin-mqtt'));
    });

    test('should load provider and add to activeConnections', async () => {
        class MockTestPlugin extends BaseProvider {
            constructor(config, context) {
                super(config, context);
                this.connected = false;
            }
            async connect() { 
                this.connected = true;
                return true; 
            }
            async disconnect() { this.connected = false; }
            publish() {}
        }

        jest.mock('korelate-plugin-test-success', () => MockTestPlugin, { virtual: true });
        
        const providerConfig = {
            id: 'test_id',
            type: 'test-success',
            options: {}
        };

        connectorManager.loadProvider(providerConfig);

        expect(connectorManager.providers.has('test_id')).toBe(true);
        expect(mockContext.activeConnections.has('test_id')).toBe(true);
        
        const connection = mockContext.activeConnections.get('test_id');
        expect(typeof connection.publish).toBe('function');
    });

    test('should fail if provider ID is missing', () => {
        connectorManager.loadProvider({ type: 'mqtt' }); // Missing ID
        expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("Missing 'id'"));
    });
});
