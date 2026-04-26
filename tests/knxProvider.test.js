/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the KNX/IP Provider.
 */

jest.mock('knx', () => {
    return {
        Connection: jest.fn().mockImplementation((opts) => {
            // Store handlers to trigger them in tests
            const mock = {
                Disconnect: jest.fn(),
                write: jest.fn(),
                on: jest.fn(),
                _opts: opts
            };
            // Simulate async connection
            setTimeout(() => opts.handlers.connected(), 10);
            return mock;
        })
    };
});

const KnxProvider = require('../connectors/knx/index');
const knx = require('knx');

const createMockLogger = () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    child: jest.fn().mockImplementation(() => createMockLogger())
});

describe('KnxProvider', () => {
    let mockContext;
    let providerConfig;

    beforeEach(() => {
        jest.clearAllMocks();
        mockContext = {
            logger: createMockLogger(),
            handleMessage: jest.fn(),
            updateConnectorStatus: jest.fn()
        };
        providerConfig = {
            id: 'test_knx',
            type: 'knx',
            host: '127.0.0.1',
            subscribe: [
                '1/1/1:DPT1.001::bms/light'
            ]
        };
    });

    test('should connect and handle incoming events', async () => {
        const provider = new KnxProvider(providerConfig, mockContext);
        const result = await provider.connect();
        
        expect(result).toBe(true);
        expect(provider.connected).toBe(true);
        
        // Simulate event from bus
        const handlers = knx.Connection.mock.calls[0][0].handlers;
        handlers.event('GroupValue_Write', '1.1.1', '1/1/1', 1);

        expect(mockContext.handleMessage).toHaveBeenCalledWith(
            'test_knx', 'bms/light', expect.objectContaining({ value: 1 }), expect.anything()
        );
    });

    test('should publish values to KNX bus', async () => {
        const provider = new KnxProvider(providerConfig, mockContext);
        await provider.connect();
        
        provider.publish('bms/light', true, {}, (err) => {
            expect(err).toBeFalsy();
            expect(provider.connection.write).toHaveBeenCalledWith('1/1/1', true, 'DPT1.001');
        });
    });
});
