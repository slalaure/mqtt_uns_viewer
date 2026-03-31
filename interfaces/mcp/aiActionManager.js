const fs = require('fs');
const path = require('path');

class AiActionManager {
    constructor(dataDir) {
        this.historyDir = path.join(dataDir, 'ai_history');
        this.logFile = path.join(this.historyDir, 'history.json');
        this.history = [];
        this.init();
    }

    init() {
        if (!fs.existsSync(this.historyDir)) fs.mkdirSync(this.historyDir, { recursive: true });
        try {
            if (fs.existsSync(this.logFile)) {
                this.history = JSON.parse(fs.readFileSync(this.logFile, 'utf8'));
            }
        } catch (e) {
            this.history = [];
        }
    }

    logAction(user, toolName, args, originalState) {
        const action = {
            id: 'ai_act_' + Date.now() + '_' + Math.floor(Math.random()*1000),
            timestamp: new Date().toISOString(),
            user: user ? user.username : 'system',
            toolName,
            args,
            originalState // This can hold backup file paths, or JSON payloads of original rule state
        };
        this.history.unshift(action);
        if (this.history.length > 200) this.history.length = 200;
        this.save();
        return action;
    }

    save() {
        fs.writeFileSync(this.logFile, JSON.stringify(this.history, null, 2), 'utf8');
    }

    backupFile(filePath) {
        if (!fs.existsSync(filePath)) return null;
        const backupName = path.basename(filePath) + '.bkp.' + Date.now();
        const backupPath = path.join(this.historyDir, backupName);
        fs.copyFileSync(filePath, backupPath);
        return backupPath;
    }

    restoreFile(backupPath, originalPath) {
        if (backupPath && fs.existsSync(backupPath)) {
            fs.copyFileSync(backupPath, originalPath);
            return true;
        } else if (!backupPath && fs.existsSync(originalPath)) {
            // It was a creation, revert means delete
            fs.unlinkSync(originalPath);
            return true;
        }
        return false;
    }

    getHistory() {
        return this.history;
    }
}

module.exports = AiActionManager;
