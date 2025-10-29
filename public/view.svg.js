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
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Import shared utilities
import { formatTimestampForLabel } from './utils.js';

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
    });

    if (svgHandle) {
        makeSvgSliderDraggable(svgHandle);
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
    return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : null), obj);
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

        // [NEW LOGIC]
        // 1. Find all elements with a data-key *within* this group
        const dataElements = groupElement.querySelectorAll('[data-key]');
        
        // 2. Iterate over them
        dataElements.forEach(el => {
            const keyPath = el.dataset.key; // Get the "variables.STORAGE_LEVEL" string
            
            // 3. Get the nested value
            const value = getNestedValue(data, keyPath);
            
            // 4. Update the text content if the value is found
            if (value !== null && value !== undefined) {
                // Format numbers to 2 decimal places if they are not integers
                if (typeof value === 'number' && !Number.isInteger(value)) {
                    el.textContent = value.toFixed(2);
                } else {
                    el.textContent = value;
                }
            }
            // Optional: else { el.textContent = 'N/A'; } // Or just leave it as is
        });
        // [END NEW LOGIC]

        // Add a visual highlight pulse
        groupElement.classList.add('highlight-svg');
        setTimeout(() => groupElement.classList.remove('highlight-svg'), 500);
    } catch (e) { 
        // Payload is not JSON or element not found, ignore for map
        console.warn("SVG updateMap error:", e); // Uncomment for debugging
    }
}

/**
 * Updates the UI of the SVG timeline slider.
 * @param {number} min - The minimum timestamp of all history.
 * @param {number} max - The maximum timestamp of all history.
 */
export function updateSvgTimelineUI(min, max) {
    if (!svgHandle) return;
    
    // Update module state
    currentMinTimestamp = min;
    currentMaxTimestamp = max;

    // Don't update UI if not in history mode
    if (!svgHistoryToggle?.checked) return;

    const timeRange = currentMaxTimestamp - currentMinTimestamp;
    if (timeRange <= 0) return;

    const currentTimestamp = parseFloat(svgHandle.dataset.timestamp || currentMaxTimestamp);
    const currentPercent = ((currentTimestamp - currentMinTimestamp) / timeRange) * 100;
    
    svgHandle.style.left = `${currentPercent}%`;
    svgLabel.textContent = formatTimestampForLabel(currentTimestamp);
}

/**
 * [MODIFIED] Replays the SVG state up to a specific point in time.
 * @param {number} replayUntilTimestamp - The timestamp to replay to.
 */
function replaySvgHistory(replayUntilTimestamp) {
    if (!svgContent) return;

    // 1. Reset SVG to its initial state
    svgInitialTextValues.forEach((text, element) => {
        element.textContent = text;
    });

    // 2. Filter messages up to the replay timestamp
    const entriesToReplay = allHistoryEntries.filter(e => e.timestampMs <= replayUntilTimestamp);
    
    // 3. Determine the final state of each topic at that point in time
    const finalState = new Map();
    // Iterate backwards (from newest to oldest)
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

            // [NEW LOGIC]
            // 1. Find all elements with a data-key *within* this group
            const dataElements = groupElement.querySelectorAll('[data-key]');
            
            // 2. Iterate over them
            dataElements.forEach(el => {
                const keyPath = el.dataset.key; // Get the "variables.STORAGE_LEVEL" string
                
                // 3. Get the nested value
                const value = getNestedValue(data, keyPath);
                
                // 4. Update the text content if the value is found
                if (value !== null && value !== undefined) {
                    // Format numbers to 2 decimal places if they are not integers
                    if (typeof value === 'number' && !Number.isInteger(value)) {
                        el.textContent = value.toFixed(2);
                    } else {
                        el.textContent = value;
                    }
                }
            });
            // [END NEW LOGIC]
        } catch (e) { /* Payload is not JSON, ignore */ }
    });
}

/**
 * Makes the SVG timeline slider handle draggable.
 * @param {HTMLElement} handle - The slider handle element.
 */
function makeSvgSliderDraggable(handle) {
    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (!svgTimelineSlider) return;
        const sliderRect = svgTimelineSlider.getBoundingClientRect();

        const onMouseMove = (moveEvent) => {
            let x = moveEvent.clientX - sliderRect.left;
            let percent = (x / sliderRect.width) * 100;
            percent = Math.max(0, Math.min(100, percent));
            
            const timeRange = currentMaxTimestamp - currentMinTimestamp;
            if (timeRange <= 0) return;
            const newTimestamp = currentMinTimestamp + (timeRange * percent / 100);

            handle.style.left = `${percent}%`;
            handle.dataset.timestamp = newTimestamp;
            svgLabel.textContent = formatTimestampForLabel(newTimestamp);

            replaySvgHistory(newTimestamp); // Replay history while dragging
        };
        
        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}