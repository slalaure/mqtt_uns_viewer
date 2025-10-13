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
    const payloadTopic = document.getElementById('payload-topic');
    const datetimeContainer = document.getElementById('current-datetime');
    const livePayloadToggle = document.getElementById('live-payload-toggle');
    const topicHistoryLog = document.getElementById('topic-history-log'); // **[MODIFICATION]** Get history container
    let selectedNodeContainer = null;
    let currentSelectedTopic = null; // **[MODIFICATION]** State for selected topic

    // Elements for tab navigation
    const btnTreeView = document.getElementById('btn-tree-view');
    const btnMapView = document.getElementById('btn-map-view');
    const btnHistoryView = document.getElementById('btn-history-view');
    const treeView = document.getElementById('tree-view');
    const mapView = document.getElementById('map-view');
    const historyView = document.getElementById('history-view');

    // History View Elements
    const historyLogContainer = document.getElementById('historical-log-container');
    const historyTotalMessages = document.getElementById('history-total-messages');
    const historyDbSize = document.getElementById('history-db-size');
    const historyDbLimit = document.getElementById('history-db-limit');
    const pruningIndicator = document.getElementById('pruning-indicator');

    // Simulator UI Elements
    const btnStartSim = document.getElementById('btn-start-sim');
    const btnStopSim = document.getElementById('btn-stop-sim');
    const simStatusIndicator = document.getElementById('sim-status');
    const simulatorControls = document.querySelector('.simulator-controls');

    // --- Application Initialization ---
    async function initializeApp() {
        try {
            const response = await fetch('/api/config');
            const config = await response.json();
            if (config.isSimulatorEnabled && simulatorControls) {
                simulatorControls.style.display = 'flex';
                const statusRes = await fetch('/api/simulator/status');
                const statusData = await statusRes.json();
                updateSimulatorStatusUI(statusData.status);
            }
        } catch (error) {
            console.error("Failed to fetch app configuration:", error);
        }
        loadSvgPlan();
    }

    // --- Dynamic SVG Plan Loading ---
    async function loadSvgPlan() {
        try {
            const response = await fetch('./view.svg');
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const svgText = await response.text();
            if (mapView) mapView.innerHTML = svgText;
        } catch (error) {
            console.error("Could not load the SVG file:", error);
            if (mapView) mapView.innerHTML = `<p style="color: red; padding: 20px;">Error: The SVG plan file could not be loaded.</p>`;
        }
    }

    // --- Tab Switching Logic ---
    function switchView(viewToShow) {
        const views = [treeView, mapView, historyView];
        const buttons = [btnTreeView, btnMapView, btnHistoryView];
        
        let targetView, targetButton;
        if (viewToShow === 'map') {
            targetView = mapView;
            targetButton = btnMapView;
        } else if (viewToShow === 'history') {
            targetView = historyView;
            targetButton = btnHistoryView;
        } else {
            targetView = treeView;
            targetButton = btnTreeView;
        }

        views.forEach(v => v?.classList.remove('active'));
        buttons.forEach(b => b?.classList.remove('active'));

        targetView?.classList.add('active');
        targetButton?.classList.add('active');
    }

    btnTreeView?.addEventListener('click', () => switchView('tree'));
    btnMapView?.addEventListener('click', () => switchView('map'));
    btnHistoryView?.addEventListener('click', () => switchView('history'));

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

    // --- Simulator UI Logic ---
    function updateSimulatorStatusUI(status) {
        if (!simStatusIndicator) return;
        if (status === 'running') {
            simStatusIndicator.textContent = 'Running';
            simStatusIndicator.classList.remove('stopped');
            simStatusIndicator.classList.add('running');
        } else {
            simStatusIndicator.textContent = 'Stopped';
            simStatusIndicator.classList.remove('running');
            simStatusIndicator.classList.add('stopped');
        }
    }
    btnStartSim?.addEventListener('click', () => fetch('/api/simulator/start', { method: 'POST' }));
    btnStopSim?.addEventListener('click', () => fetch('/api/simulator/stop', { method: 'POST' }));

    // --- WebSocket Connection ---
    const ws = new WebSocket(`ws://${window.location.host}`);
    ws.onopen = () => {
        console.log("Connected to WebSocket server.");
        initializeApp();
    };
    ws.onmessage = async (event) => {
        const dataText = event.data instanceof Blob ? await event.data.text() : event.data;
        try {
            const message = JSON.parse(dataText);

            switch(message.type) {
                case 'mqtt-message':
                    updateTree(message.topic, message.payload, message.timestamp);
                    updateMap(message.topic, message.payload);
                    addHistoryEntry(message, true); // Prepend new message
                    // **[MODIFICATION]** If this message is for the selected topic, refresh its history
                    if (message.topic === currentSelectedTopic) {
                        ws.send(JSON.stringify({ type: 'get-topic-history', topic: currentSelectedTopic }));
                    }
                    break;
                case 'simulator-status':
                    updateSimulatorStatusUI(message.status);
                    break;
                case 'history-initial-data':
                    if (historyLogContainer) historyLogContainer.innerHTML = ''; // Clear previous data
                    message.data.forEach(entry => addHistoryEntry(entry, false)); // Append initial data
                    break;
                case 'db-status-update':
                    if (historyTotalMessages) historyTotalMessages.textContent = message.totalMessages.toLocaleString();
                    if (historyDbSize) historyDbSize.textContent = message.dbSizeMB.toFixed(2);
                    if (historyDbLimit) historyDbLimit.textContent = message.dbLimitMB > 0 ? message.dbLimitMB : 'N/A';
                    break;
                case 'pruning-status':
                    if (pruningIndicator) pruningIndicator.classList.toggle('visible', message.status === 'started');
                    break;
                // **[MODIFICATION]** New case to handle incoming topic history
                case 'topic-history-data':
                    displayTopicHistory(message.data);
                    break;
            }
        } catch (e) {
            console.error("JSON Parsing Error:", dataText, e);
        }
    };
    
    // **[MODIFICATION]** New function to display specific topic history
    function displayTopicHistory(entries) {
        if (!topicHistoryLog) return;
        topicHistoryLog.innerHTML = ''; // Clear previous content

        if (!entries || entries.length === 0) {
            topicHistoryLog.innerHTML = `<p class="history-placeholder">No history found for this topic.</p>`;
            return;
        }

        entries.forEach(entry => {
            const div = document.createElement('div');
            div.className = 'topic-history-entry';

            const timeSpan = document.createElement('span');
            timeSpan.className = 'topic-history-timestamp';
            timeSpan.textContent = new Date(entry.timestamp).toLocaleTimeString('en-GB');

            const pre = document.createElement('pre');
            pre.className = 'topic-history-payload';
            try {
                const jsonObj = JSON.parse(entry.payload);
                pre.textContent = JSON.stringify(jsonObj, null, 2);
            } catch (e) {
                pre.textContent = entry.payload;
            }
            
            div.appendChild(timeSpan);
            div.appendChild(pre);
            topicHistoryLog.appendChild(div);
        });
    }

    // --- History View Functions ---
    function addHistoryEntry(entry, prepend = false) {
        if (!historyLogContainer) return;
        const div = document.createElement('div');
        div.className = 'log-entry';

        const header = document.createElement('div');
        header.className = 'log-entry-header';
        
        const topicSpan = document.createElement('span');
        topicSpan.className = 'log-entry-topic';
        topicSpan.textContent = entry.topic;

        const timeSpan = document.createElement('span');
        timeSpan.className = 'log-entry-timestamp';
        timeSpan.textContent = new Date(entry.timestamp).toLocaleTimeString('en-GB');

        header.appendChild(topicSpan);
        header.appendChild(timeSpan);
        
        const pre = document.createElement('pre');
        try {
            const jsonObj = JSON.parse(entry.payload);
            pre.textContent = JSON.stringify(jsonObj, null, 2);
        } catch(e) {
            pre.textContent = entry.payload;
        }

        div.appendChild(header);
        div.appendChild(pre);
        
        if (prepend) {
            historyLogContainer.prepend(div);
        } else {
            historyLogContainer.appendChild(div);
        }
    }

    // --- SVG Plan Update Logic ---
    function updateMap(topic, payload) {
        try {
            const data = JSON.parse(payload);
            const svgId = topic.replace(/\//g, '-');
            const groupElement = document.getElementById(svgId);
            if (!groupElement) return;

            for (const key in data) {
                const textElement = groupElement.querySelector(`[data-key="${key}"]`);
                if (textElement) textElement.textContent = data[key];
            }

            groupElement.classList.add('highlight-svg');
            setTimeout(() => groupElement.classList.remove('highlight-svg'), 500);
        } catch (e) { /* Payload is not JSON, ignore for map */ }
    }

    // --- Payload Display & Interaction Logic ---
    livePayloadToggle?.addEventListener('change', (event) => {
        if (event.target.checked && selectedNodeContainer) {
            selectedNodeContainer.classList.remove('selected');
            selectedNodeContainer = null;
            currentSelectedTopic = null; // Clear selected topic
            if(topicHistoryLog) topicHistoryLog.innerHTML = `<p class="history-placeholder">Select a topic to see its recent history.</p>`; // Reset history view
        }
    });

    function displayPayload(topic, payload) {
        if (payloadTopic) {
            payloadTopic.textContent = topic || "No topic selected";
        }
        if (payloadContent) {
            try {
                const jsonObj = JSON.parse(payload);
                payloadContent.textContent = JSON.stringify(jsonObj, null, 2);
            } catch (e) {
                payloadContent.textContent = payload || "Select a topic to see its payload.";
            }
        }
    }
    
    // --- Tree View Functions ---

    function isTopicVisible(targetLi) {
        let currentNode = targetLi;
        while (currentNode) {
            const checkbox = currentNode.querySelector(':scope > .node-container > .node-filter-checkbox');
            if (!checkbox || !checkbox.checked) {
                return false;
            }
            currentNode = currentNode.parentElement.closest('li');
        }
        return true;
    }

    function handleCheckboxClick(event) {
        event.stopPropagation(); 
        const checkbox = event.target;
        const isChecked = checkbox.checked;
        const li = checkbox.closest('li');
        if (li) {
            const childCheckboxes = li.querySelectorAll('.node-filter-checkbox');
            childCheckboxes.forEach(cb => cb.checked = isChecked);
        }
    }

    function updateTree(topic, payload, timestamp) {
        if (!treeContainer) return;
        const parts = topic.split('/');
        let currentNode = treeContainer;
        const affectedNodes = [];
        const formattedTimestamp = new Date(timestamp).toLocaleTimeString('en-GB');

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
                li.classList.add('new-node');
                
                const nodeContainer = document.createElement('div');
                nodeContainer.className = 'node-container';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'node-filter-checkbox';
                checkbox.checked = true;
                checkbox.addEventListener('click', handleCheckboxClick);

                const nodeName = document.createElement('span');
                nodeName.className = 'node-name';
                nodeName.textContent = part;

                const nodeTimestamp = document.createElement('span');
                nodeTimestamp.className = 'node-timestamp';
                
                nodeContainer.appendChild(checkbox);
                nodeContainer.appendChild(nodeName);
                nodeContainer.appendChild(nodeTimestamp);
                li.appendChild(nodeContainer);
                ul.appendChild(li);
            }
            
            const timestampSpan = li.querySelector('.node-timestamp');
            if(timestampSpan) timestampSpan.textContent = formattedTimestamp;
            affectedNodes.push({ element: li, isNew: isNewNode });
            
            const nodeContainer = li.querySelector('.node-container');
            if (nodeContainer) {
                 if (isLastPart) {
                    li.classList.add('is-file');
                    li.classList.remove('is-folder');
                    nodeContainer.dataset.payload = payload;
                    nodeContainer.dataset.topic = topic;
                    nodeContainer.addEventListener('click', handleNodeClick);
                } else {
                    li.classList.add('is-folder');
                }
            }
            currentNode = li;
        });

        const animationDelay = 150;
        const animationDuration = 1200;
        affectedNodes.forEach((nodeInfo, index) => {
            setTimeout(() => {
                if (nodeInfo.isNew) nodeInfo.element.classList.remove('new-node');
                nodeInfo.element.classList.add('pulse');
                setTimeout(() => nodeInfo.element.classList.remove('pulse'), animationDuration);
            }, index * animationDelay);
        });

        if (livePayloadToggle?.checked && isTopicVisible(currentNode)) {
            const totalAnimationTime = affectedNodes.length * animationDelay;
            setTimeout(() => {
                displayPayload(topic, payload);
            }, totalAnimationTime);
        }
    }

    function handleNodeClick(event) {
        const targetContainer = event.currentTarget;
        if (selectedNodeContainer) {
            selectedNodeContainer.classList.remove('selected');
        }
        selectedNodeContainer = targetContainer;
        selectedNodeContainer.classList.add('selected');
        
        if (livePayloadToggle) {
            livePayloadToggle.checked = false;
        }
        
        const topic = targetContainer.dataset.topic;
        const payload = targetContainer.dataset.payload;
        
        displayPayload(topic, payload);

        // **[MODIFICATION]** Request history for the clicked topic
        currentSelectedTopic = topic;
        if (topicHistoryLog) {
            topicHistoryLog.innerHTML = '<p class="history-placeholder">Loading history...</p>';
        }
        ws.send(JSON.stringify({ type: 'get-topic-history', topic: topic }));
    }
});