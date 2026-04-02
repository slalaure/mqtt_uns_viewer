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
 * Semantic Modeler View Module
 * Provides an advanced, dynamic GUI to explore and edit the uns_model.json
 * according to I3X specifications. 
 * Integrates vis-network for interactive Relationship Graphs.
 * [UPDATED] Implemented View Lifecycle Teardown (mount/unmount) to prevent memory leaks.
 */

import { confirmModal, trackEvent, makeResizable, showToast } from './utils.js';

// --- State ---
let currentModel = null;
let currentSelection = { type: null, id: null, ref: null }; 
let isModelerInitialized = false;
let isMounted = false; // Lifecycle flag
let expandedNodes = new Set(); 
let networkGraph = null; 

// --- DOM Elements ---
let treeContainer, graphContainer, btnRefresh, btnSave, statusMsg;
let formContainer, welcomeScreen, mainContent, formTitle, formSubtitle, dynamicFields, btnDelete;
let btnAddNamespace, btnAddType, btnAddInstance;

/**
 * Robust loader for vis-network with CDN fallback.
 */
function loadVisNetwork() {
    return new Promise((resolve) => {
        if (window.vis) return resolve();
        const loadScript = (src) => {
            return new Promise((res) => {
                const script = document.createElement('script');
                script.type = 'text/javascript';
                script.src = src;
                script.onload = () => res(true);
                script.onerror = () => res(false);
                document.head.appendChild(script);
            });
        };
        const basePath = document.querySelector('base')?.getAttribute('href') || '/';
        const localPath = basePath + 'libs/vis-network.min.js';
        const cdnPath = 'https://unpkg.com/vis-network/standalone/umd/vis-network.min.js';

        loadScript(localPath).then(success => {
            if (success) {
                console.log("✅ vis-network library loaded from local libs.");
                resolve();
            } else {
                console.warn("⚠️ Failed to load local vis-network.min.js. Trying CDN fallback...");
                loadScript(cdnPath).then(cdnSuccess => {
                    if (cdnSuccess) {
                        console.log("✅ vis-network library loaded from CDN.");
                    } else {
                        console.error("❌ Failed to load vis-network from both local and CDN.");
                    }
                    resolve();
                });
            }
        });
    });
}

/**
 * Initializes the Modeler View DOM elements (Called once).
 */
export async function initModelerView() {
    const container = document.getElementById('modeler-view');
    if (!container || isModelerInitialized) return;

    try {
        const response = await fetch('html/view.modeler.html');
        if (!response.ok) throw new Error('Failed to load modeler template');
        container.innerHTML = await response.text();

        // Bind DOM elements
        treeContainer = document.getElementById('modeler-tree-container');
        graphContainer = document.getElementById('relationship-graph');
        btnRefresh = document.getElementById('btn-modeler-refresh');
        btnSave = document.getElementById('btn-modeler-save');
        statusMsg = document.getElementById('modeler-status');
        welcomeScreen = document.getElementById('modeler-welcome');
        mainContent = document.getElementById('modeler-content');
        formContainer = document.getElementById('modeler-form');
        formTitle = document.getElementById('modeler-form-title');
        formSubtitle = document.getElementById('modeler-form-subtitle');
        dynamicFields = document.getElementById('modeler-dynamic-fields');
        btnDelete = document.getElementById('btn-modeler-delete');
        btnAddNamespace = document.getElementById('btn-add-namespace');
        btnAddType = document.getElementById('btn-add-type');
        btnAddInstance = document.getElementById('btn-add-instance');

        // Initialize Resizers
        makeResizable({
            resizerEl: document.getElementById('drag-handle-vertical-modeler'),
            direction: 'vertical',
            panelA: document.querySelector('.modeler-sidebar')
        });

        makeResizable({
            resizerEl: document.getElementById('drag-handle-horizontal-modeler'),
            direction: 'horizontal',
            panelA: document.getElementById('modeler-graph-wrapper'),
            containerEl: document.getElementById('modeler-content')
        });

        await loadVisNetwork();

        isModelerInitialized = true;
        console.log("✅ Semantic Modeler V3 (Vis-Network) Initialized");
    } catch (err) {
        console.error("Error initializing Modeler View:", err);
        container.innerHTML = `<div style="padding:20px; color:var(--color-danger);">Error loading Modeler Interface. Check console.</div>`;
    }
}

