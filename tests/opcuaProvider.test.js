/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the OPC UA Provider.
 * Verifies connection management, subscription setup, and connection drop/backoff recovery.
 */

const OpcUaProvider = require('../connectors/opcua/index');
const { OPCUAClient, ClientSubscription, ClientMonitoredItem } = require('node-opcua');

// Mock node-opcua module
jest.mock('node-opcua', () => {
    const mockSession = {
        close: jest.fn().mockResolvedValue(true),
        write: jest.fn((nodeToWrite, callback) => callback(null, { value: 0, name: 'Good' }))
    };

    const mockClient = {
        on: jest.fn().mockReturnThis(),
        connect: jest.fn().mockResolvedValue(true),
        createSession: jest.fn().mockResolvedValue(mockSession),
        disconnect: jest.fn().mockResolvedValue(true)
    };

    const mockSubscription = {
        on: jest.fn().mockReturnThis(),
        terminate: jest.fn().mockResolvedValue(true)
    };

    const mockMonitoredItem = {
        on: jest.fn().mockReturnThis()
    };

    return {
        OPCUAClient: {
            create: jest.fn(() => mockClient)
        },
        ClientSubscription: {
            create: jest.fn(() => mockSubscription)
        },
        ClientMonitoredItem: {
            create: jest.fn(() => mockMonitoredItem)
        },
        AttributeIds: { Value: 13 },
        TimestampsToReturn: { Both: 2 },
        DataType: { Double: 11, Int32: 6, Boolean: 1, String: 12 }
    };
});

const createMockLogger = () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockImplementation(() => createMockLogger())
});

describe('OpcUaProvider', () => {
    let mockContext;
    let providerConfig;

    beforeEach(() => {
        jest.clearAllMocks();

        mockContext = {
            logger: createMockLogger(),
            handleMessage: jest.fn(),
            updateBrokerStatus: jest.fn()
        };

        providerConfig = {
            id: 'test_opc',
            type: 'opcua',
            endpointUrl: 'opc.tcp://mock-server:4840',
            subscribe: [
                { nodeId: 'ns=1;s=Temperature', topic: 'uns/factory/temp' }
            ]
        };
    });

    test('should connect and create session and subscription successfully', async () => {
        const provider = new OpcUaProvider(providerConfig, mockContext);
        
        const result = await provider.connect();
        
        expect(result).toBe(true);
        expect(provider.connected).toBe(true);
        expect(mockContext.updateBrokerStatus).toHaveBeenCalledWith('test_opc', 'connecting', null);
        expect(mockContext.updateBrokerStatus).toHaveBeenCalledWith('test_opc', 'connected', null);
        
        // Verify OPC UA calls
        expect(OPCUAClient.create).toHaveBeenCalled();
        expect(provider.client.connect).toHaveBeenCalledWith('opc.tcp://mock-server:4840');
        expect(provider.client.createSession).toHaveBeenCalled();
        expect(ClientSubscription.create).toHaveBeenCalled();
    });

    test('should handle connection backoff events (simulated connection drop/retry)', async () => {
        const provider = new OpcUaProvider(providerConfig, mockContext);
        await provider.connect();

        // Extract the backoff event handler registered during connect
        const backoffCall = provider.client.on.mock.calls.find(call => call[0] === 'backoff');
        expect(backoffCall).toBeDefined();

        const backoffHandler = backoffCall[1];
        
        // Simulate a connection drop resulting in a backoff retry
        backoffHandler(3, 5000); // Retry #3, 5000ms delay

        expect(mockContext.updateBrokerStatus).toHaveBeenCalledWith('test_opc', 'connecting', 'Retrying... (3)');
        expect(provider.logger.warn).toHaveBeenCalledWith(expect.stringContaining('5000ms'));
    });

    test('should handle connection failures gracefully', async () => {
        // Force the mock client to reject the connection
        const provider = new OpcUaProvider(providerConfig, mockContext);
        provider.client = OPCUAClient.create(); // Create instance early to mock its rejection
        provider.client.connect.mockRejectedValueOnce(new Error("Connection Refused"));

        const result = await provider.connect();

        expect(result).toBe(false);
        expect(provider.connected).toBe(false);
        expect(mockContext.updateBrokerStatus).toHaveBeenCalledWith('test_opc', 'error', 'Connection Refused');
        expect(provider.logger.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Failed to connect'));
    });

    test('should map incoming data to correct UNS topic', async () => {
        const provider = new OpcUaProvider(providerConfig, mockContext);
        await provider.connect();

        // Extract the subscription start event to trigger monitorItems
        const subStartedCall = provider.subscription.on.mock.calls.find(call => call[0] === 'started');
        const subStartedHandler = subStartedCall[1];
        subStartedHandler();

        expect(ClientMonitoredItem.create).toHaveBeenCalledTimes(1);

        // Find the 'changed' event handler
        const mockMonitoredItemInstance = ClientMonitoredItem.create.mock.results[0].value;
        const changedCall = mockMonitoredItemInstance.on.mock.calls.find(call => call[0] === 'changed');
        const changedHandler = changedCall[1];

        // Simulate incoming OPC UA DataValue
        const mockDataValue = {
            value: { value: 42.5 },
            statusCode: { name: 'Good' },
            sourceTimestamp: new Date('2025-01-01T12:00:00Z')
        };

        changedHandler(mockDataValue);

        // Verify the payload is mapped to the UNS topic and forwarded to the central engine
        expect(mockContext.handleMessage).toHaveBeenCalledWith('test_opc', 'uns/factory/temp', {
            value: 42.5,
            quality: 'Good',
            timestamp: mockDataValue.sourceTimestamp
        }, {}); // Empty options
    });

    test('should disconnect and cleanup resources gracefully', async () => {
        const provider = new OpcUaProvider(providerConfig, mockContext);
        await provider.connect();
        
        expect(provider.connected).toBe(true);

        await provider.disconnect();

        expect(provider.connected).toBe(false);
        expect(provider.subscription.terminate).toHaveBeenCalled();
        expect(provider.session.close).toHaveBeenCalled();
        expect(provider.client.disconnect).toHaveBeenCalled();
        expect(mockContext.updateBrokerStatus).toHaveBeenCalledWith('test_opc', 'disconnected', null);
    });
});