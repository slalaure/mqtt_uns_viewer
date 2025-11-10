/**
 * @license MIT
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * View module for the Publish tab.
 * Manages the manual publish form, Ace Editor, and simulator controls.
 */

import { trackEvent, mqttPatternToRegex } from './utils.js'; // [MODIFIED] Import regex util

// --- DOM Element Querying ---
const publishForm = document.getElementById('publish-form');
const publishTopicInput = document.getElementById('publish-topic');
const publishFormatSelect = document.getElementById('publish-format');
const publishQosSelect = document.getElementById('publish-qos');
const publishRetainCheckbox = document.getElementById('publish-retain');
const publishButton = document.getElementById('publish-button');
const publishStatus = document.getElementById('publish-status');
const payloadEditorDiv = document.getElementById('publish-payload-editor');

// [NEW] Simulator controls
const simulatorListContainer = document.getElementById('simulator-list-container');
const simulatorControlTemplate = document.getElementById('simulator-control-template');


// --- Module-level State ---
let aceEditor = null;
let isDarkTheme = localStorage.getItem('theme') === 'dark';
let publishStatusTimer = null;
let subscribedTopics = []; // [NEW] Store subscribed topics
let simControlsContainer = null; // [NEW] Store reference to simulator list container

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
 * @param {string[]} options.subscribedTopics - List of subscribed topic patterns for datalist.
 * @param {HTMLElement} options.simulatorListContainer - The container for dynamic sim controls.
 */
export function initPublishView(options) {
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

        // [NEW] Add listener to clear validation error on input
        publishTopicInput.addEventListener('input', () => {
            if (publishTopicInput.classList.contains('input-error')) {
                publishTopicInput.classList.remove('input-error');
            }
        });
    }

    // [NEW] Store subscribed topics for validation
    subscribedTopics = options.subscribedTopics || [];

    // [NEW] Store simulator container
    simControlsContainer = options.simulatorListContainer;
    
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
 * [NEW] Checks if the given topic matches any of the subscribed patterns.
 * @param {string} topic - The topic to test.
 * @returns {boolean} True if a match is found, false otherwise.
 */
function isTopicSubscribed(topic) {
    if (!subscribedTopics || subscribedTopics.length === 0) {
        return false; // No patterns to match against
    }
    
    for (const pattern of subscribedTopics) {
        try {
            // Use the regex converter from utils.js
            const regex = mqttPatternToRegex(pattern); 
            if (regex.test(topic)) {
                return true; // Found a match
            }
        } catch (e) {
            console.error(`Invalid MQTT pattern in config: ${pattern}`, e);
        }
    }
    
    return false; // No pattern matched
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
    
    // Set template and move cursor to end
    aceEditor.setValue(PAYLOAD_TEMPLATES[format] || "", 1);
}

/**
 * Handles the manual publish form submission.
 * @param {Event} event - The form submit event.
 */
async function onPublishSubmit(event) {
    event.preventDefault();
    if (publishButton.disabled) return;
    
    trackEvent('publish_manual_submit');

    // 1. Get data from form
    const topic = publishTopicInput.value.trim(); // Trim whitespace
    const payload = aceEditor.getValue();
    const format = publishFormatSelect.value;
    const qos = parseInt(publishQosSelect.value, 10);
    const retain = publishRetainCheckbox.checked;

    // 2. Validate topic
    if (!topic) {
        showPublishStatus('Topic is required.', 'error');
        publishTopicInput.classList.add('input-error');
        return;
    }

    // [NEW] 2.5 Validate topic against subscribed patterns
    if (!isTopicSubscribed(topic)) {
        showPublishStatus('Error: Topic does not match any subscribed patterns in config.', 'error');
        publishTopicInput.classList.add('input-error'); // Add visual feedback
        return; // Stop submission
    }
    
    // [NEW] Clear error class if validation passes
    publishTopicInput.classList.remove('input-error');
    
    // 3. Disable UI
    publishButton.disabled = true;
    publishButton.textContent = 'Publishing...';
    showPublishStatus('Publishing...', 'success');

    // 4. Send to backend
    try {
        const response = await fetch('api/publish/message', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ topic, payload, format, qos, retain })
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || `HTTP error! Status: ${response.status}`);
        }

        showPublishStatus(`Message published to '${topic}'!`, 'success');

    } catch (err) {
        console.error("Publish error:", err);
        showPublishStatus(`Error: ${err.message}`, 'error');
    } finally {
        // 5. Re-enable UI
        publishButton.disabled = false;
        publishButton.textContent = 'Publish Message';
    }
}

/**
 * Helper to show a status message in the publish UI.
 * @param {string} message - The text to display.
 * @param {string} type - 'success' or 'error'.
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


// --- [NEW] Simulator Logic ---

/**
 * Helper to format snake_case names to Title Case.
 * @param {string} name - e.g., 'stark_industries'
 * @returns {string} e.g., 'Stark Industries'
 */
function formatSimName(name) {
    return name.split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * Helper to update the UI of a single simulator control block.
 * @param {HTMLElement} controlEl - The .simulator-instance-controls element.
 * @param {string} status - 'running' or 'stopped'.
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
 * [NEW] Receives the full map of simulator statuses and updates the UI.
 * @param {object} statuses - e.g., { stark_industries: 'running', death_star: 'stopped' }
 */
export function updateSimulatorStatuses(statuses) {
    if (!simControlsContainer || !simulatorControlTemplate) return;

    // We can just rebuild the list, it's simpler than merging
    simControlsContainer.innerHTML = '';
    
    if (Object.keys(statuses).length === 0) {
        simControlsContainer.innerHTML = '<p class="history-placeholder">No simulators are available.</p>';
        return;
    }

    for (const [name, status] of Object.entries(statuses)) {
        // 1. Clone template
        const controlEl = simulatorControlTemplate.content.cloneNode(true).firstElementChild;

        // 2. Find elements inside the clone
        const nameEl = controlEl.querySelector('.simulator-name');
        const startBtn = controlEl.querySelector('.btn-start-sim');
        const stopBtn = controlEl.querySelector('.btn-stop-sim');
        
        // 3. Populate
        nameEl.textContent = formatSimName(name);
        updateControlUI(controlEl, status); // Set initial UI state

        // 4. Add event listeners
        startBtn.addEventListener('click', () => {
            fetch(`api/simulator/start/${name}`, { method: 'POST' });
            trackEvent(`simulator_start_${name}`);
        });
        
        stopBtn.addEventListener('click', () => {
            fetch(`api/simulator/stop/${name}`, { method: 'POST' });
            trackEvent(`simulator_stop_${name}`);
        });

        // 5. Append to list
        simControlsContainer.appendChild(controlEl);
    }
}