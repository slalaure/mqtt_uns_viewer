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

// Import shared utilities
import { formatTimestampForLabel, trackEvent } from './utils.js';
import { createSingleTimeSlider } from './time-slider.js';

// --- DOM Element Querying ---
const svgContent = document.getElementById('svg-content');
const svgHistoryToggle = document.getElementById('svg-history-toggle');
const svgTimelineSlider = document.getElementById('svg-timeline-slider-container');
const svgHandle = document.getElementById('svg-handle');
const svgLabel = document.getElementById('svg-label');
const btnSvgFullscreen = document.getElementById('btn-svg-fullscreen');
const mapView = document.getElementById('map-view');
const svgSelectDropdown = document.getElementById('svg-select-dropdown');

// --- Module-level State ---
let svgInitialTextValues = new Map();
let allHistoryEntries = [];
let isSvgHistoryMode = false;
let currentMinTimestamp = 0;
let currentMaxTimestamp = 0;
let svgSlider = null; 

// [NEW] State for Paris Métro SVG
let stationCoords = new Map(); // Stores {x, y} for each station_id
let trainElements = new Map(); // Stores SVG <g> elements for trains
let stationTextElements = new Map(); // Stores SVG <text> elements for station alerts
let stationTelemetryElements = new Map(); // Stores SVG <g> for dynamic station KPIs
let currentSvgId = ""; // ID of the currently loaded SVG
// ---

/**
 * Initializes the SVG View functionality.
 */
export function initSvgView(appConfig) {
    populateSvgListAndLoadDefault(appConfig.svgFilePath);
    
    btnSvgFullscreen?.addEventListener('click', toggleFullscreen);

    svgHistoryToggle?.addEventListener('change', (e) => {
        isSvgHistoryMode = e.target.checked;
        if (svgTimelineSlider) svgTimelineSlider.style.display = isSvgHistoryMode ? 'flex' : 'none';
        
        trackEvent(isSvgHistoryMode ? 'svg_history_on' : 'svg_history_off');
        replaySvgHistory(currentMaxTimestamp);

        if (svgSlider) {
            svgSlider.updateUI(currentMinTimestamp, currentMaxTimestamp, currentMaxTimestamp);
        }
    });

    if (svgHandle) {
        svgSlider = createSingleTimeSlider({
            containerEl: svgTimelineSlider,
            handleEl: svgHandle,
            labelEl: svgLabel,
            onDrag: (newTime) => {
                replaySvgHistory(newTime);
            },
            onDragEnd: (newTime) => {
                trackEvent('svg_slider_drag_end');
            }
        });
    }  
}

/**
 * Receives the full history log from the main app.
 */
export function setSvgHistoryData(entries) {
    allHistoryEntries = entries;
}

/**
 * Fetches the list of SVGs, populates the dropdown, and loads the default.
 */
async function populateSvgListAndLoadDefault(defaultSvgFile) {
    if (!svgSelectDropdown) return;
    
    let defaultFileFound = false;
    try {
        const response = await fetch('api/svg/list');
        if (!response.ok) throw new Error('Failed to fetch SVG list');
        
        const svgFiles = await response.json();
        
        svgSelectDropdown.innerHTML = '';
        if (svgFiles.length === 0) {
            svgSelectDropdown.innerHTML = '<option value="">No SVGs found</option>';
        }

        svgFiles.forEach(filename => {
            const option = document.createElement('option');
            option.value = filename;
            option.textContent = filename;
            if (filename === defaultSvgFile) {
                option.selected = true;
                defaultFileFound = true;
            }
            svgSelectDropdown.appendChild(option);
        });
        
        if (!defaultFileFound && svgFiles.length > 0) {
            svgSelectDropdown.value = svgFiles[0];
            defaultSvgFile = svgFiles[0];
        }

    } catch (error) {
        console.error("Could not populate SVG list:", error);
        svgSelectDropdown.innerHTML = `<option value="">Error loading list</option>`;
    }

    svgSelectDropdown.addEventListener('change', onSvgFileChange);
    
    if (defaultSvgFile) {
        await loadSvgPlan(defaultSvgFile);
    } else {
        svgContent.innerHTML = `<p style="color: red; padding: 20px;">Error: No SVG files found in the /data directory.</p>`;
    }
}

