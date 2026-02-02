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
 * Admin API
 * Protected routes for user management (List, Delete).
 */
const express = require('express');
const userManager = require('../database/userManager');

module.exports = (logger) => {
    const router = express.Router();

    // --- Admin Middleware ---
    const requireAdmin = (req, res, next) => {
        if (req.isAuthenticated() && req.user.role === 'admin') {
            return next();
        }
        logger.warn(`[AdminAPI] Unauthorized access attempt by user: ${req.user ? req.user.username : 'Guest'} IP: ${req.ip}`);
        return res.status(403).json({ error: "Forbidden: Admin privileges required." });
    };

    router.use(requireAdmin);

    // --- List All Users ---
    router.get('/users', async (req, res) => {
        try {
            const users = await userManager.getAllUsers();
            res.json(users);
        } catch (err) {
            logger.error({ err }, "Failed to list users");
            res.status(500).json({ error: "Internal Server Error" });
        }
    });

    // --- Delete User ---
    router.delete('/users/:id', async (req, res) => {
        const userIdToDelete = req.params.id;
        
        // Prevent self-deletion
        if (userIdToDelete === req.user.id) {
            return res.status(400).json({ error: "You cannot delete your own account while logged in." });
        }

        try {
            await userManager.deleteUser(userIdToDelete);
            logger.info(`[AdminAPI] User ${userIdToDelete} deleted by admin ${req.user.username}`);
            res.json({ success: true, message: "User and associated data deleted." });
        } catch (err) {
            logger.error({ err }, "Failed to delete user");
            res.status(500).json({ error: "Failed to delete user." });
        }
    });

    return router;
};