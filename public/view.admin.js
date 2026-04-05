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
 * Refactored to use Native Web Components for all panels.
 */
import { showToast } from './utils.js';
import { state } from './state.js';

// --- Import Web Components ---
import './components/admin-users-panel.js';
import './components/admin-apikeys-panel.js';
import './components/admin-webhooks-panel.js';
import './components/admin-db-panel.js';
import './components/admin-alerts-panel.js';
import './components/admin-assets-panel.js';
import './components/admin-simulators-panel.js';
import './components/admin-parsers-panel.js';
import './components/admin-ai-panel.js';
import './components/admin-logs-panel.js';

// --- Elements for Tabs ---
let subNavButtons = null;

// --- Elements for HMI/Simulator Code Editor ---
let btnAdminEditorCancel = null;
let btnAdminEditorSave = null;
let btnAdminEditorDelete = null;
let adminAceEditor = null;
let currentEditingFilename = null;

let isViewInitialized = false;
let isMounted = false; 
let templatePromise = null;

/**
 * Initializes the Admin View elements by loading the HTML fragment.
 */
export async function initAdminView() {
    if (templatePromise) return templatePromise;

    templatePromise = (async () => {
        const container = document.getElementById('admin-view');
        if (!container) return;
        if (isViewInitialized) return;

        try {
            const response = await fetch('html/view.admin.html');
            if (!response.ok) throw new Error(`Failed to load admin template: ${response.statusText}`);
            const htmlContent = await response.text();
            container.innerHTML = htmlContent;
            initializeElements(container);
            isViewInitialized = true;
            console.log("✅ Admin View Initialized (Web Components Ready)");
            
            // Re-mount if we should be active
            if (state.activeView === 'admin') {
                isMounted = false; // Reset to force re-binding
                mountAdminView();
            }
        } catch (err) {
            console.error("Error initializing Admin View:", err);
            container.innerHTML = `<div style="padding:20px; color:red;">Error loading Admin Interface. Check console.</div>`;
            isViewInitialized = false;
            templatePromise = null;
        }
    })();

    return templatePromise;
}

function initializeElements(container) {
    subNavButtons = container.querySelectorAll('.sub-tab-button');
    btnAdminEditorCancel = document.getElementById('btn-admin-editor-cancel');
    btnAdminEditorSave = document.getElementById('btn-admin-editor-save');
    btnAdminEditorDelete = document.getElementById('btn-admin-editor-delete');

    // Add event listeners for editing assets
    container.addEventListener('edit-asset', (e) => {
        openAssetEditor(e.detail.name);
    });
}

const onSubTabClick = (e) => {
    const btn = e.currentTarget;
    const container = document.getElementById('admin-view');
    if (!subNavButtons) subNavButtons = container.querySelectorAll('.sub-tab-button');
    
    subNavButtons.forEach(b => b.classList.remove('active'));
    container.querySelectorAll('.alerts-content-container').forEach(p => p.classList.remove('active'));
    
    btn.classList.add('active');
    const targetId = btn.dataset.target;
    const targetPanel = document.getElementById(targetId);
    if (targetPanel) targetPanel.classList.add('active');
    
    // Trigger component-specific refreshes
    if (targetId === 'admin-users-panel') container.querySelector('admin-users-panel')?.loadUsers();
    if (targetId === 'admin-db-panel') container.querySelector('admin-db-panel')?.loadDlqStatus();
    if (targetId === 'admin-alerts-panel') container.querySelector('admin-alerts-panel')?.loadResolvedStats();
    if (targetId === 'admin-assets-panel') container.querySelector('admin-assets-panel')?.loadAssets();
    if (targetId === 'admin-simulators-panel') container.querySelector('admin-simulators-panel')?.loadSimulators();
    if (targetId === "admin-webhooks-panel") container.querySelector('admin-webhooks-panel')?.loadWebhooks();
    if (targetId === "admin-apikeys-panel") container.querySelector('admin-apikeys-panel')?.loadApiKeys();
    if (targetId === 'admin-ai-panel') container.querySelector('admin-ai-panel')?.loadAiHistory();
    if (targetId === 'admin-logs-panel') container.querySelector('admin-logs-panel')?.loadSystemLogs();
};

