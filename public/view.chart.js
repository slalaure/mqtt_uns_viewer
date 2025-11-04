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
 * IMPLIED, INCLUDING BUT NOTT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Import shared utilities
import { formatTimestampForLabel } from './utils.js';
// [NEW] Import the reusable payload viewer
import { createPayloadViewer } from './payload-viewer.js';
// [NEW] Import the new time slider module
import { createDualTimeSlider }from './time-slider.js';

// --- DOM Element Querying ---
// [REMOVED] chart-tree, chart-payload-topic, chart-payload-content (handled by app.js and viewer)
const chartVariableList = document.getElementById('chart-variable-list');
const chartMainArea = document.getElementById('chart-main-area');
const chartCanvas = document.getElementById('chart-canvas');
const chartCanvasContainer = document.getElementById('chart-canvas-container');
const chartPlaceholder = document.getElementById('chart-placeholder');

// Chart Controls
const btnChartGenerate = document.getElementById('btn-chart-generate');
const btnChartFullscreen = document.getElementById('btn-chart-fullscreen');
const btnChartExportCSV = document.getElementById('btn-chart-export-csv');
const btnChartExportPNG = document.getElementById('btn-chart-export-png');
const btnChartClear = document.getElementById('btn-chart-clear'); 
const chartTypeSelect = document.getElementById('chart-type-select');
const chartConnectNulls = document.getElementById('chart-connect-nulls-toggle');

// [MODIFIED] Save/Load controls
const chartConfigSelect = document.getElementById('chart-config-select');
const btnChartSaveCurrent = document.getElementById('btn-chart-save-current');
const btnChartSaveAs = document.getElementById('btn-chart-save-as');
const btnChartDeleteConfig = document.getElementById('btn-chart-delete-config');
const chartSaveStatus = document.getElementById('chart-save-status');


// Time Slider Elements
const chartTimeSliderContainer = document.getElementById('chart-time-range-slider-container');
const chartHandleMin = document.getElementById('chart-handle-min');
const chartHandleMax = document.getElementById('chart-handle-max');
const chartSliderRange = document.getElementById('chart-slider-range');
const chartLabelMin = document.getElementById('chart-label-min');
const chartLabelMax = document.getElementById('chart-label-max');


// --- Module-level State ---
let chartInstance = null;
// [REMOVED] selectedChartNode (managed by app.js)
let selectedChartTopic = null; // The topic path for the selected UI node
let lastGeneratedData = { labels: [], datasets: [] }; // For CSV export
let chartedVariables = new Map(); // Stores all variables to be charted, key = 'topic|path'

let minTimestamp = 0;
let maxTimestamp = 0;
let currentMinTimestamp = 0;
let currentMaxTimestamp = 0;

// [MODIFIED] State for live mode and saving
let isChartLive = true; // Default to live mode
let chartSaveTimer = null;
let allChartConfigs = { configurations: [] }; // Holds all saved configs
let currentConfigId = null; // ID of the currently loaded chart
let maxChartsLimit = 0; // [NEW] To store the limit from config

let chartSlider = null; // [NEW] Module instance for the slider
let chartRefreshTimer = null; // [MODIFIÉ] Timer pour le "debounce" du graphique


// [NEW] Create an instance of the payload viewer for this view
const payloadViewer = createPayloadViewer({
    topicEl: document.getElementById('chart-payload-topic'),
    contentEl: document.getElementById('chart-payload-content'),
    historyLogEl: null, // Chart view doesn't show history
    placeholderEl: null
});


// --- Callbacks from main app.js ---
let appCallbacks = {
    getHistory: () => [],
    // [REMOVED] displayPayload (now handled by internal payloadViewer)
    colorChartTreeCallback: () => console.error("colorChartTreeCallback not set"), 
};

/**
 * Exports the Set of topics that have variables charted.
 * @returns {Set<string>} A Set of topic strings.
 */
export function getChartedTopics() {
    const topics = new Set();
    for (const varInfo of chartedVariables.values()) {
        topics.add(varInfo.topic);
    }
    return topics;
}

/**
 * [NEW] Removes any charted variables that match a topic pattern.
 * @param {RegExp} regex - The regex to test against topic strings.
 */
