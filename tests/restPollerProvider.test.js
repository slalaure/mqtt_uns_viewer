/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the REST API Poller Provider.
 */
const RestPollerProvider = require('../connectors/rest-poller/index');
const axios = require('axios');

jest.spyOn(axios, 'get').mockResolvedValue({ data: { temperature: 22.5 } });

const createMockLogger = () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    child: jest.fn().mockImplementation(() => createMockLogger())
});

describe('RestPollerProvider', () => {
    let mockContext;

    beforeEach(() => {
        jest.clearAllMocks();
        mockContext = {
            logger: createMockLogger(),
            handleMessage: jest.fn(),
            updateConnectorStatus: jest.fn()
        };
    });

    test('should connect, poll, and forward data successfully', async () => {
        const config = {
            id: 'rest_test',
            type: 'rest',
            options: {
                endpoint: 'http://test.com/api',
                interval: 1000,
                auth: { type: 'bearer', token: 'mock_token' }
            }
        };

        const provider = new RestPollerProvider(config, mockContext);
        
        const res = await provider.connect();
        expect(res).toBe(true);
        
        await new Promise(resolve => setImmediate(resolve));
        
        expect(axios.get).toHaveBeenCalledWith('http://test.com/api', expect.objectContaining({
            headers: expect.objectContaining({ 'Authorization': 'Bearer mock_token' })
        }));
        
        expect(mockContext.handleMessage).toHaveBeenCalledWith(
            'rest_test',
            'rest/rest_test',
            { temperature: 22.5 },
            expect.objectContaining({ connectorType: 'rest' })
        );
        
        await provider.disconnect();
    });
});
