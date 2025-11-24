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
// [NEW] Maximum number of entries to keep in browser memory to prevent crashes.
// 50,000 objects approx 20-50MB RAM depending on payload size.
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
        // Preserve existing content if possible, or just replace content
        // Replacing content is cleaner to avoid duplicating loaders
        historyLogContainer.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: center; gap: 10px; padding: 20px; color: var(--color-text-secondary);">
                <div class="broker-dot" style="background-color: var(--color-primary); animation: blink 1s infinite;"></div>
                <span>Fetching data...</span>
            </div>
        `;
    }
}

/**
 * Applies current filters (time + search + broker) and re-renders the log.
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
        // Limit rendering to avoid browser freeze
        const displayEntries = filteredEntries.slice(0, 500);
        displayEntries.forEach(entry => addHistoryEntry(entry, searchActive ? searchTerm : null));
        
        if (filteredEntries.length > 500) {
            const limitMsg = document.createElement('div');
            limitMsg.style.textAlign = 'center';
            limitMsg.style.padding = '10px';
            limitMsg.style.color = 'var(--color-text-secondary)';
            limitMsg.textContent = `... showing 500 of ${filteredEntries.length} entries. Narrow filter or range to see more.`;
            historyLogContainer.appendChild(limitMsg);
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
        renderFilteredHistory(); // Instant filter
        clearTimeout(fetchTimer);
        fetchTimer = setTimeout(() => {
            // Also fetch from DB with filter
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
    btnGrp.style.flexWrap = 'wrap'; // Allow buttons to wrap
    
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
    //  Added requested buttons
    btnGrp.appendChild(createRangeBtn('1M', 24*30));
    btnGrp.appendChild(createRangeBtn('3M', 24*30*3));
    btnGrp.appendChild(createRangeBtn('1Y', 24*365));
    btnGrp.appendChild(createRangeBtn('Full', 'FULL'));

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
            // User manually changed date -> Disable Realtime mode unless it implies 'now'
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
        
        // Populate the dropdown with configured brokers
        brokerConfigs.forEach(config => {
            const option = document.createElement('option');
            option.value = config.id;
            option.textContent = config.id;
            brokerFilterSelect.appendChild(option);
        });
        
        brokerFilterSelect.addEventListener('change', renderFilteredHistory);
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
                
                // Tightened Real-time threshold: Only activate if effectively at the very end
                const range = globalMaxTimestamp - globalMinTimestamp;
                // Use a stricter threshold (99.9%) to avoid accidental live mode
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
 * @param {number|string} hours - Number of hours to go back, or 'FULL'.
 */
function setRelativeRange(hours) {
    if (hours === 'FULL') {
        isRealTimeMode = true;
        // Request global bounds
        triggerDataFetch(globalMinTimestamp, Date.now());
        return;
    }

    const end = Date.now();
    let start = end - (hours * 60 * 60 * 1000);
    
    // [FIX] Ensure start does not go below global min to prevent UI bugs (disappearing handle)
    if (globalMinTimestamp > 0 && start < globalMinTimestamp) {
        start = globalMinTimestamp;
    }

    isRealTimeMode = true; // Quick actions usually imply "recent"
    triggerDataFetch(start, end);
}

function triggerDataFetch(start, end) {
    // Update Inputs
    if (startDateInput) startDateInput.value = toDateTimeLocal(start);
    if (endDateInput) endDateInput.value = toDateTimeLocal(end);

    currentMinTimestamp = start;
    currentMaxTimestamp = end;
    updateSliderUI();

    // Show visual feedback immediately
    showLoader();

    // Call Backend
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
    
    // On startup, cover entire range
    currentMinTimestamp = globalMinTimestamp;
    currentMaxTimestamp = globalMaxTimestamp;
    isRealTimeMode = true;

    updateSliderUI();
}

/**
 * Receives data from the main app.
 * @param {Array} entries - Log entries.
 * @param {boolean} isInitialLoad - If true, this is the startup batch.
 * @param {boolean} isUpdate - If true, this is a single live update.
 */
export function setHistoryData(entries, isInitialLoad, isUpdate = false) { 
    if (isUpdate) {
        // Live update: Append new entries to the list
        allHistoryEntries.unshift(...entries);
        
        // [NEW] Memory Protection: Cap the size of the client-side array
        // If we exceed the limit, chop off the oldest entries (at the end of array)
        if (allHistoryEntries.length > MAX_CLIENT_ENTRIES) {
            // Keep the newest 50k
            allHistoryEntries = allHistoryEntries.slice(0, MAX_CLIENT_ENTRIES);
        }

        // Update global max time
        const newMax = entries[0].timestampMs;
        if (newMax > globalMaxTimestamp) globalMaxTimestamp = newMax;
        
        // If in Real-Time Mode, drag the right handle along
        if (isRealTimeMode) {
            currentMaxTimestamp = globalMaxTimestamp;
        }
        // Note: We DO NOT change currentMinTimestamp in live mode unless it was already at globalMin
    } else {
        // Bulk load (Initial or Fetch Range result)
        allHistoryEntries = entries;
        
        // If this was a specific fetch, update bounds logic if needed
        // But usually we trust the query parameters used
        if (entries.length > 2000) {
            // Show warning if result set is huge (popup as requested)
             if(!isInitialLoad) console.log("Notice: The selected range returned a large number of results.");
        }
    }

    // Sync Date Inputs
    if (startDateInput) startDateInput.value = toDateTimeLocal(currentMinTimestamp);
    if (endDateInput) endDateInput.value = toDateTimeLocal(currentMaxTimestamp);

    renderFilteredHistory(); // This will overwrite the loader with content or empty state
    updateSliderUI();

    // Return current view bounds for other modules
    return { min: currentMinTimestamp, max: currentMaxTimestamp };
}

function updateSliderUI() {
    if (historySlider) {
        // The scale is defined by Global bounds
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