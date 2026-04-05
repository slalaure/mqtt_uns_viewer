/**
 * @license Apache License, Version 2.0 (the "License")
 * @author Sebastien Lalaurette
 * * Unit tests for Error Utilities
 */

jest.mock('../core/metricsManager', () => ({
    incrementError: jest.fn()
}));

const { logError } = require('../core/errorUtils');
const metricsManager = require('../core/metricsManager');

describe('ErrorUtils', () => {
    let mockLogger;

    beforeEach(() => {
        jest.clearAllMocks();
        mockLogger = {
            error: jest.fn()
        };
        // Mock console.error for fallback tests
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        console.error.mockRestore();
    });

    test('should log error with provided code and traceId', () => {
        const error = new Error('Test DB Error');
        
        logError({
            logger: mockLogger,
            err: error,
            code: 'DB_CONNECTION_FAILED',
            traceId: 'trace-123',
            message: 'Failed to connect to primary DB'
        });

        expect(metricsManager.incrementError).toHaveBeenCalledWith('DB_CONNECTION_FAILED');
        expect(mockLogger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                err: expect.objectContaining({
                    code: 'DB_CONNECTION_FAILED',
                    traceId: 'trace-123',
                    message: 'Failed to connect to primary DB',
                    stack: expect.any(String)
                })
            }),
            'Failed to connect to primary DB'
        );
    });

    test('should fallback to console.error if logger is missing', () => {
        const error = new Error('Silent error');

        logError({
            err: error,
            code: 'SILENT_ERROR',
            message: 'No logger available'
        });

        expect(metricsManager.incrementError).toHaveBeenCalledWith('SILENT_ERROR');
        expect(console.error).toHaveBeenCalledWith(
            '[SILENT_ERROR] No logger available',
            expect.objectContaining({
                code: 'SILENT_ERROR',
                message: 'No logger available'
            })
        );
    });

    test('should extract traceId from context if not explicitly provided', () => {
        logError({
            logger: mockLogger,
            err: 'Simple string error',
            code: 'API_ERROR',
            context: { correlationId: 'corr-999', extra: 'data' }
        });

        expect(mockLogger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                err: expect.objectContaining({
                    traceId: 'corr-999',
                    extra: 'data',
                    message: 'Simple string error'
                })
            }),
            'Simple string error'
        );
    });
});
