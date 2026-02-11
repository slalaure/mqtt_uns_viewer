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
let ruleEditorTitle = null;

// --- State ---
let refreshTimer = null;
let aceEditor = null; // For condition code
let editingRuleId = null; // Track if we are editing an existing rule

/**
 * Initialize the Alerts View.
 */
export function initAlertsView() {
    container = document.getElementById('alerts-view');
    if (!container) return;

    // --- 1. Inject UI Structure ---
    // Note: We escape backticks inside the HTML string with a backslash (\`) to prevent syntax errors.
    container.innerHTML = `
        <div class="alerts-sub-nav">
            <button class="sub-tab-button active" data-target="active-alerts-panel">🚨 Active Alerts</button>
            <button class="sub-tab-button" data-target="alert-rules-panel">⚙️ Alert Rules</button>
        </div>

        <div id="active-alerts-panel" class="alerts-content-container active">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                <h2>Live Dashboard</h2>
                <div style="display:flex; align-items:center; gap:20px;">
                    <label style="font-size:0.9em; cursor:pointer; user-select:none; display:flex; align-items:center; gap:6px;">
                        <input type="checkbox" id="chk-hide-resolved"> 
                        <strong>Hide Resolved</strong>
                    </label>
                    <span style="font-size:0.8em; color:var(--color-text-secondary); border-left:1px solid #ccc; padding-left:15px;">Updates automatically</span>
                </div>
            </div>
            <table class="alerts-table">
                <thead>
                    <tr>
                        <th style="width: 120px;">Time</th>
                        <th>Severity</th>
                        <th>Rule / Topic</th>
                        <th>Status</th>
                        <th>Trigger Value</th>
                        <th>Analysis / Actions</th>
                    </tr>
                </thead>
                <tbody id="active-alerts-body">
                    <tr><td colspan="6" style="text-align:center;">Waiting for alerts...</td></tr>
                </tbody>
            </table>
        </div>

        <div id="alert-rules-panel" class="alerts-content-container">
            <div id="rules-list-container">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                    <h2>Detection Rules</h2>
                    <button id="btn-new-rule" class="modal-button button-primary">+ New Rule</button>
                </div>
                <table class="alerts-table">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Topic Pattern</th>
                            <th>Severity</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody id="alert-rules-body">
                        <tr><td colspan="4" style="text-align:center;">Loading...</td></tr>
                    </tbody>
                </table>
            </div>

            <div id="rule-editor-container" class="rule-editor-container" style="display:none;">
                <div class="rule-editor-header">
                    <h3 id="rule-editor-title">Create / Edit Rule</h3>
                    <button id="btn-cancel-rule" class="modal-button">Cancel</button>
                </div>
                <form id="rule-form">
                    <div class="form-group">
                        <label>Rule Name</label>
                        <input type="text" name="name" required placeholder="e.g. High Temp Warning">
                    </div>
                    <div class="form-group">
                        <label>Topic Pattern (Wildcards allowed)</label>
                        <input type="text" name="topic_pattern" required placeholder="e.g. factory/+/temp">
                    </div>
                    <div class="form-group">
                        <label>Severity</label>
                        <select name="severity">
                            <option value="info">Info</option>
                            <option value="warning">Warning</option>
                            <option value="critical">Critical</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <div class="label-with-icon">
                            <label style="margin:0;">Condition (JavaScript)</label>
                            <span id="btn-js-help" class="info-icon" title="See Examples">ℹ️</span>
                        </div>
                        <span class="help-text">
                            Available vars: <code>msg.payload</code>, <code>msg.topic</code>. <br>
                            Must return <code>true</code> to trigger. Async <code>await db.get(...)</code> supported.
                        </span>
                        <div id="rule-condition-editor" class="code-editor-wrapper"></div>
                    </div>
                    <div class="form-group">
                        <label>AI Analysis Prompt (Workflow)</label>
                        <textarea name="workflow_prompt" rows="3" placeholder="e.g. Analyze this temperature spike. Check maintenance logs for this machine."></textarea>
                    </div>
                    <div class="form-group">
                        <div class="label-with-icon">
                            <label style="margin:0;">Webhook URL (HTTP POST)</label>
                            <span class="info-icon" title="Trigger external systems">🔗</span>
                        </div>
                        <span class="help-text">Enter a URL to receive a POST request when alert triggers. <br>Example: <code>https://chat.googleapis.com/v1/spaces/AAAA/messages?key=...</code> (Google Chat) or Slack/Teams webhook.</span>
                        <input type="text" name="webhook" placeholder="https://chat.googleapis.com/v1/spaces/AAAA/messages?key=...">
                    </div>
                    <div style="text-align:right;">
                        <button type="submit" class="modal-button button-primary">Save Rule</button>
                    </div>
                </form>
            </div>
        </div>

        <div id="alert-help-modal" class="modal-backdrop" style="display:none;">
            <div class="help-modal-content">
                <div style="display:flex; justify-content:space-between; margin-bottom:15px;">
                    <h3 style="margin:0;">JavaScript Condition Examples</h3>
                    <button id="btn-close-help" style="background:none; border:none; font-size:1.5em; cursor:pointer;">&times;</button>
                </div>
                
                <div class="example-block">
                    <div class="example-title">1. Simple Threshold (Stark Industries)</div>
                    <div class="example-code">// Topic: stark_industries/malibu_facility/assembly_line_01/palladium_core_cell/robotic_arm_01/temperature
// Trigger if temp > 70
return msg.payload.value > 70;</div>
                </div>

                <div class="example-block">
                    <div class="example-title">2. Status Check (Paris Metro)</div>
                    <div class="example-code">// Topic: ratp/uns/line/1/status
// Trigger if status is NOT 'OK'
if (msg.payload.status && msg.payload.status !== 'OK') {
    return true; 
}
return false;</div>
                </div>

                <div class="example-block">
                    <div class="example-title">3. Contextual Data (Death Star - Reactor)</div>
                    <div class="example-code">// Topic: galactic_empire/death_star/power_systems/main_reactor/output
// Trigger if current output is 20% higher than average of last 10 readings

// Get average from history using SQL (Note: Backticks escaped)
const result = await db.get(\`
    SELECT AVG(CAST(payload->>'value' AS FLOAT)) as avg_val 
    FROM mqtt_events 
    WHERE topic = '\${msg.topic}' 
    ORDER BY timestamp DESC LIMIT 10
\`);

if (result && result.avg_val) {
    const threshold = result.avg_val * 1.20; // +20%
    return msg.payload.value > threshold;
}
return false;</div>
                </div>

                <div style="text-align:right;">
                     <button id="btn-close-help-2" class="modal-button">Close</button>
                </div>
            </div>
        </div>
    `;

    // --- 2. Element References ---
    activeAlertsTableBody = document.getElementById('active-alerts-body');
    rulesTableBody = document.getElementById('alert-rules-body');
    ruleForm = document.getElementById('rule-form');
    btnNewRule = document.getElementById('btn-new-rule');
    ruleEditorContainer = document.getElementById('rule-editor-container');
    rulesListContainer = document.getElementById('rules-list-container');
    helpModal = document.getElementById('alert-help-modal');
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
    
    // [NEW] Checkbox listener
    document.getElementById('chk-hide-resolved').addEventListener('change', loadActiveAlerts);
    
    // Rule Editor Controls
    btnNewRule.addEventListener('click', () => showRuleEditor());
    document.getElementById('btn-cancel-rule').addEventListener('click', hideRuleEditor);
    
    // Help Modal Controls
    document.getElementById('btn-js-help').addEventListener('click', () => helpModal.style.display = 'flex');
    document.getElementById('btn-close-help').addEventListener('click', () => helpModal.style.display = 'none');
    document.getElementById('btn-close-help-2').addEventListener('click', () => helpModal.style.display = 'none');
    
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
}

