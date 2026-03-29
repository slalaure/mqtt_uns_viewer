/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * Custom JS Bindings for the HyDroChem-AG 2026 Operations Dashboard.
 */

window.registerSvgBindings({
    initialize: (svgRoot) => {
        console.log("[HyDroChem-AG] Dashboard Initialized.");
        // Utilisation de querySelector, beaucoup plus fiable sur les SVG injectés
        const alertBox = svgRoot.querySelector('#g_alert_box');
        if (alertBox) alertBox.style.display = 'none';
    },

    update: (brokerId, topic, payload, svgRoot) => {
        // Safe Parse Payload
        const data = (typeof payload === 'string') ? JSON.parse(payload) : payload;
        const vars = data.variables || data;

        // Helper sécurisé pour mettre à jour le texte
        const updateText = (id, val) => {
            const el = svgRoot.querySelector('#' + id);
            if (el) el.textContent = val;
        };

        // --- 1. OT: Drying Oven ---
        // Filtrage large pour supporter 'line_2' ou 'line2'
        if (topic.includes('drying_oven')) {
            
            // Protection contre les variables manquantes (si le payload est splitté)
            if (vars.temp_c !== undefined) {
                updateText('val_oven_temp', `${parseFloat(vars.temp_c).toFixed(1)}°C`);
                
                const tempStatus = svgRoot.querySelector('#val_oven_status');
                const tempBox = svgRoot.querySelector('.callout-box');
                const tempLine = svgRoot.querySelector('.callout-line');
                
                if (vars.temp_c < 118.0 && vars.temp_c > 30) {
                    if(tempStatus) { tempStatus.textContent = 'Status: Warning (Temp Drop)'; tempStatus.setAttribute('fill', '#f85149'); }
                    if(tempBox) { tempBox.setAttribute('stroke', '#f85149'); tempBox.setAttribute('fill', 'rgba(248,81,73,0.1)'); }
                    if(tempLine) tempLine.setAttribute('stroke', '#f85149');
                } else if (vars.temp_c >= 118.0) {
                    if(tempStatus) { tempStatus.textContent = 'Status: NOMINAL'; tempStatus.setAttribute('fill', '#8a6d3b'); }
                    if(tempBox) { tempBox.setAttribute('stroke', '#8a6d3b'); tempBox.setAttribute('fill', '#21262d'); }
                    if(tempLine) tempLine.setAttribute('stroke', '#8a6d3b');
                }
            }

            if (vars.fan_vfd_speed_pct !== undefined) {
                updateText('val_fan_speed', `${parseFloat(vars.fan_vfd_speed_pct).toFixed(0)}%`);
                const fan = svgRoot.querySelector('#anim_fan');
                if (fan) {
                    if (vars.fan_vfd_speed_pct > 0) {
                        const duration = 100 / vars.fan_vfd_speed_pct;
                        fan.style.animation = `spin ${duration}s linear infinite`;
                    } else {
                        fan.style.animation = 'none';
                    }
                }
            }

            if (vars.web_speed_m_min !== undefined) {
                const rolls = svgRoot.querySelectorAll('.anim_roll');
                rolls.forEach(roll => {
                    if (vars.web_speed_m_min > 0) {
                        roll.style.animation = `spin ${10 / vars.web_speed_m_min}s linear infinite`;
                    } else {
                        roll.style.animation = 'none';
                    }
                });
            }
        }

        // --- 2. IT: SCADA Alarms ---
        if (topic.includes('scada') || topic.includes('alarm') || topic.includes('alert')) {
            const alertBox = svgRoot.querySelector('#g_alert_box');
            if (alertBox && vars.message) {
                alertBox.style.display = 'block';
                updateText('val_alert_msg', `ALERT: ${vars.message}`);
            } else if (alertBox && vars.alarm === "NONE") {
                alertBox.style.display = 'none';
            }
        }

        // --- 3. IT: MES / ERP Status ---
        if (topic.includes('mes') || topic.includes('erp') || topic.includes('production_orders')) {
            const woId = vars.active_wo || vars.id || vars.workOrderId;
            if (woId) updateText('val_wo_id', woId);
            
            if (vars.status) {
                const woStatus = svgRoot.querySelector('#val_wo_status');
                if (woStatus) {
                    woStatus.textContent = `Status: ${vars.status}`;
                    woStatus.setAttribute('fill', vars.status === 'RUNNING' ? '#3fb950' : '#8b949e');
                }
            }
        }

        // --- 4. IT: QMS Inspection Result ---
        if (topic.includes('qms')) {
            if (vars.fissure_rate_pct !== undefined) {
                updateText('val_qms_fissure', `${parseFloat(vars.fissure_rate_pct).toFixed(2)}%`);
            }
            if (vars.result) {
                const qmsStatus = svgRoot.querySelector('#val_qms_status');
                if (qmsStatus) {
                    if (vars.result === 'FAIL') {
                        qmsStatus.textContent = 'REJECTED';
                        qmsStatus.setAttribute('fill', '#f85149');
                    } else {
                        qmsStatus.textContent = 'NOMINAL';
                        qmsStatus.setAttribute('fill', '#3fb950');
                    }
                }
            }
        }

        // --- 5. Infrastructure: Main Power ---
        if (topic.includes('infrastructure') || topic.includes('power')) {
            const volts = vars.voltage_v !== undefined ? vars.voltage_v : vars.voltage;
            if (volts !== undefined) {
                updateText('val_power_volts', `${parseFloat(volts).toFixed(0)} V`);
                const pwrStatus = svgRoot.querySelector('#val_power_status');
                if (pwrStatus) {
                    if (volts < 350) {
                        pwrStatus.textContent = 'Status: SAG DETECTED';
                        pwrStatus.setAttribute('fill', '#f85149');
                    } else if (volts < 390) {
                        pwrStatus.textContent = 'Status: Recovering';
                        pwrStatus.setAttribute('fill', '#d29922');
                    } else {
                        pwrStatus.textContent = 'Status: NOMINAL';
                        pwrStatus.setAttribute('fill', '#3fb950');
                    }
                }
            }
        }

        // --- 6. Utilities / Chiller ---
        if (topic.includes('utilities') || topic.includes('chiller')) {
            if (vars.supply_temp_c !== undefined) {
                updateText('val_chiller_temp', `${parseFloat(vars.supply_temp_c).toFixed(1)} °C`);
                const chillerStatus = svgRoot.querySelector('#val_chiller_status');
                if (chillerStatus) {
                    if (vars.supply_temp_c > 7.5) {
                        chillerStatus.textContent = `Status: WARNING`;
                        chillerStatus.setAttribute('fill', '#f85149');
                    } else {
                        chillerStatus.textContent = 'Status: NOMINAL';
                        chillerStatus.setAttribute('fill', '#3fb950');
                    }
                }
            }
        }

        // --- 7. BMS: Cleanroom ---
        if (topic.includes('bms') || topic.includes('cleanroom')) {
            if (vars.pressure_pa !== undefined) {
                updateText('val_cleanroom_pressure', `${parseFloat(vars.pressure_pa).toFixed(1)} Pa`);
                const pressStatus = svgRoot.querySelector('#val_cleanroom_status');
                if (pressStatus) {
                    if (vars.pressure_pa < 10) {
                        pressStatus.textContent = `Status: WARNING`;
                        pressStatus.setAttribute('fill', '#f85149');
                    } else {
                        pressStatus.textContent = 'Status: NOMINAL';
                        pressStatus.setAttribute('fill', '#3fb950');
                    }
                }
            }
        }
    },

    reset: (svgRoot) => {
        const alertBox = svgRoot.querySelector('#g_alert_box');
        if (alertBox) alertBox.style.display = 'none';
    }
});