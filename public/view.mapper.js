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
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Import shared utilities
import { mqttPatternToClientRegex } from './utils.js';
// [NEW] Import the reusable payload viewer
import { createPayloadViewer } from './payload-viewer.js';

// --- DOM Element Querying ---
// [REMOVED] mapper-tree, mapper-payload-topic, mapper-payload-content (handled by app.js and viewer)
const mapperTransformPlaceholder = document.getElementById('mapper-transform-placeholder');
const mapperTransformForm = document.getElementById('mapper-transform-form');
const mapperVersionSelect = document.getElementById('mapper-version-select');
const mapperSaveButton = document.getElementById('mapper-save-button');
const mapperSaveAsNewButton = document.getElementById('mapper-save-as-new-button');
const mapperSaveStatus = document.getElementById('mapper-save-status');
const mapperSourceTopicInput = document.getElementById('mapper-source-topic');
const mapperAddTargetButton = document.getElementById('mapper-add-target-button');
const mapperTargetsList = document.getElementById('mapper-targets-list');
const mapperTargetsPlaceholder = document.getElementById('mapper-targets-placeholder');
const mapperTargetTemplate = document.getElementById('mapper-target-template');
const deleteModalBackdrop = document.getElementById('delete-rule-modal-backdrop');
const deleteModalTopic = document.getElementById('delete-modal-topic');
const deleteModalPattern = document.getElementById('delete-modal-pattern');
const modalBtnCancel = document.getElementById('modal-btn-cancel');
const modalBtnDeleteRule = document.getElementById('modal-btn-delete-rule');
const modalBtnDeletePrune = document.getElementById('modal-btn-delete-prune');

// --- Module-level State ---
let mapperConfig = { versions: [], activeVersionId: null };
let mapperMetrics = {};
let mappedTargetTopics = new Set();
let mapperSaveTimer = null;
let currentEditingSourceTopic = null;
let defaultJSCode = ''; // Will be set by initMapperView
// [REMOVED] selectedMapperNode (managed by app.js)
let deleteModalContext = null;

// [NEW] Ace Editor State
let aceEditors = new Map(); // Stores Ace editor instances by target.id
let isDarkTheme = localStorage.getItem('theme') === 'dark'; // Track theme for new editors

// [NEW] Create an instance of the payload viewer for this view
const payloadViewer = createPayloadViewer({
    topicEl: document.getElementById('mapper-payload-topic'),
    contentEl: document.getElementById('mapper-payload-content'),
    historyLogEl: null, // Mapper doesn't show history
    placeholderEl: null
});


// --- Callbacks from main app.js ---
let appCallbacks = {
    pruneTopicFromFrontend: () => console.error("pruneTopicFromFrontend callback not set"),
    getSubscribedTopics: () => ['#'], // Default fallback
    colorAllTrees: () => console.error("colorAllTrees callback not set"),
    addPruneIgnorePattern: () => console.error("addPruneIgnorePattern callback not set"),
    // [REMOVED] displayPayload (now handled by internal payloadViewer)
};

/**
 * [NEW] Updates the theme for all active Ace editor instances.
 * This is exported and called by app.js.
 * @param {boolean} isDark - True if dark mode is enabled.
 */
export function setMapperTheme(isDark) {
    isDarkTheme = isDark;
    const theme = isDark ? 'ace/theme/tomorrow_night' : 'ace/theme/chrome';
    aceEditors.forEach(editor => {
        editor.setTheme(theme);
    });
}


/**
 * Initializes the Mapper View functionality.
 * This is called once by app.js when the app loads.
 * @param {object} callbacks - An object containing callback functions from app.js
 */
