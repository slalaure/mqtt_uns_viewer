/**
 * @license Apache License, Version 2.0
 */

const { configureAuth, requireRole, ROLES } = require('../interfaces/web/middlewares/auth');

describe('Auth Middleware RBAC (requireRole)', () => {
    let mockReq;
    let mockRes;
    let mockNext;
    
    const mockLogger = {
        warn: jest.fn(),
        info: jest.fn(),
        error: jest.fn()
    };

    beforeAll(() => {
        // Initialize the module state with a mock logger so it doesn't crash on auth failures
        const mockApp = { use: jest.fn() };
        configureAuth(mockApp, {}, mockLogger, { createSessionStore: jest.fn() }, '', '');
    });

    beforeEach(() => {
        mockReq = {
            isAuthenticated: jest.fn().mockReturnValue(true),
            user: { role: 'viewer' },
            originalUrl: '/api/test'
        };
        mockRes = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
            send: jest.fn()
        };
        mockNext = jest.fn();
    });

    test('should allow admin to access viewer route', () => {
        mockReq.user.role = 'admin';
        const middleware = requireRole('viewer');
        middleware(mockReq, mockRes, mockNext);
        expect(mockNext).toHaveBeenCalled();
        expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('should allow engineer to access operator route', () => {
        mockReq.user.role = 'engineer';
        const middleware = requireRole('operator');
        middleware(mockReq, mockRes, mockNext);
        expect(mockNext).toHaveBeenCalled();
    });

    test('should deny viewer from accessing operator route', () => {
        mockReq.user.role = 'viewer';
        const middleware = requireRole('operator');
        middleware(mockReq, mockRes, mockNext);
        expect(mockNext).not.toHaveBeenCalled();
        expect(mockRes.status).toHaveBeenCalledWith(403);
        expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('operator') }));
    });

    test('should deny operator from accessing admin route', () => {
        mockReq.user.role = 'operator';
        const middleware = requireRole('admin');
        middleware(mockReq, mockRes, mockNext);
        expect(mockNext).not.toHaveBeenCalled();
        expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    test('should default missing user role to viewer (deny operator access)', () => {
        mockReq.user.role = undefined;
        const middleware = requireRole('operator');
        middleware(mockReq, mockRes, mockNext);
        expect(mockNext).not.toHaveBeenCalled();
        expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    test('should deny unauthenticated requests', () => {
        mockReq.isAuthenticated.mockReturnValue(false);
        const middleware = requireRole('viewer');
        middleware(mockReq, mockRes, mockNext);
        expect(mockNext).not.toHaveBeenCalled();
        expect(mockRes.status).toHaveBeenCalledWith(403);
    });
});
