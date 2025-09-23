/**
 * @license MIT
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Element Initialization ---
    const treeContainer = document.getElementById('mqtt-tree');
    const payloadContent = document.getElementById('payload-content');
    const datetimeContainer = document.getElementById('current-datetime');
    let selectedNodeContainer = null;

    // Elements for tab navigation
    const btnTreeView = document.getElementById('btn-tree-view');
    const btnMapView = document.getElementById('btn-map-view');
    const treeView = document.getElementById('tree-view');
    const mapView = document.getElementById('map-view');

    // --- Dynamic SVG Plan Loading ---
    async function loadSvgPlan() {
        try {
            const response = await fetch('./view.svg'); // Path to your SVG file
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const svgText = await response.text();
            if (mapView) {
                mapView.innerHTML = svgText;
            }
        } catch (error) {
            console.error("Could not load the SVG file:", error);
            if (mapView) {
                mapView.innerHTML = `<p style="color: red; padding: 20px;">Error: The SVG plan file could not be loaded.</p>`;
            }
        }
    }
    loadSvgPlan(); // Load the SVG as soon as the page is ready

    // --- Tab Switching Logic (with safety checks) ---
    function switchView(viewToShow) {
        if (!treeView || !mapView) return; // Safety check if view containers don't exist

        if (viewToShow === 'map') {
            mapView.classList.add('active');
            treeView.classList.remove('active');
            if (btnMapView) btnMapView.classList.add('active');
            if (btnTreeView) btnTreeView.classList.remove('active');
        } else {
            treeView.classList.add('active');
            mapView.classList.remove('active');
            if (btnTreeView) btnTreeView.classList.add('active');
            if (btnMapView) btnMapView.classList.remove('active');
        }
    }

    if (btnTreeView && btnMapView) {
        btnTreeView.addEventListener('click', () => switchView('tree'));
        btnMapView.addEventListener('click', () => switchView('map'));
    } else {
        console.error("Tab buttons not found. Check the IDs in index.html.");
    }

    // --- Real-Time Clock ---
    function updateClock() {
        if (!datetimeContainer) return;
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        datetimeContainer.textContent = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }
    setInterval(updateClock, 1000);
    updateClock();

    // --- WebSocket Connection ---
    const ws = new WebSocket(`ws://${window.location.host}`);
    ws.onopen = () => console.log("Connected to WebSocket server.");
    ws.onmessage = async (event) => {
        let dataText;
        if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
            dataText = await (new Response(event.data)).text();
        } else {
            dataText = event.data;
        }
        try {
            const message = JSON.parse(dataText);
            // Call update handlers for both views
            updateTree(message.topic, message.payload, message.timestamp);
            updateMap(message.topic, message.payload);
        } catch (e) {
            console.error("JSON Parsing Error:", dataText, e);
        }
    };
    
    // --- SVG Plan Update Logic ---
    function updateMap(topic, payload) {
        try {
            const data = JSON.parse(payload);
            const svgId = topic.replace(/\//g, '-');
            const groupElement = document.getElementById(svgId);
            if (!groupElement) return;

            for (const key in data) {
                const textElement = groupElement.querySelector(`[data-key="${key}"]`);
                if (textElement) {
                    textElement.textContent = data[key];
                }
            }

            groupElement.classList.add('highlight-svg');
            setTimeout(() => {
                groupElement.classList.remove('highlight-svg');
            }, 500);
        } catch (e) {
            // Payload is not JSON, ignoring for the map view.
        }
    }

    // --- Tree View Functions ---
    /**
     * Updates the tree view, handles timestamps, and triggers animations.
     * @param {string} topic The MQTT topic.
     * @param {string} payload The message payload.
     * @param {string} timestamp The ISO timestamp of the message.
     */
    function updateTree(topic, payload, timestamp) {
        if (!treeContainer) return;
        const parts = topic.split('/');
        let currentNode = treeContainer;
        const affectedNodes = [];
        const formattedTimestamp = new Date(timestamp).toLocaleTimeString('en-GB'); // Using English locale

        parts.forEach((part, index) => {
            const isLastPart = index === parts.length - 1;
            const partId = parts.slice(0, index + 1).join('-');
            let ul = currentNode.querySelector(':scope > ul');
            if (!ul) {
                ul = document.createElement('ul');
                currentNode.appendChild(ul);
            }
            let li = ul.querySelector(`:scope > li#node-${partId}`);
            let isNewNode = false;
            if (!li) {
                isNewNode = true;
                li = document.createElement('li');
                li.id = `node-${partId}`;
                if (isNewNode) li.classList.add('new-node');
                
                const nodeContainer = document.createElement('div');
                nodeContainer.className = 'node-container';
                const nodeName = document.createElement('span');
                nodeName.className = 'node-name';
                nodeName.textContent = part;
                const nodeTimestamp = document.createElement('span');
                nodeTimestamp.className = 'node-timestamp';
                
                nodeContainer.appendChild(nodeName);
                nodeContainer.appendChild(nodeTimestamp);
                li.appendChild(nodeContainer);
                ul.appendChild(li);
            }
            
            const timestampSpan = li.querySelector('.node-timestamp');
            timestampSpan.textContent = formattedTimestamp;
            affectedNodes.push({ element: li, isNew: isNewNode }); // Store the element and its state
            
            const nodeContainer = li.querySelector('.node-container');
            if (isLastPart) {
                li.classList.add('is-file');
                li.classList.remove('is-folder');
                nodeContainer.dataset.payload = payload;
                nodeContainer.dataset.topic = topic;
                nodeContainer.addEventListener('click', handleNodeClick);
            } else {
                li.classList.add('is-folder');
            }
            currentNode = li;
        });

        // --- Improved cascading animation logic ---
        const animationDelay = 150;
        const animationDuration = 1200;
        affectedNodes.forEach((nodeInfo, index) => {
            setTimeout(() => {
                if (nodeInfo.isNew) {
                    nodeInfo.element.classList.remove('new-node');
                }
                nodeInfo.element.classList.add('pulse');
                setTimeout(() => {
                    nodeInfo.element.classList.remove('pulse');
                }, animationDuration);
            }, index * animationDelay);
        });
    }

    /**
     * Handles clicks on a "file" node to display its payload.
     * @param {MouseEvent} event The click event.
     */
    function handleNodeClick(event) {
        const targetContainer = event.currentTarget;
        if (selectedNodeContainer) {
            selectedNodeContainer.classList.remove('selected');
        }
        selectedNodeContainer = targetContainer;
        selectedNodeContainer.classList.add('selected');
        
        const payload = targetContainer.dataset.payload;
        try {
            // Try to parse and pretty-print if it's JSON
            const jsonObj = JSON.parse(payload);
            payloadContent.textContent = JSON.stringify(jsonObj, null, 2);
        } catch (e) {
            // Otherwise, display as plain text
            payloadContent.textContent = payload;
        }
    }
});