/**
 * @license Apache License, Version 2.0 (the "License")
 * @author Sebastien Lalaurette
 *
 * Simulation Scenario: HyDroChem-AG Frankfurt - Full Day Production & RCA
 * Location: Frankfurt, Germany
 * Frameworks: ISA-95 (Equipment/Procedural), Brick Schema (BMS/Energy)
 * * Focus: 6 Production Lots. 
 * Lot 1, 2, 4, 5: Nominal (with red herrings like Operator Tweaks or LIMS warnings).
 * Lot 3: The Incident (Severe Grid Sag -> HVAC drops -> Cleanroom pressure drops -> Oven Exhaust drops -> Defect).
 * Lot 6: The Resilient Lot (Multiple brief grid sags -> HVAC handles it -> No pressure drop -> No defect).
 * Note: Simulates physical inertia. Data is published continuously, decaying to IDLE states between batches.
 */

module.exports = (logger, publish, isSparkplugEnabled) => {
    let narrativeInterval = null;
    let sensorInterval = null;
    
    // Timers: Business events every 10s, telemetry every 1s
    const NARRATIVE_INTERVAL_MS = 10000; 
    const SENSOR_INTERVAL_MS = 1000;     
    
    const randomBetween = (min, max, decimals = 2) => parseFloat((Math.random() * (max - min) + min).toFixed(decimals));

    // --- Enterprise & Plant State Machine ---
    let simState = {
        step: 0,
        day_time: new Date().setHours(6, 0, 0, 0), // Starts at 06:00 AM
        
        // Incident Flags: 'none', 'severe', 'brief'
        grid_anomaly: 'none',
        hvac_compensating: false,
        defect_active: false,
        
        erp: {
            active_wo: null,
            schedule: ["WO-PEM-1040", "WO-PEM-1041", "WO-PEM-1042", "WO-PEM-1043", "WO-PEM-1044", "WO-PEM-1045"] 
        },
        
        wms: {
            ink_lot: "LOT-PTIR-A11",
            web_lot: "PTFE-ROLL-882"
        },

        qms: {
            fissure_rate: 0.00,
            thickness_avg: 0.00
        },
        
        brick_bms: {
            main_power: { voltage: 400.0, current: 150.0, active_power_kw: 103.9 },
            chiller_01: { supply_temp_c: 6.0, return_temp_c: 11.2 },
            cleanroom_area: { temp_c: 21.0, humidity_rh: 45.0, pressure_pa: 15.0 },
            ahu_01: { fan_vfd_hz: 48.0 }
        },
        
        isa_line1: {
            status: "IDLE",
            speed_m_min: 0.0,
            produced_m: 0,
            target_m: 2000,
            
            preparation: { agitator_rpm: 0, target_rpm: 0 },
            coating: { 
                pump_hz: 0.0, 
                mass_flow_kg_min: 0.0,
                gap_um: 250
            },
            oven: {
                z1_temp: 100, z2_temp: 100, z3_temp: 100, z4_temp: 100, z5_temp: 100, z6_temp: 100, // Standby temp
                voc_exhaust_hz: 10.0, // Standby exhaust
                total_power_kw: 50.0  // Standby power
            },
            web_handling: { tension_n: 0.0, target_tension: 150 }
        }
    };

    /**
     * Fast Loop: Generates rich, high-frequency telemetry for all SCADA/BMS points.
     */
    function publishSensorData() {
        const now_iso = new Date(simState.day_time).toISOString();
        simState.day_time += 120000; // Advance time by 2 minutes per real-time second for pacing

        const isRunning = simState.isa_line1.status === "RUNNING";

        // ---------------------------------------------------------
        // 1. BRICK SCHEMA: BMS & ENERGY (hydrochem:Frankfurt_Plant)
        // ---------------------------------------------------------
        
        // Power Substation (Grid Sags)
        if (simState.grid_anomaly === 'severe') {
            simState.brick_bms.main_power.voltage = randomBetween(340, 365); // Deep sag
        } else if (simState.grid_anomaly === 'brief') {
            // Simulating multiple rapid flickers
            simState.brick_bms.main_power.voltage = (Math.random() > 0.5) ? randomBetween(375, 385) : 400.0; 
        } else {
            simState.brick_bms.main_power.voltage = 400.0 + randomBetween(-2, 2);
        }
        
        // Power correlates with machine status
        const targetBmsPower = isRunning ? 520 : 150;
        simState.brick_bms.main_power.active_power_kw = (simState.brick_bms.main_power.active_power_kw * 0.8) + (targetBmsPower * 0.2) + randomBetween(-2, 2);

        publish('hydrochem/frankfurt/bms/electrical/main_substation/telemetry', JSON.stringify({
            voltage_v: parseFloat(simState.brick_bms.main_power.voltage.toFixed(1)),
            active_power_kw: parseFloat(simState.brick_bms.main_power.active_power_kw.toFixed(1)),
            emitted_at: now_iso
        }), false);

        // Cleanroom HVAC & Pressure cascade
        if (simState.grid_anomaly === 'severe') {
            simState.brick_bms.ahu_01.fan_vfd_hz = randomBetween(32, 38); // VFD drops hard
            simState.hvac_compensating = true;
        } else if (simState.grid_anomaly === 'brief') {
            simState.brick_bms.ahu_01.fan_vfd_hz = randomBetween(46.5, 47.8); 
        } else if (simState.hvac_compensating && simState.brick_bms.ahu_01.fan_vfd_hz < 48.0) {
            simState.brick_bms.ahu_01.fan_vfd_hz += 0.5; // Recovery
        } else {
            simState.hvac_compensating = false;
            simState.brick_bms.ahu_01.fan_vfd_hz = 48.0 + randomBetween(-0.2, 0.2);
        }

        // Cleanroom pressure drops significantly only if AHU struggles below 45 Hz
        let targetPressure = (simState.brick_bms.ahu_01.fan_vfd_hz / 48.0) * 15.0;
        simState.brick_bms.cleanroom_area.pressure_pa = (simState.brick_bms.cleanroom_area.pressure_pa * 0.7) + (targetPressure * 0.3) + randomBetween(-0.1, 0.1);

        publish('hydrochem/frankfurt/bms/hvac/cleanroom_area/telemetry', JSON.stringify({
            temp_c: 21.0 + randomBetween(-0.1, 0.1),
            humidity_rh: 45.0 + randomBetween(-0.5, 0.5),
            pressure_pa: parseFloat(simState.brick_bms.cleanroom_area.pressure_pa.toFixed(2)),
            ahu_vfd_hz: parseFloat(simState.brick_bms.ahu_01.fan_vfd_hz.toFixed(1)),
            emitted_at: now_iso
        }), false);

        // ---------------------------------------------------------
        // 2. ISA-95: LINE 1 SCADA & OT (Physical Inertia Simulation)
        // ---------------------------------------------------------

        // Increment production only if running
        if (isRunning) {
            simState.isa_line1.produced_m += (simState.isa_line1.speed_m_min / 60) * 120; // 2 mins elapsed per tick
            if (simState.isa_line1.produced_m > simState.isa_line1.target_m) {
                simState.isa_line1.produced_m = simState.isa_line1.target_m;
            }
        }

        // Physical Targets based on status
        const tgt_pump = isRunning ? 42.1 : 0.0;
        const tgt_flow = isRunning ? 15.2 : 0.0;
        const tgt_speed = isRunning ? 12.0 : 0.0;
        const tgt_tension = isRunning ? simState.isa_line1.web_handling.target_tension : 0.0; // Operator target or 0
        const tgt_power = isRunning ? 412.0 : 50.0; // Standby heating vs active heating
        let tgt_exhaust = isRunning ? 45.0 : 10.0; // VFD standby

        // The Root Cause cascade limit
        if (isRunning && simState.brick_bms.cleanroom_area.pressure_pa < 14.5) {
            tgt_exhaust = 30.0; // Exhaust drops to save room pressure
            simState.defect_active = true; // Defect is baked
        } else {
            simState.defect_active = false;
        }

        // Apply physical smoothing (asymptotic decay/ramp-up)
        simState.isa_line1.coating.pump_hz = (simState.isa_line1.coating.pump_hz * 0.8) + (tgt_pump * 0.2);
        simState.isa_line1.coating.mass_flow_kg_min = (simState.isa_line1.coating.mass_flow_kg_min * 0.8) + (tgt_flow * 0.2);
        simState.isa_line1.speed_m_min = (simState.isa_line1.speed_m_min * 0.7) + (tgt_speed * 0.3);
        simState.isa_line1.web_handling.tension_n = (simState.isa_line1.web_handling.tension_n * 0.8) + (tgt_tension * 0.2);
        simState.isa_line1.oven.voc_exhaust_hz = (simState.isa_line1.oven.voc_exhaust_hz * 0.8) + (tgt_exhaust * 0.2);
        simState.isa_line1.oven.total_power_kw = (simState.isa_line1.oven.total_power_kw * 0.9) + (tgt_power * 0.1);

        // Temperatures have high thermal inertia
        const tgt_oven_temp = isRunning ? 180.0 : 120.0; // Cooldown to 120 when idle
        let z3_target = tgt_oven_temp;
        if (isRunning && tgt_exhaust < 40) z3_target = 184.0; // Temp spikes due to poor exhaust

        simState.isa_line1.oven.z1_temp = (simState.isa_line1.oven.z1_temp * 0.95) + (tgt_oven_temp * 0.05);
        simState.isa_line1.oven.z3_temp = (simState.isa_line1.oven.z3_temp * 0.9) + (z3_target * 0.1);

        // Publish Coating
        publish('hydrochem/frankfurt/mes/line_1/coating/telemetry', JSON.stringify({
            pump_hz: parseFloat(simState.isa_line1.coating.pump_hz.toFixed(2)),
            mass_flow_kg_min: parseFloat(simState.isa_line1.coating.mass_flow_kg_min.toFixed(2)),
            gap_um: simState.isa_line1.coating.gap_um,
            emitted_at: now_iso
        }), false);

        // Publish Oven
        publish('hydrochem/frankfurt/mes/line_1/drying_oven/telemetry', JSON.stringify({
            zone1_temp_c: parseFloat(simState.isa_line1.oven.z1_temp.toFixed(1)) + (isRunning ? randomBetween(-0.2, 0.2) : 0),
            zone2_temp_c: parseFloat(simState.isa_line1.oven.z1_temp.toFixed(1)),
            zone3_temp_c: parseFloat(simState.isa_line1.oven.z3_temp.toFixed(1)) + (isRunning ? randomBetween(-0.2, 0.2) : 0),
            zone4_temp_c: parseFloat(simState.isa_line1.oven.z1_temp.toFixed(1)),
            zone5_temp_c: parseFloat(simState.isa_line1.oven.z1_temp.toFixed(1)),
            zone6_temp_c: parseFloat(simState.isa_line1.oven.z1_temp.toFixed(1)),
            voc_exhaust_fan_hz: parseFloat(simState.isa_line1.oven.voc_exhaust_hz.toFixed(1)),
            total_power_kw: parseFloat(simState.isa_line1.oven.total_power_kw.toFixed(1)) + (isRunning ? randomBetween(-2, 2) : 0),
            emitted_at: now_iso
        }), false);

        // Publish Web Handling
        publish('hydrochem/frankfurt/mes/line_1/web_handling/telemetry', JSON.stringify({
            speed_m_min: parseFloat(simState.isa_line1.speed_m_min.toFixed(2)),
            tension_n: parseFloat(simState.isa_line1.web_handling.tension_n.toFixed(1)) + (isRunning ? randomBetween(-1, 1) : 0),
            emitted_at: now_iso
        }), false);

        // Publish QMS (Only meaningful if line is physically moving)
        if (simState.isa_line1.speed_m_min > 2.0) {
            if (simState.defect_active) {
                simState.qms.fissure_rate = randomBetween(15.0, 22.0); // Massive spike in pinholes
                simState.qms.thickness_avg = randomBetween(14.4, 14.6); // Shrinkage
            } else {
                simState.qms.fissure_rate = randomBetween(0.01, 0.08); // Nominal
                simState.qms.thickness_avg = randomBetween(15.0, 15.15);
            }
        } else {
            simState.qms.fissure_rate = 0;
            simState.qms.thickness_avg = 0;
        }

        publish('hydrochem/frankfurt/qms/line_1/laser_scanner/telemetry', JSON.stringify({
            thickness_um: parseFloat(simState.qms.thickness_avg.toFixed(3)),
            fissure_count_per_m2: parseFloat(simState.qms.fissure_rate.toFixed(2)),
            emitted_at: now_iso
        }), false);
    }

    /**
     * Slow Loop: The Narrative/Business Events simulating the 6 batches.
     */
    const scenario = [
        // --- LOT 1: NOMINAL (06:00 - 08:30) ---
        () => {
            logger.info("[HyDroChem-AG] Batch 1: ERP releasing WO-PEM-1040");
            simState.erp.active_wo = "WO-PEM-1040";
            return { topic: 'hydrochem/frankfurt/erp/workorder/WO-PEM-1040/status', payload: { status: "RELEASED", product: "15µm PEM Membrane" } };
        },
        () => {
            logger.info("[HyDroChem-AG] Batch 1: MES Line 1 starts coating.");
            simState.isa_line1.status = "RUNNING"; simState.isa_line1.produced_m = 0;
            return { topic: 'hydrochem/frankfurt/mes/line_1/status', payload: { status: "RUNNING", active_wo: "WO-PEM-1040" } };
        },
        () => {
            logger.info("[HyDroChem-AG] Batch 1: Completed successfully.");
            simState.isa_line1.status = "IDLE";
            return { topic: 'hydrochem/frankfurt/mes/line_1/status', payload: { status: "IDLE", active_wo: null } };
        },
        () => {
            return { topic: 'hydrochem/frankfurt/qms/roll_report', payload: { work_order: "WO-PEM-1040", result: "PASS", avg_thickness: 15.08, defects: 0 } };
        },

        // --- LOT 2: RED HERRING - TENSION TWEAK (09:00 - 11:30) ---
        () => {
            logger.info("[HyDroChem-AG] Batch 2: ERP releasing WO-PEM-1041");
            simState.erp.active_wo = "WO-PEM-1041";
            return { topic: 'hydrochem/frankfurt/erp/workorder/WO-PEM-1041/status', payload: { status: "RELEASED", product: "15µm PEM Membrane" } };
        },
        () => {
            simState.isa_line1.status = "RUNNING"; simState.isa_line1.produced_m = 0;
            return { topic: 'hydrochem/frankfurt/mes/line_1/status', payload: { status: "RUNNING", active_wo: "WO-PEM-1041" } };
        },
        () => {
            logger.info("[HyDroChem-AG] Batch 2: RED HERRING - Operator manually adjusts web tension.");
            simState.isa_line1.web_handling.target_tension = 158; // Manual tweak, higher target tension
            return { topic: 'hydrochem/frankfurt/scada/line_1/audit_trail', payload: { user: "Müller, T.", action: "Set Web Tension", old_val: 150, new_val: 158 } };
        },
        () => {
            logger.info("[HyDroChem-AG] Batch 2: Completed successfully despite tension change.");
            simState.isa_line1.status = "IDLE"; 
            simState.isa_line1.web_handling.target_tension = 150; // Reset logic for next batch
            return { topic: 'hydrochem/frankfurt/mes/line_1/status', payload: { status: "IDLE", active_wo: null } };
        },
        () => {
            return { topic: 'hydrochem/frankfurt/qms/roll_report', payload: { work_order: "WO-PEM-1041", result: "PASS", avg_thickness: 14.95, defects: 2 } };
        },

        // --- LOT 3: THE INCIDENT (12:00 - 14:30) ---
        () => {
            logger.info("[HyDroChem-AG] Batch 3: ERP releasing WO-PEM-1042");
            simState.erp.active_wo = "WO-PEM-1042";
            return { topic: 'hydrochem/frankfurt/erp/workorder/WO-PEM-1042/status', payload: { status: "RELEASED", product: "15µm PEM Membrane" } };
        },
        () => {
            simState.isa_line1.status = "RUNNING"; simState.isa_line1.produced_m = 0;
            return { topic: 'hydrochem/frankfurt/mes/line_1/status', payload: { status: "RUNNING", active_wo: "WO-PEM-1042" } };
        },
        () => {
            logger.warn("[HyDroChem-AG] Batch 3: THE INCIDENT - Severe external grid sag detected.");
            simState.grid_anomaly = 'severe';
            return { topic: 'hydrochem/frankfurt/bms/alarms/substation', payload: { alarm_id: "PWR-ERR-01", message: "Severe Transient Voltage Sag", severity: "CRITICAL" } };
        },
        () => {
            logger.warn("[HyDroChem-AG] Batch 3: CASCADE - AHU struggles, Cleanroom pressure drops, Oven Exhaust drops -> Defect generated.");
            simState.grid_anomaly = 'none'; // Grid recovers, but defect was baked in
            return { topic: 'hydrochem/frankfurt/bms/alarms/cleanroom', payload: { alarm_id: "CR-WARN-88", message: "Cleanroom Delta-P Low", severity: "WARNING" } };
        },
        () => {
            logger.error("[HyDroChem-AG] Batch 3: Completed. QMS flags massive failure.");
            simState.isa_line1.status = "IDLE";
            return { topic: 'hydrochem/frankfurt/mes/line_1/status', payload: { status: "IDLE", active_wo: null } };
        },
        () => {
            return { 
                topic: 'hydrochem/frankfurt/qms/roll_report', 
                payload: { work_order: "WO-PEM-1042", result: "FAIL", avg_thickness: 14.45, defects: 450, reason: "Excessive pinhole density (blistering)." } 
            };
        },
        () => {
            logger.error("[HyDroChem-AG] Batch 3: ERP Quarantines the batch.");
            return { topic: 'hydrochem/frankfurt/erp/workorder/WO-PEM-1042/status', payload: { status: "QUARANTINED", quality_block: true } };
        },

        // --- LOT 4: RED HERRING - INK VISCOSITY (15:00 - 17:30) ---
        () => {
            logger.info("[HyDroChem-AG] Batch 4: Maintenance resets HVAC VFDs. ERP releasing WO-PEM-1043");
            simState.erp.active_wo = "WO-PEM-1043";
            return { topic: 'hydrochem/frankfurt/erp/workorder/WO-PEM-1043/status', payload: { status: "RELEASED", product: "15µm PEM Membrane" } };
        },
        () => {
            logger.info("[HyDroChem-AG] Batch 4: RED HERRING - LIMS warns about new ink lot viscosity.");
            simState.wms.ink_lot = "LOT-PTIR-B02"; // New lot
            return { topic: 'hydrochem/frankfurt/lims/lab_notes/LOT-PTIR-B02', payload: { author: "Schmidt, K.", note: "Viscosity is at upper control limit (450 cP).", severity: "WARNING" } };
        },
        () => {
            simState.isa_line1.status = "RUNNING"; simState.isa_line1.produced_m = 0;
            return { topic: 'hydrochem/frankfurt/mes/line_1/status', payload: { status: "RUNNING", active_wo: "WO-PEM-1043" } };
        },
        () => {
            logger.info("[HyDroChem-AG] Batch 4: Completed successfully despite ink viscosity.");
            simState.isa_line1.status = "IDLE";
            return { topic: 'hydrochem/frankfurt/mes/line_1/status', payload: { status: "IDLE", active_wo: null } };
        },
        () => {
            return { topic: 'hydrochem/frankfurt/qms/roll_report', payload: { work_order: "WO-PEM-1043", result: "PASS", avg_thickness: 15.11, defects: 0 } };
        },

        // --- LOT 5: NOMINAL (18:00 - 20:30) ---
        () => {
            logger.info("[HyDroChem-AG] Batch 5: ERP releasing WO-PEM-1044");
            simState.erp.active_wo = "WO-PEM-1044";
            return { topic: 'hydrochem/frankfurt/erp/workorder/WO-PEM-1044/status', payload: { status: "RELEASED", product: "15µm PEM Membrane" } };
        },
        () => {
            simState.isa_line1.status = "RUNNING"; simState.isa_line1.produced_m = 0;
            return { topic: 'hydrochem/frankfurt/mes/line_1/status', payload: { status: "RUNNING", active_wo: "WO-PEM-1044" } };
        },
        () => {
            logger.info("[HyDroChem-AG] Batch 5: Completed successfully.");
            simState.isa_line1.status = "IDLE";
            return { topic: 'hydrochem/frankfurt/mes/line_1/status', payload: { status: "IDLE", active_wo: null } };
        },
        () => {
            return { topic: 'hydrochem/frankfurt/qms/roll_report', payload: { work_order: "WO-PEM-1044", result: "PASS", avg_thickness: 15.01, defects: 0 } };
        },

        // --- LOT 6: BRIEF ANOMALY, NO IMPACT (21:00 - 23:30) ---
        () => {
            logger.info("[HyDroChem-AG] Batch 6: ERP releasing WO-PEM-1045");
            simState.erp.active_wo = "WO-PEM-1045";
            return { topic: 'hydrochem/frankfurt/erp/workorder/WO-PEM-1045/status', payload: { status: "RELEASED", product: "15µm PEM Membrane" } };
        },
        () => {
            simState.isa_line1.status = "RUNNING"; simState.isa_line1.produced_m = 0;
            return { topic: 'hydrochem/frankfurt/mes/line_1/status', payload: { status: "RUNNING", active_wo: "WO-PEM-1045" } };
        },
        () => {
            logger.warn("[HyDroChem-AG] Batch 6: Multiple BRIEF grid sags detected.");
            simState.grid_anomaly = 'brief';
            return { topic: 'hydrochem/frankfurt/bms/alarms/substation', payload: { alarm_id: "PWR-WARN-02", message: "Minor Voltage Flickers", severity: "LOW" } };
        },
        () => {
            logger.info("[HyDroChem-AG] Batch 6: HVAC absorbed the brief sag. Cleanroom pressure nominal. No defect.");
            simState.grid_anomaly = 'none'; 
            return { topic: 'hydrochem/frankfurt/mes/line_1/heartbeat', payload: { output_meters: simState.isa_line1.produced_m, target: 2000, oee: 98.9 } };
        },
        () => {
            logger.info("[HyDroChem-AG] Batch 6: Completed successfully. End of day.");
            simState.isa_line1.status = "IDLE";
            return { topic: 'hydrochem/frankfurt/mes/line_1/status', payload: { status: "IDLE", active_wo: null } };
        },
        () => {
            return { topic: 'hydrochem/frankfurt/qms/roll_report', payload: { work_order: "WO-PEM-1045", result: "PASS", avg_thickness: 15.09, defects: 1 } };
        }
    ];

    // --- Public API ---
    function start() {
        if (narrativeInterval) return; 

        logger.info(`[HyDroChem-AG] Starting NARRATIVE loop. Publishing every ${NARRATIVE_INTERVAL_MS / 1000}s.`);
        narrativeInterval = setInterval(() => {
            let msg = null;
            do {
                msg = scenario[simState.step]();
                simState.step = (simState.step + 1) % scenario.length;
            } while (msg === null);
            
            if (msg.payload) {
                msg.payload.emitted_at = new Date(simState.day_time).toISOString();
                publish(msg.topic, JSON.stringify(msg.payload), false);
            }
        }, NARRATIVE_INTERVAL_MS);

        if (sensorInterval) clearInterval(sensorInterval);
        logger.info(`[HyDroChem-AG] Starting SENSOR loop. Publishing every ${SENSOR_INTERVAL_MS / 1000}s.`);
        sensorInterval = setInterval(publishSensorData, SENSOR_INTERVAL_MS);
        publishSensorData(); 
    }

    function stop() {
        let stopped = false;
        if (narrativeInterval) {
            logger.info("[HyDroChem-AG] Stopping narrative loop.");
            clearInterval(narrativeInterval);
            narrativeInterval = null;
            stopped = true;
        }
        if (sensorInterval) {
            logger.info("[HyDroChem-AG] Stopping sensor loop.");
            clearInterval(sensorInterval);
            sensorInterval = null;
            stopped = true;
        }
        
        // Reset state for next run
        simState.step = 0;
        simState.grid_anomaly = 'none';
        simState.defect_active = false;
        simState.isa_line1.status = "IDLE";
        simState.day_time = new Date().setHours(6, 0, 0, 0);
        
        logger.info("[HyDroChem-AG] Simulator stopped and reset.");
        return stopped;
    }

    return { start, stop };
};