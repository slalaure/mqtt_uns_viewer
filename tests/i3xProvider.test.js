/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the I3X Provider.
 */

const { EventEmitter } = require('events');

jest.mock('axios', () => {
    const mockAxios = {
        get: jest.fn(),
        post: jest.fn(),
        put: jest.fn(),
        delete: jest.fn(),
        create: jest.fn(),
        defaults: { headers: {} }
    };
    mockAxios.create.mockReturnValue(mockAxios);
    return mockAxios;
});

const axios = require('axios');
const I3xProvider = require('../connectors/i3x/index');

const createMockLogger = () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockImplementation(() => createMockLogger())
});

describe('I3xProvider', () => {
    let mockContext;
    let providerConfig;
    let mockStream;

    beforeEach(() => {
        jest.clearAllMocks();

        mockStream = new EventEmitter();
        mockStream.destroy = jest.fn();
        axios.create.mockReturnValue(axios);

        mockContext = {
            logger: createMockLogger(),
            handleMessage: jest.fn(),
            updateConnectorStatus: jest.fn(),
            isShuttingDown: jest.fn().mockReturnValue(false)
        };

        providerConfig = {
            id: 'test_i3x',
            type: 'i3x',
            baseUrl: 'http://remote-i3x:8080/api/i3x',
            subscribe: ['Pump-001'],
            autoDiscover: false
        };
    });

    test('should connect and setup subscription successfully', async () => {
        axios.get.mockResolvedValueOnce({ data: [] }); // /namespaces
        axios.post.mockResolvedValueOnce({ data: { subscriptionId: 'sub-123' } }); // /subscriptions
        axios.post.mockResolvedValueOnce({ data: { success: true } }); // /register
        
        // Mock the stream request
        axios.get.mockResolvedValueOnce({ data: mockStream }); // /stream

        const provider = new I3xProvider(providerConfig, mockContext);
        const result = await provider.connect();

        expect(result).toBe(true);
        expect(provider.connected).toBe(true);
        expect(provider.subscriptionId).toBe('sub-123');
        expect(axios.post).toHaveBeenCalledWith('/subscriptions', {});
        expect(axios.post).toHaveBeenCalledWith('/subscriptions/sub-123/register', expect.anything());
    });

    test('should handle incoming SSE data and forward it', async () => {
        axios.get.mockResolvedValueOnce({ data: [] });
        axios.post.mockResolvedValueOnce({ data: { subscriptionId: 'sub-123' } });
        axios.post.mockResolvedValueOnce({ data: { success: true } });
        axios.get.mockResolvedValueOnce({ data: mockStream });

        const provider = new I3xProvider(providerConfig, mockContext);
        await provider.connect();

        // Simulate incoming SSE message
        const mockI3xPayload = {
            elementId: 'Pump-001',
            value: { value: 123.4, quality: 'Good', timestamp: '2025-01-01T10:00:00Z' }
        };
        
        const sseMessage = `data: ${JSON.stringify(mockI3xPayload)}\n\n`;
        mockStream.emit('data', Buffer.from(sseMessage));

        expect(mockContext.handleMessage).toHaveBeenCalledWith('test_i3x', 'Pump-001', mockI3xPayload.value, { connectorType: 'i3x' });
    });

    test('should disconnect and delete subscription', async () => {
        axios.get.mockResolvedValueOnce({ data: [] });
        axios.post.mockResolvedValueOnce({ data: { subscriptionId: 'sub-123' } });
        axios.post.mockResolvedValueOnce({ data: { success: true } });
        axios.get.mockResolvedValueOnce({ data: mockStream });
        axios.delete.mockResolvedValueOnce({ data: { success: true } });

        const provider = new I3xProvider(providerConfig, mockContext);
        await provider.connect();
        await provider.disconnect();

        expect(provider.connected).toBe(false);
        expect(axios.delete).toHaveBeenCalledWith('/subscriptions/sub-123');
    });

    test('should handle connection errors gracefully', async () => {
        axios.get.mockRejectedValueOnce(new Error('Network Error'));

        const provider = new I3xProvider(providerConfig, mockContext);
        const result = await provider.connect();

        expect(result).toBe(false);
        expect(provider.connected).toBe(false);
        expect(mockContext.updateConnectorStatus).toHaveBeenCalledWith('test_i3x', 'error', 'Network Error');
    });

    test('should publish data using PUT /value', async () => {
        axios.get.mockResolvedValueOnce({ data: [] });
        axios.post.mockResolvedValueOnce({ data: { subscriptionId: 'sub-123' } });
        axios.post.mockResolvedValueOnce({ data: { success: true } });
        axios.get.mockResolvedValueOnce({ data: mockStream });

        const provider = new I3xProvider(providerConfig, mockContext);
        await provider.connect();

        axios.put.mockResolvedValueOnce({ data: { success: true } });
        
        const callback = jest.fn();
        await provider.publish('Pump-001', { value: 99.9 }, {}, callback);

        expect(axios.put).toHaveBeenCalledWith('/objects/Pump-001/value', { value: 99.9 });
        expect(callback).toHaveBeenCalledWith(null);
    });
});