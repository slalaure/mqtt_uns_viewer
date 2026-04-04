const { Worker } = require('worker_threads');
const path = require('path');
const os = require('os');

/**
 * Sandbox Worker Pool
 * Manages a pool of workers for executing untrusted JS code (Mapper/Alerts) with strict memory limits.
 */
class SandboxPool {
    constructor(logger, db) {
        this.logger = logger.child({ component: 'SandboxPool' });
        this.db = db;
        this.workers = [];
        this.queue = [];
        this.active = new Map(); // taskId -> { resolve, reject, timeout }
        this.poolSize = Math.max(1, Math.min(os.cpus().length - 1, 4));
        
        // Resource Limits per Worker
        this.resourceLimits = {
            maxOldGenerationSizeMb: 100, // Strict 100MB heap limit
            maxYoungGenerationSizeMb: 50,
            codeRangeSizeMb: 50
        };

        this.init();
    }

    init() {
        const workerScript = path.join(__dirname, 'sandboxWorker.js');
        for (let i = 0; i < this.poolSize; i++) {
            const worker = new Worker(workerScript, { resourceLimits: this.resourceLimits });
            
            worker.on('message', (msg) => this.handleWorkerMessage(worker, msg));
            worker.on('error', (err) => {
                this.logger.error({ err }, "Sandbox Worker Error (Potential Memory Limit Exceeded). Restarting...");
                this.respawnWorker(worker);
            });
            worker.on('exit', (code) => {
                if (code !== 0) this.logger.warn(`Sandbox Worker exited with code ${code}`);
                this.respawnWorker(worker);
            });

            this.workers.push({ worker, busy: false });
        }
        this.logger.info(`✅ Sandbox Pool initialized with ${this.poolSize} workers (Max Memory: 100MB each).`);
    }

    respawnWorker(oldWorker) {
        const index = this.workers.findIndex(w => w.worker === oldWorker);
        if (index === -1) return;

        // Reject any active tasks on this worker
        this.active.forEach((task, id) => {
            if (task.worker === oldWorker) {
                task.reject(new Error("Worker crashed (Memory limit or timeout)"));
                this.active.delete(id);
            }
        });

        const workerScript = path.join(__dirname, 'sandboxWorker.js');
        const newWorker = new Worker(workerScript, { resourceLimits: this.resourceLimits });
        newWorker.on('message', (msg) => this.handleWorkerMessage(newWorker, msg));
        newWorker.on('error', (err) => this.logger.error({ err }, "Respawned Sandbox Worker Error."));
        newWorker.on('exit', () => this.respawnWorker(newWorker));

        this.workers[index] = { worker: newWorker, busy: false };
        this.processQueue();
    }

    handleWorkerMessage(worker, msg) {
        const { id, type } = msg;
        const task = this.active.get(id);
        if (!task) return;

        switch (type) {
            case 'db_query':
                this.handleDbQuery(worker, id, msg);
                break;
            case 'result':
                task.resolve(msg.result);
                this.active.delete(id);
                this.releaseWorker(worker);
                break;
            case 'error':
                task.reject(new Error(msg.error));
                this.active.delete(id);
                this.releaseWorker(worker);
                break;
            case 'log':
                // Forward VM logs to main logger
                if (this.logger[msg.level]) {
                    this.logger[msg.level]({ vm_log: msg.args, taskId: id }, "Sandbox Log");
                }
                break;
        }
    }

    handleDbQuery(worker, taskId, msg) {
        const { method, sql, taskId: dbTaskId } = msg;
        if (!this.db) {
            worker.postMessage({ type: 'db_result', taskId: dbTaskId, error: "Database not ready" });
            return;
        }

        if (!sql.trim().toUpperCase().startsWith('SELECT')) {
            worker.postMessage({ type: 'db_result', taskId: dbTaskId, error: "Read-only access" });
            return;
        }

        this.db[method](sql, (err, result) => {
            worker.postMessage({ type: 'db_result', taskId: dbTaskId, error: err ? err.message : null, result });
        });
    }

    execute(code, contextData, timeout = 2000) {
        return new Promise((resolve, reject) => {
            const id = Math.random().toString(36).substring(7);
            this.queue.push({ id, code, contextData, timeout, resolve, reject });
            this.processQueue();
        });
    }

    processQueue() {
        if (this.queue.length === 0) return;

        const availableWorker = this.workers.find(w => !w.busy);
        if (!availableWorker) return;

        const task = this.queue.shift();
        availableWorker.busy = true;
        this.active.set(task.id, { 
            resolve: task.resolve, 
            reject: task.reject, 
            worker: availableWorker.worker 
        });

        availableWorker.worker.postMessage({
            id: task.id,
            code: task.code,
            contextData: task.contextData,
            timeout: task.timeout
        });
    }

    releaseWorker(worker) {
        const w = this.workers.find(w => w.worker === worker);
        if (w) w.busy = false;
        this.processQueue();
    }
}

module.exports = SandboxPool;