export function pruneChartedVariables(regex) {
    let wasPruned = false;
    for (const [varId, varInfo] of chartedVariables.entries()) {
        if (regex.test(varInfo.topic)) {
            chartedVariables.delete(varId);
            wasPruned = true;
        }
    }
    
    if (wasPruned) {
        onGenerateChart(); // Re-generate chart with pruned variables
        appCallbacks.colorChartTreeCallback(); // Re-color the tree
        
        // If the *currently selected node* (for variable picking) was pruned,
        // we need to refresh its variable list
        if (selectedChartTopic && regex.test(selectedChartTopic)) {
             // We need the payload, but we don't have it.
             // We'll just clear the list.
             populateChartVariables(null);
        }
    }
}


/**
 * Initializes the Chart View functionality.
 * @param {object} callbacks - An object containing callback functions from app.js
 */
export function initChartView(callbacks) {
    // [NEW] Separate appCallbacks from displayPayload
    const { displayPayload, maxSavedChartConfigs, ...otherCallbacks } = callbacks;
    appCallbacks = { ...appCallbacks, ...otherCallbacks };
    maxChartsLimit = maxSavedChartConfigs || 0; // [NEW] Store the limit

    btnChartGenerate?.addEventListener('click', onGenerateChart);
    btnChartFullscreen?.addEventListener('click', toggleChartFullscreen);
    btnChartExportPNG?.addEventListener('click', onExportPNG);
    btnChartExportCSV?.addEventListener('click', onExportCSV);
    btnChartClear?.addEventListener('click', onClearAll); 
    
    // [MODIFIED] Add listeners for new controls
    chartConfigSelect?.addEventListener('change', onChartConfigChange);
    btnChartSaveCurrent?.addEventListener('click', onSaveCurrent);
    btnChartSaveAs?.addEventListener('click', onSaveAsNew);
    btnChartDeleteConfig?.addEventListener('click', onDeleteConfig);

    // Add listeners to other controls to trigger re-gen
    chartTypeSelect?.addEventListener('change', onGenerateChart);
    chartConnectNulls?.addEventListener('change', onGenerateChart);

    // [MODIFIED] Initialize the dual time slider
    if (chartHandleMin && chartHandleMax) {
        chartSlider = createDualTimeSlider({
            containerEl: chartTimeSliderContainer,
            handleMinEl: chartHandleMin,
            handleMaxEl: chartHandleMax,
            rangeEl: chartSliderRange,
            labelMinEl: chartLabelMin,
            labelMaxEl: chartLabelMax,
            onDrag: (newMin, newMax) => {
                // This logic is from the old makeDraggable
                currentMinTimestamp = newMin;
                currentMaxTimestamp = newMax;
                
                const timeRange = maxTimestamp - minTimestamp;
                if (timeRange > 0) {
                    const minPercent = ((newMin - minTimestamp) / timeRange) * 100;
                    const maxPercent = ((newMax - minTimestamp) / timeRange) * 100;
                    // Moving max handle breaks live mode unless we're very close to the end
                    isChartLive = (maxPercent > 99.9);
                    // Moving min handle always breaks live mode
                    if (minPercent > 0) {
                        isChartLive = false;
                    }
                }
                
                // Update UI without re-filtering
                updateChartSliderUI(minTimestamp, maxTimestamp, false);
            },
            onDragEnd: (newMin, newMax) => {
                // This logic is from the old onMouseUp
                currentMinTimestamp = newMin;
                currentMaxTimestamp = newMax;
                
                // Re-check live state on mouse up for max handle
                const timeRange = maxTimestamp - minTimestamp;
                if (timeRange > 0) {
                    const maxPercent = ((newMax - minTimestamp) / timeRange) * 100;
                    isChartLive = (maxPercent > 99.9);
                }

                // We trigger a chart refresh on mouse up
                onGenerateChart();
            }
        });
    }

    loadChartConfig(); // Load saved configs on init
}

/**
 * Handles a click event on a node in the Chart tree.
 * @param {Event} event - The click event.
 * @param {HTMLElement} nodeContainer - The clicked node's container.
 * @param {string} topic - The node's topic.
 */
export function handleChartNodeClick(event, nodeContainer, topic) {
    const payload = nodeContainer.dataset.payload;
    selectedChartTopic = topic; // Update the currently viewed topic

    // Display payload using the shared function
    // [NEW] Use the payload viewer
    payloadViewer.display(topic, payload);

    // Populate the variable selection list
    // This will now respect the chartedVariables map
    populateChartVariables(payload);
}

/**
 * [MODIFIED] Updates the UI of the chart timeline slider
 * by calling the slider module.
 * @param {number} min - The minimum timestamp of all history.
 * @param {number} max - The maximum timestamp of all history.
 * @param {boolean} isInitialLoad - True if this is the first load.
 */
