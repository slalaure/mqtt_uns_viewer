/**
 * @license Apache License, Version 2.0 (the "License")
 */

import { confirmModal, trackEvent, makeResizable, showToast } from './utils.js';
import { state } from './state.js';

// --- State ---
let currentModel = null;
let currentSelection = { type: null, id: null, ref: null }; 
let isModelerInitialized = false;
let isMounted = false;
let networkGraph = null; 
let aceEditor = null;
let editMode = 'form'; 
let isPhysicsEnabled = true;
let templatePromise = null;
let syncTimeout = null;

// --- DOM Elements ---
let el = {};

const ICONS = {
    ns: '<svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin:0; width:14px; height:14px;"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>',
    type: '<svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin:0; width:14px; height:14px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>',
    inst: '<svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin:0; width:14px; height:14px;"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>',
    freeze: '<svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin:0 4px 0 0;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>',
    unfreeze: '<svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin:0 4px 0 0;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>'
};

export async function initModelerView() {
    if (templatePromise) return templatePromise;

    templatePromise = (async () => {
        const container = document.getElementById('modeler-view');
        if (!container || isModelerInitialized) return;

        try {
            const response = await fetch('html/view.modeler.html');
            container.innerHTML = await response.text();

            const ids = [
                'modeler-tree-container', 'relationship-graph', 'btn-modeler-refresh', 'btn-modeler-save',
                'modeler-welcome', 'modeler-content', 'btn-modeler-delete', 'btn-add-namespace', 
                'btn-add-type', 'btn-add-instance', 'modeler-search', 'modeler-edit-displayname',
                'modeler-edit-id', 'btn-mode-form', 'btn-mode-json', 'modeler-form-view',
                'modeler-json-view', 'modeler-ace-editor', 'field-isa-level', 'field-namespace',
                'container-properties', 'container-relationships',
                'btn-add-property', 'btn-add-relationship', 'btn-toggle-physics',
                'modeler-help-modal', 'btn-modeler-help', 'btn-close-modeler-help',
                'btn-modeler-import', 'btn-modeler-export', 'modeler-import-file', 'btn-modeler-raw'
            ];
            ids.forEach(id => el[id] = document.getElementById(id));

            makeResizable({ 
                resizerEl: document.getElementById('drag-handle-vertical-modeler-1'), 
                direction: 'vertical', 
                panelA: document.querySelector('.modeler-sidebar') 
            });
            
            const resizer2 = document.getElementById('drag-handle-vertical-modeler-2');
            const rightPanel = document.querySelector('.modeler-graph-sidebar');
            let isDraggingRight = false;
            
            resizer2.addEventListener('mousedown', (e) => {
                isDraggingRight = true;
                document.body.style.cursor = 'col-resize';
                e.preventDefault();
            });
            
            window.addEventListener('mousemove', (e) => {
                if (!isDraggingRight) return;
                const containerRect = document.querySelector('.modeler-container').getBoundingClientRect();
                let newWidth = containerRect.right - e.clientX;
                if (newWidth < 150) newWidth = 150;
                if (newWidth > 800) newWidth = 800;
                rightPanel.style.width = `${newWidth}px`;
                rightPanel.style.flexBasis = `${newWidth}px`;
            });
            
            window.addEventListener('mouseup', () => {
                if (isDraggingRight) {
                    isDraggingRight = false;
                    document.body.style.cursor = 'default';
                }
            });

            isModelerInitialized = true;
            if (state.activeView === 'modeler') mountModelerView();
        } catch (err) { console.error("Modeler Init Error:", err); }
    })();

    return templatePromise;
}

