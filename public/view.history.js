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
import { formatTimestampForLabel, highlightText } from './utils.js';

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

/**
 * Initializes the History View functionality.
 * This is called once by app.js when the app loads.
 */
export function initHistoryView() {
    historySearchInput?.addEventListener('input', applyAndRenderFilters);

    if (handleMin && handleMax) {
        makeDraggable(handleMin, true);
        makeDraggable(handleMax, false);
    }
}

/**
 * Receives the full history log and timestamp data from the main app.
 * @param {Array} entries - The complete list of history entries.
 * @param {boolean} isInitialLoad - True if this is the first batch of data.
 */
export function setHistoryData(entries, isInitialLoad) { // [MODIFIED] Removed isLive
    allHistoryEntries = entries;

    if (allHistoryEntries.length === 0) {
        if(timeRangeSliderContainer) timeRangeSliderContainer.style.display = 'none';
        minTimestamp = maxTimestamp = currentMinTimestamp = currentMaxTimestamp = 0;
        applyAndRenderFilters(); // Render empty state
        return { min: 0, max: 0 }; // [MODIFIED] Return state
    }

    if (timeRangeSliderContainer) timeRangeSliderContainer.style.display = 'block';

    // [MODIFIED] Check if the handle is at the live edge *before* updating maxTimestamp
    const isLive = currentMaxTimestamp === maxTimestamp;

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

    // Re-render and update UI
    applyAndRenderFilters();
    updateSliderUI();

    // Return the new state to app.js
    return { 
        min: minTimestamp, 
        max: maxTimestamp
        // [MODIFIED] Removed currentMin/Max from return
    };
}

/**
 * Applies current filters (time + search) and re-renders the log.
 */
function applyAndRenderFilters() {
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
    filteredEntries.forEach(entry => addHistoryEntry(entry, searchActive ? searchTerm : null));
}

/**
 * Updates the visual state of the time range slider.
 */
function updateSliderUI() {
    if (!handleMin || !sliderRange || !labelMin) return;

    const timeRange = maxTimestamp - minTimestamp;
    if (timeRange <= 0) {
        // Handle case with only one message
        handleMin.style.left = '0%';
        handleMax.style.left = '100%';
        sliderRange.style.left = '0%';
        sliderRange.style.width = '100%';
        labelMin.textContent = formatTimestampForLabel(currentMinTimestamp);
        labelMax.textContent = formatTimestampForLabel(currentMaxTimestamp);
        return;
    }

    const minPercent = ((currentMinTimestamp - minTimestamp) / timeRange) * 100;
    const maxPercent = ((currentMaxTimestamp - minTimestamp) / timeRange) * 100;
    
    handleMin.style.left = `${minPercent}%`;
    handleMax.style.left = `${maxPercent}%`;
    sliderRange.style.left = `${minPercent}%`;
    sliderRange.style.width = `${maxPercent - minPercent}%`;
    labelMin.textContent = formatTimestampForLabel(currentMinTimestamp);
    labelMax.textContent = formatTimestampForLabel(currentMaxTimestamp);
}

/**
 * Makes a slider handle draggable.
 * @param {HTMLElement} handle - The handle element.
 * @param {boolean} isMin - True if this is the minimum handle.
 */
function makeDraggable(handle, isMin) {
    if (!handle || !timeRangeSliderContainer) return;

    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const sliderRect = timeRangeSliderContainer.getBoundingClientRect();

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
            updateSliderUI();
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            applyAndRenderFilters(); // Re-render log with new time range
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
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