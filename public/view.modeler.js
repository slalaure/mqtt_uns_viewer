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
 * Provides a GUI to edit the uns_model.json according to I3X specification.
 */

import { confirmModal, trackEvent } from './utils.js';

// --- State ---
let currentModel = null;
let currentSelection = { type: null, id: null }; // type: 'namespace' | 'type' | 'instance'
let isModelerInitialized = false;

// --- DOM Elements ---
let listNamespaces, listTypes, listInstances;
let btnRefresh, btnSave, statusMsg;
let formContainer, welcomeScreen, formTitle, dynamicFields, btnDelete;
let btnAddNamespace, btnAddType, btnAddInstance;

export async function initModelerView() {
    const container = document.getElementById('modeler-view');
    if (!container) return;
    if (isModelerInitialized) return;

    try {
        const response = await fetch('html/view.modeler.html');
        if (!response.ok) throw new Error('Failed to load modeler template');
        container.innerHTML = await response.text();

        // Bind DOM elements
        listNamespaces = document.getElementById('modeler-list-namespaces');
        listTypes = document.getElementById('modeler-list-types');
        listInstances = document.getElementById('modeler-list-instances');
        
        btnRefresh = document.getElementById('btn-modeler-refresh');
        btnSave = document.getElementById('btn-modeler-save');
        statusMsg = document.getElementById('modeler-status');
        
        formContainer = document.getElementById('modeler-form');
        welcomeScreen = document.getElementById('modeler-welcome');
        formTitle = document.getElementById('modeler-form-title');
        dynamicFields = document.getElementById('modeler-dynamic-fields');
        btnDelete = document.getElementById('btn-modeler-delete');

        btnAddNamespace = document.getElementById('btn-modeler-add-namespace');
        btnAddType = document.getElementById('btn-modeler-add-type');
        btnAddInstance = document.getElementById('btn-modeler-add-instance');

        // Event Listeners
        btnRefresh.addEventListener('click', loadModel);
        btnSave.addEventListener('click', saveModelToServer);
        
        btnAddNamespace.addEventListener('click', () => createNewItem('namespace'));
        btnAddType.addEventListener('click', () => createNewItem('type'));
        btnAddInstance.addEventListener('click', () => createNewItem('instance'));

        formContainer.addEventListener('submit', handleFormSubmit);
        btnDelete.addEventListener('click', handleDeleteItem);

        isModelerInitialized = true;
        console.log("✅ Semantic Modeler View Initialized");

    } catch (err) {
        console.error("Error initializing Modeler View:", err);
        container.innerHTML = `<div style="padding:20px; color:var(--color-danger);">Error loading Modeler Interface. Check console.</div>`;
    }
}

export function onModelerViewShow() {
    if (isModelerInitialized) {
        loadModel();
    }
}

/**
 * Shows a temporary status message in the sidebar
 */
function showStatus(message, isError = false) {
    statusMsg.textContent = message;
    statusMsg.style.color = isError ? 'var(--color-danger)' : 'var(--color-success)';
    setTimeout(() => statusMsg.textContent = '', 4000);
}

/**
 * Loads the current semantic model from the server.
 */
async function loadModel() {
    try {
        const res = await fetch('api/env/model');
        if (!res.ok) throw new Error("Failed to load model from server");
        currentModel = await res.json();

        // Ensure baseline I3X structure exists
        currentModel.namespaces = currentModel.namespaces || [];
        currentModel.objectTypes = currentModel.objectTypes || [];
        currentModel.instances = currentModel.instances || [];

        renderLists();
        clearEditor();
    } catch (e) {
        console.error(e);
        showStatus(e.message, true);
    }
}

/**
 * Renders the lists in the left sidebar.
 */
