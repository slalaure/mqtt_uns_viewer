/**
 * @license Apache License, Version 2.0 (the "License")
 */

import { state } from '../state.js';

/**
 * Web Component for displaying and selecting numeric variables from a JSON payload.
 */
class ChartVariableList extends HTMLElement {
    constructor() {
        super();
        this.variables = []; // Array of { path: "motor.speed", value: 1500, type: "number" }
        this.chartedVariables = new Map(); // Inherited from parent to know what's checked
        this.currentTopic = null;
        this.currentSourceId = null;
    }

    connectedCallback() {
        this.render();
    }

    updateData(topic, sourceId, variables, chartedVariablesMap) {
        this.currentTopic = topic;
        this.currentSourceId = sourceId;
        this.variables = variables || [];
        this.chartedVariables = chartedVariablesMap || new Map();
        this.renderList();
    }


    render() {
        this.innerHTML = `
            <div id="variable-list-container" class="chart-variable-list">
                <p class="history-placeholder">Select a topic from the tree to view extractable variables.</p>
            </div>
        `;
    }

    renderList() {
        const container = this.querySelector('#variable-list-container');
        if (!container) return;

        container.innerHTML = '';

        if (this.variables.length === 0) {
            container.innerHTML = '<p class="history-placeholder">No extractable properties found in this payload.</p>';
            return;
        }

        const table = document.createElement('table');
        table.className = 'variable-table';
        const thead = document.createElement('thead');
        thead.innerHTML = '<tr><th>Property</th><th>Type</th><th>Value</th><th>Plot</th></tr>';
        table.appendChild(thead);
        const tbody = document.createElement('tbody');

        this.variables.forEach(variable => {
            const tr = document.createElement('tr');
            
            // Generate a unique ID for this variable + topic combo
            const varId = `${this.currentSourceId}::${this.currentTopic}::${variable.path}`;
            const isChecked = this.chartedVariables.has(varId);
            
            // Format value for display
            let displayVal = variable.value;
            if (typeof displayVal === 'number') {
                displayVal = Number.isInteger(displayVal) ? displayVal : displayVal.toFixed(3);
            } else if (typeof displayVal === 'boolean') {
                displayVal = displayVal ? 'true' : 'false';
            }

            tr.innerHTML = `
                <td title="${variable.path}"><code>${variable.path}</code></td>
                <td><span class="type-badge type-${variable.type}">${variable.type}</span></td>
                <td class="value-cell">${displayVal}</td>
                <td>
                    <input type="checkbox" class="var-checkbox" data-id="${varId}" data-path="${variable.path}" ${isChecked ? 'checked' : ''}>
                </td>
            `;

            // Color picker (only if checked)
            if (isChecked) {
                const info = this.chartedVariables.get(varId);
                const colorInput = document.createElement('input');
                colorInput.type = 'color';
                colorInput.value = info.color || '#3366cc';
                colorInput.className = 'var-color-picker';
                colorInput.title = 'Change line color';
                colorInput.oninput = (e) => {
                    // Update state but don't refresh everything on every move
                    this.chartedVariables.get(varId).color = e.target.value;
                };
                colorInput.onchange = (e) => {
                    // When change is final, notify and refresh
                    this.dispatchEvent(new CustomEvent('color-changed', {
                        detail: { id: varId, color: e.target.value },
                        bubbles: true,
                        composed: true
                    }));
                };
                tr.querySelector('td:last-child').appendChild(colorInput);
            }

            // Checkbox event
            tr.querySelector('.var-checkbox').onchange = (e) => {
                const checked = e.target.checked;
                if (checked) {
                    this.chartedVariables.set(varId, {
                        sourceId: this.currentSourceId,
                        topic: this.currentTopic,
                        path: variable.path,
                        color: '#3366cc' // Default color
                    });
                } else {
                    this.chartedVariables.delete(varId);
                }

                // Notify parent for chart refresh and unsaved state
                this.dispatchEvent(new CustomEvent('variable-toggled', {
                    detail: {
                        id: varId,
                        sourceId: this.currentSourceId,
                        topic: this.currentTopic,
                        path: variable.path,
                        checked: checked
                    },
                    bubbles: true,
                    composed: true
                }));

                // Re-render list immediately to show/hide color picker
                this.renderList();
            };

            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        container.appendChild(table);
    }
}

customElements.define('chart-variable-list', ChartVariableList);
