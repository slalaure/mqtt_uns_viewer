/**
 * Custom SVG Bindings for Paris Métro Simulation
 *
 * This file is loaded dynamically by view.svg.js when "paris-metro.svg" is selected.
 * It provides custom logic to initialize the map, update elements, and reset the view.
 */

// --- State (Specific to this SVG) ---
let stationCoords = new Map();
let trainElements = new Map();
let stationTextElements = new Map();
let stationTelemetryElements = new Map();

/**
 * Helper to find an element in the SVG.
 * @param {SVGElement} svgRoot - The root <svg> element.
 * @param {string} selector - The CSS selector.
 * @returns {SVGElement | null}
 */
function find(svgRoot, selector) {
    return svgRoot.querySelector(selector);
}

/**
 * Helper to find multiple elements in the SVG.
 * @param {SVGElement} svgRoot - The root <svg> element.
 * @param {string} selector - The CSS selector.
 * @returns {NodeListOf<SVGElement>}
 */
function findAll(svgRoot, selector) {
    return svgRoot.querySelectorAll(selector);
}

/**
 * Called once when the SVG file is first loaded.
 * Used to scan the SVG and cache important element references or coordinates.
 * @param {SVGElement} svgRoot - The root <svg> element.
 */
function initialize(svgRoot) {
    console.log("[Bindings] Initializing Paris Métro Logic...");
    
    // 1. Scan for station coordinates from the <path> elements
    const stationPaths = findAll(svgRoot, 'path[id*="_gare_"]');
    stationCoords.clear();
    
    stationPaths.forEach(path => {
        const id = path.id; // e.g., "line1_gare_chatelet"
        const d = path.getAttribute('d');
        if (!d) return;

        // Extract the first 'm' (moveto) coordinate.
        const match = d.match(/m\s*([\d\.-]+)\s*,\s*([\d\.-]+)/);
        if (match && match[1] && match[2]) {
            let x = parseFloat(match[1]);
            let y = parseFloat(match[2]);
            
            // Account for the <g transform="..."> parent
            const parentGroup = path.closest('g');
            if (parentGroup) {
                const transform = parentGroup.getAttribute('transform');
                if (transform) {
                    const translateMatch = transform.match(/translate\(\s*([\d\.-]+)\s*,?\s*([\d\.-]+)\s*\)/);
                    if (translateMatch) {
                        x += parseFloat(translateMatch[1]);
                        y += parseFloat(translateMatch[2]);
                    }
                }
            }
            stationCoords.set(id, { x, y });
        }
    });
    console.log(`[Bindings] Scanned ${stationCoords.size} metro stations for coordinates.`);

    // 2. Scan for station text elements
    const stationTexts = findAll(svgRoot, 'text[id*="ratp-uns-station-"]');
    stationTextElements.clear();
    stationTexts.forEach(textEl => {
        // e.g., "ratp-uns-station-chatelet-alert"
        const stationId = textEl.id.split('-')[3]; // "chatelet"
        if(stationId) {
            // Store the element itself
            stationTextElements.set(stationId, textEl);
        }
    });
    console.log(`[Bindings] Scanned ${stationTextElements.size} metro station alert texts.`);
    
    // 3. Clear dynamic containers on init
    reset(svgRoot);
}

/**
 * Called when switching to history mode or loading the SVG.
 * Used to remove all dynamically created elements and reset styles.
 * @param {SVGElement} svgRoot - The root <svg> element.
 */
function reset(svgRoot) {
    // Remove dynamically created elements
    trainElements.forEach(trainG => trainG.remove());
    trainElements.clear();
    stationTelemetryElements.forEach(kpiG => kpiG.remove());
    stationTelemetryElements.clear();
    
    // Reset alert text styles
    stationTextElements.forEach(textEl => {
        textEl.classList.remove('alarm-text');
    });
    
    // Reset line path statuses to "OK"
    findAll(svgRoot, 'path[data-key="status"]').forEach(linePath => {
         const baseClass = Array.from(linePath.classList).filter(c => !c.startsWith('line-status-')).join(' ');
         linePath.setAttribute('class', baseClass + ' line-status-OK');
    });
}

