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
 * View module for the Chart tab.
 * Handles configuration, data extraction (including primitives), and rendering.
 */

// Import shared utilities
import { formatTimestampForLabel, trackEvent, confirmModal } from './utils.js'; 
import { createPayloadViewer } from './payload-viewer.js';
import { createDualTimeSlider }from './time-slider.js';

// --- DOM Element Querying ---
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
const chartSmartAxis = document.getElementById('chart-smart-axis-toggle'); 
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
let hasUnsavedChanges = false; // State for UI feedback

// Configuration for Chart
const MAX_POINTS_PER_SERIES = 500; 

// --- Semantic Color Palette ---
const PALETTE_HUES = [
    210, // Blue (Default 1)
    120, // Green (Default 2)
    30,  // Orange (Default 3)
    270, // Purple (Default 4)
    180, // Teal
    60,  // Yellow
    300, // Magenta
    0    // Red (Last resort)
];

let payloadViewer = createPayloadViewer({
    topicEl: document.getElementById('chart-payload-topic'),
    contentEl: document.getElementById('chart-payload-content'),
    historyLogEl: null, 
    placeholderEl: null,
    isMultiBroker: false 
});

let appCallbacks = {
    colorChartTreeCallback: () => console.error("colorChartTreeCallback not set"), 
};

// --- Unsaved Changes Feedback ---
function markUnsaved() {
    if (!hasUnsavedChanges && btnChartSaveCurrent && !btnChartSaveCurrent.disabled) {
        hasUnsavedChanges = true;
        btnChartSaveCurrent.classList.add('btn-unsaved');
    }
}

function clearUnsaved() {
    hasUnsavedChanges = false;
    if (btnChartSaveCurrent) {
        btnChartSaveCurrent.classList.remove('btn-unsaved');
    }
}

export function refreshChart() {
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
        markUnsaved();
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
    if (chartCanvas) chartCanvas.style.opacity = '0.3';
    if (!document.getElementById('chart-spinner-overlay')) {
        const overlay = document.createElement('div');
        overlay.id = 'chart-spinner-overlay';
        overlay.style.position = 'absolute';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.backgroundColor = 'var(--color-bg-secondary)';
        overlay.style.opacity = '0.7';
        overlay.style.zIndex = '10';
        // CSS Spinner
        overlay.innerHTML = `
            <div style="border: 4px solid var(--color-border); border-top: 4px solid var(--color-primary); border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite;"></div>
            <style>@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }</style>
        `;
        const container = document.getElementById('chart-canvas-container');
        if (container) container.appendChild(overlay);
    }
}

function hideChartLoader() {
    if (chartCanvas) chartCanvas.style.opacity = '1';
    const overlay = document.getElementById('chart-spinner-overlay');
    if (overlay) overlay.remove();
    if (chartedVariables.size === 0 && chartPlaceholder) {
        chartPlaceholder.style.display = 'block';
        chartPlaceholder.textContent = 'Select a topic and check variables to plot, or load a saved chart.';
    } else if (chartPlaceholder) {
        chartPlaceholder.style.display = 'none';
    }
}

