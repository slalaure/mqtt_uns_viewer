/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * HMI View Module (Formerly SVG View)
 * Handles HTML pages, dynamic A-Frame, generic HTML data binding, 
 * embedded live charts, AND Embedded SVGs with their own JS logic.
 * [UPDATED] Implemented View Lifecycle Teardown (mount/unmount) to prevent memory leaks.
 */
import { formatTimestampForLabel, trackEvent, confirmModal, showToast } from './utils.js';
import { createSingleTimeSlider } from './time-slider.js';

// --- DOM Element Querying ---
const hmiContent = document.getElementById('hmi-content'); 
if (hmiContent && !hmiContent.getElementById) {
    // Compatibility shim for older scripts expecting getElementById on the root element
    hmiContent.getElementById = (id) => hmiContent.querySelector(`[id="${id}"]`);
}
const hmiHistoryToggle = document.getElementById('hmi-history-toggle');
const hmiTimelineSlider = document.getElementById('hmi-timeline-slider-container');
const hmiHandle = document.getElementById('hmi-handle');
const hmiLabel = document.getElementById('hmi-label');
const btnHmiFullscreen = document.getElementById('btn-hmi-fullscreen');
const hmiView = document.getElementById('hmi-view');
const hmiSelectDropdown = document.getElementById('hmi-select-dropdown');
let btnDeleteHmi = null;
let btnExportHmi = null;
let btnImportHmi = null;
let importHmiInput = null; // Dynamically created

// --- Module-level State ---
let hmiInitialStates = new Map();
let allHistoryEntries = [];
let isHmiHistoryMode = false;
let currentMinTimestamp = 0;
let currentMaxTimestamp = 0;
let hmiSlider = null;
let appBasePath = '/'; 
let isMultiSource = false;
let isMounted = false; // Lifecycle flag

// --- Performance Optimization & Chart State ---
let elementCache = new Map(); 
let updateQueue = new Map();  
let animationFrameRequested = false;
let highlightTimers = new Map(); 
let embeddedChartInstances = new Map(); 

/**
 * Controlled Execution Context for HMI scripts.
 * Automatically tracks and cleans up timers and animation frames.
 */
class HmiLifecycleContext {
    constructor() {
        this.intervals = [];
        this.timeouts = [];
        this.animationFrames = [];
        this.eventListeners = [];
        this.isDestroyed = false;
    }

    setInterval(fn, ms) {
        if (this.isDestroyed) return null;
        const id = window.setInterval(fn, ms);
        this.intervals.push(id);
        return id;
    }

    setTimeout(fn, ms) {
        if (this.isDestroyed) return null;
        const id = window.setTimeout(fn, ms);
        this.timeouts.push(id);
        return id;
    }

    requestAnimationFrame(fn) {
        if (this.isDestroyed) return null;
        const id = window.requestAnimationFrame((t) => {
            if (!this.isDestroyed) fn(t);
        });
        this.animationFrames.push(id);
        return id;
    }

    addEventListener(target, type, listener, options) {
        if (this.isDestroyed) return;
        target.addEventListener(type, listener, options);
        this.eventListeners.push({ target, type, listener, options });
    }

    destroy() {
        this.isDestroyed = true;
        this.intervals.forEach(id => window.clearInterval(id));
        this.timeouts.forEach(id => window.clearTimeout(id));
        this.animationFrames.forEach(id => window.cancelAnimationFrame(id));
        this.eventListeners.forEach(l => l.target.removeEventListener(l.type, l.listener, l.options));
        this.intervals = [];
        this.timeouts = [];
        this.animationFrames = [];
        this.eventListeners = [];
    }
}

// --- Tableau des bindings actifs ---
let activeBindings = [];
let currentHmiContext = null;
const BINDINGS_SCRIPT_ID = 'custom-hmi-bindings-script';

/**
 * Universal bindings register (Accumule les scripts au lieu d'en avoir un seul)
 */
window.registerHmiBindings = window.registerSvgBindings = function(bindings) {
    if (!bindings) return;
    activeBindings.push(bindings);
    console.log(`Custom HMI bindings registered. Total active scripts: ${activeBindings.length}`);
}

// --- Named Event Handlers (for clean unmounting) ---

