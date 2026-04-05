/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 */

import { state } from '../state.js';
import { trackEvent } from '../utils.js';

/**
 * Custom Web Component for editing a Mapper Target.
 * Encapsulates the UI and logic for a single transformation target within a rule.
 */
class MapperTargetEditor extends HTMLElement {
    constructor() {
        super();
        /** @type {Object|null} */
        this.rule = null;
        /** @type {Object|null} */
        this.target = null;
        /** @type {Object|null} */
        this.callbacks = null;
        /** @type {any|null} */
        this.aceEditor = null;
    }

    /**
     * Initializes the component with data and callbacks.
     * @param {Object} rule The parent rule object.
     * @param {Object} target The specific target object to edit.
     * @param {Object} options Configuration and callbacks.
     */
    init(rule, target, options) {
        this.rule = rule;
        this.target = target;
        this.callbacks = options.callbacks || {};
        this.context = options.context || {};
        this.render();
    }

    render() {
        const template = document.getElementById('mapper-target-template');
        if (!template) {
            console.error('MapperTargetEditor: template #mapper-target-template not found.');
            return;
        }

        this.innerHTML = '';
        const content = template.content.cloneNode(true);
        const editorDiv = content.querySelector('.mapper-target-editor');
        editorDiv.dataset.targetId = this.target.id;

        const isSourceSparkplug = this.rule.sourceTopic.startsWith('spBv1.0/');
        const isDarkTheme = document.body.classList.contains('dark-theme');

        // --- Title & Collapse Logic ---
        const toggleBtn = editorDiv.querySelector('.target-toggle-collapse');
        toggleBtn.addEventListener('click', () => {
            editorDiv.classList.toggle('collapsed');
            setTimeout(() => { if (this.aceEditor) this.aceEditor.resize(); }, 50);
            if (this.callbacks.onToggleCollapse) this.callbacks.onToggleCollapse(this.target.id);
        });

        const titleInput = editorDiv.querySelector('.target-editor-title-input');
        titleInput.value = this.target.name || 'Unnamed Target';
        titleInput.addEventListener('change', (e) => {
            let newName = e.target.value.trim() || "Unnamed Target";
            const isDuplicate = this.rule.targets.some(t => t.id !== this.target.id && t.name === newName);
            if (isDuplicate) {
                newName = newName + "_" + Math.floor(Math.random() * 1000);
                e.target.value = newName;
            }
            this.target.name = newName;
            state.mapperUnsaved = true;
        });

        const enabledToggle = editorDiv.querySelector('.target-enabled-toggle');
        enabledToggle.checked = this.target.enabled;
        enabledToggle.addEventListener('change', () => {
            this.target.enabled = enabledToggle.checked;
            trackEvent('mapper_target_toggle'); 
            state.mapperUnsaved = true;
        });

        const deleteButton = editorDiv.querySelector('.target-delete-button');
        deleteButton.addEventListener('click', () => {
            if (this.callbacks.onDelete) this.callbacks.onDelete(this.rule, this.target);
        });

        // --- Routing Mode Logic ---
        if (!this.target.routingMode) this.target.routingMode = 'ui';
        const routingModeSelect = editorDiv.querySelector('.routing-mode-select');
        const topicGroup = editorDiv.querySelector('.target-topic-group');
        const outputTopicInput = editorDiv.querySelector('.target-output-topic');
        
        outputTopicInput.value = this.target.outputTopic || '';
        routingModeSelect.value = this.target.routingMode;

        const validateTopic = () => {
            if (this.target.routingMode === 'code') return;
            this.target.outputTopic = outputTopicInput.value; 
            if (this.callbacks.onValidateTopic) {
                const validation = this.callbacks.onValidateTopic(this.target.outputTopic, isSourceSparkplug);
                outputTopicInput.classList.toggle('input-error', !!validation.isError);
                outputTopicInput.classList.toggle('input-warning', !!validation.warning);
                outputTopicInput.title = validation.message || '';
            }
        };

        const applyRoutingModeUI = () => {
            topicGroup.style.display = this.target.routingMode === 'code' ? 'none' : 'block';
            if (this.target.routingMode !== 'code') validateTopic();
            else {
                outputTopicInput.classList.remove('input-warning', 'input-error');
                outputTopicInput.title = '';
            }
        };

        routingModeSelect.addEventListener('change', (e) => {
            const oldMode = this.target.routingMode;
            this.target.routingMode = e.target.value;
            applyRoutingModeUI();
            if (this.callbacks.onRoutingModeChange) this.callbacks.onRoutingModeChange(this.target.id, oldMode, this.target.routingMode);
            state.mapperUnsaved = true;
        });

        outputTopicInput.addEventListener('input', () => {
            validateTopic();
            state.mapperUnsaved = true;
        });

        // --- Provider Target Selector ---
        if (this.context.isMultiProvider) {
            const brokerGroup = document.createElement('div');
            brokerGroup.className = 'form-group';
            brokerGroup.style.cssText = "margin:0; flex:1; min-width:200px;";
            brokerGroup.innerHTML = `<label style="margin-bottom:5px;">Target Provider:</label>`;
            
            const select = document.createElement('select');
            select.className = 'target-source-select';
            select.style.width = "100%";
            select.innerHTML = `<option value="">Same as Source</option>`;

            (this.context.availableProviders || []).forEach(provider => {
                const opt = document.createElement('option');
                opt.value = provider.id;
                const isReadOnly = !provider.publish || provider.publish.length === 0;
                opt.textContent = `${isReadOnly ? '🔒 ' : ''}${provider.id} [${(provider.type || 'mqtt').toUpperCase()}]${isReadOnly ? ' (Read-Only)' : ''}`;
                opt.disabled = isReadOnly;
                select.appendChild(opt);
            });

            select.value = this.target.targetConnectorId || ""; 
            select.addEventListener('change', () => {
                this.target.targetConnectorId = select.value || null; 
                state.mapperUnsaved = true;
            });
            brokerGroup.appendChild(select);
            editorDiv.querySelector('.target-settings-row').insertBefore(brokerGroup, routingModeSelect.parentNode);
        }

        // --- Ace Editor ---
        const codeEditorDiv = editorDiv.querySelector('.target-code-editor');
        if (typeof ace !== 'undefined') {
            this.aceEditor = ace.edit(codeEditorDiv);
            this.aceEditor.setTheme(isDarkTheme ? 'ace/theme/tomorrow_night' : 'ace/theme/chrome');
            this.aceEditor.session.setMode('ace/mode/javascript');
            this.aceEditor.session.setValue(this.target.code || '');
            this.aceEditor.setOptions({
                fontSize: "14px", fontFamily: "monospace",
                enableBasicAutocompletion: true, enableLiveAutocompletion: true,
                enableSnippets: true, useWorker: true 
            });
            this.aceEditor.session.on('change', () => {
                this.target.code = this.aceEditor.session.getValue();
                state.mapperUnsaved = true;
            });
            if (this.callbacks.onEditorCreated) this.callbacks.onEditorCreated(this.target.id, this.aceEditor);
        }

        // --- Maximize / Minimize ---
        const maximizeBtn = editorDiv.querySelector('.target-maximize-code');
        const minimizeBtn = editorDiv.querySelector('.target-minimize-button');
        const saveMaximizedBtn = editorDiv.querySelector('.target-save-maximized');
        const payloadRefContent = editorDiv.querySelector('.maximized-payload-content');

        const toggleMaximized = () => {
            const isMaximized = editorDiv.classList.toggle('maximized');
            if (isMaximized && this.callbacks.getPayload) {
                const payload = this.callbacks.getPayload();
                try { payloadRefContent.textContent = JSON.stringify(JSON.parse(payload), null, 2); }
                catch(e) { payloadRefContent.textContent = payload || "No payload received yet."; }
            }
            setTimeout(() => { if (this.aceEditor) this.aceEditor.resize(); }, 50);
        };

        maximizeBtn.addEventListener('click', toggleMaximized);
        minimizeBtn.addEventListener('click', toggleMaximized);
        saveMaximizedBtn.addEventListener('click', () => { if (this.callbacks.onSave) this.callbacks.onSave(); });

        const userRole = window.currentUser ? window.currentUser.role : 'user';
        if (userRole !== 'admin') saveMaximizedBtn.style.display = 'none';

        this.appendChild(content);
        applyRoutingModeUI();
        if (this.callbacks.onRendered) this.callbacks.onRendered(editorDiv, this.target.id);
    }

    disconnectedCallback() {
        if (this.aceEditor) {
            this.aceEditor.destroy();
            this.aceEditor = null;
        }
    }
}

customElements.define('mapper-target-editor', MapperTargetEditor);
export default MapperTargetEditor;
