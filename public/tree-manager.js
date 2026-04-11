/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025-2026 Sebastien Lalaurette
 *
 * Reusable Tree View Manager Module
 * Encapsulates all logic for creating, updating, and interacting with one tree.
 * [UPDATED] Added dblclick event listener to toggle folder collapse/expand correctly.
 * [UPDATED] Protocol-agnostic hierarchy grouping & integrated I3X Semantic Mode with graph relationships.
 * [UPDATED] Smart fallback for dynamically created providers (e.g., CSV Parsers).
 */

export function createTreeManager(rootElementOrId, options = {}) {
    const { 
        treeId, 
        onNodeClick, 
        onCheckboxClick, 
        showCheckboxes = false, 
        allowFolderCollapse = true,
        isMultiSource = false,
        providersMap = {} // Maps provider/broker ID to technology type (mqtt, opcua, file...)
    } = options;

    function getRootNode() {
        if (typeof rootElementOrId === 'string') {
            return document.getElementById(rootElementOrId);
        }
        return rootElementOrId;
    }

    let nodeMap = new Map(); // Stores references to <li> elements by topic path
    let i3xTopicMap = new Map(); // Stores mapping of physical topics to I3X <li> elements

    // --- [NEW] I3X Mode State ---
    let isI3xModeActive = false;
    let lastMqttEntries = []; // Cache to restore MQTT view when switching back

    /**
     * Smart fallback to guess the provider type if it wasn't registered in the initial config.
     * Useful for dynamically launched CSV parsers.
     */
    function getProviderType(sourceId) {
        if (!sourceId) return 'mqtt';
        if (providersMap[sourceId]) return providersMap[sourceId];
        
        const lower = sourceId.toLowerCase();
        if (lower.includes('csv') || lower.includes('file')) return 'file';
        if (lower.includes('opc')) return 'opcua';
        if (lower === 'i3x') return 'i3x';
        
        return 'mqtt'; // Ultimate fallback
    }

    /**
     * Creates or updates a node in this tree.
     * Organizes hierarchy by: Technology Type -> Provider ID -> Topic hierarchy
     */
    function update(sourceId, topic, payload, timestamp, updateOptions = {}) {
        const rootNode = getRootNode();
        if (!rootNode) return null;

        // Sync physical topic updates to their mapped I3X nodes
        const i3xNodes = i3xTopicMap.get(topic);
        if (i3xNodes) {
            const payloadString = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
            const dateObj = new Date(timestamp);
            const timeStr = dateObj.toLocaleTimeString('en-GB');
            i3xNodes.forEach(li => {
                const container = li.querySelector(':scope > .node-container');
                if (container) {
                    container.dataset.payload = payloadString;
                    const tsSpan = container.querySelector('.node-timestamp');
                    if (tsSpan) {
                        tsSpan.textContent = timeStr;
                        tsSpan.style.color = '';
                    }
                    if (updateOptions.enableAnimations !== false) {
                        container.classList.remove('flash');
                        void container.offsetWidth; 
                        container.classList.add('flash');
                    }
                }
            });
        }

        // Block live MQTT updates if we are currently viewing the I3X Semantic Model
        if (isI3xModeActive) return null;

        const { enableAnimations = false } = updateOptions;
        
        const safeSourceId = sourceId || 'default';
        const providerType = getProviderType(safeSourceId);
        
        // Remove leading slashes to prevent empty parts
        const cleanTopic = topic.replace(/^\//, '');
        const displayTopic = `${providerType}/${safeSourceId}/${cleanTopic}`;
        
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

            // Reconstruct the real topic for data attributes (skipping Tech and Provider levels)
            let nodeSpecificTopic = '';
            if (index >= 2) {
                currentRealTopic += (index > 2 ? '/' : '') + part;
                nodeSpecificTopic = currentRealTopic;
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

                let checkboxHtml = '';
                if (showCheckboxes) {
                    checkboxHtml = `<input type="checkbox" class="node-filter-checkbox" checked>`;
                }
                
                nodeContainer.innerHTML = `
                    ${checkboxHtml}
                    <span class="node-name">${part}</span>
                    <span class="node-timestamp"></span>
                `;

                nodeContainer.dataset.sourceId = safeSourceId;
                nodeContainer.dataset.topic = nodeSpecificTopic; 

                // Semantic drag and drop fallback for data endpoints
                if (index >= 2) {
                    nodeContainer.draggable = true;
                    nodeContainer.addEventListener('dragstart', (e) => {
                        const dragPayload = {
                            type: 'topic',
                            path: nodeSpecificTopic,
                            sourceId: safeSourceId
                        };
                        e.dataTransfer.setData('application/json', JSON.stringify(dragPayload));
                        e.dataTransfer.effectAllowed = 'copy';
                    });
                }

                li.appendChild(nodeContainer);

                // Find parent <ul> and append
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
                    nodeContainer.addEventListener('click', (e) => onNodeClick(e, nodeContainer, safeSourceId, nodeSpecificTopic));
                }

                // Add double-click to toggle folders
                nodeContainer.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    const parentLi = nodeContainer.closest('li');
                    if (parentLi && parentLi.classList.contains('is-folder')) {
                        parentLi.classList.toggle('collapsed');
                    }
                });

                if (showCheckboxes && onCheckboxClick) {
                     nodeContainer.querySelector('.node-filter-checkbox').addEventListener('click', (e) => onCheckboxClick(e, nodeContainer, safeSourceId, nodeSpecificTopic));
                }
            }

            const nodeContainer = li.querySelector('.node-container');
            const timestampSpan = nodeContainer.querySelector('.node-timestamp');
            if (timestampSpan && isLastPart) timestampSpan.textContent = formattedTimestamp;
            
            affectedNodes.push({ element: li, isNew: isNewNode });
            
            if (isLastPart) {
                nodeContainer.dataset.payload = (typeof payload === 'object') ? JSON.stringify(payload) : payload;
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
     * Wipes and rebuilds the tree from a list of topic entries.
     */
    function rebuild(entries) {
         const rootNode = getRootNode();
         if (!rootNode) return;

         // Cache the raw MQTT state
         lastMqttEntries = entries;
         if (isI3xModeActive) return; // Do not rebuild MQTT tree if I3X mode is active

         console.log(`[tree-manager ${treeId}] Rebuilding tree with ${entries.length} topics...`); 
         const rootUl = rootNode.querySelector(':scope > ul');
         if (rootUl) {
             rootUl.innerHTML = '';
         } else {
             rootNode.innerHTML = '<ul></ul>';
         }
         nodeMap.clear();

        const sortedEntries = entries.sort((a, b) => {
            const sourceA = a.source_id || a.sourceId || 'default';
            const sourceB = b.source_id || b.sourceId || 'default';
            
            const typeA = getProviderType(sourceA);
            const typeB = getProviderType(sourceB);
            
            const strA = `${typeA}/${sourceA}/${a.topic}`;
            const strB = `${typeB}/${sourceB}/${b.topic}`;
            return strA.localeCompare(strB);
        });

        let i = 0;
        for (const entry of sortedEntries) {
            i++;
            try {
                update(entry.source_id || entry.sourceId, entry.topic, entry.payload, entry.timestamp, { enableAnimations: false });
            } catch (e) {
                console.error(`[tree-manager ${treeId}] Failed to update node for topic: ${entry.topic}`, e); 
            }
        }
        console.log(`[tree-manager ${treeId}] Rebuild complete. ${i} nodes processed.`); 
    }

    /**
     * --- I3X Semantic Mode Logic ---
     * Fetches instances from the I3X API and builds a hierarchical tree based on `parentId`.
     */
    async function setI3xMode(mode) {
        const rootNode = getRootNode();
        if (!rootNode) return;
        isI3xModeActive = mode;
        if (mode) {
            const rootUl = rootNode.querySelector(':scope > ul');
            if (rootUl) rootUl.innerHTML = '<li style="padding: 10px; color: var(--color-text-secondary);">Loading Semantic Model...</li>';
            try {
                const safeBasePath = document.querySelector('base')?.getAttribute('href') || '/';
                const res = await fetch(`${safeBasePath}api/i3x/objects`);
                if (!res.ok) throw new Error("Failed to fetch I3X objects");
                const objects = await res.json();
                buildI3xTree(objects);
            } catch (err) {
                console.error(`[tree-manager ${treeId}] I3X fetch error:`, err);
                if (rootUl) rootUl.innerHTML = `<li style="padding: 10px; color: var(--color-danger);">Error loading semantic model: ${err.message}</li>`;
            }
        } else {
            // Revert to raw protocol hierarchy
            rebuild(lastMqttEntries);
        }
    }

    /**
     * Integrates the I3X semantic models as a dedicated root node branch, 
     * resolving children and complex graph relationship edges.
     */
    function buildI3xTree(objects) {
        const rootNode = getRootNode();
        if (!rootNode) return;
        if (!objects || !Array.isArray(objects)) return;

        let rootUl = rootNode.querySelector(':scope > ul');
        if (!rootUl) {
            rootUl = document.createElement('ul');
            rootNode.appendChild(rootUl);
        }
        
        let i3xRootLi = nodeMap.get('i3x_root');
        if (!i3xRootLi) {
            i3xRootLi = document.createElement('li');
            i3xRootLi.id = `node-${treeId}-i3x-root`;
            i3xRootLi.classList.add('is-folder'); 
            
            const nodeContainer = document.createElement('div');
            nodeContainer.className = 'node-container';
            
            let checkboxHtml = showCheckboxes ? `<input type="checkbox" class="node-filter-checkbox" checked>` : '';
            nodeContainer.innerHTML = `
                ${checkboxHtml}
                <span class="node-name" style="color: var(--color-primary); font-weight: bold; letter-spacing: 1px;">I3X_Semantic_Graph</span>
            `;
            
            nodeContainer.dataset.sourceId = 'i3x';
            nodeContainer.dataset.topic = '';
            
            i3xRootLi.appendChild(nodeContainer);
            
            const childUl = document.createElement('ul');
            i3xRootLi.appendChild(childUl);
            rootUl.appendChild(i3xRootLi);
            nodeMap.set('i3x_root', i3xRootLi);
            
            if (onNodeClick) {
                nodeContainer.addEventListener('click', (e) => onNodeClick(e, nodeContainer, 'i3x', ''));
            }

            nodeContainer.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                if (i3xRootLi.classList.contains('is-folder')) {
                    i3xRootLi.classList.toggle('collapsed');
                }
            });
        }
        
        const i3xUl = i3xRootLi.querySelector(':scope > ul');
        i3xUl.innerHTML = '';
        i3xTopicMap.clear();

        const childrenMap = new Map();        objects.forEach(obj => {
            const parent = (obj.parentId === '/' || !obj.parentId) ? null : obj.parentId;
            if (!childrenMap.has(parent)) childrenMap.set(parent, []);
            childrenMap.get(parent).push(obj);
        });
        
        function createNode(obj, currentPath) {
            const li = document.createElement('li');
            const path = `${currentPath}/${obj.elementId}`;
            li.id = `node-${treeId}-i3x-${obj.elementId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
            li.classList.add(obj.isComposition ? 'is-folder' : 'is-file');
            if (obj.isComposition) li.classList.add('collapsed');
            
            const nodeContainer = document.createElement('div');
            nodeContainer.className = 'node-container';
            
            nodeContainer.draggable = true;
            nodeContainer.addEventListener('dragstart', (e) => {
                const dragPayload = { type: 'element', id: obj.elementId, typeId: obj.typeId, namespaceUri: obj.namespaceUri };
                e.dataTransfer.setData('application/json', JSON.stringify(dragPayload));
                e.dataTransfer.effectAllowed = 'copy';
            });
            
            let checkboxHtml = showCheckboxes ? `<input type="checkbox" class="node-filter-checkbox" checked>` : '';
            nodeContainer.innerHTML = `
                ${checkboxHtml}
                <span class="node-name" title="Type: ${obj.typeId}">${obj.displayName || obj.elementId}</span>
                <span class="node-timestamp" style="color:var(--color-primary); font-size:0.7em;">Semantic</span>
            `;
            
            nodeContainer.dataset.elementId = obj.elementId;
            nodeContainer.dataset.typeId = obj.typeId;
            nodeContainer.dataset.isI3x = "true";
            nodeContainer.dataset.sourceId = 'i3x';
            nodeContainer.dataset.topic = obj.elementId;

            let effectiveSourceId = 'i3x';
            let effectiveTopic = obj.elementId;

            if (obj.topic_mapping) {
                nodeContainer.dataset.topicMapping = obj.topic_mapping;
                effectiveTopic = obj.topic_mapping;

                if (!i3xTopicMap.has(obj.topic_mapping)) i3xTopicMap.set(obj.topic_mapping, []);
                i3xTopicMap.get(obj.topic_mapping).push(li);

                // Initial payload sync from cache
                const lastEntry = lastMqttEntries.find(e => e.topic === obj.topic_mapping);
                if (lastEntry) {
                    effectiveSourceId = lastEntry.sourceId || 'mqtt';
                    nodeContainer.dataset.sourceId = effectiveSourceId;
                    nodeContainer.dataset.topic = effectiveTopic;
                    nodeContainer.dataset.payload = typeof lastEntry.payload === 'object' ? JSON.stringify(lastEntry.payload) : String(lastEntry.payload);
                    const tsSpan = nodeContainer.querySelector('.node-timestamp');
                    const ts = lastEntry.timestampMs || (lastEntry.timestamp ? new Date(lastEntry.timestamp).getTime() : null);
                    if (tsSpan && ts) {
                        const dateObj = new Date(ts);
                        tsSpan.textContent = dateObj.toLocaleTimeString('en-GB');
                    }
                } else {
                    nodeContainer.dataset.topic = effectiveTopic;
                }
            }

            li.appendChild(nodeContainer);
            nodeMap.set(`i3x_node_${path}`, li);
            if (onNodeClick) {
                nodeContainer.addEventListener('click', (e) => onNodeClick(e, nodeContainer, effectiveSourceId, effectiveTopic));
            }
            nodeContainer.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                if (li.classList.contains('is-folder')) {
                    li.classList.toggle('collapsed');
                }
            });

            if (showCheckboxes && onCheckboxClick) {
                const cb = nodeContainer.querySelector('.node-filter-checkbox');
                if (cb) cb.addEventListener('click', (e) => onCheckboxClick(e, nodeContainer, 'i3x', obj.elementId));
            }
            
            const childUl = document.createElement('ul');
            let hasChildren = false;
            
            // 1. Hierarchical / Composition Children
            const children = childrenMap.get(obj.elementId) || [];
            if (children.length > 0) {
                hasChildren = true;
                children.forEach(child => childUl.appendChild(createNode(child, path)));
            }
            
            // 2. Specific Graph Relationships
            if (obj.relationships) {
                for (const [relType, targets] of Object.entries(obj.relationships)) {
                    if (['HasParent', 'HasChildren', 'HasComponent', 'ComponentOf', 'InheritsFrom', 'InheritedBy'].includes(relType)) continue;
                    
                    const targetList = Array.isArray(targets) ? targets : [targets];
                    targetList.forEach(targetId => {
                        hasChildren = true;
                        const relLi = document.createElement('li');
                        relLi.classList.add('is-file');
                        
                        const relContainer = document.createElement('div');
                        relContainer.className = 'node-container';
                        relContainer.dataset.sourceId = 'i3x';
                        relContainer.dataset.topic = targetId;
                        relContainer.dataset.isI3x = "true";
                        relContainer.dataset.elementId = targetId;
                        
                        let relCheckboxHtml = showCheckboxes ? `<input type="checkbox" class="node-filter-checkbox" checked>` : '';
                        relContainer.innerHTML = `
                            ${relCheckboxHtml}
                            <span class="node-name" style="color: #8e44ad; font-style: italic;">🔗 ${relType}: ${targetId}</span>
                        `;
                        
                        if (onNodeClick) {
                            relContainer.addEventListener('click', (e) => onNodeClick(e, relContainer, 'i3x', targetId));
                        }
                        if (showCheckboxes && onCheckboxClick) {
                            const cb = relContainer.querySelector('.node-filter-checkbox');
                            if (cb) cb.addEventListener('click', (e) => onCheckboxClick(e, relContainer, 'i3x', targetId));
                        }
                        
                        relLi.appendChild(relContainer);
                        childUl.appendChild(relLi);
                    });
                }
            }
            
            if (hasChildren) {
                li.appendChild(childUl);
            } else {
                li.classList.remove('is-folder', 'collapsed');
                li.classList.add('is-file');
            }
            
            return li;
        }
        
        const rootObjects = childrenMap.get(null) || [];
        rootObjects.forEach(obj => {
            i3xUl.appendChild(createNode(obj, ''));
        });
    }

    /**
     * Applies coloring logic to all nodes in this tree.
     */
    function colorTree(colorLogicFn) {
        const rootNode = getRootNode();
        if (!rootNode) return;
        rootNode.querySelectorAll('li > .node-container').forEach(nodeContainer => {
            const li = nodeContainer.closest('li');
            const sourceId = nodeContainer.dataset.sourceId;
            const topic = nodeContainer.dataset.topic;
            if (sourceId !== undefined && topic !== undefined) {
                 colorLogicFn(sourceId, topic, li);
            }
        });
    }

    function toggleAllFolders(collapse) {
        const rootNode = getRootNode();
        if (!rootNode) return;
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
        const sourceId = nodeContainer.dataset.sourceId?.toLowerCase() || '';
        
        const isMatch = nodeName.includes(filterText) || 
                        originalTopic.includes(filterText) || 
                        sourceId.includes(filterText);
                        
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
        const rootNode = getRootNode();
        if (!rootNode) return;
        const rootUl = rootNode.querySelector(':scope > ul');
        if (!rootUl) return; 
        const allNodes = rootUl.querySelectorAll(':scope > li');
        allNodes.forEach(node => filterNode(node, filterText.toLowerCase()));
    }

    return {
        update,
        rebuild,
        buildI3xTree,
        setI3xMode, 
        colorTree,
        toggleAllFolders,
        applyFilter,
        isTopicVisible: (targetLi) => {
            const rootNode = getRootNode();
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