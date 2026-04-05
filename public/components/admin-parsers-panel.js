/**
 * @license Apache License, Version 2.0 (the "License")
 */

import { showToast } from '../utils.js';

/**
 * Web Component for Data Parsers (CSV) in Admin Panel.
 */
class AdminParsersPanel extends HTMLElement {
    constructor() {
        super();
    }

    connectedCallback() {
        this.render();
    }

    async onStartCsvParser(e) {
        e.preventDefault();
        const input = this.querySelector('#csv-upload-input');
        const defaultTopic = this.querySelector('#csv-default-topic').value;
        const timeDelta = this.querySelector('#csv-time-delta').value;
        const loop = this.querySelector('#csv-loop').checked;
        const status = this.querySelector('#csv-parser-status');
        const btn = this.querySelector('#btn-start-csv-parser');

        const file = input.files[0];
        if (!file) return showToast("Please select a CSV file.", "warning");

        const formData = new FormData();
        formData.append('csv_file', file);
        formData.append('defaultTopic', defaultTopic);
        formData.append('timeDelta', timeDelta);
        formData.append('loop', loop);

        btn.disabled = true;
        btn.textContent = "Starting...";

        try {
            const res = await fetch('api/admin/start-csv-parser', { method: 'POST', body: formData });
            const data = await res.json();
            if (data.success) {
                showToast("CSV Parser started successfully.", "success");
                if (status) {
                    status.textContent = `▶ Running: ${file.name}`;
                    status.style.color = 'var(--color-success)';
                }
            } else {
                throw new Error(data.error || "Failed to start parser");
            }
        } catch (e) {
            showToast("Error: " + e.message, "error");
        } finally {
            btn.disabled = false;
            btn.textContent = "Start CSV Parser";
        }
    }

    render() {
        this.innerHTML = `
            <div style="max-width: 800px; margin: 0 auto;">
                <h2>Data Parsers</h2>
                <p style="color: var(--color-text-secondary); margin-bottom: 20px;">
                    Upload and configure dynamic data providers like CSV files for playback.
                </p>
                <div style="background-color: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: 8px; padding: 20px; margin-bottom: 20px;">
                    <h3 style="margin-top:0;">CSV File Parser</h3>
                    <div style="background-color: var(--color-bg-tertiary); padding: 15px; border-radius: 6px; margin-bottom: 15px; font-size: 0.9em; border: 1px dashed var(--color-border);">
                        <strong>Expected Format:</strong> CSV with a header row.<br><br>
                        - If a column is named <code>topic</code>, it dynamically routes the row to that specific MQTT topic.<br>
                        - If no time column is present, you can simulate a delay (Delta) between each row publication.<br>
                        - All other columns form the JSON payload published to the broker.
                    </div>
                    <form id="csv-parser-form" style="display: flex; flex-direction: column; gap: 15px;">
                        <div class="form-group" style="margin:0;">
                            <label>CSV File</label>
                            <input type="file" id="csv-upload-input" accept=".csv" required style="width: 100%; padding: 8px; border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-bg);">
                        </div>
                        <div class="form-group" style="margin:0;">
                            <label>Default Topic (Fallback if not in CSV)</label>
                            <input type="text" id="csv-default-topic" value="factory/csv/data" required style="width: 100%; padding: 8px; border: 1px solid var(--color-border); border-radius: 4px;">
                        </div>
                        <div class="form-group" style="margin:0;">
                            <label>Time Delta between rows (ms)</label>
                            <input type="number" id="csv-time-delta" value="1000" min="100" required style="width: 100%; padding: 8px; border: 1px solid var(--color-border); border-radius: 4px;">
                        </div>
                        <div class="form-group" style="margin:0; display:flex; align-items:center; gap:10px;">
                            <input type="checkbox" id="csv-loop" checked>
                            <label for="csv-loop" style="margin:0; cursor: pointer;">Loop continuously</label>
                        </div>
                        <button type="submit" id="btn-start-csv-parser" class="mapper-button button-primary" style="align-self: flex-start; padding: 10px 20px;">Start CSV Parser</button>
                        <div id="csv-parser-status" style="font-weight: 500;"></div>
                    </form>
                </div>
            </div>
        `;

        this.querySelector('#csv-parser-form').onsubmit = (e) => this.onStartCsvParser(e);
    }
}

customElements.define('admin-parsers-panel', AdminParsersPanel);