export function initMapperView(callbacks) {
    // [NEW] Separate appCallbacks from displayPayload (which is now internal)
    const { displayPayload, ...otherCallbacks } = callbacks;
    appCallbacks = { ...appCallbacks, ...otherCallbacks };
    
    // [MODIFIED] Set default JS code here
    defaultJSCode = `// 'msg' object contains msg.topic and msg.payload (parsed JSON).
// 'db' object is available with await db.all(sql) and await db.get(sql).
// Return the modified 'msg' object to publish.
// Return null or undefined to skip publishing.

/* // Example: Get average of last 5 values for this topic
try {
    const sql = \`
        SELECT AVG(CAST(payload->>'value' AS DOUBLE)) as avg_val 
        FROM (
            SELECT payload FROM mqtt_events 
            WHERE topic = '\${msg.topic}' 
            ORDER BY timestamp DESC 
            LIMIT 5
        )
    \`;
    const result = await db.get(sql);
    if (result && result.avg_val) {
        msg.payload.average_5 = result.avg_val;
    }
} catch (e) {
    console.error("DB query failed: " + e.message);
}
*/

return msg;
`;
    
    loadMapperConfig(); // Load initial config
    
    // Add event listeners
    mapperSaveButton?.addEventListener('click', onSave);
    mapperSaveAsNewButton?.addEventListener('click', onSaveAsNew);
    mapperVersionSelect?.addEventListener('change', onVersionChange);
    mapperAddTargetButton?.addEventListener('click', onAddTarget);
    
    // Modal listeners
    modalBtnCancel?.addEventListener('click', hidePruneModal);
    modalBtnDeleteRule?.addEventListener('click', onDeleteRule);
    modalBtnDeletePrune?.addEventListener('click', onDeleteAndPrune);
}

/**
 * Updates the mapper's internal state with new metrics from the server.
 * @param {object} newMetrics - The metrics object from the WebSocket.
 */
export function updateMapperMetrics(newMetrics) {
    mapperMetrics = newMetrics;
    // If the user is currently editing a rule, update its metrics
    if (currentEditingSourceTopic) {
        updateMetricsForEditor(currentEditingSourceTopic);
    }
}

/**
 * Updates the mapper's internal state with a new config from the server.
 * @param {object} newConfig - The config object from the WebSocket.
 */
export function updateMapperConfig(newConfig) {
    console.log("Received config update from server");
    mapperConfig = newConfig;
    updateMapperVersionSelector();
    appCallbacks.colorAllTrees(); // Trigger a re-color
}

/**
 * Handles a click event on a node in the Mapper tree.
 * This function is exported and attached by app.js.
 * @param {Event} event - The click event.
 * @param {HTMLElement} nodeContainer - The clicked node's container.
 * @param {string} topic - The node's topic.
 */
export function handleMapperNodeClick(event, nodeContainer, topic) {
    const li = nodeContainer.closest('li');
    const payload = nodeContainer.dataset.payload; // Payload is stored on all nodes

    // --- Check if it's a file or folder ---
    if (li.classList.contains('is-file')) {
        // It's a file node (object) - show payload and editor
        currentEditingSourceTopic = topic; // Store this
        // [NEW] Use the payload viewer
        payloadViewer.display(topic, payload);
        renderTransformEditor(topic);
    } else {
        // It's a folder node - show placeholder, hide editor
        currentEditingSourceTopic = null; // Clear editing topic
        // [NEW] Use the payload viewer
        payloadViewer.display(topic, "N/A (Folder selected)"); // Show folder info
        mapperTransformPlaceholder.style.display = 'block'; // Show placeholder
        mapperTransformForm.style.display = 'none'; // Hide form
    }
}

/**
 * Gets the current mapper config state.
 * @returns {object} The mapper config.
 */
export function getMapperConfig() {
    return mapperConfig;
}

/**
 * Gets the current set of mapped target topics.
 * @returns {Set<string>} The set of topics.
 */
export function getMappedTargetTopics() {
    return mappedTargetTopics;
}

/**
 * Adds a topic to the set of locally generated target topics.
 * @param {string} topic - The topic to add.
 */
export function addMappedTargetTopic(topic) {
    mappedTargetTopics.add(topic);
}

/**
 * Finds the active rule configuration for a given topic.
 * @param {string} topic The topic string.
 * @returns {string|null} 'source' or 'target' if a rule applies, or null.
 */
