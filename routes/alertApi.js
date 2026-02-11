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
 * Alert API
 * REST endpoints for managing Rules and Alerts.
 * [UPDATED] Import path adjusted for alert_manager move.
 */
const express = require('express');
// [UPDATED] Import from root
const alertManager = require('../alert_manager');

module.exports = (logger) => {
    const router = express.Router();

    // --- RULES MANAGEMENT ---
    // GET /api/alerts/rules - List rules
    router.get('/rules', async (req, res) => {
        try {
            const userId = req.user ? req.user.id : null;
            const rules = await alertManager.getRules(userId);
            res.json(rules);
        } catch (err) {
            logger.error({ err }, "Failed to list rules");
            res.status(500).json({ error: "Internal Server Error" });
        }
    });

    // POST /api/alerts/rules - Create rule
    router.post('/rules', async (req, res) => {
        if (!req.user && !req.headers['x-api-key']) {
            return res.status(401).json({ error: "Authentication required to create alert rules." });
        }
        const ruleData = req.body;
        // Validation basic
        if (!ruleData.name || !ruleData.topic_pattern || !ruleData.condition_code) {
            return res.status(400).json({ error: "Missing required fields (name, topic_pattern, condition_code)." });
        }
        // Set owner
        ruleData.owner_id = req.user ? req.user.id : 'api_key_user';
        // Admin can set 'global' owner explicitly if sent in body
        if (req.user && req.user.role === 'admin' && req.body.is_global) {
            ruleData.owner_id = 'global';
        }

        try {
            const result = await alertManager.createRule(ruleData);
            logger.info(`Alert Rule created: ${result.name} by ${ruleData.owner_id}`);
            res.json({ success: true, rule: result });
        } catch (err) {
            logger.error({ err }, "Failed to create rule");
            res.status(500).json({ error: err.message });
        }
    });

    // PUT /api/alerts/rules/:id - Update rule
    router.put('/rules/:id', async (req, res) => {
        if (!req.user) {
            return res.status(401).json({ error: "Authentication required to edit rules." });
        }
        const ruleId = req.params.id;
        const ruleData = req.body;
        if (!ruleData.name || !ruleData.topic_pattern || !ruleData.condition_code) {
            return res.status(400).json({ error: "Missing required fields." });
        }
        const userId = req.user.id;
        const isAdmin = req.user.role === 'admin';

        try {
            const result = await alertManager.updateRule(ruleId, userId, ruleData, isAdmin);
            logger.info(`Alert Rule updated: ${result.name} (${ruleId}) by ${userId}`);
            res.json({ success: true, rule: result });
        } catch (err) {
            logger.error({ err }, "Failed to update rule");
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /api/alerts/rules/:id
    router.delete('/rules/:id', async (req, res) => {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });
        try {
            const isAdmin = req.user.role === 'admin';
            await alertManager.deleteRule(req.params.id, req.user.id, isAdmin);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- ALERTS (INSTANCES) MANAGEMENT ---
    // GET /api/alerts/active - List triggered alerts
    router.get('/active', async (req, res) => {
        try {
            const userId = req.user ? req.user.id : null;
            const alerts = await alertManager.getActiveAlerts(userId);
            res.json(alerts);
        } catch (err) {
            logger.error({ err }, "Failed to fetch active alerts");
            res.status(500).json({ error: "Internal Server Error" });
        }
    });

    // POST /api/alerts/:id/status - Acknowledge or Resolve
    router.post('/:id/status', async (req, res) => {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });
        const { status } = req.body; // 'acknowledged', 'resolved'
        if (!['acknowledged', 'resolved', 'open'].includes(status)) {
            return res.status(400).json({ error: "Invalid status" });
        }
        try {
            const username = req.user.displayName || req.user.username || 'User';
            await alertManager.updateAlertStatus(req.params.id, status, username);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- ADMIN / MAINTENANCE ROUTES ---
    // GET /api/alerts/admin/stats - Get resolved count and size
    router.get('/admin/stats', async (req, res) => {
        if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: "Forbidden" });
        try {
            const stats = await alertManager.getResolvedAlertsStats();
            res.json(stats);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/alerts/admin/purge - Delete resolved alerts
    router.post('/admin/purge', async (req, res) => {
        if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: "Forbidden" });
        try {
            await alertManager.purgeResolvedAlerts();
            res.json({ success: true, message: "Purge complete." });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};