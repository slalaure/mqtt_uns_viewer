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
import { formatTimestampForLabel, trackEvent } from './utils.js'; // [MODIFIED] Import trackEvent
// [NEW] Import the new time slider module
import { createSingleTimeSlider } from './time-slider.js';

// --- DOM Element Querying ---
const svgContent = document.getElementById('svg-content');
const svgHistoryToggle = document.getElementById('svg-history-toggle');
const svgTimelineSlider = document.getElementById('svg-timeline-slider-container');
const svgHandle = document.getElementById('svg-handle');
const svgLabel = document.getElementById('svg-label');
const btnSvgFullscreen = document.getElementById('btn-svg-fullscreen');
const mapView = document.getElementById('map-view');
const svgSelectDropdown = document.getElementById('svg-select-dropdown'); // [NEW]

// --- Module-level State ---
let svgInitialTextValues = new Map();
let allHistoryEntries = []; // Local cache of history, synced from app.js
let isSvgHistoryMode = false;
let currentMinTimestamp = 0;
let currentMaxTimestamp = 0;
let svgSlider = null; // [NEW] Module instance for the slider

/**
 * Initializes the SVG View functionality.
 * This is called once by app.js when the app loads.
 * @param {object} appConfig - The main application config object.
 */
export function initSvgView(appConfig) {
    // [MODIFIED] Populate list and load the default SVG
    populateSvgListAndLoadDefault(appConfig.svgFilePath);
    
    btnSvgFullscreen?.addEventListener('click', toggleFullscreen);

    svgHistoryToggle?.addEventListener('change', (e) => {
        isSvgHistoryMode = e.target.checked;
        if (svgTimelineSlider) svgTimelineSlider.style.display = isSvgHistoryMode ? 'flex' : 'none';
        
        // [NEW] Track event
        trackEvent(isSvgHistoryMode ? 'svg_history_on' : 'svg_history_off');

        // When toggling, replay state up to the end to get in sync
        replaySvgHistory(currentMaxTimestamp);

        // [NEW] Also update the slider's UI to the max time
        if (svgSlider) {
            svgSlider.updateUI(currentMinTimestamp, currentMaxTimestamp, currentMaxTimestamp);
        }
    });

    // [MODIFIED] Initialize the single time slider
    if (svgHandle) {
        svgSlider = createSingleTimeSlider({
            containerEl: svgTimelineSlider,
            handleEl: svgHandle,
            labelEl: svgLabel,
            onDrag: (newTime) => {
                replaySvgHistory(newTime); // Replay history while dragging
            },
            onDragEnd: (newTime) => { // [MODIFIED] Added onDragEnd
                trackEvent('svg_slider_drag_end');
            }
        });
    }  
}

/**
 * Receives the full history log from the main app.
 * @param {Array} entries - The complete list of history entries.
 */
export function setSvgHistoryData(entries) {
    allHistoryEntries = entries;
}

/**
 * [NEW] Fetches the list of SVGs, populates the dropdown, and loads the default.
 * @param {string} defaultSvgFile - The filename of the default SVG to load.
 */
async function populateSvgListAndLoadDefault(defaultSvgFile) {
    if (!svgSelectDropdown) return;
    
    let defaultFileFound = false;
    try {
        const response = await fetch('api/svg/list');
        if (!response.ok) throw new Error('Failed to fetch SVG list');
        
        const svgFiles = await response.json();
        
        svgSelectDropdown.innerHTML = ''; // Clear any existing options
        
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
        
        // If default from .env wasn't in the list, use the first file
        if (!defaultFileFound && svgFiles.length > 0) {
            svgSelectDropdown.value = svgFiles[0];
            defaultSvgFile = svgFiles[0];
        }

    } catch (error) {
        console.error("Could not populate SVG list:", error);
        svgSelectDropdown.innerHTML = `<option value="">Error loading list</option>`;
    }

    // Add listener *after* populating
    svgSelectDropdown.addEventListener('change', onSvgFileChange);
    
    // Finally, load the determined default SVG
    if (defaultSvgFile) {
        await loadSvgPlan(defaultSvgFile);
    } else {
        svgContent.innerHTML = `<p style="color: red; padding: 20px;">Error: No SVG files found in the /data directory.</p>`;
    }
}

/**
 * [NEW] Handles the change event when a new SVG is selected.
 * @param {Event} event
 */
async function onSvgFileChange(event) {
    const filename = event.target.value;
    if (!filename) return;
    
    trackEvent('svg_file_change');
    await loadSvgPlan(filename);
}


