/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the SQL Poller Provider.
 */
const SqlPollerProvider = require('../connectors/sql/index');

jest.mock('pg', () => {
    return {
        Pool: jest.fn(() => ({
            query: jest.fn().mockResolvedValue({
                rows: [ { id: 1, val: 'test1', updated_at: 100 }, { id: 2, val: 'test2', updated_at: 110 } ]
            }),
            end: jest.fn()
        }))
    };
});

const createMockLogger = () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    child: jest.fn().mockImplementation(() => createMockLogger())
});

describe('SqlPollerProvider', () => {
    let mockContext;

    beforeEach(() => {
        jest.clearAllMocks();
        mockContext = {
            logger: createMockLogger(),
            handleMessage: jest.fn(),
            updateConnectorStatus: jest.fn()
        };
    });

    test('should connect and poll successfully with postgres driver', async () => {
        const config = {
            id: 'sql_test',
            type: 'sql',
            options: {
                driver: 'postgres',
                connection: 'mock_conn',
                query: 'SELECT * FROM test',
                interval: 1000,
                cursorColumn: 'updated_at'
            }
        };

        const provider = new SqlPollerProvider(config, mockContext);
        
        const res = await provider.connect();
        expect(res).toBe(true);
        expect(provider.connected).toBe(true);
        
        // Let the immediate poll resolve
        await new Promise(resolve => setImmediate(resolve));
        
        expect(mockContext.handleMessage).toHaveBeenCalledTimes(2);
        expect(mockContext.handleMessage).toHaveBeenCalledWith(
            'sql_test', 
            'sql/sql_test', 
            { id: 1, val: 'test1', updated_at: 100 }, 
            expect.objectContaining({ connectorType: 'sql' })
        );
        
        // Verify cursor update
        expect(provider.lastCursorValue).toBe(110);
        
        await provider.disconnect();
    });
});
