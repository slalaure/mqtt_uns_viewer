/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for Sandbox Isolation
 * Verifies VM boundaries and security constraints.
 */

const SandboxPool = require('../core/engine/sandboxPool');

describe('SandboxPool Isolation', () => {
    let pool;
    let mockLogger;

    beforeAll(() => {
        mockLogger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            child: jest.fn().mockReturnThis()
        };
        pool = new SandboxPool(mockLogger, null);
    });

    afterAll(() => {
        // Terminate all workers to avoid open handles
        pool.workers.forEach(w => w.worker.terminate());
    });

    test('should prevent access to require() and file system', async () => {
        const code = `
            try {
                const fs = require('fs');
                fs.readFileSync('/etc/passwd');
            } catch (e) {
                throw new Error("ISOLATION_VERIFIED: " + e.message);
            }
        `;
        
        await expect(pool.execute(code, { msg: {} })).rejects.toThrow(/ISOLATION_VERIFIED: require is not defined/);
    });

    test('should evaluate safe code correctly', async () => {
        const code = `msg.payload.val * 2;`;
        const result = await pool.execute(code, { msg: { payload: { val: 21 } } });
        expect(result).toBe(42);
    });

    test('should reject long-running code (infinite loop) based on timeout', async () => {
        const code = `while(true) {}`;
        // Pass a short timeout of 100ms
        await expect(pool.execute(code, { msg: {} }, 100)).rejects.toThrow(/Script execution timed out/);
    });
});
