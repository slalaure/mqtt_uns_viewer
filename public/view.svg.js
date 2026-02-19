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
 * SVG View Module
 * Handles real-time updates of SVG synoptics with performance optimizations.
 * [UPDATED] Implemented RequestAnimationFrame and update throttling to fix UI freezes.
 * [UPDATED] Added DOM element caching for faster lookups.
 * [UPDATED] Added safety try/finally to prevent frozen render loops.
 * [UPDATED] Added instant refresh on tab activation.
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
let appBasePath = '/'; 
let isMultiBroker = false;
// --- Performance Optimization State ---
let elementCache = new Map(); // Cache for SVG elements by ID
let updateQueue = new Map();  // Queue for throttled updates
let animationFrameRequested = false;
let highlightTimers = new Map(); // Track active highlight timeouts to prevent overlaps
const BINDINGS_SCRIPT_ID = 'custom-svg-bindings-script';
// API for custom bindings to accept brokerId
let customSvgBindings = {
    isLoaded: false,
    initialize: (svgRoot) => {},
    update: (brokerId, topic, payloadObject, svgRoot) => {},
    reset: (svgRoot) => {}
};
/**
 * Allows an external script (svg-bindings.js) to register its logic.
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
    appBasePath = appConfig.basePath; 
    isMultiBroker = appConfig.isMultiBroker; // Store multi-broker state
    // Initial load
    refreshSvgList(appConfig.svgFilePath);
    btnSvgFullscreen?.addEventListener('click', toggleFullscreen);
    svgSelectDropdown?.addEventListener('change', onSvgFileChange);
    svgHistoryToggle?.addEventListener('change', (e) => {
        isSvgHistoryMode = e.target.checked;
        if (svgTimelineSlider) svgTimelineSlider.style.display = isSvgHistoryMode ? 'flex' : 'none';
        trackEvent(isSvgHistoryMode ? 'svg_history_on' : 'svg_history_off');
        if (isSvgHistoryMode) {
            // When turning on, fetch state for the current slider position
            const replayTime = parseFloat(svgHandle.dataset.timestamp || currentMaxTimestamp);
            fetchLastKnownState(replayTime);
        } else {
            // [FIX] When returning to live mode, fetch latest state immediately
            fetchLastKnownState(Date.now());
        }
        if (svgSlider) {
            svgSlider.updateUI(currentMinTimestamp, currentMaxTimestamp, currentMaxTimestamp);
        }
    });
    if (svgHandle) {
        svgSlider = createSingleTimeSlider({
            containerEl: svgTimelineSlider,
            handleEl: svgHandle,
            labelEl: svgLabel,
            // onDrag only updates UI now
            onDrag: (newTime) => {
                // UI update managed by slider
            },
            // onDragEnd triggers the DB fetch
            onDragEnd: (newTime) => {
                trackEvent('svg_slider_drag_end');
                if (isSvgHistoryMode) {
                    fetchLastKnownState(newTime);
                }
            }
        });
    }
    // Add Delete Button to Controls
    const controlsContainer = document.querySelector('.map-view-controls');
    if (controlsContainer) {
        const btnDelete = document.createElement('button');
        btnDelete.className = 'map-button danger-button'; 
        btnDelete.innerHTML = '&#x1F5D1;'; // Trash icon
        btnDelete.title = "Delete current view";
        btnDelete.style.marginLeft = "10px";
        btnDelete.onclick = deleteCurrentSvg;
        controlsContainer.insertBefore(btnDelete, btnSvgFullscreen);
    }
}
/**
 * Receives the full history log from the main app.
 */
export function setSvgHistoryData(entries) {
    allHistoryEntries = entries; 
}
/**
 * Publicly exported function to refresh the dropdown.
 */