export function initChartView(callbacks) {
    const { displayPayload, maxSavedChartConfigs, isMultiBroker: multiBrokerState, requestRangeCallback, getHistory, ...otherCallbacks } = callbacks;
    appCallbacks = { ...appCallbacks, ...otherCallbacks };
    maxChartsLimit = maxSavedChartConfigs || 0; 
    isMultiBroker = multiBrokerState || false; 

    // Convert Fullscreen button to Maximize style
    if (btnChartFullscreen) {
        btnChartFullscreen.innerHTML = '⛶ Maximize';
        btnChartFullscreen.style.fontSize = '0.85em';
        btnChartFullscreen.style.padding = '4px 10px';
    }

    // Remove pie option from selector
    if (chartTypeSelect) {
        for (let i = 0; i < chartTypeSelect.options.length; i++) {
            if (chartTypeSelect.options[i].value === 'pie') {
                chartTypeSelect.remove(i);
                break;
            }
        }
    }

    // Inject Aggregation Dropdown Dynamically
    if (chartTypeSelect && !document.getElementById('chart-aggregation-select')) {
        const typeGroup = chartTypeSelect.closest('.form-group');
        const aggGroup = document.createElement('div');
        aggGroup.className = 'form-group';
        aggGroup.innerHTML = `
            <label for="chart-aggregation-select">Aggregation:</label>
            <select id="chart-aggregation-select" style="padding: 4px 8px; font-size: 0.9em; border-radius: 4px; border: 1px solid var(--color-border); background-color: var(--color-bg-tertiary); color: var(--color-text);">
                <option value="AUTO">Auto (Mean)</option>
                <option value="MIN">Min</option>
                <option value="MAX">Max</option>
                <option value="MEAN">Mean</option>
                <option value="MEDIAN">Median</option>
            </select>
        `;
        typeGroup.parentNode.insertBefore(aggGroup, typeGroup);
        document.getElementById('chart-aggregation-select').addEventListener('change', () => {
            markUnsaved();
            onGenerateChart(true);
        });
    }

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
    
    chartTypeSelect?.addEventListener('change', () => { markUnsaved(); onGenerateChart(true); });
    chartConnectNulls?.addEventListener('change', () => { markUnsaved(); onGenerateChart(true); });
    chartSmartAxis?.addEventListener('change', () => { markUnsaved(); onGenerateChart(true); }); 

    if (chartRangeButtonsContainer) {
        const createRangeBtn = (text, hours) => {
            const btn = document.createElement('button');
            btn.textContent = text;
            btn.className = 'tool-button';
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
        chartRangeButtonsContainer.appendChild(createRangeBtn('1M', 24*30));
        chartRangeButtonsContainer.appendChild(createRangeBtn('3M', 24*30*3));
        chartRangeButtonsContainer.appendChild(createRangeBtn('1Y', 24*365));
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
            triggerDataFetch();
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
                triggerDataFetch();
            }
        });
    }

    loadChartConfig(); 
}

