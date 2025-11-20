/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * Simulation Scenario: Death Star (Galactic Empire)
 *
 * This module exports a factory function that creates a new
 * instance of the Death Star simulation.
 */
const spBv10Codec = require('sparkplug-payload').get("spBv1.0");

/**
 * Factory function for the Death Star simulation scenario.
 * @param {pino.Logger} logger - A pino logger instance.
 * @param {function} publish - The function to publish MQTT messages (topic, payload, isBinary).
 * @param {boolean} isSparkplugEnabled - Global config flag for Sparkplug.
 * @returns {object} An object with start() and stop() methods.
 */
module.exports = (logger, publish, isSparkplugEnabled) => {
    
    let narrativeInterval = null;
    let sensorInterval = null;
    const NARRATIVE_INTERVAL_MS = 15000; //  Faster narrative loop
    const SENSOR_INTERVAL_MS = 7000;    // Loop for sensor/telemetry data
    
    const randomBetween = (min, max, decimals = 2) => parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
    
    // Scenario-specific state
    let simState = { 
        step: 0, 
        superlaserCharge: 0.0,
        reactorOutput: 100.0,
        rebelActivity: false,
        commanders: ["Lord Vader", "Grand Moff Tarkin", "Admiral Motti", "General Tagge", "Officer TK-421"],
        
        equipmentStatus: {
            // Sparkplug B Devices
            turbolaser_01: { status: 'standby', temp: 150, power: 10, target: 'none', spSeq: 0, bdSeq: 0 },
            turbolaser_02: { status: 'standby', temp: 155, power: 10, target: 'none', spSeq: 0, bdSeq: 0 },
            droid_r5_j4:   { status: 'patrol', battery: 85.0, task: 'sector 1138 patrol', spSeq: 0, bdSeq: 0 },
            droid_mse_6:   { status: 'transit', battery: 95.0, task: 'deliver datapad to command', spSeq: 0, bdSeq: 0 },
            interrogator_IT_O: { status: 'idle', subject: 'none', spSeq: 0, bdSeq: 0 }, // [NEW]

            // JSON UNS Devices
            life_support_s01: { o2: 20.9, co2: 410, pressure: 101.2 },
            shield_gen_main:  { power: 100, status: 'online' },
            tractor_beam_01:  { status: 'inactive', power: 0.0 },
            detention_AA23:   { prisoner: 'none', status: 'empty', guard: 'TK-421' }, // [NEW]
            trash_compactor_3263827: { status: 'idle', pressure: 10.0, walls_active: false }, // [NEW]
            bridge_status:    { alert_level: 'green', commander: 'Admiral Motti' } // [NEW]
        }
    };

    /**
     * Publishes NBIRTH messages for all Sparkplug B devices.
     */
    function publishBirthMessages() {
        if (!isSparkplugEnabled) return;

        logger.info("[DeathStarSim] Publishing Sparkplug NBIRTH messages for all devices...");
        const now_ts = Date.now();
        const sessionSeqNum = 0; // NBIRTH 'seq' MUST be 0

        // --- 1. Turbolaser 01 NBIRTH ---
        let stateTL01 = simState.equipmentStatus.turbolaser_01;
        stateTL01.bdSeq = (stateTL01.bdSeq + 1) % 256;
        let metricsTL01 = [
            { name: "Status", value: stateTL01.status, type: "String" },
            { name: "Capacitor/Temp", value: stateTL01.temp, type: "Float" },
            { name: "Capacitor/Power", value: stateTL01.power, type: "Float" },
            { name: "Target/ID", value: stateTL01.target, type: "String" }
        ];
        let payloadTL01 = spBv10Codec.encodePayload({ timestamp: now_ts, metrics: metricsTL01, seq: sessionSeqNum, bdSeq: stateTL01.bdSeq });
        publish('spBv1.0/galactic_empire/NBIRTH/turbolaser_01', payloadTL01, true);

        // --- 2. Turbolaser 02 NBIRTH ---
        let stateTL02 = simState.equipmentStatus.turbolaser_02;
        stateTL02.bdSeq = (stateTL02.bdSeq + 1) % 256;
        let metricsTL02 = [
            { name: "Status", value: stateTL02.status, type: "String" },
            { name: "Capacitor/Temp", value: stateTL02.temp, type: "Float" },
            { name: "Capacitor/Power", value: stateTL02.power, type: "Float" },
            { name: "Target/ID", value: stateTL02.target, type: "String" }
        ];
        let payloadTL02 = spBv10Codec.encodePayload({ timestamp: now_ts, metrics: metricsTL02, seq: sessionSeqNum, bdSeq: stateTL02.bdSeq });
        publish('spBv1.0/galactic_empire/NBIRTH/turbolaser_02', payloadTL02, true);

        // --- 3. Droid R5-J4 NBIRTH ---
        let stateR5 = simState.equipmentStatus.droid_r5_j4;
        stateR5.bdSeq = (stateR5.bdSeq + 1) % 256;
        let metricsR5 = [
            { name: "Status", value: stateR5.status, type: "String" },
            { name: "Battery", value: stateR5.battery, type: "Float" },
            { name: "CurrentTask", value: stateR5.task, type: "String" }
        ];
        let payloadR5 = spBv10Codec.encodePayload({ timestamp: now_ts, metrics: metricsR5, seq: sessionSeqNum, bdSeq: stateR5.bdSeq });
        publish('spBv1.0/galactic_empire/NBIRTH/droid_r5_j4', payloadR5, true);

        // --- 4. Droid MSE-6 (Mouse Droid) NBIRTH ---
        let stateMSE = simState.equipmentStatus.droid_mse_6;
        stateMSE.bdSeq = (stateMSE.bdSeq + 1) % 256;
        let metricsMSE = [
            { name: "Status", value: stateMSE.status, type: "String" },
            { name: "Battery", value: stateMSE.battery, type: "Float" },
            { name: "CurrentTask", value: stateMSE.task, type: "String" }
        ];
        let payloadMSE = spBv10Codec.encodePayload({ timestamp: now_ts, metrics: metricsMSE, seq: sessionSeqNum, bdSeq: stateMSE.bdSeq });
        publish('spBv1.0/galactic_empire/NBIRTH/droid_mse_6', payloadMSE, true);
        
        // --- 5. Interrogation Droid IT-O NBIRTH --- [NEW]
        let stateITO = simState.equipmentStatus["interrogator_IT_O"];
        stateITO.bdSeq = (stateITO.bdSeq + 1) % 256;
        let metricsITO = [
            { name: "Status", value: stateITO.status, type: "String" },
            { name: "Subject/ID", value: stateITO.subject, type: "String" }
        ];
        let payloadITO = spBv10Codec.encodePayload({ timestamp: now_ts, metrics: metricsITO, seq: sessionSeqNum, bdSeq: stateITO.bdSeq });
        publish('spBv1.0/galactic_empire/NBIRTH/interrogator_IT_O', payloadITO, true);

        
        logger.info("[DeathStarSim]    -> NBIRTH messages published (seq=0).");
    }

    /**
     * Publishes DDATA and JSON for all sensors/equipment.
     */
    function publishSensorData() {
        const { equipmentStatus } = simState;
        const now_iso = new Date().toISOString();
        const now_ts = Date.now();

        // --- 1. Superlaser Charge (JSON UNS) ---
        if (simState.superlaserCharge < 100) {
            simState.superlaserCharge += randomBetween(0.5, 1.5);
            simState.superlaserCharge = Math.min(simState.superlaserCharge, 100);
        }
        publish('galactic_empire/death_star/weapon_systems/superlaser/charge', JSON.stringify({
            value: parseFloat(simState.superlaserCharge.toFixed(2)), unit: "%", status: "charging", emitted_at: now_iso
        }), false);

        // --- 2. Main Reactor (JSON UNS) ---
        let reactorFluctuation = (simState.rebelActivity ? randomBetween(-5, 5) : randomBetween(-1, 1));
        let targetReactor = 100 + reactorFluctuation;
        simState.reactorOutput = (simState.reactorOutput * 0.9) + (targetReactor * 0.1);
        publish('galactic_empire/death_star/power_systems/main_reactor/output', JSON.stringify({
            value: parseFloat(simState.reactorOutput.toFixed(1)), unit: "%", emitted_at: now_iso
        }), false);
        
        // --- 3. Life Support (JSON UNS) ---
        let stateLife = equipmentStatus.life_support_s01;
        stateLife.o2 = 20.9 + (simState.rebelActivity ? randomBetween(-0.5, 0.1) : randomBetween(-0.1, 0.1));
        stateLife.co2 = 410 + (simState.rebelActivity ? randomBetween(5, 50) : randomBetween(-5, 5));
        publish('galactic_empire/death_star/life_support/sector_01/telemetry', JSON.stringify({
            o2_level: parseFloat(stateLife.o2.toFixed(1)),
            co2_level: parseFloat(stateLife.co2.toFixed(0)),
            pressure: parseFloat(stateLife.pressure.toFixed(1)),
            unit_pressure: "kPa",
            emitted_at: now_iso
        }), false);
        
        // --- 4. Shield Generator (JSON UNS) ---
        let stateShield = equipmentStatus.shield_gen_main;
        if (simState.rebelActivity && stateShield.status === 'online') {
            stateShield.power = randomBetween(85, 99);
        } else if (stateShield.status === 'online') {
            stateShield.power = 100;
        }
        publish('galactic_empire/death_star/defense_systems/main_shield/status', JSON.stringify({
            status: stateShield.status, power: stateShield.power, unit: "%", emitted_at: now_iso
        }), false);

        
        // --- 5. Turbolaser 01 (SPARKPLUG B + JSON UNS) ---
        if (isSparkplugEnabled) {
            let stateTL01 = equipmentStatus.turbolaser_01;
            if (stateTL01.status === 'firing') {
                stateTL01.temp += randomBetween(50, 75);
                stateTL01.power = randomBetween(90, 100);
            } else {
                stateTL01.temp = Math.max(150, stateTL01.temp - randomBetween(20, 30));
                stateTL01.power = Math.max(10, stateTL01.power - randomBetween(10, 20));
            }
            stateTL01.spSeq = (stateTL01.spSeq + 1) % 256; 
            const metrics = [
                { name: "Status", value: stateTL01.status, type: "String" },
                { name: "Capacitor/Temp", value: parseFloat(stateTL01.temp.toFixed(0)), type: "Float" },
                { name: "Capacitor/Power", value: parseFloat(stateTL01.power.toFixed(0)), type: "Float" },
                { name: "Target/ID", value: stateTL01.target, type: "String" }
            ];
            const payloadObject = { timestamp: now_ts, metrics: metrics, seq: stateTL01.spSeq };
            const payloadBuffer = spBv10Codec.encodePayload(payloadObject);
            publish('spBv1.0/galactic_empire/DDATA/turbolaser_01', payloadBuffer, true);
            
            publish('galactic_empire/death_star/defense_systems/turbolaser_battery_01/turbolaser_01/telemetry', JSON.stringify({
                status: stateTL01.status, temp: stateTL01.temp, power: stateTL01.power, target: stateTL01.target, emitted_at: now_iso
            }), false);
        }
        
        // --- 6. Droid R5-J4 (SPARKPLUG B + JSON UNS) ---
        if (isSparkplugEnabled) {
            let stateR5 = equipmentStatus.droid_r5_j4;
            if (stateR5.status === 'maintenance') {
                stateR5.battery = Math.max(0, stateR5.battery - 0.5); // Drains faster
            } else {
                stateR5.battery = Math.max(0, stateR5.battery - 0.1); // Slow drain
            }
            stateR5.spSeq = (stateR5.spSeq + 1) % 256;
            const metrics = [
                { name: "Status", value: stateR5.status, type: "String" },
                { name: "Battery", value: parseFloat(stateR5.battery.toFixed(1)), type: "Float" },
                { name: "CurrentTask", value: stateR5.task, type: "String" }
            ];
            const payloadObject = { timestamp: now_ts, metrics: metrics, seq: stateR5.spSeq };
            const payloadBuffer = spBv10Codec.encodePayload(payloadObject);
            publish('spBv1.0/galactic_empire/DDATA/droid_r5_j4', payloadBuffer, true);

            publish('galactic_empire/death_star/logistics/droid_pool/R5-J4/status', JSON.stringify({
                status: stateR5.status, battery: parseFloat(stateR5.battery.toFixed(1)), task: stateR5.task, emitted_at: now_iso
            }), false);
        }

        // --- 7. Trash Compactor (JSON UNS) --- [NEW]
        let stateCompactor = equipmentStatus.trash_compactor_3263827;
        if (stateCompactor.walls_active) {
            stateCompactor.pressure += randomBetween(10, 25);
            stateCompactor.status = 'compacting';
        } else if (stateCompactor.pressure > 10) {
            stateCompactor.pressure -= randomBetween(5, 10);
            stateCompactor.status = 'idle';
        }
        stateCompactor.pressure = Math.max(10, stateCompactor.pressure);
        publish('galactic_empire/death_star/waste_management/trash_compactor_3263827/status', JSON.stringify({
            status: stateCompactor.status,
            pressure: parseFloat(stateCompactor.pressure.toFixed(1)),
            unit: "PSI",
            walls_active: stateCompactor.walls_active,
            emitted_at: now_iso
        }), false);
        
        // --- 8. Interrogation Droid (SPARKPLUG B) --- [NEW]
        if (isSparkplugEnabled) {
            let stateITO = equipmentStatus["interrogator_IT_O"];
            // Logic is in narrative, just publish status
            stateITO.spSeq = (stateITO.spSeq + 1) % 256;
            const metrics = [
                { name: "Status", value: stateITO.status, type: "String" },
                { name: "Subject/ID", value: stateITO.subject, type: "String" }
            ];
            const payloadObject = { timestamp: now_ts, metrics: metrics, seq: stateITO.spSeq };
            const payloadBuffer = spBv10Codec.encodePayload(payloadObject);
            publish('spBv1.0/galactic_empire/DDATA/interrogator_IT_O', payloadBuffer, true);
        }
    }
    

    /**
     * The narrative (LF) scenario for the Death Star
     */
    const scenario = [
        // 1. All systems nominal
        () => { 
            simState.rebelActivity = false; 
            simState.equipmentStatus.turbolaser_01.status = 'standby';
            simState.equipmentStatus.turbolaser_01.target = 'none';
            simState.equipmentStatus.bridge_status.alert_level = 'green';
            simState.equipmentStatus.bridge_status.commander = simState.commanders[2]; // Motti
            return { topic: 'galactic_empire/death_star/command/bridge/status', payload: { ...simState.equipmentStatus.bridge_status, status: "All systems nominal. Awaiting arrival at Alderaan." } }; 
        },
        // 2. Start Superlaser charging
        () => { 
            simState.superlaserCharge = 0; 
            simState.equipmentStatus.bridge_status.commander = simState.commanders[1]; // Tarkin
            return { topic: 'galactic_empire/death_star/command/weapon_control', payload: { order: "Commence primary ignition.", target: "Alderaan", commander: simState.commanders[1] } }; 
        },
        // 3. Logistics order for Droid
        () => {
            simState.equipmentStatus.droid_mse_6.status = 'transit';
            simState.equipmentStatus.droid_mse_6.task = 'Deliver tactical plans to Lord Vader';
            return { topic: 'galactic_empire/death_star/logistics/droid_dispatch', payload: { droidId: "MSE-6-881", task: "Deliver datapad to Lord Vader", destination: "Command Center" } };
        },
        //  4. Prisoner transfer
        () => {
            logger.info("[DeathStarSim] Prisoner Arrived: Leia Organa");
            simState.equipmentStatus.detention_AA23.prisoner = "Leia Organa (ID: 2187)";
            simState.equipmentStatus.detention_AA23.status = "detained";
            return { topic: 'galactic_empire/death_star/security/detention_block_AA23/status', payload: { ...simState.equipmentStatus.detention_AA23 } };
        },
        //  5. Interrogation
        () => {
            simState.equipmentStatus.bridge_status.commander = simState.commanders[0]; // Vader
            simState.equipmentStatus["interrogator_IT_O"].status = "active";
            simState.equipmentStatus["interrogator_IT_O"].subject = "Leia Organa (ID: 2187)";
            return { topic: 'galactic_empire/death_star/command/bridge/status', payload: { ...simState.equipmentStatus.bridge_status, status: "Commencing interrogation of prisoner 2187." } };
        },
        // 6. Rebel fleet detected!
        () => { 
            logger.warn("[DeathStarSim] Rebel fleet detected! Simulating attack...");
            simState.rebelActivity = true; 
            simState.equipmentStatus.bridge_status.alert_level = 'red';
            return { topic: 'galactic_empire/death_star/command/bridge/status', payload: { ...simState.equipmentStatus.bridge_status, status: "Rebel fleet detected. All batteries fire at will." } }; 
        },
        // 7. Turbolasers engage
        () => { 
            simState.equipmentStatus.turbolaser_01.status = 'firing';
            simState.equipmentStatus.turbolaser_01.target = 'X-Wing (Red-5)';
            return { topic: 'galactic_empire/death_star/defense_systems/turbolaser_battery_01/command', payload: { target: "X-Wing squadron", action: "FIRE" } };
        },
        // 8. Tractor beam engages
        () => {
            simState.equipmentStatus.tractor_beam_01.status = 'active';
            simState.equipmentStatus.tractor_beam_01.power = 100;
            return { topic: 'galactic_empire/death_star/defense_systems/tractor_beam_01/status', payload: { status: 'active', power: 100, target: "Millennium Falcon", emitted_at: new Date().toISOString() } };
        },
        //  9. Guard post abandoned
        () => {
            simState.equipmentStatus.detention_AA23.guard = "none (post abandoned)";
            return { topic: 'galactic_empire/death_star/security/detention_block_AA23/status', payload: { ...simState.equipmentStatus.detention_AA23 } };
        },
        //  10. Prisoner escape!
        () => {
            logger.warn("[DeathStarSim] Prisoner Escape!");
            simState.equipmentStatus.detention_AA23.prisoner = "none";
            simState.equipmentStatus.detention_AA23.status = "breached";
            simState.equipmentStatus["interrogator_IT_O"].status = "idle";
            simState.equipmentStatus["interrogator_IT_O"].subject = "none";
            simState.equipmentStatus.bridge_status.commander = simState.commanders[0]; // Vader
            return { topic: 'galactic_empire/death_star/command/bridge/status', payload: { ...simState.equipmentStatus.bridge_status, status: "Security breach in detention block AA-23! Prisoner has escaped!" } };
        },
        //  11. Trash compactor activated
        () => {
            logger.warn("[DeathStarSim] Activating trash compactor!");
            simState.equipmentStatus.trash_compactor_3263827.walls_active = true;
            return { topic: 'galactic_empire/death_star/waste_management/trash_compactor_3263827/command', payload: { command: "ACTIVATE" } };
        },
        //  12. Trash compactor shut down
        () => {
            logger.info("[DeathStarSim] Shutting down all trash compactors.");
            simState.equipmentStatus.trash_compactor_3263827.walls_active = false;
            simState.equipmentStatus.trash_compactor_3263827.status = "shutdown";
            return { topic: 'galactic_empire/death_star/waste_management/command', payload: { command: "SHUTDOWN_ALL_COMPACTORS", reason: "Emergency override", commander: simState.commanders[1] } };
        },
        // 13. Rebel hit! Shield generator damaged.
        () => { 
            logger.warn("[DeathStarSim] Shield generator hit!");
            simState.equipmentStatus.shield_gen_main.status = 'damaged';
            simState.equipmentStatus.shield_gen_main.power = 25;
            return { topic: 'galactic_empire/death_star/command/damage_control', payload: { system: "Main Shield Generator", status: "DAMAGED", details: "Rebel torpedo hit. Power at 25%." } };
        },
        // 14. Droid R5 dispatched for repair
        () => {
            simState.equipmentStatus.droid_r5_j4.status = 'maintenance';
            simState.equipmentStatus.droid_r5_j4.task = 'Repair shield generator power coupling';
            return { topic: 'galactic_empire/death_star/logistics/droid_dispatch', payload: { droidId: "R5-J4", task: "Repair main shield generator", destination: "Shield Generator Room" } };
        },
        // 15. Superlaser fires!
        () => { 
            logger.info("[DeathStarSim] Superlaser FIRE!");
            simState.superlaserCharge = 0.0; // Reset charge
            return { topic: 'galactic_empire/death_star/weapon_systems/superlaser/status', payload: { status: "DISCHARGED", target: "Alderaan", result: "Target destroyed.", commander: simState.commanders[1], emitted_at: new Date().toISOString() } }; 
        },
        // 16. Repair complete
        () => { 
            logger.info("[DeathStarSim] Shield generator repaired.");
            simState.equipmentStatus.shield_gen_main.status = 'online';
            simState.equipmentStatus.shield_gen_main.power = 100;
            simState.equipmentStatus.droid_r5_j4.status = 'patrol';
            simState.equipmentStatus.droid_r5_j4.task = 'Returning to duty';
            return { topic: 'galactic_empire/death_star/command/damage_control', payload: { system: "Main Shield Generator", status: "ONLINE", details: "Repairs complete by unit R5-J4." } };
        },
        // 17. Tractor beam disabled
        () => {
            simState.equipmentStatus.tractor_beam_01.status = 'offline';
            simState.equipmentStatus.tractor_beam_01.power = 0;
            return { topic: 'galactic_empire/death_star/defense_systems/tractor_beam_01/status', payload: { status: 'offline', power: 0, reason: "Manual override by unauthorized personnel.", emitted_at: new Date().toISOString() } };
        },
        // 18. Battle over
        () => { 
            logger.info("[DeathStarSim] Battle simulation over. Returning to nominal.");
            simState.rebelActivity = false; 
            simState.equipmentStatus.turbolaser_01.status = 'standby';
            simState.equipmentStatus.turbolaser_01.target = 'none';
            simState.equipmentStatus.bridge_status.alert_level = 'green';
            simState.equipmentStatus.detention_AA23.guard = 'TK-421'; // He's back
            return { topic: 'galactic_empire/death_star/command/bridge/status', payload: { ...simState.equipmentStatus.bridge_status, status: "Rebel fleet has retreated." } }; 
        },
    ];
    
    // --- Public Methods ---
    
    function start() {
        if (narrativeInterval) return; // Already running

        // --- PUBLISH NBIRTH MESSAGES ON START ---
        publishBirthMessages();

        // Start NARRATIVE loop (slow)
        logger.info(`[DeathStarSim] Starting NARRATIVE loop. Publishing every ${NARRATIVE_INTERVAL_MS / 1000}s.`);
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
        logger.info(`[DeathStarSim] Starting SENSOR loop. Publishing every ${SENSOR_INTERVAL_MS / 1000}s.`);
        sensorInterval = setInterval(publishSensorData, SENSOR_INTERVAL_MS);
        publishSensorData(); // Publish once immediately
    }
    
    function stop() {
        let stopped = false;
        if (narrativeInterval) {
            logger.info("[DeathStarSim] Stopping narrative loop.");
            clearInterval(narrativeInterval);
            narrativeInterval = null;
            stopped = true;
        }
        if (sensorInterval) {
            logger.info("[DeathStarSim] Stopping sensor loop.");
            clearInterval(sensorInterval);
            sensorInterval = null;
            stopped = true;
        }

        // Reset state
        Object.keys(simState.equipmentStatus).forEach(key => {
            if (simState.equipmentStatus[key].status) {
                if (key.includes('droid')) {
                    simState.equipmentStatus[key].status = 'patrol';
                } else if (key.includes('turbolaser')) {
                    simState.equipmentStatus[key].status = 'standby';
                } else if (key.includes('interrogator')) {
                    simState.equipmentStatus[key].status = 'idle';
                    simState.equipmentStatus[key].subject = 'none';
                } else if (key.includes('detention')) {
                    simState.equipmentStatus[key].status = 'empty';
                    simState.equipmentStatus[key].prisoner = 'none';
                } else if (key.includes('trash')) {
                    simState.equipmentStatus[key].status = 'idle';
                    simState.equipmentStatus[key].walls_active = false;
                } else {
                    simState.equipmentStatus[key].status = 'online';
                }
            }
        });
        simState.superlaserCharge = 0.0;
        simState.rebelActivity = false;
        simState.equipmentStatus.bridge_status.alert_level = 'green';
        logger.info("[DeathStarSim] All equipment statuses reset.");
        return stopped;
    }

    // Return the public interface
    return {
        start,
        stop
    };
};