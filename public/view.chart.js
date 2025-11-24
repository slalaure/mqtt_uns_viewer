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
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies substantial portions of the Software.
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
import { formatTimestampForLabel, trackEvent } from './utils.js'; 
import { createPayloadViewer } from './payload-viewer.js';
import { createDualTimeSlider }from './time-slider.js';

// ... (DOM Elements Querying - Unchanged) ...
const chartVariableList = document.getElementById('chart-variable-list');
const chartMainArea = document.getElementById('chart-main-area');
const chartCanvas = document.getElementById('chart-canvas');
const chartPlaceholder = document.getElementById('chart-placeholder');
const btnChartFullscreen = document.getElementById('btn-chart-fullscreen');
const btnChartExportCSV = document.getElementById('btn-chart-export-csv');
const btnChartExportPNG = document.getElementById('btn-chart-export-png');
const btnChartClear = document.getElementById('btn-chart-clear'); 
const chartTypeSelect = document.getElementById('chart-type-select');
const chartConnectNulls = document.getElementById('chart-connect-nulls-toggle');
const chartConfigSelect = document.getElementById('chart-config-select');
const btnChartSaveCurrent = document.getElementById('btn-chart-save-current');
const btnChartSaveAs = document.getElementById('btn-chart-save-as');
const btnChartDeleteConfig = document.getElementById('btn-chart-delete-config');
const chartSaveStatus = document.getElementById('chart-save-status');
const chartStartDateInput = document.getElementById('chart-start-date');
const chartEndDateInput = document.getElementById('chart-end-date');
const chartRangeButtonsContainer = document.getElementById('chart-range-buttons');
const chartTimeSliderContainer = document.getElementById('chart-time-range-slider-container');
const chartHandleMin = document.getElementById('chart-handle-min');
const chartHandleMax = document.getElementById('chart-handle-max');
const chartSliderRange = document.getElementById('chart-slider-range');
const chartLabelMin = document.getElementById('chart-label-min');
const chartLabelMax = document.getElementById('chart-label-max');

// --- Module-level State ---
let chartInstance = null;
let selectedChartBrokerId = null; 
let selectedChartTopic = null; 
let lastGeneratedData = { labels: [], datasets: [] }; 
let chartedVariables = new Map(); 

let minTimestamp = 0;
let maxTimestamp = 0;
let currentMinTimestamp = 0;
let currentMaxTimestamp = 0;

let isChartLive = true; 
let chartSaveTimer = null;
let allChartConfigs = { configurations: [] }; 
let currentConfigId = null; 
let maxChartsLimit = 0; 
let isMultiBroker = false; 

let chartSlider = null; 
let chartRefreshTimer = null; 
let isUserInteracting = false;
let lastSliderUpdate = 0;

// Configuration for Downsampling
const MAX_POINTS_PER_SERIES = 1500; // Target number of points to display per series

let payloadViewer = createPayloadViewer({
    topicEl: document.getElementById('chart-payload-topic'),
    contentEl: document.getElementById('chart-payload-content'),
    historyLogEl: null, 
    placeholderEl: null,
    isMultiBroker: false 
});

let appCallbacks = {
    getHistory: () => [],
    requestRangeCallback: null, 
    colorChartTreeCallback: () => console.error("colorChartTreeCallback not set"), 
};

/**
 * External refresh trigger (called by app.js when new data arrives)
 */
export function refreshChart() {
    // Data arrived, we can process and hide loader
    onGenerateChart(false); 
}

export function getChartedTopics() { return chartedVariables; }

export function pruneChartedVariables(regex) {
    let wasPruned = false;
    for (const [varId, varInfo] of chartedVariables.entries()) {
        if (regex.test(varInfo.topic)) { 
            chartedVariables.delete(varId);
            wasPruned = true;
        }
    }
    if (wasPruned) {
        onGenerateChart(); 
        appCallbacks.colorChartTreeCallback(); 
        if (selectedChartTopic && regex.test(selectedChartTopic)) populateChartVariables(null);
    }
}

function toDateTimeLocal(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    const offsetMs = d.getTimezoneOffset() * 60 * 1000;
    return (new Date(d.getTime() - offsetMs)).toISOString().slice(0, 16);
}

