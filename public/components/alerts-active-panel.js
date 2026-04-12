/**
 * @license Apache License, Version 2.0 (the "License")
 */

import { confirmModal, showToast } from '../utils.js';

/**
 * Web Component for Active Alerts.
 */
class AlertsActivePanel extends HTMLElement {
    constructor() {
        super();
        this.allActiveAlerts = [];
        this.isMultiProvider = false;
        this.availableProviders = [];
    }

    connectedCallback() {
        this.render();
        this.loadActiveAlerts();
    }

    init(options = {}) {
        this.isMultiProvider = options.isMultiSource || false;
        const bConfigs = options.providerConfigs || [];
        const pConfigs = options.dataProviders || [];
        this.availableProviders = [...bConfigs, ...pConfigs];
        this.render();
        this.loadActiveAlerts();
    }

    async loadActiveAlerts() {
        try {
            const res = await fetch('api/alerts/active');
            this.allActiveAlerts = await res.json();
            this.renderTable();
        } catch (e) { 
            console.error("Failed to load alerts", e); 
        }
    }

    formatCompactTrigger(jsonStr) {
        try {
            const j = JSON.parse(jsonStr);
            if (typeof j !== 'object' || j === null) return String(j);
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

    parseAiResponse(fullText) {
        if (!fullText) return { trigger: null, action: null, report: null };
        const triggerMatch = fullText.match(/## TRIGGER\n(.*?)(?=\n##|$)/s);
        const actionMatch = fullText.match(/## ACTION\n(.*?)(?=\n##|$)/s);
        const reportMatch = fullText.match(/## REPORT\n([\s\S]*)/s); 
        return {
            trigger: triggerMatch ? triggerMatch[1].trim() : null,
            action: actionMatch ? actionMatch[1].trim() : null,
            report: reportMatch ? reportMatch[1].trim() : fullText 
        };
    }

    renderTable() {
        const tbody = this.querySelector('#active-alerts-body');
        if (!tbody) return;

        const hideResolved = this.querySelector('#chk-hide-resolved')?.checked;
        const searchInput = this.querySelector('#alerts-search-input');
        const searchVal = searchInput ? searchInput.value.trim().toLowerCase() : '';
        const providerFilterSelect = this.querySelector('#alerts-source-filter');
        const providerVal = providerFilterSelect ? providerFilterSelect.value : 'all';

        let filteredAlerts = this.allActiveAlerts;

        if (hideResolved) {
            filteredAlerts = filteredAlerts.filter(a => a.status !== 'resolved');
        }
        
        if (providerVal && providerVal !== 'all') {
            filteredAlerts = filteredAlerts.filter(a => a.source_id === providerVal);
        }

        if (searchVal) {
            filteredAlerts = filteredAlerts.filter(a => {
                const tMatch = (a.topic || '').toLowerCase().includes(searchVal);
                const rMatch = (a.rule_name || '').toLowerCase().includes(searchVal);
                const vMatch = (a.trigger_value || '').toLowerCase().includes(searchVal);
                return tMatch || rMatch || vMatch;
            });
        }

        tbody.innerHTML = '';
        
        if (filteredAlerts.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--color-text-secondary);"><svg xmlns="http://www.w3.org/2000/svg" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--color-success);"><polyline points="20 6 9 17 4 12"></polyline></svg> No active alerts match the filters.</td></tr>';
            return;
        }

        filteredAlerts.forEach(alert => {
            const tr = document.createElement('tr');
            const aiData = this.parseAiResponse(alert.analysis_result);
            
            let displayTrigger = aiData.trigger || this.formatCompactTrigger(alert.trigger_value);
            let fullJsonTooltip = alert.trigger_value;
            try { 
                fullJsonTooltip = JSON.stringify(JSON.parse(alert.trigger_value), null, 2).replace(/"/g, '&quot;');
            } catch(e) {}
            
            const triggerHtml = `<div class="compact-json" title="${fullJsonTooltip}">${this.sanitize(displayTrigger)}</div>`;

            let analysisHtml = '';
            let contentToModal = aiData.report || alert.analysis_result; 
            
            if (alert.status === 'analyzing') {
                analysisHtml = `<div style="color:var(--color-primary); font-size:0.85em;"><span class="connector-dot" style="background:var(--color-primary); animation:blink 1s infinite;"></span> Analyzing...</div>`;
            } else if (aiData.action) {
                analysisHtml = `
                    <div style="display:flex; align-items:center; gap:10px;">
                        <div class="ai-action-pill" title="${this.sanitize(aiData.action)}"><svg xmlns="http://www.w3.org/2000/svg" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--color-warning); margin:0 4px 0 0;"><path d="M9 18h6"></path><path d="M10 22h4"></path><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 11.2 4a4.65 4.65 0 0 0-5.3 7.5c.76.76 1.23 1.52 1.41 2.5h7.78z"></path></svg> ${this.sanitize(aiData.action)}</div>
                        <button class="btn-view-analysis tool-button" style="padding:2px 6px;" title="View Full Report"><svg xmlns="http://www.w3.org/2000/svg" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin:0;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></button>
                    </div>
                `;
            } else if (alert.analysis_result) {
                 const snippet = this.sanitize(alert.analysis_result).substring(0, 60) + "...";
                 analysisHtml = `
                    <div style="display:flex; align-items:center; gap:10px;">
                        <span style="font-size:0.85em; opacity:0.8;">${snippet}</span>
                        <button class="btn-view-analysis tool-button" style="padding:2px 6px;" title="View Full Report"><svg xmlns="http://www.w3.org/2000/svg" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin:0;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></button>
                    </div>
                `;
            } else {
                analysisHtml = '<span style="color:#ccc; font-size:0.8em;">Waiting...</span>';
            }

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
            if (alert.handled_by) {
                let actionTime = "";
                if (alert.updated_at) {
                    const d = new Date(alert.updated_at);
                    actionTime = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                }
                statusHtml += `<div class="alert-meta-info">by ${this.sanitize(alert.handled_by)} <span style="opacity:0.7">(${actionTime})</span></div>`;
            }

            const alertDate = new Date(alert.created_at);
            const displayTime = `${alertDate.getFullYear()}/${String(alertDate.getMonth() + 1).padStart(2, '0')}/${String(alertDate.getDate()).padStart(2, '0')} ${alertDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;

            tr.innerHTML = `
                <td data-label="Time" style="font-size:0.85em; white-space:nowrap;">${displayTime}</td>
                <td data-label="Severity"><span class="badge badge-${alert.severity}">${alert.severity}</span></td>
                <td data-label="Rule / Topic">
                    <div style="font-weight:bold; font-size:0.9em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${this.sanitize(alert.rule_name)}">${this.sanitize(alert.rule_name)}</div>
                    <div style="font-size:0.75em; color:var(--color-text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${this.sanitize(alert.topic)}">${this.sanitize(alert.topic)}</div>
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

            tr.querySelectorAll('.btn-ack').forEach(b => b.onclick = () => this.updateStatus(alert.id, 'acknowledged'));
            tr.querySelectorAll('.btn-resolve').forEach(b => b.onclick = () => this.updateStatus(alert.id, 'resolved'));
            
            const viewBtn = tr.querySelector('.btn-view-analysis');
            if(viewBtn) {
                viewBtn.onclick = () => this.showAnalysisModal(contentToModal);
            }

            tbody.appendChild(tr);
        });
    }

    async updateStatus(id, status) {
        try {
            await fetch(`api/alerts/${id}/status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status })
            });
            this.loadActiveAlerts();
        } catch (e) { console.error(e); }
    }

    showAnalysisModal(content) {
        const modal = this.querySelector('#analysis-modal');
        const contentDiv = this.querySelector('#analysis-content');
        if (modal && contentDiv) {
            if (window.marked) {
                contentDiv.innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(window.marked.parse(content)) : window.marked.parse(content);
            } else {
                contentDiv.textContent = content;
            }
            modal.style.display = 'flex';
        }
    }

    sanitize(str) {
        if (!str) return '';
        return window.DOMPurify ? window.DOMPurify.sanitize(str) : str.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    toggleFullscreen() {
        const panel = this.querySelector('.alerts-content-wrapper');
        const btn = this.querySelector('#btn-alerts-fullscreen');
        if (!document.fullscreenElement) {
            panel.requestFullscreen().catch(err => console.error(`Error enabling fullscreen: ${err.message}`));
            panel.classList.add('fullscreen-mode');
            if(btn) btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin:0;"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path></svg> Minimize';
        } else {
            document.exitFullscreen();
            panel.classList.remove('fullscreen-mode');
            if(btn) btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin:0;"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path></svg> Maximize';
        }
    }

    render() {
        let providerOptions = '<option value="all">All Brokers</option>';
        if (this.isMultiProvider) {
            this.availableProviders.forEach(p => {
                const typeLabel = p.type ? `[${p.type.toUpperCase()}]` : '[MQTT]';
                providerOptions += `<option value="${p.id}">${p.id} ${typeLabel}</option>`;
            });
        }

        this.innerHTML = `
            <div class="alerts-content-wrapper" style="display:flex; flex-direction:column; height:100%;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                    <h2>Live Dashboard</h2>
                    <div style="display:flex; align-items:center; gap:15px;">
                        <label style="font-size:0.9em; cursor:pointer; user-select:none; display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" id="chk-hide-resolved"> 
                            <strong>Hide Resolved</strong>
                        </label>
                        <button id="btn-alerts-fullscreen" class="tool-button" title="Toggle Fullscreen" style="padding: 4px 10px;"><svg xmlns="http://www.w3.org/2000/svg" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin:0;"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path></svg> Maximize</button>
                        <span style="font-size:0.8em; color:var(--color-text-secondary); border-left:1px solid var(--color-border); padding-left:15px;">Updates automatically</span>
                    </div>
                </div>
                
                <div class="alerts-controls" style="display: flex; gap: 10px; margin-bottom: 15px;">
                    <select id="alerts-source-filter" style="width: auto; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--color-border); background-color: var(--color-bg); color: var(--color-text); display: ${this.isMultiProvider ? 'block' : 'none'};">
                        ${providerOptions}
                    </select>
                    <input type="text" id="alerts-search-input" placeholder="Search alerts by topic, rule name or payload..." style="flex-grow: 1; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--color-border); background-color: var(--color-bg); color: var(--color-text);">
                    <button id="btn-alerts-refresh" class="tool-button"><svg xmlns="http://www.w3.org/2000/svg" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin:0 6px 0 0;"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg> Refresh</button>
                </div>

                <div id="alerts-table-wrapper" style="overflow-x: auto; flex-grow:1;">
                    <table class="alerts-table">
                        <thead>
                            <tr>
                                <th style="width: 130px;">Time</th> <th style="width: 90px;">Severity</th> <th style="width: 20%;">Rule / Topic</th>
                                <th style="width: 90px;">Status</th>
                                <th style="width: 15%;">Trigger Value</th> <th style="width: auto;">AI Analysis &amp; Actions</th> 
                            </tr>
                        </thead>
                        <tbody id="active-alerts-body">
                            <tr><td colspan="6" style="text-align:center;">Waiting for alerts...</td></tr>
                        </tbody>
                    </table>
                </div>

                <div id="analysis-modal" class="modal-backdrop" style="display:none; z-index: 3000; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); align-items:center; justify-content:center;">
                    <div class="help-modal-content" style="max-width: 800px; background:var(--color-bg); padding:20px; border-radius:8px; width:90%; max-height:90vh; overflow-y:auto; position:relative;">
                        <div style="display:flex; justify-content:space-between; margin-bottom:15px; border-bottom:1px solid var(--color-border); padding-bottom:10px;">
                            <h3 style="margin:0; display:flex; align-items:center; gap:8px;"><svg xmlns="http://www.w3.org/2000/svg" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin:0;"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8" y2="16"></line><line x1="16" y1="16" x2="16" y2="16"></line></svg> AI Analysis Report</h3>
                            <button id="btn-close-analysis" style="background:none; border:none; font-size:1.5em; cursor:pointer; color:var(--color-text);"><svg xmlns="http://www.w3.org/2000/svg" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin:0;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
                        </div>
                        <div id="analysis-content" class="analysis-content" style="line-height:1.6;"></div>
                        <div style="text-align:right; margin-top:20px;">
                             <button id="btn-close-analysis-2" class="tool-button">Close</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        this.querySelector('#chk-hide-resolved').onchange = () => this.renderTable();
        this.querySelector('#alerts-search-input').oninput = () => this.renderTable();
        this.querySelector('#alerts-source-filter').onchange = () => this.renderTable();
        this.querySelector('#btn-alerts-refresh').onclick = () => this.loadActiveAlerts();
        this.querySelector('#btn-alerts-fullscreen').onclick = () => this.toggleFullscreen();

        const closeModal = () => { this.querySelector('#analysis-modal').style.display = 'none'; };
        this.querySelector('#btn-close-analysis').onclick = closeModal;
        this.querySelector('#btn-close-analysis-2').onclick = closeModal;

        // Listen for external refresh requests
        this.addEventListener('refresh-alerts', () => this.loadActiveAlerts());
    }
}

customElements.define('alerts-active-panel', AlertsActivePanel);