const onFullscreenChange = () => {
    if (btnHmiFullscreen) {
        if (document.fullscreenElement === hmiView) {
            btnHmiFullscreen.innerHTML = '✖ Minimize';
        } else {
            btnHmiFullscreen.innerHTML = '⛶ Maximize';
        }
    }
};

const onHistoryToggleChange = (e) => {
    isHmiHistoryMode = e.target.checked;
    if (hmiTimelineSlider) hmiTimelineSlider.style.display = isHmiHistoryMode ? 'flex' : 'none';
    trackEvent(isHmiHistoryMode ? 'hmi_history_on' : 'hmi_history_off');
    if (isHmiHistoryMode) {
        const replayTime = parseFloat(hmiHandle.dataset.timestamp || currentMaxTimestamp);
        fetchLastKnownState(replayTime);
    } else {
        fetchLastKnownState(Date.now());
    }
    if (hmiSlider) {
        hmiSlider.updateUI(currentMinTimestamp, currentMaxTimestamp, currentMaxTimestamp);
    }
};

/**
 * Unmounts the HMI view (Removes listeners, pauses logic).
 * Aliased to onHmiViewHide to maintain router compatibility.
 */
export function onHmiViewHide() {
    if (!isMounted) return;

    console.log("[HMI View] View hidden. Suspending lifecycle context & unmounting...");
    
    if (currentHmiContext) {
        currentHmiContext.destroy();
        currentHmiContext = null;
    }
    // Also clear the update queue and animation frame request to stop core updates
    updateQueue.clear();
    animationFrameRequested = false;

    // Remove DOM listeners
    btnHmiFullscreen?.removeEventListener('click', toggleFullscreen);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    hmiSelectDropdown?.removeEventListener('change', onHmiFileChange);
    hmiHistoryToggle?.removeEventListener('change', onHistoryToggleChange);
    btnDeleteHmi?.removeEventListener('click', deleteCurrentHmi);
    btnExportHmi?.removeEventListener('click', exportCurrentHmi);
    btnImportHmi?.removeEventListener('click', triggerHmiImport);

    isMounted = false;
}

/**
 * Mounts the HMI view (Attaches listeners, resumes logic).
 * Aliased to onHmiViewShow to maintain router compatibility.
 */
export function onHmiViewShow() {
    if (isMounted) return;

    console.log("[HMI View] View shown. Resuming HMI lifecycle & mounting...");
    
    // Attach DOM listeners
    btnHmiFullscreen?.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    hmiSelectDropdown?.addEventListener('change', onHmiFileChange);
    hmiHistoryToggle?.addEventListener('change', onHistoryToggleChange);
    btnDeleteHmi?.addEventListener('click', deleteCurrentHmi);
    btnExportHmi?.addEventListener('click', exportCurrentHmi);
    btnImportHmi?.addEventListener('click', triggerHmiImport);

    if (activeBindings.length > 0 && hmiContent) {
        // If we have active bindings, re-initialize them with a fresh context
        if (currentHmiContext) currentHmiContext.destroy();
        currentHmiContext = new HmiLifecycleContext();
        activeBindings.forEach(binding => {
            try { 
                if (typeof binding.initialize === 'function') {
                    binding.initialize(hmiContent, currentHmiContext); 
                }
            } catch(e) { console.error(e); }
        });
    }

    isMounted = true;
}

/**
 * Initializes the HMI View DOM Structure (Called once).
 */
