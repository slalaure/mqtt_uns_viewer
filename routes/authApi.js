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
 * Authentication API
 * Handles Login, Logout, Registration and User Session retrieval.
 */
const express = require('express');
const passport = require('passport');
// [NEW] Import User Manager to handle registration
const userManager = require('../database/userManager');

module.exports = (logger) => {
    const router = express.Router();

    // --- Local Login ---
    router.post('/login', (req, res, next) => {
        passport.authenticate('local', (err, user, info) => {
            if (err) {
                logger.error({ err }, "Auth Error during local login");
                return res.status(500).json({ error: "Internal Server Error" });
            }
            if (!user) {
                return res.status(401).json({ error: info.message || "Authentication failed" });
            }
            req.logIn(user, (err) => {
                if (err) {
                    logger.error({ err }, "Login Session Error");
                    return res.status(500).json({ error: "Failed to create session" });
                }
                logger.info(`User logged in: ${user.username || user.email}`);
                return res.json({ 
                    success: true, 
                    user: { 
                        id: user.id, 
                        username: user.username, 
                        displayName: user.display_name,
                        avatar: user.avatar_url 
                    } 
                });
            });
        })(req, res, next);
    });

    // --- [NEW] Registration Route ---
    router.post('/register', async (req, res) => {
        const { username, password } = req.body;
        
        if (!username || !password || password.length < 6) {
            return res.status(400).json({ error: "Invalid input. Password must be at least 6 characters." });
        }

        try {
            const user = await userManager.createLocalUser(username, password);
            logger.info(`New user registered: ${username}`);
            
            // Automatically log in after registration
            req.logIn(user, (err) => {
                if (err) return res.status(500).json({ error: "Registration successful, but auto-login failed." });
                res.json({ success: true, user: { id: user.id, username: user.username } });
            });
        } catch (err) {
            logger.warn({ err }, "Registration failed");
            // Check for specific "Already exists" error from userManager
            if (err.message.includes('exists')) {
                return res.status(409).json({ error: "Username already taken." });
            }
            res.status(500).json({ error: "Registration failed." });
        }
    });

    // --- Google OAuth ---
    router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

    router.get('/google/callback', 
        passport.authenticate('google', { failureRedirect: '/' }), 
        (req, res) => {
            logger.info(`User logged in via Google: ${req.user.display_name}`);
            res.redirect('/');
        }
    );

    // --- Logout ---
    router.post('/logout', (req, res, next) => {
        req.logout((err) => {
            if (err) { return next(err); }
            res.json({ success: true });
        });
    });

    // --- Get Current User Context ---
    router.get('/me', (req, res) => {
        if (req.isAuthenticated()) {
            res.json({ 
                isAuthenticated: true, 
                user: {
                    id: req.user.id,
                    username: req.user.username,
                    displayName: req.user.display_name,
                    avatar: req.user.avatar_url,
                    provider: req.user.google_id ? 'google' : 'local'
                }
            });
        } else {
            res.json({ isAuthenticated: false });
        }
    });

    return router;
};