export function getTopicMappingStatus(topic) {
    if (!mapperConfig || !mapperConfig.versions) return null;

    // Check if it's a target topic (fast check)
    if (mappedTargetTopics.has(topic)) return 'target';

    const activeVersion = mapperConfig.versions.find(v => v.id === mapperConfig.activeVersionId);
    if (!activeVersion) return null;

    // Check if it's a source topic
    for (const rule of activeVersion.rules) {
        if (rule.sourceTopic === topic) {
            return 'source';
        }
        // Check if it's a parent of a rule
        const pattern = rule.sourceTopic.replace(/(\/\+.*|\/\#.*)/g, '');
            if (topic === pattern && topic !== rule.sourceTopic) {
                return 'source'; // Mark parent folder as source too
        }
    }
    return null;
}

// --- Internal Logic ---

/**
 * Loads the initial mapper configuration from the server.
 */
async function loadMapperConfig() {
    try {
        const response = await fetch('api/mapper/config');
        if (!response.ok) throw new Error('Failed to fetch mapper config');
        mapperConfig = await response.json();

        // Note: defaultJSCode is now set in initMapperView()

        updateMapperVersionSelector();
        appCallbacks.colorAllTrees();
    } catch (error) {
        console.error('Error loading mapper config:', error);
        showMapperSaveStatus('Error loading config', 'error');
    }
}

/**
 * Populates the version <select> dropdown.
 */
function updateMapperVersionSelector() {
    if (!mapperVersionSelect) return;
    mapperVersionSelect.innerHTML = '';
    mapperConfig.versions.forEach(version => {
        const option = document.createElement('option');
        option.value = version.id;
        option.textContent = version.name;
        if (version.id === mapperConfig.activeVersionId) {
            option.selected = true;
        }
        mapperVersionSelect.appendChild(option);
    });
}

/**
 * Finds or creates a rule object in the active version.
 * @param {string} sourceTopic - The topic to find a rule for.
 * @param {boolean} createIfMissing - Whether to create a new rule if not found.
 * @returns {object|null} The rule object.
 */
function getRuleForTopic(sourceTopic, createIfMissing = false) {
    const activeVersion = mapperConfig.versions.find(v => v.id === mapperConfig.activeVersionId);
    if (!activeVersion) return null;

    let rule = activeVersion.rules.find(r => r.sourceTopic === sourceTopic);
    if (!rule && createIfMissing) {
        rule = {
            sourceTopic: sourceTopic,
            targets: []
        };
        activeVersion.rules.push(rule);
    }
    return rule;
}

/**
 * Renders the bottom-right editor panel for a given topic.
 * @param {string} sourceTopic - The topic to render the editor for.
 */
function renderTransformEditor(sourceTopic) {
    mapperTransformPlaceholder.style.display = 'none';
    mapperTransformForm.style.display = 'flex';
    mapperSourceTopicInput.value = sourceTopic;

    // --- [NEW] Destroy old editors before clearing ---
    aceEditors.forEach(editor => editor.destroy());
    aceEditors.clear();
    // --- [END NEW] ---
    
    mapperTargetsList.innerHTML = ''; // This is fine now

    const rule = getRuleForTopic(sourceTopic, false); // Don't create yet

    if (!rule || rule.targets.length === 0) {
        mapperTargetsPlaceholder.style.display = 'block';
    } else {
        mapperTargetsPlaceholder.style.display = 'none';
        rule.targets.forEach(target => {
            const targetEditor = createTargetEditor(rule, target);
            mapperTargetsList.appendChild(targetEditor);
        });
    }
    // Ensure metrics are updated when editor is shown
    updateMetricsForEditor(sourceTopic);
}

/**
 * Checks if a given topic matches any of the app's subscription patterns.
 * @param {string} outputTopic - The topic to check.
 * @returns {boolean} True if the topic is subscribed.
 */
function isTopicSubscribed(outputTopic) {
    const subscriptionPatterns = appCallbacks.getSubscribedTopics();
    if (!subscriptionPatterns || subscriptionPatterns.length === 0) {
        return false;
    }
    // Special case: If subscribed to '#', any topic is valid
    if (subscriptionPatterns.includes('#')) {
            return true;
    }

    for (const pattern of subscriptionPatterns) {
            // Handle simple prefix matching for '#' ending patterns
            if (pattern.endsWith('/#')) {
                const prefix = pattern.substring(0, pattern.length - 1); // Get 'a/b/' from 'a/b/#'
                if (outputTopic.startsWith(prefix)) {
                    return true;
                }
            }
            // Handle exact match or '+' matching using Regex (simplified)
            else {
                    const regex = mqttPatternToClientRegex(pattern);
                    if (regex.test(outputTopic)) {
                        return true;
                    }
            }
    }
    return false; // No pattern matched
}

/**
 * Creates the DOM for a single target editor.
 * @param {object} rule - The parent rule object.
 * @param {object} target - The target object to create an editor for.
 * @returns {HTMLElement} The populated editor element.
 */
function createTargetEditor(rule, target) {
    const template = mapperTargetTemplate.content.cloneNode(true);
    const editorDiv = template.querySelector('.mapper-target-editor');
    editorDiv.dataset.targetId = target.id;

    const isSourceSparkplug = rule.sourceTopic.startsWith('spBv1.0/');

    const title = editorDiv.querySelector('.target-editor-title');
    title.textContent = `Target: ${target.id.substring(0, 8)}`;

    const enabledToggle = editorDiv.querySelector('.target-enabled-toggle');
    enabledToggle.checked = target.enabled;
    enabledToggle.addEventListener('change', () => {
        target.enabled = enabledToggle.checked;
    });

    const deleteButton = editorDiv.querySelector('.target-delete-button');
    deleteButton.addEventListener('click', () => {
        showPruneModal(rule, target);
    });

    const outputTopicInput = editorDiv.querySelector('.target-output-topic');
    outputTopicInput.value = target.outputTopic;

    // --- Validation logic ---
    const validateTopic = () => {
        const topicValue = outputTopicInput.value.trim();
        target.outputTopic = topicValue; // Update data model immediately

        let warningMessage = '';
        let isError = false;

        if (topicValue) {
            if (!isTopicSubscribed(topicValue)) {
                warningMessage = 'Warning: This topic might not be covered by current subscriptions.';
            }
            if (isSourceSparkplug && topicValue.startsWith('spBv1.0/')) {
                warningMessage += (warningMessage ? '\n' : '') + 'Warning: Republishing Sparkplug data to spBv1.0/ namespace can cause decoding loops. Consider using your UNS namespace.';
            }
            if (!isSourceSparkplug && topicValue.startsWith('spBv1.0/')) {
                warningMessage = 'ERROR: Cannot map a non-Sparkplug source to the spBv1.0/ namespace. Target topic is invalid.';
                isError = true;
            }
        }

        outputTopicInput.classList.remove('input-warning', 'input-error');
        if (isError) {
            outputTopicInput.classList.add('input-error');
            outputTopicInput.title = warningMessage;
        } else if (warningMessage) {
            outputTopicInput.classList.add('input-warning');
            outputTopicInput.title = warningMessage;
        } else {
            outputTopicInput.title = '';
        }
    };
    outputTopicInput.addEventListener('input', validateTopic);
    validateTopic();
    // --- END Validation ---

    const codeLabel = editorDiv.querySelector('.target-code-label');
    codeLabel.textContent = 'Transform (JavaScript)';

    // [MODIFIED] This section is now for Ace Editor initialization
    const codeEditorDiv = editorDiv.querySelector('.target-code-editor');
    
    if (!target.code) {
        target.code = defaultJSCode;
    }
    
    // --- [NEW] Initialize Ace Editor ---
    const editor = ace.edit(codeEditorDiv);
    editor.setTheme(isDarkTheme ? 'ace/theme/tomorrow_night' : 'ace/theme/chrome');
    editor.session.setMode('ace/mode/javascript');
    editor.session.setValue(target.code);
    editor.setOptions({
        fontSize: "14px",
        fontFamily: "monospace",
        enableBasicAutocompletion: true,
        enableLiveAutocompletion: true,
        enableSnippets: true,
        useWorker: true // Enable syntax checking
    });

    editor.session.on('change', () => {
        target.code = editor.session.getValue();
    });
    
    // Store the editor instance
    aceEditors.set(target.id, editor);
    // --- [END NEW] ---

    updateMetricsForTarget(editorDiv, rule.sourceTopic, target.id);

    return editorDiv;
}

/**
 * Event handler for the "Add Target" button.
 */
function onAddTarget() {
    if (!currentEditingSourceTopic) return;

    const rule = getRuleForTopic(currentEditingSourceTopic, true); // Create rule if needed

    const defaultOutputTopic = currentEditingSourceTopic + Math.floor(Math.random() * 100);

    const newTarget = {
        id: `tgt_${Date.now()}`,
        enabled: true,
        outputTopic: defaultOutputTopic,
        mode: "js",
        code: defaultJSCode
    };

    rule.targets.push(newTarget);
    renderTransformEditor(currentEditingSourceTopic); // Re-render
}

/**
 * Updates the metrics display for all targets in the editor.
 * @param {string} sourceTopic - The source topic being edited.
 */
function updateMetricsForEditor(sourceTopic) {
    if (!sourceTopic || sourceTopic !== currentEditingSourceTopic) return;

    const rule = getRuleForTopic(sourceTopic, false);
    if (!rule) return;

    rule.targets.forEach(target => {
        const editorDiv = mapperTargetsList.querySelector(`.mapper-target-editor[data-target-id="${target.id}"]`);
        if (editorDiv) {
            updateMetricsForTarget(editorDiv, sourceTopic, target.id);
        }
    });
}

/**
 * Updates the metrics for a single target editor.
 * @param {HTMLElement} editorDiv - The DOM element for the target editor.
 * @param {string} sourceTopic - The source topic.
 * @param {string} targetId - The target ID.
 */
function updateMetricsForTarget(editorDiv, sourceTopic, targetId) {
    const ruleId = `${sourceTopic}::${targetId}`;
    const ruleMetrics = mapperMetrics[ruleId];

    const countSpan = editorDiv.querySelector('.metric-count');
    const logsList = editorDiv.querySelector('.target-logs-list');

    if (ruleMetrics) {
        countSpan.textContent = ruleMetrics.count;
        if (ruleMetrics.logs && ruleMetrics.logs.length > 0) {
            logsList.innerHTML = '';
            ruleMetrics.logs.forEach(log => {
                const logDiv = document.createElement('div');
                logDiv.className = 'target-log-entry';
                let fullLogContent = ''; // [NEW] Store full content for copy

                // [MODIFIED] Check if the log entry is an error or debug
                if (log.error) {
                    logDiv.classList.add('is-error');
                    logDiv.innerHTML = `
                        <span class="log-entry-ts">${new Date(log.ts).toLocaleTimeString('en-GB')}</span>
                        <span class="log-entry-error-label">ERROR</span>
                    `;
                    fullLogContent = `Input: ${log.inTopic}\nError: ${log.error}`; // [NEW]
                    logDiv.title = fullLogContent;
                
                } else if (log.debug) { // <-- [NEW] Ajout de ce bloc
                    logDiv.classList.add('is-debug');
                    logDiv.innerHTML = `
                        <span class="log-entry-ts">${new Date(log.ts).toLocaleTimeString('en-GB')}</span>
                        <span class="log-entry-debug-label">TRACE</span>
                    `;
                    fullLogContent = `Input: ${log.inTopic}\nTrace: ${log.debug}`; // [NEW]
                    logDiv.title = fullLogContent;

                } else {
                    logDiv.innerHTML = `
                        <span class="log-entry-ts">${new Date(log.ts).toLocaleTimeString('en-GB')}</span>
                        <span class="log-entry-topic">${log.outTopic}</span>
                    `;
                    fullLogContent = `Payload: ${log.outPayload}`; // [NEW]
                    logDiv.title = fullLogContent;
                }

                // --- [NEW] Add Copy Button ---
                const copyBtn = document.createElement('button');
                copyBtn.className = 'log-copy-btn';
                copyBtn.innerHTML = '📋'; // Clipboard emoji
                copyBtn.title = 'Copy log details';
                copyBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(fullLogContent).then(() => {
                        copyBtn.innerHTML = '✓'; // Checkmark
                        copyBtn.classList.add('copied');
                        setTimeout(() => {
                            copyBtn.innerHTML = '📋';
                            copyBtn.classList.remove('copied');
                        }, 1000);
                    }).catch(err => {
                        console.error('Failed to copy log:', err);
                        copyBtn.innerHTML = 'X';
                    });
                });
                logDiv.appendChild(copyBtn);
                // --- [END NEW] ---

                logsList.appendChild(logDiv);
            });
        } else {
            logsList.innerHTML = '<p class.history-placeholder">No executions yet.</p>';
        }
    } else {
        countSpan.textContent = '0';
        logsList.innerHTML = '<p class="history-placeholder">No executions yet.</p>';
    }
}

