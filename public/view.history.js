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
 * View module for the History tab.
 * [UPDATED] Protocol-agnostic provider selection with Dynamic Addition for Parsers.
 * [UPDATED] Integrated Proxy-based reactive state for auto-filtering based on tree selection.
 */

import { state, subscribe } from './state.js';
import { formatTimestampForLabel, highlightText, trackEvent, showToast } from './utils.js'; 
import { createDualTimeSlider } from './time-slider.js';

// --- DOM Element Querying ---
const historyLogContainer = document.getElementById('historical-log-container');
const historySearchInput = document.getElementById('history-search-input');
const historyControls = document.querySelector('.history-controls'); 
const timeRangeSliderContainer = document.getElementById('time-range-slider-container');
const handleMin = document.getElementById('handle-min');
const handleMax = document.getElementById('handle-max');
const sliderRange = document.getElementById('slider-range');
const labelMin = document.getElementById('label-min');
const labelMax = document.getElementById('label-max');

// --- Constants ---
const MAX_CLIENT_ENTRIES = 50000; 

// --- Module-level State ---
let allHistoryEntries = [];
let globalMinTimestamp = 0; 
let globalMaxTimestamp = 0; 
let currentMinTimestamp = 0; 
let currentMaxTimestamp = 0; 
let historySlider = null; 

let isMultiProvider = false;
let providerFilterSelect = null; 
let availableProviders = [];

let visibleCount = 1000; 

// UI Elements for Dates
let startDateInput = null;
let endDateInput = null;
let fetchTimer = null;

let requestRangeCallback = null; 

function toDateTimeLocal(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    const offsetMs = d.getTimezoneOffset() * 60 * 1000;
    return (new Date(d.getTime() - offsetMs)).toISOString().slice(0, 16);
}

function showLoader() {
    if (historyLogContainer) {
        historyLogContainer.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: center; gap: 10px; padding: 20px; color: var(--color-text-secondary);">
                <div class="broker-dot" style="background-color: var(--color-primary); animation: blink 1s infinite;"></div>
                <span>Fetching data...</span>
            </div>
        `;
    }
}

/**
 * Exports the currently filtered history entries to a JSON file.
 */
function exportHistoryToJSON() {
    trackEvent('history_export_json');
    if (!allHistoryEntries || allHistoryEntries.length === 0) {
        showToast("No data to export.", "warning");
        return;
    }

    const searchTerm = historySearchInput.value.trim().toLowerCase();
    const searchActive = searchTerm.length >= 3;
    const selectedProviderId = providerFilterSelect ? providerFilterSelect.value : 'all';

    const entriesToExport = allHistoryEntries.filter(entry => {
        if (selectedProviderId !== 'all' && entry.brokerId !== selectedProviderId) return false;
        if (entry.timestampMs < currentMinTimestamp || entry.timestampMs > currentMaxTimestamp) return false;
        
        if (searchActive) {
            const topicMatch = entry.topic.toLowerCase().includes(searchTerm);
            const payloadMatch = entry.payload.toLowerCase().includes(searchTerm);
            return topicMatch || payloadMatch;
        }
        return true;
    });

    if (entriesToExport.length === 0) {
        showToast("Current filters result in no data.", "warning");
        return;
    }

    const sanitizedEntries = entriesToExport.map(entry => ({
        timestamp: entry.timestamp,
        brokerId: entry.brokerId, // Keep 'brokerId' key for JSON backward compatibility
        topic: entry.topic,
        payload: entry.payload
    }));

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(sanitizedEntries, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    const dateStr = new Date().toISOString().slice(0, 10);
    downloadAnchorNode.setAttribute("download", `mqtt_history_export_${dateStr}.json`);
    
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
}

/**
 * Exports the currently filtered history entries to a CSV file.
 */
function exportHistoryToCSV() {
    trackEvent('history_export_csv');
    if (!allHistoryEntries || allHistoryEntries.length === 0) {
        showToast("No data to export.", "warning");
        return;
    }

    const searchTerm = historySearchInput.value.trim().toLowerCase();
    const searchActive = searchTerm.length >= 3;
    const selectedProviderId = providerFilterSelect ? providerFilterSelect.value : 'all';

    const entriesToExport = allHistoryEntries.filter(entry => {
        if (selectedProviderId !== 'all' && entry.brokerId !== selectedProviderId) return false;
        if (entry.timestampMs < currentMinTimestamp || entry.timestampMs > currentMaxTimestamp) return false;
        
        if (searchActive) {
            const topicMatch = entry.topic.toLowerCase().includes(searchTerm);
            const payloadMatch = entry.payload.toLowerCase().includes(searchTerm);
            return topicMatch || payloadMatch;
        }
        return true;
    });

    if (entriesToExport.length === 0) {
        showToast("Current filters result in no data.", "warning");
        return;
    }

    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "Timestamp,Provider,Topic,Payload\r\n"; 
    
    entriesToExport.forEach(entry => {
        const ts = new Date(entry.timestamp).toISOString();
        const provider = `"${entry.brokerId.replace(/"/g, '""')}"`;
        const topic = `"${entry.topic.replace(/"/g, '""')}"`;
        const payload = `"${entry.payload.replace(/"/g, '""')}"`;
        csvContent += `${ts},${provider},${topic},${payload}\r\n`;
    });

    const encodedUri = encodeURI(csvContent);
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", encodedUri);
    const dateStr = new Date().toISOString().slice(0, 10);
    downloadAnchorNode.setAttribute("download", `mqtt_history_export_${dateStr}.csv`);
    
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
}

