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
 * View Module for Alerts Management.
 */

// --- Imports ---
import { trackEvent, confirmModal } from './utils.js';

// --- DOM Elements ---
let container = null;
let activeAlertsTableBody = null;
let rulesTableBody = null;
let ruleForm = null;
let btnNewRule = null;
let ruleEditorContainer = null;
let rulesListContainer = null;
let helpModal = null;
let analysisModal = null;
let ruleEditorTitle = null;
let btnFullscreen = null;
let searchInput = null;
let brokerFilterSelect = null;

// --- State ---
let aceEditor = null;
let editingRuleId = null;
let isViewInitialized = false;
let allActiveAlerts = []; 
let isMultiBroker = false;
let brokerConfigs = [];
let hasUnsavedRuleChanges = false;

/**
 * Initialize the Alerts View.
 */
export async function initAlertsView(options = {}) {
    isMultiBroker = options.isMultiBroker || false;
    brokerConfigs = options.brokerConfigs || [];

    container = document.getElementById('alerts-view');
    if (!container) return;
    
    try {
        const response = await fetch('html/view.alerts.html');
        if (!response.ok) throw new Error(`Failed to load alerts template: ${response.statusText}`);
        const htmlContent = await response.text();
        container.innerHTML = htmlContent;
    } catch (err) {
        console.error("Error initializing Alerts View:", err);
        container.innerHTML = `<div style="padding:20px; color:red;">Error loading Alerts Interface. Please check console.</div>`;
        return;
    }

    // --- Element References ---
    activeAlertsTableBody = document.getElementById('active-alerts-body');
    rulesTableBody = document.getElementById('alert-rules-body');
    ruleForm = document.getElementById('rule-form');
    btnNewRule = document.getElementById('btn-new-rule');
    ruleEditorContainer = document.getElementById('rule-editor-container');
    rulesListContainer = document.getElementById('rules-list-container');
    helpModal = document.getElementById('alert-help-modal');
    analysisModal = document.getElementById('analysis-modal');
    ruleEditorTitle = document.getElementById('rule-editor-title');
    btnFullscreen = document.getElementById('btn-alerts-fullscreen');
    searchInput = document.getElementById('alerts-search-input');
    brokerFilterSelect = document.getElementById('alerts-broker-filter');

    if (btnFullscreen) {
        btnFullscreen.innerHTML = '⛶ Maximize';
        btnFullscreen.style.fontSize = '0.85em';
    }

    // --- Event Listeners ---
    container.querySelectorAll('.sub-tab-button').forEach(btn => {
        btn.addEventListener('click', () => {
            container.querySelectorAll('.sub-tab-button').forEach(b => b.classList.remove('active'));
            container.querySelectorAll('.alerts-content-container').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.target).classList.add('active');
            if (btn.dataset.target === 'active-alerts-panel') loadActiveAlerts();
            if (btn.dataset.target === 'alert-rules-panel') loadRules();
        });
    });

    document.getElementById('chk-hide-resolved').addEventListener('change', renderActiveAlerts);
    searchInput?.addEventListener('input', renderActiveAlerts);

    if (isMultiBroker && brokerFilterSelect) {
        brokerFilterSelect.style.display = 'block';
        brokerConfigs.forEach(b => {
            const opt = document.createElement('option');
            opt.value = b.id;
            opt.textContent = b.id;
            brokerFilterSelect.appendChild(opt);
        });
        brokerFilterSelect.addEventListener('change', renderActiveAlerts);
    }

    // Fullscreen
    btnFullscreen?.addEventListener('click', toggleFullscreen);
    
    // Track native fullscreen changes (sync button state on ESC)
    document.addEventListener('fullscreenchange', () => {
        const panel = document.getElementById('active-alerts-panel');
        if (btnFullscreen) {
            if (document.fullscreenElement === panel) {
                btnFullscreen.innerHTML = '✖ Minimize';
            } else {
                btnFullscreen.innerHTML = '⛶ Maximize';
                panel?.classList.remove('fullscreen-mode');
            }
        }
    });

    // Rule & Modal Controls
    btnNewRule.addEventListener('click', () => showRuleEditor());
    document.getElementById('btn-cancel-rule').addEventListener('click', hideRuleEditor);
    document.getElementById('btn-js-help').addEventListener('click', () => helpModal.style.display = 'flex');
    document.getElementById('btn-close-help').addEventListener('click', () => helpModal.style.display = 'none');
    document.getElementById('btn-close-help-2').addEventListener('click', () => helpModal.style.display = 'none');
    document.getElementById('btn-close-analysis').addEventListener('click', () => analysisModal.style.display = 'none');
    document.getElementById('btn-close-analysis-2').addEventListener('click', () => analysisModal.style.display = 'none');
    
    ruleForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await saveRule();
    });

    // Unsaved Changes Tracking
    ruleForm.addEventListener('input', markRuleUnsaved);

    // --- Init Ace ---
    if (window.ace) {
        aceEditor = ace.edit("rule-condition-editor");
        aceEditor.setTheme(document.body.classList.contains('dark-mode') ? 'ace/theme/tomorrow_night' : 'ace/theme/chrome');
        aceEditor.session.setMode("ace/mode/javascript");
        aceEditor.setValue("return msg.payload.value > 50;", -1);
        aceEditor.session.on('change', markRuleUnsaved);
    }

    isViewInitialized = true;
    console.log("✅ Alerts View Initialized");

    if (container.classList.contains('active')) {
        const activeSubTab = container.querySelector('.sub-tab-button.active');
        if (activeSubTab && activeSubTab.dataset.target === 'alert-rules-panel') {
            loadRules();
        } else {
            loadActiveAlerts();
        }
    }
}

