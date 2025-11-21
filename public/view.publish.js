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
 */

import { trackEvent, mqttPatternToRegex } from './utils.js'; //  Import regex util

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
let subscribedTopics = []; //  This is now a fallback
let simControlsContainer = null; 
let brokerSelectElement = null; //  To store the broker <select>
let isMultiBroker = false; 
let availableBrokers = []; // Store full broker configs [NEW]

// --- Payload Templates ---
const PAYLOAD_TEMPLATES = {
    json: JSON.stringify({
        "timestamp": new Date().toISOString(),
        "value": 123.45,
        "unit": "°C",
        "quality": 192
    }, null, 2),
    string: "Hello, MQTT!",
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
    isMultiBroker = options.isMultiBroker || false;
    availableBrokers = options.brokerConfigs || []; // [NEW] Store configs

    if (payloadEditorDiv) {
        // --- Initialize Ace Editor ---
        aceEditor = ace.edit(payloadEditorDiv);
        aceEditor.setTheme(isDarkTheme ? 'ace/theme/tomorrow_night' : 'ace/theme/chrome');
        aceEditor.session.setMode('ace/mode/json'); // Default to JSON
        aceEditor.setValue(PAYLOAD_TEMPLATES.json, 1); // -1 moves cursor to start, 1 to end
        
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

        // [MODIFIED] Live validation on topic input
        publishTopicInput.addEventListener('input', () => {
            validatePublishPermissions();
        });
    }

    // ---  Multi-Broker Selector ---
    if (isMultiBroker && availableBrokers.length > 0) {
        const firstFormGroup = publishForm.querySelector('.form-group');
        
        const brokerGroup = document.createElement('div');
        brokerGroup.className = 'form-group';
        
        const label = document.createElement('label');
        label.htmlFor = 'publish-broker-select';
        label.textContent = 'Broker';
        
        brokerSelectElement = document.createElement('select');
        brokerSelectElement.id = 'publish-broker-select';
        
        availableBrokers.forEach(broker => {
            const option = document.createElement('option');
            option.value = broker.id;
            
            // [NEW] Add visual indicator for Read-Only brokers
            const isReadOnly = (!broker.publish || broker.publish.length === 0);
            const lockIcon = isReadOnly ? '🔒 ' : '';
            const readOnlyText = isReadOnly ? ' (Read-Only)' : '';
            
            option.textContent = `${lockIcon}${broker.id} (${broker.host})${readOnlyText}`;
            brokerSelectElement.appendChild(option);
        });
        
        // [NEW] Re-validate when broker changes
        brokerSelectElement.addEventListener('change', validatePublishPermissions);

        brokerGroup.appendChild(label);
        brokerGroup.appendChild(brokerSelectElement);
        
        if (firstFormGroup) {
            publishForm.insertBefore(brokerGroup, firstFormGroup);
        } else {
            publishForm.prepend(brokerGroup);
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
        document.body.appendChild(datalist); // Add to body
        publishTopicInput.setAttribute('list', datalist.id);
    }
    
    // [NEW] Initial validation run
    validatePublishPermissions();
}

/**
 * Updates the theme for the Ace editor instance.
 * @param {boolean} isDark - True if dark mode is enabled.
 */
export function setPublishTheme(isDark) {
    isDarkTheme = isDark;
    if (aceEditor) {
        aceEditor.setTheme(isDark ? 'ace/theme/tomorrow_night' : 'ace/theme/chrome');
    }
}

/**
 * [MODIFIED] Checks if the given topic matches allowed PUBLISH patterns for the selected broker.
 */
function isPublishAllowed(brokerId, topic) {
    // Find config for this broker
    let brokerConfig;
    if (isMultiBroker) {
        brokerConfig = availableBrokers.find(b => b.id === brokerId);
    } else {
        brokerConfig = availableBrokers[0]; // Single broker mode
    }

    if (!brokerConfig) return false;

    const publishPatterns = brokerConfig.publish || [];
    
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
            console.error(`Invalid MQTT pattern: ${pattern}`, e);
        }
    }
    
    return false; 
}

/**
 * [NEW] Validates UI state based on broker permissions and topic.
 * Enables/Disables button and shows warnings.
 */
function validatePublishPermissions() {
    if (!publishButton || !publishTopicInput) return;

    const topic = publishTopicInput.value.trim();
    const brokerId = brokerSelectElement ? brokerSelectElement.value : (availableBrokers[0]?.id || 'default');
    
    // Find broker config
    const brokerConfig = availableBrokers.find(b => b.id === brokerId) || availableBrokers[0];
    
    if (!brokerConfig) return;

    // 1. Check if Broker is Read-Only
    const isReadOnly = (!brokerConfig.publish || brokerConfig.publish.length === 0);
    
    if (isReadOnly) {
        publishButton.disabled = true;
        publishButton.textContent = "🔒 Broker is Read-Only";
        publishButton.title = "This broker configuration does not allow publishing.";
        publishTopicInput.classList.remove('input-error'); // Not a topic error, a broker error
        return;
    }

    // 2. Check Topic Permission (if topic is entered)
    if (topic.length > 0) {
        const allowed = isPublishAllowed(brokerId, topic);
        if (!allowed) {
            publishButton.disabled = true;
            publishButton.textContent = "⛔ Topic Not Allowed";
            publishTopicInput.classList.add('input-error');
            publishTopicInput.title = "Publishing to this topic is restricted by broker configuration.";
            showPublishStatus('Topic forbidden by configuration.', 'error');
        } else {
            publishButton.disabled = false;
            publishButton.textContent = "Publish Message";
            publishTopicInput.classList.remove('input-error');
            publishTopicInput.title = "";
            // Clear status if it was an error before
            if (publishStatus.className === 'error') publishStatus.textContent = '';
        }
    } else {
        // Reset state if no topic
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
    
    const brokerId = brokerSelectElement ? brokerSelectElement.value : (availableBrokers[0]?.id);

    if (!topic) {
        showPublishStatus('Topic is required.', 'error');
        publishTopicInput.classList.add('input-error');
        return;
    }

    // [MODIFIED] Client-side security check before sending
    if (!isPublishAllowed(brokerId, topic)) {
        showPublishStatus('⛔ Security Block: Publishing to this topic is not allowed by config.', 'error');
        publishTopicInput.classList.add('input-error');
        return;
    }
    
    publishButton.disabled = true;
    publishButton.textContent = 'Publishing...';
    showPublishStatus('Publishing...', 'success');

    try {
        const requestBody = { topic, payload, format, qos, retain, brokerId };
        
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
        // [MODIFIED] Re-validate state instead of blind reset
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

/**
 * Helper to format snake_case names to Title Case.
 */
function formatSimName(name) {
    return name.split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * Helper to update the UI of a single simulator control block.
 */
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

/**
 * Receives the full map of simulator statuses and updates the UI.
 */
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