export function updateChartSliderUI(min, max, isInitialLoad = false) {
    if (!chartSlider) return; // Slider not initialized

    // Check if we were live BEFORE updating timestamps
    const wasLive = isChartLive;

    minTimestamp = min;
    maxTimestamp = max;

    if (isInitialLoad) {
        currentMinTimestamp = min;
        currentMaxTimestamp = max;
        isChartLive = true;
    } else if (isChartLive && wasLive) {
        // If we are in live mode and were in live mode, stick to the new edge
        currentMaxTimestamp = max;
    }
    // If user dragged (isChartLive = false), timestamps are preserved
    

    if (chartTimeSliderContainer) {
         chartTimeSliderContainer.style.display = (min === 0 && max === 0) ? 'none' : 'flex';
    }

    // [NEW] Call the slider's update method
    chartSlider.updateUI(minTimestamp, maxTimestamp, currentMinTimestamp, currentMaxTimestamp);
    
    // [MODIFIÉ] Auto-refresh chart if in live mode (with debounce)
    if (isChartLive && !isInitialLoad && chartedVariables.size > 0) {
        clearTimeout(chartRefreshTimer);
        // Rafraîchir le graphique après un court délai pour regrouper les mises à jour
        chartRefreshTimer = setTimeout(onGenerateChart, 1500); 
    }
}

/**
 * [HELPER] Safely gets a nested value from an object using a dot-notation string.
 * [MODIFIED] Now understands Sparkplug-style array paths like 'metrics[Level]'.
 * @param {object} obj - The object to search.
 * @param {string} path - The dot-notation path (e.g., "variables.temp" or "metrics[Level]").
 * @returns {*} The value, or undefined if not found.
 */
function getNestedValue(obj, path) {
    if (typeof path !== 'string' || !obj) return undefined;

    // [CORRECTION] Split by '.' or by literal '[' and ']'
    // e.g., "metrics[Level]" becomes ["metrics", "Level"]
    // e.g., "timestamp.low" becomes ["timestamp", "low"]
    const parts = path.split(/\.|\[|\]/).filter(Boolean); // Removed '\\'

    let current = obj;
    for (const part of parts) {
        if (current === undefined || current === null) return undefined;

        if (Array.isArray(current)) {
            // If we're in an array, assume it's a Sparkplug metrics array
            // and the 'part' is the 'name' we're looking for.
            const metric = current.find(m => m.name === part);
            current = metric ? metric.value : undefined;
        } else {
            // Standard object property access
            current = current[part];
        }
    }
    return current;
}


/**
 * [HELPER] Recursively finds all numeric properties in a JSON object.
 * [MODIFIED] Now handles Sparkplug 'metrics' arrays and string-based numbers.
 * @param {object} obj - The object or array to scan.
 * @param {string} path - The current path prefix.
 * @param {Array} list - The list to add results to.
 */
function findNumericKeys(obj, path = '', list = []) {
    if (obj === null || typeof obj !== 'object') return list;

    // [NEW] Special handling for arrays (like Sparkplug 'metrics')
    if (Array.isArray(obj)) {
        // Check if it looks like a Sparkplug metrics array
        if (obj.length > 0 && obj.every(item => typeof item === 'object' && item.hasOwnProperty('name') && item.hasOwnProperty('value'))) {
            obj.forEach(metric => {
                // Create a custom path like 'metrics[Level]'
                const newPath = path ? `${path}[${metric.name}]` : `[${metric.name}]`; 
                const value = metric.value;
                
                if (typeof value === 'number') {
                    list.push({ path: newPath, type: Number.isInteger(value) ? 'int' : 'float' });
                } else if (typeof value === 'string' && value.trim() !== '') {
                    // Check if string is a number
                    if (!isNaN(parseFloat(value)) && isFinite(Number(value))) {
                        list.push({ path: newPath, type: value.includes('.') ? 'float (string)' : 'int (string)' });
                    }
                }
                // Note: We don't recurse deeper into metric.value, assume it's a primitive or non-chartable
            });
        }
        // We don't process other types of arrays (e.g., [1, 2, 3]) for now.
        return list;
    }

    // Standard object property iteration (for non-array objects)
    for (const key of Object.keys(obj)) {
        const newPath = path ? `${path}.${key}` : key;
        const value = obj[key];

        if (typeof value === 'number') {
            list.push({ path: newPath, type: Number.isInteger(value) ? 'int' : 'float' });
        } else if (typeof value === 'string' && value.trim() !== '') {
            if (!isNaN(parseFloat(value)) && isFinite(Number(value))) {
                list.push({ path: newPath, type: value.includes('.') ? 'float (string)' : 'int (string)' });
            }
        } else if (typeof value === 'object') { // Recurse for both objects and arrays
            // This will pass arrays to the special handling block above
            findNumericKeys(value, newPath, list);
        }
    }
    return list;
}


