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
  
 */

// Import shared utilities
import { mqttPatternToClientRegex, trackEvent } from './utils.js'; 
import { createPayloadViewer } from './payload-viewer.js';

// --- DOM Element Querying ---
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
let mappedTargetTopics = new Map(); 
let mapperSaveTimer = null;
let currentEditingBrokerId = null; 
let currentEditingSourceTopic = null;
let defaultJSCode = ''; 
let deleteModalContext = null;
let maxMappersLimit = 0; 
let isMultiBroker = false; 
let brokerConfigs = []; // Store broker configs

let aceEditors = new Map(); 
let isDarkTheme = localStorage.getItem('theme') === 'dark'; 

let payloadViewer = createPayloadViewer({
    topicEl: document.getElementById('mapper-payload-topic'),
    contentEl: document.getElementById('mapper-payload-content'),
    historyLogEl: null, 
    placeholderEl: null,
    isMultiBroker: false 
});


// --- Callbacks from main app.js ---
let appCallbacks = {
    pruneTopicFromFrontend: () => console.error("pruneTopicFromFrontend callback not set"),
    getSubscribedTopics: () => ['#'], 
    colorAllTrees: () => console.error("colorAllTrees callback not set"),
    addPruneIgnorePattern: () => console.error("addPruneIgnorePattern callback not set"),
};

export function setMapperTheme(isDark) {
    isDarkTheme = isDark;
    const theme = isDark ? 'ace/theme/tomorrow_night' : 'ace/theme/chrome';
    aceEditors.forEach(editor => {
        editor.setTheme(theme);
    });
}


/**
 * Initializes the Mapper View functionality.
 */
export function initMapperView(callbacks) {
    const { displayPayload, maxSavedMapperVersions, isMultiBroker: multiBrokerState, brokerConfigs: bConfigs, ...otherCallbacks } = callbacks;
    appCallbacks = { ...appCallbacks, ...otherCallbacks };
    maxMappersLimit = maxSavedMapperVersions || 0; 
    isMultiBroker = multiBrokerState || false;
    brokerConfigs = bConfigs || [];

    payloadViewer = createPayloadViewer({
        topicEl: document.getElementById('mapper-payload-topic'),
        contentEl: document.getElementById('mapper-payload-content'),
        isMultiBroker: isMultiBroker 
    });
    
    defaultJSCode = `// 'msg' object contains msg.topic, msg.payload (parsed JSON), and msg.brokerId.
// 'db' object is available with await db.all(sql) and await db.get(sql).
// Return the modified 'msg' object to publish.
// Return null or undefined to skip publishing.

/* // Example: Get average of last 5 values for this topic
try {
    const sql = \`
        SELECT AVG(CAST(payload->>'value' AS DOUBLE)) as avg_val 
        FROM (
            SELECT payload FROM mqtt_events 
            WHERE topic = '\${msg.topic}' AND broker_id = '\${msg.brokerId}'
            ORDER BY timestamp DESC 
            LIMIT 5
        )\
    \`;
    const result = await db.get(sql);
    if (result && result.avg_val) {
        msg.payload.average_5 = result.avg_val;
    }
} catch (e) {
    console.error(\"DB query failed: \" + e.message);
}
*/

return msg;
`;
    
    loadMapperConfig(); 
    
    mapperSaveButton?.addEventListener('click', onSave);
    mapperSaveAsNewButton?.addEventListener('click', onSaveAsNew);
    mapperVersionSelect?.addEventListener('change', onVersionChange);
    mapperAddTargetButton?.addEventListener('click', onAddTarget);
    
    modalBtnCancel?.addEventListener('click', hidePruneModal);
    modalBtnDeleteRule?.addEventListener('click', onDeleteRule);
    modalBtnDeletePrune?.addEventListener('click', onDeleteAndPrune);
}

export function updateMapperMetrics(newMetrics) {
    mapperMetrics = newMetrics;
    if (currentEditingSourceTopic) {
        updateMetricsForEditor(currentEditingSourceTopic);
    }
}

export function updateMapperConfig(newConfig) {
    console.log("Received config update from server");
    mapperConfig = newConfig;
    updateMapperVersionSelector();
    appCallbacks.colorAllTrees(); 
}

/**
 * Handle click on mapper tree node.
 * Now explicitly ignores folders/parent topics for mapping.
 */