/**
 * Event handler for the "Save" button.
 */
async function onSave() {
    let hasInvalidMapping = false;
    const activeVersion = mapperConfig.versions.find(v => v.id === mapperConfig.activeVersionId);
    if (activeVersion && activeVersion.rules) {
        for (const rule of activeVersion.rules) {
            const isSourceSparkplug = rule.sourceTopic.startsWith('spBv1.0/');
            for (const target of rule.targets) {
                if (!isSourceSparkplug && target.outputTopic.startsWith('spBv1.0/')) {
                    hasInvalidMapping = true;
                    if (currentEditingSourceTopic === rule.sourceTopic) {
                            const editorDiv = mapperTargetsList.querySelector(`.mapper-target-editor[data-target-id="${target.id}"]`);
                            if(editorDiv) {
                                const outputTopicInput = editorDiv.querySelector('.target-output-topic');
                                outputTopicInput?.classList.add('input-error');
                                outputTopicInput?.focus();
                            }
                    }
                }
            }
        }
    }

    if (hasInvalidMapping) {
        showMapperSaveStatus('ERROR: Invalid mapping(s) found (JSON Source -> spBv1.0/ Target). Cannot save.', 'error');
        return;
    }

    showMapperSaveStatus('Saving...');
    try {
        if(activeVersion) {
            activeVersion.rules = activeVersion.rules.filter(r => r.targets && r.targets.length > 0);
        }

        const response = await fetch('api/mapper/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(mapperConfig)
        });
        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Failed to save');
        }
        showMapperSaveStatus('Saved!', 'success');
        appCallbacks.colorAllTrees();
    } catch (error) {
        console.error('Error saving mapper config:', error);
        showMapperSaveStatus(error.message, 'error');
    }
}

