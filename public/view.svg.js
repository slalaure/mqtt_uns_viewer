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
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OF OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Import shared utilities
import { formatTimestampForLabel } from './utils.js';
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
    loadSvgPlan();
    
    btnSvgFullscreen?.addEventListener('click', toggleFullscreen);

    svgHistoryToggle?.addEventListener('change', (e) => {
        isSvgHistoryMode = e.target.checked;
        if (svgTimelineSlider) svgTimelineSlider.style.display = isSvgHistoryMode ? 'flex' : 'none';
        
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
            onDragEnd: null // No action needed on mouse up
        });
    }

    // --- Handle SVG Default Fullscreen ---
    if (appConfig.svgDefaultFullscreen && appConfig.viewSvgEnabled && mapView.classList.contains('active')) {
        console.log("Attempting to open SVG view in fullscreen by default...");
        try {
            toggleFullscreen();
        } catch (err) {
            console.warn("Default fullscreen request was blocked by the browser.", err);
        }
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
 * Loads the view.svg file from the server and populates the content.
 */
async function loadSvgPlan() {
    try {
        // This fetch is relative ('view.svg') and will correctly resolve
        const response = await fetch('view.svg'); 
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const svgText = await response.text();
        if (svgContent) {
            svgContent.innerHTML = svgText;
            // Store initial values of all data-keyed elements
            const textElements = svgContent.querySelectorAll('[data-key]');
            textElements.forEach(el => {
                svgInitialTextValues.set(el, el.textContent);
            });
            // Ensure placeholder is correct on load
            updateAlarmPlaceholder(); 
        }
    } catch (error) {
        console.error("Could not load the SVG file:", error);
        if (svgContent) svgContent.innerHTML = `<p style="color: red; padding: 20px;">Error: The SVG plan file could not be loaded.</p>`;
    }
}

/**
 * Toggles fullscreen mode for the SVG map view.
 */
function toggleFullscreen() {
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
    // This handles keys like 'variables.6000_CPT_CH4_J'
    return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : null), obj);
}

/**
 * [NEW HELPER] Checks if a value triggers an alarm.
 * @param {*} currentValue - The value from the payload (usually a string).
 * @param {string} alarmType - The type of alarm (e.g., "HH", "H", "L", "LL").
 * @param {string} alarmThreshold - The threshold value (as a string).
 * @returns {boolean} True if in alarm, false otherwise.
 */
function checkAlarm(currentValue, alarmType, alarmThreshold) {
    const value = parseFloat(currentValue);
    const threshold = parseFloat(alarmThreshold);

    // If values are not valid numbers, it's not an alarm.
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

    // Find all *visible* alarm lines in the whole document
    // We check for `style=""` as well in case the default "display: none" was just removed.
    const visibleAlarms = svgContent.querySelectorAll('.alarm-line[style*="block"]');
    
    if (visibleAlarms.length > 0) {
        noAlarmsEl.style.display = 'none'; // Hide placeholder
    } else {
        noAlarmsEl.style.display = 'block'; // Show placeholder
    }
}

/**
 * [MODIFIED] Updates the SVG map with new data from an MQTT message.
 * Will not update if the history toggle is checked.
 * @param {string} topic - The MQTT topic.
 * @param {string} payload - The message payload.
 */
export function updateMap(topic, payload) {
    // Check the toggle's state directly
    if (svgHistoryToggle?.checked) return;

    try {
        const data = JSON.parse(payload); // 'data' is the full payload: { device_identifier: ..., variables: {...} }
        const svgId = topic.replace(/\//g, '-');
        const groupElement = svgContent?.querySelector(`#${svgId}`);
        if (!groupElement) return;

        // [MODIFIED LOGIC]
        const dataElements = groupElement.querySelectorAll('[data-key]');
        
        dataElements.forEach(el => {
            const keyPath = el.dataset.key; // Get the "variables.STORAGE_LEVEL" string
            const value = getNestedValue(data, keyPath);
            
            if (value !== null && value !== undefined) {
                // 1. Update the text content
                if (typeof value === 'number' && !Number.isInteger(value)) {
                    el.textContent = parseFloat(value).toFixed(2);
                } else {
                    el.textContent = value;
                }
                
                // 2. --- NEW ALARM LOGIC ---
                const alarmType = el.dataset.alarmType;
                const alarmValue = el.dataset.alarmValue;
                
                if (alarmType && alarmValue) {
                    const alarmLineGroup = el.closest('.alarm-line');
                    if (alarmLineGroup) {
                        const isAlarm = checkAlarm(value, alarmType, alarmValue);
                        // Show or hide the entire alarm line
                        alarmLineGroup.style.display = isAlarm ? 'block' : 'none';
                    }
                }
                // --- END ALARM LOGIC ---
            }
        });
        
        // 3. --- UPDATE PLACEHOLDER ---
        // After processing all elements in this group, check the global alarm state.
        updateAlarmPlaceholder();

        // Add a visual highlight pulse
        groupElement.classList.add('highlight-svg');
        setTimeout(() => groupElement.classList.remove('highlight-svg'), 500);
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
    
    // Update module state
    currentMinTimestamp = min;
    currentMaxTimestamp = max;

    // Don't update UI if not in history mode
    if (!svgHistoryToggle?.checked) return;

    // Get the slider's current time from its data attribute, or default to the max
    const currentTimestamp = parseFloat(svgHandle.dataset.timestamp || currentMaxTimestamp);
    
    svgSlider.updateUI(currentMinTimestamp, currentMaxTimestamp, currentTimestamp);
}

/**
 * [MODIFIED] Replays the SVG state up to a specific point in time.
 */
function replaySvgHistory(replayUntilTimestamp) {
    if (!svgContent) return;

    // 1. Reset SVG to its initial state
    svgInitialTextValues.forEach((text, element) => {
        element.textContent = text;
    });
    // Also reset all alarm lines to hidden
    svgContent.querySelectorAll('.alarm-line').forEach(el => el.style.display = 'none');

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
            const data = JSON.parse(payload); // 'data' is the full payload
            const svgId = topic.replace(/\//g, '-');
            const groupElement = svgContent?.querySelector(`#${svgId}`);
            if (!groupElement) return;

            // [MODIFIED LOGIC]
            const dataElements = groupElement.querySelectorAll('[data-key]');
            
            dataElements.forEach(el => {
                const keyPath = el.dataset.key; 
                const value = getNestedValue(data, keyPath);
                
                if (value !== null && value !== undefined) {
                    // 1. Update text content
                    if (typeof value === 'number' && !Number.isInteger(value)) {
                        el.textContent = parseFloat(value).toFixed(2);
                    } else {
                        el.textContent = value;
                    }
                    
                    // 2. --- NEW ALARM LOGIC ---
                    const alarmType = el.dataset.alarmType;
                    const alarmValue = el.dataset.alarmValue;
                    
                    if (alarmType && alarmValue) {
                        const alarmLineGroup = el.closest('.alarm-line');
                        if (alarmLineGroup) {
                            const isAlarm = checkAlarm(value, alarmType, alarmValue);
                            if (isAlarm) {
                                // *Only set to block*, don't set to 'none'
                                // Otherwise, a non-alarm value from another topic could hide it
                                alarmLineGroup.style.display = 'block';
                            }
                        }
                    }
                }
            });
        } catch (e) { /* Payload is not JSON, ignore */ }
    });
    
    // 5. --- UPDATE PLACEHOLDER ---
    // After all states are replayed, check the global alarm visibility
    updateAlarmPlaceholder();
}

/**
 * [REMOVED] makeSvgSliderDraggable(handle)
 * This logic is now in public/time-slider.js
 */