// --- Named Event Handlers ---
const onAddNamespace = () => createNewItem('namespace');
const onAddType = () => createNewItem('objectType');
const onAddInstance = () => createNewItem('instance');
const onWindowResize = () => { if (networkGraph) networkGraph.fit(); };

/**
 * Mounts the view (attaches event listeners, loads data).
 */
export function mountModelerView() {
    if (isMounted || !isModelerInitialized) return;

    btnRefresh?.addEventListener('click', loadModel);
    btnSave?.addEventListener('click', saveModelToServer);
    btnAddNamespace?.addEventListener('click', onAddNamespace);
    btnAddType?.addEventListener('click', onAddType);
    btnAddInstance?.addEventListener('click', onAddInstance);
    formContainer?.addEventListener('submit', handleFormSubmit);
    btnDelete?.addEventListener('click', handleDeleteItem);
    window.addEventListener('resize', onWindowResize);

    loadModel();
    isMounted = true;
    console.log("[Modeler View] Mounted.");
}

/**
 * Legacy wrapper for router compatibility.
 */
export function onModelerViewShow() {
    mountModelerView();
}

/**
 * Unmounts the view (removes listeners, destroys vis-network).
 */
export function unmountModelerView() {
    if (!isMounted) return;

    // Clean up vis-network instance
    if (networkGraph) {
        networkGraph.destroy();
        networkGraph = null;
    }

    btnRefresh?.removeEventListener('click', loadModel);
    btnSave?.removeEventListener('click', saveModelToServer);
    btnAddNamespace?.removeEventListener('click', onAddNamespace);
    btnAddType?.removeEventListener('click', onAddType);
    btnAddInstance?.removeEventListener('click', onAddInstance);
    formContainer?.removeEventListener('submit', handleFormSubmit);
    btnDelete?.removeEventListener('click', handleDeleteItem);
    window.removeEventListener('resize', onWindowResize);

    isMounted = false;
    console.log("[Modeler View] Unmounted & Cleaned up.");
}

// --- 1. Model Loading & Tree Building ---
async function loadModel() {
    try {
        const res = await fetch('api/env/model');
        if (!res.ok) throw new Error("Failed to load model from server");
        currentModel = await res.json();
        currentModel.namespaces = currentModel.namespaces || [];
        currentModel.objectTypes = currentModel.objectTypes || [];
        currentModel.instances = currentModel.instances || [];
        renderTree();
        if (currentSelection.id) {
            selectItem(currentSelection.type, currentSelection.id);
        } else {
            clearEditor();
        }
    } catch (e) {
        showToast(e.message, 'error');
    }
}