/**
 * Applies current filters (time + search + provider) and re-renders the log.
 */
export function renderFilteredHistory() {
    if (!historyLogContainer) return;

    const searchTerm = historySearchInput.value.trim().toLowerCase();
    const searchActive = searchTerm.length >= 3;
    const selectedProviderId = providerFilterSelect ? providerFilterSelect.value : 'all';

    const filteredEntries = allHistoryEntries.filter(entry => {
        if (selectedProviderId !== 'all' && entry.brokerId !== selectedProviderId) return false;
        if (entry.timestampMs < currentMinTimestamp || entry.timestampMs > currentMaxTimestamp) return false;
        
        if (searchActive) {
            const topicMatch = entry.topic.toLowerCase().includes(searchTerm);
            const payloadMatch = entry.payload.toLowerCase().includes(searchTerm);
            return topicMatch || payloadMatch;
        }
        return true;
    });

    historyLogContainer.innerHTML = ''; 
    
    if (filteredEntries.length === 0) {
        historyLogContainer.innerHTML = '<p class="history-placeholder">No log entries in this view range.</p>';
    } else {
        const displayEntries = filteredEntries.slice(0, visibleCount);
        displayEntries.forEach(entry => addHistoryEntry(entry, searchActive ? searchTerm : null));
        
        if (filteredEntries.length > visibleCount) {
            const btnContainer = document.createElement('div');
            btnContainer.style.textAlign = 'center';
            btnContainer.style.padding = '15px';
            
            const loadMoreBtn = document.createElement('button');
            loadMoreBtn.className = 'tool-button';
            loadMoreBtn.textContent = `Show Next 1000 (${filteredEntries.length - visibleCount} remaining)`;
            loadMoreBtn.onclick = () => {
                visibleCount += 1000;
                renderFilteredHistory();
            };
            
            btnContainer.appendChild(loadMoreBtn);
            historyLogContainer.appendChild(btnContainer);
        }
    }
}

/**
 * Dynamically adds a new data provider to the dropdown filter (e.g., when a CSV parser is started)
 */
export function addAvailableHistoryProvider(providerId, type = 'dynamic') {
    if (!providerFilterSelect) return;
    
    // Check if it already exists to prevent duplicates
    for (let i = 0; i < providerFilterSelect.options.length; i++) {
        if (providerFilterSelect.options[i].value === providerId) return;
    }
    
    availableProviders.push({ id: providerId, type: type });
    
    const option = document.createElement('option');
    option.value = providerId;
    const typeLabel = type ? `[${type.toUpperCase()}]` : '[DYNAMIC]';
    option.textContent = `${providerId} ${typeLabel}`;
    
    providerFilterSelect.appendChild(option);
}

/**
 * Initializes the History View functionality.
 */
