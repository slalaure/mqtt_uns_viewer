/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette * @author Sebastien Lalaurette
 * HMI View Module (Formerly SVG View)
 * Handles HTML pages, dynamic A-Frame, generic HTML data binding, 
 * embedded live charts, AND Embedded SVGs with their own JS logic.
 */
import { formatTimestampForLabel, trackEvent, confirmModal } from './utils.js';
import { createSingleTimeSlider } from './time-slider.js';

// --- DOM Element Querying ---
const hmiContent = document.getElementById('svg-content'); 
const svgHistoryToggle = document.getElementById('svg-history-toggle');
const svgTimelineSlider = document.getElementById('svg-timeline-slider-container');
const svgHandle = document.getElementById('svg-handle');
const svgLabel = document.getElementById('svg-label');
const btnSvgFullscreen = document.getElementById('btn-svg-fullscreen');
const mapView = document.getElementById('map-view');
const svgSelectDropdown = document.getElementById('svg-select-dropdown');

// --- Module-level State ---
let hmiInitialStates = new Map();
let allHistoryEntries = [];
let isSvgHistoryMode = false;
let currentMinTimestamp = 0;
let currentMaxTimestamp = 0;
let svgSlider = null;
let appBasePath = '/'; 
let isMultiBroker = false;

// --- Performance Optimization & Chart State ---
let elementCache = new Map(); 
let updateQueue = new Map();  
let animationFrameRequested = false;
let highlightTimers = new Map(); 
let embeddedChartInstances = new Map(); 

// --- [NOUVEAU] Tableau des bindings actifs ---
let activeBindings = [];

/**
 * Universal bindings register (Accumule les scripts au lieu d'en avoir un seul)
 */
window.registerHmiBindings = window.registerSvgBindings = function(bindings) {
    if (!bindings) return;
    activeBindings.push(bindings);
    console.log(`Custom HMI/SVG bindings registered. Total active scripts: ${activeBindings.length}`);
}
/**
 * Initializes the SVG View functionality.
 */export function initSvgView(appConfig) {
    appBasePath = appConfig.basePath; 
    isMultiBroker = appConfig.isMultiBroker; 
    
    if (btnSvgFullscreen) {
        btnSvgFullscreen.innerHTML = '⛶ Maximize';
        btnSvgFullscreen.style.fontSize = '0.85em';
        btnSvgFullscreen.style.padding = '4px 10px';
    }

    // Initial load
    refreshSvgList(appConfig.svgFilePath);
    
    btnSvgFullscreen?.addEventListener('click', toggleFullscreen);

    // Track native fullscreen changes (e.g. user presses ESC)
    document.addEventListener('fullscreenchange', () => {
        if (btnSvgFullscreen) {
            if (document.fullscreenElement === mapView) {
                btnSvgFullscreen.innerHTML = '✖ Minimize';
            } else {
                btnSvgFullscreen.innerHTML = '⛶ Maximize';
            }
        }
    });

    svgSelectDropdown?.addEventListener('change', onHmiFileChange);
    svgHistoryToggle?.addEventListener('change', (e) => {
        isSvgHistoryMode = e.target.checked;
        if (svgTimelineSlider) svgTimelineSlider.style.display = isSvgHistoryMode ? 'flex' : 'none';
        trackEvent(isSvgHistoryMode ? 'hmi_history_on' : 'hmi_history_off');
        if (isSvgHistoryMode) {
            // When turning on, fetch state for the current slider position
            const replayTime = parseFloat(svgHandle.dataset.timestamp || currentMaxTimestamp);
            fetchLastKnownState(replayTime);
        } else {
            // When returning to live mode, fetch latest state immediately
            fetchLastKnownState(Date.now());
        }
        if (svgSlider) {
            svgSlider.updateUI(currentMinTimestamp, currentMaxTimestamp, currentMaxTimestamp);
        }
    });

    if (svgHandle) {
        svgSlider = createSingleTimeSlider({
            containerEl: svgTimelineSlider,
            handleEl: svgHandle,
            labelEl: svgLabel,
            onDrag: (newTime) => {},
            onDragEnd: (newTime) => {
                trackEvent('hmi_slider_drag_end');
                if (isSvgHistoryMode) {
                    fetchLastKnownState(newTime);
                }
            }
        });
    }

    // Add Delete Button to Controls
    const controlsContainer = document.querySelector('.map-view-controls');
    if (controlsContainer && !document.getElementById('btn-delete-hmi')) {
        const btnDelete = document.createElement('button');
        btnDelete.id = 'btn-delete-hmi';
        btnDelete.className = 'tool-button button-danger'; 
        btnDelete.textContent = 'Delete'; 
        btnDelete.title = "Delete current view";
        btnDelete.style.marginLeft = "10px";
        btnDelete.onclick = deleteCurrentHmi;
        controlsContainer.insertBefore(btnDelete, btnSvgFullscreen);
    }
}

