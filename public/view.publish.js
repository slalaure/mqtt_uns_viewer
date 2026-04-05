/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025-2026 Sebastien Lalaurette
 *
 * View module for the Publish tab.
 * Manages the manual publish form, Ace Editor, and simulator controls.
 * [UPDATED] Protocol-agnostic data providers support (MQTT, OPC UA, etc.).
 * [UPDATED] Dynamic injection of new Data Providers (like CSV streams).
 * [UPDATED] Subscribes to Proxy-based reactive state for auto-filling and theming.
 * [UPDATED] Implemented View Lifecycle Teardown (mount/unmount) to prevent memory leaks.
 * [UPDATED] Fixed Ace Editor remounting bug by clearing DOM on destroy.
 */

import { state, subscribe, unsubscribe } from './state.js';
import { trackEvent, mqttPatternToRegex, showToast } from './utils.js'; 

// --- DOM Element Querying ---
const publishForm = document.getElementById('publish-form');
const publishTopicInput = document.getElementById('publish-topic');
const publishFormatSelect = document.getElementById('publish-format');
const publishQosSelect = document.getElementById('publish-qos');
const publishRetainCheckbox = document.getElementById('publish-retain');
const publishButton = document.getElementById('publish-button');
const payloadEditorDiv = document.getElementById('publish-payload-editor');

//  Simulator controls
const simulatorControls = document.getElementById('simulator-list-container');
const simulatorControlTemplate = document.getElementById('simulator-control-template');

// --- Module-level State ---
let aceEditor = null;
let isDarkTheme = state.isDarkMode; // Read from global state
let subscribedTopics = []; 
let simControlsContainer = null; 
let providerSelectElement = null; 
let isMultiProvider = false; 
let availableProviders = []; // Store full provider configs (MQTT + others)
let isMounted = false; // Lifecycle flag

// --- Payload Templates ---
const PAYLOAD_TEMPLATES = {
    json: JSON.stringify({
        "timestamp": new Date().toISOString(),
        "value": 123.45,
        "unit": "°C",
        "quality": 192
    }, null, 2),
    string: "Hello, Provider!",
    sparkplugb: JSON.stringify({
        "timestamp": Date.now(),
        "metrics": [
            { "name": "Motor/Speed", "value": 1500, "type": "Int32" },
            { "name": "Motor/Temp", "value": 82.5, "type": "Float" }
        ],
        "seq": 0
    }, null, 2)
};

// --- Named Event Handlers (For clean unmounting) ---
const onFormatSelectChange = () => onFormatChange();
const onTopicInput = () => validatePublishPermissions();
const onProviderSelectChange = () => validatePublishPermissions();

const onDarkModeChange = (isDark) => {
    isDarkTheme = isDark;
    if (aceEditor) {
        aceEditor.setTheme(isDark ? 'ace/theme/tomorrow_night' : 'ace/theme/chrome');
    }
};

const onCurrentTopicChange = (topic) => {
    // Only auto-fill if we aren't actively modifying the publish view
    if (topic && publishTopicInput && state.activeView !== 'publish') {
        publishTopicInput.value = topic;
        validatePublishPermissions();
    }
};

const onCurrentSourceIdChange = (sourceId) => {
    if (sourceId && providerSelectElement && state.activeView !== 'publish') {
        const exists = Array.from(providerSelectElement.options).some(opt => opt.value === sourceId);
        if (exists) {
            providerSelectElement.value = sourceId;
            validatePublishPermissions();
        }
    }
};

/**
 * Initializes the Publish View configuration (Called once on app start).
 * @param {object} options
 * @param {string[]} options.subscribedTopics - List of subscribed topic patterns (fallback).
 * @param {HTMLElement} options.simulatorListContainer - The container for dynamic sim controls.
 * @param {boolean} options.isMultiSource - Whether the app is in multi-source mode.
 * @param {Array} options.sourceConfigs - List of broker config objects.
 */