export function mountModelerView() {
    if (isMounted || !isModelerInitialized) return;

    el['btn-modeler-refresh'].onclick = loadModel;
    el['btn-modeler-save'].onclick = saveModelToServer;
    
    // Import/Export logic
    el['btn-modeler-export'].onclick = () => {
        if (!currentModel) return showToast("No model to export.", "warning");
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(currentModel, null, 2));
        const a = document.createElement('a');
        a.href = dataStr;
        a.download = `uns_model_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
    };
    
    el['btn-modeler-import'].onclick = () => el['modeler-import-file'].click();
    
    el['modeler-import-file'].onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (evt) => {
            try {
                const importedModel = JSON.parse(evt.target.result);
                currentModel = importedModel;
                renderRegistry();
                setEditMode('form');
                el['btn-modeler-save'].classList.add('btn-unsaved');
                showToast("Model imported! Don't forget to click Save.", "info");
            } catch (err) {
                showToast("Invalid JSON file.", "error");
            }
            el['modeler-import-file'].value = '';
        };
        reader.readAsText(file);
    };

    el['btn-modeler-help'].onclick = () => el['modeler-help-modal'].style.display = 'flex';
    el['btn-close-modeler-help'].onclick = () => el['modeler-help-modal'].style.display = 'none';
    
    // Close modal if clicked outside the content area
    el['modeler-help-modal'].onclick = (e) => {
        if (e.target === el['modeler-help-modal']) {
            el['modeler-help-modal'].style.display = 'none';
        }
    };

    el['btn-add-namespace'].onclick = () => createItem('namespace');
    el['btn-add-type'].onclick = () => createItem('objectType');
    el['btn-add-instance'].onclick = () => createItem('instance');
    el['modeler-search'].oninput = renderRegistry;
    el['btn-modeler-delete'].onclick = handleDelete;
    el['btn-mode-form'].onclick = () => setEditMode('form');
    el['btn-mode-json'].onclick = () => setEditMode('json');
    el['btn-modeler-raw'].onclick = () => setEditMode('raw');
    el['btn-add-property'].onclick = () => addSchemaRow();
    el['btn-add-relationship'].onclick = () => addRelationshipRow();
    
    el['btn-toggle-physics'].onclick = () => {
        isPhysicsEnabled = !isPhysicsEnabled;
        el['btn-toggle-physics'].innerHTML = isPhysicsEnabled ? `${ICONS.freeze} Freeze` : `${ICONS.unfreeze} Unfreeze`;
        if (networkGraph) {
            networkGraph.setPhysics(isPhysicsEnabled);
        }
    };

    [el['modeler-edit-displayname'], el['field-isa-level'], el['field-namespace']].forEach(input => {
        input.oninput = syncStateFromForm;
    });

    loadModel();
    isMounted = true;
}

export function onModelerViewShow() { mountModelerView(); }

export function unmountModelerView() {
    if (!isMounted) return;
    if (networkGraph) { networkGraph.destroy(); networkGraph = null; }
    if (aceEditor) { aceEditor.destroy(); aceEditor = null; }
    isMounted = false;
}

// --- Logic ---

async function loadModel() {
    try {
        const res = await fetch('api/env/model');
        currentModel = await res.json();
        renderRegistry();
        populateNamespaces();
        if (currentSelection.id) selectItem(currentSelection.type, currentSelection.id);
    } catch (e) { showToast("Load error", "error"); }
}

function populateNamespaces() {
    const nsEl = document.getElementById('field-namespace');
    if (!nsEl) return;
    nsEl.innerHTML = (currentModel?.namespaces || []).map(ns =>
        `<option value="${ns.uri}">${ns.displayName}</option>`
    ).join('');
}
function renderRegistry() {
    if (!el['modeler-tree-container']) return;
    const query = el['modeler-search'].value.toLowerCase();
    const container = el['modeler-tree-container'];
    container.innerHTML = '';

    const createNode = (id, name, type, icon) => {
        if (query && !name.toLowerCase().includes(query) && !id.toLowerCase().includes(query)) return null;
        const div = document.createElement('div');
        const isSelected = String(currentSelection.id) === String(id);
        
        div.className = `modeler-node ${isSelected ? 'selected' : ''}`;
        if (isSelected) {
            div.style.backgroundColor = "rgba(0, 123, 255, 0.2)";
            div.style.borderLeft = "4px solid #007bff";
            div.style.color = "#007bff";
            div.style.fontWeight = "bold";
        }
        
        div.innerHTML = `<span class="node-icon" style="margin-right:6px; display:inline-flex; align-items:center;">${icon}</span> <span class="node-label" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${name}</span>`;
        div.onclick = () => selectItem(type, id);
        return div;
    };

    const section = (title, items, type, icon) => {
        if (!items || items.length === 0) return;
        const h = document.createElement('div');
        h.style = "font-size:0.7em; text-transform:uppercase; color:var(--color-text-muted); margin: 15px 0 5px 5px; font-weight:700; letter-spacing:1px;";
        h.textContent = title;
        container.appendChild(h);
        items.forEach(item => {
            const id = item.uri || item.elementId;
            const node = createNode(id, item.displayName || id, type, icon);
            if (node) container.appendChild(node);
        });
    };

    section('Namespaces', currentModel.namespaces, 'namespace', ICONS.ns);
    section('Object Types', currentModel.objectTypes, 'objectType', ICONS.type);
    section('Instances', currentModel.instances, 'instance', ICONS.inst);
}

function selectItem(type, id) {
    let ref = null;
    if (type === 'namespace') ref = currentModel.namespaces.find(n => n.uri === id);
    if (type === 'objectType') ref = currentModel.objectTypes.find(t => t.elementId === id);
    if (type === 'instance') ref = currentModel.instances.find(i => i.elementId === id);

    if (!ref) return;
    currentSelection = { type, id, ref };
    
    el['modeler-welcome'].style.display = 'none';
    el['modeler-content'].style.display = 'flex';
    
    renderRegistry();
    
    [el['modeler-edit-displayname'], el['field-isa-level'], el['field-namespace']].forEach(i => {
        if(i) i.oninput = null;
    });

    // 1. Setup Namespace UI dynamically
    const nsContainer = el['field-namespace'].parentNode;
    if (type === 'namespace') {
        nsContainer.innerHTML = `<label class="modern-label">Namespace URI</label><input type="text" id="field-namespace" class="modern-input">`;
    } else {
        nsContainer.innerHTML = `<label class="modern-label">Namespace URI</label><select id="field-namespace" class="modern-input"></select>`;
    }
    el['field-namespace'] = document.getElementById('field-namespace');
    
    if (type !== 'namespace') populateNamespaces();
    
    // 2. Fill values
    el['modeler-edit-displayname'].value = ref.displayName || '';
    el['modeler-edit-id'].textContent = id;
    el['field-isa-level'].value = ref.isaLevel || '';
    
    if (type === 'namespace') {
        el['field-namespace'].value = ref.uri || '';
    } else {
        el['field-namespace'].value = ref.namespaceUri || '';
    }

    // 3. Toggle Sections Visibility (I3X Specific Fix)
    const schemaSection = el['container-properties'].closest('.editor-section');
    const relSection = el['container-relationships'].closest('.editor-section');
    const isaContainer = el['field-isa-level'].parentNode;
    
    if (type === 'namespace') {
        schemaSection.style.display = 'none';
        relSection.style.display = 'none';
        isaContainer.style.display = 'none';
    } else if (type === 'objectType') {
        schemaSection.style.display = 'block';
        relSection.style.display = 'block';
        isaContainer.style.display = 'none';
        renderSchemaItems();
        renderRelationships();
    } else { // 'instance'
        schemaSection.style.display = 'none'; // Instances inherit schemas from their Types
        relSection.style.display = 'block';
        isaContainer.style.display = 'block';
        renderRelationships();
    }
    
    [el['modeler-edit-displayname'], el['field-isa-level'], el['field-namespace']].forEach(i => {
        if(i) i.oninput = syncStateFromForm;
    });

    // Render graph natively
    drawGraph();

    if (editMode === 'json' || editMode === 'raw') {
        if (aceEditor) aceEditor.setValue(JSON.stringify(currentSelection.ref, null, 2), -1);
        editMode = 'json'; // Exit raw mode since an item is selected
        setEditMode('json');
    }
}

function renderSchemaItems() {
    el['container-properties'].innerHTML = '';
    
    // Inject the Datalist for Regex Presets (Only needed once per render)
    if (!document.getElementById('regex-presets')) {
        const datalist = document.createElement('datalist');
        datalist.id = 'regex-presets';
        datalist.innerHTML = `
            <option value="^[a-zA-Z0-9_]+$">Alphanumeric</option>
            <option value="^\\d+$">Numbers Only</option>
            <option value="^[\\w-\\.]+@([\\w-]+\\.)+[\\w-]{2,4}$">Email Address</option>
            <option value="^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$">Hex Color</option>
            <option value="^(true|false|1|0)$">Boolean (Strict)</option>
            <option value="^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$">IP Address (v4)</option>
        `;
        el['container-properties'].appendChild(datalist);
    }

    const schema = currentSelection.ref.schema || {};
    const props = schema.properties || {};
    Object.entries(props).forEach(([key, val]) => {
        addSchemaRow({ id: key, ...val });
    });
}

function addSchemaRow(data = {}) {
    const container = el['container-properties'];
    const row = document.createElement('div');
    row.className = 'schema-item-row';
    row.style.flexDirection = 'column';
    row.style.alignItems = 'stretch';
    row.style.gap = '4px';

    const types = ['string', 'number', 'boolean', 'integer', 'object', 'array'];
    const typeOptions = types.map(t => `<option value="${t}" ${data.type === t ? 'selected' : ''}>${t}</option>`).join('');
    
    const keyTypes = ['-', 'PK', 'FK'];
    const keyTypeOptions = keyTypes.map(t => `<option value="${t}" ${data.keyType === t ? 'selected' : ''}>${t}</option>`).join('');
    
    const confLevels = ['Public', 'Internal', 'Confidential', 'Restricted'];
    const confOptions = confLevels.map(t => `<option value="${t}" ${data.confidentiality === t ? 'selected' : ''}>${t}</option>`).join('');
    
    const sensLevels = ['Normal', 'Sensitive', 'Highly Sensitive'];
    const sensOptions = sensLevels.map(t => `<option value="${t}" ${data.sensitivity === t ? 'selected' : ''}>${t}</option>`).join('');

    const fkTargets = [];
    const extractPKs = (entities, prefix) => {
        (entities || []).forEach(entity => {
            const props = entity.schema?.properties || {};
            Object.entries(props).forEach(([propId, propDef]) => {
                if (propDef.keyType === 'PK') {
                    fkTargets.push({
                        id: `${entity.elementId}.${propId}`,
                        label: `${prefix}: ${entity.displayName || entity.elementId} → ${propDef.title || propId}`
                    });
                }
            });
        });
    };
    extractPKs(currentModel.objectTypes, 'Type');
    extractPKs(currentModel.instances, 'Obj');

    const fkTargetOptions = `<option value="">-- Link to PK --</option>` + fkTargets.map(t => `<option value="${t.id}" ${data.fkTarget === t.id ? 'selected' : ''}>${t.label}</option>`).join('');

    const minRange = data.expected_range ? data.expected_range[0] : '';
    const maxRange = data.expected_range ? data.expected_range[1] : '';

    const isNumeric = data.type === 'number' || data.type === 'integer';

    row.innerHTML = `
        <div style="display: flex; gap: 8px; align-items: center;">
            <input type="text" placeholder="ID" class="modern-input" style="flex: 1.5 0 80px; font-family:monospace; min-width: 80px;" value="${data.id || ''}" data-key="id">
            <input type="text" placeholder="Label" class="modern-input" style="flex: 2 0 120px; min-width: 120px;" value="${data.title || data.id || ''}" data-key="title">
            <input type="text" placeholder="Description..." class="modern-input" style="flex: 3 0 150px; min-width: 150px;" value="${data.description || ''}" data-key="description" title="Explanation of the data">
            <select class="modern-input" style="flex: 1.5 0 90px; min-width: 90px;" data-key="type">${typeOptions}</select>
            
            <div style="flex: 1.5 0 100px; min-width: 100px; position: relative; display: flex; align-items: center;">
                <input type="text" placeholder="Regex/Pattern" class="modern-input" style="width: 100%; padding-right: 24px;" value="${data.pattern || ''}" data-key="pattern" title="Regex or schema constraint" list="regex-presets">
                <button class="btn-ask-ai-regex" style="position: absolute; right: 4px; background: none; border: none; cursor: pointer; font-size: 1.1em; padding: 0; display: flex; align-items: center; justify-content: center; filter: grayscale(0.5); transition: filter 0.2s;" title="Ask AI to generate a Regex pattern">✨</button>
            </div>

            <input type="text" placeholder="Sensor/PLC/HW" class="modern-input" style="flex: 2 0 120px; min-width: 120px;" value="${data.source || ''}" data-key="source" title="Hardware or entity that generated this data">
            <select class="modern-input" style="flex: 1 0 70px; min-width: 70px; background: var(--color-bg-tertiary);" data-key="keyType" title="Key Type (PK/FK)">${keyTypeOptions}</select>
            <select class="modern-input" style="flex: 2 0 120px; min-width: 120px; display: ${data.keyType === 'FK' ? 'block' : 'none'}; border: 1px solid var(--color-primary);" data-key="fkTarget">${fkTargetOptions}</select>
            <div style="flex: 2 0 120px; min-width: 120px; display: ${data.keyType !== 'FK' ? 'block' : 'none'};"></div>
            <select class="modern-input" style="flex: 1.5 0 100px; min-width: 100px;" data-key="confidentiality" title="Confidentiality">${confOptions}</select>
            <select class="modern-input" style="flex: 1.5 0 100px; min-width: 100px;" data-key="sensitivity" title="Sensitivity">${sensOptions}</select>
            <input type="text" placeholder="Unit" class="modern-input" style="flex: 1 0 60px; min-width: 60px;" value="${data.unit || ''}" data-key="unit">
            <button class="btn-delete-row" style="flex: 0 0 30px; width: 30px; padding: 4px 8px;">✖</button>
        </div>
        <div class="profiling-row" style="display: ${isNumeric ? 'flex' : 'none'}; flex-wrap: wrap; gap: 15px; align-items: center; padding: 6px 10px; background: var(--color-bg-tertiary); border-radius: 4px; font-size: 0.85em; margin-top: 5px;">
            <span style="color: var(--color-text-muted); font-weight: bold;">Profiling:</span>
            <div style="display:flex; align-items:center; gap: 4px;">Nominal: <input type="number" step="any" class="modern-input" style="padding: 4px 6px; width: 70px;" data-key="nominal_value" value="${data.nominal_value ?? ''}"></div>
            <div style="display:flex; align-items:center; gap: 4px;">Min: <input type="number" step="any" class="modern-input" style="padding: 4px 6px; width: 70px;" data-key="min_range" value="${minRange}"></div>
            <div style="display:flex; align-items:center; gap: 4px;">Max: <input type="number" step="any" class="modern-input" style="padding: 4px 6px; width: 70px;" data-key="max_range" value="${maxRange}"></div>
            <div style="display:flex; align-items:center; gap: 4px;">Freq(s): <input type="number" step="any" class="modern-input" style="padding: 4px 6px; width: 70px;" data-key="data_frequency_seconds" value="${data.data_frequency_seconds ?? ''}"></div>
            <div style="display:flex; align-items:center; gap: 4px;">Qual(%): <input type="number" step="any" min="0" max="100" class="modern-input" style="padding: 4px 6px; width: 70px;" data-key="quality_score" value="${data.quality_score ? Math.round(data.quality_score * 100) : ''}"></div>
        </div>
    `;

    // Hook up the AI Regex Assistant button
    const btnAskAi = row.querySelector('.btn-ask-ai-regex');
    if (btnAskAi) {
        btnAskAi.onmouseover = () => btnAskAi.style.filter = 'grayscale(0)';
        btnAskAi.onmouseout = () => btnAskAi.style.filter = 'grayscale(0.5)';
        btnAskAi.onclick = () => {
            const propId = row.querySelector('[data-key="id"]')?.value || 'this property';
            const propDesc = row.querySelector('[data-key="description"]')?.value || '';
            const propType = row.querySelector('[data-key="type"]')?.value || 'string';
            const objectName = el['modeler-edit-displayname']?.value || 'the current object';

            let promptMsg = `I am modeling an equipment/object named "${objectName}" in the CDM Modeler.\n`;
            promptMsg += `Please generate a strict Regular Expression (Regex) pattern to validate the following property:\n`;
            promptMsg += `- Property Name: "${propId}"\n`;
            promptMsg += `- Data Type: "${propType}"\n`;
            if (propDesc) promptMsg += `- Description/Role: "${propDesc}"\n\n`;
            promptMsg += `Provide ONLY the raw Regex string inside a code block, followed by a brief explanation.`;

            const chatWidget = document.querySelector('ai-chat-widget');
            if (chatWidget && typeof chatWidget.askNewQuestion === 'function') {
                chatWidget.askNewQuestion(promptMsg, true);
            } else {
                showToast("AI Chat Assistant is not available.", "warning");
            }
        };
    }

    const keyTypeSelect = row.querySelector('[data-key="keyType"]');
    const fkTargetSelect = row.querySelector('[data-key="fkTarget"]');
    const typeSelect = row.querySelector('[data-key="type"]');
    const profilingRow = row.querySelector('.profiling-row');
    
    keyTypeSelect.onchange = (e) => {
        fkTargetSelect.style.display = e.target.value === 'FK' ? 'block' : 'none';
        syncStateFromForm();
        
        if (e.target.value === 'PK' || data.keyType === 'PK') {
            renderSchemaItems();
        }
    };
    
    typeSelect.onchange = (e) => {
        const val = e.target.value;
        profilingRow.style.display = (val === 'number' || val === 'integer') ? 'flex' : 'none';
        syncStateFromForm();
    };

    row.querySelectorAll('input, select').forEach(i => {
        if (i !== keyTypeSelect && i !== typeSelect) i.oninput = syncStateFromForm;
        if (i === fkTargetSelect) i.onchange = syncStateFromForm;
    });
    row.querySelector('.btn-delete-row').onclick = () => { 
        const wasPK = keyTypeSelect.value === 'PK';
        row.remove(); 
        syncStateFromForm(); 
        if (wasPK) renderSchemaItems(); 
    };
    container.appendChild(row);
}

function renderRelationships() {
    el['container-relationships'].innerHTML = '';
    const rels = currentSelection.ref.relationships || {};
    Object.entries(rels).forEach(([relType, targets]) => {
        const targetList = Array.isArray(targets) ? targets : [targets];
        targetList.forEach(targetId => {
            addRelationshipRow({ type: relType, target: targetId });
        });
    });
}

function addRelationshipRow(data = {}) {
    const container = el['container-relationships'];
    const row = document.createElement('div');
    row.className = 'schema-item-row';
    
    const types = ['HasParent', 'HasChildren', 'HasComponent', 'ComponentOf', 'InstanceOf', 'SuppliesTo', 'SuppliesFrom'];
    const typeOptions = types.map(t => `<option value="${t}" ${data.type === t ? 'selected' : ''}>${t}</option>`).join('');
    
    const targetOptions = (currentModel?.instances || [])
        .filter(i => i.elementId !== currentSelection.id)
        .map(i => `<option value="${i.elementId}" ${data.target === i.elementId ? 'selected' : ''}>${i.displayName || i.elementId}</option>`)
        .join('');

    row.innerHTML = `
        <select class="modern-input" style="flex:2;" data-key="rel-type">${typeOptions}</select>
        <select class="modern-input" style="flex:3;" data-key="rel-target">
            <option value="">-- Select Target --</option>
            ${targetOptions}
        </select>
        <button class="btn-delete-row">✖</button>
    `;

    row.querySelectorAll('select').forEach(i => i.onchange = syncRelationshipsAndRedraw);
    row.querySelector('.btn-delete-row').onclick = () => { row.remove(); syncRelationshipsAndRedraw(); };
    container.appendChild(row);
}

function syncStateFromForm() {
    if (!currentSelection.ref) return;
    const ref = currentSelection.ref;
    ref.displayName = el['modeler-edit-displayname'].value;
    
    if (el['field-isa-level'].value) {
        ref.isaLevel = el['field-isa-level'].value;
    } else {
        delete ref.isaLevel;
    }
    
    if (currentSelection.type === 'namespace') {
        ref.uri = el['field-namespace'].value;
        renderRegistry();
        el['btn-modeler-save'].classList.add('btn-unsaved');
        return; 
    }
    
    ref.namespaceUri = el['field-namespace'].value;

    const properties = {};
    const rows = [...el['container-properties'].children];
    rows.forEach(row => {
        const id = row.querySelector('[data-key="id"]')?.value?.trim();
        if (!id) return;
        
        const existingItem = ref.schema?.properties?.[id] || {};
        
        const item = { 
            ...existingItem,
            title: row.querySelector('[data-key="title"]').value || id, 
            type: row.querySelector('[data-key="type"]').value,
            keyType: row.querySelector('[data-key="keyType"]').value,
            confidentiality: row.querySelector('[data-key="confidentiality"]').value,
            sensitivity: row.querySelector('[data-key="sensitivity"]').value
        };

        if (item.keyType === 'FK') {
            item.fkTarget = row.querySelector('[data-key="fkTarget"]').value;
        }

        const unitEl = row.querySelector('[data-key="unit"]');
        if (unitEl && unitEl.value) item.unit = unitEl.value;
        
        const descEl = row.querySelector('[data-key="description"]');
        if (descEl && descEl.value) item.description = descEl.value; else delete item.description;
        
        const pattEl = row.querySelector('[data-key="pattern"]');
        if (pattEl && pattEl.value) item.pattern = pattEl.value; else delete item.pattern;

        const srcEl = row.querySelector('[data-key="source"]');
        if (srcEl && srcEl.value) item.source = srcEl.value; else delete item.source;

        const nom = row.querySelector('[data-key="nominal_value"]').value;
        if (nom !== '') item.nominal_value = parseFloat(nom);
        else delete item.nominal_value;

        const freq = row.querySelector('[data-key="data_frequency_seconds"]').value;
        if (freq !== '') item.data_frequency_seconds = parseFloat(freq);
        else delete item.data_frequency_seconds;

        const qual = row.querySelector('[data-key="quality_score"]').value;
        if (qual !== '') item.quality_score = parseFloat(qual) / 100;
        else delete item.quality_score;

        const min = row.querySelector('[data-key="min_range"]').value;
        const max = row.querySelector('[data-key="max_range"]').value;
        if (min !== '' || max !== '') {
            item.expected_range = [
                min !== '' ? parseFloat(min) : null,
                max !== '' ? parseFloat(max) : null
            ];
        } else {
            delete item.expected_range;
        }

        properties[id] = item;
    });
    ref.schema = { type: "object", properties };

    renderRegistry();
    el['btn-modeler-save'].classList.add('btn-unsaved');
}

function syncRelationshipsAndRedraw() {
    if (!currentSelection.ref) return;
    const relationships = {};
    [...el['container-relationships'].children].forEach(row => {
        const type = row.querySelector('[data-key="rel-type"]').value;
        const target = row.querySelector('[data-key="rel-target"]').value;
        if (!type || !target) return;
        if (!relationships[type]) relationships[type] = [];
        relationships[type].push(target);
    });
    currentSelection.ref.relationships = relationships;
    syncStateFromForm();
    drawGraph();
}

function setEditMode(mode) {
    if (editMode === 'json' && mode === 'form') {
        try {
            const updated = JSON.parse(aceEditor.getValue());
            Object.assign(currentSelection.ref, updated);
            selectItem(currentSelection.type, currentSelection.id);
        } catch(e) { showToast("Fix JSON first", "error"); return; }
    } else if (editMode === 'raw' && mode !== 'raw') {
        try {
            const updated = JSON.parse(aceEditor.getValue());
            currentModel = updated;
            renderRegistry();
            if (currentSelection.id) selectItem(currentSelection.type, currentSelection.id);
        } catch(e) { showToast("Fix JSON first", "error"); return; }
    }

    editMode = mode;

    if (mode === 'raw') {
        el['modeler-welcome'].style.display = 'none';
        el['modeler-content'].style.display = 'flex';
        el['modeler-edit-displayname'].value = 'uns_model.json';
        el['modeler-edit-displayname'].disabled = true;
        el['modeler-edit-id'].textContent = 'Complete JSON Model (Namespaces, ObjectTypes, Instances)';
        el['btn-mode-form'].parentElement.style.display = 'none';
        el['btn-modeler-delete'].style.display = 'none';
        el['modeler-form-view'].style.display = 'none';
        el['modeler-json-view'].style.display = 'block';
    } else {
        el['modeler-edit-displayname'].disabled = false;
        el['btn-mode-form'].parentElement.style.display = 'flex'; 
        el['btn-modeler-delete'].style.display = 'flex'; 
        el['btn-mode-form'].classList.toggle('active', mode === 'form');
        el['btn-mode-json'].classList.toggle('active', mode === 'json');
        el['modeler-form-view'].style.display = mode === 'form' ? 'block' : 'none';
        el['modeler-json-view'].style.display = mode === 'json' ? 'block' : 'none';
    }

    if (mode === 'json' || mode === 'raw') {
        if (!aceEditor) {
            aceEditor = ace.edit(el['modeler-ace-editor']);
            aceEditor.setTheme(state.isDarkMode ? "ace/theme/tomorrow_night" : "ace/theme/chrome");
            aceEditor.session.setMode("ace/mode/json");
            
            aceEditor.on("change", () => {
                el['btn-modeler-save'].classList.add('btn-unsaved');
            });
        }

        if (mode === 'raw') {
            aceEditor.setValue(JSON.stringify(currentModel, null, 2), -1);
        } else {
            aceEditor.setValue(JSON.stringify(currentSelection.ref, null, 2), -1);
        }
    }
}

// ============================================================================
// NATIVE KORELATE GRAPH ENGINE (SVG Force-Directed)
// ============================================================================

class KorelateGraph {
    constructor(container, data, options) {
        this.container = container;
        this.container.innerHTML = '';
        this.options = options || {};
        this.isPhysicsEnabled = this.options.physicsEnabled ?? true;
        this.onDoubleClick = this.options.onDoubleClick || (()=>{});
        
        this.svg = document.createElementNS("[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)", "svg");
        this.svg.style.width = '100%';
        this.svg.style.height = '100%';
        this.svg.style.display = 'block';
        this.svg.style.userSelect = 'none';
        
        this.svg.innerHTML = `
            <defs>
                <marker id="korelate-arrow" viewBox="0 0 10 10" refX="28" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#888" />
                </marker>
            </defs>
            <g class="edges"></g>
            <g class="nodes"></g>
        `;
        this.container.appendChild(this.svg);
        this.edgesGroup = this.svg.querySelector('.edges');
        this.nodesGroup = this.svg.querySelector('.nodes');

        this.nodes = [];
        this.edges = [];
        this.nodeMap = new Map();
        
        this.draggedNode = null;
        this.dragOffset = {x: 0, y: 0};
        this.lastClick = { id: null, time: 0 };
        this.animFrame = null;

        this.initData(data);
        this.bindEvents();
        
        if (this.isPhysicsEnabled) this.start();
        else this.render();
    }

    initData(data) {
        const width = this.container.clientWidth || 400;
        const height = this.container.clientHeight || 400;
        const cx = width / 2;
        const cy = height / 2;

        data.nodes.forEach((n) => {
            const node = {
                id: n.id,
                label: n.label,
                x: cx + (Math.random() - 0.5) * 150,
                y: cy + (Math.random() - 0.5) * 150,
                vx: 0, vy: 0,
                width: 140, height: 36,
                color: n.color || '#fff',
                fontColor: n.fontColor || '#333',
                isCenter: n.id === 'self'
            };
            this.nodes.push(node);
            this.nodeMap.set(node.id, node);

            const g = document.createElementNS("[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)", "g");
            g.setAttribute('class', 'korelate-node');
            g.setAttribute('cursor', 'pointer');
            g.dataset.id = node.id;
            
            const rect = document.createElementNS("[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)", "rect");
            rect.setAttribute('width', node.width);
            rect.setAttribute('height', node.height);
            rect.setAttribute('x', -node.width/2);
            rect.setAttribute('y', -node.height/2);
            rect.setAttribute('rx', 6);
            rect.setAttribute('fill', node.color);
            rect.setAttribute('stroke', node.isCenter ? '#0056b3' : '#999');
            rect.setAttribute('stroke-width', node.isCenter ? '2' : '1');
            
            const text = document.createElementNS("[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)", "text");
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('dominant-baseline', 'central');
            text.setAttribute('fill', node.fontColor);
            text.setAttribute('font-size', '12px');
            text.setAttribute('font-family', 'sans-serif');
            text.setAttribute('pointer-events', 'none');
            
            let rawText = n.label.replace(/<[^>]*>?/gm, '').trim();
            if (rawText.length > 20) rawText = rawText.substring(0, 18) + '...';
            text.textContent = rawText;
            
            g.appendChild(rect);
            g.appendChild(text);
            this.nodesGroup.appendChild(g);
            node.el = g;
        });

        data.edges.forEach(e => {
            const source = this.nodeMap.get(e.from);
            const target = this.nodeMap.get(e.to);
            if (source && target) {
                const edge = { source, target, label: e.label || '' };
                this.edges.push(edge);
                
                const line = document.createElementNS("[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)", "line");
                line.setAttribute('stroke', '#888');
                line.setAttribute('stroke-width', '2');
                line.setAttribute('marker-end', 'url(#korelate-arrow)');
                
                const labelBg = document.createElementNS("[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)", "rect");
                labelBg.setAttribute('fill', state.isDarkMode ? '#1e1e1e' : '#fff');
                labelBg.setAttribute('rx', '3');
                
                const labelText = document.createElementNS("[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)", "text");
                labelText.setAttribute('text-anchor', 'middle');
                labelText.setAttribute('dominant-baseline', 'central');
                labelText.setAttribute('fill', '#888');
                labelText.setAttribute('font-size', '10px');
                labelText.setAttribute('font-family', 'sans-serif');
                labelText.textContent = edge.label;
                
                this.edgesGroup.appendChild(line);
                this.edgesGroup.appendChild(labelBg);
                this.edgesGroup.appendChild(labelText);
                
                edge.lineEl = line;
                edge.labelBg = labelBg;
                edge.labelEl = labelText;
            }
        });
    }

    bindEvents() {
        this.svg.addEventListener('mousedown', (e) => {
            const targetG = e.target.closest('.korelate-node');
            if (targetG && targetG.dataset.id) {
                const node = this.nodeMap.get(targetG.dataset.id);
                if (node) {
                    const now = Date.now();
                    if (this.lastClick.id === node.id && (now - this.lastClick.time) < 300) {
                        this.onDoubleClick(node.id);
                        return;
                    }
                    this.lastClick = { id: node.id, time: now };
                    
                    this.draggedNode = node;
                    const pt = this.getSVGPoint(e);
                    this.dragOffset = { x: node.x - pt.x, y: node.y - pt.y };
                    node.vx = 0; node.vy = 0;
                }
            }
        });

        window.addEventListener('mousemove', (e) => {
            if (this.draggedNode) {
                const pt = this.getSVGPoint(e);
                this.draggedNode.x = pt.x + this.dragOffset.x;
                this.draggedNode.y = pt.y + this.dragOffset.y;
                this.draggedNode.vx = 0;
                this.draggedNode.vy = 0;
                this.render(); 
            }
        });

        window.addEventListener('mouseup', () => {
            this.draggedNode = null;
        });
    }

    getSVGPoint(evt) {
        const pt = this.svg.createSVGPoint();
        pt.x = evt.clientX;
        pt.y = evt.clientY;
        return pt.matrixTransform(this.svg.getScreenCTM().inverse());
    }

    setPhysics(enabled) {
        this.isPhysicsEnabled = enabled;
        if (enabled) this.start();
        else this.stop();
    }

    start() {
        if (!this.animFrame) this.loop();
    }

    stop() {
        if (this.animFrame) {
            cancelAnimationFrame(this.animFrame);
            this.animFrame = null;
        }
    }

    destroy() {
        this.stop();
        this.container.innerHTML = '';
    }

    loop() {
        if (this.isPhysicsEnabled) {
            this.applyForces();
        }
        this.render();
        if (this.isPhysicsEnabled) {
            this.animFrame = requestAnimationFrame(() => this.loop());
        } else {
            this.animFrame = null;
        }
    }

    applyForces() {
        const width = this.container.clientWidth || 400;
        const height = this.container.clientHeight || 400;
        const cx = width / 2;
        const cy = height / 2;
        
        const kRepel = 6000; 
        const kSpring = 0.05; 
        const springLen = 140;
        const damping = 0.75; 

        // 1. Node Repulsion
        for (let i = 0; i < this.nodes.length; i++) {
            for (let j = i + 1; j < this.nodes.length; j++) {
                const n1 = this.nodes[i];
                const n2 = this.nodes[j];
                let dx = n1.x - n2.x;
                let dy = n1.y - n2.y;
                let dsq = dx*dx + dy*dy;
                if (dsq === 0) { dx = Math.random()-0.5; dy = Math.random()-0.5; dsq = dx*dx+dy*dy; }
                if (dsq < 90000) {
                    const d = Math.sqrt(dsq);
                    const force = kRepel / dsq;
                    const fx = (dx/d) * force;
                    const fy = (dy/d) * force;
                    n1.vx += fx; n1.vy += fy;
                    n2.vx -= fx; n2.vy -= fy;
                }
            }
        }

        // 2. Edge Attraction
        this.edges.forEach(e => {
            const n1 = e.source;
            const n2 = e.target;
            let dx = n2.x - n1.x;
            let dy = n2.y - n1.y;
            let d = Math.sqrt(dx*dx + dy*dy);
            if (d === 0) d = 0.1;
            const force = (d - springLen) * kSpring;
            const fx = (dx/d) * force;
            const fy = (dy/d) * force;
            n1.vx += fx; n1.vy += fy;
            n2.vx -= fx; n2.vy -= fy;
        });

        // 3. Gravity and Integration
        this.nodes.forEach(n => {
            n.vx += (cx - n.x) * 0.01;
            n.vy += (cy - n.y) * 0.01;
            
            n.vx *= damping;
            n.vy *= damping;
            
            if (Math.abs(n.vx) < 0.05) n.vx = 0;
            if (Math.abs(n.vy) < 0.05) n.vy = 0;

            if (n !== this.draggedNode) {
                n.x += n.vx;
                n.y += n.vy;
            }
            
            // Bounds
            n.x = Math.max(n.width/2 + 10, Math.min(width - n.width/2 - 10, n.x));
            n.y = Math.max(n.height/2 + 10, Math.min(height - n.height/2 - 10, n.y));
        });
    }

    render() {
        this.nodes.forEach(n => {
            n.el.setAttribute('transform', `translate(${n.x},${n.y})`);
        });
        
        this.edges.forEach(e => {
            e.lineEl.setAttribute('x1', e.source.x);
            e.lineEl.setAttribute('y1', e.source.y);
            e.lineEl.setAttribute('x2', e.target.x);
            e.lineEl.setAttribute('y2', e.target.y);
            
            if (e.label) {
                const mx = (e.source.x + e.target.x) / 2;
                const my = (e.source.y + e.target.y) / 2;
                e.labelEl.setAttribute('x', mx);
                e.labelEl.setAttribute('y', my);
                
                const bbox = e.labelEl.getBBox ? e.labelEl.getBBox() : { width: e.label.length * 6, height: 12 };
                const w = Math.max(bbox.width + 8, 20);
                e.labelBg.setAttribute('x', mx - w/2);
                e.labelBg.setAttribute('y', my - 8);
                e.labelBg.setAttribute('width', w);
                e.labelBg.setAttribute('height', 16);
            }
        });
    }
}

function drawGraph() {
    const graphDiv = el['relationship-graph'];
    if (!graphDiv) return;

    const item = currentSelection.ref;
    if (!item) return;

    const isDark = state.isDarkMode;
    const nodes = [{ id: 'self', label: item.displayName || 'Selected', color: '#007bff', fontColor: '#fff' }];
    const edges = [];

    const addNode = (id, label, icon, group) => {
        if (!nodes.find(n => n.id === id)) {
            let color = isDark ? '#333' : '#eee';
            let fontColor = isDark ? '#fff' : '#333';
            if (group === 'ns') { color = '#3b82f6'; fontColor = '#fff'; }
            else if (group === 'type') { color = '#28a745'; fontColor = '#fff'; }
            nodes.push({ id, label: `${icon} ${label}`, color, fontColor });
        }
    };

    if (item.namespaceUri) {
        addNode('ns', item.namespaceUri.split('/').pop(), ICONS.ns, 'ns');
        edges.push({ from: 'self', to: 'ns', label: 'belongs to' });
    }

    if (currentSelection.type === 'instance') {
        if (item.parentId && item.parentId !== '/') {
            const p = currentModel.instances.find(i => i.elementId === item.parentId);
            addNode('parent', p ? (p.displayName || p.elementId) : item.parentId, ICONS.inst, 'inst');
            edges.push({ from: 'self', to: 'parent', label: 'ChildOf' });
        }
        if (item.typeId) {
            const t = currentModel.objectTypes.find(ot => ot.elementId === item.typeId);
            addNode('type', t ? (t.displayName || t.elementId) : item.typeId, ICONS.type, 'type');
            edges.push({ from: 'self', to: 'type', label: 'InstanceOf' });
        }
        if (item.relationships) {
            Object.entries(item.relationships).forEach(([rel, targets]) => {
                const list = Array.isArray(targets) ? targets : [targets];
                list.forEach(tId => {
                    const tObj = currentModel.instances.find(i => i.elementId === tId);
                    const label = tObj ? (tObj.displayName || tId) : tId;
                    addNode(`rel-${tId}`, label, ICONS.inst, 'inst');
                    edges.push({ from: 'self', to: `rel-${tId}`, label: rel });
                });
            });
        }
    } else if (currentSelection.type === 'objectType') {
        const instances = currentModel.instances.filter(i => i.typeId === item.elementId).slice(0, 10);
        instances.forEach(i => {
            addNode(`inst-${i.elementId}`, i.displayName || i.elementId, ICONS.inst, 'inst');
            edges.push({ from: `inst-${i.elementId}`, to: 'self', label: 'Implements' });
        });
    }

    if (networkGraph) {
        networkGraph.destroy();
    }
    
    networkGraph = new KorelateGraph(graphDiv, { nodes, edges }, {
        physicsEnabled: isPhysicsEnabled,
        onDoubleClick: (nid) => {
            if (nid === 'parent') selectItem('instance', item.parentId);
            else if (nid === 'type') selectItem('objectType', item.typeId);
            else if (nid === 'ns') selectItem('namespace', item.namespaceUri);
            else if (nid.startsWith('rel-')) selectItem('instance', nid.replace('rel-', ''));
            else if (nid.startsWith('inst-')) selectItem('instance', nid.replace('inst-', ''));
        }
    });
}

// --- CRUD ---

async function handleDelete() {
    const { type, id } = currentSelection;
    if (await confirmModal(`Delete ${type}`, `Remove "${id}"?`, "Delete", true)) {
        if (type === 'namespace') currentModel.namespaces = currentModel.namespaces.filter(n => n.uri !== id);
        else if (type === 'objectType') currentModel.objectTypes = currentModel.objectTypes.filter(t => t.elementId !== id);
        else currentModel.instances = currentModel.instances.filter(i => i.elementId !== id);
        el['modeler-welcome'].style.display = 'flex';
        el['modeler-content'].style.display = 'none';
        currentSelection = { type: null, id: null, ref: null };
        renderRegistry();
    }
}

function createItem(type) {
    const id = `new_${type}_${Date.now()}`;
    const newItem = { displayName: `New ${type}`, description: "", isaLevel: "Equipment" };
    if (type === 'namespace') { newItem.uri = `https://local/${Date.now()}`; currentModel.namespaces.push(newItem); selectItem(type, newItem.uri); }
    else {
        newItem.elementId = id; newItem.namespaceUri = currentModel.namespaces[0]?.uri || "";
        if (type === 'objectType') { newItem.schema = { type: "object", properties: {} }; currentModel.objectTypes.push(newItem); }
        else { newItem.typeId = currentModel.objectTypes[0]?.elementId || ""; currentModel.instances.push(newItem); }
        selectItem(type, id);
    }
}

async function saveModelToServer() {
    if (editMode === 'json' && aceEditor) {
        try { Object.assign(currentSelection.ref, JSON.parse(aceEditor.getValue())); } catch(e) { return showToast("Invalid JSON", "error"); }
    } else if (editMode === 'raw' && aceEditor) {
        try { 
            const updated = JSON.parse(aceEditor.getValue()); 
            currentModel = updated;
        } catch(e) { return showToast("Invalid JSON in Raw mode", "error"); }
    }
    
    el['btn-modeler-save'].disabled = true;
    try {
        const res = await fetch('api/env/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentModel) });
        if (!res.ok) throw new Error();
        showToast("Model saved", "success");
        el['btn-modeler-save'].classList.remove('btn-unsaved');
        renderRegistry(); 
    } catch (e) { showToast("Save error", "error"); }
    finally { el['btn-modeler-save'].disabled = false; }
}