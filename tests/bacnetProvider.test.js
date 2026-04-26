/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the BACnet/IP Provider.
 */

jest.mock('node-bacnet', () => {
    const mock = jest.fn().mockImplementation(() => ({
        readProperty: jest.fn((ip, obj, prop, cb) => {
            cb(null, { values: [{ value: 25.5 }] });
        }),
        writeProperty: jest.fn((ip, obj, prop, val, cb) => {
            cb(null, true);
        }),
        close: jest.fn(),
        on: jest.fn()
    }));
    
    mock.enum = {
        ApplicationTags: {
            BACNET_APPLICATION_TAG_REAL: 4,
            BACNET_APPLICATION_TAG_BOOLEAN: 9
        }
    };
    
    return mock;
});

const BacnetProvider = require('../connectors/bacnet/index');
const bacnet = require('node-bacnet');

const createMockLogger = () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    child: jest.fn().mockImplementation(() => createMockLogger())
});

describe('BacnetProvider', () => {
    let mockContext;
    let providerConfig;
    let provider;

    beforeEach(() => {
        jest.clearAllMocks();
        mockContext = {
            logger: createMockLogger(),
            handleMessage: jest.fn(),
            updateConnectorStatus: jest.fn()
        };
        providerConfig = {
            id: 'test_bacnet',
            type: 'bacnet',
            targetDeviceIp: '192.168.1.50',
            pollingInterval: 100,
            subscribe: [
                '0:1:85::bms/room1/temp'
            ]
        };
    });

    afterEach(async () => {
        if (provider) await provider.disconnect();
    });

    test('should connect and parse mappings successfully', async () => {
        provider = new BacnetProvider(providerConfig, mockContext);
        const result = await provider.connect();
        
        expect(result).toBe(true);
        expect(provider.connected).toBe(true);
        expect(provider.mappings.length).toBe(1);
        expect(provider.mappings[0].objectId).toEqual({ type: 0, instance: 1 });
        expect(mockContext.updateConnectorStatus).toHaveBeenCalledWith('test_bacnet', 'connected', null);
    });

    test('should poll and handle incoming messages', async () => {
        provider = new BacnetProvider(providerConfig, mockContext);
        await provider.connect();
        
        // Wait for at least one poll
        await new Promise(resolve => setTimeout(resolve, 250));
        
        expect(mockContext.handleMessage).toHaveBeenCalledWith(
            'test_bacnet', 'bms/room1/temp', expect.objectContaining({ value: 25.5 }), expect.anything()
        );
    });
});
