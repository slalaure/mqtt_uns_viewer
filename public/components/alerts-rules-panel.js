/**
 * @license Apache License, Version 2.0 (the "License")
 */

import { confirmModal, showToast } from '../utils.js';
import { state, subscribe, unsubscribe } from '../state.js';

/**
 * Web Component for Alert Rules.
 */
class AlertsRulesPanel extends HTMLElement {
    constructor() {
        super();
        this.rules = [];
        this.aceEditor = null;
        this.editingRuleId = null;
        this.isMounted = false;
    }

    connectedCallback() {
        if (!this.isMounted) {
            this.render();
            this.initAceEditor();
            this.isMounted = true;
        }
        this.loadRules();
    }

    disconnectedCallback() {
        if (this.aceEditor) {
            this.aceEditor.destroy();
            this.aceEditor = null;
        }
    }

    initAceEditor() {
        if (window.ace && !this.aceEditor) {
            const editorEl = this.querySelector('#rule-condition-editor');
            if (editorEl) {
                this.aceEditor = ace.edit(editorEl);
                this.aceEditor.setTheme(state.isDarkMode ? 'ace/theme/tomorrow_night' : 'ace/theme/chrome');
                this.aceEditor.session.setMode("ace/mode/javascript");
                this.aceEditor.setValue("return msg.payload.value > 50;", -1);
                this.aceEditor.session.on('change', () => { state.ruleUnsaved = true; });
                
                subscribe('isDarkMode', (isDark) => {
                    if (this.aceEditor) {
                        this.aceEditor.setTheme(isDark ? 'ace/theme/tomorrow_night' : 'ace/theme/chrome');
                    }
                });
            }
        }
    }

