/**
 * @license Apache License, Version 2.0 (the "License")
 */

import { confirmModal, showToast } from '../utils.js';

/**
 * Web Component for Webhooks Management in Admin Panel.
 */
class AdminWebhooksPanel extends HTMLElement {
    constructor() {
        super();
        this.webhooks = [];
    }

    connectedCallback() {
        this.render();
        this.loadWebhooks();
    }

    async loadWebhooks() {
        const tableBody = this.querySelector('#admin-webhooks-table-body');
        if (!tableBody) return;
        
        tableBody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px;">Loading webhooks...</td></tr>';
        try {
            const res = await fetch('api/admin/webhooks');
            if (!res.ok) throw new Error("Failed to fetch webhooks list.");
            this.webhooks = await res.json();
            this.renderTable();
        } catch (e) {
            console.error("Webhooks Load Error:", e);
            tableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--color-danger); padding: 20px;">Error: ${e.message}</td></tr>`;
        }
    }

    renderTable() {
        const tableBody = this.querySelector('#admin-webhooks-table-body');
        if (!tableBody) return;

        tableBody.innerHTML = '';
        if (this.webhooks.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px;">No webhooks registered.</td></tr>';
            return;
        }

        this.webhooks.forEach(w => {
            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid var(--color-border)';
            tr.innerHTML = `
                <td style="padding: 10px; font-family: monospace; font-size: 0.85em; color: var(--color-text-secondary);">${w.id}</td>
                <td style="padding: 10px; font-weight: 500;">${w.topic}</td>
                <td style="padding: 10px; font-size: 0.9em; word-break: break-all;">${w.url}</td>
                <td style="padding: 10px;">${w.min_interval_ms}ms</td>
                <td style="padding: 10px; font-size: 0.85em; color: var(--color-text-secondary);">${w.last_triggered ? new Date(w.last_triggered).toLocaleString() : 'Never'}</td>
                <td style="padding: 10px; text-align: right; white-space: nowrap;">
                    <button class="tool-button button-primary btn-test-webhook" data-id="${w.id}">Test</button>
                    <button class="tool-button button-danger btn-delete-webhook" data-id="${w.id}">Delete</button>
                </td>
            `;
            tableBody.appendChild(tr);
        });

        // Add event listeners for table buttons
        this.querySelectorAll('.btn-test-webhook').forEach(btn => {
            btn.onclick = () => this.onTestWebhook(btn.dataset.id);
        });
        this.querySelectorAll('.btn-delete-webhook').forEach(btn => {
            btn.onclick = () => this.onDeleteWebhook(btn.dataset.id);
        });
    }

    async onTestWebhook(id) {
        try {
            const res = await fetch(`api/admin/webhooks/${id}/test`, { method: 'POST' });
            if (res.ok) {
                showToast("Test trigger sent. Check your webhook target.", "success");
                setTimeout(() => this.loadWebhooks(), 2000);
            }
        } catch (e) {
            showToast("Failed to test webhook.", "error");
        }
    }

    async onDeleteWebhook(id) {
        const isConfirmed = await confirmModal('Delete Webhook', `Are you sure you want to delete webhook ${id}?`, 'Delete', true);
        if (isConfirmed) {
            try {
                const res = await fetch(`api/admin/webhooks/${id}`, { method: 'DELETE' });
                if (res.ok) {
                    showToast("Webhook deleted.", "success");
                    this.loadWebhooks();
                }
            } catch (e) {
                showToast("Failed to delete webhook.", "error");
            }
        }
    }

    async onRegisterWebhook(e) {
        e.preventDefault();
        const form = e.target;
        const topic = form.querySelector('#webhook-topic').value;
        const url = form.querySelector('#webhook-url').value;
        const interval = form.querySelector('#webhook-interval').value;

        try {
            const res = await fetch('api/admin/webhooks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ topic, url, min_interval_ms: parseInt(interval) })
            });
            if (res.ok) {
                showToast("Webhook registered successfully.", "success");
                form.reset();
                this.loadWebhooks();
            }
        } catch (e) {
            showToast("Failed to register webhook.", "error");
        }
    }

    async onClearWebhooks() {
        const isConfirmed = await confirmModal('Clear All Webhooks', '⚠️ Are you sure you want to delete ALL webhooks?', 'Clear All', true);
        if (isConfirmed) {
            try {
                const res = await fetch('api/admin/webhooks/clear', { method: 'POST' });
                if (res.ok) {
                    showToast("All webhooks cleared.", "success");
                    this.loadWebhooks();
                }
            } catch (e) {
                showToast("Failed to clear webhooks.", "error");
            }
        }
    }

    render() {
        this.innerHTML = `
            <div class="payload-header" style="margin-bottom: 15px;">
                <div>
                    <h2 style="margin-bottom: 5px;">Webhooks Subscriptions</h2>
                    <p style="font-size: 0.9em; color: var(--color-text-secondary); margin: 0;">Register and manage HTTP callbacks for real-time events.</p>
                </div>
                <div style="display: flex; gap: 10px;">
                    <button id="btn-webhooks-refresh" class="mapper-button">Refresh List</button>
                    <button id="btn-webhooks-clear" class="danger-button">Clear All</button>
                </div>
            </div>
            <div style="background-color: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: 8px; padding: 20px; margin-bottom: 20px;">
                <h3 style="margin-top:0;">Register New Webhook</h3>
                <form id="webhook-register-form" style="display: flex; flex-direction: column; gap: 15px;">
                    <div style="display: grid; grid-template-columns: 1fr 2fr 1fr; gap: 15px;">
                        <div class="form-group" style="margin:0;">
                            <label>Topic Pattern</label>
                            <input type="text" id="webhook-topic" placeholder="factory/line1/#" required style="width: 100%; padding: 8px; border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-bg);">
                        </div>
                        <div class="form-group" style="margin:0;">
                            <label>Webhook URL</label>
                            <input type="url" id="webhook-url" placeholder="https://api.my-app.com/webhook" required style="width: 100%; padding: 8px; border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-bg);">
                        </div>
                        <div class="form-group" style="margin:0;">
                            <label>Anti-flood (ms)</label>
                            <input type="number" id="webhook-interval" value="1000" min="0" required style="width: 100%; padding: 8px; border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-bg);">
                        </div>
                    </div>
                    <button type="submit" class="mapper-button button-primary" style="align-self: flex-start; padding: 10px 20px;">Add Webhook</button>
                </form>
            </div>
            <div style="background-color: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: 4px; overflow: hidden;">
                <table style="width: 100%; border-collapse: collapse; text-align: left;">
                    <thead style="background-color: var(--color-bg-tertiary); border-bottom: 1px solid var(--color-border);">
                        <tr>
                            <th style="padding: 10px; font-weight: 500;">ID</th>
                            <th style="padding: 10px; font-weight: 500;">Topic Pattern</th>
                            <th style="padding: 10px; font-weight: 500;">URL</th>
                            <th style="padding: 10px; font-weight: 500;">Interval</th>
                            <th style="padding: 10px; font-weight: 500;">Last Triggered</th>
                            <th style="padding: 10px; text-align: right; font-weight: 500;">Actions</th>
                        </tr>
                    </thead>
                    <tbody id="admin-webhooks-table-body">
                        <tr><td colspan="6" style="text-align:center; padding:20px;">Loading webhooks...</td></tr>
                    </tbody>
                </table>
            </div>
        `;

        this.querySelector('#btn-webhooks-refresh').addEventListener('click', () => this.loadWebhooks());
        this.querySelector('#btn-webhooks-clear').addEventListener('click', () => this.onClearWebhooks());
        this.querySelector('#webhook-register-form').addEventListener('submit', (e) => this.onRegisterWebhook(e));
    }
}

customElements.define('admin-webhooks-panel', AdminWebhooksPanel);
