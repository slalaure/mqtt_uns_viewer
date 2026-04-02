/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the MQTT Provider.
 * Verifies connection handling, Sparkplug B payload decoding, and MQTT v5 property extraction.
 */

const MqttProvider = require('../connectors/mqtt/index');
const mqtt = require('mqtt');
const fs = require('fs');

// --- Mock Dependencies ---
jest.mock('mqtt', () => {
    const mockClient = {
        on: jest.fn().mockReturnThis(),
        subscribe: jest.fn((topics, opts, cb) => {
            if (cb) cb(null);
        }),
        publish: jest.fn((topic, payload, opts, cb) => {
            if (cb) cb(null);
        }),
        end: jest.fn()
    };
    return {
        connect: jest.fn(() => mockClient)
    };
});

jest.mock('sparkplug-payload', () => ({
    get: jest.fn(() => ({
        decodePayload: jest.fn((payload) => {
            if (payload === 'bad_buffer') throw new Error('Sparkplug decode error');
            return { metrics: [{ name: 'TestMetric', value: 100 }], seq: 1 };
        })
    }))
}));

jest.mock('fs');

// --- Helper for Mock Logger ---
const createMockLogger = () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockImplementation(() => createMockLogger())
});

describe('MqttProvider', () => {
    let mockContext;
    let providerConfig;

    beforeEach(() => {
        jest.clearAllMocks();

        mockContext = {
            logger: createMockLogger(),
            handleMessage: jest.fn(),
            updateBrokerStatus: jest.fn(),
            CERTS_PATH: '/mock/certs/path',
            config: {
                IS_SPARKPLUG_ENABLED: true
            },
            isShuttingDown: jest.fn().mockReturnValue(false)
        };

        providerConfig = {
            id: 'main_mqtt',
            type: 'mqtt',
            host: 'localhost',
            port: 1883,
            protocol: 'mqtt',
            subscribe: ['factory/#']
        };
        
        fs.readFileSync.mockReturnValue('mock_cert_data');
    });

    test('should connect successfully and subscribe to topics', async () => {
        const provider = new MqttProvider(providerConfig, mockContext);
        
        const connectPromise = provider.connect();
        
        // Retrieve the registered 'connect' event handler and trigger it
        const client = mqtt.connect.mock.results[0].value;
        const connectCall = client.on.mock.calls.find(call => call[0] === 'connect');
        expect(connectCall).toBeDefined();
        
        // Simulate successful connection
        connectCall[1]();
        
        const result = await connectPromise;
        
        expect(result).toBe(true);
        expect(provider.connected).toBe(true);
        expect(mqtt.connect).toHaveBeenCalled();
        expect(client.subscribe).toHaveBeenCalledWith(['factory/#'], { qos: 1 }, expect.any(Function));
        expect(mockContext.updateBrokerStatus).toHaveBeenCalledWith('main_mqtt', 'connected');
    });

    test('should process standard MQTT messages and forward to central handler', async () => {
        const provider = new MqttProvider(providerConfig, mockContext);
        await provider.connect();
        
        const client = mqtt.connect.mock.results[0].value;
        const messageCall = client.on.mock.calls.find(call => call[0] === 'message');
        const messageHandler = messageCall[1];

        // Simulate incoming standard message
        const topic = 'factory/line1/temp';
        const payload = Buffer.from('{"value": 25}');
        const packet = { properties: {} };

        messageHandler(topic, payload, packet);

        expect(mockContext.handleMessage).toHaveBeenCalledWith('main_mqtt', topic, payload, {
            isSparkplugOrigin: false,
            rawBuffer: payload,
            decodeError: null,
            correlationId: null
        });
    });

    test('should decode Sparkplug B messages when enabled', async () => {
        const provider = new MqttProvider(providerConfig, mockContext);
        await provider.connect();
        
        const client = mqtt.connect.mock.results[0].value;
        const messageCall = client.on.mock.calls.find(call => call[0] === 'message');
        const messageHandler = messageCall[1];

        const topic = 'spBv1.0/Group/DDATA/Node';
        const payload = Buffer.from('mock_spb_buffer');
        const packet = { properties: {} };

        messageHandler(topic, payload, packet);

        expect(mockContext.handleMessage).toHaveBeenCalledWith('main_mqtt', topic, { metrics: [{ name: 'TestMetric', value: 100 }], seq: 1 }, {
            isSparkplugOrigin: true,
            rawBuffer: payload,
            decodeError: null,
            correlationId: null
        });
    });

    test('should extract MQTT v5 Correlation ID from user properties', async () => {
        const provider = new MqttProvider(providerConfig, mockContext);
        await provider.connect();
        
        const client = mqtt.connect.mock.results[0].value;
        const messageHandler = client.on.mock.calls.find(call => call[0] === 'message')[1];

        const topic = 'factory/cmd/status';
        const payload = Buffer.from('OK');
        const packet = { 
            properties: { 
                userProperties: { correlationId: 'trace-12345' } 
            } 
        };

        messageHandler(topic, payload, packet);

        expect(mockContext.handleMessage).toHaveBeenCalledWith('main_mqtt', topic, payload, expect.objectContaining({
            correlationId: 'trace-12345'
        }));
    });

    test('should gracefully handle MTLS configuration and file reading', async () => {
        const mtlsConfig = {
            ...providerConfig,
            certFilename: 'cert.pem',
            keyFilename: 'key.pem',
            caFilename: 'ca.pem'
        };

        const provider = new MqttProvider(mtlsConfig, mockContext);
        
        // Prevent connect promise from hanging by auto-resolving the 'connect' event
        mqtt.connect.mockImplementationOnce(() => {
            const mockClient = {
                on: jest.fn((event, handler) => {
                    if (event === 'connect') setTimeout(handler, 10);
                    return mockClient;
                }),
                subscribe: jest.fn()
            };
            return mockClient;
        });

        const result = await provider.connect();
        
        expect(result).toBe(true);
        expect(fs.readFileSync).toHaveBeenCalledTimes(3);
        expect(provider.logger.info).toHaveBeenCalledWith(expect.stringContaining('MTLS'));
    });

    test('should fail safely if MTLS certificates are missing', async () => {
        const mtlsConfig = {
            ...providerConfig,
            certFilename: 'cert.pem',
            keyFilename: 'key.pem',
            caFilename: 'ca.pem'
        };

        fs.readFileSync.mockImplementation(() => { throw new Error('File not found'); });

        const provider = new MqttProvider(mtlsConfig, mockContext);
        const result = await provider.connect();

        expect(result).toBe(false);
        expect(provider.logger.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Could not read MTLS'));
        expect(mockContext.updateBrokerStatus).toHaveBeenCalledWith('main_mqtt', 'error', 'MTLS Certs missing');
    });
});