function showChartLoader() {
    if (chartPlaceholder) {
        chartPlaceholder.style.display = 'block';
        chartPlaceholder.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: center; gap: 10px;">
                <div class="broker-dot" style="background-color: var(--color-primary); animation: blink 1s infinite;"></div>
                <span>Loading and processing data...</span>
            </div>`;
    }
    if (chartCanvas) chartCanvas.style.opacity = '0.5';
}

function hideChartLoader() {
    if (chartCanvas) chartCanvas.style.opacity = '1';
    // Placeholder hiding is handled in render logic depending on data availability
}

export function initChartView(callbacks) {
    const { displayPayload, maxSavedChartConfigs, isMultiBroker: multiBrokerState, requestRangeCallback, ...otherCallbacks } = callbacks;
    appCallbacks = { ...appCallbacks, ...otherCallbacks };
    if (requestRangeCallback) appCallbacks.requestRangeCallback = requestRangeCallback;

    maxChartsLimit = maxSavedChartConfigs || 0; 
    isMultiBroker = multiBrokerState || false; 
    
    payloadViewer = createPayloadViewer({
        topicEl: document.getElementById('chart-payload-topic'),
        contentEl: document.getElementById('chart-payload-content'),
        isMultiBroker: isMultiBroker
    });

    btnChartFullscreen?.addEventListener('click', toggleChartFullscreen);
    btnChartExportPNG?.addEventListener('click', onExportPNG);
    btnChartExportCSV?.addEventListener('click', onExportCSV);
    btnChartClear?.addEventListener('click', onClearAll); 
    chartConfigSelect?.addEventListener('change', onChartConfigChange);
    btnChartSaveCurrent?.addEventListener('click', onSaveCurrent);
    btnChartSaveAs?.addEventListener('click', onSaveAsNew);
    btnChartDeleteConfig?.addEventListener('click', onDeleteConfig);
    chartTypeSelect?.addEventListener('change', () => onGenerateChart(true));
    chartConnectNulls?.addEventListener('change', () => onGenerateChart(true));

    if (chartRangeButtonsContainer) {
        const createRangeBtn = (text, hours) => {
            const btn = document.createElement('button');
            btn.textContent = text;
            btn.className = 'chart-button';
            btn.style.padding = '4px 8px';
            btn.style.fontSize = '0.85em';
            btn.onclick = () => setRelativeRange(hours);
            return btn;
        };
        chartRangeButtonsContainer.innerHTML = ''; 
        chartRangeButtonsContainer.appendChild(createRangeBtn('1h', 1));
        chartRangeButtonsContainer.appendChild(createRangeBtn('6h', 6));
        chartRangeButtonsContainer.appendChild(createRangeBtn('24h', 24));
        chartRangeButtonsContainer.appendChild(createRangeBtn('7d', 24*7));
        chartRangeButtonsContainer.appendChild(createRangeBtn('Full', 'FULL'));
    }

    const onDateChange = () => {
        const start = chartStartDateInput.value ? new Date(chartStartDateInput.value).getTime() : 0;
        const end = chartEndDateInput.value ? new Date(chartEndDateInput.value).getTime() : Date.now();
        if (start && end && start < end) {
            isChartLive = (Math.abs(end - Date.now()) < 60000);
            currentMinTimestamp = start;
            currentMaxTimestamp = end;
            updateChartSliderUI(minTimestamp, maxTimestamp, false, true); 
            triggerDataFetch(start, end);
        }
    };
    chartStartDateInput?.addEventListener('change', onDateChange);
    chartEndDateInput?.addEventListener('change', onDateChange);

    if (chartHandleMin && chartHandleMax) {
        chartSlider = createDualTimeSlider({
            containerEl: chartTimeSliderContainer,
            handleMinEl: chartHandleMin,
            handleMaxEl: chartHandleMax,
            rangeEl: chartSliderRange,
            labelMinEl: chartLabelMin,
            labelMaxEl: chartLabelMax,
            onDrag: (newMin, newMax) => {
                isUserInteracting = true; 
                currentMinTimestamp = newMin;
                currentMaxTimestamp = newMax;
                const timeRange = maxTimestamp - minTimestamp;
                if (timeRange > 0) {
                    const maxPercent = ((newMax - minTimestamp) / timeRange) * 100;
                    isChartLive = (maxPercent > 99.9);
                }
                if (chartStartDateInput) chartStartDateInput.value = toDateTimeLocal(currentMinTimestamp);
                if (chartEndDateInput) chartEndDateInput.value = toDateTimeLocal(currentMaxTimestamp);
                if (chartSlider) {
                    chartSlider.updateUI(minTimestamp, maxTimestamp, currentMinTimestamp, currentMaxTimestamp);
                }
            },
            onDragEnd: (newMin, newMax) => {
                isUserInteracting = false;
                currentMinTimestamp = newMin;
                currentMaxTimestamp = newMax;
                if (chartStartDateInput) chartStartDateInput.value = toDateTimeLocal(currentMinTimestamp);
                if (chartEndDateInput) chartEndDateInput.value = toDateTimeLocal(currentMaxTimestamp);
                triggerDataFetch(newMin, newMax);
            }
        });
    }
    loadChartConfig(); 
}

function triggerDataFetch(start, end) {
    showChartLoader();
    clearTimeout(chartRefreshTimer);
    chartRefreshTimer = setTimeout(() => {
        if (appCallbacks.requestRangeCallback) {
            // Request backend data. The app.js will call refreshChart() when data arrives.
            appCallbacks.requestRangeCallback(start, end, null);
        } else {
            // Fallback for standalone mode
            onGenerateChart();
        }
    }, 200);
}

function setRelativeRange(hours) {
    let start, end = Date.now();
    isUserInteracting = false;
    if (hours === 'FULL') {
        start = (minTimestamp > 0) ? minTimestamp : end - (24 * 60 * 60 * 1000); 
        isChartLive = true;
    } else {
        start = end - (hours * 60 * 60 * 1000);
        if (minTimestamp > 0 && start < minTimestamp) start = minTimestamp;
        isChartLive = true;
    }
    currentMinTimestamp = start;
    currentMaxTimestamp = end;
    updateChartSliderUI(minTimestamp, maxTimestamp, false, true);
    triggerDataFetch(start, end);
}

export function handleChartNodeClick(event, nodeContainer, brokerId, topic) {
    const payload = nodeContainer.dataset.payload;
    selectedChartBrokerId = brokerId;
    selectedChartTopic = topic; 
    payloadViewer.display(brokerId, topic, payload);
    populateChartVariables(payload);
}

export function updateChartSliderUI(min, max, isInitialLoad = false, force = false) {
    if (!chartSlider) return; 
    if (isUserInteracting && !force) return;
    // Debounce high-frequency updates from live stream
    if (!isInitialLoad && !force && Date.now() - lastSliderUpdate < 1000) return;
    
    lastSliderUpdate = Date.now();
    minTimestamp = min;
    maxTimestamp = max;

    if (isInitialLoad) {
        currentMinTimestamp = min;
        currentMaxTimestamp = max;
        isChartLive = true;
    } else if (isChartLive && !force) {
        const duration = currentMaxTimestamp - currentMinTimestamp;
        currentMaxTimestamp = max;
        currentMinTimestamp = max - duration;
        if (currentMinTimestamp < min) currentMinTimestamp = min;
    }

    if (chartStartDateInput) chartStartDateInput.value = toDateTimeLocal(currentMinTimestamp);
    if (chartEndDateInput) chartEndDateInput.value = toDateTimeLocal(currentMaxTimestamp);
    if (chartTimeSliderContainer) chartTimeSliderContainer.style.display = (min === 0 && max === 0) ? 'none' : 'flex';

    chartSlider.updateUI(minTimestamp, maxTimestamp, currentMinTimestamp, currentMaxTimestamp);
    
    if (isChartLive && !isInitialLoad && !force && chartedVariables.size > 0) {
        onGenerateChart(false); 
    }
}

// --- Helpers: Parsing ---

function getNestedValue(obj, path) {
    if (typeof path !== 'string' || !obj) return undefined;
    const parts = path.split(/\.|\[|\]/).filter(Boolean); 
    let current = obj;
    for (const part of parts) {
        if (current === undefined || current === null) return undefined;
        if (Array.isArray(current)) {
            const metric = current.find(m => m.name === part);
            current = metric ? metric.value : undefined;
        } else {
            current = current[part];
        }
    }
    return current;
}

function findNumericKeys(obj, path = '', list = []) {
    if (obj === null || typeof obj !== 'object') return list;
    if (Array.isArray(obj)) {
        if (obj.length > 0 && obj.every(item => typeof item === 'object' && item.hasOwnProperty('name') && item.hasOwnProperty('value'))) {
            obj.forEach(metric => {
                const newPath = path ? `${path}[${metric.name}]` : `[${metric.name}]`; 
                const value = metric.value;
                if (typeof value === 'number') {
                    list.push({ path: newPath, type: Number.isInteger(value) ? 'int' : 'float' });
                } else if (typeof value === 'string' && value.trim() !== '') {
                    if (!isNaN(parseFloat(value)) && isFinite(Number(value))) {
                        list.push({ path: newPath, type: value.includes('.') ? 'float (string)' : 'int (string)' });
                    }
                }
            });
        }
        return list;
    }
    for (const key of Object.keys(obj)) {
        const newPath = path ? `${path}.${key}` : key;
        const value = obj[key];
        if (typeof value === 'number') {
            list.push({ path: newPath, type: Number.isInteger(value) ? 'int' : 'float' });
        } else if (typeof value === 'string' && value.trim() !== '') {
            if (!isNaN(parseFloat(value)) && isFinite(Number(value))) {
                list.push({ path: newPath, type: value.includes('.') ? 'float (string)' : 'int (string)' });
            }
        } else if (typeof value === 'object') { 
            findNumericKeys(value, newPath, list);
        }
    }
    return list;
}

function populateChartVariables(payloadString) {
    if (!chartVariableList) return;
    chartVariableList.innerHTML = ''; 
    if (!selectedChartTopic || !selectedChartBrokerId) {
         chartVariableList.innerHTML = '<p class="history-placeholder">No topic selected.</p>';
         return;
    }
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
            const varId = `${selectedChartBrokerId}|${selectedChartTopic}|${key.path}`;
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `chart-var-${varId.replace(/[^a-zA-Z0-9]/g, '_')}`; 
            checkbox.value = varId; 
            checkbox.dataset.brokerId = selectedChartBrokerId;
            checkbox.dataset.topic = selectedChartTopic;
            checkbox.dataset.path = key.path; 
            checkbox.checked = chartedVariables.has(varId);
            checkbox.addEventListener('change', onChartVariableToggle);
            const label = document.createElement('label');
            label.htmlFor = checkbox.id;
            label.textContent = key.path; 
            const typeSpan = document.createElement('span');
            typeSpan.className = 'var-type';
            typeSpan.textContent = `(${key.type})`; 
            label.appendChild(typeSpan);
            itemDiv.appendChild(checkbox);
            itemDiv.appendChild(label);
            chartVariableList.appendChild(itemDiv);
        });
    } catch (e) {
        chartVariableList.innerHTML = '<p class="history-placeholder">Payload is not valid JSON.</p>';
    }
}

function onClearAll() {
    trackEvent('chart_clear_all'); 
    chartedVariables.clear();
    if (chartVariableList) {
        chartVariableList.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
            cb.checked = false;
        });
    }
    chartTypeSelect.value = 'line';
    chartConnectNulls.checked = false;
    currentConfigId = null;
    chartConfigSelect.value = ""; 
    onGenerateChart(true); 
    appCallbacks.colorChartTreeCallback(); 
}

function onChartVariableToggle(event) {
    const checkbox = event.target;
    const varId = checkbox.value; 
    if (checkbox.checked) {
        chartedVariables.set(varId, {
            brokerId: checkbox.dataset.brokerId,
            topic: checkbox.dataset.topic,
            path: checkbox.dataset.path 
        });
        trackEvent('chart_add_variable'); 
    } else {
        chartedVariables.delete(varId);
        trackEvent('chart_remove_variable'); 
    }
    onGenerateChart(true);
    appCallbacks.colorChartTreeCallback();
}

/**
 * Downsample data using Bucket Averaging (simple and efficient).
 * Reduces data points to MAX_POINTS_PER_SERIES.
 */
function downsampleData(data, targetCount) {
    if (data.length <= targetCount) return data;

    const sampled = [];
    // Size of each bucket
    const bucketSize = Math.ceil(data.length / targetCount);

    for (let i = 0; i < data.length; i += bucketSize) {
        // Get slice for this bucket
        const bucket = data.slice(i, i + bucketSize);
        
        // Calculate averages for this bucket
        let sumVal = 0;
        let sumTs = 0;
        let count = 0;

        for (const point of bucket) {
            // Only average if value is valid number
            if (point && point.y !== null && point.y !== undefined) {
                sumVal += point.y;
                sumTs += point.x;
                count++;
            }
        }

        if (count > 0) {
            sampled.push({
                x: Math.round(sumTs / count),
                y: sumVal / count
            });
        }
    }
    return sampled;
}

/**
 * Main Chart Generation Logic.
 * @param {boolean} showLoader - Force showing loader (useful for button clicks)
 */
function onGenerateChart(showLoader = false) {
    trackEvent('chart_generate_refresh'); 
    if (isUserInteracting) return;

    if (showLoader) showChartLoader();

    // Use setTimeout to allow UI to render loader before heavy processing
    setTimeout(() => {
        processChartData();
    }, 10);
}

function processChartData() {
    if (chartedVariables.size === 0) {
        if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
        chartPlaceholder.style.display = 'block';
        chartPlaceholder.textContent = 'Select a topic and check variables to plot, or load a saved chart.';
        chartCanvas.style.display = 'none';
        lastGeneratedData = { labels: [], datasets: [] };
        hideChartLoader();
        return;
    }

    const allHistory = appCallbacks.getHistory(); 

    // Filter strictly by requested range + small buffer
    const timeFilteredHistory = allHistory.filter(entry =>
        entry.timestampMs >= (currentMinTimestamp - 500) &&
        entry.timestampMs <= (currentMaxTimestamp + 500)
    ); 

    if (timeFilteredHistory.length === 0) {
        if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
        chartPlaceholder.style.display = 'block';
        chartPlaceholder.textContent = "No data found in the selected time range.";
        chartCanvas.style.display = 'none';
        lastGeneratedData = { labels: [], datasets: [] };
        hideChartLoader();
        return;
    }

    const chartType = chartTypeSelect.value;
    const connectNulls = chartConnectNulls.checked;
    let datasets = [];
    let labels = []; // Not strictly used for XY scatter/line, but kept for compatibility
    const isDarkMode = document.body.classList.contains('dark-mode');
    const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    const textColor = isDarkMode ? '#e0e0e0' : '#333';

    const dynamicScales = {
        x: {
            type: 'time',
            time: {
                // [MODIFIED] Explicit format configuration to show date + time on large scales
                tooltipFormat: 'yyyy-MM-dd HH:mm:ss',
                displayFormats: {
                    millisecond: 'HH:mm:ss.SSS',
                    second: 'HH:mm:ss',
                    minute: 'HH:mm',
                    hour: 'dd/MM HH:mm', // Show date when zoomed out to hours
                    day: 'yyyy-MM-dd'
                }
            },
            grid: { color: gridColor },
            ticks: { color: textColor },
            min: currentMinTimestamp,
            max: currentMaxTimestamp
        }
    };

    // --- PIE CHART LOGIC ---
    if (chartType === 'pie') {
        const totals = {};
        chartedVariables.forEach((varInfo, varId) => {
            const topicParts = varInfo.topic.split('/');
            const cleanPath = varInfo.path.replace(/\[|\]/g, ''); 
            const brokerPrefix = isMultiBroker ? `[${varInfo.brokerId}] ` : '';
            const label = `${brokerPrefix}${topicParts.slice(-2).join('/')} | ${cleanPath}`;
            totals[label] = 0;
        });
        for (const entry of timeFilteredHistory) {
            for (const [varId, { brokerId, topic, path }] of chartedVariables.entries()) {
                if (entry.brokerId === brokerId && entry.topic === topic) {
                    try {
                        const payload = JSON.parse(entry.payload);
                        let value = getNestedValue(payload, path);
                        if (typeof value === 'string') {
                            const numVal = parseFloat(value);
                            if (!isNaN(numVal) && isFinite(Number(value))) value = numVal; 
                        }
                        if (typeof value === 'number') {
                            const topicParts = topic.split('/');
                            const cleanPath = path.replace(/\[|\]/g, ''); 
                            const brokerPrefix = isMultiBroker ? `[${brokerId}] ` : '';
                            const label = `${brokerPrefix}${topicParts.slice(-2).join('/')} | ${cleanPath}`;
                            totals[label] += value;
                        }
                    } catch (e) { }
                }
            }
        }
        datasets = [{
            data: Object.values(totals),
            backgroundColor: Object.keys(totals).map((_, i) => `hsl(${(i * 360 / chartedVariables.size)}, 70%, 50%)`),
        }];
        labels = Object.keys(totals);
    } 
    // --- LINE / BAR CHART LOGIC ---
    else {
        let i = 0;
        for (const [varId, { brokerId, topic, path }] of chartedVariables.entries()) {
            const color = `hsl(${(i * 360 / chartedVariables.size)}, 70%, 50%)`;
            const topicParts = topic.split('/');
            const cleanPath = path.replace(/\[|\]/g, ''); 
            const brokerPrefix = isMultiBroker ? `[${brokerId}] ` : '';
            const label = `${brokerPrefix}${topicParts.slice(-2).join('/')} | ${cleanPath}`;
            const yAxisId = `y${i}`; 
            const position = (i % 2 === 0) ? 'left' : 'right'; 
            
            // Collect raw data points
            let rawPoints = [];
            for (const entry of timeFilteredHistory) {
                if (entry.brokerId === brokerId && entry.topic === topic) {
                    try {
                        const payload = JSON.parse(entry.payload);
                        let value = getNestedValue(payload, path);
                        if (typeof value === 'string') {
                            const numVal = parseFloat(value);
                            if (!isNaN(numVal) && isFinite(Number(value))) value = numVal;
                        }
                        if (typeof value === 'number') {
                            rawPoints.push({ x: entry.timestampMs, y: value });
                        }
                    } catch (e) { }
                }
            }

            // Sort by time before downsampling
            rawPoints.sort((a, b) => a.x - b.x);

            // --- DOWNSAMPLING ---
            let processedPoints = rawPoints;
            if (rawPoints.length > MAX_POINTS_PER_SERIES) {
                console.log(`[Chart] Downsampling series '${label}' from ${rawPoints.length} to ~${MAX_POINTS_PER_SERIES} points.`);
                processedPoints = downsampleData(rawPoints, MAX_POINTS_PER_SERIES);
            }

            datasets.push({
                label: label,
                data: processedPoints, // {x, y} format for Chart.js time scale
                borderColor: color,
                backgroundColor: color,
                fill: false,
                spanGaps: connectNulls,
                tension: 0.1,
                yAxisID: yAxisId,
                pointRadius: processedPoints.length > 200 ? 0 : 3 // Hide points if dense
            });

            dynamicScales[yAxisId] = {
                type: 'linear',
                position: position,
                grid: { drawOnChartArea: (i === 0) },
                ticks: { color: color },
            };
            i++;
        }
    }

    if (chartInstance) chartInstance.destroy();
    chartPlaceholder.style.display = 'none';
    chartCanvas.style.display = 'block';
    
    chartInstance = new Chart(chartCanvas, {
        type: chartType,
        data: { datasets: datasets }, // No global labels needed for Time Scale with XY data
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: (chartType === 'pie') ? {} : dynamicScales,
            plugins: {
                legend: { labels: { color: textColor } },
                // [MODIFIED] Added Zoom Plugin Configuration
                zoom: {
                    zoom: {
                        drag: {
                            enabled: true,
                            backgroundColor: 'rgba(54, 162, 235, 0.3)'
                        },
                        mode: 'x',
                        onZoomComplete: ({chart}) => {
                            const {min, max} = chart.scales.x;
                            currentMinTimestamp = min;
                            currentMaxTimestamp = max;
                            isUserInteracting = true;
                            isChartLive = false;
                            updateChartSliderUI(currentMinTimestamp, currentMaxTimestamp, false, true);
                            triggerDataFetch(min, max);
                        }
                    },
                    pan: {
                        enabled: false,
                        mode: 'x'
                    }
                },
                tooltip: { 
                    mode: 'index', 
                    intersect: false,
                    callbacks: {
                        title: (context) => {
                            // Format timestamp in tooltip
                            if (context[0] && context[0].parsed.x) {
                                return new Date(context[0].parsed.x).toLocaleString();
                            }
                            return '';
                        }
                    }
                }
            },
            animation: false,
            parsing: false, // Improved performance for explicit {x,y} structure
            normalized: true // Data is pre-sorted
        }
    });
    lastGeneratedData = { labels, datasets };
    
    hideChartLoader();
}

function toggleChartFullscreen() {
    trackEvent('chart_fullscreen'); 
    if (!chartMainArea) return;
    if (!document.fullscreenElement) {
        chartMainArea.requestFullscreen().catch(err => console.error(err));
    } else {
        if (document.exitFullscreen) document.exitFullscreen();
    }
}

function onExportPNG() {
    trackEvent('chart_export_png'); 
    if (!chartInstance) { alert("Please generate a chart first."); return; }
    const a = document.createElement('a');
    a.href = chartInstance.toBase64Image();
    a.download = `multi_topic_chart.png`;
    a.click();
}

function onExportCSV() {
    trackEvent('chart_export_csv'); 
    // Export currently displayed data from the chart instance to ensure we get processed/downsampled data
    if (!chartInstance || !chartInstance.data.datasets || chartInstance.data.datasets.length === 0) {
        alert("Please generate a chart first.");
        return;
    }
    const chartType = chartTypeSelect.value;
    let csvContent = "data:text/csv;charset=utf-8,";
    
    if (chartType === 'pie') {
        csvContent += "Variable,Total\r\n";
        chartInstance.data.labels.forEach((label, index) => {
            const value = chartInstance.data.datasets[0].data[index];
            csvContent += `"${label}",${value}\r\n`;
        });
    } else {
        const headers = ['timestamp', ...chartInstance.data.datasets.map(d => `"${d.label}"`)];
        csvContent += headers.join(',') + '\r\n';
        
        // Collect all unique timestamps from all datasets
        const allTimestamps = new Set();
        chartInstance.data.datasets.forEach(ds => {
            ds.data.forEach(point => allTimestamps.add(point.x));
        });
        const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);

        // Map data for quick lookup: datasetIndex -> timestamp -> value
        const dataMap = chartInstance.data.datasets.map(ds => {
            const map = new Map();
            ds.data.forEach(p => map.set(p.x, p.y));
            return map;
        });

        sortedTimestamps.forEach(ts => {
            const row = [new Date(ts).toISOString()];
            dataMap.forEach(map => {
                row.push(map.has(ts) ? map.get(ts) : '');
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

async function loadChartConfig() {
    try {
        const response = await fetch('api/chart/config');
        if (!response.ok) throw new Error('Failed to fetch chart config');
        let savedConfig = await response.json(); 
        if (Array.isArray(savedConfig)) {
            allChartConfigs = { configurations: [{ id: `chart_${Date.now()}`, name: "Migrated Chart", chartType: "line", connectNulls: false, variables: savedConfig.map(v => ({ brokerId: 'default', topic: v.topic, path: v.path })) }] };
            await saveAllChartConfigs(allChartConfigs, false); 
        } else if (savedConfig && Array.isArray(savedConfig.configurations)) {
            allChartConfigs = savedConfig; 
        } else {
            allChartConfigs = { configurations: [] }; 
        }
        populateChartConfigSelect(); 
        if (allChartConfigs.configurations.length > 0) {
            chartConfigSelect.value = allChartConfigs.configurations[0].id; 
            onChartConfigChange(); 
        } else {
            onClearAll(); 
        }
    } catch (error) {
        showChartSaveStatus('Load failed', 'error');
    }
}

function populateChartConfigSelect() {
    if (!chartConfigSelect) return;
    chartConfigSelect.innerHTML = ''; 
    const newOption = document.createElement('option');
    newOption.value = "";
    newOption.textContent = "-- New Chart --";
    chartConfigSelect.appendChild(newOption);
    allChartConfigs.configurations.forEach(config => {
        const option = document.createElement('option');
        option.value = config.id;
        option.textContent = config.name;
        chartConfigSelect.appendChild(option);
    });
    chartConfigSelect.value = currentConfigId || "";
}

function onChartConfigChange() {
    const configId = chartConfigSelect.value;
    currentConfigId = configId;
    if (!configId) { onClearAll(); return; }
    const config = allChartConfigs.configurations.find(c => c.id === configId);
    if (!config) { onClearAll(); return; }
    
    chartTypeSelect.value = config.chartType || 'line';
    chartConnectNulls.checked = config.connectNulls || false;
    chartedVariables.clear();
    if (Array.isArray(config.variables)) {
        config.variables.forEach(v => {
            const brokerId = v.brokerId || 'default_broker'; 
            const varId = `${brokerId}|${v.topic}|${v.path}`;
            chartedVariables.set(varId, { ...v, brokerId: brokerId });
        });
    }
    onGenerateChart();
    appCallbacks.colorChartTreeCallback();
    if(selectedChartTopic && selectedChartBrokerId) {
        const node = document.querySelector(`.node-container[data-topic="${selectedChartTopic}"][data-broker-id="${selectedChartBrokerId}"]`);
        if(node) populateChartVariables(node.dataset.payload);
    }
    showChartSaveStatus(`Loaded '${config.name}'`, 'success');
}

async function saveAllChartConfigs(configObject, showStatus = true) {
    if (showStatus) showChartSaveStatus('Saving...', 'success');
    try {
        const response = await fetch('api/chart/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(configObject),
        });
        if (!response.ok) throw new Error('Failed to save');
        allChartConfigs = configObject; 
        if (showStatus) showChartSaveStatus('Saved!', 'success');
        return true;
    } catch (error) {
        if (showStatus) showChartSaveStatus(`Error: ${error.message}`, 'error');
        return false;
    }
}

async function onSaveCurrent() {
    trackEvent('chart_save_current'); 
    if (!currentConfigId) { onSaveAsNew(); return; }
    const config = allChartConfigs.configurations.find(c => c.id === currentConfigId);
    if (!config) { showChartSaveStatus('Error: Config not found', 'error'); return; }
    config.name = chartConfigSelect.options[chartConfigSelect.selectedIndex].text; 
    config.chartType = chartTypeSelect.value;
    config.connectNulls = chartConnectNulls.checked;
    config.variables = Array.from(chartedVariables.values());
    await saveAllChartConfigs(allChartConfigs);
}

async function onSaveAsNew() {
    trackEvent('chart_save_as_new'); 
    if (maxChartsLimit > 0 && allChartConfigs.configurations.length >= maxChartsLimit) {
        alert(`Limit reached (${maxChartsLimit}). Delete a chart first.`);
        return; 
    }
    const name = prompt("Enter a name for this new chart configuration:");
    if (!name || name.trim().length === 0) return; 
    const newConfig = {
        id: `chart_${Date.now()}`,
        name: name.trim(),
        chartType: chartTypeSelect.value,
        connectNulls: chartConnectNulls.checked,
        variables: Array.from(chartedVariables.values()) 
    };
    allChartConfigs.configurations.push(newConfig);
    currentConfigId = newConfig.id; 
    const success = await saveAllChartConfigs(allChartConfigs);
    if (success) populateChartConfigSelect();
}

async function onDeleteConfig() {
    trackEvent('chart_delete_config'); 
    if (!currentConfigId) { alert("No chart selected."); return; }
    if (!confirm(`Delete chart?`)) return;
    allChartConfigs.configurations = allChartConfigs.configurations.filter(c => c.id !== currentConfigId);
    const success = await saveAllChartConfigs(allChartConfigs);
    if (success) { onClearAll(); populateChartConfigSelect(); }
}