const onAssetDeleteClick = async () => {
    if (currentEditingFilename) {
        const isSimulator = currentEditingFilename.toLowerCase().startsWith('simulator-');
        const res = await fetch(`api/admin/${isSimulator ? 'simulators' : 'hmi-assets'}/${currentEditingFilename}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            showToast("Asset deleted successfully.", "success");
            closeAssetEditor();
            const container = document.getElementById('admin-view');
            if (isSimulator) container.querySelector('admin-simulators-panel')?.loadSimulators();
            else container.querySelector('admin-assets-panel')?.loadAssets();
        }
    }
};

export function mountAdminView() {
    if (isMounted) return;
    if (!isViewInitialized) {
        initAdminView();
        return;
    }

    if (subNavButtons) {
        subNavButtons.forEach(btn => {
            btn.removeEventListener('click', onSubTabClick);
            btn.addEventListener('click', onSubTabClick);
        });
    }
    
    btnAdminEditorCancel?.removeEventListener('click', closeAssetEditor);
    btnAdminEditorCancel?.addEventListener('click', closeAssetEditor);
    
    btnAdminEditorSave?.removeEventListener('click', saveAssetEditor);
    btnAdminEditorSave?.addEventListener('click', saveAssetEditor);
    
    btnAdminEditorDelete?.removeEventListener('click', onAssetDeleteClick);
    btnAdminEditorDelete?.addEventListener('click', onAssetDeleteClick);

    isMounted = true;
    console.log("[Admin View] Mounted.");
}

export function onAdminViewShow() {
    mountAdminView();
}

export function unmountAdminView() {
    if (!isMounted) return;

    if (adminAceEditor) {
        adminAceEditor.destroy();
        adminAceEditor = null;
    }
    closeAssetEditor();

    if (subNavButtons) {
        subNavButtons.forEach(btn => btn.removeEventListener('click', onSubTabClick));
    }
    btnAdminEditorCancel?.removeEventListener('click', closeAssetEditor);
    btnAdminEditorSave?.removeEventListener('click', saveAssetEditor);
    btnAdminEditorDelete?.removeEventListener('click', onAssetDeleteClick);

    isMounted = false;
    console.log("[Admin View] Unmounted & Cleaned up.");
}

// --- Asset Editor ---
async function openAssetEditor(filename) {
    const modal = document.getElementById('admin-hmi-editor-modal');
    const title = document.getElementById('admin-hmi-editor-title');
    const editorEl = document.getElementById('admin-hmi-code-editor');

    if (!modal || !editorEl) return;

    currentEditingFilename = filename;
    title.textContent = `Editing: ${filename}`;
    modal.style.display = 'flex';

    if (!adminAceEditor) {
        adminAceEditor = ace.edit(editorEl);
        adminAceEditor.setTheme(state.isDarkMode ? "ace/theme/tomorrow_night" : "ace/theme/chrome");
        const ext = filename.split('.').pop().toLowerCase();
        if (ext === 'js') adminAceEditor.session.setMode("ace/mode/javascript");
        else if (ext === 'html' || ext === 'htm') adminAceEditor.session.setMode("ace/mode/html");
        else if (ext === 'svg') adminAceEditor.session.setMode("ace/mode/svg");
        else adminAceEditor.session.setMode("ace/mode/text");
    }

    try {
        const isSimulator = filename.toLowerCase().startsWith('simulator-');
        const res = await fetch(`api/admin/${isSimulator ? 'simulators' : 'hmi-assets'}/${filename}`);
        const data = await res.json();
        adminAceEditor.setValue(data.content || '', -1);
    } catch (e) {
        showToast("Error loading file content.", "error");
    }
}

function closeAssetEditor() {
    const modal = document.getElementById('admin-hmi-editor-modal');
    if (modal) modal.style.display = 'none';
    currentEditingFilename = null;
}

async function saveAssetEditor() {
    if (!currentEditingFilename || !adminAceEditor) return;
    const content = adminAceEditor.getValue();
    const isSimulator = currentEditingFilename.toLowerCase().startsWith('simulator-');

    try {
        const res = await fetch(`api/admin/${isSimulator ? 'simulators' : 'hmi-assets'}/${currentEditingFilename}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
        const data = await res.json();
        if (data.success) {
            showToast("File saved successfully.", "success");
            closeAssetEditor();
            const container = document.getElementById('admin-view');
            if (isSimulator) container.querySelector('admin-simulators-panel')?.loadSimulators();
            else container.querySelector('admin-assets-panel')?.loadAssets();
        } else {
            showToast("Error saving file: " + data.error, "error");
        }
    } catch (e) {
        showToast("Failed to save file.", "error");
    }
}
