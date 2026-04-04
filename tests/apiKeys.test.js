const express = require('express');
const http = require('http');
const duckdb = require('duckdb');
const externalApi = require('../interfaces/web/externalApi');
const adminApi = require('../interfaces/web/adminApi');

describe('API Keys Management & Authentication', () => {
    let app;
    let server;
    let baseUrl;
    let db;
    let mockMqttClient;
    let logger;
    let createdApiKeyId = null;
    let createdRawKey = null;

    beforeAll((done) => {
        // 1. Setup in-memory DuckDB and schema
        db = new duckdb.Database(':memory:', (err) => {
            if (err) return done(err);
            db.exec(`
                CREATE TABLE IF NOT EXISTS api_keys (
                    id VARCHAR PRIMARY KEY,
                    api_key VARCHAR UNIQUE,
                    name VARCHAR,
                    scopes VARCHAR,
                    created_at TIMESTAMPTZ DEFAULT current_timestamp,
                    last_used_at TIMESTAMPTZ
                );
            `, (err2) => {
                if (err2) return done(err2);

                // 2. Setup mocks
                mockMqttClient = {
                    connected: true,
                    publish: jest.fn((topic, payload, options, callback) => callback(null))
                };
                const getMainConnection = () => mockMqttClient;

                logger = {
                    info: jest.fn(),
                    warn: jest.fn(),
                    error: jest.fn(),
                    child: jest.fn(() => logger)
                };

                const mockDataManager = {};
                const longReplacer = (key, value) => typeof value === 'bigint' ? value.toString() : value;

                // 3. Setup Express App
                app = express();
                app.use(express.json());

                // Mock authentication middleware for admin routes
                app.use('/api/admin', (req, res, next) => {
                    req.isAuthenticated = () => true;
                    req.user = { role: 'admin', username: 'testadmin' };
                    next();
                });

                // Mount routers
                const adminRouter = adminApi(logger, db, mockDataManager, '/tmp');
                app.use('/api/admin', adminRouter);

                const externalRouter = externalApi(getMainConnection, logger, db, longReplacer);
                app.use('/api/external', externalRouter);
                
                app.use((err, req, res, next) => {
                    console.error("EXPRESS ERROR:", err);
                    res.status(500).json({ error: err.message });
                });

                server = http.createServer(app);
                server.listen(0, () => {
                    const port = server.address().port;
                    baseUrl = `http://localhost:${port}`;
                    done();
                });
            });
        });
    });

    afterAll((done) => {
        if (server) {
            server.close(() => {
                db.close(done);
            });
        } else {
            db.close(done);
        }
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('Admin API - API Keys CRUD', () => {
        it('should generate a new API key', async () => {
            const response = await fetch(`${baseUrl}/api/admin/api_keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'Test App',
                    scopes: ['sensors/+/temperature', 'alerts/#']
                })
            });

            expect(response.status).toBe(200);
            const body = await response.json();
            expect(body.success).toBe(true);
            expect(body.api_key).toMatch(/^krl_[a-f0-9]{64}$/);
            createdRawKey = body.api_key;
        });

        it('should list API keys masking the full key', async () => {
            const response = await fetch(`${baseUrl}/api/admin/api_keys`);

            expect(response.status).toBe(200);
            const body = await response.json();
            expect(Array.isArray(body)).toBe(true);
            expect(body.length).toBeGreaterThan(0);
            
            const keyRecord = body[0];
            expect(keyRecord.name).toBe('Test App');
            expect(keyRecord.api_key_preview).toMatch(/^krl_[a-f0-9]{4}\*\*\*/); // Should start with krl_XXXX***
            expect(keyRecord.scopes).toBe('["sensors/+/temperature","alerts/#"]');
            
            createdApiKeyId = keyRecord.id;
        });
    });

    describe('External API - Publishing with API Key', () => {
        it('should block requests without an API key', async () => {
            const response = await fetch(`${baseUrl}/api/external/publish`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ topic: 'test', payload: 'data' })
            });

            expect(response.status).toBe(401);
            const body = await response.json();
            expect(body.error).toMatch(/Missing API key/);
            expect(mockMqttClient.publish).not.toHaveBeenCalled();
        });

        it('should block requests with an invalid API key', async () => {
            const response = await fetch(`${baseUrl}/api/external/publish`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'x-api-key': 'invalid_key_123'
                },
                body: JSON.stringify({ topic: 'test', payload: 'data' })
            });

            expect(response.status).toBe(401);
            const body = await response.json();
            expect(body.error).toMatch(/Invalid API key/);
        });

        it('should block requests if the topic is not in the allowed scopes', async () => {
            const response = await fetch(`${baseUrl}/api/external/publish`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${createdRawKey}`
                },
                body: JSON.stringify({ topic: 'factory/commands/start', payload: 'data' })
            });

            expect(response.status).toBe(403);
            const body = await response.json();
            expect(body.error).toMatch(/Forbidden/);
            expect(mockMqttClient.publish).not.toHaveBeenCalled();
        });

        it('should allow publishing if the key and scope are valid', async () => {
            const response = await fetch(`${baseUrl}/api/external/publish`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'x-api-key': createdRawKey
                },
                body: JSON.stringify({ topic: 'sensors/room1/temperature', payload: { value: 25.5 }, qos: 1 })
            });

            expect(response.status).toBe(200);
            const body = await response.json();
            expect(body.success).toBe(true);
            
            expect(mockMqttClient.publish).toHaveBeenCalledWith(
                'sensors/room1/temperature',
                '{"value":25.5}',
                { qos: 1, retain: false },
                expect.any(Function)
            );
        });

        it('should update the last_used_at timestamp on successful auth', async () => {
            // Need to wait a moment to ensure timestamp change is measurable
            await new Promise(r => setTimeout(r, 100));

            const response = await fetch(`${baseUrl}/api/admin/api_keys`);

            expect(response.status).toBe(200);
            const body = await response.json();
            const keyRecord = body.find(k => k.id === createdApiKeyId);
            expect(keyRecord.last_used_at).not.toBeNull();
        });
    });

    describe('Admin API - Deleting API Keys', () => {
        it('should delete the generated API key', async () => {
            const response = await fetch(`${baseUrl}/api/admin/api_keys/${createdApiKeyId}`, {
                method: 'DELETE'
            });

            expect(response.status).toBe(200);
            const body = await response.json();
            expect(body.success).toBe(true);

            // Verify it's gone
            const checkResponse = await fetch(`${baseUrl}/api/admin/api_keys`);
            const checkBody = await checkResponse.json();
            expect(checkBody.length).toBe(0);
        });

        it('should no longer authorize requests with the deleted key', async () => {
            const response = await fetch(`${baseUrl}/api/external/publish`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'x-api-key': createdRawKey
                },
                body: JSON.stringify({ topic: 'sensors/room1/temperature', payload: 'data' })
            });

            expect(response.status).toBe(401);
            const body = await response.json();
            expect(body.error).toMatch(/Invalid API key/);
        });
    });
});