/**
 * Handles the change event when a new SVG is selected.
 */
async function onSvgFileChange(event) {
    const filename = event.target.value;
    if (!filename) return;
    
    trackEvent('svg_file_change');
    await loadSvgPlan(filename);
}


/**
 * [MODIFIED] Loads a specific view.svg file from the server.
 * Now resets and scans the SVG.
 */
async function loadSvgPlan(filename) {
    if (!filename) {
        svgContent.innerHTML = `<p style="color: red; padding: 20px;">Error: No SVG file selected.</p>`;
        return;
    }
    
    try {
        const response = await fetch(`api/svg/file?name=${encodeURIComponent(filename)}`); 
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const svgText = await response.text();
        if (svgContent) {
            svgContent.innerHTML = svgText;
            
            // --- [MODIFIED] Clear state and scan new SVG ---
            svgInitialTextValues.clear();
            stationCoords.clear();
            trainElements.clear();
            stationTextElements.clear();
            stationTelemetryElements.clear();

            const svgRoot = svgContent.querySelector('svg');
            currentSvgId = svgRoot ? svgRoot.id : "";

            // Scan for data-keys and static elements
            const dataElements = svgContent.querySelectorAll('[data-key]');
            
            dataElements.forEach(el => {
                if (el.tagName === 'text' || el.tagName === 'tspan') {
                    svgInitialTextValues.set(el, { type: 'text', value: el.textContent });
                } else if (el.id === 'shield-visual-effect') {
                    svgInitialTextValues.set(el, { type: 'attr', attr: 'stroke-opacity', value: el.getAttribute('stroke-opacity') });
                    svgInitialTextValues.set(el, { type: 'attr', attr: 'stroke-width', value: el.getAttribute('stroke-width') });
                } else if (el.id === 'laser-charge-visual') {
                    svgInitialTextValues.set(el, { type: 'attr', attr: 'width', value: el.getAttribute('width') });
                } else if (el.tagName === 'path' && (el.dataset.key === 'status')) {
                    // [MODIFIED] Save class for metro lines
                    svgInitialTextValues.set(el, { type: 'attr', attr: 'class', value: el.getAttribute('class') });
                } else if (el.tagName === 'circle' && el.dataset.key === 'occupancy_percent') {
                    svgInitialTextValues.set(el, { type: 'attr', attr: 'fill-opacity', value: el.getAttribute('fill-opacity') });
                }
            });

            // Special logic for Paris Métro map
            if (currentSvgId === 'ParisMetroTacticalMap') {
                scanParisMetroSVG();
            }
            
            const replayTime = isSvgHistoryMode 
                ? parseFloat(svgHandle.dataset.timestamp || currentMaxTimestamp) 
                : currentMaxTimestamp;
            replaySvgHistory(replayTime);
        }
    } catch (error) {
        console.error(`Could not load the SVG file '${filename}':`, error);
        if (svgContent) svgContent.innerHTML = `<p style="color: red; padding: 20px;">Error: The SVG file '${filename}' could not be loaded.</p>`;
    }
}

/**
 * [NEW] Scans the loaded Paris Métro SVG to find station coordinates and text elements.
 */
function scanParisMetroSVG() {
    // 1. Scan for station coordinates using the <path> elements
    const stationPaths = svgContent.querySelectorAll('path[id*="_gare_"]');
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
    console.log(`[SVG] Scanned ${stationCoords.size} metro stations for coordinates.`);

    // 2. Scan for station text elements
    const stationTexts = svgContent.querySelectorAll('text[id*="ratp-uns-station-"]');
    stationTextElements.clear();
    stationTexts.forEach(textEl => {
        // e.g., "ratp-uns-station-chatelet-alert"
        const stationId = textEl.id.split('-')[3]; // "chatelet"
        if(stationId) {
            // Store the element itself
            stationTextElements.set(stationId, textEl);
            // Save its initial class
            svgInitialTextValues.set(textEl, { type: 'attr', attr: 'class', value: textEl.getAttribute('class') || '' });
        }
    });
    console.log(`[SVG] Scanned ${stationTextElements.size} metro station alert texts.`);
    
    // 3. Scan for line path elements (now by data-key)
    const linePaths = svgContent.querySelectorAll('path[data-key="status"]');
    linePaths.forEach(pathEl => {
         svgInitialTextValues.set(pathEl, { type: 'attr', attr: 'class', value: pathEl.getAttribute('class') || '' });
    });
}