export function initHmiView(appConfig) {
    appBasePath = appConfig.basePath; 
    isMultiSource = appConfig.isMultiSource; 
    
    if (btnHmiFullscreen) {
        btnHmiFullscreen.innerHTML = '⛶ Maximize';
        btnHmiFullscreen.style.fontSize = '0.85em';
        btnHmiFullscreen.style.padding = '4px 10px';
    }

    refreshHmiList(appConfig.hmiFilePath || appConfig.svgFilePath);

    if (hmiHandle) {
        hmiSlider = createSingleTimeSlider({
            containerEl: hmiTimelineSlider,
            handleEl: hmiHandle,
            labelEl: hmiLabel,
            onDrag: (newTime) => {},
            onDragEnd: (newTime) => {
                trackEvent('hmi_slider_drag_end');
                if (isHmiHistoryMode) {
                    fetchLastKnownState(newTime);
                }
            }
        });
    }

    const controlsContainer = document.querySelector('.hmi-view-controls') || document.querySelector('.map-view-controls');
    if (controlsContainer && !document.getElementById('btn-delete-hmi')) {
        btnImportHmi = document.createElement('button');
        btnImportHmi.id = 'btn-import-hmi';
        btnImportHmi.className = 'tool-button';
        btnImportHmi.textContent = 'Import';
        btnImportHmi.title = "Import HMI files";
        btnImportHmi.style.marginLeft = "10px";
        controlsContainer.insertBefore(btnImportHmi, btnHmiFullscreen);

        btnExportHmi = document.createElement('button');
        btnExportHmi.id = 'btn-export-hmi';
        btnExportHmi.className = 'tool-button';
        btnExportHmi.textContent = 'Export';
        btnExportHmi.title = "Export current view and its JS bindings";
        btnExportHmi.style.marginLeft = "5px";
        controlsContainer.insertBefore(btnExportHmi, btnHmiFullscreen);

        btnDeleteHmi = document.createElement('button');
        btnDeleteHmi.id = 'btn-delete-hmi';
        btnDeleteHmi.className = 'tool-button button-danger';
        btnDeleteHmi.textContent = 'Delete';
        btnDeleteHmi.title = "Delete current view";
        btnDeleteHmi.style.marginLeft = "5px";
        controlsContainer.insertBefore(btnDeleteHmi, btnHmiFullscreen);

        // Create hidden input for import
        importHmiInput = document.createElement('input');
        importHmiInput.type = 'file';
        importHmiInput.multiple = true;
        importHmiInput.accept = '.html,.htm,.svg,.js,.glb,.gltf,.bin,.png,.jpg,.jpeg';
        importHmiInput.style.display = 'none';
        importHmiInput.addEventListener('change', handleHmiImport);
        controlsContainer.appendChild(importHmiInput);
    }}

export function setHmiHistoryData(entries) {
    allHistoryEntries = entries; 
}

export async function refreshHmiList(targetFilenameToSelect = null) {
    if (!hmiSelectDropdown) return;
    const currentSelection = targetFilenameToSelect || hmiSelectDropdown.value;
    try {
        const response = await fetch('api/hmi/list');
        if (!response.ok) throw new Error('Failed to fetch HMI list');
        const hmiFiles = await response.json();
        hmiSelectDropdown.innerHTML = '';
        if (hmiFiles.length === 0) {
            hmiSelectDropdown.innerHTML = '<option value="">No Views found</option>';
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
            hmiSelectDropdown.appendChild(option);
        });
        if (!matchFound && hmiFiles.length > 0) {
            hmiSelectDropdown.value = hmiFiles[0];
            await loadHmiPlan(hmiFiles[0]);
        } else if (matchFound) {
            await loadHmiPlan(currentSelection);
        }
    } catch (error) {
        console.error("Could not populate HMI list:", error);
        hmiSelectDropdown.innerHTML = `<option value="">Error loading list</option>`;
    }
}

async function onHmiFileChange(event) {
    const filename = event.target.value;
    if (!filename) return;
    trackEvent('hmi_file_change');
    await loadHmiPlan(filename);
}

async function deleteCurrentHmi() {
    const filename = hmiSelectDropdown.value;
    if(!filename) return;
    const isConfirmed = await confirmModal('Delete View', `Are you sure you want to delete '${filename}'?\nThis action cannot be undone.`, 'Delete', true);
    if(!isConfirmed) return;
    try {
        const res = await fetch(`api/hmi/file?name=${encodeURIComponent(filename)}`, { method: 'DELETE' });
        if(res.ok) {
            showToast(`View '${filename}' deleted successfully.`, "success");
            refreshHmiList();
        } else {
            const data = await res.json();
            showToast("Error: " + data.error, "error");
        }
    } catch(e) {
        showToast("Request failed: " + e.message, "error");
    }
}