/**
 * Event handler for the "Save as New..." button.
 */
function onSaveAsNew() {
    const activeVersionName = mapperVersionSelect.options[mapperVersionSelect.selectedIndex]?.text || 'current';
    const newVersionName = prompt("Enter a name for the new version:", `Copy of ${activeVersionName}`);
    if (!newVersionName) return;

    const activeVersion = mapperConfig.versions.find(v => v.id === mapperConfig.activeVersionId);
    if (!activeVersion) return;

    const newVersion = JSON.parse(JSON.stringify(activeVersion));
    newVersion.id = `v_${Date.now()}`;
    newVersion.name = newVersionName;
    newVersion.createdAt = new Date().toISOString();
    newVersion.rules = newVersion.rules.filter(r => r.targets && r.targets.length > 0);

    mapperConfig.versions.push(newVersion);
    mapperConfig.activeVersionId = newVersion.id;

    updateMapperVersionSelector();
    onSave(); // Trigger a save
}

/**
 * Event handler for changing the active version.
 */
function onVersionChange() {
    mapperConfig.activeVersionId = mapperVersionSelect.value;

    if (currentEditingSourceTopic) {
        renderTransformEditor(currentEditingSourceTopic);
    } else {
        mapperTransformPlaceholder.style.display = 'block';
        mapperTransformForm.style.display = 'none';
    }
    
    appCallbacks.colorAllTrees();
}