/**
 * Called for every single MQTT message.
 * This function routes the message to the correct handler.
 *  Updated signature to accept brokerId as the first argument.
 * @param {string} brokerId - The ID of the broker.
 * @param {string} topic - The MQTT topic.
 * @param {object} payload - The parsed JSON payload.
 * @param {SVGElement} svgRoot - The root <svg> element.
 */
function update(brokerId, topic, payload, svgRoot) {
    // This binding only cares about RATP topics and JSON payloads
    if (typeof payload !== 'object' || !topic.startsWith('ratp/uns/')) return;

    // Note: We ignore brokerId here, assuming the simulation runs on the active broker(s).
    // If you wanted to restrict to a specific broker, you could check: if (brokerId !== 'my_broker') return;

    if (topic.includes('/train/')) {
        updateMetroTrain(topic, payload, svgRoot);
    } else if (topic.includes('/station/') && topic.endsWith('/alert')) {
        updateMetroStationAlert(topic, payload, svgRoot);
    } else if (topic.includes('/station/') && topic.endsWith('/telemetry')) {
        updateMetroStationTelemetry(topic, payload, svgRoot);
    } else if (topic.includes('/line/') && topic.endsWith('/status')) {
        updateMetroLineStatus(topic, payload, svgRoot);
    }
}

// --- Specific Logic Functions ---

/**
 * Creates, updates, and moves a train <g> element on the map.
 */
function updateMetroTrain(topic, data, svgRoot) {
    const parts = topic.split('/');
    const trainId = parts[parts.length - 2]; // e.g., "MP05-01"
    const trainG_Id = `train-g-${trainId}`;
    const stationId = data.position_station_id; // e.g., "line1_gare_chatelet"
    const trainContainer = find(svgRoot, '#train-container');
    if (!trainContainer) {
        console.warn("#train-container not found in SVG");
        return;
    }

    let trainG = trainElements.get(trainG_Id);
    
    // 1. Create train element if it doesn't exist
    if (!trainG) {
        const linePath = find(svgRoot, `path[id="line${data.line}_path"]`);
        const trainColor = linePath ? linePath.getAttribute('stroke') : '#fff';

        trainG = document.createElementNS("http://www.w3.org/2000/svg", "g");
        trainG.id = trainG_Id;
        trainG.setAttribute('style', 'transition: transform 0.8s ease-in-out;');
        
        trainG.innerHTML = `
            <rect class="train-box" x="-150" y="-50" width="300" height="100" rx="3" style="stroke: ${trainColor};" />
            <text class="train-text train-text-id" x="0" y="-25" text-anchor="middle" style="fill: ${trainColor};">${trainId}</text>
            <text class="train-text train-text-label" x="-140" y="5">Driver:</text>
            <text class="train-text train-text-data train-driver" x="-60" y="5">${data.driver}</text>
            <text class="train-text train-text-label" x="-140" y="35">Pax:</text>
            <text class="train-text train-text-data train-passengers" x="-60" y="35">${data.passengers}</text>
            <circle class="train-status-light" cx="135" y="-25" r="8" fill="#fff"/>
        `;
        trainContainer.appendChild(trainG);
        trainElements.set(trainG_Id, trainG);
    }

    // 2. Update position
    const coords = stationCoords.get(stationId);
    if (coords) {
        const x = coords.x;
        const y = coords.y - 70; // 70px above the station circle
        trainG.setAttribute('transform', `translate(${x}, ${y})`);
    } else {
        console.warn(`[Bindings] No coordinates found for station ID: ${stationId}`);
    }

    // 3. Update data
    find(trainG, '.train-driver').textContent = data.driver;
    find(trainG, '.train-passengers').textContent = `${data.passengers} (${data.occupancy_percent}%)`;
    
    // 4. Update status light
    find(trainG, '.train-status-light').setAttribute('class', `train-status-light train-status-${data.status}`);
}

