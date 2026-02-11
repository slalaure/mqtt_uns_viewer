/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * Admin View Module
 * Handles User Management, Database Maintenance, and Alerts Maintenance.
 * [UPDATED] Uses Async HTML Fragment Loading.
 */

let usersTableBody = null;
// --- Elements for Tabs ---
let subNavButtons = null;
// --- Elements for DB Maintenance ---
let btnImportDb = null;
let importInput = null;
let importStatus = null;
let btnResetDb = null;
let resetDbStatus = null;
// --- Elements for Alerts Maintenance ---
let resolvedCountEl = null;
let resolvedSizeEl = null;
let btnPurgeAlerts = null;
let purgeStatus = null;

let isViewInitialized = false;

/**
 * Initializes the Admin View elements by loading the HTML fragment.
 */
export async function initAdminView() {
    const container = document.getElementById('admin-view');
    if (!container) return;
    if (isViewInitialized) return;

    try {
        // 1. Fetch HTML Fragment
        const response = await fetch('html/view.admin.html');
        if (!response.ok) throw new Error(`Failed to load admin template: ${response.statusText}`);
        const htmlContent = await response.text();
        container.innerHTML = htmlContent;

        // 2. Initialize DOM References & Listeners AFTER injection
        initializeElements(container);
        isViewInitialized = true;
        console.log("✅ Admin View Initialized (Async HTML Load)");

    } catch (err) {
        console.error("Error initializing Admin View:", err);
        container.innerHTML = `<div style="padding:20px; color:red;">Error loading Admin Interface. Check console.</div>`;
    }
}

/**
 * Helper to attach listeners once HTML is in DOM.
 */
function initializeElements(container) {
    // 1. User Management Elements
    usersTableBody = document.getElementById('admin-users-table-body');
    const refreshBtn = document.getElementById('btn-admin-refresh');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadUsers);
    }

    // 2. Tab Navigation Logic
    subNavButtons = container.querySelectorAll('.sub-tab-button');
    const panelClass = 'alerts-content-container'; 
    subNavButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            // Remove active from all buttons
            subNavButtons.forEach(b => b.classList.remove('active'));
            // Hide all panels
            container.querySelectorAll(`.${panelClass}`).forEach(p => p.classList.remove('active'));
            // Activate clicked
            btn.classList.add('active');
            const targetId = btn.dataset.target;
            const targetPanel = document.getElementById(targetId);
            if (targetPanel) targetPanel.classList.add('active');
            
            // Load data based on tab
            if (targetId === 'admin-users-panel') loadUsers();
            if (targetId === 'admin-alerts-panel') loadResolvedStats();
        });
    });

    // 3. Database Maintenance Logic
    btnImportDb = document.getElementById('btn-import-db');
    importInput = document.getElementById('db-import-input');
    importStatus = document.getElementById('db-import-status');
    btnResetDb = document.getElementById('btn-reset-db');
    resetDbStatus = document.getElementById('reset-db-status');

    if (btnImportDb && importInput) {
        btnImportDb.addEventListener('click', onImportDB);
    }
    if (btnResetDb) {
        btnResetDb.addEventListener('click', onResetDB);
    }

    // 4. Alerts Maintenance Logic
    resolvedCountEl = document.getElementById('stats-resolved-count');
    resolvedSizeEl = document.getElementById('stats-resolved-size');
    btnPurgeAlerts = document.getElementById('btn-purge-alerts');
    purgeStatus = document.getElementById('purge-alerts-status');

    if (btnPurgeAlerts) {
        btnPurgeAlerts.addEventListener('click', onPurgeAlerts);
    }
}

/**
 * Called when the Admin tab is activated.
 */
export function onAdminViewShow() {
    if (!isViewInitialized) {
        // If user clicks tab before async fetch finishes, wait or retry?
        // Usually fetch is fast enough, but we can check.
        // initAdminView is called on app load, so usually it's ready.
        return;
    }

    const activeTab = document.querySelector('#admin-view .sub-tab-button.active');
    if (activeTab && activeTab.dataset.target === 'admin-alerts-panel') {
        loadResolvedStats();
    } else {
        loadUsers();
    }
}

/**
 * Fetches users from the API and renders them.
 */
async function loadUsers() {
    if (!usersTableBody) return;
    usersTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px;">Loading users...</td></tr>';
    
    try {
        const res = await fetch('api/admin/users');
        if (!res.ok) {
            if (res.status === 403) throw new Error("Access Denied: Admin privileges required.");
            throw new Error("Failed to fetch user list.");
        }
        const users = await res.json();
        renderUsers(users);
    } catch (e) {
        console.error("Admin Load Error:", e);
        usersTableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--color-danger); padding: 20px;">Error: ${e.message}</td></tr>`;
    }
}

/**
 * Renders the user table rows.
 * @param {Array} users 
 */