// --- Lifecycle ---
export function onAlertsViewShow() {
    if (isViewInitialized) {
        loadActiveAlerts();
    }
}

export function onAlertsViewHide() { }

export function refreshAlerts() {
    if (isViewInitialized && container && container.querySelector('#active-alerts-panel').classList.contains('active')) {
        loadActiveAlerts();
    }
}

export function openCreateRuleModal(topic, examplePayload) {
    if (!isViewInitialized) { console.warn("Alerts view not ready."); return; }
    const rulesTabBtn = document.querySelector('.sub-tab-button[data-target="alert-rules-panel"]');
    if (rulesTabBtn) rulesTabBtn.click();
    showRuleEditor();
    ruleForm.elements.topic_pattern.value = topic;
    
    let condition = "return true;";
    if (examplePayload && typeof examplePayload === 'object') {
        const keys = Object.keys(examplePayload);
        if (keys.length > 0) {
            const key = keys[0];
            const val = examplePayload[key];
            if (typeof val === 'number') condition = `return msg.payload.${key} > ${val};`;
        }
    }
    if (aceEditor) aceEditor.setValue(condition, -1);
}

// --- Logic ---
function markRuleUnsaved() {
    if (!hasUnsavedRuleChanges) {
        hasUnsavedRuleChanges = true;
        const btnSave = ruleForm.querySelector('button[type="submit"]');
        if (btnSave) btnSave.classList.add('btn-unsaved');
    }
}

function clearRuleUnsaved() {
    hasUnsavedRuleChanges = false;
    const btnSave = ruleForm.querySelector('button[type="submit"]');
    if (btnSave) btnSave.classList.remove('btn-unsaved');
}

function toggleFullscreen() {
    const panel = document.getElementById('active-alerts-panel');
    if (!document.fullscreenElement) {
        panel.requestFullscreen().catch(err => {
            console.error(`Error enabling fullscreen: ${err.message}`);
        });
        panel.classList.add('fullscreen-mode');
    } else {
        document.exitFullscreen();
        panel.classList.remove('fullscreen-mode');
    }
}

