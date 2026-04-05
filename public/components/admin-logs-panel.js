/**
 * @license Apache License, Version 2.0 (the "License")
 */

/**
 * Web Component for System Logs in Admin Panel.
 */
class AdminLogsPanel extends HTMLElement {
    constructor() {
        super();
    }

    connectedCallback() {
        this.render();
        this.loadSystemLogs();
    }

    async loadSystemLogs() {
        const logsContent = this.querySelector('#admin-logs-content');
        if (logsContent) logsContent.textContent = 'Loading logs...';
        
        try {
            const res = await fetch('api/admin/logs');
            const data = await res.json();
            if (logsContent) {
                logsContent.textContent = data.logs || 'No logs found.';
                logsContent.scrollTop = logsContent.scrollHeight;
            }
        } catch (e) {
            console.error("Logs Load Error:", e);
            if (logsContent) logsContent.textContent = 'Error loading logs.';
        }
    }

    render() {
        this.innerHTML = `
            <div class="payload-header" style="margin-bottom: 15px;">
                <div>
                    <h2 style="margin-bottom: 5px;">System Logs</h2>
                    <p style="font-size: 0.9em; color: var(--color-text-secondary); margin: 0;">View the last 500 lines of backend and frontend logs.</p>
                </div>
                <button id="btn-logs-refresh" class="mapper-button">Refresh Logs</button>
            </div>
            <div style="background-color: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: 8px; padding: 20px;">
                <pre id="admin-logs-content" style="background-color: var(--color-code-bg); color: var(--color-code-text); padding: 15px; border-radius: 4px; height: 500px; overflow-y: auto; font-family: 'Courier New', Courier, monospace; font-size: 0.85em; white-space: pre-wrap; word-wrap: break-word;">Loading logs...</pre>
            </div>
        `;

        this.querySelector('#btn-logs-refresh').onclick = () => this.loadSystemLogs();
    }
}

customElements.define('admin-logs-panel', AdminLogsPanel);