/**
 * Populates the variable selection list based on the payload.
 * Checkboxes now reflect the global 'chartedVariables' state.
 * @param {string} payloadString - The JSON payload as a string.
 */
function populateChartVariables(payloadString) {
    if (!chartVariableList) return;
    chartVariableList.innerHTML = ''; // Clear old list

    // This function must only be called after selectedChartTopic is set
    if (!selectedChartTopic) {
         chartVariableList.innerHTML = '<p class="history-placeholder">No topic selected.</p>';
         return;
    }
    
    // Check for null or undefined payloadString
    if (payloadString === null || payloadString === undefined) {
         chartVariableList.innerHTML = '<p class="history-placeholder">No payload for this topic.</p>';
         return;
    }

    try {
        const payload = JSON.parse(payloadString);
        const numericKeys = findNumericKeys(payload);

        if (numericKeys.length === 0) {
            chartVariableList.innerHTML = '<p class="history-placeholder">No numeric properties found in this payload.</p>';
            return;
        }

        numericKeys.forEach(key => {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'chart-variable-item';
            
            // key.path is now 'timestamp.low' or 'metrics[Level]'
            const varId = `${selectedChartTopic}|${key.path}`;

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `chart-var-${varId.replace(/[^a-zA-Z0-9]/g, '_')}`; // Create a DOM-safe ID
            checkbox.value = varId; // Store the unique ID
            checkbox.dataset.topic = selectedChartTopic;
            checkbox.dataset.path = key.path; // Store the path
            
            // Check if this variable is in our global map
            checkbox.checked = chartedVariables.has(varId);
            
            checkbox.addEventListener('change', onChartVariableToggle);

            const label = document.createElement('label');
            label.htmlFor = checkbox.id;
            label.textContent = key.path; // Show the path e.g., 'metrics[Level]'

            const typeSpan = document.createElement('span');
            typeSpan.className = 'var-type';
            typeSpan.textContent = `(${key.type})`; // e.g., (float) or (float (string))

            label.appendChild(typeSpan);
            itemDiv.appendChild(checkbox);
            itemDiv.appendChild(label);
            chartVariableList.appendChild(itemDiv);
        });

    } catch (e) {
        chartVariableList.innerHTML = '<p class="history-placeholder">Payload is not valid JSON.</p>';
    }
}

/**
 * [MODIFIED] Handler for the "Clear All" button.
 * Resets the UI to the "New Chart" state without saving.
 */
function onClearAll() {
    chartedVariables.clear();
    
    // Uncheck any visible checkboxes
    if (chartVariableList) {
        chartVariableList.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
            cb.checked = false;
        });
    }

    // Reset UI controls
    chartTypeSelect.value = 'line';
    chartConnectNulls.checked = false;
    currentConfigId = null;
    chartConfigSelect.value = ""; // Set dropdown to "-- New Chart --"
    
    onGenerateChart(); // This will clear the chart
    appCallbacks.colorChartTreeCallback(); // This will clear the tree highlights
}

/**
 * Handler for when a chart variable checkbox is toggled.
 * This adds or removes the variable from the global map.
 */
function onChartVariableToggle(event) {
    const checkbox = event.target;
    const varId = checkbox.value; // e.g., "topic/a|metrics[Level]"

    if (checkbox.checked) {
        // Add to map
        chartedVariables.set(varId, {
            topic: checkbox.dataset.topic,
            path: checkbox.dataset.path // e.g., "metrics[Level]"
        });
    } else {
        // Remove from map
        chartedVariables.delete(varId);
    }
    
    // Regenerate the chart
    onGenerateChart();
    // Call the callback to update the tree highlighting
    appCallbacks.colorChartTreeCallback();
}


/**
 * Main function to generate or update the chart.
 * This now builds the chart from the global 'chartedVariables' map.
 * Added dynamic Y-axis generation.
 */