export function initPublishView(options) {
    subscribedTopics = options.subscribedTopics || [];
    simControlsContainer = options.simulatorListContainer;
    isMultiProvider = options.isMultiSource || false;

    // Merge legacy broker configs and new data provider configs
    const bConfigs = options.sourceConfigs || [];
    const pConfigs = options.dataProviders || [];
    availableProviders = [...bConfigs, ...pConfigs];

    // ---  Multi-Provider Selector (Build DOM once) ---
    if (isMultiProvider && availableProviders.length > 0) {
        const firstFormGroup = publishForm?.querySelector('.form-group');
        
        const providerGroup = document.createElement('div');
        providerGroup.className = 'form-group';
        
        const label = document.createElement('label');
        label.htmlFor = 'publish-provider-select';
        label.textContent = 'Target Provider';
        
        providerSelectElement = document.createElement('select');
        providerSelectElement.id = 'publish-provider-select';

        availableProviders.forEach(provider => {
            // Implicitly allow dynamic files to act as loopback streams
            if (!provider.publish && (provider.type === 'file' || provider.type === 'dynamic')) {
                provider.publish = ['#'];
            }

            const option = document.createElement('option');
            option.value = provider.id;
            
            // Add visual indicator for Read-Only providers
            const isReadOnly = (!provider.publish || provider.publish.length === 0);
            const lockIcon = isReadOnly ? '🔒 ' : '';
            const readOnlyText = isReadOnly ? ' (Read-Only)' : '';
            const typeLabel = provider.type ? `[${provider.type.toUpperCase()}]` : '[MQTT]';
            
            option.textContent = `${lockIcon}${provider.id} ${typeLabel}${readOnlyText}`;
            providerSelectElement.appendChild(option);
        });

        providerGroup.appendChild(label);
        providerGroup.appendChild(providerSelectElement);

        if (publishForm) {
            if (firstFormGroup) {
                publishForm.insertBefore(providerGroup, firstFormGroup);
            } else {
                publishForm.prepend(providerGroup);
            }
        }
    }

    // --- Populate Topic Datalist ---
    if (options.subscribedTopics && publishTopicInput) {
        const datalist = document.createElement('datalist');
        datalist.id = 'subscribed-topics-list';
        options.subscribedTopics.forEach(topic => {
            const option = document.createElement('option');
            option.value = topic;
            datalist.appendChild(option);
        });
        document.body.appendChild(datalist); 
        publishTopicInput.setAttribute('list', datalist.id);
    }
}

/**
 * Mounts the view (attaches event listeners, initializes heavy components).
 */
export function mountPublishView() {
    if (isMounted) return;

    if (payloadEditorDiv && !aceEditor) {
        // Clean up any lingering Ace DOM elements before re-initializing to prevent breaking
        payloadEditorDiv.innerHTML = '';
        
        // --- Initialize Ace Editor ---
        aceEditor = ace.edit(payloadEditorDiv);
        aceEditor.setTheme(isDarkTheme ? 'ace/theme/tomorrow_night' : 'ace/theme/chrome');
        aceEditor.session.setMode('ace/mode/json'); // Default to JSON
        
        // Re-apply format template based on current select value
        const currentFormat = publishFormatSelect ? publishFormatSelect.value : 'json';
        aceEditor.setValue(PAYLOAD_TEMPLATES[currentFormat] || PAYLOAD_TEMPLATES.json, 1); 
        
        aceEditor.setOptions({
            fontSize: "14px",
            fontFamily: "monospace",
            enableBasicAutocompletion: true, 
            enableLiveAutocompletion: true,  
            enableSnippets: true,            
            useWorker: true
        });
    }

    // --- Add Event Listeners ---
    publishForm?.addEventListener('submit', onPublishSubmit);
    publishFormatSelect?.addEventListener('change', onFormatSelectChange);
    publishTopicInput?.addEventListener('input', onTopicInput);
    providerSelectElement?.addEventListener('change', onProviderSelectChange);

    // --- Reactive State Subscriptions ---
    subscribe('isDarkMode', onDarkModeChange);
    subscribe('currentTopic', onCurrentTopicChange, true);
    subscribe('currentSourceId', onCurrentSourceIdChange);

    // Initial validation run
    validatePublishPermissions();

    isMounted = true;
    console.log("[Publish View] Mounted.");
}

/**
 * Unmounts the view (removes listeners, destroys Ace editor to free memory).
 */
