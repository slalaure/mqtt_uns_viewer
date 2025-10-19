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
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const spBv10Codec = require('sparkplug-payload').get("spBv1.0");

module.exports = (logger, publish, isSparkplugEnabled) => {
    let simulatorInterval = null;
    const SIMULATION_INTERVAL_MS = 1500;
    
    const randomBetween = (min, max, decimals = 2) => parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
    let simState = { 
        step: 0, 
        workOrders: { palladiumCore: null, vibraniumCasing: null }, 
        operators: ["Pepper Potts", "Happy Hogan", "James Rhodes", "J.A.R.V.I.S.", "Peter Parker"], 
        spSeq: 0 
    };

    const scenario = [
        () => { simState.workOrders.palladiumCore = { id: `WO-PD${Math.floor(10000 + Math.random() * 90000)}`, facility: "malibu", itemNumber: "ARC-PD-CORE-01", status: "RELEASED" }; return { topic: `stark_industries/malibu_facility/erp/workorder`, payload: { ...simState.workOrders.palladiumCore, itemName: "Palladium Core" } }; },
        () => ({ topic: 'stark_industries/malibu_facility/assembly_line_01/palladium_core_cell/mes/operation', payload: { workOrderId: simState.workOrders.palladiumCore.id, step: 10, stepName: "Micro-particle assembly", operator: simState.operators[0], status: "IN_PROGRESS" } }),
        () => ({ topic: 'stark_industries/malibu_facility/assembly_line_01/palladium_core_cell/robotic_arm_01/torque', payload: { value: randomBetween(8.5, 9.2), unit: "Nm" } }),
        () => ({ topic: 'stark_industries/malibu_facility/assembly_line_01/mes/oee', payload: { availability: randomBetween(0.98, 0.99), performance: randomBetween(0.96, 0.99), quality: 1.0, oee: 0.95 } }),
        () => { simState.workOrders.vibraniumCasing = { id: `WO-VB${Math.floor(10000 + Math.random() * 90000)}`, facility: "malibu", itemNumber: "ARC-VB-CASE-03", status: "RELEASED" }; return { topic: `stark_industries/malibu_facility/erp/workorder`, payload: { ...simState.workOrders.vibraniumCasing, itemName: "Vibranium Casing" } }; },
        () => ({ topic: 'stark_industries/malibu_facility/assembly_line_01/vibranium_casing_cell/mes/operation', payload: { workOrderId: simState.workOrders.vibraniumCasing.id, step: 10, stepName: "Laser welding", operator: simState.operators[1], status: "IN_PROGRESS" } }),
        () => ({ topic: 'stark_industries/malibu_facility/assembly_line_01/vibranium_casing_cell/laser_welder_01/temperature', payload: { value: randomBetween(1200, 1500, 0), unit: "°C" } }),
        () => ({ topic: 'stark_industries/malibu_facility/assembly_line_01/palladium_core_cell/mes/operation', payload: { workOrderId: simState.workOrders.palladiumCore.id, step: 20, stepName: "Magnetic field stabilization", operator: simState.operators[2], status: "IN_PROGRESS" } }),
        () => ({ topic: 'stark_industries/malibu_facility/assembly_line_01/clean_room_01/humidity', payload: { value: randomBetween(25, 28, 1), unit: "%RH" } }),
        () => ({ topic: 'stark_industries/malibu_facility/assembly_line_01/vibranium_casing_cell/mes/operation', payload: { workOrderId: simState.workOrders.vibraniumCasing.id, step: 20, stepName: "5-axis CNC milling", operator: simState.operators[3], status: "IN_PROGRESS" } }),
        () => ({ topic: 'stark_industries/malibu_facility/assembly_line_01/vibranium_casing_cell/cnc_mill_05/vibration', payload: { value: randomBetween(0.2, 0.5), unit: "g" } }),
        () => ({ topic: 'stark_industries/malibu_facility/cmms/maintenance_request', payload: { equipmentId: "cnc_mill_05", equipmentPath: "malibu_facility/assembly_line_01/vibranium_casing_cell/cnc_mill_05", description: "Abnormal vibration detected by J.A.R.V.I.S.", priority: "HIGH" } }),
        () => { const isPass = Math.random() > 0.10; simState.workOrders.palladiumCore.quality_check = isPass ? "PASS" : "FAIL"; return { topic: 'stark_industries/malibu_facility/quality_control_station/qms/energy_output_test', payload: { workOrderId: simState.workOrders.palladiumCore.id, result: simState.workOrders.palladiumCore.quality_check, value: isPass ? randomBetween(2.9, 3.1) : randomBetween(1.5, 2.2), unit: "GJ/s" } }; },
        () => { if (simState.workOrders.palladiumCore.quality_check === "FAIL") { return { topic: 'stark_industries/malibu_facility/assembly_line_01/palladium_core_cell/mes/operation', payload: { workOrderId: simState.workOrders.palladiumCore.id, step: 25, stepName: "REWORK - Field recalibration", operator: simState.operators[4], status: "IN_PROGRESS" } }; } return null; },
        () => { if (simState.workOrders.palladiumCore.quality_check === "FAIL") { simState.workOrders.palladiumCore.quality_check = "PASS"; return { topic: 'stark_industries/malibu_facility/quality_control_station/qms/energy_output_test', payload: { workOrderId: simState.workOrders.palladiumCore.id, result: "PASS", value: randomBetween(3.0, 3.2), unit: "GJ/s", details: "Retest post-recalibration OK" } }; } return null; },
        () => { simState.workOrders.palladiumCore.status = "COMPLETED"; return { topic: `stark_industries/malibu_facility/erp/workorder`, payload: { ...simState.workOrders.palladiumCore, completionDate: new Date().toISOString() } }; },
        () => { simState.workOrders.vibraniumCasing.status = "COMPLETED"; return { topic: `stark_industries/malibu_facility/erp/workorder`, payload: { ...simState.workOrders.vibraniumCasing, completionDate: new Date().toISOString() } }; },
    ];
    
    if (isSparkplugEnabled) {
        const sparkplugDeviceStep = () => {
            const topic = 'spBv1.0/stark_industries/NDATA/robot_arm_01';
            simState.spSeq = (simState.spSeq + 1) % 256;
            
            const payloadObject = {
                timestamp: Date.now(),
                metrics: [
                    { name: "Motor/Speed", value: Math.floor(randomBetween(1500, 1800)), type: "Int32" },
                    { name: "Motor/Temp", value: randomBetween(80, 85, 1), type: "Float" }
                ],
                seq: simState.spSeq
            };
    
            const payloadBuffer = spBv10Codec.encodePayload(payloadObject);
            return { topic: topic, payload: payloadBuffer, isBinary: true };
        };
        scenario.splice(3, 0, sparkplugDeviceStep);
        logger.info("   -> Sparkplug B demo step has been added to the simulator scenario.");
    }
    
    const startSimulator = () => {
        if (simulatorInterval) return { status: 'already running' };
        logger.info(`✅ Starting simulation loop. Publishing every ${SIMULATION_INTERVAL_MS / 1000}s.`);
        simulatorInterval = setInterval(() => {
            let msg = null;
            do {
                msg = scenario[simState.step]();
                simState.step = (simState.step + 1) % scenario.length;
            } while (msg === null);
    
            if (msg.isBinary) {
                publish(msg.topic, msg.payload, true);
            } else {
                msg.payload.emitted_at = new Date().toISOString();
                publish(msg.topic, JSON.stringify(msg.payload), false);
            }
        }, SIMULATION_INTERVAL_MS);
        return { status: 'running' };
    };
    
    const stopSimulator = () => {
        if (simulatorInterval) {
            logger.info("✅ Stopping simulation loop.");
            clearInterval(simulatorInterval);
            simulatorInterval = null;
            return { status: 'stopped' };
        }
        return { status: 'already stopped' };
    };

    // Expose a function to get the current status
    const getStatus = () => (simulatorInterval ? 'running' : 'stopped');

    // Add getStatus to the exported object
    return { startSimulator, stopSimulator, getStatus };
};