    async loadRules() {
        const tbody = this.querySelector('#alert-rules-body');
        if (!tbody) return;

        try {
            const res = await fetch('api/alerts/rules');
            this.rules = await res.json();
            
            tbody.innerHTML = '';
            if (this.rules.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 20px;">No rules defined.</td></tr>';
                return;
            }

            this.rules.forEach(rule => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td data-label="Name" title="${this.sanitize(rule.name)}">
                        <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width:200px;"><strong>${this.sanitize(rule.name)}</strong></div>
                    </td>
                    <td data-label="Topic" title="${this.sanitize(rule.topic_pattern)}">
                        <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width:200px;"><code>${this.sanitize(rule.topic_pattern)}</code></div>
                    </td>
                    <td data-label="Severity"><span class="badge badge-${rule.severity}">${rule.severity}</span></td>
                    <td data-label="Actions">
                        <button class="tool-button btn-edit" title="Edit">Edit</button>
                        <button class="tool-button btn-delete" style="color:var(--color-danger); border-color:var(--color-danger);" title="Delete">Delete</button>
                    </td>
                `;
                tr.querySelector('.btn-edit').onclick = () => this.showRuleEditor(rule);
                tr.querySelector('.btn-delete').onclick = () => this.deleteRule(rule.id);
                tbody.appendChild(tr);
            });
        } catch (e) { 
            console.error("Failed to load rules", e); 
        }
    }

    showRuleEditor(ruleToEdit = null) {
        state.ruleUnsaved = false;
        this.querySelector('#rules-list-container').style.display = 'none';
        this.querySelector('#rule-editor-container').style.display = 'block';
        const form = this.querySelector('#rule-form');

        if (ruleToEdit) {
            this.editingRuleId = ruleToEdit.id;
            this.querySelector('#rule-editor-title').textContent = "Edit Rule";
            form.elements.name.value = ruleToEdit.name;
            form.elements.topic_pattern.value = ruleToEdit.topic_pattern;
            form.elements.severity.value = ruleToEdit.severity;
            form.elements.workflow_prompt.value = ruleToEdit.workflow_prompt || '';
            let webhookUrl = '';
            try { webhookUrl = JSON.parse(ruleToEdit.notifications || '{}').webhook || ''; } catch(e){}
            form.elements.webhook.value = webhookUrl;
            
            if (this.aceEditor) this.aceEditor.setValue(ruleToEdit.condition_code, -1);
        } else {
            this.editingRuleId = null;
            this.querySelector('#rule-editor-title').textContent = "Create New Rule";
            form.reset();
            if (this.aceEditor) this.aceEditor.setValue("return msg.payload.value > 50;", -1);
        }
        this.updateSaveButtonState(false);
    }

    hideRuleEditor() {
        this.querySelector('#rules-list-container').style.display = 'block';
        this.querySelector('#rule-editor-container').style.display = 'none';
        this.editingRuleId = null;
        state.ruleUnsaved = false;
        this.updateSaveButtonState(false);
    }

    async saveRule() {
        const form = this.querySelector('#rule-form');
        const formData = new FormData(form);
        const data = {
            name: formData.get('name'),
            topic_pattern: formData.get('topic_pattern'),
            severity: formData.get('severity'),
            condition_code: this.aceEditor ? this.aceEditor.getValue() : "return true;",
            workflow_prompt: formData.get('workflow_prompt'),
            notifications: JSON.stringify({ webhook: formData.get('webhook') })
        };

        try {
            let url = 'api/alerts/rules';
            let method = 'POST';
            
            if (this.editingRuleId) { 
                url = `api/alerts/rules/${this.editingRuleId}`; 
                method = 'PUT'; 
            }

            const res = await fetch(url, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });

            if (!res.ok) throw new Error((await res.json()).error);
            
            showToast("Rule saved successfully.", "success");
            state.ruleUnsaved = false;
            this.hideRuleEditor();
            this.loadRules();
        } catch (e) { 
            showToast("Error: " + e.message, "error"); 
        }
    }

    async deleteRule(id) {
        const isConfirmed = await confirmModal("Delete Rule", "Are you sure you want to delete this alert rule?", "Delete", true);
        if (!isConfirmed) return;

        try {
            await fetch(`api/alerts/rules/${id}`, { method: 'DELETE' });
            showToast("Rule deleted.", "success");
            this.loadRules();
        } catch (e) { 
            showToast("Delete failed.", "error"); 
        }
    }

    updateSaveButtonState(isUnsaved) {
        const btnSave = this.querySelector('#rule-form button[type="submit"]');
        if (btnSave) {
            if (isUnsaved) btnSave.classList.add('btn-unsaved');
            else btnSave.classList.remove('btn-unsaved');
        }
    }

    openCreateFromTopic(topic, payload) {
        this.showRuleEditor();
        const form = this.querySelector('#rule-form');
        form.elements.topic_pattern.value = topic;
        
        let condition = "return true;";
        if (payload && typeof payload === 'object') {
            const keys = Object.keys(payload);
            if (keys.length > 0) {
                const key = keys[0];
                const val = payload[key];
                if (typeof val === 'number') condition = `return msg.payload.${key} > ${val};`;
            }
        }
        if (this.aceEditor) this.aceEditor.setValue(condition, -1);
    }

    sanitize(str) {
        if (!str) return '';
        return window.DOMPurify ? window.DOMPurify.sanitize(str) : str.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    render() {
        this.innerHTML = `
            <div id="rules-list-container">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                    <h2>Detection Rules</h2>
                    <button id="btn-new-rule" class="tool-button button-primary"><svg xmlns="http://www.w3.org/2000/svg" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin:0 4px 0 0;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> New Rule</button>
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
                    <button id="btn-cancel-rule" class="tool-button">Cancel</button>
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
                            <span id="btn-js-help" class="info-icon" title="See Examples" style="cursor:pointer;"><svg xmlns="http://www.w3.org/2000/svg" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin:0;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg></span>
                        </div>
                        <span class="help-text">
                            Available vars: <code>msg.payload</code>, <code>msg.topic</code>. <br>
                            Must return <code>true</code> to trigger. Async <code>await db.get(...)</code> supported.
                        </span>
                        <div id="rule-condition-editor" class="code-editor-wrapper" style="height:150px; border:1px solid var(--color-border); border-radius:4px;"></div>
                    </div>
                    <div class="form-group">
                        <label>AI Analysis Prompt (Workflow)</label>
                        <textarea name="workflow_prompt" rows="3" placeholder="e.g. Analyze this temperature spike. Check maintenance logs for this machine."></textarea>
                    </div>
                    <div class="form-group">
                        <div class="label-with-icon">
                            <label style="margin:0;">Webhook URL (HTTP POST)</label>
                            <span class="info-icon" title="Trigger external systems"><svg xmlns="http://www.w3.org/2000/svg" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin:0;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg></span>
                        </div>
                        <span class="help-text">Enter a URL to receive a POST request when alert triggers.</span>
                        <input type="text" name="webhook" placeholder="https://chat.googleapis.com/v1/spaces/AAAA/messages?key=...">
                    </div>
                    <div style="text-align:right;">
                        <button type="submit" class="tool-button button-primary">Save Rule</button>
                    </div>
                </form>
            </div>

            <div id="alert-help-modal" class="modal-backdrop" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:4000; align-items:center; justify-content:center;">
                <div class="help-modal-content" style="background:var(--color-bg); padding:20px; border-radius:8px; width:90%; max-width:600px; max-height: 85vh; overflow-y: auto; box-shadow: 0 15px 50px rgba(0,0,0,0.5); border: 1px solid var(--color-border); position: relative;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:15px;">
                        <h3 style="margin:0;">JavaScript Condition Examples</h3>
                        <button id="btn-close-help" style="background:none; border:none; font-size:1.5em; cursor:pointer;"><svg xmlns="http://www.w3.org/2000/svg" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin:0;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
                    </div>
                    <div class="example-block" style="background-color: var(--color-bg-tertiary); border: 1px solid var(--color-border); border-radius: 6px; padding: 15px; margin-bottom: 15px;">
                        <div class="example-title" style="font-weight: bold; margin-bottom: 8px; color: var(--color-primary);">1. Simple Threshold (JSON)</div>
                        <pre style="background:var(--color-code-bg); color:var(--color-code-text); padding:10px; border-radius:4px; font-size:0.85em; font-family:'Courier New', monospace; overflow-x:auto;">return msg.payload.value > 70;</pre>
                    </div>
                    <div class="example-block" style="background-color: var(--color-bg-tertiary); border: 1px solid var(--color-border); border-radius: 6px; padding: 15px; margin-bottom: 15px;">
                        <div class="example-title" style="font-weight: bold; margin-bottom: 8px; color: var(--color-primary);">2. Sparkplug B</div>
                        <pre style="background:var(--color-code-bg); color:var(--color-code-text); padding:10px; border-radius:4px; font-size:0.85em; font-family:'Courier New', monospace; overflow-x:auto;">
if (!msg.payload.metrics) return false;
const metric = msg.payload.metrics.find(m => m.name === "Motor/Temp");
return metric && metric.value > 80.0;</pre>
                    </div>
                    <div style="text-align:right; margin-top:20px;">
                         <button id="btn-close-help-2" class="tool-button">Close</button>
                    </div>
                </div>
            </div>
        `;

        this.querySelector('#btn-new-rule').onclick = () => this.showRuleEditor();
        this.querySelector('#btn-cancel-rule').onclick = () => this.hideRuleEditor();
        
        const form = this.querySelector('#rule-form');
        form.onsubmit = (e) => { e.preventDefault(); this.saveRule(); };
        form.oninput = () => { state.ruleUnsaved = true; };

        subscribe('ruleUnsaved', (isUnsaved) => this.updateSaveButtonState(isUnsaved));

        const showHelp = () => { this.querySelector('#alert-help-modal').style.display = 'flex'; };
        const hideHelp = () => { this.querySelector('#alert-help-modal').style.display = 'none'; };
        
        this.querySelector('#btn-js-help').onclick = showHelp;
        this.querySelector('#btn-close-help').onclick = hideHelp;
        this.querySelector('#btn-close-help-2').onclick = hideHelp;
    }
}

customElements.define('alerts-rules-panel', AlertsRulesPanel);
