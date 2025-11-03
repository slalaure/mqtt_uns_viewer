/**
 * @license MIT
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

    function makeDraggable(handle, isMin) {
        if (!handle || !containerEl) return;

        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const sliderRect = containerEl.getBoundingClientRect();

            const onMouseMove = (moveEvent) => {
                let x = moveEvent.clientX - sliderRect.left;
                let percent = (x / sliderRect.width) * 100;
                percent = Math.max(0, Math.min(100, percent));
                
                const timeRange = maxTimestamp - minTimestamp;
                if (timeRange <= 0) return; // Don't drag if no range
                
                const newTimestamp = minTimestamp + (timeRange * percent / 100);

                if (isMin) {
                    currentMin = Math.min(newTimestamp, currentMax);
                } else {
                    currentMax = Math.max(newTimestamp, currentMin);
                }
                
                // Call the continuous drag callback
                if (onDrag) {
                    onDrag(currentMin, currentMax);
                }
            };

            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                // Call the drag end callback
                if (onDragEnd) {
                    onDragEnd(currentMin, currentMax);
                }
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }
    
    makeDraggable(handleMinEl, true);
    makeDraggable(handleMaxEl, false);

    /**
     * Updates the UI of the slider.
     * @param {number} newMinRange - The new overall minimum timestamp.
     * @param {number} newMaxRange - The new overall maximum timestamp.
     * @param {number} newCurrentMin - The new selected minimum timestamp.
     * @param {number} newCurrentMax - The new selected maximum timestamp.
     */
    function updateUI(newMinRange, newMaxRange, newCurrentMin, newCurrentMax) {
        minTimestamp = newMinRange;
        maxTimestamp = newMaxRange;
        currentMin = newCurrentMin;
        currentMax = newCurrentMax;

        if (!handleMinEl || !rangeEl || !labelMinEl) return;
        
        const timeRange = maxTimestamp - minTimestamp;
        if (timeRange <= 0) {
            handleMinEl.style.left = '0%';
            handleMaxEl.style.left = '100%';
            rangeEl.style.left = '0%';
            rangeEl.style.width = '100%';
            labelMinEl.textContent = formatTimestampForLabel(currentMin);
            labelMaxEl.textContent = formatTimestampForLabel(currentMax);
            return;
        }

        const minPercent = ((currentMin - minTimestamp) / timeRange) * 100;
        const maxPercent = ((currentMax - minTimestamp) / timeRange) * 100;
        
        handleMinEl.style.left = `${minPercent}%`;
        handleMaxEl.style.left = `${maxPercent}%`;
        rangeEl.style.left = `${minPercent}%`;
        rangeEl.style.width = `${maxPercent - minPercent}%`;
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
     * @param {number} newMinRange - The new overall minimum timestamp.
     * @param {number} newMaxRange - The new overall maximum timestamp.
     * @param {number} newCurrentTime - The new selected timestamp.
     */
    function updateUI(newMinRange, newMaxRange, newCurrentTime) {
        minTimestamp = newMinRange;
        maxTimestamp = newMaxRange;
        currentTime = newCurrentTime;

        if (!handleEl || !labelEl) return;

        const timeRange = maxTimestamp - minTimestamp;
        if (timeRange <= 0) {
            handleEl.style.left = '100%'; // Default to end
            labelEl.textContent = formatTimestampForLabel(currentTime);
            handleEl.dataset.timestamp = currentTime;
            return;
        }
        
        const currentPercent = ((currentTime - minTimestamp) / timeRange) * 100;
        
        handleEl.style.left = `${currentPercent}%`;
        labelEl.textContent = formatTimestampForLabel(currentTime);
        handleEl.dataset.timestamp = currentTime;
    }
    
    return {
        updateUI
    };
}