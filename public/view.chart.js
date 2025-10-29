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
const chartTreeContainer = document.getElementById('chart-tree');
const chartPayloadTopic = document.getElementById('chart-payload-topic');
const chartPayloadContent = document.getElementById('chart-payload-content');
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

// Time Slider Elements
const chartTimeSliderContainer = document.getElementById('chart-time-range-slider-container');
const chartHandleMin = document.getElementById('chart-handle-min');
const chartHandleMax = document.getElementById('chart-handle-max');
const chartSliderRange = document.getElementById('chart-slider-range');
const chartLabelMin = document.getElementById('chart-label-min');
const chartLabelMax = document.getElementById('chart-label-max');


// --- Module-level State ---
let chartInstance = null;
let selectedChartNode = null; // The node selected in the tree UI
let selectedChartTopic = null; // The topic path for the selected UI node
let lastGeneratedData = { labels: [], datasets: [] }; // For CSV export
let chartedVariables = new Map(); // Stores all variables to be charted, key = 'topic|path'

let minTimestamp = 0;
let maxTimestamp = 0;
let currentMinTimestamp = 0;
let currentMaxTimestamp = 0;

// --- Callbacks from main app.js ---
let appCallbacks = {
    getHistory: () => [],
    displayPayload: () => console.error("displayPayload callback not set"),
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
 * Removes any charted variables that match a topic pattern.
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
    }
}

/**
 * Initializes the Chart View functionality.
 * @param {object} callbacks - An object containing callback functions from app.js
 */
export function initChartView(callbacks) {
    appCallbacks = { ...appCallbacks, ...callbacks };

    btnChartGenerate?.addEventListener('click', onGenerateChart);
    btnChartFullscreen?.addEventListener('click', toggleChartFullscreen);
    btnChartExportPNG?.addEventListener('click', onExportPNG);
    btnChartExportCSV?.addEventListener('click', onExportCSV);
    btnChartClear?.addEventListener('click', onClearAll); 

    // Add listeners to other controls to trigger re-gen
    chartTypeSelect?.addEventListener('change', onGenerateChart);
    chartConnectNulls?.addEventListener('change', onGenerateChart);

    if (chartHandleMin && chartHandleMax) {
        makeDraggable(chartHandleMin, true);
        makeDraggable(chartHandleMax, false);
    }
}

/**
 * Handles a click event on a node in the Chart tree.
 * @param {Event} event - The click event.
 */
export function handleChartNodeClick(event) {
    const targetContainer = event.currentTarget;
    const li = targetContainer.closest('li');

    // Manage selection
    if (selectedChartNode) {
        selectedChartNode.classList.remove('selected');
    }
    selectedChartNode = targetContainer;
    selectedChartNode.classList.add('selected');

    const topic = targetContainer.dataset.topic;
    const payload = targetContainer.dataset.payload;
    
    selectedChartTopic = topic; // Update the currently viewed topic

    // Display payload using the shared function
    appCallbacks.displayPayload(topic, payload, chartPayloadTopic, chartPayloadContent);

    // Populate the variable selection list
    // This will now respect the chartedVariables map
    populateChartVariables(payload);
}

/**
 * Updates the UI of the chart timeline slider.
 * @param {number} min - The minimum timestamp of all history.
 * @param {number} max - The maximum timestamp of all history.
 * @param {boolean} isInitialLoad - True if this is the first load.
 */
export function updateChartSliderUI(min, max, isInitialLoad = false) {
    if (!chartHandleMin || !chartHandleMax) return;

    minTimestamp = min;
    maxTimestamp = max;

    if (isInitialLoad) {
        currentMinTimestamp = min;
        currentMaxTimestamp = max;
    }

    if (chartTimeSliderContainer) {
         chartTimeSliderContainer.style.display = (min === 0 && max === 0) ? 'none' : 'flex';
    }

    const timeRange = maxTimestamp - minTimestamp;
    if (timeRange <= 0) {
        // Handle case with one or zero messages
        chartHandleMin.style.left = '0%';
        chartHandleMax.style.left = '100%';
        chartSliderRange.style.left = '0%';
        chartSliderRange.style.width = '100%';
        chartLabelMin.textContent = formatTimestampForLabel(currentMinTimestamp);
        chartLabelMax.textContent = formatTimestampForLabel(currentMaxTimestamp);
        return;
    }

    const minPercent = ((currentMinTimestamp - minTimestamp) / timeRange) * 100;
    const maxPercent = ((currentMaxTimestamp - minTimestamp) / timeRange) * 100;

    chartHandleMin.style.left = `${minPercent}%`;
    chartHandleMax.style.left = `${maxPercent}%`;
    chartSliderRange.style.left = `${minPercent}%`;
    chartSliderRange.style.width = `${maxPercent - minPercent}%`;
    chartLabelMin.textContent = formatTimestampForLabel(currentMinTimestamp);
    chartLabelMax.textContent = formatTimestampForLabel(currentMaxTimestamp);
}

/**
 * [HELPER] Safely gets a nested value from an object using a dot-notation string.
 * @param {object} obj - The object to search.
 * @param {string} path - The dot-notation path (e.g., "variables.temp").
 * @returns {*} The value, or undefined if not found.
 */
function getNestedValue(obj, path) {
    if (typeof path !== 'string' || !obj) return undefined;
    return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
}

/**
 * [HELPER] Recursively finds all numeric properties in a JSON object.
 * Now also detects strings that are valid numbers.
 * @param {object} obj - The object to scan.
 * @param {string} path - The current path prefix.
 * @param {Array} list - The list to add results to.
 */