/**
 * Receives the full history log from the main app.
 */
export function setSvgHistoryData(entries) {
    allHistoryEntries = entries; 
}

/**
 * Publicly exported function to refresh the dropdown.
 */
export async function refreshSvgList(targetFilenameToSelect = null) {
    if (!svgSelectDropdown) return;
    const currentSelection = targetFilenameToSelect || svgSelectDropdown.value;
    try {
        const response = await fetch('api/svg/list');
        if (!response.ok) throw new Error('Failed to fetch HMI list');
        const hmiFiles = await response.json();
        svgSelectDropdown.innerHTML = '';
        if (hmiFiles.length === 0) {
            svgSelectDropdown.innerHTML = '<option value="">No Views found</option>';
            return;
        }
        let matchFound = false;
        hmiFiles.forEach(filename => {
            const option = document.createElement('option');
            option.value = filename;
            option.textContent = filename;
            if (filename === currentSelection) {
                option.selected = true;
                matchFound = true;
            }
            svgSelectDropdown.appendChild(option);
        });
        if (!matchFound && hmiFiles.length > 0) {
            svgSelectDropdown.value = hmiFiles[0];
            await loadSvgPlan(hmiFiles[0]);
        } else if (matchFound) {
            await loadSvgPlan(currentSelection);
        }
    } catch (error) {
        console.error("Could not populate HMI list:", error);
        svgSelectDropdown.innerHTML = `<option value="">Error loading list</option>`;
    }
}

async function onHmiFileChange(event) {
    const filename = event.target.value;
    if (!filename) return;
    trackEvent('hmi_file_change');
    await loadSvgPlan(filename);
}

async function deleteCurrentHmi() {
    const filename = svgSelectDropdown.value;
    if(!filename) return;
    const isConfirmed = await confirmModal('Delete View', `Are you sure you want to delete '${filename}'?\nThis action cannot be undone.`, 'Delete', true);
    if(!isConfirmed) return;
    try {
        const res = await fetch(`api/svg/file?name=${encodeURIComponent(filename)}`, { method: 'DELETE' });
        if(res.ok) {
            refreshSvgList();
        } else {
            const data = await res.json();
            alert("Error: " + data.error);
        }
    } catch(e) {
        alert("Request failed: " + e.message);
    }
}

/**
 * Dynamically loads the custom svg-bindings.js script *by name*.
 */
async function loadCustomBindingsScript(bindingFilename) {
    return new Promise((resolve) => {
        const script = document.createElement('script');
        script.className = 'custom-hmi-script'; // Tag to remove them later
        script.type = 'module';
        const apiBasePath = (appBasePath === '/') ? '' : appBasePath;
        script.src = `${apiBasePath}/api/svg/bindings.js?name=${encodeURIComponent(bindingFilename)}&v=${Date.now()}`;
        
        script.onload = () => {
            console.log(`Custom script loaded: ${bindingFilename}`);
            resolve();
        };
        script.onerror = () => {
            console.log(`No script found for: ${bindingFilename}`);
            resolve(); 
        };
        document.head.appendChild(script);
    });
}

/**
 * Scans the SVG for [data-key] elements to use with default logic.
 */