function renderTree() {
    if (!treeContainer) return;
    treeContainer.innerHTML = '';
    const rootUl = document.createElement('ul');
    rootUl.className = 'modeler-tree';

    const typesByNamespace = new Map();
    const instancesByType = new Map();
    const instancesByParent = new Map();

    currentModel.objectTypes.forEach(t => {
        if (!typesByNamespace.has(t.namespaceUri)) typesByNamespace.set(t.namespaceUri, []);
        typesByNamespace.get(t.namespaceUri).push(t);
    });

    currentModel.instances.forEach(inst => {
        if (!instancesByType.has(inst.typeId)) instancesByType.set(inst.typeId, []);
        instancesByType.get(inst.typeId).push(inst);
        const pid = (inst.parentId === '/' || !inst.parentId) ? 'root' : inst.parentId;
        if (!instancesByParent.has(pid)) instancesByParent.set(pid, []);
        instancesByParent.get(pid).push(inst);
    });

    const buildInstanceNode = (inst) => {
        const li = document.createElement('li');
        const children = instancesByParent.get(inst.elementId) || [];
        const hasChildren = children.length > 0 || inst.isComposition;
        const isExp = expandedNodes.has(inst.elementId);
        const toggleClass = isExp ? '' : 'collapsed';
        const toggleIcon = hasChildren ? '▼' : '&nbsp;';

        const nodeDiv = document.createElement('div');
        nodeDiv.className = `modeler-node ${currentSelection.id === inst.elementId ? 'selected' : ''}`;
        nodeDiv.innerHTML = `
            <span class="node-toggle ${toggleClass}">${toggleIcon}</span>
            <span class="node-icon" style="color: #64748b;">📦</span>
            <span class="node-label">${inst.displayName || inst.elementId}</span>
        `;

        nodeDiv.onclick = (e) => {
            if (e.target.classList.contains('node-toggle') && hasChildren) {
                const ul = li.querySelector(':scope > ul');
                if (ul) {
                    ul.classList.toggle('collapsed');
                    e.target.classList.toggle('collapsed');
                    if (ul.classList.contains('collapsed')) expandedNodes.delete(inst.elementId);
                    else expandedNodes.add(inst.elementId);
                }
                return;
            }
            selectItem('instance', inst.elementId);
        };

        li.appendChild(nodeDiv);
        if (hasChildren) {
            const ul = document.createElement('ul');
            ul.className = toggleClass;
            children.forEach(child => ul.appendChild(buildInstanceNode(child)));
            li.appendChild(ul);
        }
        return li;
    };

    currentModel.namespaces.forEach(ns => {
        const nsLi = document.createElement('li');
        const types = typesByNamespace.get(ns.uri) || [];
        const isExp = expandedNodes.has(ns.uri);
        const nodeDiv = document.createElement('div');
        nodeDiv.className = `modeler-node ${currentSelection.id === ns.uri ? 'selected' : ''}`;
        nodeDiv.innerHTML = `
            <span class="node-toggle ${isExp ? '' : 'collapsed'}">${types.length > 0 ? '▼' : '&nbsp;'}</span>
            <span class="node-icon" style="color: #3b82f6;">🌐</span>
            <span class="node-label">${ns.displayName}</span>
        `;

        nodeDiv.onclick = (e) => {
            if (e.target.classList.contains('node-toggle') && types.length > 0) {
                const ul = nsLi.querySelector(':scope > ul');
                if (ul) {
                    ul.classList.toggle('collapsed');
                    e.target.classList.toggle('collapsed');
                    if (ul.classList.contains('collapsed')) expandedNodes.delete(ns.uri);
                    else expandedNodes.add(ns.uri);
                }
                return;
            }
            selectItem('namespace', ns.uri);
        };
        nsLi.appendChild(nodeDiv);

        if (types.length > 0) {
            const typeUl = document.createElement('ul');
            typeUl.className = isExp ? '' : 'collapsed';
            types.forEach(t => {
                const tLi = document.createElement('li');
                const rootInstancesOfType = (instancesByType.get(t.elementId) || []).filter(i => i.parentId === '/' || !i.parentId);
                const isTExp = expandedNodes.has(t.elementId);
                const tDiv = document.createElement('div');
                tDiv.className = `modeler-node ${currentSelection.id === t.elementId ? 'selected' : ''}`;
                tDiv.innerHTML = `
                    <span class="node-toggle ${isTExp ? '' : 'collapsed'}">${rootInstancesOfType.length > 0 ? '▼' : '&nbsp;'}</span>
                    <span class="node-icon" style="color: #22c55e;">📃</span>
                    <span class="node-label">${t.displayName}</span>
                `;
                tDiv.onclick = (e) => {
                    if (e.target.classList.contains('node-toggle') && rootInstancesOfType.length > 0) {
                        const ul = tLi.querySelector(':scope > ul');
                        if (ul) {
                            ul.classList.toggle('collapsed');
                            e.target.classList.toggle('collapsed');
                            if (ul.classList.contains('collapsed')) expandedNodes.delete(t.elementId);
                            else expandedNodes.add(t.elementId);
                        }
                        return;
                    }
                    selectItem('objectType', t.elementId);
                };
                tLi.appendChild(tDiv);
                if (rootInstancesOfType.length > 0) {
                    const instUl = document.createElement('ul');
                    instUl.className = isTExp ? '' : 'collapsed';
                    rootInstancesOfType.forEach(inst => instUl.appendChild(buildInstanceNode(inst)));
                    tLi.appendChild(instUl);
                }
                typeUl.appendChild(tLi);
            });
            nsLi.appendChild(typeUl);
        }
        rootUl.appendChild(nsLi);
    });
    treeContainer.appendChild(rootUl);
}