/**
 * Toggles fullscreen mode for the SVG map view.
 */
function toggleFullscreen() {
    trackEvent('svg_fullscreen_toggle');
    if (!mapView) return;
    
    if (!document.fullscreenElement) {
        mapView.requestFullscreen().catch(err => {
            console.error(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
        });
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        }
    }
}

/**
 * [HELPER] Safely gets a nested value from an object.
 */
function getNestedValue(obj, path) {
    if (typeof path !== 'string' || !obj) return null;
    return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : null), obj);
}

/**
 * [MODIFIED] Checks if a value triggers an alarm. Now supports 'EQ' (equals).
 */
function checkAlarm(currentValue, alarmType, alarmThreshold) {
    if (alarmType === 'EQ') {
        return String(currentValue) === String(alarmThreshold);
    }
    if (alarmType === 'NEQ') {
        return String(currentValue) !== String(alarmThreshold);
    }

    const value = parseFloat(currentValue);
    const threshold = parseFloat(alarmThreshold);
    if (isNaN(value) || isNaN(threshold)) return false;

    switch (alarmType) {
        case 'H': return value > threshold;
        case 'L': return value < threshold;
        default: return false;
    }
}

function updateAlarmPlaceholder() {
    // This function is not used in the metro map
}

/**
 * [MODIFIED] Updates a single SVG element with a new value.
 */
function updateSvgElement(el, keyPath, value) {
    // --- 1. SPECIAL VISUALS (by ID or data-key) ---
    const numericValue = parseFloat(value);
    
    // A. Death Star Shield Effect
    if (el.id === 'shield-visual-effect' && keyPath === 'power' && !isNaN(numericValue)) {
        const opacity = Math.max(0, Math.min(1, (numericValue / 100.0) * 0.7 + 0.1));
        const width = 2 + (numericValue / 100.0) * 8;
        el.setAttribute('stroke-opacity', opacity.toFixed(2));
        el.setAttribute('stroke-width', width.toFixed(2));
        return; // Handled
    }
    
    // B. Death Star Laser Charge Effect
    if (el.id === 'laser-charge-visual' && keyPath === 'value' && !isNaN(numericValue)) {
        const maxWidth = 140; // Max width in SVG
        const chargeWidth = Math.max(0, (numericValue / 100.0) * maxWidth);
        el.setAttribute('width', chargeWidth.toFixed(2));
        return; // Handled
    }
    
    // C. Paris Métro Line Status (Path)
    if (el.tagName === 'path' && keyPath === 'status') {
        // Find the base classes (e.g., "line-path line-1")
        const baseClass = Array.from(el.classList).filter(c => !c.startsWith('line-status-')).join(' ');
        if (value === 'OK') el.setAttribute('class', baseClass + ' line-status-OK');
        else if (value === 'PERTURBED') el.setAttribute('class', baseClass + ' line-status-PERTURBED');
        else if (value === 'INTERRUPTED') el.setAttribute('class', baseClass + ' line-status-INTERRUPTED');
        return; // Handled
    }
    
    // D. Paris Métro Station Occupancy (Circle)
    if (el.tagName === 'circle' && keyPath === 'occupancy_percent' && !isNaN(numericValue)) {
        const opacity = Math.max(0.1, Math.min(1, (numericValue / 100.0) * 0.8 + 0.1));
        el.setAttribute('fill-opacity', opacity.toFixed(2));
    }
    
    
    // --- 2. TEXT COLOR (by keyPath or value) ---
    if (el.tagName === 'text' || el.tagName === 'tspan') {
        let isStatus = false;
        
        // Colorize based on alert level
        if (keyPath === 'alert_level' || keyPath === 'global_status') {
            isStatus = true;
            if (value === 'red' || value === 'INTERRUPTED') el.setAttribute('fill', '#f85149');
            else if (value === 'yellow' || value === 'PERTURBED') el.setAttribute('fill', '#d29922');
            else el.setAttribute('fill', '#58a6ff'); // Blue for OK/green
        }
        // Colorize based on common status keywords
        else if (keyPath.includes('status') || keyPath === 'metrics[Status]') {
            isStatus = true;
            const v = String(value).toLowerCase();
            if (v === 'damaged' || v === 'offline' || v === 'breached' || v === 'error' || v === 'stopped_emergency' || v === 'cancelled' || v.includes('interrupted')) {
                el.setAttribute('fill', '#f85149'); // Red
            } else if (v === 'online' || v === 'empty' || v === 'green' || v === 'clear' || v === 'patrol' || v === 'ok' || v === 'running') {
                el.setAttribute('fill', '#3fb950'); // Green
            } else {
                el.setAttribute('fill', '#d29922'); // Yellow for 'standby', 'charging', 'transit', 'perturbed', 'stopped_station' etc.
            }
        }
        
        // Animate red status text
        if (el.getAttribute('fill') === '#f85149' && !el.classList.contains('text-data')) {
            el.classList.add('alarm-text'); 
        } else {
            el.classList.remove('alarm-text');
        }

        // --- 3. DEFAULT TEXT UPDATE ---
        if (typeof value === 'number' && !Number.isInteger(value)) {
            el.textContent = parseFloat(value).toFixed(2);
        } else {
            el.textContent = value;
        }
    }
    
    // --- 4. ALARM LINE (Alarm check) ---
    const alarmType = el.dataset.alarmType;
    const alarmValue = el.dataset.alarmValue;
    
    if (alarmType && alarmValue) {
        const alarmLineGroup = el.closest('.alarm-line');
        if (alarmLineGroup) {
            const isAlarm = checkAlarm(value, alarmType, alarmValue);
            alarmLineGroup.style.visibility = isAlarm ? 'visible' : 'hidden';
        } else {
             const isAlarm = checkAlarm(value, alarmType, alarmValue);
             el.style.visibility = isAlarm ? 'visible' : 'hidden';
        }
    }
}