function findNumericKeys(obj, path = '', list = []) {
    if (obj === null || typeof obj !== 'object') return list;

    for (const key of Object.keys(obj)) {
        const newPath = path ? `${path}.${key}` : key;
        const value = obj[key];

        if (typeof value === 'number') {
            // It's already a number
            list.push({ path: newPath, type: Number.isInteger(value) ? 'int' : 'float' });
        
        } else if (typeof value === 'string' && value.trim() !== '') {
            // Check if it's a string that represents a number
            if (!isNaN(parseFloat(value)) && isFinite(Number(value))) {
                list.push({ path: newPath, type: value.includes('.') ? 'float (string)' : 'int (string)' });
            }
        
        } else if (typeof value === 'object' && !Array.isArray(value)) {
            // Recurse into sub-objects
            findNumericKeys(value, newPath, list);
        }
        // We ignore arrays for simplicity
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
    if (!selectedChartTopic) return;

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

            const varId = `${selectedChartTopic}|${key.path}`;

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `chart-var-${varId.replace(/[^a-zA-Z0-9]/g, '_')}`; // Create a DOM-safe ID
            checkbox.value = varId; // Store the unique ID
            checkbox.dataset.topic = selectedChartTopic;
            checkbox.dataset.path = key.path;
            
            // Check if this variable is in our global map
            checkbox.checked = chartedVariables.has(varId);
            
            checkbox.addEventListener('change', onChartVariableToggle);

            const label = document.createElement('label');
            label.htmlFor = checkbox.id;
            label.textContent = key.path;

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
 * Handler for the "Clear All" button.
 */
function onClearAll() {
    chartedVariables.clear();
    
    // Uncheck any visible checkboxes
    if (chartVariableList) {
        chartVariableList.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
            cb.checked = false;
        });
    }
    
    onGenerateChart(); // This will clear the chart
    appCallbacks.colorChartTreeCallback(); // This will clear the tree highlights
}

/**
 * Handler for when a chart variable checkbox is toggled.
 * This adds or removes the variable from the global map.
 */
function onChartVariableToggle(event) {
    const checkbox = event.target;
    const varId = checkbox.value; // e.g., "topic/a|value"

    if (checkbox.checked) {
        // Add to map
        chartedVariables.set(varId, {
            topic: checkbox.dataset.topic,
            path: checkbox.dataset.path
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
 * [MODIFIED] Added dynamic Y-axis generation.
 */
function onGenerateChart() {
    // 1. Check if we have any variables to plot
    if (chartedVariables.size === 0) {
        if (chartInstance) {
            chartInstance.destroy();
            chartInstance = null;
        }
        chartPlaceholder.style.display = 'block';
        chartPlaceholder.textContent = "Select a topic and check variables to plot.";
        chartCanvas.style.display = 'none';
        lastGeneratedData = { labels: [], datasets: [] };
        return;
    }

    // 2. Get history and filter by *time*
    const allHistory = appCallbacks.getHistory();
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

    // 3. Get chart config
    const chartType = chartTypeSelect.value;
    const connectNulls = chartConnectNulls.checked;

    // 4. Process data for chart
    let datasets = [];
    let labels = [];

    // [MODIFIED] Get shared color info
    const isDarkMode = document.body.classList.contains('dark-mode');
    const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    const textColor = isDarkMode ? '#e0e0e0' : '#333';

    // [NEW] Prepare dynamic scales object
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
            const label = `${topicParts.slice(-2).join('/')} | ${varInfo.path}`;
            totals[label] = 0;
        });

        // Sum data for each variable
        for (const entry of timeFilteredHistory) {
            for (const [varId, { topic, path }] of chartedVariables.entries()) {
                if (entry.topic === topic) {
                    try {
                        const payload = JSON.parse(entry.payload);
                        
                        let value = getNestedValue(payload, path);
                        if (typeof value === 'string') {
                            const numVal = parseFloat(value);
                            if (!isNaN(numVal) && isFinite(Number(value))) {
                                value = numVal; // Use the parsed number
                            }
                        }
                        
                        if (typeof value === 'number') {
                            const topicParts = topic.split('/');
                            const label = `${topicParts.slice(-2).join('/')} | ${path}`;
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
            const label = `${topicParts.slice(-2).join('/')} | ${path}`;
            
            // [NEW] Define Y-axis ID and position
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
                yAxisID: yAxisId // [NEW] Assign dataset to this axis
            });

            // [NEW] Add the scale configuration for this axis
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
    chartPlaceholder.textContent = "Select a topic, choose variables, and click \"Generate Chart\"."; // Reset placeholder text
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
            // [MODIFIED] Use the dynamically built scales object
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
 * Makes a slider handle draggable.
 * @param {HTMLElement} handle - The handle element.
 * @param {boolean} isMin - True if this is the minimum handle.
 */
function makeDraggable(handle, isMin) {
    if (!handle || !chartTimeSliderContainer) return;

    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const sliderRect = chartTimeSliderContainer.getBoundingClientRect();

        const onMouseMove = (moveEvent) => {
            let x = moveEvent.clientX - sliderRect.left;
            let percent = (x / sliderRect.width) * 100;
            percent = Math.max(0, Math.min(100, percent));
            
            const timeRange = maxTimestamp - minTimestamp;
            if (timeRange <= 0) return; // Don't drag if no range
            
            const newTimestamp = minTimestamp + (timeRange * percent / 100);

            if (isMin) {
                currentMinTimestamp = Math.min(newTimestamp, currentMaxTimestamp);
            } else {
                currentMaxTimestamp = Math.max(newTimestamp, currentMinTimestamp);
            }
            // Update UI without re-filtering
            updateChartSliderUI(minTimestamp, maxTimestamp, false);
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            // We trigger a chart refresh on mouse up
            onGenerateChart();
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}