export function unmountPublishView() {
    if (!isMounted) return;

    if (aceEditor) {
        aceEditor.destroy();
        aceEditor = null;
        if (payloadEditorDiv) payloadEditorDiv.innerHTML = ''; // Clear DOM for future mounts
    }

    publishForm?.removeEventListener('submit', onPublishSubmit);
    publishFormatSelect?.removeEventListener('change', onFormatSelectChange);
    publishTopicInput?.removeEventListener('input', onTopicInput);
    providerSelectElement?.removeEventListener('change', onProviderSelectChange);

    unsubscribe('isDarkMode', onDarkModeChange);
    unsubscribe('currentTopic', onCurrentTopicChange, true);
    unsubscribe('currentSourceId', onCurrentSourceIdChange);

    isMounted = false;
    console.log("[Publish View] Unmounted & Cleaned up.");
}

/**
 * Legacy wrapper: kept to avoid crashing app.js before we fully migrate it.
 * Real toggling is now handled by the state subscription.
 */
export function setPublishTheme(isDark) {
    // No-op, managed by state now.
}

/**
 * Checks if the given topic matches allowed PUBLISH patterns for the selected provider.
 */
function isPublishAllowed(providerId, topic) {
    let providerConfig;
    if (isMultiProvider) {
        providerConfig = availableProviders.find(p => p.id === providerId);
    } else {
        providerConfig = availableProviders[0]; 
    }
    
    if (!providerConfig) return false;

    // File providers or dynamic streams should default to loopback enabled
    const publishPatterns = providerConfig.publish || (providerConfig.type === 'file' || providerConfig.type === 'dynamic' ? ['#'] : []);
    
    // Check if strictly Read-Only
    if (publishPatterns.length === 0) return false;

    // Check specific patterns
    for (const pattern of publishPatterns) {
        try {
            const regex = mqttPatternToRegex(pattern); 
            if (regex.test(topic)) {
                return true; 
            }
        } catch (e) {
            console.error(`Invalid topic pattern: ${pattern}`, e);
        }
    }

    return false; 
}

/**
 * Validates UI state based on provider permissions and topic.
 */
function validatePublishPermissions() {
    if (!publishButton || !publishTopicInput) return;

    const topic = publishTopicInput.value.trim();
    const providerId = providerSelectElement ? providerSelectElement.value : (availableProviders[0]?.id || 'default');
    const providerConfig = availableProviders.find(p => p.id === providerId) || availableProviders[0];

    if (!providerConfig) return;

    // 1. Check if Provider is Read-Only
    const publishPatterns = providerConfig.publish || (providerConfig.type === 'file' || providerConfig.type === 'dynamic' ? ['#'] : []);
    const isReadOnly = publishPatterns.length === 0;

    if (isReadOnly) {
        publishButton.disabled = true;
        publishButton.textContent = "🔒 Provider is Read-Only";
        publishButton.title = "This provider configuration does not allow publishing.";
        publishTopicInput.classList.remove('input-error'); 
        return;
    }

    // 2. Check Topic Permission
    if (topic.length > 0) {
        const allowed = isPublishAllowed(providerId, topic);
        if (!allowed) {
            publishButton.disabled = true;
            publishButton.textContent = "⛔ Topic Not Allowed";
            publishTopicInput.classList.add('input-error');
            publishTopicInput.title = "Publishing to this topic is restricted by provider configuration.";
        } else {
            publishButton.disabled = false;
            publishButton.textContent = "Publish Message";
            publishTopicInput.classList.remove('input-error');
            publishTopicInput.title = "";
        }
    } else {
        publishButton.disabled = false;
        publishButton.textContent = "Publish Message";
        publishTopicInput.classList.remove('input-error');
    }
}

/**
 * Handles changes to the payload format select.
 */
function onFormatChange() {
    const format = publishFormatSelect.value;
    if (!aceEditor) return;
    
    if (format === 'json' || format === 'sparkplugb') {
        aceEditor.session.setMode('ace/mode/json');
    } else {
        aceEditor.session.setMode('ace/mode/text');
    }
    aceEditor.setValue(PAYLOAD_TEMPLATES[format] || "", 1);
}

/**
 * Handles the manual publish form submission.
 */
