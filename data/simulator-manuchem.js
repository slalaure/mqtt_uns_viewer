/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2026 Sebastien Lalaurette
 *
 * Simulation Scenario: ManuCHEM 2026 - Enhanced RCA (Red Herrings & Cascading Faults)
 * Location: Frankfurt, Germany
 * Focus: AI Root Cause Analysis filtering out false leads across WMS/LIMS to find IT/OT correlation.
 */

module.exports = (logger, publish, isSparkplugEnabled) => {
    let narrativeInterval = null;
    let sensorInterval = null;
    
    // Timers: Business events every 15s, telemetry every 2s
    const NARRATIVE_INTERVAL_MS = 15000; 
    const SENSOR_INTERVAL_MS = 2000;     
    
    const randomBetween = (min, max, decimals = 2) => parseFloat((Math.random() * (max - min) + min).toFixed(decimals));

    // --- State Machine ---
    let simState = {
        step: 0,
        grid_status: 'nominal', // 'nominal' | 'sag'
        
        erp: {
            workOrder: { id: "WO-PEM-2026", product: "Hydrogen PEM - Type A", status: "PLANNED", batch_quality: "PENDING" }
        },
        
        wms: {
            ink_lot: { lot_id: "PTIR-992", status: "ALLOCATED", lines_using: ["Line_1", "Line_2"] }
        },

        lims: {
            latest_note: null
        },

        qms: {
            inspection_status: "IDLE",
            micro_fissure_rate: 0.02, 
            catalyst_loading_uniformity: 99.5
        },
        
        infrastructure: {
            main_power: { voltage: 400.0, status: "ONLINE" }
        },
        
        utilities: {
            chiller_plant: { supply_temp_c: 6.0, status: "NOMINAL" }
        },

        bms: {
            cleanroom_A: { pressure_pa: 15.0, hvac_vfd_speed: 100.0, status: "NOMINAL" } 
        },
        
        mes: {
            coating_line_2: { status: "IDLE", active_wo: null }
        },
        
        ot: {
            drying_oven: { temp_c: 120.0, fan_vfd_speed: 100.0, web_speed_m_min: 5.0, status: "IDLE" },
            scada_alarms: []
        }
    };

    /**
     * Fast Loop: Publishes high-frequency telemetry for all OT/Infrastructure sensors.
     */
    function publishSensorData() {
        const now_iso = new Date().toISOString();

        // 1. Infrastructure: Main Power (Grid Sag logic)
        let targetVoltage = simState.grid_status === 'sag' ? 328.0 : 400.0; // 82% sag
        simState.infrastructure.main_power.voltage = targetVoltage + randomBetween(-1.5, 1.5);
        
        publish('frankfurt/ot/infrastructure/main_power/telemetry', JSON.stringify({
            voltage_v: parseFloat(simState.infrastructure.main_power.voltage.toFixed(2)),
            frequency_hz: simState.grid_status === 'sag' ? 49.8 : 50.0 + randomBetween(-0.02, 0.02),
            status: simState.infrastructure.main_power.status,
            emitted_at: now_iso
        }), false);

        // 2. Utilities: Chiller Plant (Secondary cascade failure)
        if (simState.grid_status === 'sag') {
            simState.utilities.chiller_plant.supply_temp_c = 8.5; // Spike due to compressor desync
            simState.utilities.chiller_plant.status = "COMPRESSOR_RESTART";
        } else if (simState.utilities.chiller_plant.supply_temp_c > 6.0) {
            simState.utilities.chiller_plant.supply_temp_c -= 0.5; // Slow recovery
            if (simState.utilities.chiller_plant.supply_temp_c <= 6.0) {
                simState.utilities.chiller_plant.supply_temp_c = 6.0;
                simState.utilities.chiller_plant.status = "NOMINAL";
            }
        }

        publish('frankfurt/ot/utilities/chiller_plant/telemetry', JSON.stringify({
            supply_temp_c: parseFloat(simState.utilities.chiller_plant.supply_temp_c.toFixed(2)),
            status: simState.utilities.chiller_plant.status,
            emitted_at: now_iso
        }), false);

        // 3. BMS: Cleanroom A (HVAC trip cascade)
        if (simState.grid_status === 'sag') {
            simState.bms.cleanroom_A.hvac_vfd_speed = 0.0; 
            simState.bms.cleanroom_A.status = "VFD_TRIP";
        } else if (simState.bms.cleanroom_A.hvac_vfd_speed < 100.0 && simState.mes.coating_line_2.status !== "IDLE") {
            simState.bms.cleanroom_A.hvac_vfd_speed += 15.0; 
            if (simState.bms.cleanroom_A.hvac_vfd_speed >= 100.0) {
                simState.bms.cleanroom_A.hvac_vfd_speed = 100.0;
                simState.bms.cleanroom_A.status = "NOMINAL";
            }
        }
        
        let targetPressure = (simState.bms.cleanroom_A.hvac_vfd_speed / 100.0) * 15.0;
        simState.bms.cleanroom_A.pressure_pa = (simState.bms.cleanroom_A.pressure_pa * 0.7) + (targetPressure * 0.3) + randomBetween(-0.2, 0.2);

        publish('frankfurt/ot/bms/cleanroom_A/telemetry', JSON.stringify({
            pressure_pa: parseFloat(simState.bms.cleanroom_A.pressure_pa.toFixed(2)),
            hvac_vfd_speed_pct: parseFloat(simState.bms.cleanroom_A.hvac_vfd_speed.toFixed(1)),
            status: simState.bms.cleanroom_A.status,
            emitted_at: now_iso
        }), false);

        // 4. OT: Drying Oven on Coating Line 2 (The primary cause of the defect)
        if (simState.grid_status === 'sag') {
            simState.ot.drying_oven.fan_vfd_speed = 60.0; 
            simState.ot.drying_oven.status = "UNDER_VOLTAGE_WARN";
        } else if (simState.ot.drying_oven.fan_vfd_speed < 100.0 && simState.mes.coating_line_2.status === "RUNNING") {
            simState.ot.drying_oven.fan_vfd_speed += 10.0; 
            if (simState.ot.drying_oven.fan_vfd_speed >= 100.0) {
                simState.ot.drying_oven.fan_vfd_speed = 100.0;
                simState.ot.drying_oven.status = "RUNNING";
            }
        }

        let targetTemp = simState.mes.coating_line_2.status === "RUNNING" ? 120.0 : 25.0;
        if (simState.ot.drying_oven.fan_vfd_speed < 100) {
            targetTemp -= 4.0; // Rapid cooling due to lack of airflow
        }
        simState.ot.drying_oven.temp_c = (simState.ot.drying_oven.temp_c * 0.8) + (targetTemp * 0.2) + randomBetween(-0.5, 0.5);

        publish('frankfurt/ot/line_2/drying_oven/telemetry', JSON.stringify({
            temp_c: parseFloat(simState.ot.drying_oven.temp_c.toFixed(2)),
            fan_vfd_speed_pct: parseFloat(simState.ot.drying_oven.fan_vfd_speed.toFixed(1)),
            web_speed_m_min: simState.ot.drying_oven.web_speed_m_min,
            status: simState.ot.drying_oven.status,
            emitted_at: now_iso
        }), false);
    }

    /**
     * Slow Loop: The Narrative. 
     */
    const scenario = [
        // 1. WMS Allocates Ink Lot to lines
        () => {
            logger.info("[ManuCHEM] WMS allocating Ink Lot PTIR-992");
            return { 
                topic: 'frankfurt/wms/inventory/allocation', 
                payload: simState.wms.ink_lot 
            };
        },
        // 2. ERP Releases Work Order
        () => {
            logger.info("[ManuCHEM] ERP releasing Work Order WO-PEM-2026");
            simState.erp.workOrder.status = "RELEASED";
            return { 
                topic: 'frankfurt/erp/workorder/WO-PEM-2026/status', 
                payload: simState.erp.workOrder 
            };
        },
        // 3. MES starts Production on Line 2
        () => {
            logger.info("[ManuCHEM] MES starting Coating Line 2");
            simState.mes.coating_line_2.status = "RUNNING";
            simState.mes.coating_line_2.active_wo = "WO-PEM-2026";
            
            simState.bms.cleanroom_A.hvac_vfd_speed = 100.0;
            simState.ot.drying_oven.fan_vfd_speed = 100.0;
            simState.ot.drying_oven.status = "RUNNING";
            simState.ot.drying_oven.temp_c = 120.0;
            simState.ot.drying_oven.web_speed_m_min = 5.0;
            
            return { 
                topic: 'frankfurt/mes/operations/line_2/status', 
                payload: simState.mes.coating_line_2 
            };
        },
        // 4. THE INCIDENT: Micro Grid Sag (150ms)
        () => {
            logger.warn("[ManuCHEM] INJECTING GRID ANOMALY: Voltage Sag");
            simState.grid_status = 'sag';
            return { 
                topic: 'frankfurt/external/hessen_grid/alerts', 
                payload: { event: "VOLTAGE_SAG", duration_ms: 150, severity: "WARNING", region: "Frankfurt Industriepark" } 
            };
        },
        // 5. SCADA Alarm Triggered & Acknowledged by Operator
        () => {
            logger.warn("[ManuCHEM] Operator acknowledges SCADA warning but ignores it.");
            simState.grid_status = 'nominal'; // Grid recovered instantly
            return {
                topic: 'frankfurt/ot/scada/alarms/line_2',
                payload: {
                    alarm_id: "ALM-8492",
                    message: "Transient Airflow Warning - Oven Zone 1",
                    severity: "LOW",
                    status: "ACKNOWLEDGED",
                    operator: "Müller, T.",
                    action_taken: "Dismissed - Suspected Sensor Glitch"
                }
            };
        },
        // 6. Production continues, unaware of the latent defect
        () => {
            logger.info("[ManuCHEM] Line 2 running... (Latent defect created on web)");
            return { 
                topic: 'frankfurt/mes/operations/line_2/heartbeat', 
                payload: { status: "RUNNING", output_meters: 400, target: 500 } 
            };
        },
        // 7. LIMS Note Added (The Red Herring)
        () => {
            logger.info("[ManuCHEM] Quality Manager adds LIMS note regarding ink lot.");
            simState.lims.latest_note = "Suspect dispersion issue with new Platinum-Iridium catalyst ink batch (Lot #PTIR-992) introduced this morning.";
            return {
                topic: 'frankfurt/lims/lab_notes/WO-PEM-2026',
                payload: { author: "Schmidt, K.", role: "Shift Quality Manager", note: simState.lims.latest_note }
            };
        },
        // 8. MES finishes Production
        () => {
            logger.info("[ManuCHEM] MES completing Work Order");
            simState.mes.coating_line_2.status = "IDLE";
            simState.mes.coating_line_2.active_wo = null;
            simState.ot.drying_oven.status = "IDLE";
            simState.ot.drying_oven.web_speed_m_min = 0.0;
            return { 
                topic: 'frankfurt/mes/operations/line_2/status', 
                payload: simState.mes.coating_line_2 
            };
        },
        // 9. QMS AOI Inspection (Fails)
        () => {
            logger.error("[ManuCHEM] QMS AOI Inspection FAILED due to micro-fissures.");
            simState.qms.inspection_status = "COMPLETED";
            simState.qms.micro_fissure_rate = 15.4; // Spiked
            simState.qms.catalyst_loading_uniformity = 88.2; 
            return { 
                topic: 'frankfurt/qms/aoi_inspection/result', 
                payload: { 
                    work_order: "WO-PEM-2026", 
                    result: "FAIL", 
                    fissure_rate_pct: simState.qms.micro_fissure_rate,
                    uniformity_pct: simState.qms.catalyst_loading_uniformity,
                    reason: "Excessive micro-fissures detected in middle section."
                } 
            };
        },
        // 10. ERP Quarantines the Batch
        () => {
            logger.error("[ManuCHEM] ERP Quarantining Batch WO-PEM-2026");
            simState.erp.workOrder.status = "QUARANTINED";
            simState.erp.workOrder.batch_quality = "REJECTED";
            return { 
                topic: 'frankfurt/erp/workorder/WO-PEM-2026/status', 
                payload: simState.erp.workOrder 
            };
        }
    ];

    // --- Public API ---
    function start() {
        if (narrativeInterval) return; 

        logger.info(`[ManuCHEM] Starting NARRATIVE loop. Publishing every ${NARRATIVE_INTERVAL_MS / 1000}s.`);
        narrativeInterval = setInterval(() => {
            let msg = null;
            do {
                msg = scenario[simState.step]();
                simState.step = (simState.step + 1) % scenario.length;
            } while (msg === null);
            
            msg.payload.emitted_at = new Date().toISOString();
            publish(msg.topic, JSON.stringify(msg.payload), false);
        }, NARRATIVE_INTERVAL_MS);

        if (sensorInterval) clearInterval(sensorInterval);
        logger.info(`[ManuCHEM] Starting SENSOR loop. Publishing every ${SENSOR_INTERVAL_MS / 1000}s.`);
        sensorInterval = setInterval(publishSensorData, SENSOR_INTERVAL_MS);
        publishSensorData(); 
    }

    function stop() {
        let stopped = false;
        if (narrativeInterval) {
            logger.info("[ManuCHEM] Stopping narrative loop.");
            clearInterval(narrativeInterval);
            narrativeInterval = null;
            stopped = true;
        }
        if (sensorInterval) {
            logger.info("[ManuCHEM] Stopping sensor loop.");
            clearInterval(sensorInterval);
            sensorInterval = null;
            stopped = true;
        }
        
        // Reset state for next run
        simState.step = 0;
        simState.grid_status = 'nominal';
        simState.erp.workOrder.status = "PLANNED";
        simState.qms.inspection_status = "IDLE";
        simState.mes.coating_line_2.status = "IDLE";
        
        logger.info("[ManuCHEM] Simulator stopped and reset.");
        return stopped;
    }

    return { start, stop };
};