function renderLists() {
    const renderItems = (items, ulElement, typeStr, idField, displayField) => {
        ulElement.innerHTML = '';
        if (!items || items.length === 0) {
            ulElement.innerHTML = `<li style="cursor:default; opacity:0.6; background:transparent; border:none;">No items</li>`;
            return;
        }
        items.forEach((item, index) => {
            const li = document.createElement('li');
            li.textContent = item[displayField] || item[idField] || `Unnamed ${typeStr}`;
            li.title = item[idField];
            if (currentSelection.type === typeStr && currentSelection.id === item[idField]) {
                li.classList.add('selected');
            }
            li.onclick = () => selectItem(typeStr, item[idField], index);
            ulElement.appendChild(li);
        });
    };

    renderItems(currentModel.namespaces, listNamespaces, 'namespace', 'uri', 'displayName');
    renderItems(currentModel.objectTypes, listTypes, 'type', 'elementId', 'displayName');
    renderItems(currentModel.instances, listInstances, 'instance', 'elementId', 'displayName');
}

/**
 * Selects an item and populates the editor form.
 */
function selectItem(type, id, index) {
    currentSelection = { type, id, index };
    renderLists(); // Update highlights
    
    let itemData = null;
    if (type === 'namespace') itemData = currentModel.namespaces[index];
    if (type === 'type') itemData = currentModel.objectTypes[index];
    if (type === 'instance') itemData = currentModel.instances[index];

    if (!itemData) return;

    welcomeScreen.style.display = 'none';
    formContainer.style.display = 'block';
    btnDelete.style.display = 'block';
    formTitle.textContent = `Edit ${type.charAt(0).toUpperCase() + type.slice(1)}`;

    dynamicFields.innerHTML = '';

    // Generate fields based on type
    if (type === 'namespace') {
        dynamicFields.innerHTML = `
            <div class="form-group"><label>URI</label><input type="text" name="uri" value="${itemData.uri || ''}" required></div>
            <div class="form-group"><label>Display Name</label><input type="text" name="displayName" value="${itemData.displayName || ''}" required></div>
        `;
    } else if (type === 'type') {
        dynamicFields.innerHTML = `
            <div class="form-group"><label>Element ID</label><input type="text" name="elementId" value="${itemData.elementId || ''}" required></div>
            <div class="form-group"><label>Display Name</label><input type="text" name="displayName" value="${itemData.displayName || ''}" required></div>
            <div class="form-group"><label>Namespace URI</label><input type="text" name="namespaceUri" value="${itemData.namespaceUri || ''}" required></div>
            <div class="form-group"><label>Schema (JSON)</label><textarea name="schema" rows="6" style="font-family:monospace; width:100%;">${itemData.schema ? JSON.stringify(itemData.schema, null, 2) : '{}'}</textarea></div>
        `;
    } else if (type === 'instance') {
        const typeOptions = (currentModel.objectTypes || []).map(t => `<option value="${t.elementId}" ${itemData.typeId === t.elementId ? 'selected' : ''}>${t.displayName} (${t.elementId})</option>`).join('');
        const parentOptions = `<option value="">-- None (Root) --</option>` + (currentModel.instances || [])
            .filter(i => i.elementId !== itemData.elementId) // Can't be own parent
            .map(i => `<option value="${i.elementId}" ${itemData.parentId === i.elementId ? 'selected' : ''}>${i.displayName}</option>`).join('');

        dynamicFields.innerHTML = `
            <div class="form-group"><label>Element ID</label><input type="text" name="elementId" value="${itemData.elementId || ''}" required></div>
            <div class="form-group"><label>Display Name</label><input type="text" name="displayName" value="${itemData.displayName || ''}" required></div>
            <div class="form-group"><label>Type</label><select name="typeId" required>${typeOptions}</select></div>
            <div class="form-group"><label>Parent Instance</label><select name="parentId">${parentOptions}</select></div>
            <div class="form-group" style="display:flex; align-items:center; gap:10px;">
                <input type="checkbox" name="isComposition" id="chk-comp" ${itemData.isComposition ? 'checked' : ''}>
                <label for="chk-comp" style="margin:0; cursor:pointer;">Is Composition (Contains inner components)</label>
            </div>
            <div class="form-group" style="margin-top: 15px; padding-top: 15px; border-top: 1px dashed var(--color-border);">
                <label style="color:var(--color-primary);">MQTT Topic Mapping Pattern (Optional)</label>
                <div style="font-size:0.8em; color:var(--color-text-secondary); margin-bottom:5px;">Link this I3X object to a real MQTT topic (supports + and # wildcards)</div>
                <input type="text" name="topic_mapping" value="${itemData.topic_mapping || ''}" placeholder="e.g. factory/line1/machineA/#">
            </div>
        `;
    }
}

