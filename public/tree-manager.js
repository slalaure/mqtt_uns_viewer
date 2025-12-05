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
 */

/**
 * Creates a new tree manager instance.
 * @param {HTMLElement} rootElement The <ul> element to build the tree in.
 * @param {object} options
 * @param {string} options.treeId A unique ID prefix for nodes (e.g., 'main-tree').
 * @param {function} [options.onNodeClick] (event, nodeContainer, brokerId, topic) => void
 * @param {function} [options.onCheckboxClick] (event, nodeContainer, brokerId, topic) => void
 * @param {boolean} [options.showCheckboxes] Show filter checkboxes.
 * @param {boolean} [options.allowFolderCollapse] Allow folders to be collapsed.
 * @param {boolean} [options.isMultiBroker] Whether the app is in multi-broker mode.
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

    /**
     * Creates or updates a node in this tree.
     * @param {string} brokerId - The ID of the broker.
     * @param {string} topic - Full topic string.
     * @param {string} payload - The payload string.
     * @param {string} timestamp - ISO timestamp.
     * @param {object} updateOptions
     * @param {boolean} updateOptions.enableAnimations
     */
    function update(brokerId, topic, payload, timestamp, updateOptions = {}) {
        const { enableAnimations = false } = updateOptions;
        
        //  Safety check for brokerId to prevent "undefined" root folders
        const safeBrokerId = brokerId || 'default';

        //  Create the topic path that will be displayed in the tree.
        const displayTopic = isMultiBroker ? `${safeBrokerId}/${topic}` : topic;
        const parts = displayTopic.split('/');
        
        let currentTopicPath = '';
        // Used to reconstruct the actual MQTT topic (without broker prefix if needed)
        let currentRealTopic = ''; 
        let currentUl = rootNode;
        const affectedNodes = [];
        const formattedTimestamp = new Date(timestamp).toLocaleTimeString('en-GB');
        let li; 

        for (let index = 0; index < parts.length; index++) {
            const part = parts[index];
            currentTopicPath += (index > 0 ? '/' : '') + part;

            // Reconstruct the real topic for data attributes
            if (isMultiBroker) {
                // If multi-broker, skip the first part (brokerId) for the topic string
                if (index > 0) {
                    currentRealTopic += (index > 1 ? '/' : '') + part;
                }
            } else {
                currentRealTopic += (index > 0 ? '/' : '') + part;
            }

            const isLastPart = index === parts.length - 1;
            // The node ID must be unique *per tree*
            const partId = `node-${treeId}-${currentTopicPath.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
            
            li = nodeMap.get(currentTopicPath); 

            // --- FILTERING LOGIC ---
            // If checkboxes are enabled, check if the current node exists and is unchecked.
            // If it is unchecked, we assume the user wants to filter out this branch.
            // We stop processing immediately, preventing updates or creation of children.
            if (li && showCheckboxes) {
                const checkbox = li.querySelector(':scope > .node-container > .node-filter-checkbox');
                if (checkbox && !checkbox.checked) {
                    return null; // Stop updating this branch
                }
            }
            // -----------------------

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
                    <span class="node-name"></span>
                    <span class="node-timestamp"></span>
                `;
                nodeContainer.querySelector('.node-name').textContent = part;
                
                // Store the specific path for this node level
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
                    // This is a child node
                    parentUl = parentLi.querySelector(':scope > ul');
                    if (!parentUl) {
                        parentUl = document.createElement('ul');
                        parentLi.appendChild(parentUl);
                    }
                } else {
                    // This is a top-level node. Find/create the root <ul> inside the container.
                    parentUl = rootNode.querySelector(':scope > ul');
                    if (!parentUl) {
                        parentUl = document.createElement('ul');
                        rootNode.appendChild(parentUl);
                    }
                }

                parentUl.appendChild(li);
                nodeMap.set(currentTopicPath, li);

                // Add listeners with correct closure data
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

            // Only set payload on the actual leaf node or updated node
            nodeContainer.dataset.payload = payload;

            if (isLastPart) {
                li.classList.add('is-file');
                li.classList.remove('is-folder', 'collapsed');
            } else {
                li.classList.add('is-folder');
            }

            currentUl = li.querySelector('ul') || currentUl;
        } // end for loop

        if (enableAnimations) {
            const animationDelay = 150;
            const animationDuration = 1200;
            
            affectedNodes.forEach((nodeInfo, index) => {
                setTimeout(() => {
                    if (nodeInfo.isNew) nodeInfo.element.classList.remove('new-node');
                    nodeInfo.element.classList.add('pulse');
                    setTimeout(() => nodeInfo.element.classList.remove('pulse'), animationDuration);
                }, index * animationDelay);
            });
        }

        return li; 
    }

    /**
     * Wipes and rebuilds the tree from a list of topic entries.
     * @param {Array<object>} entries - Array of { broker_id, topic, payload, timestamp }
     */
    function rebuild(entries) {
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
     * Applies coloring logic to all nodes in this tree.
     * @param {function} colorLogicFn - (brokerId, topic, liElement) => void
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