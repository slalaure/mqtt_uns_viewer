/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the Siemens S7 Provider.
 */

jest.mock('nodes7', () => {
    return jest.fn().mockImplementation(() => ({
        initiateConnection: jest.fn((opts, cb) => setTimeout(() => cb(null), 10)),
        setTranslationCB: jest.fn(),
        addItems: jest.fn(),
        readAllItems: jest.fn((cb) => cb(null, { 'DB1,REAL4': 123.45 })),
        writeItems: jest.fn((tag, val, cb) => cb(null)),
        dropConnection: jest.fn((cb) => cb()),
        on: jest.fn()
    }));
});

const S7Provider = require('../connectors/s7/index');
const nodes7 = require('nodes7');

const createMockLogger = () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    child: jest.fn().mockImplementation(() => createMockLogger())
});

describe('S7Provider', () => {
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
            id: 'test_s7',
            type: 's7',
            host: '127.0.0.1',
            pollingInterval: 100,
            subscribe: [
                'DB1,REAL4::factory/pressure'
            ]
        };
    });

    afterEach(async () => {
        if (provider) await provider.disconnect();
    });

    test('should connect and start polling', async () => {
        provider = new S7Provider(providerConfig, mockContext);
        const result = await provider.connect();
        
        expect(result).toBe(true);
        expect(provider.connected).toBe(true);
        
        await new Promise(resolve => setTimeout(resolve, 250));
        
        expect(mockContext.handleMessage).toHaveBeenCalledWith(
            'test_s7', 'factory/pressure', expect.objectContaining({ value: 123.45 }), expect.anything()
        );
    });
});
