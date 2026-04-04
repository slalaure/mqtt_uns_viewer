/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the HTTP Provider.
 * Verifies ingestion (pseudo-publish) and webhook registration (pseudo-subscribe).
 */

const HttpProvider = require('../connectors/http/index');
const webhookManager = require('../core/webhookManager');

// Mock dependencies
jest.mock('../core/webhookManager');
jest.mock('uuid', () => ({ v4: () => 'test-uuid-12345678' }));

const createMockLogger = () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockImplementation(() => createMockLogger())
});

describe('HttpProvider', () => {
    let mockApp, mockContext, config, provider;
    let postRoutes = {};

    beforeEach(() => {
        jest.clearAllMocks();
        postRoutes = {};

        // Mock Express App
        mockApp = {
            post: jest.fn((path, ...args) => {
                // The handler is usually the last argument
                postRoutes[path] = args[args.length - 1];
            })
        };

        // Mock Global Context
        mockContext = {
            app: mockApp,
            logger: createMockLogger(),
            handleMessage: jest.fn(),
            activeConnections: new Map(),
            updateConnectorStatus: jest.fn()
        };

        config = {
            id: 'test-http',
            type: 'http',
            pathPrefix: '/api/ingest/test-http',
            publish: ['factory/line1/#'],
            subscribe: ['factory/line1/temp']
        };

        provider = new HttpProvider(config, mockContext);
    });

    test('connect should mount routes and update status', async () => {
        const result = await provider.connect();
        expect(result).toBe(true);
        expect(mockApp.post).toHaveBeenCalledWith('/api/ingest/test-http/*', expect.any(Function), expect.any(Function));
        expect(mockApp.post).toHaveBeenCalledWith('/api/subscribe/test-http', expect.any(Function), expect.any(Function));
        expect(mockContext.updateConnectorStatus).toHaveBeenCalledWith('test-http', 'connected', null);
    });

    test('ingestion route should respect allowed publish patterns', async () => {
        await provider.connect();
        const handler = postRoutes['/api/ingest/test-http/*'];

        // 1. Allowed topic
        const reqAllowed = {
            params: ['factory/line1/temp'],
            body: '{"val": 25}',
            headers: { 'content-type': 'application/json' }
        };
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

        handler(reqAllowed, res);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(mockContext.handleMessage).toHaveBeenCalledWith('test-http', 'factory/line1/temp', { val: 25 });

        // 2. Forbidden topic
        const reqForbidden = {
            params: ['factory/line2/temp'],
            body: '{"val": 25}',
            headers: { 'content-type': 'application/json' }
        };
        const resForbidden = { status: jest.fn().mockReturnThis(), json: jest.fn() };

        handler(reqForbidden, resForbidden);
        expect(resForbidden.status).toHaveBeenCalledWith(403);
        expect(resForbidden.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('forbidden') }));
    });

    test('subscription route should register webhooks for allowed topics', async () => {
        await provider.connect();
        const handler = postRoutes['/api/subscribe/test-http'];

        const req = {
            body: {
                topic: 'factory/line1/temp',
                url: 'http://my-app.com/webhook',
                min_interval_ms: 2000
            }
        };
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

        await handler(req, res);
        expect(webhookManager.addWebhook).toHaveBeenCalledWith(expect.objectContaining({
            id: 'webhook-test-uui',
            topic: 'factory/line1/temp',
            url: 'http://my-app.com/webhook',
            min_interval_ms: 2000
        }));
        expect(res.status).toHaveBeenCalledWith(201);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    test('subscription route should forbid non-allowed topic patterns', async () => {
        await provider.connect();
        const handler = postRoutes['/api/subscribe/test-http'];

        const req = {
            body: {
                topic: 'factory/line2/#',
                url: 'http://my-app.com/webhook'
            }
        };
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(webhookManager.addWebhook).not.toHaveBeenCalled();
    });

    test('publish method should return error (unsupported outbound)', (done) => {
        provider.publish('some/topic', 'payload', {}, (err) => {
            expect(err).toBeDefined();
            expect(err.message).toContain('Use Webhooks');
            done();
        });
    });
});