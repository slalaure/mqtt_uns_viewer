/**
 * @license Apache License, Version 2.0 (the "License")
 */

import { confirmModal, showToast } from '../utils.js';

/**
 * Web Component for API Key Management in Admin Panel.
 */
class AdminApiKeysPanel extends HTMLElement {
    constructor() {
        super();
        this.apiKeys = [];
    }

    connectedCallback() {
        this.render();
        this.loadApiKeys();
    }

    async loadApiKeys() {
        const tableBody = this.querySelector('#admin-apikeys-table-body');
        if (!tableBody) return;

        tableBody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px;">Loading API keys...</td></tr>';
        try {
            const res = await fetch('api/admin/api_keys');
            if (!res.ok) throw new Error("Failed to fetch API keys.");
            this.apiKeys = await res.json();
            this.renderTable();
        } catch (e) {
            console.error("API Keys Load Error:", e);
            tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--color-danger); padding:20px;">Error: ${e.message}</td></tr>`;
        }
    }

    renderTable() {
        const tableBody = this.querySelector('#admin-apikeys-table-body');
        if (!tableBody) return;

        tableBody.innerHTML = '';
        if (this.apiKeys.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--color-text-secondary);">No API keys generated.</td></tr>';
            return;
        }

        this.apiKeys.forEach(k => {
            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid var(--color-border)';
            
            let scopesDisplay = "None";
            try {
                const s = typeof k.scopes === 'string' ? JSON.parse(k.scopes) : k.scopes;
                scopesDisplay = Array.isArray(s) ? s.join(', ') : "None";
            } catch(e) {}

            tr.innerHTML = `
                <td style="padding: 10px; font-weight: 500;">${k.name}</td>
                <td style="padding: 10px;"><code>${scopesDisplay}</code></td>
                <td style="padding: 10px; font-size: 0.85em; color: var(--color-text-secondary);">${new Date(k.created_at).toLocaleString()}</td>
                <td style="padding: 10px; font-size: 0.85em; color: var(--color-text-secondary);">${k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'Never'}</td>
                <td style="padding: 10px; text-align: center;">
                    <button class="tool-button button-danger btn-revoke-apikey" data-id="${k.id}">Revoke</button>
                </td>
            `;
            tableBody.appendChild(tr);
        });

        this.querySelectorAll('.btn-revoke-apikey').forEach(btn => {
            btn.onclick = () => this.revokeApiKey(btn.dataset.id);
        });
    }

    async revokeApiKey(id) {
        const isConfirmed = await confirmModal('Revoke API Key', `Are you sure you want to revoke this API key? This will immediately disconnect any application using it.`, 'Revoke', true);
        if (isConfirmed) {
            try {
                const res = await fetch(`api/admin/api_keys/${id}`, { method: 'DELETE' });
                if (res.ok) {
                    showToast("API key revoked.", "success");
                    this.loadApiKeys();
                }
            } catch (e) {
                showToast("Failed to revoke API key.", "error");
            }
        }
    }

    async onApiKeySubmit(e) {
        e.preventDefault();
        const form = e.target;
        const name = form.querySelector('#apikey-name').value;
        const scopesInput = form.querySelector('#apikey-scopes').value;
        const scopes = scopesInput.split(',').map(s => s.trim()).filter(s => s);

        try {
            const res = await fetch('api/admin/api_keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, scopes })
            });
            const data = await res.json();
            if (res.ok) {
                await confirmModal('API Key Generated', 
                    `Successfully created API key for '${name}'.\n\nAPI KEY: ${data.api_key}\n\nWARNING: Please copy this key now. It is hashed and will never be shown again.`, 
                    'I have copied it', false);
                form.reset();
                form.querySelector('#apikey-scopes').value = '#';
                this.loadApiKeys();
            } else {
                showToast(data.error || "Failed to generate key", "error");
            }
        } catch (e) {
            showToast("Failed to generate API key.", "error");
        }
    }

    render() {
        this.innerHTML = `
            <div class="payload-header" style="margin-bottom: 15px;">
                <div>
                    <h2 style="margin-bottom: 5px;">API Key Management</h2>
                    <p style="font-size: 0.9em; color: var(--color-text-secondary); margin: 0;">Generate and revoke API keys for external integrations via HTTP.</p>
                </div>
                <div style="display: flex; gap: 10px;">
                    <button id="btn-apikeys-refresh" class="mapper-button">Refresh List</button>
                </div>
            </div>
            <div style="background-color: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: 8px; padding: 20px; margin-bottom: 20px;">
                <h3 style="margin-top:0;">Generate New API Key</h3>
                <form id="apikey-register-form" style="display: flex; flex-direction: column; gap: 15px;">
                    <div style="display: grid; grid-template-columns: 1fr 2fr; gap: 15px;">
                        <div class="form-group" style="margin:0;">
                            <label>Application Name</label>
                            <input type="text" id="apikey-name" placeholder="e.g. ERP Integration" required style="width: 100%; padding: 8px; border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-bg);">
                        </div>
                        <div class="form-group" style="margin:0;">
                            <label>Allowed Topics (Scopes - Comma separated)</label>
                            <input type="text" id="apikey-scopes" placeholder="e.g. commands/#, factory/line1/+" value="#" required style="width: 100%; padding: 8px; border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-bg);">
                        </div>
                    </div>
                    <button type="submit" class="mapper-button button-primary" style="align-self: flex-start; padding: 10px 20px;">Generate Key</button>
                </form>
            </div>
            <div style="background-color: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: 4px; overflow: hidden;">
                <table style="width: 100%; border-collapse: collapse; text-align: left;">
                    <thead style="background-color: var(--color-bg-tertiary); border-bottom: 1px solid var(--color-border);">
                        <tr>
                            <th style="padding: 10px; font-weight: 500;">Application Name</th>
                            <th style="padding: 10px; font-weight: 500;">Scopes</th>
                            <th style="padding: 10px; font-weight: 500;">Created At</th>
                            <th style="padding: 10px; font-weight: 500;">Last Used</th>
                            <th style="padding: 10px; font-weight: 500; text-align: center;">Actions</th>
                        </tr>
                    </thead>
                    <tbody id="admin-apikeys-table-body">
                        <tr><td colspan="5" style="text-align:center; padding:20px;">Loading API keys...</td></tr>
                    </tbody>
                </table>
            </div>
        `;

        this.querySelector('#btn-apikeys-refresh').addEventListener('click', () => this.loadApiKeys());
        this.querySelector('#apikey-register-form').addEventListener('submit', (e) => this.onApiKeySubmit(e));
    }
}

customElements.define('admin-apikeys-panel', AdminApiKeysPanel);