function showRuleEditor(ruleToEdit = null) {
    clearRuleUnsaved();
    rulesListContainer.style.display = 'none';
    ruleEditorContainer.style.display = 'block';
    
    if (ruleToEdit) {
        editingRuleId = ruleToEdit.id;
        ruleEditorTitle.textContent = "Edit Rule";
        ruleForm.elements.name.value = ruleToEdit.name;
        ruleForm.elements.topic_pattern.value = ruleToEdit.topic_pattern;
        ruleForm.elements.severity.value = ruleToEdit.severity;
        ruleForm.elements.workflow_prompt.value = ruleToEdit.workflow_prompt || '';
        ruleForm.elements.webhook.value = ruleToEdit.notifications?.webhook || '';
        if (aceEditor) aceEditor.setValue(ruleToEdit.condition_code, -1);
    } else {
        editingRuleId = null;
        ruleEditorTitle.textContent = "Create New Rule";
        ruleForm.reset();
        if (aceEditor) aceEditor.setValue("return msg.payload.value > 50;", -1);
    }
    clearRuleUnsaved(); // Ensure initial state is clean
}

function hideRuleEditor() {
    rulesListContainer.style.display = 'block';
    ruleEditorContainer.style.display = 'none';
    editingRuleId = null;
    clearRuleUnsaved();
}