function renderUsers(users) {
    usersTableBody.innerHTML = '';
    if (users.length === 0) {
        usersTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No users found.</td></tr>';
        return;
    }

    users.forEach(user => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--color-border)';
        
        const lastLogin = user.last_login ? new Date(user.last_login).toLocaleString() : 'Never';
        const roleBadge = user.role === 'admin' 
            ? '<span style="background:var(--color-danger); color:white; padding:2px 6px; border-radius:4px; font-size:0.8em; font-weight:bold;">ADMIN</span>' 
            : '<span style="background:var(--color-success); color:white; padding:2px 6px; border-radius:4px; font-size:0.8em;">USER</span>';
        
        const isSelf = window.currentUser && window.currentUser.id === user.id;
        const deleteDisabled = isSelf ? 'disabled title="You cannot delete yourself"' : '';
        const deleteStyle = isSelf ? 'opacity: 0.5; cursor: not-allowed;' : '';

        tr.innerHTML = `
            <td style="padding: 10px;">${user.username || '<span style="font-style:italic; color:gray;">(Google)</span>'}</td>
            <td style="padding: 10px;">${user.display_name || '-'}</td>
            <td style="padding: 10px;">${user.email || '-'}</td>
            <td style="padding: 10px;">${roleBadge}</td>
            <td style="padding: 10px; font-size: 0.9em;">${lastLogin}</td>
            <td style="padding: 10px; text-align: right;">
                <button class="danger-button btn-delete-user" data-id="${user.id}" data-username="${user.username || user.display_name}" ${deleteDisabled} style="${deleteStyle}">Delete</button>
            </td>
        `;
        usersTableBody.appendChild(tr);
    });

    // Attach event listeners
    document.querySelectorAll('.btn-delete-user').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.target.dataset.id;
            const name = e.target.dataset.username;
            deleteUser(id, name);
        });
    });
}

/**
 * Handles user deletion.
 */
async function deleteUser(id, username) {
    if (!confirm(`⚠️ WARNING: Are you sure you want to delete user "${username}"?\n\nThis will permanently delete their account AND all their saved data (charts, mapper configs, history).`)) return;

    try {
        const res = await fetch(`api/admin/users/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            loadUsers(); // Refresh list
        } else {
            alert("Error: " + data.error);
        }
    } catch (e) {
        alert("Request failed: " + e.message);
    }
}

// --- Database Maintenance Functions ---

async function onImportDB() {
    const file = importInput.files[0];
    if (!file) {
        alert("Please select a JSON export file first.");
        return;
    }
    if (!confirm(`Import data from '${file.name}'?\nThis will be added to the existing history queue.`)) {
        return;
    }

    const formData = new FormData();
    formData.append('db_import', file);

    btnImportDb.disabled = true;
    btnImportDb.textContent = "Importing...";
    importStatus.textContent = "Uploading & Processing...";
    importStatus.style.color = "var(--color-text)";

    try {
        const response = await fetch('api/admin/import-db', {
            method: 'POST',
            body: formData
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || "Import failed.");
        }
        importStatus.textContent = result.message; 
        importStatus.style.color = 'var(--color-success)';
        importInput.value = ''; 
    } catch (e) {
        importStatus.textContent = `❌ Error: ${e.message}`;
        importStatus.style.color = 'var(--color-danger)';
    } finally {
        btnImportDb.disabled = false;
        btnImportDb.textContent = "Import Data";
        setTimeout(() => {
            if (importStatus.textContent.includes('Successfully')) {
                importStatus.textContent = '';
            }
        }, 5000);
    }
}

async function onResetDB() {
    const confirmed = confirm("⚠️ WARNING: This will permanently DELETE ALL DATA in the history database.\n\nAre you sure you want to reset the database to zero?");
    if (!confirmed) return;

    btnResetDb.disabled = true;
    btnResetDb.textContent = "Resetting...";
    resetDbStatus.textContent = "";

    try {
        const response = await fetch('api/admin/reset-db', {
            method: 'POST'
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || "Reset failed.");
        }
        resetDbStatus.textContent = "✅ Database reset successfully!";
        resetDbStatus.style.color = 'var(--color-success)';
    } catch (e) {
        resetDbStatus.textContent = `❌ Error: ${e.message}`;
        resetDbStatus.style.color = 'var(--color-danger)';
    } finally {
        btnResetDb.disabled = false;
        btnResetDb.textContent = "Reset Database to 0";
        setTimeout(() => { resetDbStatus.textContent = ''; }, 5000);
    }
}

// --- Alerts Maintenance Functions ---

async function loadResolvedStats() {
    if (!resolvedCountEl) return;
    try {
        const res = await fetch('api/alerts/admin/stats');
        const data = await res.json();
        if (data.count !== undefined) {
            resolvedCountEl.textContent = data.count;
            resolvedSizeEl.textContent = data.estimatedSizeMb;
        }
    } catch (e) {
        console.error("Failed to load alert stats", e);
    }
}

async function onPurgeAlerts() {
    if (!confirm("Are you sure you want to delete ALL resolved alerts?")) return;
    
    btnPurgeAlerts.disabled = true;
    btnPurgeAlerts.textContent = "Purging...";
    purgeStatus.textContent = "";

    try {
        const res = await fetch('api/alerts/admin/purge', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            purgeStatus.textContent = "✅ Alerts purged.";
            purgeStatus.style.color = "var(--color-success)";
            loadResolvedStats(); 
        } else {
            throw new Error(data.error);
        }
    } catch (e) {
        purgeStatus.textContent = "❌ Error: " + e.message;
        purgeStatus.style.color = "var(--color-danger)";
    } finally {
        btnPurgeAlerts.disabled = false;
        btnPurgeAlerts.textContent = "Purge Resolved Alerts";
        setTimeout(() => { purgeStatus.textContent = ''; }, 3000);
    }
}