function onGenerateChart() {
    // [MODIFIÉ] Effacer le timer de debounce, puisque nous exécutons la fonction
    clearTimeout(chartRefreshTimer);

    // 1. Check if we have any variables to plot
    if (chartedVariables.size === 0) {
        if (chartInstance) {
            chartInstance.destroy();
            chartInstance = null;
        }
        chartPlaceholder.style.display = 'block';
        chartPlaceholder.textContent = 'Select a topic and check variables to plot, or load a saved chart.';
        chartCanvas.style.display = 'none';
        lastGeneratedData = { labels: [], datasets: [] };
        return;
    }

    // 2. Get history and filter by *time*
    const allHistory = appCallbacks.getHistory(); // This array is now capped at 5000
    const timeFilteredHistory = allHistory.filter(entry =>
        entry.timestampMs >= currentMinTimestamp &&
        entry.timestampMs <= currentMaxTimestamp
    ); // No reverse, we'll build maps

    if (timeFilteredHistory.length === 0) {
        // No data found. Clear chart and show placeholder.
        if (chartInstance) {
            chartInstance.destroy();
            chartInstance = null;
        }
        chartPlaceholder.style.display = 'block';
        chartPlaceholder.textContent = "No data found in the selected time range.";
        chartCanvas.style.display = 'none';
        lastGeneratedData = { labels: [], datasets: [] };
        return;
    }

    // 3. Get chart config from UI
    const chartType = chartTypeSelect.value;
    const connectNulls = chartConnectNulls.checked;

    // 4. Process data for chart
    let datasets = [];
    let labels = [];

    // Get shared color info
    const isDarkMode = document.body.classList.contains('dark-mode');
    const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    const textColor = isDarkMode ? '#e0e0e0' : '#333';

    // Prepare dynamic scales object
    const dynamicScales = {
        x: {
            type: 'time',
            time: {
                unit: 'second',
                tooltipFormat: 'yyyy-MM-dd HH:mm:ss'
            },
            grid: { color: gridColor },
            ticks: { color: textColor }
        }
    };


    if (chartType === 'pie') {
        const totals = {};
        // Initialize totals map
        chartedVariables.forEach((varInfo, varId) => {
            const topicParts = varInfo.topic.split('/');
            // Use path, but clean brackets for label
            const cleanPath = varInfo.path.replace(/\[|\]/g, ''); // Remove brackets
            const label = `${topicParts.slice(-2).join('/')} | ${cleanPath}`;
            totals[label] = 0;
        });

        // Sum data for each variable
        for (const entry of timeFilteredHistory) {
            for (const [varId, { topic, path }] of chartedVariables.entries()) {
                if (entry.topic === topic) {
                    try {
                        const payload = JSON.parse(entry.payload);
                        
                        // Use new getNestedValue
                        let value = getNestedValue(payload, path);
                        if (typeof value === 'string') {
                            const numVal = parseFloat(value);
                            if (!isNaN(numVal) && isFinite(Number(value))) {
                                value = numVal; // Use the parsed number
                            }
                        }
                        
                        if (typeof value === 'number') {
                            const topicParts = topic.split('/');
                            const cleanPath = path.replace(/\[|\]/g, ''); // Remove brackets
                            const label = `${topicParts.slice(-2).join('/')} | ${cleanPath}`;
                            totals[label] += value;
                        }
                    } catch (e) { /* ignore invalid JSON */ }
                }
            }
        }

        datasets = [{
            data: Object.values(totals),
            backgroundColor: Object.keys(totals).map((_, i) => `hsl(${(i * 360 / chartedVariables.size)}, 70%, 50%)`),
        }];
        labels = Object.keys(totals);

    } else {
        // Line or Bar chart
        let allTimestamps = new Set();
        let dataByVar = new Map(); // Key: varId, Value: Map(timestampMs -> value)

        // Pass 1: Collect all data points and timestamps for charted variables
        for (const [varId, { topic, path }] of chartedVariables.entries()) {
            const varData = new Map();
            for (const entry of timeFilteredHistory) {
                if (entry.topic === topic) {
                    try {
                        const payload = JSON.parse(entry.payload);
                        
                        // Use new getNestedValue
                        let value = getNestedValue(payload, path);
                        if (typeof value === 'string') {
                            const numVal = parseFloat(value);
                            if (!isNaN(numVal) && isFinite(Number(value))) {
                                value = numVal; // Use the parsed number
                            }
                        }
                        
                        if (typeof value === 'number') {
                            varData.set(entry.timestampMs, value);
                            allTimestamps.add(entry.timestampMs);
                        }
                    } catch (e) { /* ignore */ }
                }
            }
            dataByVar.set(varId, varData);
        }

        if (allTimestamps.size === 0) {
             if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
             chartPlaceholder.style.display = 'block';
             chartPlaceholder.textContent = "No numeric data found for selected variables in this time range.";
             chartCanvas.style.display = 'none';
             lastGeneratedData = { labels: [], datasets: [] };
             return;
        }

        // Create the master X-axis (labels)
        labels = Array.from(allTimestamps).sort((a, b) => a - b);
        
        // Pass 2: Build datasets AND dynamic Y-axes
        let i = 0;
        for (const [varId, { topic, path }] of chartedVariables.entries()) {
            const color = `hsl(${(i * 360 / chartedVariables.size)}, 70%, 50%)`;
            const varDataMap = dataByVar.get(varId);
            
            // Map each master timestamp to its value, or null if it doesn't exist
            const data = labels.map(ts => varDataMap.get(ts) ?? null);

            const topicParts = topic.split('/');
            // Use path, but clean brackets for label
            const cleanPath = path.replace(/\[|\]/g, ''); // Remove brackets
            const label = `${topicParts.slice(-2).join('/')} | ${cleanPath}`;
            
            const yAxisId = `y${i}`; // e.g., y0, y1, y2
            const position = (i % 2 === 0) ? 'left' : 'right'; // Alternate position

            datasets.push({
                label: label,
                data: data,
                borderColor: color,
                backgroundColor: color,
                fill: false,
                spanGaps: connectNulls,
                tension: 0.1,
                yAxisID: yAxisId // Assign dataset to this axis
            });

            // Add the scale configuration for this axis
            dynamicScales[yAxisId] = {
                type: 'linear',
                position: position,
                grid: {
                    // Only draw gridlines for the first axis (y0)
                    drawOnChartArea: (i === 0), 
                },
                ticks: {
                    color: color, // Match tick color to line color
                },
            };
            i++;
        }
    }

    // 5. Render Chart
    if (chartInstance) {
        chartInstance.destroy();
    }

    chartPlaceholder.style.display = 'none';
    chartPlaceholder.textContent = 'Select a topic, choose variables, and click "Refresh", or load a saved chart.'; // Reset placeholder text
    chartCanvas.style.display = 'block';

    chartInstance = new Chart(chartCanvas, {
        type: chartType,
        data: {
            labels: labels,
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            // Use the dynamically built scales object
            scales: (chartType === 'pie') ? {} : dynamicScales,
            plugins: {
                legend: {
                    labels: { color: textColor }
                },
                tooltip: {
                    mode: 'index',
                    intersect: false
                }
            },
            animation: false
        }
    });

    // Save for export
    lastGeneratedData = { labels, datasets };
}

