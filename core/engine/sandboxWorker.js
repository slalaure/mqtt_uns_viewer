const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');

/**
 * Sandbox Worker Script
 * Runs in a separate thread with strict resource limits (Memory, CPU).
 */

parentPort.on('message', async (task) => {
    const { id, code, contextData, timeout } = task;

    try {
        // Create the sandbox context
        const context = vm.createContext({
            msg: contextData.msg,
            console: {
                log: (...args) => parentPort.postMessage({ type: 'log', id, level: 'info', args }),
                warn: (...args) => parentPort.postMessage({ type: 'log', id, level: 'warn', args }),
                error: (...args) => parentPort.postMessage({ type: 'log', id, level: 'error', args })
            },
            db: {
                all: (sql) => new Promise((resolve, reject) => {
                    const taskId = Math.random().toString(36).substring(7);
                    const handler = (msg) => {
                        if (msg.type === 'db_result' && msg.taskId === taskId) {
                            parentPort.off('message', handler);
                            if (msg.error) reject(new Error(msg.error));
                            else resolve(msg.result);
                        }
                    };
                    parentPort.on('message', handler);
                    parentPort.postMessage({ type: 'db_query', id, method: 'all', sql, taskId });
                }),
                get: (sql) => new Promise((resolve, reject) => {
                    const taskId = Math.random().toString(36).substring(7);
                    const handler = (msg) => {
                        if (msg.type === 'db_result' && msg.taskId === taskId) {
                            parentPort.off('message', handler);
                            if (msg.error) reject(new Error(msg.error));
                            else resolve(msg.result);
                        }
                    };
                    parentPort.on('message', handler);
                    parentPort.postMessage({ type: 'db_query', id, method: 'get', sql, taskId });
                })
            }
        });

        const script = new vm.Script(code);
        const result = await script.runInContext(context, { timeout });

        parentPort.postMessage({ type: 'result', id, result });
    } catch (err) {
        parentPort.postMessage({ type: 'error', id, error: err.message, stack: err.stack });
    }
});
