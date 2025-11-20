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
 * Reusable Time Slider Module
 * Encapsulates logic for single- and dual-handle time sliders.
 */

import { formatTimestampForLabel } from './utils.js';

/**
 * Creates and manages a dual-handle time range slider.
 * @param {object} options
 * @param {HTMLElement} options.containerEl - The slider's parent container.
 * @param {HTMLElement} options.handleMinEl - The minimum handle element.
 * @param {HTMLElement} options.handleMaxEl - The maximum handle element.
 * @param {HTMLElement} options.rangeEl - The element for the highlighted range bar.
 * @param {HTMLElement} options.labelMinEl - The label for the minimum handle.
 * @param {HTMLElement} options.labelMaxEl - The label for the maximum handle.
 * @param {function} options.onDrag - (newMin, newMax) => void : Called continuously on drag.
 * @param {function} options.onDragEnd - (newMin, newMax) => void : Called on mouse up.
 */
export function createDualTimeSlider(options) {
    const { 
        containerEl, handleMinEl, handleMaxEl, 
        rangeEl, labelMinEl, labelMaxEl,
        onDrag, onDragEnd 
    } = options;

    let minTimestamp = 0;
    let maxTimestamp = 0;
    let currentMin = 0;
    let currentMax = 0;

    // Helper to get percentage from mouse X
    function getPercentage(clientX, rect) {
        let x = clientX - rect.left;
        let percent = (x / rect.width) * 100;
        return Math.max(0, Math.min(100, percent));
    }

    // --- Handle Dragging Logic ---
    function makeHandleDraggable(handle, isMin) {
        if (!handle || !containerEl) return;

        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation(); // Prevent triggering range drag
            const sliderRect = containerEl.getBoundingClientRect();

            const onMouseMove = (moveEvent) => {
                let percent = getPercentage(moveEvent.clientX, sliderRect);
                
                const timeRange = maxTimestamp - minTimestamp;
                if (timeRange <= 0) return;
                
                const newTimestamp = minTimestamp + (timeRange * percent / 100);

                if (isMin) {
                    currentMin = Math.min(newTimestamp, currentMax);
                } else {
                    currentMax = Math.max(newTimestamp, currentMin);
                }
                
                if (onDrag) onDrag(currentMin, currentMax);
            };

            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                if (onDragEnd) onDragEnd(currentMin, currentMax);
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }

    // --- Range Bar Dragging Logic ---
    function makeRangeDraggable() {
        if (!rangeEl || !containerEl) return;

        rangeEl.style.cursor = 'grab';

        rangeEl.addEventListener('mousedown', (e) => {
            e.preventDefault();
            rangeEl.style.cursor = 'grabbing';
            
            const sliderRect = containerEl.getBoundingClientRect();
            const startX = e.clientX;
            
            // Store initial state to calculate delta
            const startMin = currentMin;
            const startMax = currentMax;
            const duration = startMax - startMin;
            const totalSpan = maxTimestamp - minTimestamp;

            if (totalSpan <= 0) return;

            const onMouseMove = (moveEvent) => {
                const currentX = moveEvent.clientX;
                const pixelDelta = currentX - startX;
                
                // Convert pixel delta to time delta
                const timeDelta = (pixelDelta / sliderRect.width) * totalSpan;
                
                let newMin = startMin + timeDelta;
                let newMax = startMax + timeDelta;

                // Clamp to bounds while maintaining duration size
                if (newMin < minTimestamp) {
                    newMin = minTimestamp;
                    newMax = minTimestamp + duration;
                }
                if (newMax > maxTimestamp) {
                    newMax = maxTimestamp;
                    newMin = maxTimestamp - duration;
                }

                currentMin = newMin;
                currentMax = newMax;

                if (onDrag) onDrag(currentMin, currentMax);
            };

            const onMouseUp = () => {
                rangeEl.style.cursor = 'grab';
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                if (onDragEnd) onDragEnd(currentMin, currentMax);
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }
    
    makeHandleDraggable(handleMinEl, true);
    makeHandleDraggable(handleMaxEl, false);
    makeRangeDraggable(); // Initialize range dragging

    /**
     * Updates the UI of the slider.
     */
    function updateUI(newMinRange, newMaxRange, newCurrentMin, newCurrentMax) {
        minTimestamp = newMinRange;
        maxTimestamp = newMaxRange;
        currentMin = newCurrentMin;
        currentMax = newCurrentMax;

        if (!handleMinEl || !rangeEl || !labelMinEl) return;
        
        const timeRange = maxTimestamp - minTimestamp;
        
        let minPercent = 0;
        let maxPercent = 100;

        if (timeRange > 0) {
            minPercent = ((currentMin - minTimestamp) / timeRange) * 100;
            maxPercent = ((currentMax - minTimestamp) / timeRange) * 100;
        }
        
        // Visual Clamping to prevent elements flying off-screen
        minPercent = Math.max(0, Math.min(100, minPercent));
        maxPercent = Math.max(0, Math.min(100, maxPercent));

        handleMinEl.style.left = `${minPercent}%`;
        handleMaxEl.style.left = `${maxPercent}%`;
        rangeEl.style.left = `${minPercent}%`;
        rangeEl.style.width = `${Math.max(0, maxPercent - minPercent)}%`;
        
        labelMinEl.textContent = formatTimestampForLabel(currentMin);
        labelMaxEl.textContent = formatTimestampForLabel(currentMax);
    }
    
    return {
        updateUI
    };
}

/**
 * Creates and manages a single-handle time slider.
 * @param {object} options
 * @param {HTMLElement} options.containerEl - The slider's parent container.
 * @param {HTMLElement} options.handleEl - The handle element.
 * @param {HTMLElement} options.labelEl - The label for the handle.
 * @param {function} options.onDrag - (newTime) => void : Called continuously on drag.
 * @param {function} options.onDragEnd - (newTime) => void : Called on mouse up.
 */
export function createSingleTimeSlider(options) {
    const { containerEl, handleEl, labelEl, onDrag, onDragEnd } = options;

    let minTimestamp = 0;
    let maxTimestamp = 0;
    let currentTime = 0;
    
    function makeDraggable() {
        if (!handleEl || !containerEl) return;

        handleEl.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const sliderRect = containerEl.getBoundingClientRect();

            const onMouseMove = (moveEvent) => {
                let x = moveEvent.clientX - sliderRect.left;
                let percent = (x / sliderRect.width) * 100;
                percent = Math.max(0, Math.min(100, percent));
                
                const timeRange = maxTimestamp - minTimestamp;
                if (timeRange <= 0) return;
                
                const newTimestamp = minTimestamp + (timeRange * percent / 100);
                currentTime = newTimestamp; // Update internal current time
                
                // Update UI elements
                handleEl.style.left = `${percent}%`;
                handleEl.dataset.timestamp = newTimestamp; // Store for persistence
                labelEl.textContent = formatTimestampForLabel(newTimestamp);
                
                // Call continuous drag callback
                if (onDrag) {
                    onDrag(newTimestamp);
                }
            };
            
            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                if (onDragEnd) {
                    onDragEnd(currentTime);
                }
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }
    
    makeDraggable();

    /**
     * Updates the UI of the slider.
     */
    function updateUI(newMinRange, newMaxRange, newCurrentTime) {
        minTimestamp = newMinRange;
        maxTimestamp = newMaxRange;
        currentTime = newCurrentTime;

        if (!handleEl || !labelEl) return;

        const timeRange = maxTimestamp - minTimestamp;
        let currentPercent = 100;

        if (timeRange > 0) {
            currentPercent = ((currentTime - minTimestamp) / timeRange) * 100;
        }
        
        // Visual Clamping
        currentPercent = Math.max(0, Math.min(100, currentPercent));
        
        handleEl.style.left = `${currentPercent}%`;
        labelEl.textContent = formatTimestampForLabel(currentTime);
        handleEl.dataset.timestamp = currentTime;
    }
    
    return {
        updateUI
    };
}