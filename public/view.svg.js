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
let appBasePath = '/'; // [NEW] Will be set on init
const BINDINGS_SCRIPT_ID = 'custom-svg-bindings-script';

// [NEW] API for custom bindings
let customSvgBindings = {
    isLoaded: false,
    initialize: (svgRoot) => {},
    update: (topic, payloadObject, svgRoot) => {},
    reset: (svgRoot) => {}
};

/**
 * [NEW] Allows an external script (svg-bindings.js) to register its logic.
 * This function is exposed on the window object.
 */
window.registerSvgBindings = function(bindings) {
    if (!bindings) return;
    
    customSvgBindings.isLoaded = true;
    if (bindings.initialize) customSvgBindings.initialize = bindings.initialize;
    if (bindings.update) customSvgBindings.update = bindings.update;
    if (bindings.reset) customSvgBindings.reset = bindings.reset;
    console.log("Custom SVG bindings registered.");
}

/**
 * Initializes the SVG View functionality.
 */
export function initSvgView(appConfig) {
    appBasePath = appConfig.basePath; // [NEW] Store base path
    populateSvgListAndLoadDefault(appConfig.svgFilePath);
    
    btnSvgFullscreen?.addEventListener('click', toggleFullscreen);

    svgHistoryToggle?.addEventListener('change', (e) => {
        isSvgHistoryMode = e.target.checked;
        if (svgTimelineSlider) svgTimelineSlider.style.display = isSvgHistoryMode ? 'flex' : 'none';
        
        trackEvent(isSvgHistoryMode ? 'svg_history_on' : 'svg_history_off');
        
        // Replay history at the current max time when toggling on
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
 * [MODIFIED] Dynamically loads the custom svg-bindings.js script *by name*.
 * @param {string} bindingFilename - The name of the .js file to load (e.g., "my-plan.svg.js").
 */
async function loadCustomBindingsScript(bindingFilename) {
    // 1. Reset bindings to default
    customSvgBindings = {
        isLoaded: false,
        initialize: (svgRoot) => {},
        update: (topic, payloadObject, svgRoot) => {},
        reset: (svgRoot) => {}
    };
    
    // 2. Remove old script tag if it exists
    const oldScript = document.getElementById(BINDINGS_SCRIPT_ID);
    if (oldScript) {
        oldScript.remove();
    }
    
    // 3. Create new script tag
    const script = document.createElement('script');
    script.id = BINDINGS_SCRIPT_ID;
    script.type = 'module';
    
    // 4. [MODIFIED] Set src to the new API endpoint with the 'name' param
    const apiBasePath = (appBasePath === '/') ? '' : appBasePath;
    script.src = `${apiBasePath}/api/svg/bindings.js?name=${encodeURIComponent(bindingFilename)}&v=${Date.now()}`;
    
    // 5. Add to head and await load
    return new Promise((resolve) => {
        script.onload = () => {
            // Note: window.registerSvgBindings() will be called by the script itself
            console.log(`Custom SVG bindings script loaded: ${bindingFilename}`);
            resolve();
        };
        script.onerror = (err) => {
            console.log(`No custom SVG bindings script found at /data/${bindingFilename}. Using default logic.`);
            resolve(); // Resolve anyway, don't break the app
        };
        document.head.appendChild(script);
    });
}

/**
 * [NEW] Scans the SVG for [data-key] elements to use with default logic.
 */
function scanForDataKeys() {
    const dataElements = svgContent.querySelectorAll('[data-key]');
    
    dataElements.forEach(el => {
        const keyPath = el.dataset.key;
        
        if (el.tagName === 'text' || el.tagName === 'tspan') {
            svgInitialTextValues.set(el, { type: 'text', value: el.textContent });
        } else if (el.tagName === 'path' && (keyPath === 'status')) {
            svgInitialTextValues.set(el, { type: 'attr', attr: 'class', value: el.getAttribute('class') });
        } else if (el.tagName === 'circle' && keyPath === 'occupancy_percent') {
            svgInitialTextValues.set(el, { type: 'attr', attr: 'fill-opacity', value: el.getAttribute('fill-opacity') });
        } else if (el.id === 'shield-visual-effect' && keyPath === 'power') {
            // Specific example for default logic
            svgInitialTextValues.set(el, { type: 'attr', attr: 'stroke-opacity', value: el.getAttribute('stroke-opacity') });
            svgInitialTextValues.set(el, { type: 'attr', attr: 'stroke-width', value: el.getAttribute('stroke-width') });
        } else if (el.id === 'laser-charge-visual' && keyPath === 'value') {
            // Specific example for default logic
            svgInitialTextValues.set(el, { type: 'attr', attr: 'width', value: el.getAttribute('width') });
        }
        // Add more default savers here if needed
    });
}

/**
 * [MODIFIED] Loads a specific view.svg file from the server.
 * Now resets state, dynamically loads bindings, and scans the SVG.
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
            
            // Clear all old state
            svgInitialTextValues.clear();

            // [MODIFIED] Dynamically load/reload the custom bindings script
            const bindingFilename = filename + '.js'; // e.g., "paris-metro.svg" -> "paris-metro.svg.js"
            await loadCustomBindingsScript(bindingFilename);
            
            const svgRoot = svgContent.querySelector('svg');
            if (!svgRoot) return;

            // Call the *newly loaded* initialize function (if it exists)
            if (customSvgBindings.isLoaded) {
                customSvgBindings.initialize(svgRoot);
            }
            
            // Scan for data-keys for the default logic
            scanForDataKeys();
            
            // Replay history on the newly loaded SVG + bindings
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
    // This function is no longer needed as logic is generic
}

/**
 * [MODIFIED] Updates a single SVG element with a new value.
 * This is now the "default" logic, used when no custom bindings.js is found.
 */
function updateSvgElement(el, keyPath, value) {
    // --- 1. SPECIAL VISUALS (by ID or data-key) ---
    const numericValue = parseFloat(value);
    
    // A. Death Star Shield Effect (Example)
    if (el.id === 'shield-visual-effect' && keyPath === 'power' && !isNaN(numericValue)) {
        const opacity = Math.max(0, Math.min(1, (numericValue / 100.0) * 0.7 + 0.1));
        const width = 2 + (numericValue / 100.0) * 8;
        el.setAttribute('stroke-opacity', opacity.toFixed(2));
        el.setAttribute('stroke-width', width.toFixed(2));
        return; // Handled
    }
    
    // B. Death Star Laser Charge Effect (Example)
    if (el.id === 'laser-charge-visual' && keyPath === 'value' && !isNaN(numericValue)) {
        const maxWidth = 140; // Max width in SVG
        const chargeWidth = Math.max(0, (numericValue / 100.0) * maxWidth);
        el.setAttribute('width', chargeWidth.toFixed(2));
        return; // Handled
    }
    
    // --- [REMOVED] Paris Métro specific logic ---
    
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
 * Now routes to custom bindings or default logic.
 * @param {string} topic - The MQTT topic.
 * @param {string} payload - The message payload.
 */
export function updateMap(topic, payload) {
    if (svgHistoryToggle?.checked) return;
    if (!svgContent) return;
    const svgRoot = svgContent.querySelector('svg');
    if (!svgRoot) return;

    let payloadObject;
    let isJson = false;
    try {
        payloadObject = JSON.parse(payload); 
        isJson = true;
    } catch (e) { 
        payloadObject = payload; // It's a raw string
    }
    
    if (customSvgBindings.isLoaded) {
        // If custom logic is registered, *only* use that.
        try {
            customSvgBindings.update(topic, payloadObject, svgRoot);
        } catch (err) {
            console.error(`Error in custom SVG binding 'update' function for topic ${topic}:`, err);
        }
    } else {
        // Otherwise, use the generic default logic
        if(isJson) {
            const svgId = topic.replace(/\//g, '-');
            defaultUpdateLogic(svgId, payloadObject);
        }
        // (If not JSON and no custom logic, do nothing)
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
        
        // [MODIFIED] Use a generic highlight class
        groupElement.classList.add('highlight-svg-default');
        setTimeout(() => groupElement.classList.remove('highlight-svg-default'), 500);
    });
}

/**
 * [MODIFIED] Updates the UI of the SVG timeline slider
 */
export function updateSvgTimelineUI(min, max) {
    if (!svgSlider) return;
    
    currentMinTimestamp = min;
    currentMaxTimestamp = max;

    // Don't update/show if not in history mode
    if (!isSvgHistoryMode) return; 

    const currentTimestamp = parseFloat(svgHandle.dataset.timestamp || currentMaxTimestamp);
    
    svgSlider.updateUI(currentMinTimestamp, currentMaxTimestamp, currentTimestamp);
}

/**
 * [MODIFIED] Replays the SVG state up to a specific point in time.
 * Now uses custom bindings or default logic.
 */
function replaySvgHistory(replayUntilTimestamp) {
    if (!svgContent) return;

    const svgRoot = svgContent.querySelector('svg');
    if (!svgRoot) return;

    // 1. Reset SVG to its initial state (using default logic)
    svgInitialTextValues.forEach((state, element) => {
        if (state.type === 'text') {
            element.textContent = state.value;
        } else if (state.type === 'attr') {
            element.setAttribute(state.attr, state.value);
        }
        // Reset dynamic styles
        element.classList.remove('alarm-text', 'highlight-svg-default');
        if (element.getAttribute('fill') === '#f85149' || element.getAttribute('fill') === '#d29922' || element.getAttribute('fill') === '#3fb950' || element.getAttribute('fill') === '#58a6ff') {
            element.removeAttribute('fill');
        }
    });
    svgContent.querySelectorAll('.alarm-line').forEach(el => el.style.visibility = 'hidden');
    
    // [NEW] Call the custom reset function
    if (customSvgBindings.isLoaded) {
        try {
            customSvgBindings.reset(svgRoot);
        } catch (err) {
            console.error("Error in custom SVG binding 'reset' function:", err);
        }
    }

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
        let payloadObject;
        let isJson = false;
        try {
            payloadObject = JSON.parse(payload);
            isJson = true;
        } catch (e) { 
            payloadObject = payload;
        }
        
        // [MODIFIED] Route to custom or default logic
        if (customSvgBindings.isLoaded) {
            try {
                customSvgBindings.update(topic, payloadObject, svgRoot);
            } catch (err) {
                console.error(`Error in custom SVG binding 'update' function during replay for topic ${topic}:`, err);
            }
        } else {
            if (isJson) {
                const svgId = topic.replace(/\//g, '-');
                defaultUpdateLogic(svgId, payloadObject);
            }
        }
    });
}