// --- View Lifecycle ---
export function onAlertsViewShow() {
    loadActiveAlerts();
    // No polling anymore, driven by WS events from app.js
}

export function onAlertsViewHide() {
    // Cleanup if needed
}

// --- Public API for app.js ---
export function refreshAlerts() {
    // Only refresh if the view is currently visible and on the dashboard tab
    if (container && container.querySelector('#active-alerts-panel').classList.contains('active')) {
        loadActiveAlerts();
    }
}

/**
 * Open the Rule Editor, optionally pre-filled from Tree Context Menu.
 */
export function openCreateRuleModal(topic, examplePayload) {
    // Switch to Rules tab
    document.querySelector('.sub-tab-button[data-target="alert-rules-panel"]').click();
    showRuleEditor();
    
    // Pre-fill
    ruleForm.elements.topic_pattern.value = topic;
    
    // Generate simple condition based on payload type
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
        // Mode Edit
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
        // Mode Create
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
            
            // Attach event listeners safely
            tr.querySelector('.btn-edit').addEventListener('click', () => showRuleEditor(rule));
            tr.querySelector('.btn-delete').addEventListener('click', () => deleteRule(rule.id));
            
            rulesTableBody.appendChild(tr);
        });
    } catch (e) {
        console.error("Failed to load rules", e);
    }
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
        
        // If editing, switch to PUT and add ID
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
    } catch (e) {
        alert("Error: " + e.message);
    }
}