/**
 * [MODIFIED] Loads a specific view.svg file from the server.
 * @param {string} filename - The name of the SVG file to load (e.g., "view.svg").
 */
async function loadSvgPlan(filename) {
    if (!filename) {
        svgContent.innerHTML = `<p style="color: red; padding: 20px;">Error: No SVG file selected.</p>`;
        return;
    }
    
    try {
        // [MODIFIED] Fetch from the new dynamic API endpoint
        const response = await fetch(`api/svg/file?name=${encodeURIComponent(filename)}`); 
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const svgText = await response.text();
        if (svgContent) {
            svgContent.innerHTML = svgText;
            
            // Clear and store initial values for the new SVG
            svgInitialTextValues.clear();
            const dataElements = svgContent.querySelectorAll('[data-key]');
            
            dataElements.forEach(el => {
                // [MODIFIED] Store attribute state for visuals too
                if (el.tagName === 'text' || el.tagName === 'tspan') {
                    svgInitialTextValues.set(el, { type: 'text', value: el.textContent });
                } else if (el.id === 'shield-visual-effect') {
                    svgInitialTextValues.set(el, { type: 'attr', attr: 'stroke-opacity', value: el.getAttribute('stroke-opacity') });
                    svgInitialTextValues.set(el, { type: 'attr', attr: 'stroke-width', value: el.getAttribute('stroke-width') });
                } else if (el.id === 'laser-charge-visual') {
                    svgInitialTextValues.set(el, { type: 'attr', attr: 'width', value: el.getAttribute('width') });
                } else if (el.tagName === 'path' && el.dataset.key === 'status') {
                    // [NEW] Store initial class for metro lines
                    svgInitialTextValues.set(el, { type: 'attr', attr: 'class', value: el.getAttribute('class') });
                } else if (el.tagName === 'circle' && el.dataset.key === 'occupancy_percent') {
                    // [NEW] Store initial opacity for station occupancy
                    svgInitialTextValues.set(el, { type: 'attr', attr: 'fill-opacity', value: el.getAttribute('fill-opacity') });
                }
            });
            
            // [MODIFIED] Re-apply current state to the new SVG
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
    trackEvent('svg_fullscreen_toggle'); // [NEW]
    if (!mapView) return; // Make sure the view element exists
    
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
 * [HELPER] Safely gets a nested value from an object using a dot-notation string.
 * @param {object} obj - The object to search.
 * @param {string} path - The dot-notation path (e.g., "variables.STORAGE_LEVEL").
 * @returns {*} The value, or null if not found.
 */
function getNestedValue(obj, path) {
    if (typeof path !== 'string' || !obj) return null;
    // This handles keys like 'variables.6000_CPT_CH4_J' or 'air_quality.co2'
    return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : null), obj);
}

/**
 * [MODIFIED] Checks if a value triggers an alarm. Now supports 'EQ' (equals).
 * @param {*} currentValue - The value from the payload (usually a string).
 * @param {string} alarmType - The type of alarm (e.g., "H", "L", "EQ").
 * @param {string} alarmThreshold - The threshold value (as a string).
 * @returns {boolean} True if in alarm, false otherwise.
 */
function checkAlarm(currentValue, alarmType, alarmThreshold) {
    // [NEW] Handle string equality checks
    if (alarmType === 'EQ') {
        return String(currentValue) === String(alarmThreshold);
    }
    if (alarmType === 'NEQ') {
        return String(currentValue) !== String(alarmThreshold);
    }

    // Original numeric logic
    const value = parseFloat(currentValue);
    const threshold = parseFloat(alarmThreshold);

    if (isNaN(value) || isNaN(threshold)) {
        return false;
    }

    switch (alarmType) {
        case 'HH': // High-High
        case 'H':  // High
            return value > threshold;
        case 'LL': // Low-Low
        case 'L':  // Low
            return value < threshold;
        default:
            return false;
    }
}

/**
 * [NEW HELPER] Updates the visibility of the "(Aucune alarme active)" placeholder.
 * This checks the *entire SVG* for any visible alarm lines.
 */
function updateAlarmPlaceholder() {
    if (!svgContent) return;
    const noAlarmsEl = svgContent.querySelector('#no-alarms-text');
    if (!noAlarmsEl) return; // Placeholder not found

    const visibleAlarms = svgContent.querySelectorAll('.alarm-line[style*="block"]');
    
    if (visibleAlarms.length > 0) {
        noAlarmsEl.style.display = 'none'; // Hide placeholder
    } else {
        noAlarmsEl.style.display = 'block'; // Show placeholder
    }
}

/**
 * [MODIFIED] Updates a single SVG element with a new value.
 * This now handles text, colors, and visual attributes.
 * @param {SVGElement} el - The SVG element to update.
 * @param {string} keyPath - The data-key (e.g., "power" or "metrics[Status]").
 * @param {*} value - The new value from the payload.
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
    
    // C. [NEW] Paris Métro Line Status (Path)
    if (el.tagName === 'path' && keyPath === 'status') {
        const baseClass = el.getAttribute('class').split(' ')[0] + ' ' + el.getAttribute('class').split(' ')[1]; // e.g., "line-path line-1"
        if (value === 'OK') el.setAttribute('class', baseClass + ' line-status-OK');
        else if (value === 'PERTURBED') el.setAttribute('class', baseClass + ' line-status-PERTURBED');
        else if (value === 'INTERRUPTED') el.setAttribute('class', baseClass + ' line-status-INTERRUPTED');
        return; // Handled
    }
    
    // D. [NEW] Paris Métro Station Occupancy (Circle)
    if (el.tagName === 'circle' && keyPath === 'occupancy_percent' && !isNaN(numericValue)) {
        const opacity = Math.max(0.1, Math.min(1, (numericValue / 100.0) * 0.8 + 0.1));
        el.setAttribute('fill-opacity', opacity.toFixed(2));
        // We still want the text to update, so we *don't* return here.
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
            if (v === 'damaged' || v === 'offline' || v === 'breached' || v === 'error' || v === 'stopped' || v.includes('ALERT_')) {
                el.setAttribute('fill', '#f85149'); // Red
            } else if (v === 'online' || v === 'empty' || v === 'green' || v === 'clear' || v === 'patrol' || v === 'ok' || v === 'running') {
                el.setAttribute('fill', '#3fb950'); // Green
            } else {
                el.setAttribute('fill', '#d29922'); // Yellow for 'standby', 'charging', 'transit' etc.
            }
        }
        
        // Animate red status text
        if (el.getAttribute('fill') === '#f85149') {
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
            // [MODIFIED] Use visibility instead of display for <g> elements
            alarmLineGroup.style.visibility = isAlarm ? 'visible' : 'hidden';
        } else {
             // [NEW] Handle alarm text directly
             const isAlarm = checkAlarm(value, alarmType, alarmValue);
             el.style.visibility = isAlarm ? 'visible' : 'hidden';
        }
    }
}


/**
 * [MODIFIED] Updates the SVG map with new data from an MQTT message.
 * Will not update if the history toggle is checked.
 * @param {string} topic - The MQTT topic.
 * @param {string} payload - The message payload.
 */
export function updateMap(topic, payload) {
    if (svgHistoryToggle?.checked) return; // Do not update if in history mode

    try {
        const data = JSON.parse(payload); 
        const svgId = topic.replace(/\//g, '-');
        
        const groupElements = svgContent?.querySelectorAll(`[id="${svgId}"]`);
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
            
             // Add a visual highlight pulse to the <g> element
            groupElement.classList.add('highlight-svg');
            setTimeout(() => groupElement.classList.remove('highlight-svg'), 500);
        });
        
        updateAlarmPlaceholder();

    } catch (e) { 
        console.warn("SVG updateMap error:", e);
    }
}

/**
 * [MODIFIED] Updates the UI of the SVG timeline slider
 * by calling the slider module.
 * @param {number} min - The minimum timestamp of all history.
 * @param {number} max - The maximum timestamp of all history.
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
        if (element.tagName === 'text' || element.tagName === 'tspan') {
            element.setAttribute('fill', '#aaa'); // Default text color
        }
    });
    // Also reset all alarm lines to hidden
    svgContent.querySelectorAll('.alarm-line').forEach(el => el.style.visibility = 'hidden');
    // [NEW] Reset direct alarm texts
    svgContent.querySelectorAll('.alarm-text').forEach(el => {
        if (!el.closest('.alarm-line')) { // Only hide if NOT in an alarm-line group
            el.style.visibility = 'hidden';
        }
    });

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
            const svgId = topic.replace(/\//g, '-');

            const groupElements = svgContent?.querySelectorAll(`[id="${svgId}"]`);
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
            });
        } catch (e) { /* Payload is not JSON, ignore */ }
    });
    
    // 5. --- UPDATE PLACEHOLDER ---
    updateAlarmPlaceholder();
}