/**
 * [MODIFIED] Main update router function.
 * @param {string} topic - The MQTT topic.
 * @param {string} payload - The message payload.
 */
export function updateMap(topic, payload) {
    if (svgHistoryToggle?.checked) return;
    if (!svgContent) return;

    try {
        const data = JSON.parse(payload); 
        
        // --- [NEW] Paris Métro Logic ---
        if (currentSvgId === 'ParisMetroTacticalMap' && topic.startsWith('ratp/uns/')) {
            
            if (topic.includes('/train/')) {
                updateMetroTrain(topic, data); // Handles train logic
            } else if (topic.includes('/station/') && topic.endsWith('/alert')) {
                updateMetroStationAlert(topic, data); // Handles station alerts
            } else if (topic.includes('/station/') && topic.endsWith('/telemetry')) {
                updateMetroStationTelemetry(topic, data); // Handles station KPIs
            } else if (topic.includes('/line/') && topic.endsWith('/status')) {
                updateMetroLineStatus(topic, data); // Handles line status
            } else {
                // Handle other ratp/uns/ topics if needed (e.g., global status)
                 const svgId = topic.replace(/\//g, '-').replace(/_/g, '-');
                 defaultUpdateLogic(svgId, data);
            }
            return; // Handled
        }
        // --- [End New Logic] ---
        
        // --- Default Logic (Death Star, etc.) ---
        const svgId = topic.replace(/\//g, '-');
        defaultUpdateLogic(svgId, data);

    } catch (e) { 
        console.warn("SVG updateMap error:", e);
    }
}

/**
 * [NEW] Default handler for simple id-to-data-key mapping.
 * @param {string} svgId - The SVG element ID (topic with dashes).
 * @param {object} data - The parsed payload.
 */
function defaultUpdateLogic(svgId, data) {
    const groupElements = svgContent.querySelectorAll(`[id="${svgId}"]`);
    if (groupElements.length === 0) return;

    groupElements.forEach(groupElement => {
        const dataElements = groupElement.querySelectorAll('[data-key]');
        
        dataElements.forEach(el => {
            const keyPath = el.dataset.key; 
            const value = getNestedValue(data, keyPath);
            
            if (value !== null && value !== undefined) {
                updateSvgElement(el, keyPath, value);
            }
        });
        
        groupElement.classList.add('highlight-svg');
        setTimeout(() => groupElement.classList.remove('highlight-svg'), 500);
    });
    
    // updateAlarmPlaceholder(); // Not used by Metro
}


/**
 * [NEW] Updates a single train element on the Paris Métro map.
 */
function updateMetroTrain(topic, data) {
    const parts = topic.split('/');
    const trainId = parts[parts.length - 2]; // e.g., "MP05-01"
    const trainG_Id = `train-g-${trainId}`;
    const stationId = data.position_station_id; // e.g., "line1_gare_chatelet"
    const trainContainer = svgContent.querySelector('#train-container');
    if (!trainContainer) {
        console.warn("#train-container not found in SVG");
        return;
    }

    let trainG = trainElements.get(trainG_Id);
    
    // 1. Create train element if it doesn't exist
    if (!trainG) {
        const linePath = svgContent.querySelector(`path[id="line${data.line}_path"]`);
        const trainColor = linePath ? linePath.getAttribute('stroke') : '#fff';

        trainG = document.createElementNS("http://www.w3.org/2000/svg", "g");
        trainG.id = trainG_Id;
        trainG.setAttribute('style', 'transition: transform 0.8s ease-in-out;'); // CSS transition
        
        // [MODIFIED] Scaled up elements for large viewBox
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
        // [MODIFIED] Scaled up offset
        const x = coords.x;
        const y = coords.y - 70; // 70px above the station circle
        trainG.setAttribute('transform', `translate(${x}, ${y})`);
    } else {
        console.warn(`[SVG] No coordinates found for station ID: ${stationId}`);
    }

    // 3. Update data
    trainG.querySelector('.train-driver').textContent = data.driver;
    trainG.querySelector('.train-passengers').textContent = `${data.passengers} (${data.occupancy_percent}%)`;
    
    // 4. Update status light
    const statusLight = trainG.querySelector('.train-status-light');
    statusLight.setAttribute('class', `train-status-light train-status-${data.status}`);
}

/**
 * [NEW] Updates a metro line's visual status.
 */
function updateMetroLineStatus(topic, data) {
    const parts = topic.split('/');
    const lineNum = parts[parts.length - 2]; // e.g., "1"
    const linePath = svgContent.querySelector(`path[id="line${lineNum}_path"]`);
    if (linePath) {
        updateSvgElement(linePath, 'status', data.status);
    }
}

/**
 * [NEW] Updates a station's alert status.
 */
function updateMetroStationAlert(topic, data) {
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
 * [NEW] Updates a station's telemetry data (occupancy, air).
 */
function updateMetroStationTelemetry(topic, data) {
    const parts = topic.split('/');
    const stationId = parts[parts.length - 2]; // e.g., "chatelet"
    const kpiId = `station-kpi-${stationId}`;
    
    let kpiG = stationTelemetryElements.get(kpiId);
    const telemetryContainer = svgContent.querySelector('#station-telemetry-container');
    if (!telemetryContainer) {
        console.warn("#station-telemetry-container not found in SVG");
        return;
    }
    
    // 1. Create KPI box if it doesn't exist
    if (!kpiG) {
        // Find the station's <text> element to base coordinates on
        const stationTextEl = stationTextElements.get(stationId);
        if (!stationTextEl) {
             console.warn(`[SVG] No text element found for station: ${stationId}`);
             return; // Can't place it
        }
        
        const bbox = stationTextEl.getBBox();
        const x = bbox.x + (bbox.width / 2); // Center of the text
        const y = bbox.y + bbox.height + 20; // 20px below the text

        kpiG = document.createElementNS("http://www.w3.org/2000/svg", "g");
        kpiG.id = kpiId;
        kpiG.setAttribute('transform', `translate(${x}, ${y})`);
        
        // [MODIFIED] Scaled up elements
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
    kpiG.querySelector('.kpi-pax').textContent = `${data.passengers} (${data.occupancy_percent}%)`;
    kpiG.querySelector('.kpi-co2').textContent = data.air_quality.co2;
    kpiG.querySelector('.kpi-pm25').textContent = data.air_quality.pm2_5;
}


/**
 * [MODIFIED] Updates the UI of the SVG timeline slider
 */
export function updateSvgTimelineUI(min, max) {
    if (!svgSlider) return;
    
    currentMinTimestamp = min;
    currentMaxTimestamp = max;

    if (!svgHistoryToggle?.checked) return;

    const currentTimestamp = parseFloat(svgHandle.dataset.timestamp || currentMaxTimestamp);
    
    svgSlider.updateUI(currentMinTimestamp, currentMaxTimestamp, currentTimestamp);
}

/**
 * [MODIFIED] Replays the SVG state up to a specific point in time.
 */
function replaySvgHistory(replayUntilTimestamp) {
    if (!svgContent) return;

    // 1. Reset SVG to its initial state
    svgInitialTextValues.forEach((state, element) => {
        if (state.type === 'text') {
            element.textContent = state.value;
        } else if (state.type === 'attr') {
            element.setAttribute(state.attr, state.value);
        }
        // Reset dynamic styles
        element.classList.remove('alarm-text');
        
        // [MODIFIED] Reset fill color for station text
        if (element.tagName === 'text' && element.id.includes('_station_')) {
             const lineNum = element.id.match(/line(\d+)/);
             if(lineNum) {
                 if (lineNum[1] === '1') element.setAttribute('fill', '#f7bf0f');
                 else if (lineNum[1] === '2') element.setAttribute('fill', '#1c4b9c');
                 else if (lineNum[1] === '6') element.setAttribute('fill', '#6db76e');
                 else element.setAttribute('fill', '#aaa');
            } else if (element.id.startsWith('ratp-uns-station-')) {
                // Handle alert-texts (e.g. ratp-uns-station-nation-alert)
                const gParent = element.closest('g[id*="ratp-uns-line-"]');
                if(gParent) {
                     if (gParent.id.includes('-1-')) element.setAttribute('fill', '#f7bf0f');
                     else if (gParent.id.includes('-2-')) element.setAttribute('fill', '#1c4b9c');
                     else if (gParent.id.includes('-6-')) element.setAttribute('fill', '#6db76e');
                     else element.setAttribute('fill', '#aaa');
                } else {
                    element.setAttribute('fill', '#aaa');
                }
            }
        }
    });
    svgContent.querySelectorAll('.alarm-line').forEach(el => el.style.visibility = 'hidden');
    svgContent.querySelectorAll('.alarm-text').forEach(el => {
        if (!el.closest('.alarm-line')) { 
            el.style.visibility = 'hidden';
            el.classList.remove('alarm-text'); // Remove class too
        }
    });
    
    // [NEW] Clear all dynamically created elements
    trainElements.forEach(trainG => trainG.remove());
    trainElements.clear();
    stationTelemetryElements.forEach(kpiG => kpiG.remove());
    stationTelemetryElements.clear();

    // 2. Filter messages up to the replay timestamp
    const entriesToReplay = allHistoryEntries.filter(e => e.timestampMs <= replayUntilTimestamp);
    
    
    // 3. Determine the final state of each topic at that point in time
    const finalState = new Map();
    for (let i = entriesToReplay.length - 1; i >= 0; i--) {
        const entry = entriesToReplay[i];
        if (!finalState.has(entry.topic)) {
                finalState.set(entry.topic, entry.payload);
        }
    }

    // 4. Apply the final state to the SVG view
    finalState.forEach((payload, topic) => {
        try {
            const data = JSON.parse(payload); 
            
            // --- [NEW] Paris Métro Logic ---
            if (currentSvgId === 'ParisMetroTacticalMap' && topic.startsWith('ratp/uns/')) {
                 if (topic.includes('/train/')) {
                    updateMetroTrain(topic, data); // Create and place train
                } else if (topic.includes('/station/') && topic.endsWith('/alert')) {
                    updateMetroStationAlert(topic, data); // Handle station alerts
                } else if (topic.includes('/station/') && topic.endsWith('/telemetry')) {
                    updateMetroStationTelemetry(topic, data); // Handles station KPIs
                } else if (topic.includes('/line/') && topic.endsWith('/status')) {
                    updateMetroLineStatus(topic, data); // Handles line status
                } else {
                     const svgId = topic.replace(/\//g, '-');
                     defaultUpdateLogic(svgId, data);
                }
                return; // Handled
            }
            // --- [End New Logic] ---

            const svgId = topic.replace(/\//g, '-');
            defaultUpdateLogic(svgId, data);

        } catch (e) { /* Payload is not JSON, ignore */ }
    });
    
    updateAlarmPlaceholder();
}