/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the SNMP Poller Provider.
 */
const SnmpProvider = require('../connectors/snmp/index');

jest.mock('net-snmp', () => {
    return {
        createSession: jest.fn(() => ({
            get: jest.fn((oids, cb) => {
                cb(null, [
                    { oid: '1.3.6.1', value: Buffer.from('SNMP_Response') }
                ]);
            }),
            close: jest.fn()
        })),
        isVarbindError: jest.fn().mockReturnValue(false)
    };
}, { virtual: true });

const createMockLogger = () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    child: jest.fn().mockImplementation(() => createMockLogger())
});

describe('SnmpProvider', () => {
    let mockContext;

    beforeEach(() => {
        jest.clearAllMocks();
        mockContext = {
            logger: createMockLogger(),
            handleMessage: jest.fn(),
            updateConnectorStatus: jest.fn()
        };
    });

    test('should connect and poll OIDs successfully', async () => {
        const config = {
            id: 'snmp_test',
            type: 'snmp',
            options: {
                target: '127.0.0.1',
                oids: ['1.3.6.1'],
                interval: 1000
            }
        };

        const provider = new SnmpProvider(config, mockContext);
        
        const res = await provider.connect();
        expect(res).toBe(true);
        
        await new Promise(resolve => setImmediate(resolve));
        
        expect(mockContext.handleMessage).toHaveBeenCalledWith(
            'snmp_test',
            'snmp/snmp_test',
            { '1.3.6.1': 'SNMP_Response' },
            expect.objectContaining({ connectorType: 'snmp' })
        );
        
        await provider.disconnect();
    });
});
