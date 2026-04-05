/**
 * @license Apache License, Version 2.0
 */

const InfluxDbRepository = require('../storage/influxDbRepository')._instance ? require('../storage/influxDbRepository')._instance.constructor : require('../storage/influxDbRepository');
const influxDbRepo = require('../storage/influxDbRepository');
const axios = require('axios');

const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis()
};

const mockDlqManager = {
    push: jest.fn()
};

describe('InfluxDbRepository', () => {
    let repo;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(axios, 'get').mockImplementation(() => Promise.resolve({}));
        jest.spyOn(axios, 'post').mockImplementation(() => Promise.resolve({}));
        
        // Reset singleton
        influxDbRepo.close();
        
        const config = {
            INFLUX_URL: 'http://localhost:8086',
            INFLUX_TOKEN: 'my-token',
            INFLUX_ORG: 'my-org',
            INFLUX_BUCKET: 'my-bucket',
            INFLUX_MEASUREMENT: 'iot_test',
            INFLUX_BATCH_SIZE: 2,
            INFLUX_BATCH_INTERVAL_MS: 1000
        };

        influxDbRepo.init(mockLogger, config, mockDlqManager);
        
        // To directly test methods, we can grab the internal instance
        repo = influxDbRepo._instance;
        
        // By default assume connected for processing tests
        repo.isConnected = true; 
    });
    
    afterEach(() => {
        influxDbRepo.stop();
    });

    test('should connect successfully if health check passes', async () => {
        axios.get.mockResolvedValue({ status: 200 });
        await repo.init();
        expect(repo.isConnected).toBe(true);
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Successfully connected to InfluxDB'));
    });

    test('should fail connection if health check fails but continue with DLQ', async () => {
        axios.get.mockRejectedValue(new Error('Network Error'));
        await repo.init();
        expect(repo.isConnected).toBe(false);
        expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ err: 'Network Error' }), expect.any(String));
        
        // Test that processQueue redirects to DLQ when disconnected
        repo.push({ topic: 'test', payloadStringForDb: '{"v":1}' });
        await repo.processQueue();
        expect(mockDlqManager.push).toHaveBeenCalled();
    });

    test('should correctly format Line Protocol string', () => {
        const mockTime = new Date('2026-04-05T10:00:00.000Z').getTime();
        const msg = {
            sourceId: 'broker A', // test spaces
            topic: 'sensors/temp,1', // test commas
            payloadStringForDb: '{"temp": 23.5, "unit": "C"}', // test quotes
            timestamp: mockTime,
            connectorType: 'mqtt'
        };

        const lp = repo.convertToLineProtocol(msg);
        
        // spaces -> \ , commas -> \, , equals -> \=
        expect(lp).toContain('source_id=broker\\ A');
        expect(lp).toContain('topic=sensors/temp\\,1');
        expect(lp).toContain('connector_type=mqtt');
        
        // measurement name
        expect(lp.startsWith('iot_test,')).toBe(true);
        
        // payload should have escaped double quotes inside double quotes
        expect(lp).toContain('payload="{\\"temp\\": 23.5, \\"unit\\": \\"C\\"}"');
        
        // Check timestamp at the end
        expect(lp.endsWith(` ${mockTime}`)).toBe(true);
    });

    test('should send batch via POST and clear queue', async () => {
        axios.post.mockResolvedValue({ status: 204 });

        repo.push({ sourceId: 'src1', topic: 't1', payloadStringForDb: '{}', timestamp: 1000, connectorType: 'mqtt' });
        repo.push({ sourceId: 'src2', topic: 't2', payloadStringForDb: '{}', timestamp: 2000, connectorType: 'mqtt' });
        repo.push({ sourceId: 'src3', topic: 't3', payloadStringForDb: '{}', timestamp: 3000, connectorType: 'mqtt' }); // Should stay in queue (batchSize=2)

        expect(repo.writeQueue.length).toBe(3);

        await repo.processQueue();

        expect(axios.post).toHaveBeenCalled();
        
        const postArgs = axios.post.mock.calls[0];
        expect(postArgs[0]).toContain('precision=ms'); // Check URL
        expect(postArgs[1].split('\n').length).toBe(2); // Check body lines
        
        // 1 item should remain due to batch size
        expect(repo.writeQueue.length).toBe(1);
    });

    test('should push to DLQ on POST failure', async () => {
        axios.post.mockRejectedValue(new Error('Write timeout'));

        repo.push({ topic: 't1', payloadStringForDb: '{}' });
        await repo.processQueue();

        expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ err: 'Write timeout' }), expect.any(String));
        expect(mockDlqManager.push).toHaveBeenCalled();
    });
});
