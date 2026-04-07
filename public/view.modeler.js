/**
 * @license Apache License, Version 2.0 (the "License")
 */

import { confirmModal, trackEvent, makeResizable, showToast } from './utils.js';
import { state } from './state.js';

// --- Global Error Suppression ---
window.addEventListener('error', (e) => {
    if (e.message && e.message.includes('ResizeObserver loop')) {
        e.stopImmediatePropagation();
        e.preventDefault();
    }
}, true);

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

function loadVisNetwork() {
    return new Promise((resolve) => {
        if (window.vis) return resolve();
        const script = document.createElement('script');
        script.src = (document.querySelector('base')?.getAttribute('href') || '/') + 'libs/vis-network.min.js';
        script.onload = () => resolve();
        script.onerror = () => {
            const cdn = document.createElement('script');
            cdn.src = 'https://unpkg.com/vis-network/standalone/umd/vis-network.min.js';
            cdn.onload = () => resolve();
            document.head.appendChild(cdn);
        };
        document.head.appendChild(script);
    });
}

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
                'btn-add-property', 'btn-add-relationship', 'btn-toggle-physics'
            ];
            ids.forEach(id => el[id] = document.getElementById(id));

            // Resizers
            // Left Resizer: Sidebar (Panel A)
            makeResizable({ 
                resizerEl: document.getElementById('drag-handle-vertical-modeler-1'), 
                direction: 'vertical', 
                panelA: document.querySelector('.modeler-sidebar') 
            });
            
            // Right Resizer: Custom handler to avoid flex:1 conflicts
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
                    if (networkGraph) networkGraph.setSize();
                }
            });

            await loadVisNetwork();

            if (window.ResizeObserver) {
                const ro = new ResizeObserver(() => {
                    if (networkGraph) {
                        networkGraph.setSize();
                        networkGraph.redraw();
                    }
                });
                ro.observe(document.querySelector('.modeler-graph-sidebar'));
            }

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
    el['btn-add-namespace'].onclick = () => createItem('namespace');
    el['btn-add-type'].onclick = () => createItem('objectType');
    el['btn-add-instance'].onclick = () => createItem('instance');
    el['modeler-search'].oninput = renderRegistry;
    el['btn-modeler-delete'].onclick = handleDelete;
    el['btn-mode-form'].onclick = () => setEditMode('form');
    el['btn-mode-json'].onclick = () => setEditMode('json');
    el['btn-add-property'].onclick = () => addSchemaRow();
    el['btn-add-relationship'].onclick = () => addRelationshipRow();
    
    el['btn-toggle-physics'].onclick = () => {
        isPhysicsEnabled = !isPhysicsEnabled;
        el['btn-toggle-physics'].innerHTML = isPhysicsEnabled ? "⚛️ Freeze" : "❄️ Unfreeze";
        if (networkGraph) {
            networkGraph.setOptions({ 
                physics: { enabled: isPhysicsEnabled },
                interaction: { dragNodes: true } 
            });
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
    if (!el['field-namespace']) return;
    el['field-namespace'].innerHTML = (currentModel?.namespaces || []).map(ns => 
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
        div.className = `modeler-node ${currentSelection.id === id ? 'selected' : ''}`;
        div.innerHTML = `<span class="node-icon">${icon}</span> <span class="node-label" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${name}</span>`;
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

    section('Namespaces', currentModel.namespaces, 'namespace', '🌐');
    section('Object Types', currentModel.objectTypes, 'objectType', '📃');
    section('Instances', currentModel.instances, 'instance', '📦');
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
    
    document.querySelectorAll('.modeler-node').forEach(n => n.classList.remove('selected'));
    renderRegistry();
    
    el['modeler-edit-displayname'].value = ref.displayName || '';
    el['modeler-edit-id'].textContent = id;
    el['field-isa-level'].value = ref.isaLevel || 'Equipment';
    el['field-namespace'].value = ref.namespaceUri || (type === 'namespace' ? ref.uri : '');

    renderSchemaItems();
    renderRelationships();
    
    setTimeout(() => { drawGraph(); }, 100);
}

function renderSchemaItems() {
    el['container-properties'].innerHTML = '';
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
    const types = ['string', 'number', 'boolean', 'integer', 'object', 'array'];
    const options = types.map(t => `<option value="${t}" ${data.type === t ? 'selected' : ''}>${t}</option>`).join('');
    row.innerHTML = `
        <input type="text" placeholder="ID" class="modern-input" style="flex:2; font-family:monospace;" value="${data.id || ''}" data-key="id">
        <input type="text" placeholder="Label" class="modern-input" style="flex:3;" value="${data.title || ''}" data-key="title">
        <select class="modern-input" style="flex:2;" data-key="type">${options}</select>
        <input type="text" placeholder="Unit (Opt.)" class="modern-input" style="flex:1.5;" value="${data.unit || ''}" data-key="unit" title="Unit of measurement">
        <button class="btn-delete-row">✖</button>
    `;
    row.querySelectorAll('input, select').forEach(i => i.oninput = syncStateFromForm);
    row.querySelector('.btn-delete-row').onclick = () => { row.remove(); syncStateFromForm(); };
    container.appendChild(row);
}

// --- i3X Relationships Logic ---

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
    
    // i3X standard relationship types
    const types = ['HasParent', 'HasChildren', 'HasComponent', 'ComponentOf', 'InstanceOf', 'SuppliesTo', 'SuppliesFrom'];
    const typeOptions = types.map(t => `<option value="${t}" ${data.type === t ? 'selected' : ''}>${t}</option>`).join('');
    
    // Available targets (all other instances)
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
    ref.isaLevel = el['field-isa-level'].value;
    ref.namespaceUri = el['field-namespace'].value;

    // Sync Schema
    const properties = {};
    const rows = [...el['container-properties'].children];
    rows.forEach(row => {
        const id = row.querySelector('[data-key="id"]').value.trim();
        if (!id) return;
        const item = { title: row.querySelector('[data-key="title"]').value, type: row.querySelector('[data-key="type"]').value };
        const unitEl = row.querySelector('[data-key="unit"]');
        if (unitEl && unitEl.value) item.unit = unitEl.value;
        properties[id] = item;
    });
    ref.schema = { type: "object", properties };

    // Update node label without breaking layout
    if (networkGraph) {
        let icon = '📦';
        if (currentSelection.type === 'namespace') icon = '🌐';
        if (currentSelection.type === 'objectType') icon = '📃';
        try {
            networkGraph.body.data.nodes.update({ id: 'self', label: `${icon} ${ref.displayName || ref.elementId || ref.uri}` });
        } catch(e) {}
    }

    renderRegistry(); // Updates left panel highlighting immediately
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
    }
    editMode = mode;
    el['btn-mode-form'].classList.toggle('active', mode === 'form');
    el['btn-mode-json'].classList.toggle('active', mode === 'json');
    el['modeler-form-view'].style.display = mode === 'form' ? 'block' : 'none';
    el['modeler-json-view'].style.display = mode === 'json' ? 'block' : 'none';
    if (mode === 'json') { initAce(); updateAce(); }
}

