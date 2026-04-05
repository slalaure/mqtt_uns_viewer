/**
 * @license Apache License, Version 2.0 (the "License")
 */

import { confirmModal, showToast } from '../utils.js';

/**
 * Web Component for the Chart Configuration Bar.
 */
class ChartConfigBar extends HTMLElement {
    constructor() {
        super();
    }

    connectedCallback() {
        this.render();
        this.setupEventListeners();
    }

    render() {
        this.innerHTML = `
            <div class="chart-config-bar">
                <div class="form-group">
                    <label for="chart-config-select">Saved Charts:</label>
                    <select id="chart-config-select">
                        <option value="">-- New Chart --</option>
                    </select>
                </div>
                <button id="btn-chart-save-current" class="tool-button button-primary" title="Save">Save</button>
                <button id="btn-chart-save-as" class="tool-button" title="Save As New...">Save As...</button>
                <button id="btn-chart-delete-config" class="tool-button button-danger" title="Delete Selected Chart">Delete</button>

                <div class="form-group">
                    <label for="chart-type-select">Type:</label>
                    <select id="chart-type-select">
                        <option value="line">Line</option>
                        <option value="bar">Bar</option>
                    </select>
                </div>
                <div class="form-group">
                    <input type="checkbox" id="chart-connect-nulls-toggle" name="chart-connect-nulls-toggle">
                    <label for="chart-connect-nulls-toggle" class="checkbox-label">Connect Gaps</label>
                </div>
                <div class="form-group">
                    <input type="checkbox" id="chart-smart-axis-toggle" name="chart-smart-axis-toggle" checked>
                    <label for="chart-smart-axis-toggle" class="checkbox-label" title="Group variables with similar names on the same axis">Smart Axis</label>
                </div>
                <div class="form-group" style="display: flex; flex-direction: column; align-items: flex-start; gap: 0;">
                    <label style="font-size: 0.75em; margin-bottom: 2px;">Start</label>
                    <input type="datetime-local" id="chart-start-date" style="padding: 4px; font-size: 0.85em;">
                </div>
                <div class="form-group" style="display: flex; flex-direction: column; align-items: flex-start; gap: 0;">
                    <label style="font-size: 0.75em; margin-bottom: 2px;">End</label>
                    <input type="datetime-local" id="chart-end-date" style="padding: 4px; font-size: 0.85em;">
                </div>
                <div id="chart-range-buttons" style="display: flex; gap: 5px; flex-wrap: wrap;"></div>
                
                <button id="btn-chart-clear" class="tool-button" style="color:var(--color-danger); border-color:var(--color-danger);" title="Clear All Selections">Clear All</button>
                <button id="btn-chart-export-csv" class="tool-button" title="Export CSV">CSV</button>
                <button id="btn-chart-export-png" class="tool-button" title="Export PNG">PNG</button>
                <button id="btn-chart-fullscreen" class="tool-button" title="Toggle Fullscreen">&#x2922;</button>
                <span id="chart-save-status"></span>
            </div>
        `;
    }

    setupEventListeners() {
        const emit = (name, detail = {}) => {
            this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
        };

        this.querySelector('#chart-config-select').addEventListener('change', (e) => emit('config-selected', { value: e.target.value }));
        this.querySelector('#btn-chart-save-current').addEventListener('click', () => emit('save-current'));
        this.querySelector('#btn-chart-save-as').addEventListener('click', () => emit('save-as'));
        this.querySelector('#btn-chart-delete-config').addEventListener('click', () => emit('delete-config'));
        
        this.querySelector('#chart-type-select').addEventListener('change', (e) => emit('type-changed', { value: e.target.value }));
        this.querySelector('#chart-connect-nulls-toggle').addEventListener('change', (e) => emit('connect-nulls-changed', { checked: e.target.checked }));
        this.querySelector('#chart-smart-axis-toggle').addEventListener('change', (e) => emit('smart-axis-changed', { checked: e.target.checked }));
        
        this.querySelector('#chart-start-date').addEventListener('change', (e) => emit('date-changed', { type: 'start', value: e.target.value }));
        this.querySelector('#chart-end-date').addEventListener('change', (e) => emit('date-changed', { type: 'end', value: e.target.value }));
        
        this.querySelector('#btn-chart-clear').addEventListener('click', () => emit('clear-all'));
        this.querySelector('#btn-chart-export-csv').addEventListener('click', () => emit('export-csv'));
        this.querySelector('#btn-chart-export-png').addEventListener('click', () => emit('export-png'));
        this.querySelector('#btn-chart-fullscreen').addEventListener('click', () => emit('toggle-fullscreen'));
    }

    // API for parent
    getSelectElement() { return this.querySelector('#chart-config-select'); }
    getRangeButtonsContainer() { return this.querySelector('#chart-range-buttons'); }
    getStartDateInput() { return this.querySelector('#chart-start-date'); }
    getEndDateInput() { return this.querySelector('#chart-end-date'); }
    getTypeSelect() { return this.querySelector('#chart-type-select'); }
    getConnectNullsToggle() { return this.querySelector('#chart-connect-nulls-toggle'); }
    getSmartAxisToggle() { return this.querySelector('#chart-smart-axis-toggle'); }
    setSaveStatus(msg) { 
        const status = this.querySelector('#chart-save-status');
        if(status) {
            status.textContent = msg;
            setTimeout(() => { status.textContent = ''; }, 3000);
        }
    }
}

customElements.define('chart-config-bar', ChartConfigBar);