export function handleMapperNodeClick(event, nodeContainer, brokerId, topic) {
    const li = nodeContainer.closest('li');
    
    //  Ignore folders for mapping logic
    if (li.classList.contains('is-folder')) {
        return; 
    }

    const payload = nodeContainer.dataset.payload; 
    payloadViewer.display(brokerId, topic, payload);

    // Enable editor for leaf node only
    currentEditingBrokerId = brokerId;
    currentEditingSourceTopic = topic;
    
    renderTransformEditor(brokerId, topic);
}

export function getMapperConfig() {
    return mapperConfig;
}

export function getMappedTargetTopics() {
    return mappedTargetTopics;
}

export function addMappedTargetTopic(brokerId, topic) {
    const key = `${brokerId}|${topic}`;
    mappedTargetTopics.set(key, { brokerId, topic });
}

export function getTopicMappingStatus(brokerId, topic) {
    if (!mapperConfig || !mapperConfig.versions) return null;

    const targetKey = `${brokerId}|${topic}`;
    if (mappedTargetTopics.has(targetKey)) return 'target';

    const activeVersion = mapperConfig.versions.find(v => v.id === mapperConfig.activeVersionId);
    if (!activeVersion) return null;

    for (const rule of activeVersion.rules) {
        if (rule.sourceTopic === topic) {
            return 'source';
        }
        // Check if topic matches a wildcard rule (if any legacy ones exist)
        const pattern = rule.sourceTopic;
        try {
            if (mqttPatternToClientRegex(pattern).test(topic)) {
                 return 'source';
            }
        } catch(e) {}
    }
    return null;
}

// --- Internal Logic ---

async function loadMapperConfig() {
    try {
        const response = await fetch('api/mapper/config');
        if (!response.ok) throw new Error('Failed to fetch mapper config');
        mapperConfig = await response.json();

        if (mapperConfig.DEFAULT_JS_CODE) {
            defaultJSCode = mapperConfig.DEFAULT_JS_CODE;
        } 
        
        updateMapperVersionSelector();
        appCallbacks.colorAllTrees();
    } catch (error) {
        console.error('Error loading mapper config:', error);
        showMapperSaveStatus('Error loading config', 'error');
    }
}

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

function renderTransformEditor(brokerId, sourceTopic) {
    mapperTransformPlaceholder.style.display = 'none';
    mapperTransformForm.style.display = 'flex';
    
    const displayTopic = isMultiBroker ? `[${brokerId}] ${sourceTopic}` : sourceTopic;
    mapperSourceTopicInput.value = displayTopic; 

    aceEditors.forEach(editor => editor.destroy());
    aceEditors.clear();
    
    mapperTargetsList.innerHTML = ''; 

    const rule = getRuleForTopic(sourceTopic, false); 

    if (!rule || rule.targets.length === 0) {
        mapperTargetsPlaceholder.style.display = 'block';
    } else {
        mapperTargetsPlaceholder.style.display = 'none';
        rule.targets.forEach(target => {
            const targetEditor = createTargetEditor(rule, target);
            mapperTargetsList.appendChild(targetEditor);
        });
    }
    updateMetricsForEditor(sourceTopic);
}

function isTopicSubscribed(outputTopic) {
    if (isMultiBroker) return true; 

    const subscriptionPatterns = appCallbacks.getSubscribedTopics();
    if (!subscriptionPatterns || subscriptionPatterns.length === 0) {
        return false;
    }
    if (subscriptionPatterns.includes('#')) {
            return true;
    }

    for (const pattern of subscriptionPatterns) {
            if (pattern.endsWith('/#')) {
                const prefix = pattern.substring(0, pattern.length - 1); 
                if (outputTopic.startsWith(prefix)) {
                    return true;
                }
            }
            else {
                    const regex = mqttPatternToClientRegex(pattern);
                    if (regex.test(outputTopic)) {
                        return true;
                    }
            }
    }
    return false; 
}

