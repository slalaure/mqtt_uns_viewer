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
 * Handles User Management, Database Maintenance, Alerts Maintenance, HMI Assets, Simulators, and Data Parsers.
 */
import { confirmModal } from './utils.js';
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
// --- Elements for HMI Assets Maintenance ---
let hmiAssetsTableBody = null;
let btnUploadHmi = null;
let hmiUploadInput = null;
let hmiUploadStatus = null;
let btnHmiRefresh = null;
// --- Elements for Simulators Maintenance ---
let simTableBody = null;
let btnUploadSim = null;
let simUploadInput = null;
let simUploadStatus = null;
let btnSimRefresh = null;
let webhooksTableBody = null;
let webhookRegisterForm = null;
let btnWebhooksRefresh = null;
let btnWebhooksClear = null;
let isViewInitialized = false;
// --- Elements for HMI/Simulator Code Editor ---
let adminAceEditor = null;
let currentEditingFilename = null;

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
        refreshBtn.className = 'tool-button';
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
            if (targetId === 'admin-assets-panel') loadHmiAssets();
            if (targetId === 'admin-simulators-panel') loadSimulators();
            if (targetId === 'admin-webhooks-panel') loadWebhooks();
            if (targetId === 'admin-ai-panel') loadAiHistory();
            // Data parsers panel doesn't require immediate fetch on load currently
        });
    });

    document.getElementById('btn-ai-history-refresh')?.addEventListener('click', loadAiHistory);
    // 3. Database Maintenance Logic
    btnImportDb = document.getElementById('btn-import-db');
    importInput = document.getElementById('db-import-input');
    importStatus = document.getElementById('db-import-status');
    btnResetDb = document.getElementById('btn-reset-db');
    resetDbStatus = document.getElementById('reset-db-status');
    if (btnImportDb && importInput) {
        btnImportDb.className = 'tool-button button-primary';
        btnImportDb.addEventListener('click', onImportDB);
    }
    if (btnResetDb) {
        btnResetDb.className = 'tool-button button-danger';
        btnResetDb.addEventListener('click', onResetDB);
    }
    // 4. Alerts Maintenance Logic
    resolvedCountEl = document.getElementById('stats-resolved-count');
    resolvedSizeEl = document.getElementById('stats-resolved-size');
    btnPurgeAlerts = document.getElementById('btn-purge-alerts');
    purgeStatus = document.getElementById('purge-alerts-status');
    if (btnPurgeAlerts) {
        btnPurgeAlerts.className = 'tool-button button-danger';
        btnPurgeAlerts.addEventListener('click', onPurgeAlerts);
    }
    // 5. HMI Assets Maintenance Logic
    hmiAssetsTableBody = document.getElementById('admin-hmi-table-body');
    btnUploadHmi = document.getElementById('btn-upload-hmi');
    hmiUploadInput = document.getElementById('hmi-upload-input');
    hmiUploadStatus = document.getElementById('hmi-upload-status');
    btnHmiRefresh = document.getElementById('btn-hmi-refresh');
    if (btnUploadHmi && hmiUploadInput) {
        btnUploadHmi.addEventListener('click', onUploadHmiAssets);
    }
    if (btnHmiRefresh) {
        btnHmiRefresh.addEventListener('click', loadHmiAssets);
    }
    // 6. Simulators Maintenance Logic
    simTableBody = document.getElementById('admin-sim-table-body');
    btnUploadSim = document.getElementById('btn-upload-sim');
    simUploadInput = document.getElementById('sim-upload-input');
    simUploadStatus = document.getElementById('sim-upload-status');
    btnSimRefresh = document.getElementById('btn-sim-refresh');
    if (btnUploadSim && simUploadInput) {
        btnUploadSim.addEventListener('click', onUploadSimulators);
    }
    if (btnSimRefresh) {
        btnSimRefresh.addEventListener('click', loadSimulators);
    }
    
    // 7. Webhooks Logic
    webhooksTableBody = document.getElementById('admin-webhooks-table-body');
    webhookRegisterForm = document.getElementById('webhook-register-form');
    btnWebhooksRefresh = document.getElementById('btn-webhooks-refresh');
    btnWebhooksClear = document.getElementById('btn-webhooks-clear');
    if (webhookRegisterForm) {
        webhookRegisterForm.addEventListener('submit', onRegisterWebhook);
    }
    if (btnWebhooksRefresh) {
        btnWebhooksRefresh.addEventListener('click', loadWebhooks);
    }
    if (btnWebhooksClear) {
        btnWebhooksClear.addEventListener('click', onClearWebhooks);
    }

    // 8. Data Parsers Logic (CSV)
    const csvForm = document.getElementById('csv-parser-form');
    if (csvForm) {
        csvForm.addEventListener('submit', onStartCsvParser);
    }

    // 8. Ace Editor Initialization for HMI & Simulator files
    if (window.ace && !adminAceEditor) {
        adminAceEditor = ace.edit("admin-hmi-code-editor");
        adminAceEditor.setTheme(document.body.classList.contains('dark-mode') ? 'ace/theme/tomorrow_night' : 'ace/theme/chrome');
        adminAceEditor.setOptions({
            fontSize: "14px",
            fontFamily: "monospace",
            enableBasicAutocompletion: true, 
            enableLiveAutocompletion: true,
            useWorker: false // Disables heavy web workers to avoid 404s on air-gapped instances
        });
    }
    document.getElementById('btn-admin-editor-cancel')?.addEventListener('click', closeAssetEditor);
    document.getElementById('btn-admin-editor-save')?.addEventListener('click', saveAssetEditor);
    document.getElementById('btn-admin-editor-delete')?.addEventListener('click', async () => {
        if (currentEditingFilename) {
            const isSimulator = currentEditingFilename.toLowerCase().startsWith('simulator-');
            const deleted = isSimulator 
                ? await deleteSimulator(currentEditingFilename) 
                : await deleteHmiAsset(currentEditingFilename);
            if (deleted) closeAssetEditor();
        }
    });
}
/**
 * Called when the Admin tab is activated.
 */
