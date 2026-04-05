/**
 * @license Apache License, Version 2.0 (the "License")
 */

import { confirmModal, showToast } from '../utils.js';

/**
 * Web Component for Database Maintenance in Admin Panel.
 */
class AdminDbPanel extends HTMLElement {
    constructor() {
        super();
        this.dlqCount = 0;
    }

    connectedCallback() {
        this.render();
        this.loadDlqStatus();
    }

    async loadDlqStatus() {
        try {
            const res = await fetch('api/admin/dlq/status');
            const data = await res.json();
            this.dlqCount = data.count || 0;
            const dlqCountEl = this.querySelector('#stats-dlq-count');
            const btnReplayDlq = this.querySelector('#btn-replay-dlq');
            const btnClearDlq = this.querySelector('#btn-clear-dlq');

            if (dlqCountEl) dlqCountEl.textContent = this.dlqCount;
            if (btnReplayDlq) btnReplayDlq.disabled = (this.dlqCount === 0);
            if (btnClearDlq) btnClearDlq.disabled = (this.dlqCount === 0);
        } catch (e) {
            console.error("DLQ Status Error:", e);
        }
    }

    async onImportDB() {
        const importInput = this.querySelector('#db-import-input');
        const btnImportDb = this.querySelector('#btn-import-db');
        const importStatus = this.querySelector('#db-import-status');
        
        const file = importInput.files[0];
        if (!file) return showToast("Please select a JSON export file first.", "warning");
        const isConfirmed = await confirmModal('Import Database', `Import data from '${file.name}'?`, 'Import', false);
        if (!isConfirmed) return;

        const formData = new FormData();
        formData.append('db_import', file);
        btnImportDb.disabled = true;
        btnImportDb.textContent = "Importing...";
        if (importStatus) importStatus.textContent = "Uploading & Processing...";

        try {
            const response = await fetch('api/admin/import-db', { method: 'POST', body: formData });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "Import failed.");
            showToast(result.message, "success");
            importInput.value = '';
        } catch (e) {
            showToast(`Import Error: ${e.message}`, "error");
        } finally {
            btnImportDb.disabled = false;
            btnImportDb.textContent = "Import Data";
            if (importStatus) importStatus.textContent = '';
        }
    }

    async onResetDB() {
        const isConfirmed = await confirmModal('Reset Database', '⚠️ WARNING: This will permanently DELETE ALL DATA.\n\nAre you sure?', 'Reset DB', true);
        if (!isConfirmed) return;
        
        const btnResetDb = this.querySelector('#btn-reset-db');
        btnResetDb.disabled = true;
        btnResetDb.textContent = "Resetting...";
        try {
            const response = await fetch('api/admin/reset-db', { method: 'POST' });
            if (!response.ok) throw new Error("Reset failed.");
            showToast("Database reset successfully!", "success");
        } catch (e) {
            showToast(`Reset Error: ${e.message}`, "error");
        } finally {
            btnResetDb.disabled = false;
            btnResetDb.textContent = "Reset Database to 0";
        }
    }

    async onReplayDlq() {
        try {
            const res = await fetch('api/admin/dlq/replay', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                showToast(`Replay started: ${data.message}`, "success");
                this.loadDlqStatus();
            } else {
                showToast("Error replaying DLQ: " + data.error, "error");
            }
        } catch (e) {
            showToast("Failed to replay DLQ.", "error");
        }
    }

    async onClearDlq() {
        const isConfirmed = await confirmModal('Clear DLQ', 'Are you sure you want to PERMANENTLY delete all failed messages in the DLQ?', 'Clear DLQ', true);
        if (!isConfirmed) return;
        try {
            const res = await fetch('api/admin/dlq/clear', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                showToast("DLQ cleared successfully.", "success");
                this.loadDlqStatus();
            } else {
                showToast("Error clearing DLQ: " + data.error, "error");
            }
        } catch (e) {
            showToast("Failed to clear DLQ.", "error");
        }
    }

    render() {
        this.innerHTML = `
            <div style="max-width: 800px; margin: 0 auto;">
                <h2>Database Maintenance</h2>
                <p style="color: var(--color-text-secondary); margin-bottom: 20px;">
                    Manage the embedded DuckDB database containing the MQTT history.
                </p>
                <div style="background-color: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: 8px; padding: 20px; margin-bottom: 20px;">
                    <h3 style="margin-top:0;">Import History (JSON)</h3>
                    <p style="font-size: 0.9em; margin-bottom: 15px;">
                        Import offline history data. This will be queued for insertion.
                    </p>
                    <div style="display: flex; gap: 10px; align-items: center;">
                        <input type="file" id="db-import-input" accept=".json" style="flex:1;">
                        <button id="btn-import-db" class="mapper-button" style="background-color: var(--color-primary); color: white;">Import Data</button>
                    </div>
                    <div id="db-import-status" style="margin-top: 10px; font-size: 0.9em;"></div>
                </div>
                
                <div style="background-color: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: 8px; padding: 20px; margin-bottom: 20px;">
                    <h3 style="margin-top:0;">Dead Letter Queue (DLQ) Recovery</h3>
                    <p style="font-size: 0.9em; margin-bottom: 15px;">
                        Manage messages that failed to insert into the database during transient errors or schema mismatches.
                    </p>
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; background-color: var(--color-bg-tertiary); padding: 10px; border-radius: 4px; border: 1px solid var(--color-border);">
                        <div>
                            <strong>Failed Messages in DLQ:</strong> <span id="stats-dlq-count" style="font-weight:bold; font-size: 1.1em; margin-left: 5px;">--</span>
                        </div>
                    </div>
                    <div style="display: flex; gap: 10px; align-items: center;">
                        <button id="btn-replay-dlq" class="mapper-button button-primary" style="flex: 1;" disabled>Replay Failed Messages</button>
                        <button id="btn-clear-dlq" class="danger-button" style="flex: 1;" disabled>Clear DLQ</button>
                    </div>
                    <div id="dlq-status-message" style="margin-top: 10px; font-size: 0.9em; text-align: center;"></div>
                </div>

                <div style="background-color: rgba(220, 53, 69, 0.05); border: 1px solid var(--color-danger); border-radius: 8px; padding: 20px;">
                    <h3 style="margin-top:0; color: var(--color-danger);">⚠️ Danger Zone</h3>
                    <p style="font-size: 0.9em; margin-bottom: 15px;">
                        Permanently delete ALL recorded MQTT history. This cannot be undone.
                    </p>
                    <div style="display: flex; gap: 15px; align-items: center;">
                        <button id="btn-reset-db" class="danger-button" style="padding: 10px 20px;">Reset Database to 0</button>
                        <span id="reset-db-status" style="font-weight: bold;"></span>
                    </div>
                </div>
            </div>
        `;

        this.querySelector('#btn-import-db').onclick = () => this.onImportDB();
        this.querySelector('#btn-reset-db').onclick = () => this.onResetDB();
        this.querySelector('#btn-replay-dlq').onclick = () => this.onReplayDlq();
        this.querySelector('#btn-clear-dlq').onclick = () => this.onClearDlq();
    }
}

customElements.define('admin-db-panel', AdminDbPanel);
