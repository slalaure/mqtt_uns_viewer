/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 *
 * I3X Router (RFC 001 Compliant)
 * Exposes Northbound API for Contextualized Manufacturing Information.
 */
const express = require('express');

// Helper to format a single DuckDB row into an I3X VQT object
function formatVQT(row, isHistory = false) {
    if (!row) return null;
    let val = row.payload;
    try { 
        val = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload; 
    } catch(e) {}
    
    // Clean up internal _i3x metadata tag if present in the payload
    if (val && val._i3x) {
        delete val._i3x;
    }

    return {
        value: val,
        quality: "Good",
        timestamp: new Date(row.timestamp).toISOString()
    };
}

module.exports = (db, semanticManager, logger, i3xEvents) => {
    const router = express.Router();
    const i3xLogger = logger.child({ component: 'I3X_API' });

    // ==========================================
    // EXPLORATORY METHODS (RFC 4.1)
    // ==========================================

    router.get('/namespaces', (req, res) => {
        res.json(semanticManager.getModel().namespaces || []);
    });

    router.get('/objecttypes', (req, res) => {
        const { namespaceUri } = req.query;
        let types = semanticManager.getModel().objectTypes || [];
        if (namespaceUri) types = types.filter(t => t.namespaceUri === namespaceUri);
        res.json(types);
    });

    router.post('/objecttypes/query', (req, res) => {
        const { elementIds } = req.body;
        if (!elementIds || !Array.isArray(elementIds)) return res.status(400).json({ error: "elementIds array required" });
        const types = semanticManager.getModel().objectTypes || [];
        res.json(types.filter(t => elementIds.includes(t.elementId)));
    });

    router.get('/relationshiptypes', (req, res) => {
        const { namespaceUri } = req.query;
        let rels = semanticManager.getModel().relationshipTypes || [];
        if (namespaceUri) rels = rels.filter(r => r.namespaceUri === namespaceUri);
        res.json(rels);
    });

    router.get('/objects', (req, res) => {
        const { typeId } = req.query;
        let instances = semanticManager.getModel().instances || [];
        if (typeId) instances = instances.filter(i => i.typeId === typeId);
        
        // Return metadata only (no values in exploratory endpoints)
        res.json(instances.map(i => ({
            elementId: i.elementId,
            displayName: i.displayName,
            typeId: i.typeId,
            namespaceUri: i.namespaceUri,
            parentId: i.parentId,
            isComposition: !!i.isComposition
        })));
    });

    router.post('/objects/list', (req, res) => {
        const { elementIds } = req.body;
        if (!elementIds || !Array.isArray(elementIds)) return res.status(400).json({ error: "elementIds array required" });
        const instances = semanticManager.getModel().instances || [];
        res.json(instances.filter(i => elementIds.includes(i.elementId)).map(i => ({
            elementId: i.elementId,
            displayName: i.displayName,
            typeId: i.typeId,
            namespaceUri: i.namespaceUri,
            parentId: i.parentId,
            isComposition: !!i.isComposition
        })));
    });

    router.post('/objects/related', (req, res) => {
        const { elementIds, relationshiptype } = req.body;
        if (!elementIds || !Array.isArray(elementIds)) return res.status(400).json({ error: "elementIds required" });
        const instances = semanticManager.getModel().instances || [];
        let related = [];

        elementIds.forEach(eid => {
            if (!relationshiptype || relationshiptype.toLowerCase() === 'haschildren') {
                related.push(...instances.filter(i => i.parentId === eid));
            }
            if (!relationshiptype || relationshiptype.toLowerCase() === 'hasparent') {
                const obj = instances.find(i => i.elementId === eid);
                if (obj && obj.parentId) {
                    const parent = instances.find(i => i.elementId === obj.parentId);
                    if (parent) related.push(parent);
                }
            }
            if (!relationshiptype || relationshiptype.toLowerCase() === 'hascomponent') {
                related.push(...instances.filter(i => i.parentId === eid && i.relationships?.ComponentOf === eid));
            }
        });

        // Deduplicate and format
        const unique = Array.from(new Set(related.map(a => a.elementId)))
            .map(id => related.find(a => a.elementId === id));

        res.json(unique.map(i => ({
            elementId: i.elementId,
            displayName: i.displayName,
            typeId: i.typeId,
            namespaceUri: i.namespaceUri,
            parentId: i.parentId,
            isComposition: !!i.isComposition
        })));
    });

    // ==========================================
    // VALUE METHODS (RFC 4.2.1)
    // ==========================================

    const fetchValuesRecursive = async (elementId, maxDepth, currentDepth, startTime, endTime, isHistory) => {
        const instance = semanticManager.resolveElement(elementId);
        if (!instance) return null;

        let result = { data: [] };

        // Find mapping to MQTT topic
        const mapping = semanticManager.topicMappings.find(m => m.elementId === elementId);
        if (mapping) {
            // Fetch from DuckDB
            const sqlPattern = mapping.pattern.replace(/\+/g, '%').replace(/#/g, '%');
            let query = `SELECT payload, timestamp FROM mqtt_events WHERE topic LIKE ?`;
            let params = [sqlPattern];

            if (startTime) { query += ` AND timestamp >= CAST(? AS TIMESTAMPTZ)`; params.push(startTime); }
            if (endTime) { query += ` AND timestamp <= CAST(? AS TIMESTAMPTZ)`; params.push(endTime); }

            query += ` ORDER BY timestamp DESC`;
            if (!isHistory) query += ` LIMIT 1`;
            else query += ` LIMIT 1000`; // Safety limit for history

            try {
                const rows = await new Promise((resolve, reject) => {
                    db.all(query, ...params, (err, rows) => err ? reject(err) : resolve(rows));
                });

                if (rows && rows.length > 0) {
                    result.data = rows.map(r => formatVQT(r, isHistory)).filter(Boolean);
                }
            } catch(e) {
                i3xLogger.error({ err: e }, `Failed to fetch value for ${elementId}`);
            }
        }

        // Recurse if needed (maxDepth == 0 means infinite)
        const shouldRecurse = (maxDepth === 0 || currentDepth < maxDepth);
        if (shouldRecurse && instance.isComposition) {
            const children = semanticManager.getModel().instances.filter(i => i.parentId === elementId);
            for (const child of children) {
                const childResult = await fetchValuesRecursive(child.elementId, maxDepth, currentDepth + 1, startTime, endTime, isHistory);
                if (childResult) {
                    result[child.elementId] = childResult;
                }
            }
        }

        return result;
    };

    router.post('/objects/value', async (req, res) => {
        const { elementIds, maxDepth = 1 } = req.body;
        if (!elementIds || !Array.isArray(elementIds)) return res.status(400).json({ error: "elementIds array required" });

        let responseObj = {};
        for (const eid of elementIds) {
            const val = await fetchValuesRecursive(eid, maxDepth, 1, null, null, false);
            if (val) responseObj[eid] = val;
        }
        res.json(responseObj);
    });

    router.post('/objects/history', async (req, res) => {
        const { elementIds, maxDepth = 1, startTime, endTime } = req.body;
        if (!elementIds || !Array.isArray(elementIds)) return res.status(400).json({ error: "elementIds array required" });

        let responseObj = {};
        for (const eid of elementIds) {
            const val = await fetchValuesRecursive(eid, maxDepth, 1, startTime, endTime, true);
            if (val) responseObj[eid] = val;
        }
        res.json(responseObj);
    });

    // ==========================================
    // SUBSCRIPTIONS (RFC 4.2.3)
    // ==========================================
    const subscriptions = new Map(); // Map of subId -> { items: [], queue: [], res: null, maxDepth: 1 }

    router.post('/subscriptions', (req, res) => {
        const subId = `sub_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        subscriptions.set(subId, { items: [], queue: [], res: null, maxDepth: 1 });
        res.json({ subscriptionId: subId, message: "Subscription created successfully." });
    });

    router.post('/subscriptions/:id/register', (req, res) => {
        const sub = subscriptions.get(req.params.id);
        if (!sub) return res.status(404).json({ error: "Subscription not found" });
        const { elementIds, maxDepth = 1 } = req.body;
        if (!elementIds) return res.status(400).json({ error: "elementIds required" });
        
        sub.maxDepth = maxDepth;
        elementIds.forEach(eid => { if (!sub.items.includes(eid)) sub.items.push(eid); });
        res.json({ message: `Registered ${elementIds.length} objects.`, totalObjects: sub.items.length });
    });

    router.post('/subscriptions/:id/sync', (req, res) => {
        const sub = subscriptions.get(req.params.id);
        if (!sub) return res.status(404).json({ error: "Subscription not found" });
        const updates = [...sub.queue];
        sub.queue = [];
        res.json(updates);
    });

    router.get('/subscriptions/:id/stream', (req, res) => {
        const sub = subscriptions.get(req.params.id);
        if (!sub) return res.status(404).json({ error: "Subscription not found" });

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        sub.res = res;
        sub.queue = []; // Clear queue when streaming starts

        req.on('close', () => {
            sub.res = null; // Revert to queue mode if client disconnects
            i3xLogger.info(`Subscription ${req.params.id} stream closed. Reverting to queue mode.`);
        });
    });

    router.delete('/subscriptions/:id', (req, res) => {
        const subId = req.params.id;
        if (subscriptions.has(subId)) {
            const sub = subscriptions.get(subId);
            if (sub.res) sub.res.end();
            subscriptions.delete(subId);
            res.json({ success: true, message: "Unsubscribed." });
        } else {
            res.status(404).json({ error: "Subscription not found" });
        }
    });

    // Hook into internal event emitter for real-time updates
    if (i3xEvents) {
        i3xEvents.on('data', async ({ topic, payloadObject }) => {
            // Find matching semantic element
            const semanticMatch = semanticManager.resolveTopic(topic);
            if (!semanticMatch) return;
            const elementId = semanticMatch.elementId;

            // Format VQT
            let val = payloadObject;
            if (val && val._i3x) {
                val = { ...val };
                delete val._i3x;
            }
            const vqt = {
                value: val,
                quality: "Good",
                timestamp: new Date().toISOString()
            };

            const updateObj = { [elementId]: { data: [vqt] } };

            // Dispatch to active subscriptions
            for (const [subId, sub] of subscriptions.entries()) {
                if (sub.items.includes(elementId)) {
                    if (sub.res) {
                        sub.res.write(`data: ${JSON.stringify([updateObj])}\n\n`);
                        if (sub.res.flush) sub.res.flush();
                    } else {
                        sub.queue.push(updateObj);
                        if (sub.queue.length > 1000) sub.queue.shift(); // Max 1000 items in queue
                    }
                }
            }
        });
    }

    return router;
};