export function initHistoryView(options = {}) {
    isMultiProvider = options.isMultiBroker || false;
    requestRangeCallback = options.requestRangeCallback || null; 
    
    // Merge brokers and new data providers for unified filtering
    const bConfigs = options.brokerConfigs || [];
    const pConfigs = options.dataProviders || [];
    availableProviders = [...bConfigs, ...pConfigs];

    historySearchInput?.addEventListener('input', () => {
        visibleCount = 1000; 
        renderFilteredHistory(); 
        clearTimeout(fetchTimer);
        fetchTimer = setTimeout(() => {
            triggerDataFetch(currentMinTimestamp, currentMaxTimestamp);
        }, 800);
    });

    // --- 1. Create Date Picker UI Controls ---
    const dateControlsDiv = document.createElement('div');
    dateControlsDiv.style.display = 'flex';
    dateControlsDiv.style.gap = '10px';
    dateControlsDiv.style.marginBottom = '10px';
    dateControlsDiv.style.alignItems = 'center';
    dateControlsDiv.style.flexWrap = 'wrap';

    const startGrp = document.createElement('div');
    startGrp.style.display = 'flex';
    startGrp.style.flexDirection = 'column';
    startGrp.innerHTML = '<label style="font-size:0.8em;">Start</label>';
    startDateInput = document.createElement('input');
    startDateInput.type = 'datetime-local';
    startDateInput.className = 'modal-input';
    startDateInput.style.fontSize = '0.9em';
    startGrp.appendChild(startDateInput);

    const endGrp = document.createElement('div');
    endGrp.style.display = 'flex';
    endGrp.style.flexDirection = 'column';
    endGrp.innerHTML = '<label style="font-size:0.8em;">End</label>';
    endDateInput = document.createElement('input');
    endDateInput.type = 'datetime-local';
    endDateInput.className = 'modal-input';
    endDateInput.style.fontSize = '0.9em';
    endGrp.appendChild(endDateInput);

    const btnGrp = document.createElement('div');
    btnGrp.style.display = 'flex';
    btnGrp.style.gap = '5px';
    btnGrp.style.marginTop = '14px';
    btnGrp.style.flexWrap = 'wrap'; 
    
    const createRangeBtn = (text, hours) => {
        const btn = document.createElement('button');
        btn.textContent = text;
        btn.className = 'tool-button'; 
        btn.onclick = () => setRelativeRange(hours);
        return btn;
    };
    
    btnGrp.appendChild(createRangeBtn('1h', 1));
    btnGrp.appendChild(createRangeBtn('6h', 6));
    btnGrp.appendChild(createRangeBtn('24h', 24));
    btnGrp.appendChild(createRangeBtn('7d', 24*7));
    btnGrp.appendChild(createRangeBtn('1M', 24*30));
    btnGrp.appendChild(createRangeBtn('3M', 24*30*3));
    btnGrp.appendChild(createRangeBtn('1Y', 24*365));
    btnGrp.appendChild(createRangeBtn('Full', 'FULL'));

    const exportBtnJson = document.createElement('button');
    exportBtnJson.textContent = 'JSON';
    exportBtnJson.className = 'tool-button';
    exportBtnJson.style.marginTop = '14px';
    exportBtnJson.title = "Download currently filtered data as JSON";
    exportBtnJson.onclick = exportHistoryToJSON;

    const exportBtnCsv = document.createElement('button');
    exportBtnCsv.textContent = 'CSV';
    exportBtnCsv.className = 'tool-button';
    exportBtnCsv.style.marginTop = '14px';
    exportBtnCsv.title = "Download currently filtered data as CSV";
    exportBtnCsv.onclick = exportHistoryToCSV;

    btnGrp.appendChild(exportBtnJson);
    btnGrp.appendChild(exportBtnCsv);

    dateControlsDiv.appendChild(startGrp);
    dateControlsDiv.appendChild(endGrp);
    dateControlsDiv.appendChild(btnGrp);

    if (timeRangeSliderContainer) {
        timeRangeSliderContainer.parentNode.insertBefore(dateControlsDiv, timeRangeSliderContainer);
    }

    const onDateChange = () => {
        const start = startDateInput.value ? new Date(startDateInput.value).getTime() : 0;
        const end = endDateInput.value ? new Date(endDateInput.value).getTime() : Date.now();
        if (start && end && start < end) {
            const isNow = Math.abs(end - Date.now()) < 60000;
            state.isLivePayload = isNow; 
            triggerDataFetch(start, end);
        }
    };
    startDateInput.addEventListener('change', onDateChange);
    endDateInput.addEventListener('change', onDateChange);

    // --- 2. Provider Filter ---
    if (isMultiProvider && historyControls) {
        providerFilterSelect = document.createElement('select');
        providerFilterSelect.id = 'history-provider-filter';
        
        const allOption = document.createElement('option');
        allOption.value = 'all';
        allOption.textContent = 'All Providers';
        providerFilterSelect.appendChild(allOption);

        availableProviders.forEach(config => {
            const option = document.createElement('option');
            option.value = config.id;
            const typeLabel = config.type ? `[${config.type.toUpperCase()}]` : '[MQTT]';
            option.textContent = `${config.id} ${typeLabel}`;
            providerFilterSelect.appendChild(option);
        });

        providerFilterSelect.addEventListener('change', () => {
            visibleCount = 1000; 
            renderFilteredHistory();
        });

        historyControls.prepend(providerFilterSelect);
    }

    // --- 3. Reactive Subscriptions for Auto-Sync ---
    subscribe('currentTopic', (topic) => {
        if (topic && historySearchInput && state.activeView !== 'history') {
            historySearchInput.value = topic;
            visibleCount = 1000;
            renderFilteredHistory();
        }
    });

    subscribe('currentBrokerId', (brokerId) => {
        if (brokerId && providerFilterSelect && state.activeView !== 'history') {
            const exists = Array.from(providerFilterSelect.options).some(opt => opt.value === brokerId);
            if (exists) {
                providerFilterSelect.value = brokerId;
                visibleCount = 1000;
                renderFilteredHistory();
            }
        }
    });

    // --- 4. Slider Init ---
    if (handleMin && handleMax) {
        historySlider = createDualTimeSlider({
            containerEl: timeRangeSliderContainer,
            handleMinEl: handleMin,
            handleMaxEl: handleMax,
            rangeEl: sliderRange,
            labelMinEl: labelMin,
            labelMaxEl: labelMax,
            onDrag: (newMin, newMax) => {
                currentMinTimestamp = newMin;
                currentMaxTimestamp = newMax;
                const range = globalMaxTimestamp - globalMinTimestamp;
                const threshold = globalMinTimestamp + (range * 0.999); 
                state.isLivePayload = (newMax >= threshold);
                updateSliderUI();
            },
            onDragEnd: (newMin, newMax) => {
                triggerDataFetch(newMin, newMax);
            }
        });
    }
}