/**
 * Creates the DOM for a single target editor.
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
        trackEvent('mapper_target_toggle'); 
    });

    const deleteButton = editorDiv.querySelector('.target-delete-button');
    deleteButton.addEventListener('click', () => {
        showPruneModal(rule, target, currentEditingBrokerId, currentEditingSourceTopic); 
    });

    // --- Broker Target Selector ---
    if (isMultiBroker) {
        const brokerGroup = document.createElement('div');
        brokerGroup.className = 'form-group';
        
        const label = document.createElement('label');
        label.textContent = 'Target Broker';
        
        const select = document.createElement('select');
        select.className = 'target-broker-select';
        
        const sourceOption = document.createElement('option');
        sourceOption.value = ""; // Empty value means use source brokerId
        sourceOption.textContent = "Same as Source";
        select.appendChild(sourceOption);

        brokerConfigs.forEach(broker => {
            const option = document.createElement('option');
            option.value = broker.id;
            
            // [MODIFIED] Check for read-only permission
            const isReadOnly = (!broker.publish || broker.publish.length === 0);
            
            if (isReadOnly) {
                option.textContent = `🔒 ${broker.id} (Read-Only)`;
                option.disabled = true; // Disable selection
            } else {
                option.textContent = `${broker.id} (${broker.host})`;
            }
            
            select.appendChild(option);
        });
        
        select.value = target.targetBrokerId || ""; 
        
        select.addEventListener('change', () => {
            target.targetBrokerId = select.value || null; 
        });
        
        brokerGroup.appendChild(label);
        brokerGroup.appendChild(select);
        
        editorDiv.insertBefore(brokerGroup, editorDiv.querySelector('.form-group'));
    }

    const outputTopicInput = editorDiv.querySelector('.target-output-topic');
    outputTopicInput.value = target.outputTopic;

    //  Removed Wildcard Hint block

    const validateTopic = () => {
        const topicValue = outputTopicInput.value.trim();
        target.outputTopic = topicValue; 

        let warningMessage = '';
        let isError = false;

        if (topicValue) {
            if (!isMultiBroker && !isTopicSubscribed(topicValue)) {
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

    const codeLabel = editorDiv.querySelector('.target-code-label');
    codeLabel.textContent = 'Transform (JavaScript)';

    const codeEditorDiv = editorDiv.querySelector('.target-code-editor');
    
    if (!target.code) {
        target.code = defaultJSCode;
    }
    
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
        useWorker: true 
    });

    editor.session.on('change', () => {
        target.code = editor.session.getValue();
    });
    
    aceEditors.set(target.id, editor);
    
    updateMetricsForTarget(editorDiv, rule.sourceTopic, target.id);

    return editorDiv;
}

/**
 * Event handler for the "Add Target" button.
 */
