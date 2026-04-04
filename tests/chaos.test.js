/**
 * @license Apache License, Version 2.0 (the "License")
 * @author Sebastien Lalaurette
 * 
 * Chaos & Load Testing
 * Verifies DLQ spilling for DuckDB and backpressure mechanisms for WebSockets.
 */

const duckDbRepo = require('../storage/duckdbRepository');
const wsManager = require('../core/websocketManager');

const createMockLogger = () => {
    const logger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    };
    logger.child = jest.fn().mockImplementation(() => logger);
    return logger;
};

describe('Chaos & Load Testing', () => {
    
    describe('DuckDB Repository Satiation (DLQ Spill)', () => {
        let mockDb, mockLogger, mockConfig, mockDlqManager;

        beforeEach(() => {
            jest.clearAllMocks();
            mockLogger = createMockLogger();
            mockConfig = {
                DB_INSERT_BATCH_SIZE: 10,
                DB_BATCH_INTERVAL_MS: 100
            };
            mockDb = {
                serialize: jest.fn(),
                run: jest.fn(),
                prepare: jest.fn(),
                close: jest.fn(cb => cb())
            };
            
            mockDlqManager = {
                push: jest.fn(),
                init: jest.fn()
            };

            // Re-init with small batch to speed up tests
            duckDbRepo.init(mockLogger, mockConfig, mockDb, jest.fn(), {}, mockDlqManager);
            // Manually clear the write queue inherited from Singleton
            duckDbRepo.writeQueue = [];
        });

        afterEach(() => {
            duckDbRepo.stop(); // Clear intervals
        });

        test('should spill oldest messages to DLQ when queue exceeds MAX_QUEUE_SIZE', () => {
            const MAX_QUEUE_SIZE = 20000;
            const FLUSH_CHUNK_SIZE = 5000;

            // Fill queue up to the limit
            for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
                duckDbRepo.push({ topic: 'test', payloadStringForDb: '{}', timestamp: new Date() });
            }

            expect(duckDbRepo.getQueueSize()).toBe(MAX_QUEUE_SIZE);
            expect(mockDlqManager.push).not.toHaveBeenCalled();

            // Push one more message to trigger spill
            duckDbRepo.push({ topic: 'spill_trigger', payloadStringForDb: '{}', timestamp: new Date() });

            // Expect spill of FLUSH_CHUNK_SIZE
            // New queue size should be (MAX_QUEUE_SIZE - FLUSH_CHUNK_SIZE + 1)
            expect(duckDbRepo.getQueueSize()).toBe(MAX_QUEUE_SIZE - FLUSH_CHUNK_SIZE + 1);
            
            expect(mockDlqManager.push).toHaveBeenCalledWith(
                expect.arrayContaining([expect.objectContaining({ topic: 'test' })]),
                'DuckDBRepo'
            );
        });
    });

    describe('WebSocket Backpressure (Message Dropping)', () => {
        let mockServer, mockLogger, mockDb;

        beforeEach(() => {
            jest.clearAllMocks();
            mockServer = { on: jest.fn() };
            mockLogger = createMockLogger();
            mockDb = { all: jest.fn() };

            wsManager.initWebSocketManager(mockServer, mockDb, mockLogger, '/', jest.fn(), (k,v)=>v, jest.fn());
            wsManager.resetDroppedMessagesCount();
        });

        afterEach(() => {
            // Force close without waiting for callback to avoid timeouts in tests
            const wss = wsManager.getWss();
            if (wss) wss.close();
        });

        test('should drop messages if client buffer exceeds MAX_WS_BUFFER_BYTES', () => {
            const metrics = wsManager.getBackpressureMetrics();
            const MAX_WS_BUFFER_BYTES = metrics.maxBufferBytes;
            
            // Mock a "saturated" client
            const mockWs = {
                OPEN: 1,
                readyState: 1, // OPEN
                bufferedAmount: MAX_WS_BUFFER_BYTES + 1024,
                send: jest.fn(),
                on: jest.fn(),
                terminate: jest.fn()
            };

            // Inject the mock client into the underlying server
            const wss = wsManager.getWss();
            wss.clients.add(mockWs);

            // Broadcast a message
            wsManager.broadcast(JSON.stringify({ type: 'test' }));

            // Should NOT have sent the message to the saturated client
            expect(mockWs.send).not.toHaveBeenCalled();

            // Should have incremented the dropped count
            const updatedMetrics = wsManager.getBackpressureMetrics();
            expect(updatedMetrics.droppedMessagesCount).toBe(1);

            // Clean up
            wss.clients.delete(mockWs);
        });

        test('should send messages if client buffer is within limits', () => {
            const metrics = wsManager.getBackpressureMetrics();
            
            // Mock a "healthy" client
            const mockWs = {
                OPEN: 1,
                readyState: 1, // OPEN
                bufferedAmount: 1024, // 1KB (Well below 5MB)
                send: jest.fn(),
                on: jest.fn(),
                terminate: jest.fn()
            };

            const wss = wsManager.getWss();
            wss.clients.add(mockWs);

            wsManager.broadcast(JSON.stringify({ type: 'healthy_test' }));

            // Should have sent the message
            expect(mockWs.send).toHaveBeenCalled();

            // Should NOT have incremented the dropped count
            const updatedMetrics = wsManager.getBackpressureMetrics();
            expect(updatedMetrics.droppedMessagesCount).toBe(0);

            wss.clients.delete(mockWs);
        });
    });
});