/**
 * Shows a status message (e.g., "Saved!") in the mapper UI.
 * @param {string} message - The text to display.
 * @param {string} type - 'success' or 'error'.
 */
function showMapperSaveStatus(message, type = 'success') {
    if (!mapperSaveStatus) return;
    mapperSaveStatus.textContent = message;
    mapperSaveStatus.className = type;
    clearTimeout(mapperSaveTimer);
    mapperSaveTimer = setTimeout(() => {
        mapperSaveStatus.textContent = '';
        mapperSaveStatus.className = '';
    }, 3000);
}

// --- Delete Modal Logic ---

/**
 * Shows the "Delete/Prune" modal.
 * @param {object} rule - The parent rule.
 * @param {object} target - The target being deleted.
 */
function showPruneModal(rule, target) {
    deleteModalContext = { rule, target };

    deleteModalTopic.textContent = target.outputTopic;

    let pattern = target.outputTopic;
    if (pattern.includes('{{')) {
        pattern = target.outputTopic.replace(/\{\{.+?\}\}/g, '+');
        if (pattern.endsWith('/+')) {
            pattern = pattern.substring(0, pattern.length - 1) + '#';
        }
    }
    deleteModalPattern.value = pattern;

    deleteModalBackdrop.style.display = 'flex';
}

