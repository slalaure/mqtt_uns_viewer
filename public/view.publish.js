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
 * View module for the Publish tab.
 * Manages the manual publish form, Ace Editor, and simulator controls.
 * [UPDATED] Protocol-agnostic data providers support (MQTT, OPC UA, etc.).
 */
import { trackEvent, mqttPatternToRegex } from './utils.js'; 

// --- DOM Element Querying ---
const publishForm = document.getElementById('publish-form');
const publishTopicInput = document.getElementById('publish-topic');
const publishFormatSelect = document.getElementById('publish-format');
const publishQosSelect = document.getElementById('publish-qos');
const publishRetainCheckbox = document.getElementById('publish-retain');
const publishButton = document.getElementById('publish-button');
const publishStatus = document.getElementById('publish-status');
const payloadEditorDiv = document.getElementById('publish-payload-editor');

//  Simulator controls
const simulatorControls = document.getElementById('simulator-list-container');
const simulatorControlTemplate = document.getElementById('simulator-control-template');

// --- Module-level State ---
let aceEditor = null;
let isDarkTheme = localStorage.getItem('theme') === 'dark';
let publishStatusTimer = null;
let subscribedTopics = []; 
let simControlsContainer = null; 
let providerSelectElement = null; // Changed from brokerSelectElement
let isMultiProvider = false; 
let availableProviders = []; // Store full provider configs (MQTT + others)

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

/**
 * Initializes the Publish View functionality.
 * @param {object} options
 * @param {string[]} options.subscribedTopics - List of subscribed topic patterns (fallback).
 * @param {HTMLElement} options.simulatorListContainer - The container for dynamic sim controls.
 * @param {boolean} options.isMultiBroker - Whether the app is in multi-broker mode.
 * @param {Array} options.brokerConfigs - List of broker config objects.
 */
export function initPublishView(options) {
    subscribedTopics = options.subscribedTopics || [];
    simControlsContainer = options.simulatorListContainer;
    isMultiProvider = options.isMultiBroker || false;
    
    // Merge legacy broker configs and new data provider configs
    const bConfigs = options.brokerConfigs || [];
    const pConfigs = options.dataProviders || [];
    availableProviders = [...bConfigs, ...pConfigs];

    if (payloadEditorDiv) {
        // --- Initialize Ace Editor ---
        aceEditor = ace.edit(payloadEditorDiv);
        aceEditor.setTheme(isDarkTheme ? 'ace/theme/tomorrow_night' : 'ace/theme/chrome');
        aceEditor.session.setMode('ace/mode/json'); // Default to JSON
        aceEditor.setValue(PAYLOAD_TEMPLATES.json, 1); 
        aceEditor.setOptions({
            fontSize: "14px",
            fontFamily: "monospace",
            enableBasicAutocompletion: true, 
            enableLiveAutocompletion: true,  
            enableSnippets: true,            
            useWorker: true
        });

        // --- Add Event Listeners ---
        publishForm.addEventListener('submit', onPublishSubmit);
        publishFormatSelect.addEventListener('change', onFormatChange);
        
        // Live validation on topic input
        publishTopicInput.addEventListener('input', () => {
            validatePublishPermissions();
        });
    }

    // ---  Multi-Provider Selector ---
    if (isMultiProvider && availableProviders.length > 0) {
        const firstFormGroup = publishForm.querySelector('.form-group');
        const providerGroup = document.createElement('div');
        providerGroup.className = 'form-group';
        
        const label = document.createElement('label');
        label.htmlFor = 'publish-provider-select';
        label.textContent = 'Target Provider';
        
        providerSelectElement = document.createElement('select');
        providerSelectElement.id = 'publish-provider-select';
        
        availableProviders.forEach(provider => {
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

        // Re-validate when provider changes
        providerSelectElement.addEventListener('change', validatePublishPermissions);
        
        providerGroup.appendChild(label);
        providerGroup.appendChild(providerSelectElement);
        
        if (firstFormGroup) {
            publishForm.insertBefore(providerGroup, firstFormGroup);
        } else {
            publishForm.prepend(providerGroup);
        }
    }

    // --- Populate Topic Datalist ---
    if (options.subscribedTopics) {
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

    // Initial validation run
    validatePublishPermissions();
}

/**
 * Updates the theme for the Ace editor instance.
 */
export function setPublishTheme(isDark) {
    isDarkTheme = isDark;
    if (aceEditor) {
        aceEditor.setTheme(isDark ? 'ace/theme/tomorrow_night' : 'ace/theme/chrome');
    }
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
    
    const publishPatterns = providerConfig.publish || [];
    
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
    const isReadOnly = (!providerConfig.publish || providerConfig.publish.length === 0);
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
            showPublishStatus('Topic forbidden by configuration.', 'error');
        } else {
            publishButton.disabled = false;
            publishButton.textContent = "Publish Message";
            publishTopicInput.classList.remove('input-error');
            publishTopicInput.title = "";
            if (publishStatus.className === 'error') publishStatus.textContent = '';
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
    const payload = aceEditor.getValue();
    const format = publishFormatSelect.value;
    const qos = parseInt(publishQosSelect.value, 10);
    const retain = publishRetainCheckbox.checked;
    
    const providerId = providerSelectElement ? providerSelectElement.value : (availableProviders[0]?.id);
    
    if (!topic) {
        showPublishStatus('Topic/Path is required.', 'error');
        publishTopicInput.classList.add('input-error');
        return;
    }

    // Client-side security check before sending
    if (!isPublishAllowed(providerId, topic)) {
        showPublishStatus('⛔ Security Block: Publishing to this topic/path is not allowed by config.', 'error');
        publishTopicInput.classList.add('input-error');
        return;
    }

    publishButton.disabled = true;
    publishButton.textContent = 'Publishing...';
    showPublishStatus('Publishing...', 'success');

    try {
        // We still use 'brokerId' in the JSON payload to preserve backend API compatibility
        const requestBody = { topic, payload, format, qos, retain, brokerId: providerId };
        
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
        
        showPublishStatus(`${result.message || 'Message published!'}`, 'success');
    } catch (err) {
        console.error("Publish error:", err);
        showPublishStatus(`Error: ${err.message}`, 'error');
    } finally {
        validatePublishPermissions();
    }
}

/**
 * Helper to show a status message in the publish UI.
 */
function showPublishStatus(message, type = 'success') {
    if (!publishStatus) return;
    publishStatus.textContent = message;
    publishStatus.className = type;
    
    clearTimeout(publishStatusTimer);
    publishStatusTimer = setTimeout(() => {
        publishStatus.textContent = '';
        publishStatus.className = '';
    }, 4000);
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
            trackEvent(`simulator_start_${name}`);
        });
        
        stopBtn.addEventListener('click', () => {
            fetch(`api/simulator/stop/${name}`, { method: 'POST' });
            trackEvent(`simulator_stop_${name}`);
        });
        
        simControlsContainer.appendChild(controlEl);
    }
}