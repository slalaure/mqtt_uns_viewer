/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the EtherNet/IP (CIP) Provider.
 */

jest.mock('ethernet-ip', () => {
    return {
        Controller: jest.fn().mockImplementation(() => ({
            connect: jest.fn().mockResolvedValue(true),
            readTag: jest.fn().mockImplementation((tag) => {
                tag.value = 99.9;
                return Promise.resolve();
            }),
            writeTag: jest.fn().mockResolvedValue(true),
            disconnect: jest.fn().mockResolvedValue(true)
        })),
        Tag: jest.fn().mockImplementation((name) => ({
            name: name,
            value: null
        }))
    };
});

const EipProvider = require('../connectors/eip/index');
const ENIP = require('ethernet-ip');

const createMockLogger = () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    child: jest.fn().mockImplementation(() => createMockLogger())
});

describe('EipProvider', () => {
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
            id: 'test_eip',
            type: 'eip',
            host: '127.0.0.1',
            pollingInterval: 100,
            subscribe: [
                'TankLevel::factory/tank1'
            ]
        };
    });

    afterEach(async () => {
        if (provider) await provider.disconnect();
    });

    test('should connect and start polling', async () => {
        provider = new EipProvider(providerConfig, mockContext);
        const result = await provider.connect();
        
        expect(result).toBe(true);
        expect(provider.connected).toBe(true);
        
        await new Promise(resolve => setTimeout(resolve, 250));

        expect(mockContext.handleMessage).toHaveBeenCalledWith(
            'test_eip', 'factory/tank1', expect.objectContaining({ value: 99.9 }), expect.anything()
        );
    });
});
