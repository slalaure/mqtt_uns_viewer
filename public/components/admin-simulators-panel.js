/**
 * @license Apache License, Version 2.0 (the "License")
 */

import { confirmModal, showToast } from '../utils.js';

/**
 * Web Component for Simulators Management in Admin Panel.
 */
class AdminSimulatorsPanel extends HTMLElement {
    constructor() {
        super();
        this.simulators = [];
    }

    connectedCallback() {
        this.render();
        this.loadSimulators();
    }

    async loadSimulators() {
        const tableBody = this.querySelector('#admin-sim-table-body');
        if (tableBody) tableBody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px;">Loading simulators...</td></tr>';
        
        try {
            const res = await fetch('api/admin/simulators');
            if (!res.ok) throw new Error("Failed to fetch simulators list.");
            this.simulators = await res.json();
            this.renderTable();
        } catch (e) {
            console.error("Simulators Load Error:", e);
            if (tableBody) tableBody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--color-danger); padding:20px;">Error: ${e.message}</td></tr>`;
        }
    }

    renderTable() {
        const tableBody = this.querySelector('#admin-sim-table-body');
        if (!tableBody) return;

        tableBody.innerHTML = '';
        if (this.simulators.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px;">No simulators found.</td></tr>';
            return;
        }

        this.simulators.forEach(sim => {
            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid var(--color-border)';
            tr.innerHTML = `
                <td style="padding: 10px; font-weight: 500;">${sim.name}</td>
                <td style="padding: 10px; font-size: 0.85em; color: var(--color-text-secondary);">${(sim.size / 1024).toFixed(1)} KB</td>
                <td style="padding: 10px; font-size: 0.85em; color: var(--color-text-secondary);">${new Date(sim.mtime).toLocaleString()}</td>
                <td style="padding: 10px; text-align: right;">
                    <button class="tool-button btn-edit-sim" data-name="${sim.name}" style="margin-right:5px;">Edit</button>
                    <button class="tool-button button-danger btn-delete-sim" data-name="${sim.name}">Delete</button>
                </td>
            `;
            tableBody.appendChild(tr);
        });

        this.querySelectorAll('.btn-edit-sim').forEach(btn => {
            btn.onclick = () => this.dispatchEvent(new CustomEvent('edit-asset', { 
                detail: { name: btn.dataset.name },
                bubbles: true,
                composed: true
            }));
        });

        this.querySelectorAll('.btn-delete-sim').forEach(btn => {
            btn.onclick = () => this.deleteSimulator(btn.dataset.name);
        });
    }

    async deleteSimulator(name) {
        const isConfirmed = await confirmModal('Delete Simulator', `Are you sure you want to delete simulator "${name}"?`, 'Delete', true);
        if (isConfirmed) {
            try {
                const res = await fetch(`api/admin/simulators/${name}`, { method: 'DELETE' });
                const data = await res.json();
                if (data.success) {
                    showToast("Simulator deleted successfully.", "success");
                    this.loadSimulators();
                } else {
                    showToast("Error: " + data.error, "error");
                }
            } catch (e) {
                showToast("Failed to delete simulator.", "error");
            }
        }
    }

    async onUploadSimulators() {
        const input = this.querySelector('#sim-upload-input');
        const status = this.querySelector('#sim-upload-status');
        const btn = this.querySelector('#btn-upload-sim');
        
        const files = input.files;
        if (files.length === 0) return showToast("Please select .js files to upload first.", "warning");

        const formData = new FormData();
        for (let i = 0; i < files.length; i++) {
            formData.append('simulators', files[i]);
        }

        btn.disabled = true;
        btn.textContent = "Uploading...";
        if (status) status.textContent = "Uploading...";

        try {
            const response = await fetch('api/admin/upload-simulators', { method: 'POST', body: formData });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "Upload failed.");
            showToast(`${result.count} simulators uploaded successfully.`, "success");
            input.value = '';
            this.loadSimulators();
        } catch (e) {
            showToast(`Upload Error: ${e.message}`, "error");
        } finally {
            btn.disabled = false;
            btn.textContent = "Upload Files";
            if (status) status.textContent = '';
        }
    }

    render() {
        this.innerHTML = `
            <div class="payload-header" style="margin-bottom: 15px;">
                <div>
                    <h2 style="margin-bottom: 5px;">Simulators Management</h2>
                    <p style="font-size: 0.9em; color: var(--color-text-secondary); margin: 0;">Manage JavaScript simulator scenarios. Note: You must restart the server to detect new simulators.</p>
                </div>
                <button id="btn-sim-refresh" class="mapper-button">Refresh List</button>
            </div>
            <div style="background-color: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: 8px; padding: 20px; margin-bottom: 20px;">
                <h3 style="margin-top:0;">Upload New Simulator</h3>
                <div style="display: flex; gap: 10px; align-items: center;">
                    <input type="file" id="sim-upload-input" accept=".js" multiple style="flex:1;">
                    <button id="btn-upload-sim" class="mapper-button button-primary">Upload Files</button>
                </div>
                <div id="sim-upload-status" style="margin-top: 10px; font-size: 0.9em; font-weight: 500;"></div>
            </div>
            <div style="background-color: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: 4px; overflow: hidden;">
                <table style="width: 100%; border-collapse: collapse; text-align: left;">
                    <thead style="background-color: var(--color-bg-tertiary); border-bottom: 1px solid var(--color-border);">
                        <tr>
                            <th style="padding: 10px; font-weight: 500;">Filename</th>
                            <th style="padding: 10px; font-weight: 500;">Size</th>
                            <th style="padding: 10px; font-weight: 500;">Last Modified</th>
                            <th style="padding: 10px; text-align: right; font-weight: 500;">Actions</th>
                        </tr>
                    </thead>
                    <tbody id="admin-sim-table-body">
                        <tr><td colspan="4" style="text-align:center; padding:20px;">Loading simulators...</td></tr>
                    </tbody>
                </table>
            </div>
        `;

        this.querySelector('#btn-sim-refresh').onclick = () => this.loadSimulators();
        this.querySelector('#btn-upload-sim').onclick = () => this.onUploadSimulators();
    }
}

customElements.define('admin-simulators-panel', AdminSimulatorsPanel);