export async function refreshSvgList(targetFilenameToSelect = null) {
    if (!svgSelectDropdown) return;
    const currentSelection = targetFilenameToSelect || svgSelectDropdown.value;
    try {
        const response = await fetch('api/svg/list');
        if (!response.ok) throw new Error('Failed to fetch SVG list');
        const svgFiles = await response.json();
        svgSelectDropdown.innerHTML = '';
        if (svgFiles.length === 0) {
            svgSelectDropdown.innerHTML = '<option value="">No SVGs found</option>';
            return;
        }
        let matchFound = false;
        svgFiles.forEach(filename => {
            const option = document.createElement('option');
            option.value = filename;
            option.textContent = filename;
            if (filename === currentSelection) {
                option.selected = true;
                matchFound = true;
            }
            svgSelectDropdown.appendChild(option);
        });
        if (!matchFound && svgFiles.length > 0) {
            svgSelectDropdown.value = svgFiles[0];
            await loadSvgPlan(svgFiles[0]);
        } else if (matchFound) {
            // Reload the view to ensure we have the latest content
            await loadSvgPlan(currentSelection);
        }
    } catch (error) {
        console.error("Could not populate SVG list:", error);
        svgSelectDropdown.innerHTML = `<option value="">Error loading list</option>`;
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
// Logic to delete the current SVG view
async function deleteCurrentSvg() {
    const filename = svgSelectDropdown.value;
    if(!filename) return;
    if(!confirm(`Are you sure you want to delete '${filename}'? This action cannot be undone.`)) return;
    try {
        const res = await fetch(`api/svg/file?name=${encodeURIComponent(filename)}`, { method: 'DELETE' });
        if(res.ok) {
            alert("View deleted successfully.");
            refreshSvgList();
        } else {
            const data = await res.json();
            alert("Error: " + data.error);
        }
    } catch(e) {
        alert("Request failed: " + e.message);
    }
}
/**
 * Dynamically loads the custom svg-bindings.js script *by name*.
 */
async function loadCustomBindingsScript(bindingFilename) {
    // 1. Reset bindings to default
    customSvgBindings = {
        isLoaded: false,
        initialize: (svgRoot) => {},
        update: (brokerId, topic, payloadObject, svgRoot) => {},
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
    // 4. Set src to the new API endpoint with the 'name' param
    const apiBasePath = (appBasePath === '/') ? '' : appBasePath;
    script.src = `${apiBasePath}/api/svg/bindings.js?name=${encodeURIComponent(bindingFilename)}&v=${Date.now()}`;
    // 5. Add to head and await load
    return new Promise((resolve) => {
        script.onload = () => {
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
 * Scans the SVG for [data-key] elements to use with default logic.
 */
function scanForDataKeys() {
    elementCache.clear(); // Important to clear cache on new SVG load
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
            svgInitialTextValues.set(el, { type: 'attr', attr: 'stroke-opacity', value: el.getAttribute('stroke-opacity') });
            svgInitialTextValues.set(el, { type: 'attr', attr: 'stroke-width', value: el.getAttribute('stroke-width') });
        } else if (el.id === 'laser-charge-visual' && keyPath === 'value') {
            svgInitialTextValues.set(el, { type: 'attr', attr: 'width', value: el.getAttribute('width') });
        }
    });
}
/**
 * Loads a specific view.svg file from the server.
 */
async function loadSvgPlan(filename) {
    if (!filename) {
        svgContent.innerHTML = `<p style="color: red; padding: 20px;">Error: No SVG file selected.</p>`;
        return;
    }
    // Clear performance state
    updateQueue.clear();
    elementCache.clear();
    highlightTimers.forEach(t => clearTimeout(t));
    highlightTimers.clear();
    try {
        const response = await fetch(`api/svg/file?name=${encodeURIComponent(filename)}&t=${Date.now()}`); 
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const svgText = await response.text();
        if (svgContent) {
            svgContent.innerHTML = svgText;
            svgInitialTextValues.clear();
            const bindingFilename = filename + '.js'; 
            await loadCustomBindingsScript(bindingFilename);
            const svgRoot = svgContent.querySelector('svg');
            if (!svgRoot) return;
            if (customSvgBindings.isLoaded) {
                customSvgBindings.initialize(svgRoot);
            }
            scanForDataKeys();
            if (isSvgHistoryMode) {
                const replayTime = parseFloat(svgHandle.dataset.timestamp || currentMaxTimestamp);
                fetchLastKnownState(replayTime);
            } else {
                fetchLastKnownState(Date.now()); // Load current state
            }
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
 * Checks if a value triggers an alarm.
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
/**
 * Updates a single SVG element.
 */
function updateSvgElement(el, keyPath, value) {
    // --- 1. SPECIAL VISUALS (by ID or data-key) ---
    const numericValue = parseFloat(value);
    // Special visuals
    if (el.id === 'shield-visual-effect' && keyPath === 'power' && !isNaN(numericValue)) {
        const opacity = Math.max(0, Math.min(1, (numericValue / 100.0) * 0.7 + 0.1));
        const width = 2 + (numericValue / 100.0) * 8;
        el.setAttribute('stroke-opacity', opacity.toFixed(2));
        el.setAttribute('stroke-width', width.toFixed(2));
        return; 
    }
    if (el.id === 'laser-charge-visual' && keyPath === 'value' && !isNaN(numericValue)) {
        const maxWidth = 140; 
        const chargeWidth = Math.max(0, (numericValue / 100.0) * maxWidth);
        el.setAttribute('width', chargeWidth.toFixed(2));
        return; 
    }
    // --- 2. TEXT COLOR (by keyPath or value) ---
    if (el.tagName === 'text' || el.tagName === 'tspan') {
        let isStatus = false;
        if (keyPath === 'alert_level' || keyPath === 'global_status') {
            isStatus = true;
            if (value === 'red' || value === 'INTERRUPTED') el.setAttribute('fill', '#f85149');
            else if (value === 'yellow' || value === 'PERTURBED') el.setAttribute('fill', '#d29922');
            else el.setAttribute('fill', '#58a6ff'); // Blue for OK/green
        }
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
 * Process the update queue via RequestAnimationFrame to prevent UI freezing.
 * [FIX] Wrapped in try/finally to guarantee animationFrameRequested resets.
 */
function flushUpdateQueue() {
    try {
        const svgRoot = svgContent.querySelector('svg');
        if (!svgRoot) return; // Will jump to finally block

        updateQueue.forEach((data, key) => {
            const { brokerId, topic, payloadObject, isJson } = data;
            if (customSvgBindings.isLoaded) {
                try {
                    customSvgBindings.update(brokerId, topic, payloadObject, svgRoot);
                } catch (err) {
                    console.error(`Error in custom binding update:`, err);
                }
            } else if (isJson) {
                const specificId = isMultiBroker ? `${brokerId}-${topic.replace(/\//g, '-')}` : topic.replace(/\//g, '-');
                const genericId = topic.replace(/\//g, '-');
                // Search for elements (optimized using local cache)
                const idsToTry = [specificId, genericId];
                idsToTry.forEach(id => {
                    let elements = elementCache.get(id);
                    if (elements === undefined) {
                        try {
                            elements = svgContent.querySelectorAll(`[id="${id}"]`);
                        } catch (qErr) {
                            // Catch invalid selector errors safely
                            elements = [];
                        }
                        elementCache.set(id, elements);
                    }
                    if (elements.length > 0) {
                        elements.forEach(groupElement => {
                            const dataElements = groupElement.querySelectorAll('[data-key]');
                            dataElements.forEach(el => {
                                const value = getNestedValue(payloadObject, el.dataset.key);
                                if (value !== null && value !== undefined) {
                                    updateSvgElement(el, el.dataset.key, value);
                                }
                            });
                            // Optimized Highlight
                            groupElement.classList.add('highlight-svg-default');
                            if (highlightTimers.has(groupElement)) clearTimeout(highlightTimers.get(groupElement));
                            highlightTimers.set(groupElement, setTimeout(() => {
                                groupElement.classList.remove('highlight-svg-default');
                                highlightTimers.delete(groupElement);
                            }, 500));
                        });
                    }
                });
            }
        });
    } catch (globalErr) {
        console.error("Critical error in SVG render loop:", globalErr);
    } finally {
        // ALWAYS clear queue and release lock, even if querySelector throws
        updateQueue.clear();
        animationFrameRequested = false;
    }
}
/**
 * Main update router function. Throttled via Queue.
 */
export function updateMap(brokerId, topic, payload) {
    if (svgHistoryToggle?.checked || !svgContent) return;
    let payloadObject;
    let isJson = false;
    try {
        payloadObject = JSON.parse(payload); 
        isJson = true;
    } catch (e) { 
        payloadObject = payload;
    }
    // Queue the update (keep only the latest value for this topic/broker)
    const queueKey = `${brokerId}:${topic}`;
    updateQueue.set(queueKey, { brokerId, topic, payloadObject, isJson });
    if (!animationFrameRequested) {
        animationFrameRequested = true;
        requestAnimationFrame(flushUpdateQueue);
    }
}
/**
 * Updates the UI of the SVG timeline slider
 */
export function updateSvgTimelineUI(min, max) {
    if (!svgSlider) return;
    currentMinTimestamp = min;
    currentMaxTimestamp = max;
    if (!isSvgHistoryMode) return; 
    const currentTimestamp = parseFloat(svgHandle.dataset.timestamp || currentMaxTimestamp);
    svgSlider.updateUI(currentMinTimestamp, currentMaxTimestamp, currentTimestamp);
}

/**
 * [NEW] Force an explicit fetch of the latest real-time data from the DB.
 * Used when switching tabs so the user doesn't wait for the next ping.
 */
export function refreshSvgLiveState() {
    if (!isSvgHistoryMode && svgContent && svgContent.querySelector('svg')) {
        fetchLastKnownState(Date.now());
    }
}

/**
 * [NEW] Fetches the system state from DuckDB for a specific timestamp
 * and applies it to the SVG. Replaces local replaySvgHistory.
 * Renamed to fetchLastKnownState to match server semantic.
 */
async function fetchLastKnownState(timestamp) {
    if (!svgContent) return;
    const svgRoot = svgContent.querySelector('svg');
    if (!svgRoot) return;
    // 1. Visual Feedback
    svgContent.style.opacity = '0.5';
    // 2. Clear current state (Reset)
    svgInitialTextValues.forEach((state, element) => {
        if (state.type === 'text') {
            element.textContent = state.value;
        } else if (state.type === 'attr') {
            element.setAttribute(state.attr, state.value);
        }
        element.classList.remove('alarm-text', 'highlight-svg-default');
        if (element.getAttribute('fill') === '#f85149' || element.getAttribute('fill') === '#d29922' || element.getAttribute('fill') === '#3fb950' || element.getAttribute('fill') === '#58a6ff') {
            element.removeAttribute('fill');
        }
    });
    svgContent.querySelectorAll('.alarm-line').forEach(el => el.style.visibility = 'hidden');
    highlightTimers.forEach(t => clearTimeout(t));
    highlightTimers.clear();
    if (customSvgBindings.isLoaded) {
        try {
            customSvgBindings.reset(svgRoot);
        } catch (err) {
            console.error("Error in custom SVG binding 'reset' function:", err);
        }
    }
    // 3. API Call to /last-known
    try {
        const isoTime = new Date(timestamp).toISOString();
        const response = await fetch(`api/context/last-known?timestamp=${encodeURIComponent(isoTime)}`);
        if (!response.ok) throw new Error("Failed to fetch state");
        const stateData = await response.json(); 
        // console.log(`[SVG History] Fetched ${stateData.length} records (Last Known State) for ${isoTime}`);
        
        // 4. Apply State
        stateData.forEach(entry => {
            const { broker_id: brokerId, topic, payload } = entry;
            let payloadObject;
            let isJson = false;
            try {
                payloadObject = JSON.parse(payload);
                isJson = true;
            } catch (e) {
                payloadObject = payload;
            }
            if (customSvgBindings.isLoaded) {
                try {
                    customSvgBindings.update(brokerId, topic, payloadObject, svgRoot);
                } catch (err) {
                     // Retry with raw string if object fail
                    if (isJson && typeof payloadObject === 'object') {
                         try {
                             customSvgBindings.update(brokerId, topic, payload, svgRoot);
                         } catch(e) {}
                    }
                }
            } else if (isJson) {
                const specificId = isMultiBroker ? `${brokerId}-${topic.replace(/\//g, '-')}` : topic.replace(/\//g, '-');
                const genericId = topic.replace(/\//g, '-');
                try {
                    const groupElements = svgContent.querySelectorAll(`[id="${specificId}"], [id="${genericId}"]`);
                    groupElements.forEach(groupElement => {
                        groupElement.querySelectorAll('[data-key]').forEach(el => {
                            const value = getNestedValue(payloadObject, el.dataset.key);
                            if (value !== null && value !== undefined) updateSvgElement(el, el.dataset.key, value);
                        });
                    });
                } catch(e) {} // Catch invalid selector characters
            }
        });
    } catch (err) {
        console.error("Error fetching historical state:", err);
    } finally {
        svgContent.style.opacity = '1';
    }
}