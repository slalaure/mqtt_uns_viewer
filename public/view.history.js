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
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Import shared utilities
import { formatTimestampForLabel, highlightText, trackEvent } from './utils.js'; // [MODIFIED]
// [NEW] Import the new time slider module
import { createDualTimeSlider } from './time-slider.js';

// --- DOM Element Querying ---
const historyLogContainer = document.getElementById('historical-log-container');
const historySearchInput = document.getElementById('history-search-input');
const timeRangeSliderContainer = document.getElementById('time-range-slider-container');
const handleMin = document.getElementById('handle-min');
const handleMax = document.getElementById('handle-max');
const sliderRange = document.getElementById('slider-range');
const labelMin = document.getElementById('label-min');
const labelMax = document.getElementById('label-max');

// --- Module-level State ---
let allHistoryEntries = [];
let minTimestamp = 0;
let maxTimestamp = 0;
let currentMinTimestamp = 0;
let currentMaxTimestamp = 0;
let historySlider = null; // [NEW] Module instance for the slider

/**
 * [MODIFIED] Applies current filters (time + search) and re-renders the log.
 * This is now exported and named for clarity.
 */
export function renderFilteredHistory() {
    if (!historyLogContainer) return;

    const searchTerm = historySearchInput.value.trim().toLowerCase();
    const searchActive = searchTerm.length >= 3;

    // Filter entries based on the module's state
    const filteredEntries = allHistoryEntries.filter(entry => {
        const inTimeRange = entry.timestampMs >= currentMinTimestamp && entry.timestampMs <= currentMaxTimestamp;
        if (!inTimeRange) return false;
        
        if (searchActive) {
            const topicMatch = entry.topic.toLowerCase().includes(searchTerm);
            const payloadMatch = entry.payload.toLowerCase().includes(searchTerm);
            return topicMatch || payloadMatch;
        }
        return true;
    });

    historyLogContainer.innerHTML = ''; // Clear previous entries
    
    if (filteredEntries.length === 0) {
        historyLogContainer.innerHTML = '<p class="history-placeholder">No log entries match the current filters.</p>';
    } else {
        filteredEntries.forEach(entry => addHistoryEntry(entry, searchActive ? searchTerm : null));
    }
}


/**
 * Initializes the History View functionality.
 * This is called once by app.js when the app loads.
 */
export function initHistoryView() {
    historySearchInput?.addEventListener('input', renderFilteredHistory); // [MODIFIED]
    
    // [NEW] Track when a search is "committed" (on blur or Enter)
    historySearchInput?.addEventListener('change', () => {
        if (historySearchInput.value.trim().length > 0) {
            trackEvent('history_search_submit');
        }
    });


    // [MODIFIED] Initialize the dual time slider
    if (handleMin && handleMax) {
        historySlider = createDualTimeSlider({
            containerEl: timeRangeSliderContainer,
            handleMinEl: handleMin,
            handleMaxEl: handleMax,
            rangeEl: sliderRange,
            labelMinEl: labelMin,
            labelMaxEl: labelMax,
            onDrag: (newMin, newMax) => {
                // Update state continuously while dragging
                currentMinTimestamp = newMin;
                currentMaxTimestamp = newMax;
                updateSliderUI(); // Update labels
            },
            onDragEnd: (newMin, newMax) => {
                // Apply filter only on mouse up
                currentMinTimestamp = newMin;
                currentMaxTimestamp = newMax;
                renderFilteredHistory(); // [MODIFIED] Re-render log
                trackEvent('history_slider_drag_end'); // [NEW]
            }
        });
    }
}

/**
 * [MODIFIED] Receives the full history log and timestamp data from the main app.
 * This function NO LONGER re-renders the log unless it's the initial load.
 * @param {Array} entries - The complete list of history entries.
 * @param {boolean} isInitialLoad - True if this is the first batch of data.
 */
export function setHistoryData(entries, isInitialLoad) { 
    allHistoryEntries = entries;

    if (allHistoryEntries.length === 0) {
        if(timeRangeSliderContainer) timeRangeSliderContainer.style.display = 'none';
        minTimestamp = maxTimestamp = currentMinTimestamp = currentMaxTimestamp = 0;
        if (isInitialLoad) renderFilteredHistory(); // Render empty state
        return { min: 0, max: 0 }; 
    }

    if (timeRangeSliderContainer) timeRangeSliderContainer.style.display = 'block';

    // Check if the handle is at the live edge *before* updating maxTimestamp
    const isLive = (currentMaxTimestamp === maxTimestamp || isInitialLoad);

    // Update global timestamps
    minTimestamp = allHistoryEntries[allHistoryEntries.length - 1].timestampMs;
    maxTimestamp = allHistoryEntries[0].timestampMs;

    if (isInitialLoad) {
        // On first load, set slider to full range
        currentMinTimestamp = minTimestamp;
        currentMaxTimestamp = maxTimestamp;
    } else if (isLive) {
        // If we were 'live', keep the max handle pegged to the new max timestamp
        currentMaxTimestamp = maxTimestamp;
    }
    // If not initialLoad and not isLive, currentMin/MaxTimestamp are *not*
    // touched, preserving the user's selection.

    // [MODIFIED] Only re-render if it's the initial load.
    if (isInitialLoad) {
        renderFilteredHistory();
    }
    
    // Always update the slider's visual range
    updateSliderUI();

    // Return the new state to app.js
    return { 
        min: minTimestamp, 
        max: maxTimestamp
    };
}

/**
 * Updates the visual state of the time range slider
 * by calling the slider module.
 */
function updateSliderUI() {
    if (historySlider) {
        historySlider.updateUI(minTimestamp, maxTimestamp, currentMinTimestamp, currentMaxTimestamp);
    }
}

/**
 * Creates and appends a single log entry to the history container.
 * @param {object} entry - The history entry object.
 * @param {string | null} searchTerm - The term to highlight.
 */
function addHistoryEntry(entry, searchTerm = null) {
    if (!historyLogContainer) return;

    const div = document.createElement('div');
    div.className = 'log-entry';

    const header = document.createElement('div');
    header.className = 'log-entry-header';

    const topicSpan = document.createElement('span');
    topicSpan.className = 'log-entry-topic';
    // Use imported highlight function
    topicSpan.innerHTML = highlightText(entry.topic, searchTerm); 

    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-entry-timestamp';
    timeSpan.textContent = new Date(entry.timestamp).toLocaleTimeString('en-GB');

    header.appendChild(topicSpan);
    header.appendChild(timeSpan);

    const pre = document.createElement('pre');
    try {
        const jsonObj = JSON.parse(entry.payload);
        const prettyPayload = JSON.stringify(jsonObj, null, 2);
        // Use imported highlight function
        pre.innerHTML = highlightText(prettyPayload, searchTerm); 
    } catch(e) {
        // Use imported highlight function
        pre.innerHTML = highlightText(entry.payload, searchTerm); 
    }

    div.appendChild(header);
    div.appendChild(pre);
    
    historyLogContainer.appendChild(div);
}