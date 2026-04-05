/**
 * @license Apache License, Version 2.0 (the "License")
 */

import { createDualTimeSlider } from '../time-slider.js';

/**
 * Web Component for the Chart Time Range Slider.
 */
class ChartTimeSlider extends HTMLElement {
    constructor() {
        super();
        this.sliderLogic = null;
    }

    connectedCallback() {
        this.render();
        this.initSlider();
    }

    render() {
        this.innerHTML = `
            <div id="chart-time-range-slider-container" class="time-slider-container">
                <div class="slider-track"></div>
                <div class="slider-range" id="chart-slider-range"></div>
                <div class="slider-handle" id="chart-handle-min">
                    <div class="slider-label" id="chart-label-min"></div>
                </div>
                <div class="slider-handle" id="chart-handle-max">
                    <div class="slider-label" id="chart-label-max"></div>
                </div>
            </div>
        `;
    }

    initSlider() {
        this.sliderLogic = createDualTimeSlider({
            containerEl: this.querySelector('#chart-time-range-slider-container'),
            handleMinEl: this.querySelector('#chart-handle-min'),
            handleMaxEl: this.querySelector('#chart-handle-max'),
            rangeEl: this.querySelector('#chart-slider-range'),
            labelMinEl: this.querySelector('#chart-label-min'),
            labelMaxEl: this.querySelector('#chart-label-max'),
            onDrag: (newMin, newMax) => {
                this.dispatchEvent(new CustomEvent('time-drag', {
                    detail: { min: newMin, max: newMax },
                    bubbles: true,
                    composed: true
                }));
            },
            onDragEnd: (newMin, newMax) => {
                this.dispatchEvent(new CustomEvent('time-drag-end', {
                    detail: { min: newMin, max: newMax },
                    bubbles: true,
                    composed: true
                }));
            }
        });
    }

    updateUI(minRange, maxRange, currentMin, currentMax) {
        if (this.sliderLogic) {
            this.sliderLogic.updateUI(minRange, maxRange, currentMin, currentMax);
        }
    }
}

customElements.define('chart-time-slider', ChartTimeSlider);