function initAce() {
    if (aceEditor) return;
    aceEditor = ace.edit(el['modeler-ace-editor']);
    aceEditor.setTheme(state.isDarkMode ? "ace/theme/tomorrow_night" : "ace/theme/chrome");
    aceEditor.session.setMode("ace/mode/json");
}

function updateAce() { if (aceEditor) aceEditor.setValue(JSON.stringify(currentSelection.ref, null, 2), -1); }

// --- Graph ---

function drawGraph() {
    const graphDiv = el['relationship-graph'];
    if (!window.vis || !graphDiv) return;

    // Ensure container has height
    if (graphDiv.clientHeight === 0) {
        graphDiv.style.minHeight = '300px';
    }

    const item = currentSelection.ref;
    if (!item) return;

    const isDark = state.isDarkMode;
    const nodesData = [{ id: 'self', label: item.displayName || 'Selected', shape: 'box', color: '#007bff', font: { color: '#fff', size: 14 }, margin: 10 }];
    const edgesData = [];

    const addNode = (id, label, icon, group) => {
        if (!nodesData.find(n => n.id === id)) {
            let color = isDark ? '#333' : '#eee';
            let fontColor = isDark ? '#fff' : '#333';
            if (group === 'self') { color = '#007bff'; fontColor = '#fff'; }
            if (group === 'type') { color = '#28a745'; fontColor = '#fff'; }
            if (group === 'ns') { color = '#3b82f6'; fontColor = '#fff'; }
            nodesData.push({ id, label: `${icon} ${label}`, shape: 'box', color: color, font: { color: fontColor, size: 14 }, margin: 10 });
        }
    };

    if (item.namespaceUri) {
        addNode('ns', item.namespaceUri.split('/').pop(), '🌐', 'ns');
        edgesData.push({ from: 'self', to: 'ns', label: 'belongs to', arrows: 'to', dashes: true });
    }

    if (item.relationships) {
        Object.entries(item.relationships).forEach(([rel, targets]) => {
            const list = Array.isArray(targets) ? targets : [targets];
            list.forEach(tId => {
                const tObj = currentModel.instances.find(i => i.elementId === tId);
                const label = tObj ? (tObj.displayName || tId) : tId;
                addNode(`rel-${tId}`, label, '📦', 'inst');
                edgesData.push({ from: 'self', to: `rel-${tId}`, label: rel, arrows: 'to' });
            });
        });
    }

    const data = { nodes: new vis.DataSet(nodesData), edges: new vis.DataSet(edgesData) };
    const options = {
        physics: { 
            enabled: isPhysicsEnabled, 
            solver: 'barnesHut', 
            barnesHut: { gravitationalConstant: -2000, centralGravity: 0.3, springLength: 100 } 
        },
        interaction: { hover: true, zoomView: true, dragView: true, dragNodes: true }
    };

    if (!networkGraph) {
        networkGraph = new vis.Network(graphDiv, data, options);
    } else {
        networkGraph.setOptions(options);
        networkGraph.setData(data);
    }
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
    }
    el['btn-modeler-save'].disabled = true;
    try {
        const res = await fetch('api/env/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentModel) });
        if (!res.ok) throw new Error();
        showToast("Model saved", "success");
        el['btn-modeler-save'].classList.remove('btn-unsaved');
    } catch (e) { showToast("Save error", "error"); }
    finally { el['btn-modeler-save'].disabled = false; }
}