function scanForDataKeys() {
    elementCache.clear(); 
    const dataElements = hmiContent.querySelectorAll('[data-key]');
    
    dataElements.forEach(el => {
        const keyPath = el.dataset.key;
        const tagName = el.tagName.toUpperCase();

        if (tagName.startsWith('A-')) {
            const attr = el.dataset.attr || 'value';
            hmiInitialStates.set(el, { type: 'aframe', attr: attr, prop: el.dataset.property, value: el.getAttribute(attr) });
        } else if (el.dataset.attr) {
            if (el.dataset.attr === 'style') {
                const sp = el.dataset.styleProp;
                hmiInitialStates.set(el, { type: 'style', prop: sp, value: sp ? el.style[sp] : el.style.cssText });
            } else if (el.dataset.attr === 'class') {
                hmiInitialStates.set(el, { type: 'class', value: el.className });
            } else {
                hmiInitialStates.set(el, { type: 'attr', attr: el.dataset.attr, value: el.getAttribute(el.dataset.attr) });
            }
        } else if (tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA') {
            hmiInitialStates.set(el, { type: 'prop', prop: 'value', value: el.value });
        } else if (['TEXT', 'TSPAN', 'DIV', 'SPAN', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(tagName)) {
            hmiInitialStates.set(el, { type: 'text', value: el.textContent });
        } else {
            if (tagName === 'PATH' && keyPath === 'status') {
                hmiInitialStates.set(el, { type: 'attr', attr: 'class', value: el.getAttribute('class') });
            } else if (tagName === 'CIRCLE' && keyPath === 'occupancy_percent') {
                hmiInitialStates.set(el, { type: 'attr', attr: 'fill-opacity', value: el.getAttribute('fill-opacity') });
            }
        }
    });
}

function executeEmbeddedScripts() {
    const scripts = hmiContent.querySelectorAll('script');
    scripts.forEach(oldScript => {
        const newScript = document.createElement('script');
        Array.from(oldScript.attributes).forEach(attr => newScript.setAttribute(attr.name, attr.value));
        newScript.appendChild(document.createTextNode(oldScript.innerHTML));
        oldScript.parentNode.replaceChild(newScript, oldScript);
    });
}

async function ensureAFrame(htmlText) {
    if (htmlText && htmlText.includes('<a-scene') && !window.AFRAME) {
        console.log("[HMI] A-Frame 3D Scene detected. Loading A-Frame library...");
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = "https://aframe.io/releases/1.4.2/aframe.min.js";
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }
}

async function initEmbeddedCharts() {
    const chartDivs = hmiContent.querySelectorAll('.embedded-chart');
    if (chartDivs.length === 0) return;
    
    try {
        const res = await fetch('api/chart/config');
        const configData = await res.json();
        const allConfigs = configData.configurations || configData;
        
        chartDivs.forEach(div => {
            const chartId = div.dataset.chartId;
            const config = allConfigs.find(c => c.id === chartId);
            if (!config) return;
            
            div.style.position = 'relative';
            const canvas = document.createElement('canvas');
            div.appendChild(canvas);
            
            const datasets = config.variables.map(v => ({
                label: `${v.topic} | ${v.path}`,
                data: [],
                borderColor: '#3391ff',
                fill: false,
                tension: 0.1,
                _brokerId: v.brokerId || 'default_broker',
                _topic: v.topic,
                _path: v.path
            }));

            const chartInst = new Chart(canvas, {
                type: config.chartType || 'line',
                data: { datasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    scales: { x: { type: 'time', time: { tooltipFormat: 'HH:mm:ss' } } }
                }
            });

            embeddedChartInstances.set(chartId, chartInst);
        });
    } catch (e) {
        console.error("Failed to init embedded charts", e);
    }
}

/**
 * --- [NOUVEAU] Charge les SVGs imbriqués ---
 */
async function initEmbeddedSvgs() {
    const svgContainers = hmiContent.querySelectorAll('.embedded-svg');
    for (const container of svgContainers) {
        const svgName = container.dataset.svgName;
        if (!svgName) continue;
        try {
            // Fetch SVG file content
            const res = await fetch(`api/svg/file?name=${encodeURIComponent(svgName)}`);
            if (res.ok) {
                container.innerHTML = await res.text();
            } else {
                container.innerHTML = `<span style="color:red">Failed to load ${svgName}</span>`;
            }
            // Fetch associated JS script (it will push to activeBindings automatically)
            await loadCustomBindingsScript(svgName + '.js');
        } catch (err) {
            console.error(`Failed to embed SVG ${svgName}:`, err);
        }
    }
}

async function loadSvgPlan(filename) {
    if (!filename) {
        hmiContent.innerHTML = `<p style="color: red; padding: 20px;">Error: No file selected.</p>`;
        return;
    }
    
    // Clear performance state
    updateQueue.clear();
    elementCache.clear();
    highlightTimers.forEach(t => clearTimeout(t));
    highlightTimers.clear();
    embeddedChartInstances.forEach(c => c.destroy());
    embeddedChartInstances.clear();
    
    // Suppression des anciens scripts injectés
    document.querySelectorAll('.custom-hmi-script').forEach(s => s.remove());
    activeBindings = []; // Réinitialise les bindings

    // Appel à reset sur les anciens bindings avant de les vider (si nécessaire)
    activeBindings.forEach(b => { try { b.reset(hmiContent); } catch(e){} });

    try {
        const response = await fetch(`api/svg/file?name=${encodeURIComponent(filename)}&t=${Date.now()}`); 
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const text = await response.text();
        
        if (hmiContent) {
            await ensureAFrame(text);
            hmiContent.innerHTML = text;
            hmiInitialStates.clear();
            
            executeEmbeddedScripts();
            await initEmbeddedCharts();
            
            // --- [NOUVEAU] Charge les vues imbriquées ---
            await initEmbeddedSvgs();
            
            // --- Charge le script de la vue principale ---
            const bindingFilename = filename + '.js'; 
            await loadCustomBindingsScript(bindingFilename);

            // Initialise tous les scripts chargés
            activeBindings.forEach(binding => {
                try { binding.initialize(hmiContent); } catch(e) { console.error(e); }
            });
            
            scanForDataKeys();
            
            if (isSvgHistoryMode) {
                const replayTime = parseFloat(svgHandle.dataset.timestamp || currentMaxTimestamp);
                fetchLastKnownState(replayTime);
            } else {
                fetchLastKnownState(Date.now());
            }
        }
    } catch (error) {
        console.error(`Could not load the file '${filename}':`, error);
        if (hmiContent) hmiContent.innerHTML = `<p style="color: red; padding: 20px;">Error: The file '${filename}' could not be loaded.</p>`;
    }
}

/**
 * Toggles fullscreen mode for the SVG map view.
 */
function toggleFullscreen() {
    trackEvent('hmi_fullscreen_toggle');
    if (!mapView) return;
    if (!document.fullscreenElement) {
        mapView.requestFullscreen().catch(err => {
            console.error(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
        });
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        }
    }
}

/**
 * [HELPER] Safely gets a nested value from an object.
 */
function getNestedValue(obj, path) {
    if (typeof path !== 'string' || !obj) return null;
    return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : null), obj);
}