/**
 * Toggles fullscreen mode for the chart area.
 */
function toggleChartFullscreen() {
    if (!chartMainArea) return;
    
    if (!document.fullscreenElement) {
        chartMainArea.requestFullscreen().catch(err => {
            console.error(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
        });
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        }
    }
}

/**
 * Exports the current chart as a PNG.
 */
function onExportPNG() {
    if (!chartInstance) {
        alert("Please generate a chart first.");
        return;
    }
    const a = document.createElement('a');
    a.href = chartInstance.toBase64Image();
    a.download = `multi_topic_chart.png`;
    a.click();
}

/**
 * Exports the data used for the last chart generation as a CSV.
 * This now uses the chart's data model (labels + datasets).
 */
function onExportCSV() {
    const { labels, datasets } = lastGeneratedData;

    if (!labels || labels.length === 0 || !datasets || datasets.length === 0) {
        alert("Please generate a chart first.");
        return;
    }
    
    const chartType = chartTypeSelect.value;
    let csvContent = "data:text/csv;charset=utf-8,";

    if (chartType === 'pie') {
        // Handle Pie chart export
        csvContent += "Variable,Total\r\n";
        chartInstance.data.labels.forEach((label, index) => {
            const value = chartInstance.data.datasets[0].data[index];
            csvContent += `"${label}",${value}\r\n`;
        });

    } else {
        // Handle Line/Bar chart export
        const headers = ['timestamp', ...datasets.map(d => `"${d.label}"`)]; // Quote labels
        csvContent += headers.join(',') + '\r\n';

        // Data rows
        labels.forEach((timestamp, index) => {
            const row = [new Date(timestamp).toISOString()]; // Use ISO string for timestamp
            datasets.forEach(ds => {
                const value = ds.data[index];
                row.push(value ?? ''); // Add value or empty string for null
            });
            csvContent += row.join(',') + '\r\n';
        });
    }

    const encodedUri = encodeURI(csvContent);
    const a = document.createElement('a');
    a.href = encodedUri;
    a.download = 'chart_data.csv';
    a.click();
}