async function loadRules() {
    try {
        const res = await fetch('api/alerts/rules');
        const rules = await res.json();
        rulesTableBody.innerHTML = '';
        
        if (rules.length === 0) {
            rulesTableBody.innerHTML = '<tr><td colspan="4" style="text-align:center;">No rules defined.</td></tr>';
            return;
        }

        rules.forEach(rule => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td data-label="Name" title="${rule.name}">
                    <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"><strong>${rule.name}</strong></div>
                </td>
                <td data-label="Topic" title="${rule.topic_pattern}">
                    <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"><code>${rule.topic_pattern}</code></div>
                </td>
                <td data-label="Severity"><span class="badge badge-${rule.severity}">${rule.severity}</span></td>
                <td data-label="Actions">
                    <button class="tool-button btn-edit" title="Edit">Edit</button>
                    <button class="tool-button btn-delete" style="color:var(--color-danger); border-color:var(--color-danger);" title="Delete">Delete</button>
                </td>
            `;
            tr.querySelector('.btn-edit').addEventListener('click', () => showRuleEditor(rule));
            tr.querySelector('.btn-delete').addEventListener('click', () => deleteRule(rule.id));
            rulesTableBody.appendChild(tr);
        });
    } catch (e) { console.error("Failed to load rules", e); }
}

async function saveRule() {
    const formData = new FormData(ruleForm);
    const data = {
        name: formData.get('name'),
        topic_pattern: formData.get('topic_pattern'),
        severity: formData.get('severity'),
        condition_code: aceEditor.getValue(),
        workflow_prompt: formData.get('workflow_prompt'),
        notifications: { webhook: formData.get('webhook') }
    };
    
    try {
        let url = 'api/alerts/rules';
        let method = 'POST';
        if (editingRuleId) { url = `api/alerts/rules/${editingRuleId}`; method = 'PUT'; }
        
        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        if (!res.ok) throw new Error((await res.json()).error);
        clearRuleUnsaved();
        hideRuleEditor();
        loadRules();
    } catch (e) { alert("Error: " + e.message); }
}

async function deleteRule(id) {
    const isConfirmed = await confirmModal("Delete Rule", "Are you sure you want to delete this alert rule?", "Delete", true);
    if (!isConfirmed) return;
    
    try {
        await fetch(`api/alerts/rules/${id}`, { method: 'DELETE' });
        loadRules();
    } catch (e) { alert("Delete failed."); }
}

// --- Logic: Alerts ---
function formatCompactTrigger(jsonStr) {
    try {
        const j = JSON.parse(jsonStr);
        if (typeof j !== 'object' || j === null) return String(j);
        
        // Priority keys for concise display
        if (j.value !== undefined) return `${j.value} ${j.unit || ''}`;
        if (j.val !== undefined) return `${j.val}`;
        if (j.status !== undefined) return `${j.status}`;
        const keys = Object.keys(j);
        if (keys.length > 0) return `${j[keys[0]]}`;
        return "Complex Data";
    } catch (e) {
        return "Raw Data";
    }
}

/**
 * Helper to parse the Structured AI Response.
 * Fallback to full text if tags are missing to ensure user sees *something*.
 */
function parseAiResponse(fullText) {
    if (!fullText) return { trigger: null, action: null, report: null };
    
    // Regex based on markers in alert_manager.js
    const triggerMatch = fullText.match(/## TRIGGER\n(.*?)(?=\n##|$)/s);
    const actionMatch = fullText.match(/## ACTION\n(.*?)(?=\n##|$)/s);
    const reportMatch = fullText.match(/## REPORT\n([\s\S]*)/s); 
    
    return {
        trigger: triggerMatch ? triggerMatch[1].trim() : null,
        action: actionMatch ? actionMatch[1].trim() : null,
        // Fallback: If no ## REPORT tag, use the whole text as the report
        report: reportMatch ? reportMatch[1].trim() : fullText 
    };
}

async function loadActiveAlerts() {
    try {
        const res = await fetch('api/alerts/active');
        allActiveAlerts = await res.json();
        renderActiveAlerts();
    } catch (e) { console.error("Failed to load alerts", e); }
}

function renderActiveAlerts() {
    if (!activeAlertsTableBody) return;

    const hideResolved = document.getElementById('chk-hide-resolved')?.checked;
    const searchVal = searchInput?.value.trim().toLowerCase();
    const brokerVal = brokerFilterSelect?.value;

    let filteredAlerts = allActiveAlerts;

    if (hideResolved) {
        filteredAlerts = filteredAlerts.filter(a => a.status !== 'resolved');
    }

    if (brokerVal && brokerVal !== 'all') {
        filteredAlerts = filteredAlerts.filter(a => a.broker_id === brokerVal);
    }

    if (searchVal) {
        filteredAlerts = filteredAlerts.filter(a => {
            const tMatch = (a.topic || '').toLowerCase().includes(searchVal);
            const rMatch = (a.rule_name || '').toLowerCase().includes(searchVal);
            const vMatch = (a.trigger_value || '').toLowerCase().includes(searchVal);
            return tMatch || rMatch || vMatch;
        });
    }

    activeAlertsTableBody.innerHTML = '';
    
    if (filteredAlerts.length === 0) {
        activeAlertsTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--color-text-secondary);">✅ No active alerts match the filters.</td></tr>';
        return;
    }

    filteredAlerts.forEach(alert => {
        const tr = document.createElement('tr');
        
            // --- Parse AI Result ---
        const aiData = parseAiResponse(alert.analysis_result);
        
            // --- 1. Trigger Value Column ---
            // Priority: AI-extracted trigger > Legacy extraction > Raw
        let displayTrigger = aiData.trigger;
        if (!displayTrigger) {
            displayTrigger = formatCompactTrigger(alert.trigger_value);
        }
            // Prepare tooltip (Raw JSON)
        let fullJsonTooltip = "";
        try { 
            fullJsonTooltip = JSON.stringify(JSON.parse(alert.trigger_value), null, 2).replace(/"/g, '&quot;');
        } catch(e) { fullJsonTooltip = alert.trigger_value; }
        const triggerHtml = `<div class="compact-json" title="${fullJsonTooltip}">${displayTrigger}</div>`;
        
            // --- 2. Action & Analysis Column ---
        let analysisHtml = '';
        let contentToModal = aiData.report || alert.analysis_result; 
        
        if (alert.status === 'analyzing') {
            analysisHtml = `<div style="color:var(--color-primary); font-size:0.85em;"><span class="broker-dot" style="background:var(--color-primary); animation:blink 1s infinite;"></span> Analyzing...</div>`;
        } else if (aiData.action) {
                // If we have a structured action
            analysisHtml = `
                <div style="display:flex; align-items:center; gap:10px;">
                    <div class="ai-action-pill" title="${aiData.action}">💡 ${aiData.action}</div>
                    <button class="btn-view-analysis tool-button" style="padding:2px 6px;" title="View Full Report">👁️</button>
                </div>
            `;
        } else if (alert.analysis_result) {
                 // Fallback for old alerts without structure
             const snippet = alert.analysis_result.substring(0, 60) + "...";
             analysisHtml = `
                <div style="display:flex; align-items:center; gap:10px;">
                    <span style="font-size:0.85em; opacity:0.8;">${snippet}</span>
                    <button class="btn-view-analysis tool-button" style="padding:2px 6px;" title="View Full Report">👁️</button>
                </div>
            `;
        } else {
            analysisHtml = '<span style="color:#ccc; font-size:0.8em;">Waiting...</span>';
        }
        
            // --- 3. Buttons & Status Traceability ---
        let actionsHtml = '<div style="display:flex; gap:5px; align-items:center;">';
        if (alert.status !== 'resolved') {
            if (alert.status !== 'acknowledged') {
                actionsHtml += `<button class="tool-button btn-ack" data-id="${alert.id}" style="color:var(--color-primary); border-color:var(--color-primary);">Ack</button>`;
            }
            actionsHtml += `<button class="tool-button btn-resolve" data-id="${alert.id}" style="color:var(--color-success); border-color:var(--color-success);">Resolve</button>`;
        } else {
            actionsHtml += '<span style="color:var(--color-success); font-size:0.8em; font-weight:bold;">Done</span>';
        }
        actionsHtml += '</div>';
        
        let statusHtml = `<span class="badge badge-${alert.status}">${alert.status}</span>`;
            // [NEW] Display User AND Timestamp of last action
        if (alert.handled_by) {
            let actionTime = "";
            if (alert.updated_at) {
                const d = new Date(alert.updated_at);
                actionTime = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }
                // Avoid displaying "System (AI)" time if we prefer it cleaner, but explicit is better
            statusHtml += `<div class="alert-meta-info">by ${alert.handled_by} <span style="opacity:0.7">(${actionTime})</span></div>`;
        }
        
            // Format Date column
        const alertDate = new Date(alert.created_at);
        const yyyy = alertDate.getFullYear();
        const mm = String(alertDate.getMonth() + 1).padStart(2, '0');
        const dd = String(alertDate.getDate()).padStart(2, '0');
        const displayTime = `${yyyy}/${mm}/${dd} ${alertDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
        
        tr.innerHTML = `
            <td data-label="Time" style="font-size:0.85em; white-space:nowrap;">${displayTime}</td>
            <td data-label="Severity"><span class="badge badge-${alert.severity}">${alert.severity}</span></td>
            <td data-label="Rule / Topic">
                <div style="font-weight:bold; font-size:0.9em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${alert.rule_name}</div>
                <div style="font-size:0.75em; color:var(--color-text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${alert.topic}">${alert.topic}</div>
            </td>
            <td data-label="Status">${statusHtml}</td>
            <td data-label="Value">${triggerHtml}</td>
            <td data-label="Action">
                <div style="display:flex; flex-direction:column; gap:5px;">
                    ${analysisHtml}
                    ${actionsHtml}
                </div>
            </td>
        `;
        
            // Listeners
        tr.querySelectorAll('.btn-ack').forEach(b => b.addEventListener('click', () => updateStatus(alert.id, 'acknowledged')));
        tr.querySelectorAll('.btn-resolve').forEach(b => b.addEventListener('click', () => updateStatus(alert.id, 'resolved')));
        
            // Modal Logic
        const viewBtn = tr.querySelector('.btn-view-analysis');
        if(viewBtn) {
            viewBtn.addEventListener('click', () => {
                const contentDiv = document.getElementById('analysis-content');
                if(contentDiv) {
                    if (window.marked) {
                        contentDiv.innerHTML = window.marked.parse(contentToModal);
                    } else {
                        contentDiv.textContent = contentToModal;
                    }
                }
                if(analysisModal) {
                        // Move to appropriate parent for Fullscreen visibility
                    if (document.fullscreenElement) {
                        document.fullscreenElement.appendChild(analysisModal);
                    } else {
                        document.body.appendChild(analysisModal);
                    }
                    analysisModal.style.display = 'flex';
                }
            });
        }
        activeAlertsTableBody.appendChild(tr);
    });
}

async function updateStatus(id, status) {
    try {
        await fetch(`api/alerts/${id}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        });
        loadActiveAlerts();
    } catch (e) { console.error(e); }
}