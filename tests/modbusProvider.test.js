/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the Modbus TCP Provider.
 */

jest.mock('modbus-serial', () => {
    return jest.fn().mockImplementation(() => ({
        connectTCP: jest.fn().mockResolvedValue(true),
        setID: jest.fn(),
        setTimeout: jest.fn(),
        readHoldingRegisters: jest.fn().mockResolvedValue({ data: [42] }),
        readInputRegisters: jest.fn().mockResolvedValue({ data: [100] }),
        readCoils: jest.fn().mockResolvedValue({ data: [true] }),
        readDiscreteInputs: jest.fn().mockResolvedValue({ data: [false] }),
        writeRegister: jest.fn().mockResolvedValue(true),
        writeCoil: jest.fn().mockResolvedValue(true),
        close: jest.fn()
    }));
});

const ModbusProvider = require('../connectors/modbus/index');
const ModbusRTU = require('modbus-serial');

const createMockLogger = () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    child: jest.fn().mockImplementation(() => createMockLogger())
});

describe('ModbusProvider', () => {
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
            id: 'test_modbus',
            type: 'modbus',
            host: '127.0.0.1',
            port: 5020,
            unitId: 1,
            pollingInterval: 100, // Short for test
            subscribe: [
                '40001:1::factory/temp',
                '00001:1::factory/coil'
            ]
        };
    });

    afterEach(async () => {
        if (provider) await provider.disconnect();
    });

    test('should connect and parse mappings correctly', async () => {
        provider = new ModbusProvider(providerConfig, mockContext);
        const result = await provider.connect();
        
        expect(result).toBe(true);
        expect(provider.connected).toBe(true);
        expect(provider.mappings.length).toBe(2);
        expect(provider.mappings[0]).toEqual({
            address: 40001, length: 1, topic: 'factory/temp', type: 'holding'
        });
        expect(mockContext.updateConnectorStatus).toHaveBeenCalledWith('test_modbus', 'connected', null);
    });

    test('should poll and handle incoming messages', async () => {
        provider = new ModbusProvider(providerConfig, mockContext);
        await provider.connect();
        
        // Wait for at least one poll
        await new Promise(resolve => setTimeout(resolve, 250));
        
        expect(mockContext.handleMessage).toHaveBeenCalledWith(
            'test_modbus', 'factory/temp', expect.objectContaining({ value: 42 }), expect.anything()
        );
        expect(mockContext.handleMessage).toHaveBeenCalledWith(
            'test_modbus', 'factory/coil', expect.objectContaining({ value: true }), expect.anything()
        );
    });

    test('should publish values to Modbus registers', (done) => {
        provider = new ModbusProvider(providerConfig, mockContext);
        provider.connect().then(() => {
            provider.publish('factory/temp', 45, {}, (err) => {
                expect(err).toBeNull();
                expect(provider.client.writeRegister).toHaveBeenCalledWith(1, 45);
                done();
            });
        });
    });
});