/**
 * [REMOVED] makeDraggable(handle, isMin)
 * This logic is now in public/time-slider.js
 */

/**
 * [NEW] Helper to show a save status message.
 */
function showChartSaveStatus(message, type = 'success') {
    if (!chartSaveStatus) return;
    chartSaveStatus.textContent = message;
    chartSaveStatus.className = type;
    clearTimeout(chartSaveTimer);
    chartSaveTimer = setTimeout(() => {
        chartSaveStatus.textContent = '';
        chartSaveStatus.className = '';
    }, 3000);
}

/**
 * [MODIFIED] Loads the saved chart configurations from the server.
 * [FIX] This function now loads the *first* config by default,
 * or calls onClearAll() if no configs are saved.
 */
async function loadChartConfig() {
    try {
        const response = await fetch('api/chart/config');
        if (!response.ok) throw new Error('Failed to fetch chart config');
        let savedConfig = await response.json(); // This is now { configurations: [...] } or old array

        // [NEW] Migration logic for old array format
        if (Array.isArray(savedConfig)) {
            console.warn("Old chart config format detected. Migrating...");
            allChartConfigs = {
                configurations: [
                    {
                        id: `chart_${Date.now()}`,
                        name: "Migrated Chart",
                        chartType: "line",
                        connectNulls: false,
                        variables: savedConfig // The old array is now the 'variables'
                    }
                ]
            };
            // Immediately save the new structure back
            await saveAllChartConfigs(allChartConfigs, false); // 'false' = don't show status
        } else if (savedConfig && Array.isArray(savedConfig.configurations)) {
            allChartConfigs = savedConfig; // It's the new format
        } else {
            allChartConfigs = { configurations: [] }; // Fallback for corrupt data
        }
        
        console.log(`Loaded ${allChartConfigs.configurations.length} saved charts.`);

        // Refresh UI
        populateChartConfigSelect(); // Fills the dropdown
        
        // [FIXED LOGIC]
        if (allChartConfigs.configurations.length > 0) {
            // If we have saved charts, load the first one by default.
            const firstConfigId = allChartConfigs.configurations[0].id;
            chartConfigSelect.value = firstConfigId; // Set the dropdown
            onChartConfigChange(); // Manually trigger the load
        } else {
            // No saved charts, just start fresh.
            onClearAll(); 
        }
        // [END FIXED LOGIC]

    } catch (error) {
        console.error('Error loading chart config:', error);
        showChartSaveStatus('Load failed', 'error');
    }
}

/**
 * [NEW] Populates the <select> dropdown with saved charts.
 */
function populateChartConfigSelect() {
    if (!chartConfigSelect) return;
    
    chartConfigSelect.innerHTML = ''; // Clear old options
    
    // Add the "New Chart" default option
    const newOption = document.createElement('option');
    newOption.value = "";
    newOption.textContent = "-- New Chart --";
    chartConfigSelect.appendChild(newOption);

    // Add all saved charts
    allChartConfigs.configurations.forEach(config => {
        const option = document.createElement('option');
        option.value = config.id;
        option.textContent = config.name;
        chartConfigSelect.appendChild(option);
    });
    
    // Set the dropdown to the currently loaded config (or "New Chart")
    chartConfigSelect.value = currentConfigId || "";
}

/**
 * [NEW] Handles the 'change' event on the chart config <select>.
 */
function onChartConfigChange() {
    const configId = chartConfigSelect.value;
    currentConfigId = configId;
    
    if (!configId) {
        // User selected "-- New Chart --"
        onClearAll();
        return;
    }
    
    // Find the config and load it
    const config = allChartConfigs.configurations.find(c => c.id === configId);
    if (!config) {
        console.error(`Could not find config with ID: ${configId}`);
        onClearAll(); // Reset to be safe
        return;
    }
    
    // Load the config into the UI
    chartTypeSelect.value = config.chartType || 'line';
    chartConnectNulls.checked = config.connectNulls || false;
    
    // Load variables
    chartedVariables.clear();
    if (Array.isArray(config.variables)) {
        config.variables.forEach(v => {
            const varId = `${v.topic}|${v.path}`;
            chartedVariables.set(varId, v);
        });
    }
    
    // Refresh UI
    onGenerateChart();
    appCallbacks.colorChartTreeCallback();
    if (selectedChartTopic) {
        // If a topic is already selected, refresh its variable list
        const node = document.querySelector(`.node-container[data-topic="${selectedChartTopic}"]`);
        if(node) populateChartVariables(node.dataset.payload);
    }
    
    showChartSaveStatus(`Loaded '${config.name}'`, 'success');
}

