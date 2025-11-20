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
 * Simulation Scenario: Paris Métro (RATP UNS)
 *
 * This module exports a factory function that creates a new
 * instance of the Paris Métro simulation.
 * It simulates Lines 1, 2, and 6, matching the provided SVG.
 */

/**
 * Factory function for the Paris Métro simulation scenario.
 * @param {pino.Logger} logger - A pino logger instance.
 * @param {function} publish - The function to publish MQTT messages (topic, payload, isBinary).
 * @param {boolean} isSparkplugEnabled - Global config flag (unused here).
 * @returns {object} An object with start() and stop() methods.
 */
module.exports = (logger, publish, isSparkplugEnabled) => {
    
    let narrativeInterval = null;
    let sensorInterval = null;
    const NARRATIVE_INTERVAL_MS = 12000; // Loop for business/command events
    const SENSOR_INTERVAL_MS = 4000;    // Loop for sensor/telemetry data
    
    const randomBetween = (min, max, decimals = 0) => parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
    
    // --- Static Data (matching the SVG) ---
    // Note: Station IDs must match the <path id="..."> in the SVG
    const lineStations = {
        "1": [
            "line1_gare_la_defense", "line1_gare_esplanade_de_la_defense", "line1_gare_pont_de_neuilly", "line1_gare_les_sablons",
            "line1_gare_porte_maillot", "line1_gare_argentine", "line1_gare_charles_de_gaulle_etoile", "line1_gare_georges_v",
            "line1_garefranklin_d_roosevelt", "line1_gare_champs-elysees_clemenceau", "line1_gare_concorde", "line1_gare_tuileries",
            "line1_gare_palais_royal_musee_du_louvre", "line1_gare_louvre_rivoli", "line1_gare_chatelet", "line1_gare_hotel_de_ville",
            "line1_gare_saint-paul", "line1_gare_bastille", "line1_gare_gare_de_lyon", "line1_gare_reuilly_diderot",
            "line1_gare_nation", "line1_gare_porte_de_vincennes", "line1_gare_saint_mandé", "line1_gare_berault", "line1_gare_chateau_de_vincennes"
        ],
        "2": [
            "line2_gare_porte_dauphine", "line2_gare_victor_hugo", "line2_gare_ternes", "line2_gare_courcelles", "line2_gare_monceau",
            "line2_gare_villiers", "line2_gare_rome", "line2_gare_place_de_clichy", "line2_gare_blanche", "line2_gare_pigalle",
            "line2_gare_anvers", "line2_gare_barbes-rochechouart", "line2_gare_la_chapelle", "line2_gare_stallingrad", "line2_gare_jaures",
            "line2_gare_colonnel_fabien", "line2_gare_belleville", "line2_gare_couronnes", "line2_gare_menilmontant",
            "line2_gare_philippe_auguste", "line2_gare_alexandre_dumas", "line2_gare_avron", "line2_gare_nation"
        ],
        "6": [
            "line6_gare_charles_de_gaule_etoile", "line6_gare_kleber", "line6_gare_boissiere", "line6_gare_trocadero", "line6_gare_passy",
            "line6_gare_bir-hakeim_tour_eiffel", "line6_gare_dupleix", "line6_gare_la_motte_piquet_grenelle", "line6_gare_cambronne",
            "line6_gare_sevres_lecourbe", "line6_gare_pasteur", "line6_gare_montparnasse_bienvenue", "line6_gare_edgar_quinet",
            "line6_gare_raspail", "line6_gare_denfert_rochereau", "line6_gare_saint-jaques", "line6_gare_glaciere", "line6_gare_corvisart",
            "line6_gare_nationale", "line6_gare_chevaleret", "line6_gare_quai_de_la_gare", "line6_gare_bercy",
            "line6_gare_dugommier", "line6_gare_daumesnil", "line6_gare_bel-air", "line6_gare_picpus", "line6_gare_nation"
        ]
    };

    // --- Dynamic State ---
    let simState = { 
        step: 0, 
        global_status: "OK",
        lines: {
            "1": { status: "OK", message: "Trafic normal" },
            "2": { status: "OK", message: "Trafic normal" },
            "6": { status: "OK", message: "Trafic normal" }
        },
        trains: {
            // Line 1
            "MP05-01": { line: "1", position_station_id: "line1_gare_la_defense", direction: 1, passengers: 310, capacity: 720, speed: 0, driver: "AUTO", status: "STOPPED_STATION" },
            "MP05-05": { line: "1", position_station_id: "line1_gare_chatelet", direction: 1, passengers: 450, capacity: 720, speed: 65, driver: "AUTO", status: "RUNNING" },
            "MP05-09": { line: "1", position_station_id: "line1_gare_nation", direction: -1, passengers: 280, capacity: 720, speed: 0, driver: "AUTO", status: "STOPPED_STATION" },
            // Line 2
            "MF01-21": { line: "2", position_station_id: "line2_gare_porte_dauphine", direction: 1, passengers: 220, capacity: 650, speed: 0, driver: "M. Dubois", status: "STOPPED_STATION" },
            "MF01-25": { line: "2", position_station_id: "line2_gare_anvers", direction: 1, passengers: 310, capacity: 650, speed: 45, driver: "Mme. Lefevre", status: "RUNNING" },
            "MF01-29": { line: "2", position_station_id: "line2_gare_belleville", direction: -1, passengers: 400, capacity: 650, speed: 0, driver: "M. Martin", status: "STOPPED_STATION" },
            // Line 6
            "MP73-61": { line: "6", position_station_id: "line6_gare_charles_de_gaule_etoile", direction: 1, passengers: 180, capacity: 600, speed: 0, driver: "M. Petit", status: "STOPPED_STATION" },
            "MP73-64": { line: "6", position_station_id: "line6_gare_montparnasse_bienvenue", direction: 1, passengers: 350, capacity: 600, speed: 55, driver: "Mme. Moreau", status: "RUNNING" },
            "MP73-68": { line: "6", position_station_id: "line6_gare_nation", direction: -1, passengers: 290, capacity: 600, speed: 0, driver: "M. Laurent", status: "STOPPED_STATION" },
        },
        stations: {
            "chatelet": { passengers: 4500, capacity: 10000, air_quality: { co2: 650, pm2_5: 18 }, alert: "NONE" },
            "charles_de_gaulle_etoile": { passengers: 3200, capacity: 8000, air_quality: { co2: 500, pm2_5: 12 }, alert: "NONE" },
            "nation": { passengers: 2800, capacity: 7000, air_quality: { co2: 520, pm2_5: 14 }, alert: "NONE" },
            "barbes-rochechouart": { passengers: 1500, capacity: 4000, air_quality: { co2: 700, pm2_5: 22 }, alert: "NONE" },
            "montparnasse_bienvenue": { passengers: 4000, capacity: 9000, air_quality: { co2: 610, pm2_5: 16 }, alert: "NONE" },
        },
        maintenance: {}
    };

    /**
     * Publishes telemetry data for trains and stations.
     */
    function publishSensorData() {
        const now_iso = new Date().toISOString();

        // --- 1. Update and Publish Train Data ---
        for (const [trainId, train] of Object.entries(simState.trains)) {
            
            if (train.status === "RUNNING") {
                // Simulate movement
                train.speed = randomBetween(40, 70);
                train.passengers += randomBetween(-5, 5);
                
                // 30% chance to arrive at next station
                if (Math.random() < 0.3) {
                    const stations = lineStations[train.line];
                    const currentIdx = stations.indexOf(train.position_station_id);
                    
                    let nextIdx = currentIdx + train.direction;
                    // Handle terminus
                    if (nextIdx >= stations.length) {
                        nextIdx = stations.length - 1;
                        train.direction = -1; // Change direction
                    }
                    if (nextIdx < 0) {
                        nextIdx = 0;
                        train.direction = 1; // Change direction
                    }
                    
                    train.position_station_id = stations[nextIdx];
                    train.status = "STOPPED_STATION";
                    train.speed = 0;
                    train.passengers += randomBetween(10, 50); // People get on
                }
            } else if (train.status === "STOPPED_STATION") {
                // 70% chance to depart
                if (Math.random() < 0.7) {
                    train.status = "RUNNING";
                    train.passengers -= randomBetween(10, 40); // People get off
                }
            }
            // else (e.g., "CANCELLED", "MAINTENANCE"), do nothing

            train.passengers = Math.max(20, Math.min(train.capacity, train.passengers));
            
            const payload = {
                ...train,
                occupancy_percent: parseFloat((train.passengers / train.capacity * 100).toFixed(1)),
                emitted_at: now_iso
            };
            // Topic format: ratp/uns/line/<L>/train/<ID>/telemetry
            publish(`ratp/uns/line/${train.line}/train/${trainId}/telemetry`, JSON.stringify(payload), false);
        }
        
        // --- 2. Update and Publish Station Data ---
        for (const [stationId, station] of Object.entries(simState.stations)) {
            station.passengers += randomBetween(-50, 50);
            station.passengers = Math.max(100, Math.min(station.capacity, station.passengers));
            
            station.air_quality.co2 = Math.max(400, station.air_quality.co2 + randomBetween(-10, 10));
            station.air_quality.pm2_5 = Math.max(5, station.air_quality.pm2_5 + randomBetween(-1, 1, 1));
            
            const payload = {
                ...station,
                occupancy_percent: parseFloat((station.passengers / station.capacity * 100).toFixed(1)),
                emitted_at: now_iso
            };
            // Topic format: ratp/uns/station/<ID>/telemetry
            publish(`ratp/uns/station/${stationId}/telemetry`, JSON.stringify(payload), false);
        }
    }
    
    /**
     * The narrative (LF) scenario for the Paris Métro
     */
    const scenario = [
        // 1. All nominal
        () => { 
            logger.info("[ParisMetroSim] All lines nominal.");
            simState.lines["1"].status = "OK"; simState.lines["1"].message = "Trafic normal";
            simState.lines["2"].status = "OK"; simState.lines["2"].message = "Trafic normal";
            simState.lines["6"].status = "OK"; simState.lines["6"].message = "Trafic normal";
            simState.stations["barbes-rochechouart"].alert = "NONE";
            publish(`ratp/uns/line/1/status`, JSON.stringify(simState.lines["1"]), false);
            publish(`ratp/uns/line/2/status`, JSON.stringify(simState.lines["2"]), false);
            publish(`ratp/uns/line/6/status`, JSON.stringify(simState.lines["6"]), false);
            publish(`ratp/uns/station/barbes-rochechouart/alert`, JSON.stringify({ type: "NONE" }), false);
            return { topic: 'ratp/uns/network/status', payload: { global_status: "OK", incidents_active: 0 } }; 
        },
        // 2. Passenger Incident on Line 6
        () => { 
            logger.warn("[ParisMetroSim] Passenger incident on Line 6 (Montparnasse)");
            simState.lines["6"].status = "PERTURBED";
            simState.lines["6"].message = "Incident voyageur à Montparnasse";
            simState.trains["MP73-64"].status = "STOPPED_EMERGENCY";
            publish(`ratp/uns/line/6/status`, JSON.stringify(simState.lines["6"]), false);
            return { topic: 'ratp/uns/alert/incident', payload: { type: "PASSENGER_INCIDENT", line: "6", station_id: "line6_gare_montparnasse_bienvenue", severity: "MEDIUM" } }; 
        },
        // 3. Pickpocket Alert at Barbès-Rochechouart (Line 2)
        () => {
            logger.warn("[ParisMetroSim] Pickpocket alert at Barbès-Rochechouart");
            simState.stations["barbes-rochechouart"].alert = "PICKPOCKET";
            // This topic maps to <text id="ratp-uns-station-barbes-rochechouart-alert">
            publish(`ratp/uns/station/barbes-rochechouart/alert`, JSON.stringify({ type: "PICKPOCKET", status: "ACTIVE", area: "Quai Ligne 2" }), false);
            return { topic: 'ratp/uns/alert/security', payload: { type: "PICKPOCKET", station_id: "line2_gare_barbes-rochechouart", severity: "LOW" } };
        },
        // 4. Return to normal for Line 6
        () => { 
            logger.info("[ParisMetroSim] Line 6 incident cleared");
            simState.lines["6"].status = "OK";
            simState.lines["6"].message = "Trafic normal";
            simState.trains["MP73-64"].status = "RUNNING"; // Restart train
            publish(`ratp/uns/line/6/status`, JSON.stringify(simState.lines["6"]), false);
            return { topic: 'ratp/uns/alert/incident', payload: { type: "PASSENGER_INCIDENT", line: "6", station_id: "line6_gare_montparnasse_bienvenue", severity: "CLEAR" } }; 
        },
        // 5. Start Maintenance (CMMS) on Line 1 (Night work)
        () => {
            logger.info("[ParisMetroSim] Starting track work on Line 1");
            simState.lines["1"].status = "PERTURBED";
            simState.lines["1"].message = "Travaux de nuit (vitesse réduite)";
            simState.maintenance["WO-L1-451"] = { line: "1", location: "Châtelet - Gare de Lyon", description: "Contrôle des voies", status: "IN_PROGRESS" };
            publish(`ratp/uns/line/1/status`, JSON.stringify(simState.lines["1"]), false);
            return { topic: 'ratp/uns/maintenance/workorder', payload: { ...simState.maintenance["WO-L1-451"], wo_id: "WO-L1-451" } };
        },
        // 6. Power Outage on Line 2
        () => {
            logger.error("[ParisMetroSim] Power outage on Line 2!");
            simState.lines["2"].status = "INTERRUPTED";
            simState.lines["2"].message = "Panne électrique";
            simState.trains["MF01-25"].status = "CANCELLED"; // Train stopped mid-track
            publish(`ratp/uns/line/2/status`, JSON.stringify(simState.lines["2"]), false);
            return { topic: 'ratp/uns/alert/power', payload: { status: "DOWN", line: "2", area: "Anvers - La Chapelle" } };
        },
        // 7. Security Alert - People on tracks (Line 6)
        () => {
            logger.error("[ParisMetroSim] People on tracks Line 6!");
            simState.lines["6"].status = "INTERRUPTED";
            simState.lines["6"].message = "Personnes sur les voies";
            simState.trains["MP73-61"].status = "STOPPED_EMERGENCY";
            simState.trains["MP73-64"].status = "STOPPED_EMERGENCY";
            publish(`ratp/uns/line/6/status`, JSON.stringify(simState.lines["6"]), false);
            return { topic: 'ratp/uns/alert/incident', payload: { type: "PERSON_ON_TRACK", line: "6", station_id: "line6_gare_bir-hakeim_tour_eiffel", severity: "CRITICAL" } };
        },
        // 8. Restore power on Line 2
        () => {
            logger.info("[ParisMetroSim] Power restored on Line 2");
            simState.lines["2"].status = "OK";
            simState.lines["2"].message = "Trafic normal";
            simState.trains["MF01-25"].status = "RUNNING"; // Train restarts
            publish(`ratp/uns/line/2/status`, JSON.stringify(simState.lines["2"]), false);
            return { topic: 'ratp/uns/alert/power', payload: { status: "UP", line: "2", area: "Anvers - La Chapelle" } };
        },
        // 9. Clear security alert Line 6
        () => {
            logger.info("[ParisMetroSim] Line 6 tracks clear");
            simState.lines["6"].status = "OK";
            simState.lines["6"].message = "Trafic normal";
            simState.trains["MP73-61"].status = "RUNNING";
            simState.trains["MP73-64"].status = "RUNNING";
            publish(`ratp/uns/line/6/status`, JSON.stringify(simState.lines["6"]), false);
            return { topic: 'ratp/uns/alert/incident', payload: { type: "PERSON_ON_TRACK", line: "6", station_id: "line6_gare_bir-hakeim_tour_eiffel", severity: "CLEAR" } };
        },
        // 10. Clear pickpocket alert
        () => {
            logger.info("[ParisMetroSim] Pickpocket alert cleared at Barbès");
            simState.stations["barbes-rochechouart"].alert = "NONE";
            publish(`ratp/uns/station/barbes-rochechouart/alert`, JSON.stringify({ type: "PICKPOCKET", status: "CLEAR" }), false);
            return { topic: 'ratp/uns/alert/security', payload: { type: "PICKPOCKET", station_id: "line2_gare_barbes-rochechouart", severity: "CLEAR" } };
        },
        // 11. End Maintenance Line 1
        () => {
            logger.info("[ParisMetroSim] Line 1 maintenance complete");
            simState.lines["1"].status = "OK";
            simState.lines["1"].message = "Trafic normal";
            simState.maintenance["WO-L1-451"].status = "COMPLETED";
            publish(`ratp/uns/line/1/status`, JSON.stringify(simState.lines["1"]), false);
            return { topic: 'ratp/uns/maintenance/workorder', payload: { ...simState.maintenance["WO-L1-451"], wo_id: "WO-L1-451" } };
        },
    ];
    
    // --- Public Methods ---
    
    function start() {
        if (narrativeInterval) return; // Already running

        logger.info("[ParisMetroSim] Publishing static capacity data...");
        // Publish static config data
        for (const [trainId, train] of Object.entries(simState.trains)) {
            publish(`ratp/uns/line/${train.line}/train/${trainId}/config`, JSON.stringify({ capacity: train.capacity, model: trainId.split('-')[0] }), false);
        }
        for (const [stationId, station] of Object.entries(simState.stations)) {
            publish(`ratp/uns/station/${stationId}/config`, JSON.stringify({ capacity: station.capacity, location: stationId.replace('_', ' ') }), false);
        }

        // Start NARRATIVE loop (slow)
        logger.info(`[ParisMetroSim] Starting NARRATIVE loop. Publishing every ${NARRATIVE_INTERVAL_MS / 1000}s.`);
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
        logger.info(`[ParisMetroSim] Starting SENSOR loop. Publishing every ${SENSOR_INTERVAL_MS / 1000}s.`);
        sensorInterval = setInterval(publishSensorData, SENSOR_INTERVAL_MS);
        publishSensorData(); // Publish once immediately
    }
    
    function stop() {
        let stopped = false;
        if (narrativeInterval) {
            logger.info("[ParisMetroSim] Stopping narrative loop.");
            clearInterval(narrativeInterval);
            narrativeInterval = null;
            stopped = true;
        }
        if (sensorInterval) {
            logger.info("[ParisMetroSim] Stopping sensor loop.");
            clearInterval(sensorInterval);
            sensorInterval = null;
            stopped = true;
        }

        // Reset state
        simState.step = 0;
        simState.global_status = "STOPPED";
        logger.info("[ParisMetroSim] Simulator stopped and reset.");
        return stopped;
    }

    // Return the public interface
    return {
        start,
        stop
    };
};