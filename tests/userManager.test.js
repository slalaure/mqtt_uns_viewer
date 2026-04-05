/**
 * @license Apache License, Version 2.0
 */

const userManager = require('../storage/userManager');
const duckdb = require('duckdb');
const crypto = require('crypto');

describe('UserManager RBAC', () => {
    let db;
    const mockLogger = {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        child: jest.fn().mockReturnThis()
    };

    beforeAll((done) => {
        // Use an in-memory DB for tests
        db = new duckdb.Database(':memory:');
        userManager.init(db, mockLogger, '/tmp/sessions');
        
        // Give it a tiny bit of time to run the async PRAGMA table creation
        setTimeout(done, 200);
    });

    afterAll((done) => {
        db.close();
        done();
    });

    test('should create a new local user with default "viewer" role', async () => {
        const username = `testuser_${Date.now()}`;
        const result = await userManager.createLocalUser(username, 'password123');
        
        expect(result.username).toBe(username);
        expect(result.role).toBe('viewer');

        // Verify in DB
        const user = await userManager.findByUsername(username);
        expect(user.role).toBe('viewer');
    });

    test('should create a new Google user with default "viewer" role', async () => {
        const profile = {
            id: `g_${Date.now()}`,
            emails: [{ value: 'test@example.com' }],
            displayName: 'Google Tester'
        };
        const result = await userManager.findOrCreateGoogleUser(profile);
        
        expect(result.role).toBe('viewer');

        // Verify in DB
        const user = await userManager.findById(result.id);
        expect(user.role).toBe('viewer');
    });

    test('ensureAdminUser should create admin with "admin" role', async () => {
        const adminName = `admin_${Date.now()}`;
        await userManager.ensureAdminUser(adminName, 'supersecret');
        
        const user = await userManager.findByUsername(adminName);
        expect(user.role).toBe('admin');
    });

    test('updateUserRole should update an existing users role', async () => {
        const username = `updateme_${Date.now()}`;
        const created = await userManager.createLocalUser(username, 'password123');
        expect(created.role).toBe('viewer');

        await userManager.updateUserRole(created.id, 'engineer');

        const updated = await userManager.findById(created.id);
        expect(updated.role).toBe('engineer');
    });

    test('updateUserRole should reject invalid roles', async () => {
        const username = `invalid_${Date.now()}`;
        const created = await userManager.createLocalUser(username, 'password123');

        await expect(userManager.updateUserRole(created.id, 'hacker'))
            .rejects
            .toThrow("Invalid role specified.");

        // Should remain unchanged
        const unchanged = await userManager.findById(created.id);
        expect(unchanged.role).toBe('viewer');
    });
});