// --- 2. Selection & Graph Drawing ---
function selectItem(type, id) {
    let ref = null;
    if (type === 'namespace') ref = currentModel.namespaces.find(n => n.uri === id);
    if (type === 'objectType') ref = currentModel.objectTypes.find(t => t.elementId === id);
    if (type === 'instance') ref = currentModel.instances.find(i => i.elementId === id);
    if (!ref) {
        clearEditor();
        return;
    }
    currentSelection = { type, id, ref };
    document.querySelectorAll('.modeler-node').forEach(n => n.classList.remove('selected'));
    renderTree(); 
    welcomeScreen.style.display = 'none';
    mainContent.style.display = 'flex';
    
    setTimeout(() => {
        drawRelationshipGraph();
    }, 100);
    renderForm();
}

/**
 * Draws an interactive Relationship Graph using vis-network.
 */
function drawRelationshipGraph() {
    if (!window.vis || !graphContainer) return;
    const item = currentSelection.ref;
    if (!item) return;

    const isDark = document.body.classList.contains('dark-mode');
    const colors = {
        center:   { background: '#007bff', border: '#0056b3', font: '#ffffff' },
        instance: { background: isDark ? '#333333' : '#ffffff', border: '#6c757d', font: isDark ? '#ffffff' : '#333333' },
        type:     { background: isDark ? '#1a3b2b' : '#e6f4ea', border: '#28a745', font: isDark ? '#ffffff' : '#333333' },
        namespace:{ background: isDark ? '#1a2b4b' : '#e0f0ff', border: '#007bff', font: isDark ? '#ffffff' : '#333333' },
        flow:     { background: isDark ? '#3d2b1a' : '#fff3e0', border: '#e67e22', font: isDark ? '#ffffff' : '#333333' }
    };

    let nodesData = [];
    let edgesData = [];

    const addNode = (id, label, group, nodeType) => {
        if (!nodesData.find(n => n.id === id)) {
            let icon = '📦';
            if (nodeType === 'namespace') icon = '🌐';
            if (nodeType === 'objectType') icon = '📃';
            const style = (group === 'center') ? colors.center : (colors[group] || colors.instance);
            nodesData.push({
                id: id,
                label: `${icon} ${label.length > 20 ? label.substring(0, 18) + '...' : label}`,
                title: label, 
                color: style,
                shape: 'box',
                font: { color: style.font, face: 'system-ui, -apple-system, sans-serif' },
                nodeType: nodeType 
            });
        }
    };

    const addEdge = (from, to, label, type = 'hierarchy') => {
        const isFlow = label.toLowerCase().includes('suppl');
        edgesData.push({
            from: from,
            to: to,
            label: label,
            arrows: 'to',
            font: { 
                size: 10, 
                align: 'horizontal', 
                color: isFlow ? '#e67e22' : (isDark ? '#aaaaaa' : '#666666'),
                background: isDark ? '#1a1a1a' : '#f4f7f9'
            },
            color: { color: isFlow ? '#e67e22' : (isDark ? '#555555' : '#cccccc') },
            dashes: type === 'reference',
            width: isFlow ? 2 : 1
        });
    };

    const centerId = currentSelection.id;
    addNode(centerId, item.displayName || item.elementId || item.uri, 'center', currentSelection.type);

    if (currentSelection.type === 'instance') {
        // 1. Hierarchy: Parent
        if (item.parentId && item.parentId !== '/') {
            const parent = currentModel.instances.find(i => i.elementId === item.parentId);
            if (parent) {
                addNode(parent.elementId, parent.displayName || parent.elementId, 'instance', 'instance');
                addEdge(parent.elementId, centerId, 'HasParent');
            }
        }
        // 2. Type Definition
        if (item.typeId) {
            const typeRef = currentModel.objectTypes.find(t => t.elementId === item.typeId);
            if (typeRef) {
                addNode(typeRef.elementId, typeRef.displayName || typeRef.elementId, 'type', 'objectType');
                addEdge(centerId, typeRef.elementId, 'InstanceOf', 'reference');
            }
        }
        // 3. Hierarchy: Children
        const children = currentModel.instances.filter(i => i.parentId === item.elementId);
        children.forEach(c => {
            addNode(c.elementId, c.displayName || c.elementId, 'instance', 'instance');
            addEdge(centerId, c.elementId, 'HasChildren');
        });

        // 4. Graph Relationships
        if (item.relationships) {
            for (const [relType, targets] of Object.entries(item.relationships)) {
                // Skip hierarchical keys already handled
                if (['HasParent', 'HasChildren', 'HasComponent', 'ComponentOf'].includes(relType)) continue;
                
                const targetList = Array.isArray(targets) ? targets : [targets];
                targetList.forEach(targetId => {
                    const targetObj = currentModel.instances.find(inst => inst.elementId === targetId);
                    if (targetObj) {
                        addNode(targetObj.elementId, targetObj.displayName || targetObj.elementId, 'instance', 'instance');
                        addEdge(centerId, targetObj.elementId, relType);
                    }
                });
            }
        }
        
        // 5. Find incoming relationships (Reverse Lookup)
        currentModel.instances.forEach(other => {
            if (other.elementId === item.elementId || !other.relationships) return;
            for (const [relType, targets] of Object.entries(other.relationships)) {
                const targetList = Array.isArray(targets) ? targets : [targets];
                if (targetList.includes(item.elementId)) {
                    addNode(other.elementId, other.displayName || other.elementId, 'instance', 'instance');
                    addEdge(other.elementId, centerId, relType);
                }
            }
        });
    } 
    else if (currentSelection.type === 'objectType') {
        if (item.namespaceUri) {
            const ns = currentModel.namespaces.find(n => n.uri === item.namespaceUri);
            if (ns) {
                addNode(ns.uri, ns.displayName || ns.uri, 'namespace', 'namespace');
                addEdge(centerId, ns.uri, 'InNamespace', 'reference');
            }
        }
        const instances = currentModel.instances.filter(i => i.typeId === item.elementId).slice(0, 15);
        instances.forEach(c => {
            addNode(c.elementId, c.displayName || c.elementId, 'instance', 'instance');
            addEdge(c.elementId, centerId, 'InstanceOf', 'reference');
        });
    }
    else if (currentSelection.type === 'namespace') {
        const types = currentModel.objectTypes.filter(t => t.namespaceUri === item.uri).slice(0, 15);
        types.forEach(t => {
            addNode(t.elementId, t.displayName || t.elementId, 'type', 'objectType');
            addEdge(t.elementId, centerId, 'InNamespace', 'reference');
        });
    }

    const data = { 
        nodes: new vis.DataSet(nodesData), 
        edges: new vis.DataSet(edgesData) 
    };

    const options = {
        physics: {
            enabled: true,
            solver: 'forceAtlas2Based',
            forceAtlas2Based: {
                gravitationalConstant: -50,
                centralGravity: 0.01,
                springLength: 100,
                springConstant: 0.08,
                damping: 0.4,
                avoidOverlap: 0.5
            }
        },
        interaction: {
            dragNodes: true,
            dragView: true,
            zoomView: true,
            hover: true
        }
    };

    if (networkGraph) {
        networkGraph.destroy();
    }
    networkGraph = new vis.Network(graphContainer, data, options);
    networkGraph.on("click", function (params) {
        if (params.nodes.length > 0) {
            const clickedNodeId = params.nodes[0];
            const clickedNode = data.nodes.get(clickedNodeId);
            if (clickedNode && clickedNode.nodeType && clickedNodeId !== currentSelection.id) {
                selectItem(clickedNode.nodeType, clickedNodeId);
            }
        }
    });
}