async function exportCurrentHmi() {
    if (!hmiSelectDropdown || !hmiSelectDropdown.value) {
        return showToast("Please select a view to export.", "warning");
    }
    const filename = hmiSelectDropdown.value;

    try {
        // Download the main SVG/HTML file
        const mainA = document.createElement('a');
        mainA.href = `api/hmi/file?name=${encodeURIComponent(filename)}`;
        mainA.download = filename;
        document.body.appendChild(mainA);
        mainA.click();
        document.body.removeChild(mainA);

        // Try to download the JS bindings file if it exists
        const res = await fetch(`api/hmi/bindings.js?name=${encodeURIComponent(filename)}`);
        const text = await res.text();
        if (!text.trim().startsWith('// No bindings')) {
            const blob = new Blob([text], { type: 'application/javascript' });
            const url = URL.createObjectURL(blob);
            const jsA = document.createElement('a');
            jsA.href = url;
            jsA.download = `${filename}.js`;
            document.body.appendChild(jsA);
            jsA.click();
            document.body.removeChild(jsA);
            URL.revokeObjectURL(url);
        }
    } catch(e) {
        console.log("No associated JS file found to export or error occurred.", e);
    }
}

function triggerHmiImport() {
    if (importHmiInput) importHmiInput.click();
}

async function handleHmiImport(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
        formData.append('hmi_assets', files[i]);
    }

    try {
        const response = await fetch('api/hmi/upload', { method: 'POST', body: formData });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Upload failed.");
        
        showToast(`${result.count} files imported successfully.`, "success");
        
        // Find the main file to select it automatically
        let mainFile = null;
        for (let i = 0; i < files.length; i++) {
            if (files[i].name.match(/\.(svg|html|htm)$/i)) {
                mainFile = files[i].name;
                break;
            }
        }
        
        refreshHmiList(mainFile);
    } catch (e) {
        showToast(`Import Error: ${e.message}`, "error");
    } finally {
        event.target.value = ''; // Reset input
    }
}