/**
 * Checks if a value triggers an alarm.
 */
function checkAlarm(currentValue, alarmType, alarmThreshold) {
    if (alarmType === 'EQ') {
        return String(currentValue) === String(alarmThreshold);
    }
    if (alarmType === 'NEQ') {
        return String(currentValue) !== String(alarmThreshold);
    }
    const value = parseFloat(currentValue);
    const threshold = parseFloat(alarmThreshold);
    if (isNaN(value) || isNaN(threshold)) return false;
    switch (alarmType) {
        case 'H': return value > threshold;
        case 'L': return value < threshold;
        default: return false;
    }
}

/**
 * Updates a single SVG element.
 */
function updateHmiElement(el, keyPath, value) {
    const numericValue = parseFloat(value);
    const tagName = el.tagName.toUpperCase();

    if (tagName.startsWith('A-')) {
        const attr = el.dataset.attr || 'value';
        const prop = el.dataset.property;
        if (prop) el.setAttribute(attr, prop, value); 
        else el.setAttribute(attr, value);
        return;
    }

    const attr = el.dataset.attr;
    if (attr) {
        if (attr === 'style') {
            const styleProp = el.dataset.styleProp;
            if (styleProp) el.style[styleProp] = value;
            else el.style.cssText = value;
        } else if (attr === 'class') {
            el.className = value;
        } else {
            el.setAttribute(attr, value);
        }
        return;
    }

    if (tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA') {
        el.value = value;
        return;
    }

    if (['TEXT', 'TSPAN', 'DIV', 'SPAN', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(tagName)) {
        if (keyPath.includes('status') || keyPath === 'alert_level' || keyPath === 'global_status') {
            const v = String(value).toLowerCase();
            let color = '';
            if (['damaged', 'offline', 'breached', 'error', 'stopped_emergency', 'cancelled', 'interrupted', 'sag detected'].some(s => v.includes(s))) color = '#f85149';
            else if (['online', 'empty', 'green', 'clear', 'patrol', 'ok', 'running', 'nominal'].includes(v)) color = '#3fb950';
            else color = '#d29922';

            if (tagName === 'TEXT' || tagName === 'TSPAN') el.setAttribute('fill', color);
            else el.style.color = color;
            
            if (color === '#f85149' && !el.classList.contains('text-data')) el.classList.add('alarm-text');
            else el.classList.remove('alarm-text');
        }
        if (typeof value === 'number' && !Number.isInteger(value)) el.textContent = parseFloat(value).toFixed(2);
        else el.textContent = value;
        return;
    }
    
    // Legacy SVG
    if (el.id === 'shield-visual-effect' && keyPath === 'power' && !isNaN(numericValue)) {
        const opacity = Math.max(0, Math.min(1, (numericValue / 100.0) * 0.7 + 0.1));
        const width = 2 + (numericValue / 100.0) * 8;
        el.setAttribute('stroke-opacity', opacity.toFixed(2));
        el.setAttribute('stroke-width', width.toFixed(2));
        return; 
    }
    if (el.id === 'laser-charge-visual' && keyPath === 'value' && !isNaN(numericValue)) {
        const chargeWidth = Math.max(0, (numericValue / 100.0) * 140);
        el.setAttribute('width', chargeWidth.toFixed(2));
        return; 
    }
}

/**
 * Process the update queue via RequestAnimationFrame to prevent UI freezing.
 * Wrapped in try/finally to guarantee animationFrameRequested resets.
 */
function flushUpdateQueue() {
    try {
        const root = hmiContent;
        if (!root) return;
        
        updateQueue.forEach((data, key) => {
            const { brokerId, topic, payloadObject, isJson } = data;
            
            // --- Exécute TOUS les scripts de bindings actifs ---
            activeBindings.forEach(binding => {
                try { binding.update(brokerId, topic, payloadObject, root); } 
                catch (err) { console.error(`[HMI Script Error] Topic ${topic}:`, err); }
            });
            
            if (isJson) {
                const specificId = isMultiBroker ? `${brokerId}-${topic.replace(/\//g, '-')}` : topic.replace(/\//g, '-');
                const genericId = topic.replace(/\//g, '-');
                const idsToTry = [specificId, genericId];
                
                idsToTry.forEach(id => {
                    let elements = elementCache.get(id);
                    if (elements === undefined) {
                        try { elements = hmiContent.querySelectorAll(`[id="${id}"]`); } catch (e) { elements = []; }
                        elementCache.set(id, elements);
                    }
                    elements.forEach(groupElement => {
                        groupElement.querySelectorAll('[data-key]').forEach(el => {
                            const value = getNestedValue(payloadObject, el.dataset.key);
                            if (value !== null && value !== undefined) updateHmiElement(el, el.dataset.key, value);
                        });
                        groupElement.classList.add('highlight-svg-default');
                        if (highlightTimers.has(groupElement)) clearTimeout(highlightTimers.get(groupElement));
                        highlightTimers.set(groupElement, setTimeout(() => {
                            groupElement.classList.remove('highlight-svg-default');
                            highlightTimers.delete(groupElement);
                        }, 500));
                    });
                });
            }
        });

        embeddedChartInstances.forEach((chartInst, chartId) => {
            let updated = false;
            chartInst.data.datasets.forEach(ds => {
                const queueKey = `${ds._brokerId}:${ds._topic}`;
                if (updateQueue.has(queueKey)) {
                    const data = updateQueue.get(queueKey);
                    const val = getNestedValue(data.payloadObject, ds._path);
                    if (val !== null && val !== undefined) {
                        ds.data.push({ x: Date.now(), y: parseFloat(val) });
                        if (ds.data.length > 100) ds.data.shift(); 
                        updated = true;
                    }
                }
            });
            if (updated) chartInst.update();
        });

    } catch (globalErr) {
        console.error("Critical error in HMI render loop:", globalErr);
    } finally {
        updateQueue.clear();
        animationFrameRequested = false;
    }
}

/**
 * Main update router function. Throttled via Queue.
 */
export function updateMap(brokerId, topic, payload) {
    if (svgHistoryToggle?.checked || !hmiContent) return;
    let payloadObject;
    let isJson = false;
    try { payloadObject = JSON.parse(payload); isJson = true; } catch (e) { payloadObject = payload; }
    
    updateQueue.set(`${brokerId}:${topic}`, { brokerId, topic, payloadObject, isJson });
    if (!animationFrameRequested) {
        animationFrameRequested = true;
        requestAnimationFrame(flushUpdateQueue);
    }
}

/**
 * Updates the UI of the SVG timeline slider
 */
export function updateSvgTimelineUI(min, max) {
    if (!svgSlider) return;
    currentMinTimestamp = min;
    currentMaxTimestamp = max;
    if (!isSvgHistoryMode) return; 
    const currentTimestamp = parseFloat(svgHandle.dataset.timestamp || currentMaxTimestamp);
    svgSlider.updateUI(currentMinTimestamp, currentMaxTimestamp, currentTimestamp);
}

/**
 * Force an explicit fetch of the latest real-time data from the DB.
 * Used when switching tabs so the user doesn't wait for the next ping.
 */
export function refreshSvgLiveState() {
    if (!isSvgHistoryMode && hmiContent && hmiContent.children.length > 0) {
        fetchLastKnownState(Date.now());
    }
}

/**
 * Fetches the system state from DuckDB for a specific timestamp
 * and applies it to the SVG. Replaces local replaySvgHistory.
 */
async function fetchLastKnownState(timestamp) {
    if (!hmiContent || hmiContent.children.length === 0) return;
    hmiContent.style.opacity = '0.5';
    
    hmiInitialStates.forEach((state, element) => {
        if (state.type === 'text') element.textContent = state.value;
        else if (state.type === 'attr' || state.type === 'aframe') element.setAttribute(state.attr, state.value);
        else if (state.type === 'style') element.style[state.prop] = state.value;
        else if (state.type === 'class') element.className = state.value;
        else if (state.type === 'prop') element[state.prop] = state.value;

        element.classList.remove('alarm-text', 'highlight-svg-default');
        if (['#f85149', '#d29922', '#3fb950', '#58a6ff'].includes(element.getAttribute('fill') || element.style.color)) {
            element.removeAttribute('fill');
            element.style.color = '';
        }
    });

    hmiContent.querySelectorAll('.alarm-line').forEach(el => el.style.visibility = 'hidden');
    highlightTimers.forEach(t => clearTimeout(t));
    highlightTimers.clear();

    // Reset sur TOUS les bindings actifs
    activeBindings.forEach(binding => {
        try { binding.reset(hmiContent); } catch (err) {}
    });

    try {
        const isoTime = new Date(timestamp).toISOString();
        const response = await fetch(`api/context/last-known?timestamp=${encodeURIComponent(isoTime)}`);
        if (!response.ok) throw new Error("Failed to fetch state");       
        const stateData = await response.json(); 
        
        stateData.forEach(entry => {
            const { broker_id: brokerId, topic, payload } = entry;
            let payloadObject;
            let isJson = false;
            try { payloadObject = JSON.parse(payload); isJson = true; } catch (e) { payloadObject = payload; }
            
            // Mise à jour via TOUS les bindings
            activeBindings.forEach(binding => {
                try { binding.update(brokerId, topic, payloadObject, hmiContent); } catch (err) {}
            });

            if (isJson) {
                const specificId = isMultiBroker ? `${brokerId}-${topic.replace(/\//g, '-')}` : topic.replace(/\//g, '-');
                const genericId = topic.replace(/\//g, '-');         
                try {
                    hmiContent.querySelectorAll(`[id="${specificId}"], [id="${genericId}"]`).forEach(groupElement => {
                        groupElement.querySelectorAll('[data-key]').forEach(el => {
                            const value = getNestedValue(payloadObject, el.dataset.key);
                            if (value !== null && value !== undefined) updateHmiElement(el, el.dataset.key, value);
                        });
                    });
                } catch(e) {} 
            }
        });
    } catch (err) {
        console.error("Error fetching historical state:", err);
    } finally {
        hmiContent.style.opacity = '1';
    }
}