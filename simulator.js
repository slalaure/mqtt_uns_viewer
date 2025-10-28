/**
 * @license MIT
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KINDD, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const spBv10Codec = require('sparkplug-payload').get("spBv1.0");

module.exports = (logger, publish, isSparkplugEnabled) => {
    
    let narrativeInterval = null;
    let sensorInterval = null;
    const NARRATIVE_INTERVAL_MS = 40000; // Slow loop for "business" events (MES, ERP...)
    const SENSOR_INTERVAL_MS = 5000;    // Fast loop for all IoT sensors (as requested)
    
    const randomBetween = (min, max, decimals = 2) => parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
    
    let simState = { 
        step: 0, 
        workOrders: { palladiumCore: null, vibraniumCasing: null, repulsorLift: null }, 
        operators: ["Pepper Potts", "Happy Hogan", "James Rhodes", "J.A.R.V.I.S.", "Peter Parker", "Tony Stark"],
        
        // spSeq is for DDATA (0-255), bdSeq is for NBIRTH (0-255)
        equipmentStatus: {
            // Production Machines
            robot_arm_01:     { status: 'idle', temp: 40.0, speed: 0, spSeq: 0, bdSeq: 0 },
            laser_welder_01:  { status: 'idle', temp: 30.0, spSeq: 0, bdSeq: 0 },
            cnc_mill_05:      { status: 'idle', vibration: 0.1, load: 0, spSeq: 0, bdSeq: 0 },
            power_modulator_01:{ status: 'idle', output: 0.0, stability: 1.0, spSeq: 0, bdSeq: 0 },
            
            // Infrastructure (Power Meters and Gas)
            power_meter_01:   { status: 'online', voltage: 230.0, current: 10.0, power: 2.3, pf: 0.95, spSeq: 0, bdSeq: 0 },
            gas_tank_argon:   { status: 'online', level: 85.0, pressure: 150, spSeq: 0, bdSeq: 0 },
            gas_tank_nitrogen:{ status: 'online', level: 90.0, pressure: 160, spSeq: 0, bdSeq: 0 }, // 'leaking' status will be injected
            gas_tank_oxygen:  { status: 'online', level: 75.0, pressure: 130, spSeq: 0, bdSeq: 0 },

            // Building Systems (JSON UNS only)
            clean_room_01:    { humidity: 26.5 },
            bms:              { power: 80.0 }
        }
    };

    /**
     * Publishes NBIRTH messages for ALL Sparkplug B devices.
     */
    function publishBirthMessages() {
        if (!isSparkplugEnabled) return;

        logger.info("✅ Publishing Sparkplug NBIRTH messages for all devices...");
        const now_ts = Date.now();
        const sessionSeqNum = 0; // NBIRTH 'seq' MUST be 0

        // --- 1. Robot Arm NBIRTH ---
        let stateRobot = simState.equipmentStatus.robot_arm_01;
        stateRobot.bdSeq = (stateRobot.bdSeq + 1) % 256;
        let robotMetrics = [
            { name: "Motor/Speed", value: stateRobot.speed, type: "Int32" },
            { name: "Motor/Temp", value: stateRobot.temp, type: "Float" },
            { name: "Status", value: stateRobot.status, type: "String" }
        ];
        let payloadRobot = spBv10Codec.encodePayload({ timestamp: now_ts, metrics: robotMetrics, seq: sessionSeqNum, bdSeq: stateRobot.bdSeq });
        publish('spBv1.0/stark_industries/NBIRTH/robot_arm_01', payloadRobot, true);

        // --- 2. Laser Welder NBIRTH ---
        let stateLaser = simState.equipmentStatus.laser_welder_01;
        stateLaser.bdSeq = (stateLaser.bdSeq + 1) % 256;
        let laserMetrics = [
            { name: "Temperature", value: stateLaser.temp, type: "Float" },
            { name: "Status", value: stateLaser.status, type: "String" }
        ];
        let payloadLaser = spBv10Codec.encodePayload({ timestamp: now_ts, metrics: laserMetrics, seq: sessionSeqNum, bdSeq: stateLaser.bdSeq });
        publish('spBv1.0/stark_industries/NBIRTH/laser_welder_01', payloadLaser, true);

        // --- 3. CNC Mill NBIRTH ---
        let stateCNC = simState.equipmentStatus.cnc_mill_05;
        stateCNC.bdSeq = (stateCNC.bdSeq + 1) % 256;
        let cncMetrics = [
            { name: "Vibration", value: stateCNC.vibration, type: "Float" },
            { name: "Load", value: stateCNC.load, type: "Float" },
            { name: "Status", value: stateCNC.status, type: "String" }
        ];
        let payloadCNC = spBv10Codec.encodePayload({ timestamp: now_ts, metrics: cncMetrics, seq: sessionSeqNum, bdSeq: stateCNC.bdSeq });
        publish('spBv1.0/stark_industries/NBIRTH/cnc_mill_05', payloadCNC, true);

        // --- 4. Power Modulator NBIRTH ---
        let statePowerMod = simState.equipmentStatus.power_modulator_01;
        statePowerMod.bdSeq = (statePowerMod.bdSeq + 1) % 256;
        let powerModMetrics = [
            { name: "Output", value: statePowerMod.output, type: "Double" },
            { name: "Stability", value: statePowerMod.stability, type: "Float" },
            { name: "Status", value: statePowerMod.status, type: "String" }
        ];
        let payloadPowerMod = spBv10Codec.encodePayload({ timestamp: now_ts, metrics: powerModMetrics, seq: sessionSeqNum, bdSeq: statePowerMod.bdSeq });
        publish('spBv1.0/stark_industries/NBIRTH/power_modulator_01', payloadPowerMod, true);
        
        // --- 5. Power Meter 01 NBIRTH ---
        let statePowerMeter = simState.equipmentStatus.power_meter_01;
        statePowerMeter.bdSeq = (statePowerMeter.bdSeq + 1) % 256;
        let powerMeterMetrics = [
            { name: "Voltage", value: statePowerMeter.voltage, type: "Float" },
            { name: "Current", value: statePowerMeter.current, type: "Float" },
            { name: "ActivePower", value: statePowerMeter.power, type: "Float" },
            { name: "PowerFactor", value: statePowerMeter.pf, type: "Float" },
            { name: "Status", value: statePowerMeter.status, type: "String" }
        ];
        let payloadPowerMeter = spBv10Codec.encodePayload({ timestamp: now_ts, metrics: powerMeterMetrics, seq: sessionSeqNum, bdSeq: statePowerMeter.bdSeq });
        publish('spBv1.0/stark_industries/NBIRTH/power_meter_01', payloadPowerMeter, true);

        // --- 6. Gas Tanks NBIRTH ---
        ['gas_tank_argon', 'gas_tank_nitrogen', 'gas_tank_oxygen'].forEach(tankId => {
            let stateGas = simState.equipmentStatus[tankId];
            stateGas.bdSeq = (stateGas.bdSeq + 1) % 256;
            let gasMetrics = [
                { name: "Level", value: stateGas.level, type: "Float" },
                { name: "Pressure", value: stateGas.pressure, type: "Float" },
                { name: "Status", value: stateGas.status, type: "String" }
            ];
            let payloadGas = spBv10Codec.encodePayload({ timestamp: now_ts, metrics: gasMetrics, seq: sessionSeqNum, bdSeq: stateGas.bdSeq });
            publish(`spBv1.0/stark_industries/NBIRTH/${tankId}`, payloadGas, true);
        });
        
        logger.info("✅    -> NBIRTH messages published (seq=0).");
    }

    /**
     * Publishes DDATA and JSON for all sensors, including new ones.
     */
    function publishSensorData() {
        const { equipmentStatus } = simState;
        const now_iso = new Date().toISOString();
        const now_ts = Date.now();

        // --- 1. Publish BMS Power (UNS JSON Only) ---
        const runningMachines = ['robot_arm_01', 'laser_welder_01', 'cnc_mill_05', 'power_modulator_01']
            .filter(m => equipmentStatus[m].status === 'running').length;
        let totalPowerkW = (runningMachines * 8000) + randomBetween(1000, 1500); // in kW
        let targetPowerMW = (totalPowerkW / 1000) + randomBetween(0.5, 1.0); // in MW
        equipmentStatus.bms.power = (equipmentStatus.bms.power * 0.8) + (targetPowerMW * 0.2);
        publish('stark_industries/malibu_facility/bms/main_power_feed', JSON.stringify({
            value: parseFloat(equipmentStatus.bms.power.toFixed(2)), unit: "MW", source: "Arc Reactor Mk V", emitted_at: now_iso
        }), false);

        // --- 2. Publish Clean Room (UNS JSON Only) ---
        let targetHumidity = 26.5 + randomBetween(-0.5, 0.5);
        equipmentStatus.clean_room_01.humidity = (equipmentStatus.clean_room_01.humidity * 0.9) + (targetHumidity * 0.1);
        publish('stark_industries/malibu_facility/assembly_line_01/clean_room_01/humidity', JSON.stringify({
            value: parseFloat(equipmentStatus.clean_room_01.humidity.toFixed(1)), unit: "%RH", emitted_at: now_iso
        }), false);


        // --- 3. Publish Robot Arm (SPARKPLUG B + JSON UNS) ---
        if (isSparkplugEnabled) {
            let stateRobot = equipmentStatus.robot_arm_01;
            let targetTemp, targetSpeed;
            if (stateRobot.status === 'running') {
                targetTemp = 75 + randomBetween(-2, 2);
                targetSpeed = 1600 + randomBetween(-50, 50);
            } else { targetTemp = 45 + randomBetween(-1, 1); targetSpeed = 0; }
            stateRobot.temp = (stateRobot.temp * 0.8) + (targetTemp * 0.2);
            stateRobot.speed = (stateRobot.speed * 0.7) + (targetSpeed * 0.3);
            stateRobot.spSeq = (stateRobot.spSeq + 1) % 256; 
            const metrics = [
                { name: "Motor/Speed", value: Math.floor(stateRobot.speed), type: "Int32" },
                { name: "Motor/Temp", value: parseFloat(stateRobot.temp.toFixed(1)), type: "Float" },
                { name: "Status", value: stateRobot.status, type: "String" }
            ];
            const payloadObject = { timestamp: now_ts, metrics: metrics, seq: stateRobot.spSeq };
            const payloadBuffer = spBv10Codec.encodePayload(payloadObject);
            publish('spBv1.0/stark_industries/DDATA/robot_arm_01', payloadBuffer, true);
            
            publish('stark_industries/malibu_facility/assembly_line_01/palladium_core_cell/robotic_arm_01/speed', JSON.stringify({ value: Math.floor(stateRobot.speed), unit: "rpm", emitted_at: now_iso }), false);
            publish('stark_industries/malibu_facility/assembly_line_01/palladium_core_cell/robotic_arm_01/temperature', JSON.stringify({ value: parseFloat(stateRobot.temp.toFixed(1)), unit: "°C", emitted_at: now_iso }), false);
        }

        // --- 4. Publish Laser Welder (SPARKPLUG B + JSON UNS) ---
        if (isSparkplugEnabled) {
            let stateLaser = equipmentStatus.laser_welder_01;
            let targetLaserTemp = (stateLaser.status === 'running') ? (1350 + randomBetween(-15, 15)) : (40 + randomBetween(-1, 1));
            stateLaser.temp = (stateLaser.temp * 0.8) + (targetLaserTemp * 0.2);
            stateLaser.spSeq = (stateLaser.spSeq + 1) % 256;
            const metrics = [
                { name: "Temperature", value: Math.floor(stateLaser.temp), type: "Float" },
                { name: "Status", value: stateLaser.status, type: "String" }
            ];
            const payloadObject = { timestamp: now_ts, metrics: metrics, seq: stateLaser.spSeq };
            const payloadBuffer = spBv10Codec.encodePayload(payloadObject);
            publish('spBv1.0/stark_industries/DDATA/laser_welder_01', payloadBuffer, true);
            
            publish('stark_industries/malibu_facility/assembly_line_01/vibranium_casing_cell/laser_welder_01/temperature', JSON.stringify({ value: Math.floor(stateLaser.temp), unit: "°C", emitted_at: now_iso }), false);
        }

        // --- 5. Publish CNC Mill (SPARKPLUG B + JSON UNS) ---
        if (isSparkplugEnabled) {
            let stateCNC = equipmentStatus.cnc_mill_05;
            let targetVib, targetLoad;
            if (stateCNC.status === 'error') { targetVib = 4.5 + randomBetween(-0.5, 0.5); targetLoad = 95 + randomBetween(-2, 2); }
            else if (stateCNC.status === 'running') { targetVib = 0.3 + randomBetween(-0.1, 0.1); targetLoad = 70 + randomBetween(-5, 5); }
            else { targetVib = 0.1; targetLoad = 0; }
            stateCNC.vibration = (stateCNC.vibration * 0.7) + (targetVib * 0.3);
            stateCNC.load = (stateCNC.load * 0.8) + (targetLoad * 0.2);
            stateCNC.spSeq = (stateCNC.spSeq + 1) % 256;
            const metrics = [
                { name: "Vibration", value: parseFloat(stateCNC.vibration.toFixed(2)), type: "Float" },
                { name: "Load", value: parseFloat(stateCNC.load.toFixed(1)), type: "Float" },
                { name: "Status", value: stateCNC.status, type: "String" }
            ];
            const payloadObject = { timestamp: now_ts, metrics: metrics, seq: stateCNC.spSeq };
            const payloadBuffer = spBv10Codec.encodePayload(payloadObject);
            publish('spBv1.0/stark_industries/DDATA/cnc_mill_05', payloadBuffer, true);
            
            publish('stark_industries/malibu_facility/assembly_line_01/vibranium_casing_cell/cnc_mill_05/vibration', JSON.stringify({ value: parseFloat(stateCNC.vibration.toFixed(2)), unit: "g", emitted_at: now_iso }), false);
            publish('stark_industries/malibu_facility/assembly_line_01/vibranium_casing_cell/cnc_mill_05/load', JSON.stringify({ value: parseFloat(stateCNC.load.toFixed(1)), unit: "%", emitted_at: now_iso }), false);
        }

        // --- 6. Publish Power Modulator (SPARKPLUG B + JSON UNS) ---
        if (isSparkplugEnabled) {
            let statePowerMod = equipmentStatus.power_modulator_01;
            let targetOutput, targetStab;
            if (statePowerMod.status === 'running') { targetOutput = 12.3 + randomBetween(-0.1, 0.1); targetStab = 0.998 + randomBetween(-0.001, 0.001); }
            else { targetOutput = 0.0; targetStab = 1.0; }
            statePowerMod.output = (statePowerMod.output * 0.9) + (targetOutput * 0.1);
            statePowerMod.stability = (statePowerMod.stability * 0.9) + (targetStab * 0.1);
            statePowerMod.spSeq = (statePowerMod.spSeq + 1) % 256;
            const metrics = [
                { name: "Output", value: parseFloat(statePowerMod.output.toFixed(2)), type: "Double" },
                { name: "Stability", value: parseFloat(statePowerMod.stability.toFixed(4)), type: "Float" },
                { name: "Status", value: statePowerMod.status, type: "String" }
            ];
            const payloadObject = { timestamp: now_ts, metrics: metrics, seq: statePowerMod.spSeq };
            const payloadBuffer = spBv10Codec.encodePayload(payloadObject);
            publish('spBv1.0/stark_industries/DDATA/power_modulator_01', payloadBuffer, true);
            
            publish('stark_industries/malibu_facility/assembly_line_02/repulsor_cell/power_modulator_01/output', JSON.stringify({ value: parseFloat(statePowerMod.output.toFixed(2)), unit: "GW", stability: parseFloat(statePowerMod.stability.toFixed(4)), emitted_at: now_iso }), false);
        }

        // --- 7. Publish Power Meter 01 (SPARKPLUG B + JSON UNS) ---
        if (isSparkplugEnabled) {
            let statePowerMeter = equipmentStatus.power_meter_01;
            let targetV = 230 + randomBetween(-1.5, 1.5);
            let targetPF = 0.95 + randomBetween(-0.03, 0.03);
            // Correlate power with total machine power
            let targetPower_kW = (equipmentStatus.bms.power * 1000 * 0.15) + randomBetween(-10, 10); // PM01 takes 15% of total
            let targetCurrent = (targetPower_kW * 1000) / (targetV * targetPF);

            statePowerMeter.voltage = (statePowerMeter.voltage * 0.8) + (targetV * 0.2);
            statePowerMeter.current = (statePowerMeter.current * 0.7) + (targetCurrent * 0.3);
            statePowerMeter.power = (statePowerMeter.power * 0.7) + (targetPower_kW * 0.3);
            statePowerMeter.pf = (statePowerMeter.pf * 0.9) + (targetPF * 0.1);
            statePowerMeter.spSeq = (statePowerMeter.spSeq + 1) % 256;
            
            const metrics = [
                { name: "Voltage", value: parseFloat(statePowerMeter.voltage.toFixed(1)), type: "Float" },
                { name: "Current", value: parseFloat(statePowerMeter.current.toFixed(2)), type: "Float" },
                { name: "ActivePower", value: parseFloat(statePowerMeter.power.toFixed(2)), type: "Float" }, // in kW
                { name: "PowerFactor", value: parseFloat(statePowerMeter.pf.toFixed(3)), type: "Float" },
                { name: "Status", value: statePowerMeter.status, type: "String" }
            ];
            const payloadObject = { timestamp: now_ts, metrics: metrics, seq: statePowerMeter.spSeq };
            const payloadBuffer = spBv10Codec.encodePayload(payloadObject);
            publish('spBv1.0/stark_industries/DDATA/power_meter_01', payloadBuffer, true);

            const jsonPayload = {
                voltage: parseFloat(statePowerMeter.voltage.toFixed(1)),
                current: parseFloat(statePowerMeter.current.toFixed(2)),
                power: parseFloat(statePowerMeter.power.toFixed(2)),
                power_unit: "kW",
                power_factor: parseFloat(statePowerMeter.pf.toFixed(3)),
                emitted_at: now_iso
            };
            publish('stark_industries/malibu_facility/infrastructure/power_meter_01/telemetry', JSON.stringify(jsonPayload), false);
        }

        // --- 8. Publish Gas Tanks (SPARKPLUG B + JSON UNS) ---
        if (isSparkplugEnabled) {
            // Argon (for welding)
            let stateArgon = equipmentStatus.gas_tank_argon;
            let argonUsage = (equipmentStatus.laser_welder_01.status === 'running') ? 0.05 : 0.001;
            stateArgon.level = Math.max(0, stateArgon.level - argonUsage);
            stateArgon.pressure = stateArgon.level * 2.0; // Pressure proportional to level
            stateArgon.spSeq = (stateArgon.spSeq + 1) % 256;
            publishGasDevice('gas_tank_argon', stateArgon, now_ts, now_iso);
            
            // Nitrogen (for CNC and leak)
            let stateNitro = equipmentStatus.gas_tank_nitrogen;
            let nitroUsage = (equipmentStatus.cnc_mill_05.status === 'running') ? 0.03 : 0.001;
            if (stateNitro.status === 'leaking') {
                nitroUsage = 1.5; // Fast leak!
            }
            stateNitro.level = Math.max(0, stateNitro.level - nitroUsage);
            stateNitro.pressure = stateNitro.level * 2.2;
            stateNitro.spSeq = (stateNitro.spSeq + 1) % 256;
            publishGasDevice('gas_tank_nitrogen', stateNitro, now_ts, now_iso);

            // Oxygen (stable)
            let stateOxygen = equipmentStatus.gas_tank_oxygen;
            stateOxygen.level -= 0.001;
            stateOxygen.pressure = stateOxygen.level * 1.8;
            stateOxygen.spSeq = (stateOxygen.spSeq + 1) % 256;
            publishGasDevice('gas_tank_oxygen', stateOxygen, now_ts, now_iso);
        }
    }
    
    /** Helper function to publish gas device data (SPB + JSON) */
    function publishGasDevice(deviceId, state, timestamp_ms, timestamp_iso) {
        const metrics = [
            { name: "Level", value: parseFloat(state.level.toFixed(2)), type: "Float" },
            { name: "Pressure", value: parseFloat(state.pressure.toFixed(1)), type: "Float" },
            { name: "Status", value: state.status, type: "String" }
        ];
        // 1. SPARKPLUG B (DDATA)
        const payloadObject = { timestamp: timestamp_ms, metrics: metrics, seq: state.spSeq };
        const payloadBuffer = spBv10Codec.encodePayload(payloadObject);
        publish(`spBv1.0/stark_industries/DDATA/${deviceId}`, payloadBuffer, true);
        
        // 2. JSON (UNS)
        const gasName = deviceId.split('_')[2]; // gas_tank_argon -> argon
        const jsonPayload = {
            value: parseFloat(state.level.toFixed(2)),
            unit: "%",
            pressure: parseFloat(state.pressure.toFixed(1)),
            pressure_unit: "bar",
            emitted_at: timestamp_iso
        };
        publish(`stark_industries/malibu_facility/infrastructure/gas_storage/${gasName}/level`, JSON.stringify(jsonPayload), false);
    }


    /**
     * The narrative (LF) scenario now includes Fire and Gas alerts.
     */
    const scenario = [
        // 1. Start Palladium Core WO
        () => { simState.workOrders.palladiumCore = { id: `WO-PD${Math.floor(10000 + Math.random() * 90000)}`, facility: "malibu", itemNumber: "ARC-PD-CORE-01", status: "RELEASED" }; return { topic: `stark_industries/malibu_facility/erp/workorder`, payload: { ...simState.workOrders.palladiumCore, itemName: "Palladium Core" } }; },
        // 2. MES step for Core -> Set robot to 'running'
        () => { simState.equipmentStatus.robot_arm_01.status = 'running'; return { topic: 'stark_industries/malibu_facility/assembly_line_01/palladium_core_cell/mes/operation', payload: { workOrderId: simState.workOrders.palladiumCore.id, step: 10, stepName: "Micro-particle assembly", operator: simState.operators[0], status: "IN_PROGRESS" } }; },
        // 3. OEE for Line 1
        () => ({ topic: 'stark_industries/malibu_facility/assembly_line_01/mes/oee', payload: { availability: randomBetween(0.98, 0.99), performance: randomBetween(0.96, 0.99), quality: 1.0, oee: 0.95 } }),
        // 4. Start Vibranium Casing WO
        () => { simState.workOrders.vibraniumCasing = { id: `WO-VB${Math.floor(10000 + Math.random() * 90000)}`, facility: "malibu", itemNumber: "ARC-VB-CASE-03", status: "RELEASED" }; return { topic: `stark_industries/malibu_facility/erp/workorder`, payload: { ...simState.workOrders.vibraniumCasing, itemName: "Vibranium Casing" } }; },
        // 5. MES step for Casing -> Set laser to 'running'
        () => { simState.equipmentStatus.laser_welder_01.status = 'running'; return { topic: 'stark_industries/malibu_facility/assembly_line_01/vibranium_casing_cell/mes/operation', payload: { workOrderId: simState.workOrders.vibraniumCasing.id, step: 10, stepName: "Laser welding", operator: simState.operators[1], status: "IN_PROGRESS" } }; },
        // 6. WMS PICK
        () => ({ topic: 'stark_industries/malibu_facility/wms/stock_movement', payload: { type: "PICK", itemNumber: "ARC-VB-CASE-03", quantity: 1, workOrderId: simState.workOrders.vibraniumCasing.id, location: "RACK-12C" } }),
        
        // --- Fire alarm scenario ---
        // 7. Trigger alarm
        () => { logger.warn("SIMULATOR: Injecting FIRE ALARM near Laser Welder."); return { topic: 'stark_industries/malibu_facility/fms/fire_alarm', payload: { zone: "Assembly Line 01 - Casing Cell", detector_id: "SMOKE-DET-1138", status: "ALARM" } }; },
        // 8. Operator stops machine due to alarm
        () => { simState.equipmentStatus.laser_welder_01.status = 'idle'; return { topic: 'stark_industries/malibu_facility/assembly_line_01/vibranium_casing_cell/mes/operation', payload: { workOrderId: simState.workOrders.vibraniumCasing.id, step: 15, stepName: "EMERGENCY STOP (Fire Alarm)", operator: simState.operators[1], status: "PAUSED" } }; },
        // 9. Alarm cleared (false alarm)
        () => { logger.info("SIMULATOR: Clearing Fire Alarm."); return { topic: 'stark_industries/malibu_facility/fms/fire_alarm', payload: { zone: "Assembly Line 01 - Casing Cell", detector_id: "SMOKE-DET-1138", status: "CLEAR" } }; },
        // 10. Resume work
        () => { simState.equipmentStatus.laser_welder_01.status = 'running'; return { topic: 'stark_industries/malibu_facility/assembly_line_01/vibranium_casing_cell/mes/operation', payload: { workOrderId: simState.workOrders.vibraniumCasing.id, step: 10, stepName: "Laser welding", operator: simState.operators[1], status: "IN_PROGRESS" } }; },
        // --- End fire scenario ---

        // 11. R&D Lab data
        () => ({ topic: 'stark_industries/malibu_facility/rd_lab_03/experiment_a_01/status', payload: { name: "New Element Synthesis", status: "STABLE", plasma_temp: randomBetween(4500.0, 4550.0), unit: "K" } }),
        // 12. MES step 20 for Core
        () => ({ topic: 'stark_industries/malibu_facility/assembly_line_01/palladium_core_cell/mes/operation', payload: { workOrderId: simState.workOrders.palladiumCore.id, step: 20, stepName: "Magnetic field stabilization", operator: simState.operators[2], status: "IN_PROGRESS" } }),
        // 13. Logistics inbound alert
        () => { simState.lastManifestId = `SH-VIB-92${Math.floor(100 + Math.random() * 900)}`; return { topic: 'stark_industries/malibu_facility/logistics/receiving_bay_01/alert', payload: { type: "INBOUND", carrier: "SHIELD Logistics", manifest_id: simState.lastManifestId, content: "Vibranium (Raw)", status: "AWAITING_INSPECTION" } }; },
        // 14. WMS RECEIPT
        () => ({ topic: 'stark_industries/malibu_facility/wms/stock_movement', payload: { type: "RECEIPT", itemNumber: "RAW-VIB-001", quantity: 50, unit: "kg", location: "QC-HOLD-01", manifest_id: simState.lastManifestId } }),
        // 15. MES step 20 for Casing -> Set laser 'idle', cnc 'running'
        () => { simState.equipmentStatus.laser_welder_01.status = 'idle'; simState.equipmentStatus.cnc_mill_05.status = 'running'; return { topic: 'stark_industries/malibu_facility/assembly_line_01/vibranium_casing_cell/mes/operation', payload: { workOrderId: simState.workOrders.vibraniumCasing.id, step: 20, stepName: "5-axis CNC milling", operator: simState.operators[3], status: "IN_PROGRESS" } }; },
        
        // --- Incident correlation sequence (Vibration) ---
        // 16. Inject fault
        () => { logger.warn("SIMULATOR: Injecting fault into CNC Mill 05. High vibration data will start."); simState.equipmentStatus.cnc_mill_05.status = 'error'; return null; },
        // 17. Publish CMMS alert
        () => ({ topic: 'stark_industries/malibu_facility/cmms/maintenance_request', payload: { equipmentId: "cnc_mill_05", equipmentPath: "malibu_facility/assembly_line_01/vibranium_casing_cell/cnc_mill_05", description: "Abnormal vibration detected by J.A.R.V.I.S.", priority: "HIGH" } }),
        // 18. Simulate "repair"
        () => { logger.info("SIMULATOR: Fault on CNC Mill 05 is 'resolved'. Data will return to normal."); simState.equipmentStatus.cnc_mill_05.status = 'running'; return null; },
        // --- End incident ---

        // 19. Security access event
        () => ({ topic: 'stark_industries/malibu_facility/security/access_control/lab_03_main', payload: { user: "Dr. Maya Hansen", access: "GRANTED", timestamp: new Date().toISOString() } }),
        
        // --- Gas leak scenario (Anoxia) ---
        // 20. Inject leak (silent)
        () => { logger.warn("SIMULATOR: Injecting NITROGEN LEAK. Pressure will drop rapidly."); simState.equipmentStatus.gas_tank_nitrogen.status = 'leaking'; return null; },
        // 21. Publish safety alert (Anoxia)
        () => ({ topic: 'stark_industries/malibu_facility/safety/atmosphere_alert', payload: { zone: "Infrastructure - Gas Storage", type: "ANOXIA_RISK", details: "Nitrogen (N2) leak detected, O2 displacement risk.", level: "CRITICAL" } }),
        // 22. Simulate leak "repair" (silent)
        () => { logger.info("SIMULATOR: Nitrogen leak 'repaired'."); simState.equipmentStatus.gas_tank_nitrogen.status = 'online'; return null; },
        // --- End leak ---

        // 23. Start Repulsor Unit WO
        () => { simState.workOrders.repulsorLift = { id: `WO-REP${Math.floor(10000 + Math.random() * 90000)}`, facility: "malibu", itemNumber: "MARK-42-RLU-01", status: "RELEASED" }; return { topic: `stark_industries/malibu_facility/erp/workorder`, payload: { ...simState.workOrders.repulsorLift, itemName: "Repulsor Lift Unit" } }; },
        // 24. MES step for Repulsor -> Set power mod to 'running'
        () => { simState.equipmentStatus.power_modulator_01.status = 'running'; return { topic: 'stark_industries/malibu_facility/assembly_line_02/repulsor_cell/mes/operation', payload: { workOrderId: simState.workOrders.repulsorLift.id, step: 10, stepName: "Energy Channeling Matrix", operator: simState.operators[5], status: "IN_PROGRESS" } }; },
        // 25. Quality check for Core
        () => { const isPass = Math.random() > 0.10; simState.workOrders.palladiumCore.quality_check = isPass ? "PASS" : "FAIL"; return { topic: 'stark_industries/malibu_facility/quality_control_station/qms/energy_output_test', payload: { workOrderId: simState.workOrders.palladiumCore.id, result: simState.workOrders.palladiumCore.quality_check, value: isPass ? randomBetween(2.9, 3.1) : randomBetween(1.5, 2.2), unit: "GJ/s" } }; },
        // 26. Rework loop
        () => { if (simState.workOrders.palladiumCore.quality_check === "FAIL") { return { topic: 'stark_industries/malibu_facility/assembly_line_01/palladium_core_cell/mes/operation', payload: { workOrderId: simState.workOrders.palladiumCore.id, step: 25, stepName: "REWORK - Field recalibration", operator: simState.operators[4], status: "IN_PROGRESS" } }; } return null; },
        // 27. Rework re-test
        () => { if (simState.workOrders.palladiumCore.quality_check === "FAIL") { simState.workOrders.palladiumCore.quality_check = "PASS"; return { topic: 'stark_industries/malibu_facility/quality_control_station/qms/energy_output_test', payload: { workOrderId: simState.workOrders.palladiumCore.id, result: "PASS", value: randomBetween(3.0, 3.2), unit: "GJ/s", details: "Retest post-recalibration OK" } }; } return null; },
        
        // --- Completion steps ---
        // 28. Complete Core WO
        () => { simState.equipmentStatus.robot_arm_01.status = 'idle'; simState.workOrders.palladiumCore.status = "COMPLETED"; return { topic: `stark_industries/malibu_facility/erp/workorder`, payload: { ...simState.workOrders.palladiumCore, completionDate: new Date().toISOString() } }; },
        // 29. WMS PUTAWAY
        () => ({ topic: 'stark_industries/malibu_facility/wms/stock_movement', payload: { type: "PUTAWAY", itemNumber: "ARC-PD-CORE-01", quantity: 1, workOrderId: simState.workOrders.palladiumCore.id, location: "FG-RACK-01A" } }),
        // 30. Complete Casing WO
        () => { simState.equipmentStatus.cnc_mill_05.status = 'idle'; simState.workOrders.vibraniumCasing.status = "COMPLETED"; return { topic: `stark_industries/malibu_facility/erp/workorder`, payload: { ...simState.workOrders.vibraniumCasing, completionDate: new Date().toISOString() } }; },
        // 31. WMS PUTAWAY
        () => ({ topic: 'stark_industries/malibu_facility/wms/stock_movement', payload: { type: "PUTAWAY", itemNumber: "ARC-VB-CASE-03", quantity: 1, workOrderId: simState.workOrders.vibraniumCasing.id, location: "FG-RACK-01B" } }),
        // 32. Complete Repulsor WO
        () => { simState.equipmentStatus.power_modulator_01.status = 'idle'; simState.workOrders.repulsorLift.status = "COMPLETED"; return { topic: `stark_industries/malibu_facility/erp/workorder`, payload: { ...simState.workOrders.repulsorLift, completionDate: new Date().toISOString() } }; },
        // 33. Security access denied event
        () => ({ topic: 'stark_industries/malibu_facility/security/access_control/prototype_vault', payload: { user: "Justin Hammer", access: "DENIED", reason: "Unauthorized", timestamp: new Date().toISOString() } }),
    ];
    
    if (isSparkplugEnabled) {
        logger.info("   -> Sparkplug B enabled. All devices will publish NBIRTH on start (seq=0) and DDATA on HF loop (SPB + JSON).");
    }
    
    const startSimulator = () => {
        if (narrativeInterval) return { status: 'already running' };

        // --- PUBLISH NBIRTH MESSAGES ON START ---
        publishBirthMessages();

        // Start NARRATIVE loop (slow)
        logger.info(`✅ Starting NARRATIVE loop. Publishing every ${NARRATIVE_INTERVAL_MS / 1000}s.`);
        narrativeInterval = setInterval(() => {
            let msg = null;
            do {
                msg = scenario[simState.step]();
                simState.step = (simState.step + 1) % scenario.length;
            } while (msg === null);
    
            msg.payload.emitted_at = new Date().toISOString();
            publish(msg.topic, JSON.stringify(msg.payload), false);

        }, NARRATIVE_INTERVAL_MS);

        // Start SENSOR loop (fast)
        if (sensorInterval) clearInterval(sensorInterval);
        logger.info(`✅ Starting SENSOR loop. Publishing every ${SENSOR_INTERVAL_MS / 1000}s.`);
        sensorInterval = setInterval(publishSensorData, SENSOR_INTERVAL_MS);
        publishSensorData(); // Publish once immediately

        return { status: 'running' };
    };
    
    const stopSimulator = () => {
        let stopped = false;
        if (narrativeInterval) {
            logger.info("✅ Stopping narrative loop.");
            clearInterval(narrativeInterval);
            narrativeInterval = null;
            stopped = true;
        }
        if (sensorInterval) {
            logger.info("✅ Stopping sensor loop.");
            clearInterval(sensorInterval);
            sensorInterval = null;
            stopped = true;
        }

        Object.keys(simState.equipmentStatus).forEach(key => {
            if (simState.equipmentStatus[key].status) {
                // Reset to 'online' for infrastructure, 'idle' for machines
                if (key.includes('power') || key.includes('gas')) {
                    simState.equipmentStatus[key].status = 'online';
                } else {
                    simState.equipmentStatus[key].status = 'idle';
                }
            }
        });
        logger.info("✅ All equipment statuses reset.");

        return stopped ? { status: 'stopped' } : { status: 'already stopped' };
    };

    const getStatus = () => (narrativeInterval || sensorInterval ? 'running' : 'stopped');

    return { startSimulator, stopSimulator, getStatus };
};