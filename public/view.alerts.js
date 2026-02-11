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
 * [UPDATED] Uses Dynamic HTML Fragment Loading to keep index.html clean.
 * [UPDATED] Integrated marked.js for Markdown rendering of AI analysis reports.
 */
// --- Imports ---
import { trackEvent } from './utils.js';
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
// --- State ---
let aceEditor = null; // For condition code
let editingRuleId = null; // Track if we are editing an existing rule
let isViewInitialized = false;
/**
 * Initialize the Alerts View.
 * Fetches HTML template dynamically to keep JS clean and index.html light.
 */
export async function initAlertsView() {
    container = document.getElementById('alerts-view');
    if (!container) return;
    // --- 1. Fetch and Inject HTML Fragment ---
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
    // --- 2. Element References ---
    activeAlertsTableBody = document.getElementById('active-alerts-body');
    rulesTableBody = document.getElementById('alert-rules-body');
    ruleForm = document.getElementById('rule-form');
    btnNewRule = document.getElementById('btn-new-rule');
    ruleEditorContainer = document.getElementById('rule-editor-container');
    rulesListContainer = document.getElementById('rules-list-container');
    helpModal = document.getElementById('alert-help-modal');
    analysisModal = document.getElementById('analysis-modal');
    ruleEditorTitle = document.getElementById('rule-editor-title');
    // --- 3. Event Listeners ---
    // Tabs Navigation
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
    document.getElementById('chk-hide-resolved').addEventListener('change', loadActiveAlerts);
    // Rule Editor Controls
    btnNewRule.addEventListener('click', () => showRuleEditor());
    document.getElementById('btn-cancel-rule').addEventListener('click', hideRuleEditor);
    // Help Modal Controls
    document.getElementById('btn-js-help').addEventListener('click', () => helpModal.style.display = 'flex');
    document.getElementById('btn-close-help').addEventListener('click', () => helpModal.style.display = 'none');
    document.getElementById('btn-close-help-2').addEventListener('click', () => helpModal.style.display = 'none');
    // Analysis Modal Controls
    document.getElementById('btn-close-analysis').addEventListener('click', () => analysisModal.style.display = 'none');
    document.getElementById('btn-close-analysis-2').addEventListener('click', () => analysisModal.style.display = 'none');
    ruleForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await saveRule();
    });
    // --- 4. Init Ace Editor ---
    if (window.ace) {
        aceEditor = ace.edit("rule-condition-editor");
        aceEditor.setTheme(document.body.classList.contains('dark-mode') ? 'ace/theme/tomorrow_night' : 'ace/theme/chrome');
        aceEditor.session.setMode("ace/mode/javascript");
        aceEditor.setValue("return msg.payload.value > 50;", -1);
    }
    isViewInitialized = true;
    console.log("✅ Alerts View Initialized (Async HTML Load)");
    // [FIX] Check if the view is ALREADY active (user clicked tab while loading)
    // If so, trigger the data load now that DOM is ready.
    if (container.classList.contains('active')) {
        // Determine which sub-tab is active to load the right data
        const activeSubTab = container.querySelector('.sub-tab-button.active');
        if (activeSubTab && activeSubTab.dataset.target === 'alert-rules-panel') {
            loadRules();
        } else {
            loadActiveAlerts();
        }
    }
}
// --- View Lifecycle ---
export function onAlertsViewShow() {
    // Only try to load if init is complete. 
    // If not complete, the initAlertsView function (above) will handle the load when it finishes.
    if (isViewInitialized) {
        loadActiveAlerts();
    }
}
export function onAlertsViewHide() { }
// --- Public API for app.js ---
export function refreshAlerts() {
    if (isViewInitialized && container && container.querySelector('#active-alerts-panel').classList.contains('active')) {
        loadActiveAlerts();
    }
}
export function openCreateRuleModal(topic, examplePayload) {
    if (!isViewInitialized) {
        console.warn("Alerts view not ready yet.");
        return;
    }
    // Switch to Rules Tab
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
            if (typeof val === 'number') {
                condition = `return msg.payload.${key} > ${val};`;
            }
        }
    }
    if (aceEditor) aceEditor.setValue(condition, -1);
}
// --- Logic: Rules ---
function showRuleEditor(ruleToEdit = null) {
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
        if (aceEditor) {
            aceEditor.setValue(ruleToEdit.condition_code, -1);
        }
    } else {
        editingRuleId = null;
        ruleEditorTitle.textContent = "Create New Rule";
        ruleForm.reset();
        if (aceEditor) aceEditor.setValue("return msg.payload.value > 50;", -1);
    }
}
function hideRuleEditor() {
    rulesListContainer.style.display = 'block';
    ruleEditorContainer.style.display = 'none';
    editingRuleId = null;
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
                <td><strong>${rule.name}</strong></td>
                <td><code>${rule.topic_pattern}</code></td>
                <td><span class="badge badge-${rule.severity}">${rule.severity}</span></td>
                <td>
                    <button class="btn-action btn-edit" title="Edit">Edit</button>
                    <button class="btn-action btn-delete" title="Delete">Delete</button>
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
        notifications: {
            webhook: formData.get('webhook')
        }
    };
    try {
        let url = 'api/alerts/rules';
        let method = 'POST';
        if (editingRuleId) {
            url = `api/alerts/rules/${editingRuleId}`;
            method = 'PUT';
        }
        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!res.ok) throw new Error((await res.json()).error);
        alert("Rule saved successfully!");
        hideRuleEditor();
        loadRules();
    } catch (e) { alert("Error: " + e.message); }
}
async function deleteRule(id) {
    if (!confirm("Delete this rule?")) return;
    try {
        await fetch(`api/alerts/rules/${id}`, { method: 'DELETE' });
        loadRules();
    } catch (e) { alert("Delete failed."); }
}
// --- Logic: Alerts ---
async function loadActiveAlerts() {
    try {
        const res = await fetch('api/alerts/active');
        let alerts = await res.json();
        const hideResolved = document.getElementById('chk-hide-resolved')?.checked;
        if (hideResolved) {
            alerts = alerts.filter(a => a.status !== 'resolved');
        }
        activeAlertsTableBody.innerHTML = '';
        if (alerts.length === 0) {
            activeAlertsTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--color-text-secondary);">✅ No active alerts. All systems nominal.</td></tr>';
            return;
        }
        alerts.forEach(alert => {
            const tr = document.createElement('tr');
            let displayVal = alert.trigger_value;
            try { 
                const j = JSON.parse(alert.trigger_value); 
                displayVal = `<pre style="margin:0; font-size:0.8em; max-height:80px; overflow:auto;">${JSON.stringify(j, null, 2)}</pre>`;
            } catch(e){}
            // Analysis Section with Status
            let analysisHtml = '';
            if (alert.status === 'analyzing') {
                analysisHtml = `<div style="color:var(--color-primary); display:flex; align-items:center; gap:6px;">
                    <span class="broker-dot" style="background:var(--color-primary); animation:blink 1s infinite;"></span> AI Analyzing...
                </div>`;
            } else if (alert.analysis_result) {
                // Use marked to render small snippet, then strip HTML for safety or just keep snippet clean
                const rawMarkdown = alert.analysis_result;
                const snippet = rawMarkdown.substring(0, 150) + (rawMarkdown.length > 150 ? "..." : "");
                
                // If marked is available, we render the snippet
                const renderedSnippet = window.marked ? window.marked.parse(snippet) : snippet;

                analysisHtml = `
                    <div style="font-size:0.9em; border: 1px solid var(--color-border-secondary); padding: 8px; border-radius: 4px; background: var(--color-bg-tertiary);">
                        🤖 <strong>AI Report:</strong> 
                        <div class="markdown-content">${renderedSnippet}</div>
                        <button class="mapper-button btn-view-analysis" style="margin-top:10px; font-size:0.8em; padding:4px 10px; width: 100%;">📄 View Full Report</button>
                    </div>
                `;
            } else {
                analysisHtml = '<span style="color:#ccc; font-style:italic;">No analysis requested.</span>';
            }
            let actionsHtml = '';
            if (alert.status !== 'resolved') {
                if (alert.status !== 'acknowledged') {
                    actionsHtml += `<button class="btn-action btn-ack" data-id="${alert.id}">Ack</button>`;
                }
                actionsHtml += `<button class="btn-action btn-resolve" data-id="${alert.id}">Resolve</button>`;
            }
            let statusHtml = `<span class="badge badge-${alert.status}">${alert.status}</span>`;
            if (alert.handled_by) {
                statusHtml += `<div style="font-size:0.8em; margin-top:4px; color:var(--color-text-secondary); font-style:italic;">by ${alert.handled_by}</div>`;
            }
            tr.innerHTML = `
                <td style="font-size:0.9em; white-space:nowrap;">${new Date(alert.created_at).toLocaleString()}</td>
                <td><span class="badge badge-${alert.severity}">${alert.severity}</span></td>
                <td>
                    <div style="font-weight:bold;">${alert.rule_name}</div>
                    <div style="font-size:0.8em; color:var(--color-text-secondary); word-break:break-all;">${alert.topic}</div>
                </td>
                <td>${statusHtml}</td>
                <td>${displayVal}</td>
                <td>
                    <div style="margin-bottom:8px;">${actionsHtml}</div>
                    ${analysisHtml}
                </td>
            `;
            // Listeners
            tr.querySelectorAll('.btn-ack').forEach(b => b.addEventListener('click', () => updateStatus(alert.id, 'acknowledged')));
            tr.querySelectorAll('.btn-resolve').forEach(b => b.addEventListener('click', () => updateStatus(alert.id, 'resolved')));
            // Open Analysis Modal
            const viewBtn = tr.querySelector('.btn-view-analysis');
            if(viewBtn) {
                viewBtn.addEventListener('click', () => {
                    const contentDiv = document.getElementById('analysis-content');
                    if(contentDiv) {
                        // Full Markdown Render in modal
                        if (window.marked) {
                            contentDiv.innerHTML = window.marked.parse(alert.analysis_result);
                        } else {
                            contentDiv.textContent = alert.analysis_result;
                        }
                    }
                    if(analysisModal) analysisModal.style.display = 'flex';
                });
            }
            activeAlertsTableBody.appendChild(tr);
        });
    } catch (e) { console.error("Failed to load alerts", e); }
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