/**
 * Updates a metro line's visual status (color).
 */
function updateMetroLineStatus(topic, data, svgRoot) {
    const parts = topic.split('/');
    const lineNum = parts[parts.length - 2]; // e.g., "1"
    const linePath = find(svgRoot, `path[id="line${lineNum}_path"]`);
    if (linePath) {
        // Find the base classes (e.g., "line-path line-1")
        const baseClass = Array.from(linePath.classList).filter(c => !c.startsWith('line-status-')).join(' ');
        if (data.status === 'OK') linePath.setAttribute('class', baseClass + ' line-status-OK');
        else if (data.status === 'PERTURBED') linePath.setAttribute('class', baseClass + ' line-status-PERTURBED');
        else if (data.status === 'INTERRUPTED') linePath.setAttribute('class', baseClass + ' line-status-INTERRUPTED');
    }
}

/**
 * Updates a station's alert status (blinking text).
 */
function updateMetroStationAlert(topic, data, svgRoot) {
    const parts = topic.split('/');
    const stationId = parts[parts.length - 2]; // e.g., "chatelet"
    const textEl = stationTextElements.get(stationId);
    if (textEl) {
        if (data.type === "NONE" || data.status === "CLEAR") {
            textEl.classList.remove('alarm-text');
        } else {
            textEl.classList.add('alarm-text');
        }
    }
}

/**
 * Creates or updates a station's telemetry data box (occupancy, air quality).
 */
function updateMetroStationTelemetry(topic, data, svgRoot) {
    const parts = topic.split('/');
    const stationId = parts[parts.length - 2]; // e.g., "chatelet"
    const kpiId = `station-kpi-${stationId}`;
    
    let kpiG = stationTelemetryElements.get(kpiId);
    const telemetryContainer = find(svgRoot, '#station-telemetry-container');
    if (!telemetryContainer) {
        console.warn("#station-telemetry-container not found in SVG");
        return;
    }
    
    // 1. Create KPI box if it doesn't exist
    if (!kpiG) {
        // Find the station's <text> element to base coordinates on
        const stationTextEl = stationTextElements.get(stationId);
        if (!stationTextEl) {
             console.warn(`[Bindings] No text element found for station: ${stationId}`);
             return; // Can't place it
        }
        
        const bbox = stationTextEl.getBBox();
        const x = bbox.x + (bbox.width / 2); // Center of the text
        const y = bbox.y + bbox.height + 20; // 20px below the text

        kpiG = document.createElementNS("http://www.w3.org/2000/svg", "g");
        kpiG.id = kpiId;
        kpiG.setAttribute('transform', `translate(${x}, ${y})`);
        
        kpiG.innerHTML = `
            <rect class="kpi-box" x="-100" y="0" width="200" height="90" />
            <text class="train-text train-text-label" x="-90" y="25">Pax:</text>
            <text class="train-text train-text-data kpi-pax" x="0" y="25">0</text>
            <text class="train-text train-text-label" x="-90" y="50">CO2:</text>
            <text class="train-text train-text-data kpi-co2" x="0" y="50">0</text>
            <text class="train-text train-text-label" x="-90" y="75">PM2.5:</text>
            <text class="train-text train-text-data kpi-pm25" x="0" y="75">0</text>
        `;
        telemetryContainer.appendChild(kpiG);
        stationTelemetryElements.set(kpiId, kpiG);
    }
    
    // 2. Update data
    find(kpiG, '.kpi-pax').textContent = `${data.passengers} (${data.occupancy_percent}%)`;
    find(kpiG, '.kpi-co2').textContent = data.air_quality.co2;
    find(kpiG, '.kpi-pm25').textContent = data.air_quality.pm2_5;
}

// --- Register Bindings ---
// This exposes the functions to the main view.svg.js module.
window.registerSvgBindings({
    initialize: initialize,
    update: update,
    reset: reset
});