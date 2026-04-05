/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the File Provider (CSV/JSONL streaming).
 * Verifies file parsing, dynamic topic routing, stream looping (recovery logic), and error handling.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const FileProvider = require('../connectors/file/index');

const createMockLogger = () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockImplementation(() => createMockLogger())
});

describe('FileProvider', () => {
    let tempCsvPath;
    let mockContext;
    let providerConfig;

    beforeAll(() => {
        // Create a real temporary CSV file to test the actual stream logic without fragile mocks
        tempCsvPath = path.join(os.tmpdir(), `test_data_${Date.now()}.csv`);
        const csvContent = `topic,temperature,pressure,status
uns/line1/temp,22.5,1.2,running
uns/line1/temp,23.1,1.3,running
uns/line2/temp,19.8,1.1,idle`;
        fs.writeFileSync(tempCsvPath, csvContent, 'utf8');
    });

    afterAll(async () => {
        // Wait for any lingering async stream close operations
        await new Promise(resolve => setTimeout(resolve, 100));
        if (fs.existsSync(tempCsvPath)) {
            fs.unlinkSync(tempCsvPath);
        }
    });

    let providers = [];

    beforeEach(() => {
        providers = [];
        mockContext = {
            logger: createMockLogger(),
            handleMessage: jest.fn(),
            updateConnectorStatus: jest.fn()
        };

        providerConfig = {
            id: 'test_csv_stream',
            type: 'file',
            filePath: tempCsvPath,
            streamRateMs: 50, // Fast rate for testing with real timers
            defaultTopic: 'fallback/topic',
            loop: false // We test looping explicitly later
        };
    });

    afterEach(async () => {
        for (const provider of providers) {
            await provider.disconnect();
        }
    });

    test('should fail to connect if file does not exist', async () => {
        const badConfig = { ...providerConfig, filePath: '/path/does/not/exist.csv' };
        const provider = new FileProvider(badConfig, mockContext);
        providers.push(provider);

        const result = await provider.connect();

        expect(result).toBe(false);
        expect(provider.connected).toBe(false);
        expect(mockContext.updateConnectorStatus).toHaveBeenCalledWith('test_csv_stream', 'error', 'File not found');
    });

    test('should read CSV, extract headers, and dynamically route based on the topic column', async () => {
        const provider = new FileProvider(providerConfig, mockContext);
        providers.push(provider);
        const result = await provider.connect();

        expect(result).toBe(true);
        expect(provider.connected).toBe(true);

        // Wait for real stream to read the 3 lines (rate is 50ms)
        await new Promise(resolve => setTimeout(resolve, 300));

        // Verify that handleIncomingMessage was called with dynamic topics and correct type casting
        expect(mockContext.handleMessage).toHaveBeenCalledWith('test_csv_stream', 'uns/line1/temp', {
            temperature: 22.5, // Parsed as float
            pressure: 1.2,
            status: 'running'  // Kept as string
        }, { connectorType: 'file' });

        expect(mockContext.handleMessage).toHaveBeenCalledWith('test_csv_stream', 'uns/line1/temp', {
            temperature: 23.1,
            pressure: 1.3,
            status: 'running'
        }, { connectorType: 'file' });
    });

    test('should gracefully loop file stream when EOF is reached if loop is true', async () => {
        const loopingConfig = { ...providerConfig, loop: true, streamRateMs: 50 };
        const provider = new FileProvider(loopingConfig, mockContext);
        providers.push(provider);
        await provider.connect();

        // Wait enough time to finish the 3 lines and loop at least once
        await new Promise(resolve => setTimeout(resolve, 400));

        expect(provider.logger.info).toHaveBeenCalledWith(expect.stringContaining('End of file reached'));
        expect(provider.logger.info).toHaveBeenCalledWith(expect.stringContaining('Restarting file stream'));
    });

    test('publish method should loopback message to internal engine', () => {
        const provider = new FileProvider(providerConfig, mockContext);
        providers.push(provider);
        
        const testPayload = { cmd: "restart", auth: "admin" };
        
        // Simulate an outbound publish (which the file provider intercepts and loops back)
        provider.publish('internal/loopback/cmd', JSON.stringify(testPayload), {}, (err) => {
            expect(err).toBeNull();
        });

        expect(mockContext.handleMessage).toHaveBeenCalledWith(
            'test_csv_stream',
            'internal/loopback/cmd', 
            testPayload, 
            { connectorType: 'file' }
        );
        expect(provider.logger.info).toHaveBeenCalledWith(expect.stringContaining('routing publish back to stream'));
    });
});