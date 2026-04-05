/**
 * @license Apache License, Version 2.0 (the "License")
 */

import { confirmModal, showToast } from '../utils.js';

/**
 * Web Component for Alerts History Maintenance in Admin Panel.
 */
class AdminAlertsPanel extends HTMLElement {
    constructor() {
        super();
        this.stats = { count: 0, size: 0 };
    }

    connectedCallback() {
        this.render();
        this.loadResolvedStats();
    }

    async loadResolvedStats() {
        try {
            const res = await fetch('api/alerts/admin/stats');
            const data = await res.json();
            this.stats = data;
            
            const countEl = this.querySelector('#stats-resolved-count');
            const sizeEl = this.querySelector('#stats-resolved-size');
            const btnPurge = this.querySelector('#btn-purge-alerts');

            if (countEl) countEl.textContent = data.count || 0;
            if (sizeEl) sizeEl.textContent = (data.size || 0).toFixed(2);
            if (btnPurge) btnPurge.disabled = (data.count === 0);
        } catch (e) {
            console.error("Resolved Stats Error:", e);
        }
    }

    async onPurgeAlerts() {
        const isConfirmed = await confirmModal('Purge Alerts', 'Are you sure you want to PERMANENTLY delete all resolved alerts history?', 'Purge All', true);
        if (!isConfirmed) return;

        const btnPurge = this.querySelector('#btn-purge-alerts');
        btnPurge.disabled = true;
        btnPurge.textContent = "Purging...";

        try {
            const response = await fetch('api/alerts/admin/purge', { method: 'POST' });
            if (!response.ok) throw new Error("Purge failed.");
            showToast("Resolved alerts history purged successfully!", "success");
            this.loadResolvedStats();
        } catch (e) {
            showToast(`Purge Error: ${e.message}`, "error");
        } finally {
            btnPurge.disabled = false;
            btnPurge.textContent = "Purge All Resolved Alerts";
        }
    }

    render() {
        this.innerHTML = `
            <div style="max-width: 800px; margin: 0 auto;">
                <h2>Alerts History Maintenance</h2>
                <p style="color: var(--color-text-secondary); margin-bottom: 20px;">
                    Manage the archive of triggered alerts.
                </p>
                <div style="background-color: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: 8px; padding: 20px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                        <div>
                            <strong>Resolved Alerts:</strong> <span id="stats-resolved-count" style="font-weight:bold;">--</span> 
                            <span style="color: var(--color-text-secondary); margin-left:5px;">(~<span id="stats-resolved-size">--</span> MB)</span>
                        </div>
                    </div>
                    <button id="btn-purge-alerts" class="danger-button" style="width: 100%; padding: 10px;" disabled>Purge All Resolved Alerts</button>
                    <div id="purge-alerts-status" style="margin-top: 10px; text-align: center;"></div>
                </div>
            </div>
        `;

        this.querySelector('#btn-purge-alerts').onclick = () => this.onPurgeAlerts();
    }
}

customElements.define('admin-alerts-panel', AdminAlertsPanel);