// --- 3. Form Editor ---
function renderForm() {
    const { type, id, ref: itemData } = currentSelection;
    if (!itemData) return;

    formTitle.textContent = `Edit ${type.charAt(0).toUpperCase() + type.slice(1)}`;
    formSubtitle.textContent = id;
    dynamicFields.innerHTML = '';

    const createInput = (label, name, value, required = false, typeInput = 'text') => `
        <div>
            <label class="modern-label">${label} ${required ? '<span style="color:var(--color-danger)">*</span>' : ''}</label>
            <input type="${typeInput}" name="${name}" value="${value || ''}" class="modern-input" ${required ? 'required' : ''}>
        </div>
    `;

    if (type === 'namespace') {
        dynamicFields.innerHTML = `
            ${createInput('Namespace URI', 'uri', itemData.uri, true)}
            ${createInput('Display Name', 'displayName', itemData.displayName, true)}
        `;
    } else if (type === 'objectType') {
        const nsOptions = currentModel.namespaces.map(ns => 
            `<option value="${ns.uri}" ${itemData.namespaceUri === ns.uri ? 'selected' : ''}>${ns.displayName}</option>`
        ).join('');

        dynamicFields.innerHTML = `
            ${createInput('Element ID', 'elementId', itemData.elementId, true)}
            ${createInput('Display Name', 'displayName', itemData.displayName, true)}
            <div>
                <label class="modern-label">Namespace URI *</label>
                <select name="namespaceUri" class="modern-input" required>${nsOptions}</select>
            </div>
            <div>
                <label class="modern-label">JSON Schema</label>
                <textarea name="schema" class="modern-input" rows="6" style="font-family:monospace; resize:vertical;">${itemData.schema ? JSON.stringify(itemData.schema, null, 2) : '{}'}</textarea>
            </div>
        `;
    } else if (type === 'instance') {
        const typeOptions = currentModel.objectTypes.map(t => 
            `<option value="${t.elementId}" ${itemData.typeId === t.elementId ? 'selected' : ''}>${t.displayName} (${t.elementId})</option>`
        ).join('');

        const parentOptions = `<option value="/">-- Root Level --</option>` + currentModel.instances
            .filter(i => i.elementId !== itemData.elementId) 
            .map(i => `<option value="${i.elementId}" ${itemData.parentId === i.elementId ? 'selected' : ''}>${i.displayName}</option>`).join('');

        dynamicFields.innerHTML = `
            ${createInput('Element ID', 'elementId', itemData.elementId, true)}
            ${createInput('Display Name', 'displayName', itemData.displayName, true)}
            <div style="display:flex; gap: 15px;">
                <div style="flex:1;">
                    <label class="modern-label">Type Definition *</label>
                    <select name="typeId" class="modern-input" required>${typeOptions}</select>
                </div>
                <div style="flex:1;">
                    <label class="modern-label">Parent Instance</label>
                    <select name="parentId" class="modern-input">${parentOptions}</select>
                </div>
            </div>
            <div style="margin-top: 10px; display: flex; align-items: center; gap: 10px; background: var(--color-bg); padding: 10px; border-radius: 4px; border: 1px solid var(--color-border);">
                <input type="checkbox" name="isComposition" id="chk-comp" ${itemData.isComposition ? 'checked' : ''} style="width: 18px; height: 18px;">
                <label for="chk-comp" style="margin:0; cursor:pointer; font-weight: 500;">Is Composition (Contains nested components)</label>
            </div>
            <div style="margin-top: 20px; padding: 15px; background: var(--color-bg-tertiary); border-radius: 6px; border: 1px solid var(--color-border);">
                <label class="modern-label" style="color: var(--color-primary); margin-bottom: 10px; display: block;">Data Governance & Security</label>
                <div style="display:flex; gap: 15px;">
                    <div style="flex:1;">
                        <label class="modern-label">Sensitivity Level</label>
                        <select name="sensitivity" class="modern-input">
                            <option value="public" ${itemData.sensitivity === 'public' ? 'selected' : ''}>🟢 Public</option>
                            <option value="internal" ${(!itemData.sensitivity || itemData.sensitivity === 'internal') ? 'selected' : ''}>🟡 Internal</option>
                            <option value="confidential" ${itemData.sensitivity === 'confidential' ? 'selected' : ''}>🟠 Confidential</option>
                            <option value="secret" ${itemData.sensitivity === 'secret' ? 'selected' : ''}>🔴 Secret</option>
                        </select>
                    </div>
                    <div style="flex:1;">
                        <label class="modern-label">Privacy / Compliance</label>
                        <select name="privacy" class="modern-input">
                            <option value="none" ${(!itemData.privacy || itemData.privacy === 'none') ? 'selected' : ''}>None</option>
                            <option value="basic" ${itemData.privacy === 'basic' ? 'selected' : ''}>Basic Privacy</option>
                            <option value="gdpr" ${itemData.privacy === 'gdpr' ? 'selected' : ''}>⚖️ GDPR / PII</option>
                            <option value="health" ${itemData.privacy === 'health' ? 'selected' : ''}>🏥 Health Data (HDS/HIPAA)</option>
                            <option value="financial" ${itemData.privacy === 'financial' ? 'selected' : ''}>💰 Financial / PCI</option>
                            <option value="sensitive" ${itemData.privacy === 'sensitive' ? 'selected' : ''}>🛡️ Highly Sensitive (Religion/Opinions)</option>
                        </select>
                    </div>
                </div>
            </div>
            <div style="margin-top: 20px; padding-top: 15px; border-top: 1px dashed var(--color-border);">
                <label class="modern-label" style="color: var(--color-primary);">MQTT Topic Mapping Pattern</label>
                <div style="font-size:0.85em; color:var(--color-text-secondary); margin-bottom:8px;">Link this object to a raw MQTT topic stream to receive live data.</div>
                <input type="text" name="topic_mapping" class="modern-input" value="${itemData.topic_mapping || ''}" placeholder="e.g. factory/line1/machineA/#">
            </div>
            <div style="margin-top: 20px; padding-top: 15px; border-top: 1px dashed var(--color-border);">
                <label class="modern-label">Custom Graph Relationships (JSON Object)</label>
                <div style="font-size:0.85em; color:var(--color-text-secondary); margin-bottom:8px;">Define non-hierarchical links like 'SuppliesTo'. Format: {"RelType": "TargetId" or ["T1", "T2"]}</div>
                <textarea name="relationships" class="modern-input" rows="4" style="font-family:monospace; resize:vertical;">${itemData.relationships ? JSON.stringify(itemData.relationships, null, 2) : '{}'}</textarea>
            </div>
        `;
    }
}

