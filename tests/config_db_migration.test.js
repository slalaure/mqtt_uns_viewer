const duckdb = require('duckdb');
const fs = require('fs');
const path = require('path');
const { mergeConfigFromDb } = require('../boot/config');

describe('Database-Backed Configuration Migration', () => {
    let db;
    const testDbPath = path.join(__dirname, 'test_config.duckdb');
    const logger = {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn()
    };

    beforeAll((done) => {
        if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
        db = new duckdb.Database(testDbPath, (err) => {
            if (err) return done(err);
            db.exec(`
                CREATE TABLE IF NOT EXISTS app_config (
                    key VARCHAR PRIMARY KEY,
                    value JSON,
                    updated_at TIMESTAMPTZ DEFAULT current_timestamp
                );
            `, done);
        });
    });

    afterEach((done) => {
        jest.clearAllMocks();
        db.run("DELETE FROM app_config", done);
    });

    afterAll((done) => {
        db.close(() => {
            if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
            done();
        });
    });

    it('should merge configuration from database', async () => {
        const initialConfig = {
            LLM_MODEL: 'initial-model',
            VIEW_CHART_ENABLED: true,
            AI_TOOLS: { ENABLE_READ: true }
        };

        const insert = (key, val) => new Promise((resolve, reject) => {
            db.run("INSERT INTO app_config (key, value) VALUES (?, ?)", key, JSON.stringify(val), (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        await insert('LLM_MODEL', 'gemini-pro');
        await insert('VIEW_CHART_ENABLED', false);
        await insert('LLM_TOOL_ENABLE_READ', false);

        const mergedConfig = await mergeConfigFromDb(initialConfig, db, logger);

        expect(mergedConfig.LLM_MODEL).toBe('gemini-pro');
        expect(mergedConfig.VIEW_CHART_ENABLED).toBe(false);
        expect(mergedConfig.AI_TOOLS.ENABLE_READ).toBe(false);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Applied 3 configuration setting(s)'));
    });

    it('should handle complex JSON values (Data Providers)', async () => {
        const initialConfig = { DATA_PROVIDERS: [] };
        const testProviders = [{ id: 'test_provider', type: 'mqtt', host: 'localhost' }];

        await new Promise((resolve, reject) => {
            db.run("INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", 
                'DATA_PROVIDERS', JSON.stringify(testProviders),
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });

        const mergedConfig = await mergeConfigFromDb(initialConfig, db, logger);
        expect(mergedConfig.DATA_PROVIDERS).toHaveLength(1);
        expect(mergedConfig.DATA_PROVIDERS[0].id).toBe('test_provider');
    });

    it('should fallback to defaults if key is missing in DB', async () => {
        const initialConfig = { PORT: 8080 };
        const mergedConfig = await mergeConfigFromDb(initialConfig, db, logger);
        expect(mergedConfig.PORT).toBe(8080);
    });
});
