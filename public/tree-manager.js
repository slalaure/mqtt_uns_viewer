/**
 * @license MIT
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
 * @param {function} [options.onNodeClick] (event, nodeContainer, topic) => void
 * @param {function} [options.onCheckboxClick] (event, nodeContainer, topic) => void
 * @param {boolean} [options.showCheckboxes] Show filter checkboxes.
 * @param {boolean} [options.allowFolderCollapse] Allow folders to be collapsed.
 */
export function createTreeManager(rootElement, options = {}) {
    const { treeId, onNodeClick, onCheckboxClick, showCheckboxes = false, allowFolderCollapse = true } = options;
    const rootNode = rootElement;
    let nodeMap = new Map(); // Stores references to <li> elements by topic

    /**
     * Creates or updates a node in this tree.
     * @param {string} topic Full topic string.
     * @param {string} payload The payload string.
     * @param {string} timestamp ISO timestamp.
     * @param {object} updateOptions
     * @param {boolean} updateOptions.enableAnimations
     */
    function update(topic, payload, timestamp, updateOptions = {}) {
        const { enableAnimations = false } = updateOptions;
        const parts = topic.split('/');
        let currentTopicPath = '';
        let currentUl = rootNode;
        const affectedNodes = [];
        const formattedTimestamp = new Date(timestamp).toLocaleTimeString('en-GB');

        let li; // <-- [THE FIX] Declare li here, outside the loop.

        for (let index = 0; index < parts.length; index++) {
            const part = parts[index];
            currentTopicPath += (index > 0 ? '/' : '') + part;
            const isLastPart = index === parts.length - 1;
            const partId = `node-${treeId}-${currentTopicPath.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

            // [MODIFIED] Remove 'let' to assign to the outer-scoped variable
            li = nodeMap.get(currentTopicPath); 
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
                nodeContainer.dataset.topic = currentTopicPath; // Store full path
                li.appendChild(nodeContainer);

                // Find parent <ul> and append
                const parentTopic = parts.slice(0, index).join('/');
                const parentLi = nodeMap.get(parentTopic);
                let parentUl = parentLi ? parentLi.querySelector(':scope > ul') : rootNode;
                if (!parentUl) {
                    parentUl = document.createElement('ul');
                    if(parentLi) parentLi.appendChild(parentUl);
                    else rootNode.appendChild(parentUl);
                }
                parentUl.appendChild(li);
                nodeMap.set(currentTopicPath, li);
                
                // Add listeners
                if (onNodeClick) {
                    nodeContainer.addEventListener('click', (e) => onNodeClick(e, nodeContainer, currentTopicPath));
                }
                if (showCheckboxes && onCheckboxClick) {
                     nodeContainer.querySelector('.node-filter-checkbox').addEventListener('click', (e) => onCheckboxClick(e, nodeContainer, currentTopicPath));
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
                // [MODIFIED] Remove the separate click listener.
                // The main onNodeClick in app.js will now handle this.
                if (allowFolderCollapse && isNewNode) {
                    // Start new folders as collapsed
                    li.classList.add('collapsed');
                }
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
        
        return li; // <-- This return will now work correctly.
    }

    /**
     * Wipes and rebuilds the tree from a Map of topics.
     * @param {Map<string, object>} topicMap - Map of { topic -> entry }
     */
    function rebuild(topicMap) {
        console.log(`[tree-manager ${treeId}] Rebuilding tree with ${topicMap.size} topics...`); // [DEBUG LOG]
        rootNode.innerHTML = '';
        nodeMap.clear();
        
        // Sort topics to ensure parents are created before children
        const sortedTopics = Array.from(topicMap.keys()).sort();
        
        let i = 0;
        for (const topic of sortedTopics) {
            i++;
            const entry = topicMap.get(topic);
            try {
                update(topic, entry.payload, entry.timestamp, { enableAnimations: false });
            } catch (e) {
                console.error(`[tree-manager ${treeId}] Failed to update node for topic: ${topic}`, e); // [DEBUG LOG]
            }
        }
        console.log(`[tree-manager ${treeId}] Rebuild complete. ${i} nodes processed.`); // [DEBUG LOG]
    }

    /**
     * Applies coloring logic to all nodes in this tree.
     * @param {function} colorLogicFn - (topic, liElement) => void
     */
    function colorTree(colorLogicFn) {
        nodeMap.forEach((li, topic) => {
            colorLogicFn(topic, li);
        });
    }

    /**
     * Expands or collapses all folders.
     * @param {boolean} collapse - True to collapse, false to expand.
     */
    function toggleAllFolders(collapse) {
        rootNode.querySelectorAll('.is-folder').forEach(folderLi => {
            folderLi.classList.toggle('collapsed', collapse);
        });
    }
    
    /**
     * Recursively filters the tree.
     * @param {HTMLElement} node - The <li> element to start from.
     * @param {string} filterText - The lowercase filter text.
     * @returns {boolean} True if this node or a child matches.
     */
    function filterNode(node, filterText) {
        const nodeName = node.querySelector(':scope > .node-container > .node-name').textContent.toLowerCase();
        const isMatch = nodeName.includes(filterText);
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
    
    /**
     * Applies the filter text to the entire tree.
     * @param {string} filterText - The text to filter by.
     */
    function applyFilter(filterText) {
        const allNodes = rootNode.querySelectorAll(':scope > ul > li');
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