function triggerDataFetch() {
    showChartLoader();
    clearTimeout(chartRefreshTimer);
    chartRefreshTimer = setTimeout(() => {
        onGenerateChart(); // Will trigger the backend API fetch
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
    triggerDataFetch();
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
        let numericKeys = [];
        if (typeof payload === 'number' || typeof payload === 'boolean') {
             numericKeys.push({ path: "(value)", type: typeof payload });
        } 
        else if (typeof payload === 'string' && !isNaN(parseFloat(payload)) && isFinite(Number(payload))) {
             numericKeys.push({ path: "(value)", type: "float (string)" });
        }
        else {
             numericKeys = findNumericKeys(payload);
        }
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
    clearUnsaved();
    onGenerateChart(true); 
    appCallbacks.colorChartTreeCallback(); 
}

function onChartVariableToggle(event) {
    const checkbox = event.target;
    const varId = checkbox.value; 
    markUnsaved();

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

function isBooleanLike(dataPoints) {
    if (!dataPoints || dataPoints.length === 0) return false;
    for (const p of dataPoints) {
        if (p.y !== 0 && p.y !== 1) return false;
    }
    return true;
}

function guessGroupKey(topic, path) {
    const fullString = (topic + '/' + path).toLowerCase();
    const keywords = [
        'temperature', 'humidity', 'pressure', 'bar', 'psi', 'pascal',
        'power', 'current', 'voltage', 'energy', 
        'speed', 'vibration', 'level', 'percent', 'battery', 'soc', 
        'heater', 'status', 'fire', 
        'load', 'flow', 'rate', 'debit', 'throughput',
        'concentration', 'ppm', 'ppb', 'mg', 'µg', 'aqi', 'co2', 'pm25'
    ];
    for (const kw of keywords) {
        if (fullString.includes(kw)) return kw;
    }
    const topicParts = topic.split('/');
    const lastPart = topicParts[topicParts.length - 1];
    if (path === '(value)' || path.toLowerCase() === 'value') {
        return lastPart.toLowerCase();
    }
    return (lastPart + '_' + path).replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
}

function getAxisHue(axisKey, axisIndex, enableSemantic = true) {
    const key = axisKey.toLowerCase();
    
    // 1. Semantic Override (Only if enabled)
    if (enableSemantic) {
        if (key.includes('heater') || key.includes('fire')) return 0; // Red
        if (key.includes('temperature')) return 15; // Red-Orange
        if (key.includes('humidity') || key.includes('water')) return 210; // Blue
        if (key.includes('pressure') || key.includes('bar') || key.includes('psi')) return 180; // Teal/Cyan
        if (key.includes('flow') || key.includes('rate') || key.includes('debit')) return 240; // Indigo
        if (key.includes('power') || key.includes('energy') || key.includes('voltage')) return 45; // Yellow/Gold
        if (key.includes('concentration') || key.includes('ppm') || key.includes('aqi') || key.includes('co2')) return 300; // Magenta
        if (key.includes('percent') || key.includes('level') || key.includes('battery')) return 120; // Green
        if (key.includes('status')) return 270; // Purple
    }

    // 2. Palette Rotation fallback
    return PALETTE_HUES[axisIndex % PALETTE_HUES.length];
}

function onGenerateChart(showLoader = false) {
    trackEvent('chart_generate_refresh'); 
    if (isUserInteracting) {
        return;
    }
    if (showLoader) showChartLoader();
    
    // Debounce to prevent API spam in live mode
    clearTimeout(chartRefreshTimer);
    chartRefreshTimer = setTimeout(() => {
        processChartData();
    }, 300);
}

// Calls Backend API for Aggregated Data
async function processChartData() {
    if (chartedVariables.size === 0) {
        if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
        hideChartLoader(); // Includes logic to show placeholder
        chartCanvas.style.display = 'none';
        return;
    }

    const aggregationSelect = document.getElementById('chart-aggregation-select');
    const aggregation = aggregationSelect ? aggregationSelect.value : 'AUTO';

    // Group variables by topic/broker
    const topicsMap = new Map();
    chartedVariables.forEach((varInfo, varId) => {
        const key = `${varInfo.brokerId}|${varInfo.topic}`;
        if (!topicsMap.has(key)) {
            topicsMap.set(key, { brokerId: varInfo.brokerId, topic: varInfo.topic, variables: [] });
        }
        
        // Convert JS path to valid JSONPath
        let jsonPath = varInfo.path;
        if (jsonPath !== '(value)') {
            jsonPath = jsonPath.startsWith('[') ? '$' + jsonPath : '$.' + jsonPath;
        }
        topicsMap.get(key).variables.push({ id: varId, path: jsonPath, originalPath: varInfo.path });
    });

    const topicsArray = Array.from(topicsMap.values());

    try {
        const response = await fetch('api/context/aggregate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                topics: topicsArray,
                startDate: new Date(currentMinTimestamp).toISOString(),
                endDate: new Date(currentMaxTimestamp).toISOString(),
                aggregation: aggregation,
                maxPoints: MAX_POINTS_PER_SERIES
            })
        });

        if (!response.ok) throw new Error('Aggregation API failed');
        const results = await response.json();

        // Transform results back to rawPointsMap format for drawing
        const rawPointsMap = new Map();
        chartedVariables.forEach((v, id) => rawPointsMap.set(id, []));

        results.forEach(topicResult => {
            if (topicResult.error) {
                console.error("Aggregation error for topic:", topicResult.topic, topicResult.error);
                return;
            }
            if (topicResult.data) {
                topicResult.data.forEach(row => {
                    const ts = row.ts_ms;
                    Object.keys(row).forEach(col => {
                        if (col !== 'ts_ms' && row[col] !== null) {
                            rawPointsMap.get(col).push({ x: ts, y: row[col] });
                        }
                    });
                });
            }
        });

        // --- Build Datasets ---
        const chartType = chartTypeSelect.value;
        const connectNulls = chartConnectNulls.checked;
        const useSmartAxis = chartSmartAxis && chartSmartAxis.checked;
        let datasets = [];

        const isDarkMode = document.body.classList.contains('dark-mode');
        const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
        const textColor = isDarkMode ? '#e0e0e0' : '#333';

        const axisGroups = new Map();
        chartedVariables.forEach((varInfo, varId) => {
            const topicParts = varInfo.topic.split('/');
            const cleanPath = varInfo.path.replace(/\[|\]/g, '');
            const axisKey = useSmartAxis ? guessGroupKey(varInfo.topic, cleanPath) : varId;
            if (!axisGroups.has(axisKey)) axisGroups.set(axisKey, 0);
            axisGroups.set(axisKey, axisGroups.get(axisKey) + 1);
        });
        const distinctAxes = Array.from(axisGroups.keys());

        const dynamicScales = {
            x: {
                type: 'time',
                time: {
                    tooltipFormat: 'yyyy-MM-dd HH:mm:ss',
                    displayFormats: { millisecond: 'HH:mm:ss.SSS', second: 'HH:mm:ss', minute: 'HH:mm', hour: 'dd/MM HH:mm', day: 'yyyy-MM-dd' }
                },
                grid: { color: gridColor },
                ticks: { color: textColor },
                min: currentMinTimestamp,
                max: currentMaxTimestamp
            }
        };

        const axisMap = new Map(); 

            // Dataset Construction Loop
        for (const [varId, { brokerId, topic, path }] of chartedVariables.entries()) {
            const rawPoints = rawPointsMap.get(varId) || [];
            const topicParts = topic.split('/');
            const cleanPath = path.replace(/\[|\]/g, '');
            const label = `${topicParts.slice(-2).join('/')} | ${cleanPath}`;
            
                console.log(`[Chart Debug] Variable '${label}': Found ${rawPoints.length} points.`);
                
                // Sort by time
            rawPoints.sort((a, b) => a.x - b.x);
            
                // Determine Axis
            const axisKey = useSmartAxis ? guessGroupKey(topic, cleanPath) : varId;
            if (!axisMap.has(axisKey)) axisMap.set(axisKey, `y${axisMap.size}`);
            const yAxisId = axisMap.get(axisKey);
            
                // Determine Color
            const axisIndex = distinctAxes.indexOf(axisKey);
            const hue = getAxisHue(axisKey, axisIndex, useSmartAxis);
            const color = `hsl(${hue}, 85%, 60%)`;
            
                // Create Dataset (No local downsampling needed)
            datasets.push({
                label: label,
                data: rawPoints,
                borderColor: color,
                backgroundColor: color,
                fill: false,
                spanGaps: connectNulls,
                tension: 0.1,
                yAxisID: yAxisId,
                pointRadius: rawPoints.length > 200 ? 0 : 3 
            });

                // Config Scale
            if (!dynamicScales[yAxisId]) {
                const position = (Array.from(axisMap.values()).indexOf(yAxisId) % 2 === 0) ? 'left' : 'right';
                dynamicScales[yAxisId] = {
                    type: 'linear',
                    display: true,
                    position: position,
                    stack: useSmartAxis ? ((position === 'left') ? 'left-stack' : 'right-stack') : undefined,
                    title: { display: true, text: useSmartAxis ? axisKey.toUpperCase() : label, color: `hsl(${hue}, 100%, 40%)` }
                };
                if (isBooleanLike(rawPoints)) {
                    dynamicScales[yAxisId].min = 0;
                    dynamicScales[yAxisId].max = 1.2;
                    dynamicScales[yAxisId].ticks = { stepSize: 1 };
                }
            }
        }

            // Prolong last value for live chart logic
        if (connectNulls && datasets.length > 0 && isChartLive) {
             const prolongTarget = currentMaxTimestamp;
             datasets.forEach(ds => {
                 if (ds.data.length > 0) {
                     const lastPt = ds.data[ds.data.length - 1];
                     if (lastPt.x < prolongTarget) {
                         ds.data.push({ x: prolongTarget, y: lastPt.y });
                     }
                 }
             });
        }

        if (chartInstance) {
            // Unlink current chart safely
            chartInstance.destroy();
        }

        chartCanvas.style.display = 'block';
        chartInstance = new Chart(chartCanvas, {
            type: chartType,
            data: { datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: dynamicScales,
                plugins: {
                    legend: { labels: { color: textColor } },
                    zoom: {
                        zoom: {
                            drag: { enabled: true, backgroundColor: 'rgba(54, 162, 235, 0.3)' },
                            mode: 'x',
                            onZoomComplete: ({chart}) => {
                                const {min, max} = chart.scales.x;
                                currentMinTimestamp = min;
                                currentMaxTimestamp = max;
                                isUserInteracting = false; // Fix infinite load
                                isChartLive = false;
                                updateChartSliderUI(min, max, false, true);
                                setTimeout(() => triggerDataFetch(), 0); 
                            }
                        }
                    }
                },
                animation: false,
                parsing: false,
                normalized: true
            }
        });
        hideChartLoader();
    } catch (err) {
        console.error("Chart aggregation error:", err);
        hideChartLoader();
    }
}

