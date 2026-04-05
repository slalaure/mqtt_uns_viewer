/**
 * @license Apache License, Version 2.0 (the "License")
 */

import { confirmModal, showToast } from '../utils.js';

/**
 * Web Component for AI History in Admin Panel.
 */
class AdminAiPanel extends HTMLElement {
    constructor() {
        super();
        this.history = [];
    }

    async connectedCallback() {
        await this.render();
        this.loadAiHistory();
    }

    async loadAiHistory() {
        const tbody = this.querySelector('#admin-ai-history-tbody');
        if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px;">Loading history...</td></tr>';
        
        try {
            const res = await fetch('api/admin/ai_history');
            if (!res.ok) throw new Error("Failed to fetch AI history.");
            this.history = await res.json();
            this.renderTable();
        } catch (e) {
            console.error("AI History Load Error:", e);
            if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--color-danger); padding:20px;">Error: ${e.message}</td></tr>`;
        }
    }

    renderTable() {
        const tbody = this.querySelector('#admin-ai-history-tbody');
        if (!tbody) return;

        tbody.innerHTML = '';
        if (this.history.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px;">No AI actions found.</td></tr>';
            return;
        }

        this.history.forEach(item => {
            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid var(--color-border)';
            
            let details = '';
            try {
                const args = typeof item.args === 'string' ? JSON.parse(item.args) : item.args;
                if (item.tool === 'save_mapper_version') details = `Mapper: ${args.topic}`;
                else if (item.tool === 'delete_mapper_version') details = `Delete Mapper: ${args.topic}`;
                else if (item.tool === 'save_chart_config') details = `Chart: ${args.name}`;
                else details = JSON.stringify(args);
            } catch (e) { details = item.args; }

            tr.innerHTML = `
                <td style="padding: 10px; font-size: 0.85em; color: var(--color-text-secondary); white-space: nowrap;">${new Date(item.timestamp).toLocaleString()}</td>
                <td style="padding: 10px;">${item.username}</td>
                <td style="padding: 10px;"><code style="background:var(--color-bg-tertiary); padding:2px 4px; border-radius:3px;">${item.tool}</code></td>
                <td style="padding: 10px; font-size: 0.85em; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title='${details}'>${details}</td>
                <td style="padding: 10px; text-align: right;">
                    <button class="tool-button btn-revert-ai" data-id="${item.id}" ${item.reverted ? 'disabled' : ''}>${item.reverted ? 'Reverted' : 'Revert'}</button>
                </td>
            `;
            tbody.appendChild(tr);
        });

        this.querySelectorAll('.btn-revert-ai').forEach(btn => {
            if (!btn.disabled) {
                btn.onclick = () => this.revertAction(btn.dataset.id);
            }
        });
    }

    async revertAction(id) {
        const isConfirmed = await confirmModal('Revert AI Action', 'Are you sure you want to attempt to revert this action?', 'Revert', true);
        if (isConfirmed) {
            try {
                const res = await fetch(`api/admin/ai_history/${id}/revert`, { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    showToast("Action reverted successfully.", "success");
                    this.loadAiHistory();
                } else {
                    showToast("Revert failed: " + data.error, "error");
                }
            } catch (e) {
                showToast("Failed to revert action.", "error");
            }
        }
    }

    async render() {
        try {
            const response = await fetch(`components/templates/admin-ai-panel.html`);
            if (!response.ok) throw new Error(`Failed to load template: ${response.statusText}`);
            this.innerHTML = await response.text();
            this.querySelector('#btn-ai-history-refresh').onclick = () => this.loadAiHistory();
        } catch (error) {
            console.error("Error rendering AdminAiPanel:", error);
            this.innerHTML = `<div class="error" style="padding:20px; color:var(--color-danger);">Failed to load AI History UI</div>`;
        }
    }
}

customElements.define('admin-ai-panel', AdminAiPanel);