function onAddTarget() {
    trackEvent('mapper_add_target'); 
    if (!currentEditingSourceTopic) return;
    
    const activeVersion = mapperConfig.versions.find(v => v.id === mapperConfig.activeVersionId);
    if (!activeVersion) return; 
    
    const existingRule = activeVersion.rules.find(r => r.sourceTopic === currentEditingSourceTopic);
    
    if (!existingRule) {
        if (maxMappersLimit > 0 && activeVersion.rules.length >= maxMappersLimit) {
            alert(`Cannot add new mapping rule. You have reached the maximum limit of ${maxMappersLimit} mapping rules for this demo.
Please ask an administrator to clean up old rules or versions.`);
            return; 
        }
    }
    
    const rule = getRuleForTopic(currentEditingSourceTopic, true); 

    //  Removed smart wildcard default. All rules are now explicit leaf mappings.
    let initialOutputTopic = currentEditingSourceTopic + Math.floor(Math.random() * 100);
    let initialCode = defaultJSCode;

    const newTarget = {
        id: `tgt_${Date.now()}`,
        enabled: true,
        outputTopic: initialOutputTopic,
        mode: "js",
        code: initialCode,
        targetBrokerId: null 
    };

    rule.targets.push(newTarget);
    renderTransformEditor(currentEditingBrokerId, currentEditingSourceTopic); 
}

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
                let fullLogContent = ''; 

                if (log.error) {
                    logDiv.classList.add('is-error');
                    logDiv.innerHTML = `
                        <span class="log-entry-ts">${new Date(log.ts).toLocaleTimeString('en-GB')}</span>
                        <span class="log-entry-error-label">ERROR</span>
                    `;
                    fullLogContent = `Input: ${log.inTopic}\nError: ${log.error}`; 
                    logDiv.title = fullLogContent;
                
                } else if (log.debug) { 
                    logDiv.classList.add('is-debug');
                    logDiv.innerHTML = `
                        <span class="log-entry-ts">${new Date(log.ts).toLocaleTimeString('en-GB')}</span>
                        <span class="log-entry-debug-label">TRACE</span>
                    `;
                    fullLogContent = `Input: ${log.inTopic}\nTrace: ${log.debug}`; 
                    logDiv.title = fullLogContent;

                } else {
                    logDiv.innerHTML = `
                        <span class="log-entry-ts">${new Date(log.ts).toLocaleTimeString('en-GB')}</span>
                        <span class="log-entry-topic">${log.outTopic}</span>
                    `;
                    fullLogContent = `Payload: ${log.outPayload}`; 
                    logDiv.title = fullLogContent;
                }

                const copyBtn = document.createElement('button');
                copyBtn.className = 'log-copy-btn';
                copyBtn.innerHTML = '📋'; 
                copyBtn.title = 'Copy log details';
                copyBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(fullLogContent).then(() => {
                        copyBtn.innerHTML = '✓'; 
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
    trackEvent('mapper_save'); 
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

function onSaveAsNew() {
    trackEvent('mapper_save_as_new'); 
    if (maxMappersLimit > 0 && mapperConfig.versions.length >= maxMappersLimit) {
        alert(`Cannot save new version. You have reached the maximum limit of ${maxMappersLimit} saved mapper versions.
Please ask an administrator to clean up old versions.`); 
        return; 
    }

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
    onSave(); 
}

function onVersionChange() {
    trackEvent('mapper_version_change'); 
    mapperConfig.activeVersionId = mapperVersionSelect.value;

    if (currentEditingSourceTopic) {
        renderTransformEditor(currentEditingBrokerId, currentEditingSourceTopic);
    } else {
        mapperTransformPlaceholder.style.display = 'block';
        mapperTransformForm.style.display = 'none';
    }
    
    appCallbacks.colorAllTrees();
}

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

function showPruneModal(rule, target, brokerId, topic) {
    deleteModalContext = { rule, target, brokerId, topic }; 

    const displayTopic = isMultiBroker ? `[${brokerId}] ${target.outputTopic}` : target.outputTopic;
    deleteModalTopic.textContent = displayTopic;

    //  Removed wildcard pattern parsing logic
    let pattern = target.outputTopic;
    deleteModalPattern.value = pattern;

    deleteModalBackdrop.style.display = 'flex';
}

function hidePruneModal() {
    deleteModalBackdrop.style.display = 'none';
    deleteModalContext = null;
}

function onDeleteRule() {
    trackEvent('mapper_delete_rule_only'); 
    if (!deleteModalContext) return;
    const { rule, target, brokerId, topic } = deleteModalContext;

    const editor = aceEditors.get(target.id);
    if (editor) {
        editor.destroy();
        aceEditors.delete(target.id);
    }

    rule.targets = rule.targets.filter(t => t.id !== target.id);

    if (rule.targets.length === 0) {
        const activeVersion = mapperConfig.versions.find(v => v.id === mapperConfig.activeVersionId);
        if(activeVersion) {
            activeVersion.rules = activeVersion.rules.filter(r => r.sourceTopic !== rule.sourceTopic);
        }
        currentEditingBrokerId = null; 
        currentEditingSourceTopic = null;
        mapperTransformPlaceholder.style.display = 'block';
        mapperTransformForm.style.display = 'none';
        payloadViewer.clear(); 
    } else {
        renderTransformEditor(brokerId, topic); 
    }

    onSave(); 
    hidePruneModal();
}

async function onDeleteAndPrune() {
    trackEvent('mapper_delete_and_prune'); 
    if (!deleteModalContext) return;
    const { rule, target, brokerId, topic } = deleteModalContext;
    const topicPattern = deleteModalPattern.value;

    appCallbacks.addPruneIgnorePattern(topicPattern);

    modalBtnDeletePrune.disabled = true;
    showMapperSaveStatus('Purging history...', 'info');

    try {
        const targetBrokerId = target.targetBrokerId || brokerId;
        
        const response = await fetch('api/context/prune-topic', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ topicPattern: topicPattern, broker_id: targetBrokerId })
        });
        if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error || 'Failed to prune database.');
        }
        const result = await response.json();
        console.log(`Pruned ${result.count} entries from DB.`);
        
        const editor = aceEditors.get(target.id);
        if (editor) {
            editor.destroy();
            aceEditors.delete(target.id);
        }

        rule.targets = rule.targets.filter(t => t.id !== target.id);

        let ruleWasRemoved = false;
        if (rule.targets.length === 0) {
            const activeVersion = mapperConfig.versions.find(v => v.id === mapperConfig.activeVersionId);
            if(activeVersion) {
                activeVersion.rules = activeVersion.rules.filter(r => r.sourceTopic !== rule.sourceTopic);
            }
                ruleWasRemoved = true;
        }

        await onSave(); 

        await appCallbacks.pruneTopicFromFrontend(topicPattern);

        if(ruleWasRemoved) {
            currentEditingBrokerId = null; 
            currentEditingSourceTopic = null;
            mapperTransformPlaceholder.style.display = 'block';
            mapperTransformForm.style.display = 'none';
            payloadViewer.clear(); 
        } else {
            renderTransformEditor(brokerId, topic); 
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