const fs = require('fs');
const path = require('path');
const dlqManager = require('../storage/dlqManager');

const DLQ_DIR = path.join(__dirname, '../data/dlq');
const DLQ_FILE = path.join(DLQ_DIR, 'failed_events.jsonl');

const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis()
};

describe('DLQ Manager Hardening', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        if (fs.existsSync(DLQ_FILE)) {
            fs.unlinkSync(DLQ_FILE);
        }
        if (!fs.existsSync(DLQ_DIR)) {
            fs.mkdirSync(DLQ_DIR, { recursive: true });
        }
    });

    afterEach(() => {
        dlqManager.stop();
        if (fs.existsSync(DLQ_FILE)) {
            fs.unlinkSync(DLQ_FILE);
        }
    });

    it('should prune the DLQ file when it exceeds DLQ_MAX_SIZE_MB', () => {
        const mockConfig = {
            DLQ_MAX_SIZE_MB: 0.002, // 2 KB max size for testing
            DLQ_PRUNE_CHUNK_SIZE: 2 // Prune 2 lines when over limit
        };

        dlqManager.init(mockLogger, mockConfig);
        
        // 5 messages = ~1.2 KB
        const bigPayload = "x".repeat(100); 
        const largeBatch = Array.from({ length: 40 }, (_, i) => ({ topic: `test/${i}`, value: i, payload: bigPayload }));
        
        // Push 5 messages (~1.2 KB) -> Shouldn't trigger prune because limit is 2 KB
        dlqManager.push(largeBatch.slice(0, 5), 'testRepo');
        expect(fs.existsSync(DLQ_FILE)).toBe(true);
        expect(dlqManager.getMessages().length).toBe(5);
        
        // Push 5 more messages (total 10). Size will be ~2.4 KB.
        // overLimitRatio will be ~1.2 (2.4 / 2.0).
        // Since overLimitRatio > 1.1 (but not > 1.2), multiplier = 2.
        // linesToDelete = 2 * 2 = 4.
        // We have 10 lines. 10 - 4 = 6 lines remain!
        
        dlqManager.push(largeBatch.slice(5, 10), 'testRepo');
        
        const messages = dlqManager.getMessages();
        
        // Initial 10 pushes. 4 dropped. 6 remaining.
        expect(messages.length).toBe(6);
        
        expect(mockLogger.child().warn).toHaveBeenCalledWith(
            expect.stringContaining('exceeded limit')
        );
    });

    it('should clear the DLQ file when clear() is called', () => {
        dlqManager.init(mockLogger, { DLQ_MAX_SIZE_MB: 10 });
        dlqManager.push([{ topic: 'test' }], 'testRepo');
        expect(dlqManager.getMessages().length).toBe(1);
        
        dlqManager.clear();
        expect(dlqManager.getMessages().length).toBe(0);
        expect(fs.existsSync(DLQ_FILE)).toBe(false);
    });

    it('should return empty array if DLQ file does not exist', () => {
        dlqManager.init(mockLogger, { DLQ_MAX_SIZE_MB: 10 });
        if (fs.existsSync(DLQ_FILE)) fs.unlinkSync(DLQ_FILE);
        expect(dlqManager.getMessages()).toEqual([]);
    });
});