/**
 * [NEW] Saves all chart configurations back to the server.
 * @param {object} configObject - The entire config object { configurations: [...] }.
 * @param {boolean} [showStatus=true] - Whether to show the "Saving..." message.
 * @returns {Promise<boolean>} True on success, false on failure.
 */
async function saveAllChartConfigs(configObject, showStatus = true) {
    if (showStatus) {
        showChartSaveStatus('Saving...', 'success');
    }
    
    try {
        const response = await fetch('api/chart/config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(configObject),
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Failed to save');
        }
        
        allChartConfigs = configObject; // Update local state
        
        if (showStatus) {
            showChartSaveStatus('Saved!', 'success');
        }
        return true;

    } catch (error) {
        console.error('Error saving chart config:', error);
        if (showStatus) {
            showChartSaveStatus(`Error: ${error.message}`, 'error');
        }
        return false;
    }
}

/**
 * [NEW] Handles the "Save" button click. Saves over the current config or triggers "Save As".
 */
async function onSaveCurrent() {
    if (!currentConfigId) {
        // No config is loaded, so this is a "Save As"
        onSaveAsNew();
        return;
    }
    
    // Find the config to update
    const config = allChartConfigs.configurations.find(c => c.id === currentConfigId);
    if (!config) {
        console.error(`Cannot save, config ID ${currentConfigId} not found.`);
        showChartSaveStatus('Error: Config not found', 'error');
        return;
    }
    
    // Update the config object with current UI state
    config.name = chartConfigSelect.options[chartConfigSelect.selectedIndex].text; // Get name from dropdown
    config.chartType = chartTypeSelect.value;
    config.connectNulls = chartConnectNulls.checked;
    config.variables = Array.from(chartedVariables.values());
    
    // Save the entire config object
    await saveAllChartConfigs(allChartConfigs);
}

/**
 * [MODIFIED] Handles the "Save As..." button click.
 * Now checks the limit before saving.
 */
async function onSaveAsNew() {
    // [NEW] Check limit
    if (maxChartsLimit > 0 && allChartConfigs.configurations.length >= maxChartsLimit) {
        alert(`Cannot save new chart. You have reached the maximum limit of ${maxChartsLimit} saved charts.
Please delete an old chart configuration before saving a new one.`);
        return; // Stop execution
    }

    const name = prompt("Enter a name for this new chart configuration:");
    if (!name || name.trim().length === 0) {
        return; // User cancelled
    }
    
    // Create new config object
    const newConfig = {
        id: `chart_${Date.now()}`,
        name: name.trim(),
        chartType: chartTypeSelect.value,
        connectNulls: chartConnectNulls.checked,
        variables: Array.from(chartedVariables.values())
    };
    
    allChartConfigs.configurations.push(newConfig);
    currentConfigId = newConfig.id; // Set this as the new active config
    
    // Save and wait for it to complete
    const success = await saveAllChartConfigs(allChartConfigs);
    
    if (success) {
        // Refresh the dropdown to show the new item
        populateChartConfigSelect();
    }
}

/**
 * [NEW] Handles the "Delete" button click.
 */
async function onDeleteConfig() {
    if (!currentConfigId) {
        alert("No chart configuration is selected to delete.");
        return;
    }
    
    const configName = chartConfigSelect.options[chartConfigSelect.selectedIndex].text;
    if (!confirm(`Are you sure you want to delete the chart configuration "${configName}"?`)) {
        return;
    }
    
    // Filter out the config to delete
    allChartConfigs.configurations = allChartConfigs.configurations.filter(
        c => c.id !== currentConfigId
    );
    
    // Save the modified config object
    const success = await saveAllChartConfigs(allChartConfigs);
    
    if (success) {
        // Reset the UI
        onClearAll();
        // Refresh the dropdown
        populateChartConfigSelect();
    }
}