async function deleteRule(id) {
    if (!confirm("Delete this rule?")) return;
    try {
        await fetch(`api/alerts/rules/${id}`, { method: 'DELETE' });
        loadRules();
    } catch (e) {
        alert("Delete failed.");
    }
}

// --- Logic: Alerts ---

async function loadActiveAlerts() {
    try {
        const res = await fetch('api/alerts/active');
        let alerts = await res.json();
        
        // [NEW] Client-side Filtering
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
            
            // Format trigger value nicely
            let displayVal = alert.trigger_value;
            try { 
                const j = JSON.parse(alert.trigger_value); 
                displayVal = `<pre style="margin:0; font-size:0.8em;">${JSON.stringify(j, null, 2)}</pre>`;
            } catch(e){}

            // Analysis Section
            let analysisHtml = '';
            if (alert.status === 'analyzing') {
                analysisHtml = `<div style="color:var(--color-primary);"><span class="broker-dot" style="background:var(--color-primary); display:inline-block; animation:blink 1s infinite;"></span> AI Analyzing...</div>`;
            } else if (alert.analysis_result) {
                analysisHtml = `<div class="analysis-box">🤖 <strong>AI Report:</strong><br>${alert.analysis_result}</div>`;
            }

            // Actions Buttons
            let actionsHtml = '';
            if (alert.status !== 'resolved') {
                if (alert.status !== 'acknowledged') {
                    actionsHtml += `<button class="btn-action btn-ack" data-id="${alert.id}">Ack</button>`;
                }
                actionsHtml += `<button class="btn-action btn-resolve" data-id="${alert.id}">Resolve</button>`;
            }

            // [NEW] Display who handled the alert
            let statusHtml = `<span class="badge badge-${alert.status}">${alert.status}</span>`;
            if (alert.handled_by) {
                statusHtml += `<div style="font-size:0.8em; margin-top:4px; color:var(--color-text-secondary); font-style:italic;">by ${alert.handled_by}</div>`;
            }

            tr.innerHTML = `
                <td style="font-size:0.9em; white-space:nowrap;">${new Date(alert.created_at).toLocaleString()}</td>
                <td><span class="badge badge-${alert.severity}">${alert.severity}</span></td>
                <td>
                    <div style="font-weight:bold;">${alert.rule_name}</div>
                    <div style="font-size:0.8em; color:var(--color-text-secondary);">${alert.topic}</div>
                </td>
                <td>${statusHtml}</td>
                <td>${displayVal}</td>
                <td>
                    <div style="margin-bottom:5px;">${actionsHtml}</div>
                    ${analysisHtml}
                </td>
            `;

            tr.querySelectorAll('.btn-ack').forEach(b => b.addEventListener('click', () => updateStatus(alert.id, 'acknowledged')));
            tr.querySelectorAll('.btn-resolve').forEach(b => b.addEventListener('click', () => updateStatus(alert.id, 'resolved')));

            activeAlertsTableBody.appendChild(tr);
        });
    } catch (e) {
        console.error("Failed to load alerts", e);
    }
}

async function updateStatus(id, status) {
    try {
        await fetch(`api/alerts/${id}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        });
        loadActiveAlerts();
    } catch (e) {
        console.error(e);
    }
}