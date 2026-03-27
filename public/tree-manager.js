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
 * Reusable Tree View Manager Module
 * Encapsulates all logic for creating, updating, and interacting with one tree.
 * [UPDATED] Added I3X Semantic Mode & Semantic Drag and Drop support.
 */

export function createTreeManager(rootElement, options = {}) {
    const { 
        treeId, 
        onNodeClick, 
        onCheckboxClick, 
        showCheckboxes = false, 
        allowFolderCollapse = true,
        isMultiBroker = false 
    } = options;

    const rootNode = rootElement;
    let nodeMap = new Map(); // Stores references to <li> elements by topic
    
    // --- [NEW] I3X Mode State ---
    let isI3xModeActive = false;
    let lastMqttEntries = []; // Cache to restore MQTT view when switching back

    /**
     * Creates or updates a node in this tree (MQTT Mode).
     */
    function update(brokerId, topic, payload, timestamp, updateOptions = {}) {
        // [NEW] Block live MQTT updates if we are currently viewing the I3X Semantic Model
        if (isI3xModeActive) return null;

        const { enableAnimations = false } = updateOptions;

        // Safety check for brokerId
        const safeBrokerId = brokerId || 'default';
        const displayTopic = isMultiBroker ? `${safeBrokerId}/${topic}` : topic;
        const parts = displayTopic.split('/');

        let currentTopicPath = '';
        let currentRealTopic = ''; 
        let currentUl = rootNode;
        const affectedNodes = [];

        // Format timestamp
        const dateObj = new Date(timestamp);
        const yyyy = dateObj.getFullYear();
        const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
        const dd = String(dateObj.getDate()).padStart(2, '0');
        const timeStr = dateObj.toLocaleTimeString('en-GB');
        const formattedTimestamp = `${yyyy}/${mm}/${dd} ${timeStr}`;

        let li; 

        for (let index = 0; index < parts.length; index++) {
            const part = parts[index];
            currentTopicPath += (index > 0 ? '/' : '') + part;

            // Reconstruct the real topic for data attributes
            if (isMultiBroker) {
                if (index > 0) {
                    currentRealTopic += (index > 1 ? '/' : '') + part;
                }
            } else {
                currentRealTopic += (index > 0 ? '/' : '') + part;
            }

            const isLastPart = index === parts.length - 1;
            const partId = `node-${treeId}-${currentTopicPath.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

            li = nodeMap.get(currentTopicPath); 

            // Filtering logic via Checkboxes
            if (li && showCheckboxes) {
                const checkbox = li.querySelector(':scope > .node-container > .node-filter-checkbox');
                if (checkbox && !checkbox.checked) {
                    return null; // Stop updating this branch
                }
            }

            let isNewNode = false;

            if (!li) {
                isNewNode = true;
                li = document.createElement('li');
                li.id = partId;
                if (enableAnimations) li.classList.add('new-node');

                const nodeContainer = document.createElement('div');
                nodeContainer.className = 'node-container';

                // --- [NEW] Enable Semantic Drag & Drop (MQTT Fallback) ---
                nodeContainer.draggable = true;
                nodeContainer.addEventListener('dragstart', (e) => {
                    const dragPayload = {
                        type: 'topic',
                        path: currentRealTopic,
                        brokerId: safeBrokerId
                    };
                    e.dataTransfer.setData('application/json', JSON.stringify(dragPayload));
                    e.dataTransfer.effectAllowed = 'copy';
                });

                let checkboxHtml = '';
                if (showCheckboxes) {
                    checkboxHtml = `<input type="checkbox" class="node-filter-checkbox" checked>`;
                }

                nodeContainer.innerHTML = `
                    ${checkboxHtml}
                    <span class="node-name">${part}</span>
                    <span class="node-timestamp"></span>
                `;

                const nodeSpecificTopic = (isMultiBroker && index === 0) ? '' : currentRealTopic;
                nodeContainer.dataset.brokerId = safeBrokerId;
                nodeContainer.dataset.topic = nodeSpecificTopic; 

                li.appendChild(nodeContainer);

                // --- Find parent <ul> and append ---
                const parentPathParts = parts.slice(0, index);
                const parentDisplayTopic = parentPathParts.join('/');
                const parentLi = nodeMap.get(parentDisplayTopic);
                let parentUl;

                if (parentLi) {
                    parentUl = parentLi.querySelector(':scope > ul');
                    if (!parentUl) {
                        parentUl = document.createElement('ul');
                        parentLi.appendChild(parentUl);
                    }
                } else {
                    parentUl = rootNode.querySelector(':scope > ul');
                    if (!parentUl) {
                        parentUl = document.createElement('ul');
                        rootNode.appendChild(parentUl);
                    }
                }

                parentUl.appendChild(li);
                nodeMap.set(currentTopicPath, li);

                if (onNodeClick) {
                    nodeContainer.addEventListener('click', (e) => onNodeClick(e, nodeContainer, safeBrokerId, nodeSpecificTopic));
                }
                if (showCheckboxes && onCheckboxClick) {
                     nodeContainer.querySelector('.node-filter-checkbox').addEventListener('click', (e) => onCheckboxClick(e, nodeContainer, safeBrokerId, nodeSpecificTopic));
                }
            }

            const nodeContainer = li.querySelector('.node-container');
            const timestampSpan = nodeContainer.querySelector('.node-timestamp');
            if (timestampSpan) timestampSpan.textContent = formattedTimestamp;

            affectedNodes.push({ element: li, isNew: isNewNode });
            nodeContainer.dataset.payload = payload;

            if (isLastPart) {
                li.classList.add('is-file');
                li.classList.remove('is-folder', 'collapsed');
            } else {
                li.classList.add('is-folder');
            }

            currentUl = li.querySelector('ul') || currentUl;
        }

        if (enableAnimations) {
            const disableAnimCheckbox = document.getElementById('disable-tree-animations');
            const isAnimDisabled = disableAnimCheckbox ? disableAnimCheckbox.checked : false;

            if (!isAnimDisabled) {
                const animationDelay = 150;
                const animationDuration = 1200;

                affectedNodes.forEach((nodeInfo, index) => {
                    setTimeout(() => {
                        if (nodeInfo.isNew) nodeInfo.element.classList.remove('new-node');
                        nodeInfo.element.classList.add('pulse');
                        setTimeout(() => nodeInfo.element.classList.remove('pulse'), animationDuration);
                    }, index * animationDelay);
                });
            } else {
                affectedNodes.forEach((nodeInfo) => {
                    if (nodeInfo.isNew) nodeInfo.element.classList.remove('new-node');
                });
            }
        }

        return li; 
    }

    /**
     * Wipes and rebuilds the tree from a list of topic entries (MQTT Mode).
     */
    function rebuild(entries) {
        // [NEW] Cache the raw MQTT state
        lastMqttEntries = entries;
        if (isI3xModeActive) return; // Do not rebuild MQTT tree if I3X mode is active

        console.log(`[tree-manager ${treeId}] Rebuilding tree with ${entries.length} topics...`); 

        const rootUl = rootNode.querySelector(':scope > ul');
        if (rootUl) {
            rootUl.innerHTML = '';
        }
        nodeMap.clear();

        const sortedEntries = entries.sort((a, b) => {
            const brokerA = a.broker_id || 'default';
            const brokerB = b.broker_id || 'default';
            const topicA = isMultiBroker ? `${brokerA}/${a.topic}` : a.topic;
            const topicB = isMultiBroker ? `${brokerB}/${b.topic}` : b.topic;
            return topicA.localeCompare(topicB);
        });

        let i = 0;
        for (const entry of sortedEntries) {
            i++;
            try {
                update(entry.broker_id, entry.topic, entry.payload, entry.timestamp, { enableAnimations: false });
            } catch (e) {
                console.error(`[tree-manager ${treeId}] Failed to update node for topic: ${entry.topic}`, e); 
            }
        }
        console.log(`[tree-manager ${treeId}] Rebuild complete. ${i} nodes processed.`); 
    }

    /**
     * --- [NEW] I3X Semantic Mode Logic ---
     * Fetches instances from the I3X API and builds a hierarchical tree based on `parentId`.
     */
    async function setI3xMode(mode) {
        isI3xModeActive = mode;
        if (mode) {
            const rootUl = rootNode.querySelector(':scope > ul');
            if (rootUl) rootUl.innerHTML = '<li style="padding: 10px; color: var(--color-text-secondary);">Loading Semantic Model...</li>';
            
            try {
                // Fetch I3X instance definitions (Metadata only)
                const res = await fetch('api/i3x/objects');
                if (!res.ok) throw new Error("Failed to fetch I3X objects");
                
                const objects = await res.json();
                buildI3xTree(objects);
            } catch (err) {
                console.error(`[tree-manager ${treeId}] I3X fetch error:`, err);
                if (rootUl) rootUl.innerHTML = `<li style="padding: 10px; color: var(--color-danger);">Error loading semantic model: ${err.message}</li>`;
            }
        } else {
            // Revert to MQTT
            rebuild(lastMqttEntries);
        }
    }

    function buildI3xTree(objects) {
        const rootUl = rootNode.querySelector(':scope > ul');
        if (!rootUl) return;
        rootUl.innerHTML = '';
        nodeMap.clear();

        const objMap = new Map();
        const childrenMap = new Map();

        // Map hierarchy
        objects.forEach(obj => {
            objMap.set(obj.elementId, obj);
            // In I3X, parentId can be '/' or null for root
            const parent = (obj.parentId === '/' || !obj.parentId) ? null : obj.parentId;
            if (!childrenMap.has(parent)) childrenMap.set(parent, []);
            childrenMap.get(parent).push(obj);
        });

        function createNode(obj) {
            const li = document.createElement('li');
            li.id = `node-${treeId}-i3x-${obj.elementId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
            li.classList.add(obj.isComposition ? 'is-folder' : 'is-file');
            
            // I3X Composition nodes (folders) are collapsed by default
            if (obj.isComposition) li.classList.add('collapsed');
            
            const nodeContainer = document.createElement('div');
            nodeContainer.className = 'node-container';
            
            // --- [NEW] Semantic Drag & Drop (I3X Mode) ---
            nodeContainer.draggable = true;
            nodeContainer.addEventListener('dragstart', (e) => {
                const dragPayload = {
                    type: 'element',
                    id: obj.elementId,
                    typeId: obj.typeId,
                    namespaceUri: obj.namespaceUri
                };
                e.dataTransfer.setData('application/json', JSON.stringify(dragPayload));
                e.dataTransfer.effectAllowed = 'copy';
            });

            let checkboxHtml = '';
            if (showCheckboxes) {
                checkboxHtml = `<input type="checkbox" class="node-filter-checkbox" checked>`;
            }

            nodeContainer.innerHTML = `
                ${checkboxHtml}
                <span class="node-name" title="Type: ${obj.typeId}">${obj.displayName}</span>
                <span class="node-timestamp" style="color:var(--color-primary); font-size:0.7em;">I3X</span>
            `;

            // Metadata for click handlers
            nodeContainer.dataset.elementId = obj.elementId;
            nodeContainer.dataset.typeId = obj.typeId;
            nodeContainer.dataset.isI3x = "true";

            li.appendChild(nodeContainer);
            nodeMap.set(obj.elementId, li);

            if (onNodeClick) {
                // We pass 'i3x' as brokerId fallback, and elementId as topic for legacy compat
                nodeContainer.addEventListener('click', (e) => onNodeClick(e, nodeContainer, 'i3x', obj.elementId));
            }
            if (showCheckboxes && onCheckboxClick) {
                nodeContainer.querySelector('.node-filter-checkbox').addEventListener('click', (e) => onCheckboxClick(e, nodeContainer, 'i3x', obj.elementId));
            }

            // Build children recursively
            const children = childrenMap.get(obj.elementId) || [];
            if (children.length > 0) {
                const childUl = document.createElement('ul');
                children.forEach(child => {
                    childUl.appendChild(createNode(child));
                });
                li.appendChild(childUl);
            }
            return li;
        }

        const rootObjects = childrenMap.get(null) || [];
        if (rootObjects.length === 0) {
            rootUl.innerHTML = '<li style="padding: 10px; color: var(--color-text-secondary);">No I3X objects found. Configure the model first.</li>';
            return;
        }

        rootObjects.forEach(obj => {
            rootUl.appendChild(createNode(obj));
        });
    }

    /**
     * Applies coloring logic to all nodes in this tree.
     */
    function colorTree(colorLogicFn) {
        rootNode.querySelectorAll('li > .node-container').forEach(nodeContainer => {
            const li = nodeContainer.closest('li');
            const brokerId = nodeContainer.dataset.brokerId;
            const topic = nodeContainer.dataset.topic;
            if (brokerId !== undefined && topic !== undefined) {
                 colorLogicFn(brokerId, topic, li);
            }
        });
    }

    function toggleAllFolders(collapse) {
        const rootUl = rootNode.querySelector(':scope > ul');
        if (!rootUl) return;
        rootUl.querySelectorAll('.is-folder').forEach(folderLi => {
            folderLi.classList.toggle('collapsed', collapse);
        });
    }

    function filterNode(node, filterText) {
        const nodeContainer = node.querySelector(':scope > .node-container');
        if (!nodeContainer) return false;

        const nodeName = nodeContainer.querySelector('.node-name').textContent.toLowerCase();
        const originalTopic = nodeContainer.dataset.topic?.toLowerCase() || '';
        const brokerId = nodeContainer.dataset.brokerId?.toLowerCase() || '';

        const isMatch = nodeName.includes(filterText) || 
                        originalTopic.includes(filterText) || 
                        (isMultiBroker && brokerId.includes(filterText));

        let hasVisibleChild = false;
        const children = node.querySelectorAll(':scope > ul > li');
        children.forEach(child => {
            if (filterNode(child, filterText)) {
                hasVisibleChild = true;
            }
        });

        if (isMatch || hasVisibleChild) {
            node.classList.remove('filtered-out');
            if (hasVisibleChild && filterText) {
                node.classList.remove('collapsed');
            }
            return true;
        } else {
            node.classList.add('filtered-out');
            return false;
        }
    }

    function applyFilter(filterText) {
        const rootUl = rootNode.querySelector(':scope > ul');
        if (!rootUl) return; 
        const allNodes = rootUl.querySelectorAll(':scope > li');
        allNodes.forEach(node => filterNode(node, filterText.toLowerCase()));
    }

    return {
        update,
        rebuild,
        setI3xMode, // [NEW] Exposed semantic switch function
        colorTree,
        toggleAllFolders,
        applyFilter,
        isTopicVisible: (targetLi) => {
            let currentNode = targetLi;
            while (currentNode && currentNode !== rootNode) {
                if (showCheckboxes) {
                    const checkbox = currentNode.querySelector(':scope > .node-container > .node-filter-checkbox');
                    if (checkbox && !checkbox.checked) return false;
                }
                currentNode = currentNode.parentElement.closest('li');
            }
            return true;
        }
    };
}