/**
 * Hides the "Delete/Prune" modal.
 */
function hidePruneModal() {
    deleteModalBackdrop.style.display = 'none';
    deleteModalContext = null;
}

/**
 * Event handler for "Delete rule only" button.
 */
function onDeleteRule() {
    if (!deleteModalContext) return;
    const { rule, target } = deleteModalContext;

    // --- [NEW] Destroy Ace editor ---
    const editor = aceEditors.get(target.id);
    if (editor) {
        editor.destroy();
        aceEditors.delete(target.id);
    }
    // --- [END NEW] ---

    rule.targets = rule.targets.filter(t => t.id !== target.id);

    if (rule.targets.length === 0) {
        const activeVersion = mapperConfig.versions.find(v => v.id === mapperConfig.activeVersionId);
        if(activeVersion) {
            activeVersion.rules = activeVersion.rules.filter(r => r.sourceTopic !== rule.sourceTopic);
        }
        currentEditingSourceTopic = null;
        mapperTransformPlaceholder.style.display = 'block';
        mapperTransformForm.style.display = 'none';
        payloadViewer.clear(); // [NEW] Clear payload display
    } else {
        renderTransformEditor(rule.sourceTopic);
    }

    onSave(); // Save changes
    hidePruneModal();
}

/**
 * Event handler for "Delete AND Prune history" button.
 */
async function onDeleteAndPrune() {
    if (!deleteModalContext) return;
    const { rule, target } = deleteModalContext;
    const topicPattern = deleteModalPattern.value;

    // Use the callback to notify app.js to ignore this pattern
    appCallbacks.addPruneIgnorePattern(topicPattern);

    modalBtnDeletePrune.disabled = true;
    showMapperSaveStatus('Purging history...', 'info');

    try {
        const response = await fetch('api/context/prune-topic', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ topicPattern })
        });
        if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error || 'Failed to prune database.');
        }
        const result = await response.json();
        console.log(`Pruned ${result.count} entries from DB.`);
        
        // --- [NEW] Destroy Ace editor ---
        const editor = aceEditors.get(target.id);
        if (editor) {
            editor.destroy();
            aceEditors.delete(target.id);
        }
        // --- [END NEW] ---

        rule.targets = rule.targets.filter(t => t.id !== target.id);

        let ruleWasRemoved = false;
        if (rule.targets.length === 0) {
            const activeVersion = mapperConfig.versions.find(v => v.id === mapperConfig.activeVersionId);
            if(activeVersion) {
                activeVersion.rules = activeVersion.rules.filter(r => r.sourceTopic !== rule.sourceTopic);
            }
                ruleWasRemoved = true;
        }

        await onSave(); // Save config changes

        // Use the callback to trigger a frontend-wide prune and rebuild
        await appCallbacks.pruneTopicFromFrontend(topicPattern);

        if(ruleWasRemoved) {
            currentEditingSourceTopic = null;
            mapperTransformPlaceholder.style.display = 'block';
            mapperTransformForm.style.display = 'none';
            payloadViewer.clear(); // [NEW] Clear payload display
        } else {
            renderTransformEditor(rule.sourceTopic);
        }

        showMapperSaveStatus(`Rule deleted & ${result.count} entries pruned.`, 'success');
        hidePruneModal();

    } catch (err) {
        console.error('Error during prune operation:', err);
        showMapperSaveStatus(`Prune failed: ${err.message}`, 'error');
        hidePruneModal();
    } finally {
            modalBtnDeletePrune.disabled = false;
    }
}