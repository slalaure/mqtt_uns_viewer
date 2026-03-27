/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Simulation Scenario: Air Liquide ALAT (Sassenage)
 * Focus: Exact Occupancy Curve & Robust Performance
 */
module.exports = (logger, publish, isSparkplugEnabled) => {
    let loopInterval = null;
    
    // Modification : passage de 10000ms à 5000ms pour doubler la vitesse de la simulation
    const TICK_RATE_MS = 5000; 
    
    const randomBetween = (min, max, decimals = 2) => parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const BUILDINGS = [
        "Euler", "Johnson", "Joule", "Valier", "Lavoisier", 
        "Mendeleiev", "Fourier", "Kapitsa", "Janssen", "Lamarr", 
        "Curie", "Kelvin", "Grove", "Neel", "Cavendish"
    ];
    const FAKE_NAMES = ["J. Dupont", "M. Martin", "S. Petit", "L. Richard", "A. Moreau"];
    // Répartition de la population par bâtiment
    const BLDG_WEIGHTS = {
        "Euler": 0.22, "Johnson": 0.15, "Lavoisier": 0.05, 
        "Mendeleiev": 0.10, "Joule": 0.08, "Valier": 0.05, "Kapitsa": 0.04,
        "Fourier": 0.04, "Janssen": 0.04, "Lamarr": 0.04, "Curie": 0.03, 
        "Kelvin": 0.01, "Grove": 0.01, "Neel": 0.03, "Cavendish": 0.11
    };
    let simState = {
        tick: 0,
        virtualTime: new Date().setHours(5, 0, 0, 0),
        occupancy: { site_total: 6, parking_p_level: 0, buildings: {} },
        meters: { site_total: { elec_kwh: 450120, gas_m3: 89000, water_m3: 12050 }, buildings: {} },
        workPermits: {
            "WP-HEIGHT-01": { 
                company: "ToitSecur", task: "Réfection Gouttière", zone: "Lavoisier", type: "HEIGHT", 
                worker: "M. Martin", status: "ACTIVE" 
            },
            "WP-GAS-04": { 
                company: "AirGas Log", task: "Livraison H2", zone: "Joule", type: "HAZMAT", 
                worker: "Chauffeur L.", status: "ARRIVING" 
            },
            "WP-ELEC-09": { 
                company: "ElecMaint", task: "Maint. Barrière", zone: "Kelvin", type: "ELECTRICAL", 
                worker: "Tech. B", status: "ACTIVE" 
            },
            "WP-CCTV-12": { 
                company: "VisioPro", task: "Install Caméra", zone: "Grove", type: "INSTALL", 
                worker: "Tech. J.", status: "WAITING_ACCESS" 
            }
        },
        testZones: { "Euler": false },
        lastAlarms: {} 
    };
    // Init
    BUILDINGS.forEach(b => {
        simState.meters.buildings[b] = { elec_kwh: 0, gas_m3: 0, water_m3: 0 };
        simState.occupancy.buildings[b] = { count: 0, temp: 19.0, co2: 400 };
    });
    // --- LOGIC ---
    function getTargetPopulation(hour) {
        // Courbe spécifique demandée
        if (hour < 6) return 6; // Nuit profonde
        if (hour >= 6 && hour < 7) return 60; // Arrivée matinale
        if (hour >= 7 && hour < 9) { // Montée 7h-9h
            const progress = (hour - 7) / 2; 
            return 60 + (1050 - 60) * progress;
        }
        if (hour >= 9 && hour < 11.5) return 1050 + (Math.random() * 20); // Matin stable
        if (hour >= 11.5 && hour < 14) return 900 + (Math.random() * 20); // Pause Dej (Départs extérieurs?)
        if (hour >= 14 && hour < 16) return 1050 + (Math.random() * 20); // Après-midi stable
        if (hour >= 16 && hour < 17) { // Départ 1
            const progress = (hour - 16);
            return 1050 - (250 * progress); // Vers 800
        }
        if (hour >= 17 && hour < 18) { // Départ 2
            const progress = (hour - 17);
            return 800 - (500 * progress); // Vers 300
        }
        if (hour >= 18 && hour < 19) { // Départ 3
            const progress = (hour - 18);
            return 300 - (240 * progress); // Vers 60
        }
        if (hour >= 19 && hour < 21) { // Soirée
            const progress = (hour - 19) / 2;
            return 60 - (54 * progress); // Vers 6
        }
        return 6; // Nuit
    }
    function updateTimeAndOccupancy() {
        const currentHour = new Date(simState.virtualTime).getHours();
        const isDay = (currentHour >= 7 && currentHour < 19);
        // VITESSE: 1sec réelle = 20min (Jour) / 1h (Nuit)
        const minutesToAdd = isDay ? 20 : 60; 
        simState.virtualTime += minutesToAdd * 60 * 1000;
        const simDate = new Date(simState.virtualTime);
        const hourFloat = simDate.getHours() + (simDate.getMinutes() / 60);
        // 1. Population Cible
        const targetPop = getTargetPopulation(hourFloat);
        // Lissage de la courbe (inertie)
        const currentPop = simState.occupancy.site_total;
        const diff = targetPop - currentPop;
        simState.occupancy.site_total = Math.floor(currentPop + (diff * 0.2));
        // 2. Parking (950 places max)
        // Le parking se remplit un peu avant les gens et se vide un peu après
        let parkingDemand = simState.occupancy.site_total * 0.90; // 90% en voiture
        if (hourFloat > 8 && hourFloat < 9) parkingDemand *= 1.1; // Pic arrivée
        const parkingLevel = Math.min(950, Math.floor(parkingDemand));
        const parkingPct = (parkingLevel / 950) * 100;
        simState.occupancy.parking_p_level = parkingLevel;
        // 3. Répartition Bâtiments
        const isLunch = (hourFloat >= 11.5 && hourFloat < 13.5);
        BUILDINGS.forEach(b => {
            let weight = BLDG_WEIGHTS[b];
            if (isLunch) {
                weight = (b === "Lavoisier") ? 0.55 : weight * 0.45; // Cantine
            }
            simState.occupancy.buildings[b].count = Math.floor(simState.occupancy.site_total * weight);
        });
        return { date: simDate, isDay, hourFloat, parkingPct };
    }
    function runTick() {
        simState.tick++;
        const { date, isDay, hourFloat, parkingPct } = updateTimeAndOccupancy();
        const now_iso = date.toISOString();
        // --- GLOBAL CONTEXT (Every Tick) ---
        publish('ALAT/Sassenage/Site/Context/Simulation/Time', JSON.stringify({ virtual_time: now_iso }), false);
        publish('ALAT/Sassenage/Security/Occupancy/Global_Count', JSON.stringify({ total_people_on_site: simState.occupancy.site_total }), false);
        publish('ALAT/Sassenage/Facilities/Parking/P/Status', JSON.stringify({ fill_rate_pct: parseFloat(parkingPct.toFixed(1)) }), false);
        // --- TIRS RADIO (Euler Only, > 18h) ---
        if (hourFloat >= 18 || hourFloat < 6) {
             // 30% chance of test active at night
             simState.testZones["Euler"] = (Math.random() > 0.7);
        } else {
             simState.testZones["Euler"] = false;
        }
        publish(`ALAT/Sassenage/Euler/Safety/Signaling/Test_Status`, JSON.stringify({ 
            test_in_progress: simState.testZones["Euler"], type: "TIR_RADIO"
        }), false);
        // --- UTILITIES (Cumulative) ---
        // Mise à jour fréquente pour animation fluide
        let totElec = 0, totGas = 0, totWater = 0;
        BUILDINGS.forEach(b => {
            const act = Math.max(1, simState.occupancy.buildings[b].count);
            simState.meters.buildings[b].elec_kwh += act * 0.2;
            simState.meters.buildings[b].water_m3 += act * 0.005;
            totElec += simState.meters.buildings[b].elec_kwh;
            totWater += simState.meters.buildings[b].water_m3;
        });
        // Gaz (Chauffage principalement)
        simState.meters.site_total.gas_m3 += (isDay ? 2 : 5); 
        publish('ALAT/Sassenage/Facilities/Metering/Global/Electricity', JSON.stringify({ index_kwh: Math.floor(totElec) }), false);
        publish('ALAT/Sassenage/Facilities/Metering/Global/Gas', JSON.stringify({ index_m3: Math.floor(simState.meters.site_total.gas_m3) }), false);
        publish('ALAT/Sassenage/Facilities/Metering/Global/Water', JSON.stringify({ index_m3: Math.floor(totWater) }), false);
        // --- HVAC & ALARMS (Every 2 ticks) ---
        if (simState.tick % 2 === 0) {
            BUILDINGS.forEach(b => {
                const count = simState.occupancy.buildings[b].count;
                // Temp: Inertie vers consigne (21 jour, 17 nuit)
                const targetT = isDay ? 21.0 : 17.0;
                let currentT = simState.occupancy.buildings[b].temp;
                currentT += (targetT - currentT) * 0.1 + (count * 0.002) + randomBetween(-0.1, 0.1);
                simState.occupancy.buildings[b].temp = currentT;
                publish(`ALAT/Sassenage/${b}/BMS/HVAC/Ambience/Telemetry`, JSON.stringify({
                    temperature_c: parseFloat(currentT.toFixed(1)),
                    co2_ppm: 400 + (count * 5),
                    occupancy_count: count,
                    hvac_mode: isDay ? "COMFORT" : "ECO"
                }), false);
                // Heartbeat sécurité (Clear alarms)
                publish(`ALAT/Sassenage/${b}/Safety/Alarm/Status`, JSON.stringify({ alarm: "NONE" }), false);
            });
            // Random Alarm Trigger (Rare)
            if (Math.random() > 0.98) {
                const zone = pick(["Kelvin", "Mendeleiev", "Grove", "Euler"]);
                const type = pick(["GAS", "FIRE"]);
                let payload = { alarm: "ACTIVE", type: type };
                if (type === "GAS") payload.gas_type = (zone === "Kelvin") ? "CO" : "H2";
                publish(`ALAT/Sassenage/${zone}/Safety/Alarm/Status`, JSON.stringify(payload), false);
            }
        }
        // --- EVENTS (Access Control, Permits) - Every 4 ticks ---
        if (simState.tick % 4 === 0) {
            // Access Denied Event
            const gate = pick(["Porte_Johnson", "Sas_Euler", "Entree_Sud"]);
            publish(`ALAT/Sassenage/Security/AccessControl/${gate}/Event`, JSON.stringify({
                result: "DENIED",
                reason: Math.random() > 0.5 ? "Zone Restreinte" : "Hors Horaire",
                user: pick(FAKE_NAMES),
                timestamp: now_iso
            }), false);
            // Permit Updates
            const wpKey = pick(Object.keys(simState.workPermits));
            const wp = simState.workPermits[wpKey];
            if(Math.random() > 0.5) wp.status = "ACTIVE"; // Keep them active mostly
            publish(`ALAT/Sassenage/Site/HSE/WorkPermits/${wpKey}/Status`, JSON.stringify({ ...wp }), false);
        }
    }
    function start() {
        if (loopInterval) return;
        logger.info("[ALAT Sim] Starting Scenario...");
        loopInterval = setInterval(runTick, TICK_RATE_MS);
        runTick();
    }
    function stop() {
        if (loopInterval) { clearInterval(loopInterval); loopInterval = null; }
    }
    return { start, stop };
};