// Cache DOM lookups
const domCache = new Map();
function getEl(root, id) {
    if (!domCache.has(id)) {
        domCache.set(id, root.getElementById(id));
    }
    return domCache.get(id);
}
const activeAlarms = new Map();
const activePermits = new Map();
window.registerSvgBindings({
  initialize: (svgRoot) => {
    console.log("ALAT Sassenage (Optimized V2) Initialized");
    domCache.clear();
    svgRoot.querySelectorAll('use[id^="icon_"]').forEach(el => el.style.display = 'none');
    activeAlarms.clear();
    activePermits.clear();
    renderAlarmList(svgRoot);
    renderPermitList(svgRoot);
  },
  update: (brokerId, topic, payload, svgRoot) => {
    let data;
    try { data = (typeof payload === 'string') ? JSON.parse(payload) : payload; } catch (e) { return; }
    // GLOBAL KPIs
    if (topic.includes('Simulation/Time')) {
        updateText(svgRoot, 'kpi_time', new Date(data.virtual_time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}));
    }
    if (topic.includes('Occupancy/Global_Count')) updateText(svgRoot, 'kpi_pop', data.total_people_on_site);
    if (topic.includes('Metering/Global/Electricity')) updateText(svgRoot, 'kpi_elec', data.index_kwh);
    if (topic.includes('Metering/Global/Gas')) updateText(svgRoot, 'kpi_gas', data.index_m3);
    if (topic.includes('Metering/Global/Water')) updateText(svgRoot, 'kpi_water', data.index_m3);
    if (topic.includes('Facilities/Parking/P/Status')) {
        updateText(svgRoot, 'kpi_parking_val', data.fill_rate_pct + '%');
        const path = getEl(svgRoot, 'shape_parking_p'); // Updated to standard shape name
        if(path) path.style.fillOpacity = 0.3 + (data.fill_rate_pct/100)*0.7;
    }
    // BUILDINGS
    if (topic.includes('/BMS/HVAC/Ambience/Telemetry')) {
        const parts = topic.split('/');
        const bldg = parts[2].toLowerCase(); 
        if (bldg === 'lavoisier') {
             updateText(svgRoot, 'data_lavoisier_temp', `${data.temperature_c}°C`);
             updateText(svgRoot, 'data_lavoisier_pop', `${data.occupancy_count} p.`);
        } else {
             updateText(svgRoot, `data_${bldg}`, `${data.temperature_c}°C`);
        }
        const shape = getEl(svgRoot, `shape_${bldg}`);
        if (shape && !shape.classList.contains('alarm-critical')) {
            let newColor = '#f8fafc';
            if (data.hvac_mode === 'COMFORT') {
                if (data.temperature_c < 20.5) newColor = '#fff9c4'; 
                else if (data.temperature_c > 22.0) newColor = '#e1bee7'; 
            } else {
                newColor = '#cbd5e1'; 
            }
            if (shape.getAttribute('fill') !== newColor) shape.style.fill = newColor;
        }
    }
    // ALARMS (Consolidation)
    if (topic.includes('/Safety/Alarm/Status')) {
        const parts = topic.split('/');
        const zone = parts[2].toLowerCase();
        const isAlarm = (data.alarm === 'ACTIVE' || data.alarm === 'HIGH');
        const type = data.type || 'ALARM';
        let iconId = null;
        if (type === 'FIRE') iconId = `icon_fire_${zone}`;
        else if (type === 'GAS') iconId = `icon_gas_${zone}`;
        toggleAlarmState(svgRoot, zone, type, isAlarm, iconId);
    }
    // RADIO
    if (topic.includes('/Safety/Signaling/Test_Status')) {
        const parts = topic.split('/');
        const zone = parts[2].toLowerCase(); 
        toggleAlarmState(svgRoot, zone, 'RADIO', data.test_in_progress, `icon_radio_${zone}`);
    }
    // ACCESS CONTROL
    if (topic.includes('/Security/AccessControl/') && data.result === 'DENIED') {
        const gate = topic.split('/')[5].toLowerCase();
        
        // Dynamic building resolution from gate identifier
        const BUILDINGS = ["euler", "johnson", "joule", "valier", "lavoisier", "mendeleiev", "fourier", "kapitsa", "janssen", "lamarr", "curie", "kelvin", "grove", "neel", "cavendish", "parking_p", "iff"];
        let targetBldg = BUILDINGS.find(b => gate.includes(b)) || null;
        
        // Fallbacks for generic gates
        if (!targetBldg && (gate.includes('sud') || gate.includes('principal'))) {
            targetBldg = 'parking_p';
        }

        if (targetBldg) {
            const icon = getEl(svgRoot, `icon_access_${targetBldg}`);
            if (icon) {
                icon.style.display = 'block';
                // Timeout clean
                if (icon.hideTimeout) clearTimeout(icon.hideTimeout);
                icon.hideTimeout = setTimeout(() => icon.style.display = 'none', 3000);
            }
        }
    }
    // PERMITS
    if (topic.includes('/HSE/WorkPermits/')) {
        const wpId = topic.split('/')[5];
        const zone = data.zone.toLowerCase();
        const isActive = (data.status === 'ACTIVE' || data.status === 'ARRIVING');
        const shape = getEl(svgRoot, `shape_${zone}`);
        const icon = getEl(svgRoot, `icon_wp_${zone}`);
        if (shape) {
            if (isActive) shape.classList.add('highlight-wp');
            else shape.classList.remove('highlight-wp');
        }
        if (icon) icon.style.display = isActive ? 'block' : 'none';
        if (data.status === 'CLOSED') activePermits.delete(wpId);
        else activePermits.set(wpId, `<b>${data.zone}</b>: ${data.task} <br/><span style="color:#64748b; font-size:9px;">${data.company}</span>`);
        renderPermitList(svgRoot);
    }
  },
  reset: (svgRoot) => {
    domCache.clear();
    activeAlarms.clear();
    activePermits.clear();
  }
});
function updateText(svgRoot, id, val) {
    const el = getEl(svgRoot, id);
    if (el && el.textContent != val) el.textContent = val;
}
function toggleAlarmState(root, zone, type, isActive, iconId) {
    const shape = getEl(root, `shape_${zone}`);
    const icon = iconId ? getEl(root, iconId) : null;
    const alarmKey = `${zone}_${type}`;
    if (isActive) {
        if(shape) shape.classList.add('alarm-critical');
        if(icon) icon.style.display = 'block';
        activeAlarms.set(alarmKey, `${type} @ ${zone.toUpperCase()}`);
    } else {
        activeAlarms.delete(alarmKey);
        // Only clear if no other alarm for this zone
        const hasOther = Array.from(activeAlarms.keys()).some(k => k.startsWith(zone + '_'));
        if (!hasOther) {
            if(shape) shape.classList.remove('alarm-critical');
            if(icon) icon.style.display = 'none';
        }
    }
    renderAlarmList(root);
}
function renderAlarmList(root) {
    const list = getEl(root, 'alarm_list_html');
    const banner = getEl(root, 'bg_global_alarm');
    const txt = getEl(root, 'kpi_alarms');
    // Safety check to avoid spamming innerHTML
    if (!list || !banner || !txt) return;
    // Use a diff check if possible, or just simple rewrite (fast enough for 5 items)
    if (activeAlarms.size === 0) {
        if (txt.textContent !== "SÉCURITÉ SITE NOMINALE") {
            list.innerHTML = '<li style="color:#64748b; font-weight:normal;">Aucune alarme</li>';
            banner.setAttribute('fill', '#f0fdf4');
            banner.setAttribute('stroke', '#16a34a');
            txt.textContent = "SÉCURITÉ SITE NOMINALE";
            txt.setAttribute('fill', '#166534');
        }
    } else {
        let html = '';
        activeAlarms.forEach(val => { html += `<li>${val}</li>`; });
        if (list.innerHTML !== html) list.innerHTML = html;
        banner.setAttribute('fill', '#fef2f2');
        banner.setAttribute('stroke', '#dc2626');
        txt.textContent = `⚠️ ${activeAlarms.size} ALARME(S) EN COURS`;
        txt.setAttribute('fill', '#dc2626');
    }
}
function renderPermitList(root) {
    const ul = getEl(root, 'wp_list_html');
    if (!ul) return;
    let html = '';
    if (activePermits.size === 0) html = '<li>Aucun permis</li>';
    else activePermits.forEach(val => html += `<li>${val}</li>`);
    if (ul.innerHTML !== html) ul.innerHTML = html;
}