function setRelativeRange(hours) {
    if (hours === 'FULL') {
        state.isLivePayload = true;
        triggerDataFetch(globalMinTimestamp, Date.now());
        return;
    }
    const end = Date.now();
    let start = end - (hours * 60 * 60 * 1000);
    if (globalMinTimestamp > 0 && start < globalMinTimestamp) {
        start = globalMinTimestamp;
    }
    
    state.isLivePayload = true;
    triggerDataFetch(start, end);
}

function triggerDataFetch(start, end) {
    if (startDateInput) startDateInput.value = toDateTimeLocal(start);
    if (endDateInput) endDateInput.value = toDateTimeLocal(end);
    currentMinTimestamp = start;
    currentMaxTimestamp = end;
    updateSliderUI();
    showLoader();
    
    if (requestRangeCallback) {
        const filter = historySearchInput.value.trim();
        requestRangeCallback(start, end, filter);
    }
}

export function setDbBounds(min, max) {
    globalMinTimestamp = new Date(min).getTime();
    globalMaxTimestamp = new Date(max).getTime();
    currentMinTimestamp = globalMinTimestamp;
    currentMaxTimestamp = globalMaxTimestamp;
    state.isLivePayload = true;
    updateSliderUI();
}

export function setHistoryData(entries, isInitialLoad, isUpdate = false) { 
    if (isUpdate) {
        allHistoryEntries.unshift(...entries);
        if (allHistoryEntries.length > MAX_CLIENT_ENTRIES) {
            allHistoryEntries = allHistoryEntries.slice(0, MAX_CLIENT_ENTRIES);
        }
        const newMax = entries[0].timestampMs;
        if (newMax > globalMaxTimestamp) globalMaxTimestamp = newMax;
        
        if (state.isLivePayload) {
            currentMaxTimestamp = globalMaxTimestamp;
        }
    } else {
        allHistoryEntries = entries;
        visibleCount = 1000; 
        if (entries.length > 2000) {
             if(!isInitialLoad) console.log("Notice: The selected range returned a large number of results.");
        }
    }
    
    if (startDateInput) startDateInput.value = toDateTimeLocal(currentMinTimestamp);
    if (endDateInput) endDateInput.value = toDateTimeLocal(currentMaxTimestamp);
    
    renderFilteredHistory(); 
    updateSliderUI();
    
    return { min: currentMinTimestamp, max: currentMaxTimestamp };
}

function updateSliderUI() {
    if (historySlider) {
        historySlider.updateUI(globalMinTimestamp, globalMaxTimestamp, currentMinTimestamp, currentMaxTimestamp);
    }
}

function addHistoryEntry(entry, searchTerm = null) {
    if (!historyLogContainer) return;

    const div = document.createElement('div');
    div.className = 'log-entry';
    
    const header = document.createElement('div');
    header.className = 'log-entry-header';
    
    const topicSpan = document.createElement('span');
    topicSpan.className = 'log-entry-topic';
    
    // UI Label logic
    const providerPrefix = isMultiProvider ? `[${entry.brokerId}] ` : '';
    topicSpan.innerHTML = highlightText(providerPrefix + entry.topic, searchTerm); 

    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-entry-timestamp';
    timeSpan.textContent = new Date(entry.timestamp).toLocaleString('en-GB');

    header.appendChild(topicSpan);
    header.appendChild(timeSpan);

    const pre = document.createElement('pre');
    try {
        const jsonObj = JSON.parse(entry.payload);
        const prettyPayload = JSON.stringify(jsonObj, null, 2);
        pre.innerHTML = highlightText(prettyPayload, searchTerm); 
    } catch(e) {
        pre.innerHTML = highlightText(entry.payload, searchTerm); 
    }

    div.appendChild(header);
    div.appendChild(pre);
    historyLogContainer.appendChild(div);
}