const express = require('express');
const path = require('path');
const AiActionManager = require('../mcp/aiActionManager');

module.exports = () => {
    const router = express.Router();
    const DATA_DIR = path.join(__dirname, '../../data');
    const aiActionManager = new AiActionManager(DATA_DIR);

    router.get('/', (req, res, next) => {
        try {
            res.json(aiActionManager.getHistory());
        } catch (err) {
            next(err);
        }
    });

    router.post('/:id/revert', async (req, res, next) => {
        const actionId = req.params.id;
        const action = aiActionManager.getHistory().find(a => a.id === actionId);
        
        if (!action) return res.status(404).json({ error: "Action not found" });
        if (!action.originalState) return res.status(400).json({ error: "No backup available for this action." });

        try {
            const { toolName, originalState } = action;
            if (toolName === 'create_hmi_view') {
                aiActionManager.restoreFile(originalState.hmiBackup, originalState.hmiPath);
                aiActionManager.restoreFile(originalState.jsBackup, originalState.jsPath);
                return res.json({ success: true, message: "HMI files reverted." });
            } else if (toolName === 'save_file_to_data_directory' || toolName === 'update_uns_model') {
                aiActionManager.restoreFile(originalState.backupPath, originalState.originalPath);
                return res.json({ success: true, message: "File reverted." });
            } else {
                return res.json({ error: "Revert from Web UI only supports files currently. For mappers/alerts, use Chat Assistant ('Revert the last action')." });
            }
        } catch(e) {
            next(e);
        }
    });

    return router;
};