function handleFormSubmit(e) {
    e.preventDefault();
    if (!currentSelection.type) return;
    const formData = new FormData(e.target);
    const { type, ref } = currentSelection;

    for (let [key, value] of formData.entries()) {
        if (key === 'schema' || key === 'relationships') {
            try { 
                value = JSON.parse(value); 
            } catch(err) { 
                showToast(`Invalid JSON in ${key}`, 'error'); 
                return; 
            }
        }
        if (key === 'isComposition') value = true;
        if (value === "" || (typeof value === 'object' && Object.keys(value).length === 0)) delete ref[key];
        else ref[key] = value;
    }

    if (type === 'instance' && !formData.has('isComposition')) {
        ref.isComposition = false;
    }
    if (type === 'instance' && ref.parentId === '/') {
        delete ref.parentId;
    }

    renderTree();
    drawRelationshipGraph(); 
    showToast("Changes applied locally. Remember to Save to Server.", 'info');
    btnSave.classList.add('btn-unsaved'); 
}

// --- 4. Creation, Deletion & Persistence ---
function createNewItem(type) {
    const newItem = {};
    if (type === 'namespace') {
        newItem.uri = `https://namespace.local/${Date.now()}`;
        newItem.displayName = "New Namespace";
        currentModel.namespaces.push(newItem);
        expandedNodes.add(newItem.uri);
        selectItem(type, newItem.uri);
    } else if (type === 'objectType') {
        newItem.elementId = `NewType_${Date.now()}`;
        newItem.displayName = "New Object Type";
        newItem.namespaceUri = currentModel.namespaces[0]?.uri || "";
        newItem.schema = { type: "object" };
        currentModel.objectTypes.push(newItem);
        expandedNodes.add(newItem.elementId);
        selectItem(type, newItem.elementId);
    } else if (type === 'instance') {
        newItem.elementId = `instance_${Date.now()}`;
        newItem.displayName = "New Instance";
        newItem.typeId = currentModel.objectTypes[0]?.elementId || "";
        newItem.isComposition = false;
        if (currentSelection.type === 'instance') {
            newItem.parentId = currentSelection.id;
            expandedNodes.add(currentSelection.id);
        }
        currentModel.instances.push(newItem);
        selectItem(type, newItem.elementId);
    }
    btnSave.classList.add('btn-unsaved');
}