function toggleChartFullscreen() {
    trackEvent('chart_fullscreen'); 
    if (!chartMainArea) return;
    const isMaximized = chartMainArea.classList.toggle('maximized');
    if (isMaximized) {
        btnChartFullscreen.innerHTML = '✖ Minimize';
        chartMainArea.style.position = 'fixed';
        chartMainArea.style.top = '0';
        chartMainArea.style.left = '0';
        chartMainArea.style.right = '0';
        chartMainArea.style.bottom = '0';
        chartMainArea.style.zIndex = '10000';
        chartMainArea.style.backgroundColor = 'var(--color-bg-secondary)';
    } else {
        btnChartFullscreen.innerHTML = '⛶ Maximize';
        chartMainArea.style.position = '';
        chartMainArea.style.top = '';
        chartMainArea.style.left = '';
        chartMainArea.style.right = '';
        chartMainArea.style.bottom = '';
        chartMainArea.style.zIndex = '';
        chartMainArea.style.backgroundColor = '';
    }
    if (chartInstance) {
        setTimeout(() => chartInstance.resize(), 50);
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
    if (!chartInstance || !chartInstance.data.datasets || chartInstance.data.datasets.length === 0) {
        alert("Please generate a chart first.");
        return;
    }
    let csvContent = "data:text/csv;charset=utf-8,";
    const headers = ['timestamp', ...chartInstance.data.datasets.map(d => `"${d.label}"`)];
    csvContent += headers.join(',') + '\r\n';
    
    const allTimestamps = new Set();
    chartInstance.data.datasets.forEach(ds => {
        ds.data.forEach(point => allTimestamps.add(point.x));
    });
    
    const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);
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
    
    const userRole = window.currentUser ? window.currentUser.role : 'user';
    const isGlobal = config._isGlobal === true;
    
    if (isGlobal && userRole !== 'admin') {
        btnChartSaveCurrent.disabled = true;
        btnChartSaveCurrent.textContent = "🔒 Locked";
        btnChartSaveCurrent.title = "Global charts are read-only. Use 'Save As' to create a private copy.";
        btnChartDeleteConfig.disabled = true;
        btnChartDeleteConfig.title = "Cannot delete Global chart.";
        
        // Ensure "Save As" is available
        btnChartSaveAs.disabled = false;
    } else {
        // Unlock controls
        btnChartSaveCurrent.disabled = false;
        btnChartSaveCurrent.textContent = "Save";
        btnChartSaveCurrent.title = "Save changes to this chart";
        btnChartDeleteConfig.disabled = false;
        btnChartDeleteConfig.title = "Delete this chart";
    }
    
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
    
    clearUnsaved();
    onGenerateChart(true);
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
        
        // IMPORTANT: We do not update allChartConfigs with the response, 
        // because the backend might have split them. We trust our local state until next reload
        // OR we should reload. 
        // For simplicity in this edit: we trust the save succeeded.
        
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
    
    const success = await saveAllChartConfigs(allChartConfigs);
    if (success) {
        clearUnsaved();
    }
}

