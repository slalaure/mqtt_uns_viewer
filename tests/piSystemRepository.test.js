/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the AVEVA PI System Repository.
 * Verifies PI Web API connection, StreamSets payload formatting, and DLQ fallback.
 */

// Mock Axios
jest.mock('axios', () => {
    return {
        create: jest.fn()
    };
});
const piSystemRepo = require('../storage/piSystemRepository');
const axios = require('axios');

const createMockLogger = () => {
    const logger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    };
    logger.child = jest.fn().mockReturnValue(logger);
    return logger;
};

describe('PiSystemRepository', () => {
    let mockLogger, mockConfig, mockDlqManager;
    let mockAxiosInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();

        mockLogger = createMockLogger();
        mockConfig = {
            PI_WEB_API_URL: 'https://piserver.local/piwebapi',
            PI_DATA_ARCHIVE: 'HISTORIAN_01',
            PI_USERNAME: 'piadmin',
            PI_PASSWORD: 'securepassword',
            PI_INSERT_BATCH_SIZE: 1000
        };
        mockDlqManager = { push: jest.fn() };

        // Setup Axios Mock
        mockAxiosInstance = {
            get: jest.fn().mockResolvedValue({ status: 200 }),
            post: jest.fn().mockResolvedValue({ status: 202 }) // PI Web API often returns 202 Accepted
        };
        axios.create.mockReturnValue(mockAxiosInstance);

        // Reset internal state
        piSystemRepo.writeQueue = [];
        piSystemRepo.isConnected = false;
        piSystemRepo.isConnecting = false;
        piSystemRepo.axiosInstance = null;
        if (piSystemRepo.batchTimer) {
            clearInterval(piSystemRepo.batchTimer);
            piSystemRepo.batchTimer = null;
        }
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should initialize, configure axios, and connect successfully', async () => {
        await piSystemRepo.init(mockLogger, mockConfig, mockDlqManager);
        
        expect(axios.create).toHaveBeenCalledWith(expect.objectContaining({
            baseURL: 'https://piserver.local/piwebapi',
            auth: { username: 'piadmin', password: 'securepassword' }
        }));
        expect(mockAxiosInstance.get).toHaveBeenCalledWith('/system/info');
        expect(piSystemRepo.isConnected).toBe(true);
    });

    test('should fail connection gracefully on network error', async () => {
        mockAxiosInstance.get.mockRejectedValueOnce(new Error("Network Error"));
        
        await piSystemRepo.init(mockLogger, mockConfig, mockDlqManager);
        
        expect(piSystemRepo.isConnected).toBe(false);
        expect(mockLogger.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("Failed to connect"));
    });

    test('parseValueForPi should correctly extract numeric values or fallback to strings', () => {
        // Standard Korelate JSON format
        expect(piSystemRepo.parseValueForPi('{"value": 42.5}')).toBe(42.5);
        expect(piSystemRepo.parseValueForPi('{"val": 100}')).toBe(100);
        
        // Non-standard JSON
        expect(piSystemRepo.parseValueForPi('{"status": "running"}')).toBe('{"status": "running"}');
        
        // Raw strings / numbers
        expect(piSystemRepo.parseValueForPi('25.4')).toBe(25.4);
        expect(piSystemRepo.parseValueForPi('FAULT')).toBe('FAULT');
    });

    test('should format batch into StreamSets payload and post to PI Web API', async () => {
        await piSystemRepo.init(mockLogger, mockConfig, mockDlqManager);
        
        const timestamp1 = new Date('2025-01-01T10:00:00Z');
        const timestamp2 = new Date('2025-01-01T10:00:05Z');

        piSystemRepo.push({
            topic: 'factory/line1/temp',
            payloadStringForDb: '{"value": 25.5}',
            timestamp: timestamp1
        });
        
        piSystemRepo.push({
            topic: 'factory/line1/temp',
            payloadStringForDb: '{"value": 26.0}',
            timestamp: timestamp2
        });

        piSystemRepo.push({
            topic: 'factory/line2/status',
            payloadStringForDb: 'RUNNING',
            timestamp: timestamp1
        });

        await piSystemRepo.processQueue();

        expect(mockAxiosInstance.post).toHaveBeenCalledTimes(1);
        
        // Validate StreamSets formatting
        const postUrl = mockAxiosInstance.post.mock.calls[0][0];
        const postPayload = mockAxiosInstance.post.mock.calls[0][1];
        
        expect(postUrl).toBe('/streamsets/recorded');
        expect(postPayload).toHaveLength(2); // Two unique topics

        // Find the temp stream in the payload
        const tempStream = postPayload.find(p => p.WebId === '?path=pi:\\\\HISTORIAN_01\\factory.line1.temp');
        expect(tempStream).toBeDefined();
        expect(tempStream.Items).toHaveLength(2);
        expect(tempStream.Items[0].Value).toBe(25.5);
        expect(tempStream.Items[1].Value).toBe(26.0);

        // Find the status stream
        const statusStream = postPayload.find(p => p.WebId === '?path=pi:\\\\HISTORIAN_01\\factory.line2.status');
        expect(statusStream).toBeDefined();
        expect(statusStream.Items).toHaveLength(1);
        expect(statusStream.Items[0].Value).toBe('RUNNING');
        
        expect(piSystemRepo.writeQueue.length).toBe(0);
    });

    test('should route failed batches to DLQ', async () => {
        await piSystemRepo.init(mockLogger, mockConfig, mockDlqManager);
        
        // Mock a server error during post
        mockAxiosInstance.post.mockRejectedValueOnce(new Error("500 Internal Server Error"));

        piSystemRepo.push({
            topic: 'test/topic',
            payloadStringForDb: '123',
            timestamp: new Date()
        });

        await piSystemRepo.processQueue();

        expect(mockLogger.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("PI System batch insert failed"));
        expect(mockDlqManager.push).toHaveBeenCalledTimes(1);
        expect(mockDlqManager.push.mock.calls[0][0]).toHaveLength(1);
        
        // Ensure connection state is marked false to trigger reconnect on next cycle
        expect(piSystemRepo.isConnected).toBe(false);
    });

    test('should flush to DLQ when MAX_QUEUE_SIZE is exceeded', () => {
        piSystemRepo.dlqManager = mockDlqManager;
        piSystemRepo.logger = mockLogger;

        for (let i = 0; i < 20010; i++) {
            piSystemRepo.push({ topic: 'test', payloadStringForDb: '0', timestamp: new Date() });
        }

        // 5000 oldest messages should be flushed to DLQ
        expect(mockDlqManager.push).toHaveBeenCalledTimes(1);
        expect(mockDlqManager.push.mock.calls[0][0]).toHaveLength(5000);
        expect(piSystemRepo.writeQueue.length).toBe(15010);
    });
});