/**
 * Handles creation of a new item (adds to array and opens editor)
 */
function createNewItem(type) {
    const newItem = {};
    if (type === 'namespace') {
        newItem.uri = `https://my-company.com/${Date.now()}`;
        newItem.displayName = "New Namespace";
        currentModel.namespaces.push(newItem);
        selectItem(type, newItem.uri, currentModel.namespaces.length - 1);
    } else if (type === 'type') {
        newItem.elementId = `NewType_${Date.now()}`;
        newItem.displayName = "New Object Type";
        newItem.namespaceUri = currentModel.namespaces[0]?.uri || "";
        newItem.schema = { type: "object" };
        currentModel.objectTypes.push(newItem);
        selectItem(type, newItem.elementId, currentModel.objectTypes.length - 1);
    } else if (type === 'instance') {
        newItem.elementId = `instance_${Date.now()}`;
        newItem.displayName = "New Instance";
        newItem.typeId = currentModel.objectTypes[0]?.elementId || "";
        newItem.isComposition = false;
        currentModel.instances.push(newItem);
        selectItem(type, newItem.elementId, currentModel.instances.length - 1);
    }
    
    // Auto-save is NOT triggered here, user must click Apply
    btnSave.classList.add('btn-unsaved');
}

/**
 * Handles Apply Changes button inside the form
 */
function handleFormSubmit(e) {
    e.preventDefault();
    if (!currentSelection.type) return;

    const formData = new FormData(e.target);
    const { type, index } = currentSelection;
    let targetArray = null;

    if (type === 'namespace') targetArray = currentModel.namespaces;
    if (type === 'type') targetArray = currentModel.objectTypes;
    if (type === 'instance') targetArray = currentModel.instances;

    if (!targetArray || !targetArray[index]) return;

    // Apply values
    for (let [key, value] of formData.entries()) {
        if (key === 'schema') {
            try { value = JSON.parse(value); } catch(err) { alert("Invalid JSON in Schema"); return; }
        }
        if (key === 'isComposition') value = true; // Checkbox presence means true
        
        if (value === "") delete targetArray[index][key]; // Clean up empty optional fields
        else targetArray[index][key] = value;
    }

    // Fix unchecked checkbox edge case for FormData
    if (type === 'instance' && !formData.has('isComposition')) {
        targetArray[index].isComposition = false;
    }

    renderLists();
    showStatus("Changes applied locally. Remember to Save to Server.", false);
    btnSave.classList.add('btn-unsaved');
}

/**
 * Deletes the currently selected item
 */
async function handleDeleteItem() {
    const isConfirmed = await confirmModal('Delete Item', 'Are you sure you want to remove this item from the model?', 'Delete', true);
    if (!isConfirmed) return;

    const { type, index } = currentSelection;
    if (type === 'namespace') currentModel.namespaces.splice(index, 1);
    if (type === 'type') currentModel.objectTypes.splice(index, 1);
    if (type === 'instance') currentModel.instances.splice(index, 1);

    btnSave.classList.add('btn-unsaved');
    clearEditor();
    renderLists();
}

/**
 * Clears the editor panel
 */
function clearEditor() {
    currentSelection = { type: null, id: null };
    welcomeScreen.style.display = 'flex';
    formContainer.style.display = 'none';
}

/**
 * Pushes the modified model back to the server
 */
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
        showStatus("✅ Model successfully deployed to server.");
        
        // Notify the application to reconstruct trees
        if (window.appCallbacks && window.appCallbacks.refreshSemanticTrees) {
            window.appCallbacks.refreshSemanticTrees();
        }

    } catch (e) {
        showStatus(`❌ ${e.message}`, true);
    } finally {
        btnSave.disabled = false;
        btnSave.textContent = "💾 Save";
    }
}