async function onSaveAsNew() {
    trackEvent('chart_save_as_new'); 
    if (maxChartsLimit > 0 && allChartConfigs.configurations.length >= maxChartsLimit) {
        alert(`Limit reached (${maxChartsLimit}). Delete a chart first.`);
        return; 
    }
    
    const activeVersionName = chartConfigSelect.options[chartConfigSelect.selectedIndex]?.text || 'current';
    const name = prompt("Enter a name for this new chart configuration:", `Copy of ${activeVersionName}`);
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
    if (success) {
        // Manually trigger reload to get correct global/private flags if needed, 
        // or just update UI locally
        populateChartConfigSelect();
        
        // Reset UI lock since it's a new (Private) chart
        btnChartSaveCurrent.disabled = false;
        btnChartSaveCurrent.textContent = "Save";
        btnChartDeleteConfig.disabled = false;
        clearUnsaved();
    }
}

async function onDeleteConfig() {
    trackEvent('chart_delete_config'); 
    if (!currentConfigId) { alert("No chart selected."); return; }
    
    const chartName = chartConfigSelect.options[chartConfigSelect.selectedIndex].text;
    const isConfirmed = await confirmModal('Delete Chart', `Are you sure you want to delete the chart '${chartName}'?\nThis action cannot be undone.`, 'Delete', true);
    
    if (!isConfirmed) return;
    
    allChartConfigs.configurations = allChartConfigs.configurations.filter(c => c.id !== currentConfigId);
    const success = await saveAllChartConfigs(allChartConfigs);
    if (success) { 
        onClearAll(); 
        populateChartConfigSelect(); 
    }
}