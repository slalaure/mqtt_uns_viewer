/**
 * @license Apache License, Version 2.0 (the "License")
 */

import { confirmModal, showToast } from '../utils.js';

/**
 * Web Component for User Management in Admin Panel.
 */
class AdminUsersPanel extends HTMLElement {
    constructor() {
        super();
        this.users = [];
    }

    connectedCallback() {
        this.render();
        this.loadUsers();
    }

    async loadUsers() {
        const tableBody = this.querySelector('#admin-users-table-body');
        if (!tableBody) return;

        tableBody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px;">Loading users...</td></tr>';
        try {
            const res = await fetch('api/admin/users');
            if (!res.ok) throw new Error("Failed to fetch users list.");
            this.users = await res.json();
            this.renderTable();
        } catch (e) {
            console.error("Users Load Error:", e);
            tableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--color-danger); padding:20px;">Error: ${e.message}</td></tr>`;
        }
    }

    renderTable() {
        const tableBody = this.querySelector('#admin-users-table-body');
        if (!tableBody) return;

        tableBody.innerHTML = '';
        if (this.users.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px;">No users found.</td></tr>';
            return;
        }

        const roles = ['viewer', 'operator', 'engineer', 'admin'];

        this.users.forEach(u => {
            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid var(--color-border)';
            const isSelf = window.currentUser && window.currentUser.id === u.id;
            
            const roleOptions = roles.map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r.toUpperCase()}</option>`).join('');

            tr.innerHTML = `
                <td style="padding: 10px; font-weight: 500;">${u.username || '<span style="font-style:italic; color:gray;">(Google)</span>'}</td>
                <td style="padding: 10px;">${u.display_name || '-'}</td>
                <td style="padding: 10px; color: var(--color-text-secondary);">${u.email || '-'}</td>
                <td style="padding: 10px;">
                    <select class="role-select" data-id="${u.id}" ${isSelf ? 'disabled' : ''} style="background:var(--color-bg-tertiary); color:var(--color-text-primary); border:1px solid var(--color-border); border-radius:4px; padding:2px 4px;">
                        ${roleOptions}
                    </select>
                </td>
                <td style="padding: 10px; font-size: 0.85em; color: var(--color-text-secondary);">${u.last_login ? new Date(u.last_login).toLocaleString() : 'Never'}</td>
                <td style="padding: 10px; text-align: right;">
                    <button class="tool-button button-danger btn-delete-user" 
                        data-id="${u.id}" 
                        data-username="${u.username || u.display_name}" 
                        ${isSelf ? 'disabled title="You cannot delete yourself"' : ''}
                        style="${isSelf ? 'opacity: 0.5; cursor: not-allowed;' : ''}">Delete</button>
                </td>
            `;
            tableBody.appendChild(tr);
        });

        this.querySelectorAll('.role-select').forEach(select => {
            select.onchange = (e) => this.updateUserRole(select.dataset.id, e.target.value);
        });

        this.querySelectorAll('.btn-delete-user').forEach(btn => {
            if (!btn.disabled) {
                btn.onclick = () => this.deleteUser(btn.dataset.id, btn.dataset.username);
            }
        });
    }

    async updateUserRole(id, newRole) {
        try {
            const res = await fetch(`api/admin/users/${id}/role`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: newRole })
            });
            const data = await res.json();
            if (data.success) {
                showToast("User role updated successfully.", "success");
            } else {
                showToast("Error: " + data.error, "error");
                this.loadUsers(); // Refresh to original value
            }
        } catch (e) {
            showToast("Failed to update role.", "error");
            this.loadUsers();
        }
    }

    async deleteUser(id, username) {
        const isConfirmed = await confirmModal('Delete User', 
            `⚠️ WARNING: Are you sure you want to delete user "${username}"?\n\nThis will permanently delete their account AND all their saved data (charts, mapper configs, history).`, 
            'Delete', true);
        
        if (isConfirmed) {
            try {
                const res = await fetch(`api/admin/users/${id}`, { method: 'DELETE' });
                const data = await res.json();
                if (data.success) {
                    showToast("User and associated data deleted successfully.", "success");
                    this.loadUsers();
                } else {
                    showToast("Error: " + data.error, "error");
                }
            } catch (e) {
                showToast("Failed to delete user.", "error");
            }
        }
    }

    render() {
        this.innerHTML = `
            <div class="payload-header" style="margin-bottom: 15px;">
                <h2>User Management</h2>
                <button id="btn-admin-refresh" class="mapper-button">Refresh List</button>
            </div>
            <div style="background-color: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: 4px; overflow: hidden;">
                <table style="width: 100%; border-collapse: collapse; text-align: left;">
                    <thead style="background-color: var(--color-bg-tertiary); border-bottom: 1px solid var(--color-border);">
                        <tr>
                            <th style="padding: 10px; font-weight: 500;">Username</th>
                            <th style="padding: 10px; font-weight: 500;">Display Name</th>
                            <th style="padding: 10px; font-weight: 500;">Email</th>
                            <th style="padding: 10px; font-weight: 500;">Role</th>
                            <th style="padding: 10px; font-weight: 500;">Last Login</th>
                            <th style="padding: 10px; text-align: right; font-weight: 500;">Actions</th>
                        </tr>
                    </thead>
                    <tbody id="admin-users-table-body">
                        <tr><td colspan="6" style="text-align:center; padding:20px;">Loading users...</td></tr>
                    </tbody>
                </table>
            </div>
        `;

        this.querySelector('#btn-admin-refresh').addEventListener('click', () => this.loadUsers());
    }
}

customElements.define('admin-users-panel', AdminUsersPanel);