async function loadCustomBindingsScript(bindingFilename) {
    return new Promise((resolve) => {
        const script = document.createElement('script');
        script.className = 'custom-hmi-script'; 
        script.type = 'module';
        const apiBasePath = (appBasePath === '/') ? '' : appBasePath;
        script.src = `${apiBasePath}/api/hmi/bindings.js?name=${encodeURIComponent(bindingFilename)}&v=${Date.now()}`;
        
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
                _sourceId: v.sourceId || 'default_connector',
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
 * --- Charge les SVGs imbriqués ---
 */
async function initEmbeddedSvgs() {
    const svgContainers = hmiContent.querySelectorAll('.embedded-svg');
    for (const container of svgContainers) {
        const svgName = container.dataset.svgName;
        if (!svgName) continue;
        try {
            const res = await fetch(`api/hmi/file?name=${encodeURIComponent(svgName)}`);
            if (res.ok) {
                container.innerHTML = await res.text();
            } else {
                container.innerHTML = `<span style="color:red">Failed to load ${svgName}</span>`;
            }
            await loadCustomBindingsScript(svgName + '.js');
        } catch (err) {
            console.error(`Failed to embed HMI asset ${svgName}:`, err);
        }
    }
}

async function loadHmiPlan(filename) {
    if (!filename) {
        hmiContent.innerHTML = `<p style="color: red; padding: 20px;">Error: No file selected.</p>`;
        return;
    }
    
    updateQueue.clear();
    elementCache.clear();
    highlightTimers.forEach(t => clearTimeout(t));
    highlightTimers.clear();
    embeddedChartInstances.forEach(c => c.destroy());
    embeddedChartInstances.clear();
    
    document.querySelectorAll('.custom-hmi-script').forEach(s => s.remove());
    activeBindings.forEach(b => { try { b.reset(hmiContent); } catch(e){} });
    activeBindings = []; 

    if (currentHmiContext) {
        currentHmiContext.destroy();
        currentHmiContext = null;
    }

    try {
        const response = await fetch(`api/hmi/file?name=${encodeURIComponent(filename)}&t=${Date.now()}`); 
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const text = await response.text();
        
        if (hmiContent) {
            await ensureAFrame(text);
            hmiContent.innerHTML = text;
            hmiInitialStates.clear();
            
            executeEmbeddedScripts();
            await initEmbeddedCharts();
            await initEmbeddedSvgs();
            
            const bindingFilename = filename + '.js'; 
            await loadCustomBindingsScript(bindingFilename);

            currentHmiContext = new HmiLifecycleContext();
            activeBindings.forEach(binding => {
                try { binding.initialize(hmiContent, currentHmiContext); } catch(e) { console.error(e); }
            });
            
            scanForDataKeys();
            
            if (isHmiHistoryMode) {
                const replayTime = parseFloat(hmiHandle.dataset.timestamp || currentMaxTimestamp);
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

function toggleFullscreen() {
    trackEvent('hmi_fullscreen_toggle');
    if (!hmiView) return;
    if (!document.fullscreenElement) {
        hmiView.requestFullscreen().catch(err => console.error(err));
    } else {
        if (document.exitFullscreen) document.exitFullscreen();
    }
}

function getNestedValue(obj, path) {
    if (typeof path !== 'string' || !obj) return null;
    return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : null), obj);
}

function checkAlarm(currentValue, alarmType, alarmThreshold) {
    if (alarmType === 'EQ') return String(currentValue) === String(alarmThreshold);
    if (alarmType === 'NEQ') return String(currentValue) !== String(alarmThreshold);
    const value = parseFloat(currentValue);
    const threshold = parseFloat(alarmThreshold);
    if (isNaN(value) || isNaN(threshold)) return false;
    switch (alarmType) {
        case 'H': return value > threshold;
        case 'L': return value < threshold;
        default: return false;
    }
}

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

function flushUpdateQueue() {
    try {
        const root = hmiContent;
        if (!root) return;
        
        updateQueue.forEach((data, key) => {
            const { sourceId, topic, payloadObject, isJson } = data;
            
            activeBindings.forEach(binding => {
                try { binding.update(sourceId, topic, payloadObject, root, currentHmiContext); } 
                catch (err) { console.error(`[HMI Script Error] Topic ${topic}:`, err); }
            });
            
            if (isJson) {
                const specificId = isMultiSource ? `${sourceId}-${topic.replace(/\//g, '-')}` : topic.replace(/\//g, '-');
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
                const queueKey = `${ds._sourceId}:${ds._topic}`;
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

export function updateMap(sourceId, topic, payload) {
    if (hmiHistoryToggle?.checked || !hmiContent) return;
    let payloadObject;
    let isJson = false;
    try { payloadObject = JSON.parse(payload); isJson = true; } catch (e) { payloadObject = payload; }
    
    updateQueue.set(`${sourceId}:${topic}`, { sourceId, topic, payloadObject, isJson });
    if (!animationFrameRequested) {
        animationFrameRequested = true;
        requestAnimationFrame(flushUpdateQueue);
    }
}

export function updateHmiTimelineUI(min, max) {
    if (!hmiSlider) return;
    currentMinTimestamp = min;
    currentMaxTimestamp = max;
    if (!isHmiHistoryMode) return; 
    const currentTimestamp = parseFloat(hmiHandle.dataset.timestamp || currentMaxTimestamp);
    hmiSlider.updateUI(currentMinTimestamp, currentMaxTimestamp, currentTimestamp);
}

export function refreshHmiLiveState() {
    if (!isHmiHistoryMode && hmiContent && hmiContent.children.length > 0) {
        fetchLastKnownState(Date.now());
    }
}

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

    activeBindings.forEach(binding => {
        try { binding.reset(hmiContent); } catch (err) {}
    });

    try {
        const isoTime = new Date(timestamp).toISOString();
        const response = await fetch(`api/context/last-known?timestamp=${encodeURIComponent(isoTime)}`);
        if (!response.ok) throw new Error("Failed to fetch state");       
        const stateData = await response.json(); 
        
        stateData.forEach(entry => {
            const { source_id: sourceId, topic, payload } = entry;
            let payloadObject;
            let isJson = false;
            try { payloadObject = JSON.parse(payload); isJson = true; } catch (e) { payloadObject = payload; }
            
            activeBindings.forEach(binding => {
                try { binding.update(sourceId, topic, payloadObject, hmiContent, currentHmiContext); } catch (err) {}
            });

            if (isJson) {
                const specificId = isMultiSource ? `${sourceId}-${topic.replace(/\//g, '-')}` : topic.replace(/\//g, '-');
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