async function onPublishSubmit(event) {
    event.preventDefault();

    if (publishButton.disabled) return;
    trackEvent('publish_manual_submit'); 

    const topic = publishTopicInput.value.trim(); 
    const payload = aceEditor ? aceEditor.getValue() : '';
    const format = publishFormatSelect.value;
    const qos = parseInt(publishQosSelect.value, 10);
    const retain = publishRetainCheckbox.checked;
    
    const providerId = providerSelectElement ? providerSelectElement.value : (availableProviders[0]?.id);

    if (!topic) {
        showToast('Topic/Path is required.', 'error');
        publishTopicInput.classList.add('input-error');
        return;
    }

    // Client-side security check before sending
    if (!isPublishAllowed(providerId, topic)) {
        showToast('⛔ Security Block: Publishing to this topic/path is not allowed by config.', 'error');
        publishTopicInput.classList.add('input-error');
        return;
    }

    publishButton.disabled = true;
    publishButton.textContent = 'Publishing...';
    
    try {
        // We still use 'sourceId' in the JSON payload to preserve backend API compatibility
        const requestBody = { topic, payload, format, qos, retain, sourceId: providerId };

        const response = await fetch('api/publish/message', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || `HTTP error! Status: ${response.status}`);
        }

        showToast(`${result.message || 'Message published!'}`, 'success');
        
    } catch (err) {
        console.error("Publish error:", err);
        showToast(`Error: ${err.message}`, 'error');
    } finally {
        validatePublishPermissions();
    }
}

// ---  Simulator Logic ---

function formatSimName(name) {
    return name.split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function updateControlUI(controlEl, status) {
    const statusEl = controlEl.querySelector('.status-indicator');
    const startBtn = controlEl.querySelector('.btn-start-sim');
    const stopBtn = controlEl.querySelector('.btn-stop-sim');

    if (status === 'running') {
        statusEl.textContent = 'Running';
        statusEl.classList.add('running');
        statusEl.classList.remove('stopped');
        startBtn.setAttribute('disabled', true);
        stopBtn.removeAttribute('disabled');
    } else {
        statusEl.textContent = 'Stopped';
        statusEl.classList.add('stopped');
        statusEl.classList.remove('running');
        startBtn.removeAttribute('disabled');
        stopBtn.setAttribute('disabled', true);
    }
}

export function updateSimulatorStatuses(statuses) {
    if (!simControlsContainer || !simulatorControlTemplate) return;
    simControlsContainer.innerHTML = '';
    
    if (Object.keys(statuses).length === 0) {
        simControlsContainer.innerHTML = '<p class="history-placeholder">No simulators are available.</p>';
        return;
    }

    for (const [name, status] of Object.entries(statuses)) {
        const controlEl = simulatorControlTemplate.content.cloneNode(true).firstElementChild;
        const nameEl = controlEl.querySelector('.simulator-name');
        const startBtn = controlEl.querySelector('.btn-start-sim');
        const stopBtn = controlEl.querySelector('.btn-stop-sim');

        nameEl.textContent = formatSimName(name);
        updateControlUI(controlEl, status); 

        startBtn.addEventListener('click', () => {
            fetch(`api/simulator/start/${name}`, { method: 'POST' });
            showToast(`Starting simulator: ${formatSimName(name)}`, 'info');
            trackEvent(`simulator_start_${name}`);
        });

        stopBtn.addEventListener('click', () => {
            fetch(`api/simulator/stop/${name}`, { method: 'POST' });
            showToast(`Stopping simulator: ${formatSimName(name)}`, 'info');
            trackEvent(`simulator_stop_${name}`);
        });

        simControlsContainer.appendChild(controlEl);
    }
}

/**
 * Dynamically adds a new data provider to the dropdown selector (e.g., when a CSV parser is started).
 */
export function addAvailablePublishProvider(providerId, type = 'dynamic') {
    // Avoid duplicates
    if (availableProviders.find(p => p.id === providerId)) return;
    
    // Auto-allow publish loopback for dynamically created streams
    const newProvider = { id: providerId, type: type, publish: ['#'] };
    availableProviders.push(newProvider);
    
    if (providerSelectElement) {
        const option = document.createElement('option');
        option.value = providerId;
        option.textContent = `${providerId} [${type.toUpperCase()}]`;
        providerSelectElement.appendChild(option);
    }
}