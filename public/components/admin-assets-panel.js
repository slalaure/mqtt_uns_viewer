/**
 * @license Apache License, Version 2.0 (the "License")
 */

import { confirmModal, showToast } from '../utils.js';

/**
 * Web Component for HMI Assets Management in Admin Panel.
 */
class AdminAssetsPanel extends HTMLElement {
    constructor() {
        super();
        this.assets = [];
    }

    connectedCallback() {
        this.render();
        this.loadAssets();
    }

    async loadAssets() {
        const tableBody = this.querySelector('#admin-hmi-table-body');
        if (tableBody) tableBody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px;">Loading assets...</td></tr>';
        
        try {
            const res = await fetch('api/admin/hmi-assets');
            if (!res.ok) throw new Error("Failed to fetch assets list.");
            this.assets = await res.json();
            this.renderTable();
        } catch (e) {
            console.error("Assets Load Error:", e);
            if (tableBody) tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--color-danger); padding:20px;">Error: ${e.message}</td></tr>`;
        }
    }

    renderTable() {
        const tableBody = this.querySelector('#admin-hmi-table-body');
        if (!tableBody) return;

        tableBody.innerHTML = '';
        if (this.assets.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px;">No HMI assets found.</td></tr>';
            return;
        }

        this.assets.forEach(asset => {
            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid var(--color-border)';
            tr.innerHTML = `
                <td style="padding: 10px; font-weight: 500;">${asset.name}</td>
                <td style="padding: 10px; font-size: 0.85em; color: var(--color-text-secondary);">${asset.type}</td>
                <td style="padding: 10px; font-size: 0.85em; color: var(--color-text-secondary);">${(asset.size / 1024).toFixed(1)} KB</td>
                <td style="padding: 10px; font-size: 0.85em; color: var(--color-text-secondary);">${new Date(asset.mtime).toLocaleString()}</td>
                <td style="padding: 10px; text-align: right;">
                    <button class="tool-button btn-edit-asset" data-name="${asset.name}" style="margin-right:5px;">Edit</button>
                    <button class="tool-button button-danger btn-delete-asset" data-name="${asset.name}">Delete</button>
                </td>
            `;
            tableBody.appendChild(tr);
        });

        this.querySelectorAll('.btn-edit-asset').forEach(btn => {
            btn.onclick = () => this.dispatchEvent(new CustomEvent('edit-asset', { 
                detail: { name: btn.dataset.name },
                bubbles: true,
                composed: true
            }));
        });

        this.querySelectorAll('.btn-delete-asset').forEach(btn => {
            btn.onclick = () => this.deleteAsset(btn.dataset.name);
        });
    }

    async deleteAsset(name) {
        const isConfirmed = await confirmModal('Delete Asset', `Are you sure you want to delete "${name}"?`, 'Delete', true);
        if (isConfirmed) {
            try {
                const res = await fetch(`api/admin/hmi-assets/${name}`, { method: 'DELETE' });
                const data = await res.json();
                if (data.success) {
                    showToast("Asset deleted successfully.", "success");
                    this.loadAssets();
                } else {
                    showToast("Error: " + data.error, "error");
                }
            } catch (e) {
                showToast("Failed to delete asset.", "error");
            }
        }
    }

    async onUploadAssets() {
        const input = this.querySelector('#hmi-upload-input');
        const status = this.querySelector('#hmi-upload-status');
        const btn = this.querySelector('#btn-upload-hmi');
        
        const files = input.files;
        if (files.length === 0) return showToast("Please select files to upload first.", "warning");

        const formData = new FormData();
        for (let i = 0; i < files.length; i++) {
            formData.append('hmi_assets', files[i]);
        }

        btn.disabled = true;
        btn.textContent = "Uploading...";
        if (status) status.textContent = "Uploading...";

        try {
            const response = await fetch('api/admin/upload-hmi', { method: 'POST', body: formData });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "Upload failed.");
            showToast(`${result.count} files uploaded successfully.`, "success");
            input.value = '';
            this.loadAssets();
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
                    <h2 style="margin-bottom: 5px;">HMI Assets Management</h2>
                    <p style="font-size: 0.9em; color: var(--color-text-secondary); margin: 0;">Manage Global 3D Models, Scripts, SVGs, and HTML views.</p>
                </div>
                <button id="btn-hmi-refresh" class="mapper-button">Refresh List</button>
            </div>
            <div style="background-color: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: 8px; padding: 20px; margin-bottom: 20px;">
                <h3 style="margin-top:0;">Upload New Assets</h3>
                <div style="display: flex; gap: 10px; align-items: center;">
                    <input type="file" id="hmi-upload-input" accept=".html,.htm,.svg,.js,.glb,.gltf,.bin,.png,.jpg,.jpeg" multiple style="flex:1;">
                    <button id="btn-upload-hmi" class="mapper-button button-primary">Upload Files</button>
                </div>
                <div id="hmi-upload-status" style="margin-top: 10px; font-size: 0.9em; font-weight: 500;"></div>
            </div>
            <div style="background-color: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: 4px; overflow: hidden;">
                <table style="width: 100%; border-collapse: collapse; text-align: left;">
                    <thead style="background-color: var(--color-bg-tertiary); border-bottom: 1px solid var(--color-border);">
                        <tr>
                            <th style="padding: 10px; font-weight: 500;">Filename</th>
                            <th style="padding: 10px; font-weight: 500;">Type</th>
                            <th style="padding: 10px; font-weight: 500;">Size</th>
                            <th style="padding: 10px; font-weight: 500;">Last Modified</th>
                            <th style="padding: 10px; text-align: right; font-weight: 500;">Actions</th>
                        </tr>
                    </thead>
                    <tbody id="admin-hmi-table-body">
                        <tr><td colspan="5" style="text-align:center; padding:20px;">Loading assets...</td></tr>
                    </tbody>
                </table>
            </div>
        `;

        this.querySelector('#btn-hmi-refresh').onclick = () => this.loadAssets();
        this.querySelector('#btn-upload-hmi').onclick = () => this.onUploadAssets();
    }
}

customElements.define('admin-assets-panel', AdminAssetsPanel);