export function onAdminViewShow() {
    if (!isViewInitialized) {
        return;
    }
    const activeTab = document.querySelector('#admin-view .sub-tab-button.active');
    if (activeTab && activeTab.dataset.target === 'admin-alerts-panel') {
        loadResolvedStats();
    } else if (activeTab && activeTab.dataset.target === 'admin-assets-panel') {
        loadHmiAssets();
    } else if (activeTab && activeTab.dataset.target === 'admin-simulators-panel') {
        loadSimulators();
    } else if (activeTab && activeTab.dataset.target === 'admin-webhooks-panel') {
        loadWebhooks();
    } else if (activeTab && activeTab.dataset.target === 'admin-parsers-panel') {
        // Data parsers panel is active
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
                <button class="tool-button button-danger btn-delete-user" data-id="${user.id}" data-username="${user.username || user.display_name}" ${deleteDisabled} style="${deleteStyle}">Delete</button>
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
    const isConfirmed = await confirmModal('Delete User', `⚠️ WARNING: Are you sure you want to delete user "${username}"?\n\nThis will permanently delete their account AND all their saved data (charts, mapper configs, history).`, 'Delete', true);
    if (!isConfirmed) return;
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
    const isConfirmed = await confirmModal('Import Database', `Import data from '${file.name}'?\nThis will be queued and processed in the background.`, 'Import', false);
    if (!isConfirmed) return;
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
    const isConfirmed = await confirmModal('Reset Database', '⚠️ WARNING: This will permanently DELETE ALL DATA in the history database.\n\nAre you sure you want to reset the database to zero?', 'Reset DB', true);
    if (!isConfirmed) return;
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
    const isConfirmed = await confirmModal('Purge Alerts', 'Are you sure you want to delete ALL resolved alerts?', 'Purge', true);
    if (!isConfirmed) return;
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
// --- HMI Assets & Simulators Shared Functions ---
function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}
function getFileTypeBadge(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    let color = '#6c757d'; // Default gray
    if (['html', 'htm'].includes(ext)) color = '#e34c26'; // HTML Orange
    else if (ext === 'svg') color = '#ffb13b'; // SVG Yellow
    else if (ext === 'js') color = '#f1e05a'; // JS Yellow
    else if (['glb', 'gltf', 'bin'].includes(ext)) color = '#8e44ad'; // 3D Purple
    else if (['png', 'jpg', 'jpeg'].includes(ext)) color = '#17a2b8'; // Image Teal
    return `<span style="background-color: ${color}; color: ${color === '#f1e05a' || color === '#ffb13b' ? '#333' : '#fff'}; padding: 2px 6px; border-radius: 4px; font-size: 0.8em; font-weight: bold; text-transform: uppercase;">${ext}</span>`;
}
// --- HMI Assets Maintenance Functions ---
async function loadHmiAssets() {
    if (!hmiAssetsTableBody) return;
    hmiAssetsTableBody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 20px;">Loading assets...</td></tr>';
    try {
        const res = await fetch('api/admin/hmi-assets');
        if (!res.ok) throw new Error("Failed to fetch HMI assets list.");
        const assets = await res.json();
        renderHmiAssets(assets);
    } catch (e) {
        console.error("HMI Assets Load Error:", e);
        hmiAssetsTableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--color-danger); padding: 20px;">Error: ${e.message}</td></tr>`;
    }
}
function renderHmiAssets(assets) {
    hmiAssetsTableBody.innerHTML = '';
    if (assets.length === 0) {
        hmiAssetsTableBody.innerHTML = '<tr><td colspan="5" style="text-align:center;">No HMI assets found.</td></tr>';
        return;
    }
    assets.forEach(asset => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--color-border)';
        const lastModified = new Date(asset.mtime).toLocaleString();
        // Check if file is editable text
        const ext = asset.name.split('.').pop().toLowerCase();
        const isEditable = ['html', 'htm', 'svg', 'js', 'json', 'gltf'].includes(ext);
        const editBtn = isEditable ? `<button class="tool-button btn-edit-asset" data-filename="${asset.name}" style="margin-right: 5px;">Edit</button>` : '';
        tr.innerHTML = `
            <td style="padding: 10px; font-family: monospace;"><strong>${asset.name}</strong></td>
            <td style="padding: 10px;">${getFileTypeBadge(asset.name)}</td>
            <td style="padding: 10px; font-size: 0.9em;">${formatBytes(asset.size)}</td>
            <td style="padding: 10px; font-size: 0.9em;">${lastModified}</td>
            <td style="padding: 10px; text-align: right;">
                ${editBtn}
                <button class="tool-button button-danger btn-delete-asset" data-filename="${asset.name}">Delete</button>
            </td>
        `;
        hmiAssetsTableBody.appendChild(tr);
    });
    document.querySelectorAll('#admin-hmi-table-body .btn-delete-asset').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const filename = e.target.dataset.filename;
            deleteHmiAsset(filename);
        });
    });
    document.querySelectorAll('#admin-hmi-table-body .btn-edit-asset').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const filename = e.target.dataset.filename;
            openAssetEditor(filename);
        });
    });
}
async function onUploadHmiAssets() {
    const files = hmiUploadInput.files;
    if (!files || files.length === 0) {
        alert("Please select at least one file to upload.");
        return;
    }
    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
        formData.append('assets', files[i]);
    }
    btnUploadHmi.disabled = true;
    btnUploadHmi.textContent = "Uploading...";
    hmiUploadStatus.textContent = "Processing upload...";
    hmiUploadStatus.style.color = "var(--color-text)";
    try {
        const response = await fetch('api/admin/hmi-assets', {
            method: 'POST',
            body: formData
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || "Upload failed.");
        }
        hmiUploadStatus.textContent = `✅ ${result.message}`; 
        hmiUploadStatus.style.color = 'var(--color-success)';
        hmiUploadInput.value = ''; // Clear input
        loadHmiAssets(); // Refresh list automatically
    } catch (e) {
        hmiUploadStatus.textContent = `❌ Error: ${e.message}`;
        hmiUploadStatus.style.color = 'var(--color-danger)';
    } finally {
        btnUploadHmi.disabled = false;
        btnUploadHmi.textContent = "Upload Files";
        setTimeout(() => {
            if (hmiUploadStatus.textContent.includes('✅')) {
                hmiUploadStatus.textContent = '';
            }
        }, 5000);
    }
}
async function deleteHmiAsset(filename) {
    const isConfirmed = await confirmModal('Delete HMI Asset', `⚠️ Are you sure you want to permanently delete "${filename}"?\n\nDashboards depending on this asset will break.`, 'Delete', true);
    if (!isConfirmed) return false;
    try {
        const res = await fetch(`api/admin/hmi-assets/${encodeURIComponent(filename)}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            loadHmiAssets(); // Refresh list
            return true;
        } else {
            alert("Error: " + data.error);
        }
    } catch (e) {
        alert("Request failed: " + e.message);
    }
    return false;
}

// --- Simulators Maintenance Functions ---
async function loadSimulators() {
    if (!simTableBody) return;
    simTableBody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 20px;">Loading simulators...</td></tr>';
    try {
        const res = await fetch('api/admin/simulators');
        if (!res.ok) throw new Error("Failed to fetch simulators list.");
        const assets = await res.json();
        renderSimulators(assets);
    } catch (e) {
        console.error("Simulators Load Error:", e);
        simTableBody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--color-danger); padding: 20px;">Error: ${e.message}</td></tr>`;
    }
}
function renderSimulators(assets) {
    simTableBody.innerHTML = '';
    if (assets.length === 0) {
        simTableBody.innerHTML = '<tr><td colspan="4" style="text-align:center;">No Simulators found.</td></tr>';
        return;
    }
    assets.forEach(asset => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--color-border)';
        const lastModified = new Date(asset.mtime).toLocaleString();
        tr.innerHTML = `
            <td style="padding: 10px; font-family: monospace;"><strong>${asset.name}</strong></td>
            <td style="padding: 10px; font-size: 0.9em;">${formatBytes(asset.size)}</td>
            <td style="padding: 10px; font-size: 0.9em;">${lastModified}</td>
            <td style="padding: 10px; text-align: right;">
                <button class="tool-button btn-edit-sim" data-filename="${asset.name}" style="margin-right: 5px;">Edit</button>
                <button class="tool-button button-danger btn-delete-sim" data-filename="${asset.name}">Delete</button>
            </td>
        `;
        simTableBody.appendChild(tr);
    });
    document.querySelectorAll('#admin-sim-table-body .btn-delete-sim').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const filename = e.target.dataset.filename;
            deleteSimulator(filename);
        });
    });
    document.querySelectorAll('#admin-sim-table-body .btn-edit-sim').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const filename = e.target.dataset.filename;
            openAssetEditor(filename);
        });
    });
}
async function onUploadSimulators() {
    const files = simUploadInput.files;
    if (!files || files.length === 0) {
        alert("Please select at least one file to upload.");
        return;
    }
    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
        formData.append('assets', files[i]);
    }
    btnUploadSim.disabled = true;
    btnUploadSim.textContent = "Uploading...";
    simUploadStatus.textContent = "Processing upload...";
    simUploadStatus.style.color = "var(--color-text)";
    try {
        const response = await fetch('api/admin/simulators', {
            method: 'POST',
            body: formData
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || "Upload failed.");
        }
        simUploadStatus.textContent = `✅ ${result.message}`; 
        simUploadStatus.style.color = 'var(--color-success)';
        simUploadInput.value = ''; // Clear input
        loadSimulators(); // Refresh list automatically
    } catch (e) {
        simUploadStatus.textContent = `❌ Error: ${e.message}`;
        simUploadStatus.style.color = 'var(--color-danger)';
    } finally {
        btnUploadSim.disabled = false;
        btnUploadSim.textContent = "Upload Files";
        setTimeout(() => {
            if (simUploadStatus.textContent.includes('✅')) {
                simUploadStatus.textContent = '';
            }
        }, 5000);
    }
}
async function deleteSimulator(filename) {
    const isConfirmed = await confirmModal('Delete Simulator', `⚠️ Are you sure you want to permanently delete "${filename}"?`, 'Delete', true);
    if (!isConfirmed) return false;
    try {
        const res = await fetch(`api/admin/simulators/${encodeURIComponent(filename)}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            loadSimulators(); // Refresh list
            return true;
        } else {
            alert("Error: " + data.error);
        }
    } catch (e) {
        alert("Request failed: " + e.message);
    }
    return false;
}

// --- Data Parsers Logic (CSV) ---
async function onStartCsvParser(e) {
    e.preventDefault();
    const fileInput = document.getElementById('csv-upload-input');
    const defaultTopic = document.getElementById('csv-default-topic').value;
    const timeDelta = document.getElementById('csv-time-delta').value;
    const loop = document.getElementById('csv-loop').checked;
    const statusEl = document.getElementById('csv-parser-status');

    const file = fileInput.files[0];
    if (!file) return alert("Select a CSV file.");

    const formData = new FormData();
    formData.append('csv_file', file);
    formData.append('defaultTopic', defaultTopic);
    formData.append('streamRateMs', timeDelta);
    formData.append('loop', loop);

    const btn = document.getElementById('btn-start-csv-parser');
    btn.disabled = true;
    btn.textContent = "Starting...";
    statusEl.textContent = "Uploading and parsing...";
    statusEl.style.color = "var(--color-text)";

    try {
        const res = await fetch('api/admin/data-parsers/csv', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to start parser");

        statusEl.textContent = `✅ Parser started! ID: ${data.providerId}`;
        statusEl.style.color = "var(--color-success)";
        fileInput.value = '';
    } catch(err) {
        statusEl.textContent = `❌ Error: ${err.message}`;
        statusEl.style.color = "var(--color-danger)";
    } finally {
        btn.disabled = false;
        btn.textContent = "Start CSV Parser";
        setTimeout(() => { if(statusEl.textContent.includes('✅')) statusEl.textContent = ''; }, 5000);
    }
}

// --- HMI & Simulator Shared Code Editor Logic ---
async function openAssetEditor(filename) {
    try {
        const res = await fetch(`api/hmi/file?name=${encodeURIComponent(filename)}`);
        if (!res.ok) throw new Error("Failed to load file content.");
        const content = await res.text();
        currentEditingFilename = filename;
        document.getElementById('admin-hmi-editor-title').textContent = `Editing: ${filename}`;
        // Define Ace mode
        const ext = filename.split('.').pop().toLowerCase();
        let mode = 'ace/mode/text'; // Fallback
        if (ext === 'js') mode = 'ace/mode/javascript';
        else if (ext === 'json' || ext === 'gltf') mode = 'ace/mode/json';
        else if (ext === 'html' || ext === 'htm') mode = 'ace/mode/html';
        else if (ext === 'svg') mode = 'ace/mode/svg';
        adminAceEditor.session.setMode(mode);
        adminAceEditor.setTheme(document.body.classList.contains('dark-mode') ? 'ace/theme/tomorrow_night' : 'ace/theme/chrome');
        adminAceEditor.setValue(content, -1);
        document.getElementById('admin-hmi-editor-modal').style.display = 'flex';
        // Force resize after display change
        setTimeout(() => adminAceEditor.resize(), 50);
    } catch (e) {
        alert("Error opening editor: " + e.message);
    }
}
function closeAssetEditor() {
    document.getElementById('admin-hmi-editor-modal').style.display = 'none';
    currentEditingFilename = null;
}
async function saveAssetEditor() {
    if (!currentEditingFilename) return;
    const btnSave = document.getElementById('btn-admin-editor-save');
    const originalText = btnSave.textContent;
    btnSave.textContent = "Saving...";
    btnSave.disabled = true;
    try {
        const content = adminAceEditor.getValue();
        // Create a blob file memory to reuse the Multer upload endpoint
        const blob = new Blob([content], { type: 'text/plain' });
        const file = new File([blob], currentEditingFilename);
        const formData = new FormData();
        formData.append('assets', file);
        // Determine correct endpoint based on filename prefix
        const isSimulator = currentEditingFilename.toLowerCase().startsWith('simulator-');
        const endpoint = isSimulator ? 'api/admin/simulators' : 'api/admin/hmi-assets';
        const response = await fetch(endpoint, {
            method: 'POST',
            body: formData
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Save failed.");
        // Refresh the correct list
        if (isSimulator) {
            loadSimulators();
        } else {
            loadHmiAssets();
        }
        closeAssetEditor();
    } catch (e) {
        alert("Error saving file: " + e.message);
    } finally {
        btnSave.textContent = originalText;
        btnSave.disabled = false;
    }
    }

    // --- Webhooks Management Functions ---
    async function loadWebhooks() {
    if (!webhooksTableBody) return;
    webhooksTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px;">Loading webhooks...</td></tr>';
    try {
        const res = await fetch('api/admin/webhooks');
        if (!res.ok) throw new Error("Failed to fetch webhooks list.");
        const webhooks = await res.json();
        renderWebhooks(webhooks);
    } catch (e) {
        console.error("Webhooks Load Error:", e);
        webhooksTableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--color-danger); padding: 20px;">Error: ${e.message}</td></tr>`;
    }
    }

    function renderWebhooks(webhooks) {
    webhooksTableBody.innerHTML = '';
    if (webhooks.length === 0) {
        webhooksTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px;">No webhooks registered.</td></tr>';
        return;
    }
    webhooks.forEach(w => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--color-border)';
        const lastTriggered = w.last_triggered ? new Date(w.last_triggered).toLocaleString() : 'Never';
        tr.innerHTML = `
            <td style="padding: 10px; font-size: 0.8em; font-family: monospace;">${w.id}</td>
            <td style="padding: 10px;"><code>${w.topic}</code></td>
            <td style="padding: 10px;"><a href="${w.url}" target="_blank" style="color: var(--color-primary); font-size: 0.9em;">${w.url}</a></td>
            <td style="padding: 10px;">${w.min_interval_ms}ms</td>
            <td style="padding: 10px; font-size: 0.9em;">${lastTriggered}</td>
            <td style="padding: 10px; text-align: right;">
                <button class="tool-button button-danger btn-delete-webhook" data-id="${w.id}">Delete</button>
            </td>
        `;
        webhooksTableBody.appendChild(tr);
    });

    document.querySelectorAll('.btn-delete-webhook').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.target.dataset.id;
            deleteWebhook(id);
        });
    });
    }

    async function onRegisterWebhook(e) {
    e.preventDefault();
    const topic = document.getElementById('webhook-topic').value;
    const url = document.getElementById('webhook-url').value;
    const interval = document.getElementById('webhook-interval').value;

    try {
        const res = await fetch('api/admin/webhooks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ topic, url, method: 'POST', min_interval_ms: parseInt(interval, 10) })
        });
        const data = await res.json();
        if (data.success) {
            document.getElementById('webhook-register-form').reset();
            loadWebhooks();
        } else {
            alert("Error: " + data.error);
        }
    } catch (e) {
        alert("Request failed: " + e.message);
    }
    }

    async function deleteWebhook(id) {
    const isConfirmed = await confirmModal('Delete Webhook', `Are you sure you want to delete webhook ${id}?`, 'Delete', true);
    if (!isConfirmed) return;
    try {
        const res = await fetch(`api/admin/webhooks/${id}`, { method: 'DELETE' });
        if ((await res.json()).success) {
            loadWebhooks();
        }
    } catch (e) {
        alert("Delete failed: " + e.message);
    }
    }

    async function onClearWebhooks() {
    const isConfirmed = await confirmModal('Clear All Webhooks', '⚠️ Are you sure you want to delete ALL webhooks?', 'Clear All', true);
    if (!isConfirmed) return;
    try {
        const res = await fetch('api/admin/webhooks/clear', { method: 'POST' });
        if ((await res.json()).success) {
            loadWebhooks();
        }
    } catch (e) {
        alert("Clear failed: " + e.message);
    }
    }

    // --- AI History Logic ---
    async function loadAiHistory() {
        const tbody = document.getElementById('admin-ai-history-tbody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 20px;">Loading AI History...</td></tr>';
        try {
            const res = await fetch('api/admin/ai_history');
            if (!res.ok) throw new Error("Failed to fetch AI history.");
            const history = await res.json();
            renderAiHistory(history, tbody);
        } catch (e) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--color-danger); padding: 20px;">Error: ${e.message}</td></tr>`;
        }
    }

    function renderAiHistory(history, tbody) {
        tbody.innerHTML = '';
        if (!history || history.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 20px;">No AI modifications recorded.</td></tr>';
            return;
        }

        history.forEach(action => {
            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid var(--color-border)';
            const time = new Date(action.timestamp).toLocaleString();
            
            let details = '';
            if (action.toolName === 'create_hmi_view') details = `View: ${action.args.view_name}`;
            else if (action.toolName === 'save_file_to_data_directory') details = `File: ${action.args.filename}`;
            else if (action.toolName === 'update_mapper_rule') details = `Mapper: ${action.args.sourceTopic}`;
            else details = JSON.stringify(action.args).substring(0, 50) + '...';

            const canRevert = action.originalState != null;
            const revertBtn = canRevert 
                ? `<button class="tool-button button-danger btn-revert-ai" data-id="${action.id}" data-tool="${action.toolName}">Revert</button>` 
                : `<span style="font-size:0.8em; color:var(--color-text-secondary);">No Backup</span>`;

            tr.innerHTML = `
                <td style="padding: 10px; font-size: 0.85em;">${time}</td>
                <td style="padding: 10px;">${action.user}</td>
                <td style="padding: 10px; font-family: monospace;">${action.toolName}</td>
                <td style="padding: 10px; font-size: 0.9em;">${details}</td>
                <td style="padding: 10px; text-align: right;">${revertBtn}</td>
            `;
            tbody.appendChild(tr);
        });

        document.querySelectorAll('.btn-revert-ai').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.target.dataset.id;
                const tool = e.target.dataset.tool;
                const isConfirmed = await confirmModal('Revert AI Action', `Are you sure you want to revert the AI modification: ${tool}?`, 'Revert', true);
                if (!isConfirmed) return;
                
                try {
                    const res = await fetch(`api/admin/ai_history/${id}/revert`, { method: 'POST' });
                    const data = await res.json();
                    if (data.success) {
                        alert("✅ Action reverted successfully.");
                        loadAiHistory();
                    } else {
                        alert("❌ Error: " + data.error);
                    }
                } catch (err) {
                    alert("Request failed: " + err.message);
                }
            });
        });
    }