async function handleDeleteItem() {
    const isConfirmed = await confirmModal('Delete Item', 'Are you sure you want to remove this item from the model?', 'Delete', true);
    if (!isConfirmed) return;

    const { type, id } = currentSelection;
    if (type === 'namespace') {
        currentModel.namespaces = currentModel.namespaces.filter(n => n.uri !== id);
    } else if (type === 'objectType') {
        currentModel.objectTypes = currentModel.objectTypes.filter(t => t.elementId !== id);
    } else if (type === 'instance') {
        currentModel.instances = currentModel.instances.filter(i => i.elementId !== id);
    }

    btnSave.classList.add('btn-unsaved');
    clearEditor();
    renderTree();
}

function clearEditor() {
    currentSelection = { type: null, id: null, ref: null };
    if (welcomeScreen) welcomeScreen.style.display = 'flex';
    if (mainContent) mainContent.style.display = 'none';
    document.querySelectorAll('.modeler-node').forEach(n => n.classList.remove('selected'));
    if (networkGraph) {
        networkGraph.destroy();
        networkGraph = null;
    }
}

async function saveModelToServer() {
    trackEvent('modeler_save_model');
    btnSave.disabled = true;
    btnSave.textContent = "Saving...";

    try {
        const response = await fetch('api/env/model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(currentModel)
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || "Save failed");
        }

        btnSave.classList.remove('btn-unsaved');
        showToast("Model deployed to server.", 'success');
        if (window.appCallbacks && window.appCallbacks.refreshSemanticTrees) {
            window.appCallbacks.refreshSemanticTrees();
        }
    } catch (e) {
        showToast(e.message, 'error');
    } finally {
        btnSave.disabled = false;
        btnSave.innerHTML = "💾 Save";
    }
}