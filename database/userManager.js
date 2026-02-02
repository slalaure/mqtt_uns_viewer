/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * User Manager
 * Handles User Persistence in DuckDB and Password Hashing.
 * [UPDATED] Adds Admin role support, user deletion logic, and schema migration.
 */
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let db = null;
let logger = null;
let sessionsDir = null; // Path to remove user data

/**
 * Initializes the User Manager and creates the users table.
 * @param {duckdb.Database} database - The DuckDB connection.
 * @param {pino.Logger} appLogger - The application logger.
 * @param {string} sessionsPath - The directory where user data is stored (for deletion).
 */
function init(database, appLogger, sessionsPath) {
    db = database;
    logger = appLogger.child({ component: 'UserManager' });
    sessionsDir = sessionsPath;

    // Step 1: Create Table with 'role' column
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS users (
            id VARCHAR PRIMARY KEY,
            username VARCHAR,
            email VARCHAR,
            password_hash VARCHAR,
            google_id VARCHAR,
            display_name VARCHAR,
            avatar_url VARCHAR,
            role VARCHAR DEFAULT 'user',
            created_at TIMESTAMPTZ,
            last_login TIMESTAMPTZ
        );
    `;

    db.run(createTableQuery, (err) => {
        if (err) {
            logger.error({ err }, "❌ Failed to create 'users' table.");
        } else {
            // Step 1.5: Schema Migration (Check for 'role' column)
            db.all("PRAGMA table_info(users);", (pragmaErr, columns) => {
                if (pragmaErr) {
                    logger.error({ err: pragmaErr }, "Failed to check users table schema.");
                    return;
                }
                
                const hasRole = columns.some(col => col.name === 'role');
                if (!hasRole) {
                    logger.warn("⚠️ Migrating 'users' table: Adding 'role' column...");
                    db.run("ALTER TABLE users ADD COLUMN role VARCHAR DEFAULT 'user';", (alterErr) => {
                        if (alterErr) {
                            logger.error({ err: alterErr }, "Failed to add role column.");
                        } else {
                            logger.info("✅ Schema migration complete: 'role' column added.");
                        }
                    });
                }
            });

            // Step 2: Create Indexes
            const createIndexesQuery = `
                CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google ON users(google_id);
            `;
            
            db.exec(createIndexesQuery, (idxErr) => {
                if (idxErr) {
                    logger.warn({ err: idxErr }, "⚠️ Failed to create indexes.");
                } else {
                    logger.info("✅ User Manager initialized: 'users' table ready.");
                }
            });
        }
    });
}

/**
 * Checks for ADMIN_USERNAME env var and creates super admin if missing.
 */
async function ensureAdminUser(adminUsername, adminPassword) {
    if (!adminUsername || !adminPassword) return;

    // Wait a bit to ensure migration is done (simple fix for startup race condition)
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
        const existing = await findByUsername(adminUsername);
        if (existing) {
            // Optional: Update password/role if already exists
            if (existing.role !== 'admin') {
                db.run("UPDATE users SET role = 'admin' WHERE username = ?", adminUsername);
                logger.info(`Updated existing user '${adminUsername}' to admin role.`);
            }
            return;
        }

        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(adminPassword, saltRounds);
        const newId = crypto.randomUUID();

        const insertQuery = `
            INSERT INTO users (id, username, password_hash, display_name, role, created_at, last_login)
            VALUES (?, ?, ?, ?, 'admin', current_timestamp, current_timestamp)
        `;
        
        db.run(insertQuery, newId, adminUsername, passwordHash, "Super Admin", (err) => {
            if (err) logger.error({ err }, "Failed to create Admin user.");
            else logger.info(`✅ Super Admin '${adminUsername}' created.`);
        });

    } catch (e) {
        logger.error({ err: e }, "Error ensuring admin user.");
    }
}

/**
 * Finds a user by their internal ID.
 */
function findById(id) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error("DB not initialized"));
        db.all("SELECT * FROM users WHERE id = ?", id, (err, rows) => {
            if (err) return reject(err);
            resolve(rows.length > 0 ? rows[0] : null);
        });
    });
}

/**
 * Finds a user by username.
 */
function findByUsername(username) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error("DB not initialized"));
        db.all("SELECT * FROM users WHERE username = ?", username, (err, rows) => {
            if (err) return reject(err);
            resolve(rows.length > 0 ? rows[0] : null);
        });
    });
}

/**
 * Finds or creates a user from a Google Profile.
 */
function findOrCreateGoogleUser(profile) {
    return new Promise((resolve, reject) => {
        const googleId = profile.id;
        const email = profile.emails && profile.emails.length > 0 ? profile.emails[0].value : null;
        const displayName = profile.displayName;
        const avatarUrl = profile.photos && profile.photos.length > 0 ? profile.photos[0].value : null;

        db.all("SELECT * FROM users WHERE google_id = ?", googleId, (err, rows) => {
            if (err) return reject(err);

            if (rows.length > 0) {
                const user = rows[0];
                db.run("UPDATE users SET last_login = current_timestamp WHERE id = ?", user.id);
                return resolve(user);
            }

            const newId = crypto.randomUUID();
            const insertQuery = `
                INSERT INTO users (id, google_id, email, display_name, avatar_url, role, created_at, last_login)
                VALUES (?, ?, ?, ?, ?, 'user', current_timestamp, current_timestamp)
            `;
            
            db.run(insertQuery, newId, googleId, email, displayName, avatarUrl, (insertErr) => {
                if (insertErr) return reject(insertErr);
                resolve({ id: newId, google_id: googleId, email, display_name: displayName, avatar_url: avatarUrl, role: 'user' });
            });
        });
    });
}

/**
 * Registers a new local user.
 */
async function createLocalUser(username, password) {
    try {
        const existing = await findByUsername(username);
        if (existing) throw new Error("Username already exists.");
    } catch (err) {
        if (err.message.includes('Catalog Error')) throw new Error("Database table missing. Please restart the server.");
        throw err;
    }

    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    const newId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
        const insertQuery = `
            INSERT INTO users (id, username, password_hash, display_name, role, created_at, last_login)
            VALUES (?, ?, ?, ?, 'user', current_timestamp, current_timestamp)
        `;
        
        db.run(insertQuery, newId, username, passwordHash, username, (err) => {
            if (err) return reject(err);
            resolve({ id: newId, username, display_name: username, role: 'user' });
        });
    });
}

function verifyPassword(password, hash) {
    if (!hash) return Promise.resolve(false);
    return bcrypt.compare(password, hash);
}

/**
 * Lists all users (for Admin Dashboard).
 */
function getAllUsers() {
    return new Promise((resolve, reject) => {
        db.all("SELECT id, username, email, display_name, role, last_login FROM users ORDER BY created_at DESC", (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

/**
 * Deletes a user and their data directory.
 */
function deleteUser(userId) {
    return new Promise((resolve, reject) => {
        // 1. Delete from DB
        db.run("DELETE FROM users WHERE id = ?", userId, (err) => {
            if (err) return reject(err);
            logger.info(`User ${userId} deleted from DB.`);

            // 2. Wipe File Storage
            if (sessionsDir && userId) {
                const userPath = path.join(sessionsDir, userId);
                if (fs.existsSync(userPath)) {
                    try {
                        fs.rmSync(userPath, { recursive: true, force: true });
                        logger.info(`Wiped data for user ${userId}.`);
                    } catch (fsErr) {
                        logger.error({ err: fsErr }, "Failed to delete user data directory.");
                    }
                }
            }
            resolve(true);
        });
    });
}

module.exports = {
    init,
    ensureAdminUser,
    findById,
    findByUsername,
    findOrCreateGoogleUser,
    createLocalUser,
    verifyPassword,
    getAllUsers,
    deleteUser
};