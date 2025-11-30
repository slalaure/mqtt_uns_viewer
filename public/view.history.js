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
  
 */

// Import shared utilities
import { formatTimestampForLabel, highlightText, trackEvent } from './utils.js'; 
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
// Maximum number of entries to keep in browser memory to prevent crashes.
const MAX_CLIENT_ENTRIES = 50000; 

// --- Module-level State ---
let allHistoryEntries = [];
let globalMinTimestamp = 0; // Absolute DB Min (Left anchor)
let globalMaxTimestamp = 0; // Absolute Live Max (Right anchor)
let currentMinTimestamp = 0; // User selected left handle
let currentMaxTimestamp = 0; // User selected right handle
let historySlider = null; 
let isMultiBroker = false;
let brokerFilterSelect = null;

let isRealTimeMode = true; // If true, updates move the window
let visibleCount = 1000; // [NEW] Number of items to render initially

// UI Elements for Dates
let startDateInput = null;
let endDateInput = null;
let fetchTimer = null;

// Callbacks
let requestRangeCallback = null; // Function to call app.js to fetch data

/**
 * Helper to format Date for input type="datetime-local" (YYYY-MM-DDTHH:mm)
 */
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
        alert("No data to export.");
        return;
    }

    const searchTerm = historySearchInput.value.trim().toLowerCase();
    const searchActive = searchTerm.length >= 3;
    const selectedBrokerId = brokerFilterSelect ? brokerFilterSelect.value : 'all';

    const entriesToExport = allHistoryEntries.filter(entry => {
        if (selectedBrokerId !== 'all' && entry.brokerId !== selectedBrokerId) return false;
        if (entry.timestampMs < currentMinTimestamp || entry.timestampMs > currentMaxTimestamp) return false;
        if (searchActive) {
            const topicMatch = entry.topic.toLowerCase().includes(searchTerm);
            const payloadMatch = entry.payload.toLowerCase().includes(searchTerm);
            return topicMatch || payloadMatch;
        }
        return true;
    });

    if (entriesToExport.length === 0) {
        alert("Current filters result in no data.");
        return;
    }

    const sanitizedEntries = entriesToExport.map(entry => ({
        timestamp: entry.timestamp,
        brokerId: entry.brokerId, 
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
 * Applies current filters (time + search + broker) and re-renders the log.
 * [MODIFIED] Supports "Show More" pagination.
 */
export function renderFilteredHistory() {
    if (!historyLogContainer) return;

    const searchTerm = historySearchInput.value.trim().toLowerCase();
    const searchActive = searchTerm.length >= 3;
    const selectedBrokerId = brokerFilterSelect ? brokerFilterSelect.value : 'all';

    // Filter what is currently in memory
    const filteredEntries = allHistoryEntries.filter(entry => {
        if (selectedBrokerId !== 'all' && entry.brokerId !== selectedBrokerId) return false;

        // Filter by range (handle timestamps)
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
        // [MODIFIED] Limit rendering using visibleCount
        const displayEntries = filteredEntries.slice(0, visibleCount);
        displayEntries.forEach(entry => addHistoryEntry(entry, searchActive ? searchTerm : null));
        
        // [MODIFIED] "Show More" button if there are more entries
        if (filteredEntries.length > visibleCount) {
            const btnContainer = document.createElement('div');
            btnContainer.style.textAlign = 'center';
            btnContainer.style.padding = '15px';
            
            const loadMoreBtn = document.createElement('button');
            loadMoreBtn.className = 'mapper-button'; // Reuse existing style
            loadMoreBtn.style.padding = '8px 20px';
            loadMoreBtn.style.cursor = 'pointer';
            
            const remaining = filteredEntries.length - visibleCount;
            loadMoreBtn.textContent = `Show Next 1000 (${remaining} remaining)`;
            
            loadMoreBtn.onclick = () => {
                visibleCount += 1000;
                renderFilteredHistory(); // Re-render with new limit
            };
            
            btnContainer.appendChild(loadMoreBtn);
            historyLogContainer.appendChild(btnContainer);
        }
    }
}

/**
 * Initializes the History View functionality.
 */
export function initHistoryView(options = {}) {
    isMultiBroker = options.isMultiBroker || false;
    requestRangeCallback = options.requestRangeCallback || null; 
    const brokerConfigs = options.brokerConfigs || [];

    // Debounce search input to trigger backend fetch
    historySearchInput?.addEventListener('input', () => {
        visibleCount = 1000; // [MODIFIED] Reset limit on search
        renderFilteredHistory(); // Instant filter
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

    // Quick Range Buttons
    const btnGrp = document.createElement('div');
    btnGrp.style.display = 'flex';
    btnGrp.style.gap = '5px';
    btnGrp.style.marginTop = '14px';
    btnGrp.style.flexWrap = 'wrap'; 
    
    const createRangeBtn = (text, hours) => {
        const btn = document.createElement('button');
        btn.textContent = text;
        btn.className = 'mapper-button'; 
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

    // Export Button
    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Export JSON';
    exportBtn.className = 'mapper-button';
    exportBtn.style.marginTop = '14px';
    exportBtn.style.backgroundColor = 'var(--color-bg-tertiary)';
    exportBtn.style.border = '1px solid var(--color-success)';
    exportBtn.style.color = 'var(--color-success)';
    exportBtn.title = "Download currently filtered data";
    exportBtn.onclick = exportHistoryToJSON;
    btnGrp.appendChild(exportBtn);

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
            isRealTimeMode = isNow; 
            triggerDataFetch(start, end);
        }
    };
    startDateInput.addEventListener('change', onDateChange);
    endDateInput.addEventListener('change', onDateChange);


    // --- 2. Broker Filter ---
    if (isMultiBroker && historyControls) {
        brokerFilterSelect = document.createElement('select');
        brokerFilterSelect.id = 'history-broker-filter';
        const allOption = document.createElement('option');
        allOption.value = 'all';
        allOption.textContent = 'All Brokers';
        brokerFilterSelect.appendChild(allOption);
        
        brokerConfigs.forEach(config => {
            const option = document.createElement('option');
            option.value = config.id;
            option.textContent = config.id;
            brokerFilterSelect.appendChild(option);
        });
        
        brokerFilterSelect.addEventListener('change', () => {
            visibleCount = 1000; // [MODIFIED] Reset limit on filter change
            renderFilteredHistory();
        });
        historyControls.prepend(brokerFilterSelect);
    }

    // --- 3. Slider Init ---
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
                isRealTimeMode = (newMax >= threshold);

                updateSliderUI();
            },
            onDragEnd: (newMin, newMax) => {
                triggerDataFetch(newMin, newMax);
            }
        });
    }
}

/**
 * Handles quick range buttons.
 */
function setRelativeRange(hours) {
    if (hours === 'FULL') {
        isRealTimeMode = true;
        triggerDataFetch(globalMinTimestamp, Date.now());
        return;
    }

    const end = Date.now();
    let start = end - (hours * 60 * 60 * 1000);
    
    if (globalMinTimestamp > 0 && start < globalMinTimestamp) {
        start = globalMinTimestamp;
    }

    isRealTimeMode = true;
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

/**
 * Called by app.js when DB bounds are received (Initial Load).
 */
export function setDbBounds(min, max) {
    globalMinTimestamp = new Date(min).getTime();
    globalMaxTimestamp = new Date(max).getTime();
    
    currentMinTimestamp = globalMinTimestamp;
    currentMaxTimestamp = globalMaxTimestamp;
    isRealTimeMode = true;

    updateSliderUI();
}

/**
 * Receives data from the main app.
 */
export function setHistoryData(entries, isInitialLoad, isUpdate = false) { 
    if (isUpdate) {
        // Live update: Append new entries to the list
        allHistoryEntries.unshift(...entries);
        
        if (allHistoryEntries.length > MAX_CLIENT_ENTRIES) {
            allHistoryEntries = allHistoryEntries.slice(0, MAX_CLIENT_ENTRIES);
        }

        const newMax = entries[0].timestampMs;
        if (newMax > globalMaxTimestamp) globalMaxTimestamp = newMax;
        
        if (isRealTimeMode) {
            currentMaxTimestamp = globalMaxTimestamp;
        }
    } else {
        // Bulk load
        allHistoryEntries = entries;
        visibleCount = 1000; // [MODIFIED] Reset visible count on new bulk load
        
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
    const brokerPrefix = isMultiBroker ? `[${entry.brokerId}] ` : '';
    topicSpan.innerHTML = highlightText(brokerPrefix + entry.topic, searchTerm); 

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