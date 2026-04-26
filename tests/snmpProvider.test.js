/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the SNMP Poller Provider.
 */

jest.mock('net-snmp', () => {
    return {
        createSession: jest.fn(() => ({
            get: jest.fn((oids, cb) => {
                cb(null, [{ value: Buffer.from("Mock SNMP Response"), oid: oids[0] }]);
            }),
            close: jest.fn(),
            on: jest.fn()
        })),
        isVarbindError: jest.fn().mockReturnValue(false),
        Version1: 0,
        Version2c: 1
    };
});

const SnmpProvider = require('../connectors/snmp/index');
const snmp = require('net-snmp');

const createMockLogger = () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    child: jest.fn().mockImplementation(() => createMockLogger())
});

describe('SnmpProvider', () => {
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
            id: 'test_snmp',
            type: 'snmp',
            options: {
                target: '127.0.0.1',
                community: 'public',
                interval: 100,
                oids: ['1.3.6.1.2.1.1.1.0'],
                topic: 'system/descr'
            }
        };
    });

    afterEach(async () => {
        if (provider) await provider.disconnect();
    });

    test('should connect and poll successfully', async () => {
        provider = new SnmpProvider(providerConfig, mockContext);
        const result = await provider.connect();
        
        expect(result).toBe(true);
        expect(provider.connected).toBe(true);
        
        await new Promise(resolve => setTimeout(resolve, 250));

        expect(mockContext.handleMessage).toHaveBeenCalledWith(
            'test_snmp', 'system/descr', expect.objectContaining({ '1.3.6.1.2.1.1.1.0': "Mock SNMP Response" }), expect.anything()
        );
    });
});
