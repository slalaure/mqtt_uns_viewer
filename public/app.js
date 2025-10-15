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
    const payloadContainer = document.getElementById('payload-display');
    const payloadMainArea = document.getElementById('payload-main-area');
    const payloadContent = document.getElementById('payload-content');
    const payloadTopic = document.getElementById('payload-topic');
    const datetimeContainer = document.getElementById('current-datetime');
    const livePayloadToggle = document.getElementById('live-payload-toggle');
    const topicHistoryContainer = document.getElementById('topic-history-container');
    let selectedNodeContainer = null;

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
    const topicHistoryLog = document.getElementById('topic-history-log');
    
    // History filter elements
    const historySearchInput = document.getElementById('history-search-input');
    const timeRangeSliderContainer = document.getElementById('time-range-slider-container');
    const handleMin = document.getElementById('handle-min');
    const handleMax = document.getElementById('handle-max');
    const sliderRange = document.getElementById('slider-range');
    const labelMin = document.getElementById('label-min');
    const labelMax = document.getElementById('label-max');

    // [NOUVEAU] SVG View History Elements
    const svgContent = document.getElementById('svg-content');
    const svgHistoryToggle = document.getElementById('svg-history-toggle');
    const svgTimelineSlider = document.getElementById('svg-timeline-slider-container');
    const svgHandle = document.getElementById('svg-handle');
    const svgLabel = document.getElementById('svg-label');
    let svgInitialTextValues = new Map();

    // State for history filtering
    let allHistoryEntries = [];
    let minTimestamp = 0;
    let maxTimestamp = 0;
    let currentMinTimestamp = 0;
    let currentMaxTimestamp = 0;
    let isSvgHistoryMode = false;

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
            const response = await fetch('/view.svg'); 
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const svgText = await response.text();
            if (svgContent) {
                svgContent.innerHTML = svgText;
                // [NOUVEAU] Sauvegarde des valeurs initiales du SVG pour pouvoir le réinitialiser
                const textElements = svgContent.querySelectorAll('[data-key]');
                textElements.forEach(el => {
                    svgInitialTextValues.set(el, el.textContent);
                });
            }
        } catch (error) {
            console.error("Could not load the SVG file:", error);
            if (svgContent) svgContent.innerHTML = `<p style="color: red; padding: 20px;">Error: The SVG plan file could not be loaded.</p>`;
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
                case 'mqtt-message': {
                    updateTree(message.topic, message.payload, message.timestamp);
                    // [MODIFIÉ] La mise à jour du SVG ne se fait que si le mode historique est désactivé
                    if (!isSvgHistoryMode) {
                        updateMap(message.topic, message.payload);
                    }
                    
                    const newEntry = { ...message, timestampMs: new Date(message.timestamp).getTime() };
                    const wasLive = currentMaxTimestamp === maxTimestamp;
                    allHistoryEntries.unshift(newEntry);

                    if (newEntry.timestampMs > maxTimestamp) {
                        maxTimestamp = newEntry.timestampMs;
                    }
                    
                    if (wasLive) {
                        currentMaxTimestamp = maxTimestamp;
                        applyAndRenderFilters();
                    }
                    
                    updateSliderUI();
                    updateSvgTimelineUI(); // [NOUVEAU] Met à jour aussi la timeline SVG
                    break;
                }
                case 'simulator-status':
                    updateSimulatorStatusUI(message.status);
                    break;
                case 'history-initial-data':
                    allHistoryEntries = message.data.map(entry => ({ ...entry, timestampMs: new Date(entry.timestamp).getTime() }));
                    initializeHistoryFilters();
                    applyAndRenderFilters();
                    break;
                case 'topic-history-data':
                    updateTopicHistory(message.topic, message.data);
                    break;
                case 'db-status-update':
                    if (historyTotalMessages) historyTotalMessages.textContent = message.totalMessages.toLocaleString();
                    if (historyDbSize) historyDbSize.textContent = message.dbSizeMB.toFixed(2);
                    if (historyDbLimit) historyDbLimit.textContent = message.dbLimitMB > 0 ? message.dbLimitMB : 'N/A';
                    break;
                case 'pruning-status':
                    if (pruningIndicator) pruningIndicator.classList.toggle('visible', message.status === 'started');
                    break;
            }
        } catch (e) {
            console.error("JSON Parsing Error:", dataText, e);
        }
    };
    
    // --- History View Filtering Logic ---
    
    function initializeHistoryFilters() {
        if (allHistoryEntries.length === 0) {
            timeRangeSliderContainer.style.display = 'none';
            return;
        }
        timeRangeSliderContainer.style.display = 'block';

        minTimestamp = allHistoryEntries[allHistoryEntries.length - 1].timestampMs;
        maxTimestamp = allHistoryEntries[0].timestampMs;
        currentMinTimestamp = minTimestamp;
        currentMaxTimestamp = maxTimestamp;

        updateSliderUI();
        updateSvgTimelineUI(); // Initialise aussi la timeline SVG
    }
    
    function applyAndRenderFilters() {
        if (!historyLogContainer) return;

        const searchTerm = historySearchInput.value.trim().toLowerCase();
        const searchActive = searchTerm.length >= 3;

        const filteredEntries = allHistoryEntries.filter(entry => {
            const inTimeRange = entry.timestampMs >= currentMinTimestamp && entry.timestampMs <= currentMaxTimestamp;
            if (!inTimeRange) return false;

            if (searchActive) {
                const topicMatch = entry.topic.toLowerCase().includes(searchTerm);
                const payloadMatch = entry.payload.toLowerCase().includes(searchTerm);
                return topicMatch || payloadMatch;
            }
            return true;
        });

        historyLogContainer.innerHTML = '';
        filteredEntries.forEach(entry => addHistoryEntry(entry, searchActive ? searchTerm : null));
    }

    function highlightText(text, term) {
        if (!term) return text;
        const regex = new RegExp(term.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');
        return text.replace(regex, `<mark class="highlight">$&</mark>`);
    }
    
    historySearchInput?.addEventListener('input', applyAndRenderFilters);

    // --- Time Range Slider Logic ---

    function formatTimestampForLabel(timestamp) {
        const date = new Date(timestamp);
        const timePart = date.toLocaleTimeString('en-GB');
        const datePart = date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
        return `${timePart} ${datePart}`;
    }

    function updateSliderUI() {
        if (!handleMin) return;
        const timeRange = maxTimestamp - minTimestamp;
        if (timeRange <= 0) return;

        const minPercent = ((currentMinTimestamp - minTimestamp) / timeRange) * 100;
        const maxPercent = ((currentMaxTimestamp - minTimestamp) / timeRange) * 100;

        handleMin.style.left = `${minPercent}%`;
        handleMax.style.left = `${maxPercent}%`;
        sliderRange.style.left = `${minPercent}%`;
        sliderRange.style.width = `${maxPercent - minPercent}%`;

        labelMin.textContent = formatTimestampForLabel(currentMinTimestamp);
        labelMax.textContent = formatTimestampForLabel(currentMaxTimestamp);
    }

    function makeDraggable(handle, isMin) {
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const sliderRect = timeRangeSliderContainer.getBoundingClientRect();
            
            const onMouseMove = (moveEvent) => {
                let x = moveEvent.clientX - sliderRect.left;
                let percent = (x / sliderRect.width) * 100;
                percent = Math.max(0, Math.min(100, percent));

                const timeRange = maxTimestamp - minTimestamp;
                const newTimestamp = minTimestamp + (timeRange * percent / 100);

                if (isMin) {
                    currentMinTimestamp = Math.min(newTimestamp, currentMaxTimestamp);
                } else {
                    currentMaxTimestamp = Math.max(newTimestamp, currentMinTimestamp);
                }
                
                updateSliderUI();
            };

            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                applyAndRenderFilters();
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }

    if (handleMin && handleMax) {
        makeDraggable(handleMin, true);
        makeDraggable(handleMax, false);
    }
    
    // --- History View Functions ---
    function addHistoryEntry(entry, searchTerm = null) {
        if (!historyLogContainer) return;
        const div = document.createElement('div');
        div.className = 'log-entry';

        const header = document.createElement('div');
        header.className = 'log-entry-header';
        
        const topicSpan = document.createElement('span');
        topicSpan.className = 'log-entry-topic';
        topicSpan.innerHTML = highlightText(entry.topic, searchTerm);

        const timeSpan = document.createElement('span');
        timeSpan.className = 'log-entry-timestamp';
        timeSpan.textContent = new Date(entry.timestamp).toLocaleTimeString('en-GB');

        header.appendChild(topicSpan);
        header.appendChild(timeSpan);
        
        const pre = document.createElement('pre');
        try {
            const jsonObj = JSON.parse(entry.payload);
            const prettyPayload = JSON.stringify(jsonObj, null, 2);
            pre.innerHTML = highlightText(prettyPayload, searchTerm);
        } catch(e) {
            pre.innerHTML = highlightText(entry.payload, searchTerm);
        }

        div.appendChild(header);
        div.appendChild(pre);
        
        historyLogContainer.appendChild(div);
    }

    // --- [NOUVEAU] SVG Replay Logic ---

    svgHistoryToggle?.addEventListener('change', (e) => {
        isSvgHistoryMode = e.target.checked;
        svgTimelineSlider.style.display = isSvgHistoryMode ? 'flex' : 'none';
        
        // Au changement, on rejoue l'état jusqu'à la fin pour être synchronisé
        replaySvgHistory(maxTimestamp);
    });

    function updateSvgTimelineUI() {
        if (!svgHandle || !isSvgHistoryMode) return;
        
        const timeRange = maxTimestamp - minTimestamp;
        if (timeRange <= 0) return;

        const currentPercent = ((svgHandle.dataset.timestamp || maxTimestamp) - minTimestamp) / timeRange * 100;
        svgHandle.style.left = `${currentPercent}%`;
        svgLabel.textContent = formatTimestampForLabel(parseFloat(svgHandle.dataset.timestamp || maxTimestamp));
    }

    function replaySvgHistory(replayUntilTimestamp) {
        if (!svgContent) return;

        // 1. Réinitialiser le SVG à son état initial
        svgInitialTextValues.forEach((text, element) => {
            element.textContent = text;
        });

        // 2. Filtrer les messages jusqu'au timestamp de rejeu
        const entriesToReplay = allHistoryEntries.filter(e => e.timestampMs <= replayUntilTimestamp);
        
        // 3. Déterminer l'état final de chaque topic à cet instant T
        const finalState = new Map();
        // Itérer à l'envers (du plus ancien au plus récent) pour que la dernière valeur écrase les précédentes
        for (let i = entriesToReplay.length - 1; i >= 0; i--) {
            const entry = entriesToReplay[i];
            finalState.set(entry.topic, entry.payload);
        }

        // 4. Appliquer l'état final à la vue SVG
        finalState.forEach((payload, topic) => {
            updateMap(topic, payload);
        });
    }

    function makeSvgSliderDraggable(handle) {
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const sliderRect = svgTimelineSlider.getBoundingClientRect();

            const onMouseMove = (moveEvent) => {
                let x = moveEvent.clientX - sliderRect.left;
                let percent = (x / sliderRect.width) * 100;
                percent = Math.max(0, Math.min(100, percent));
                
                const timeRange = maxTimestamp - minTimestamp;
                const newTimestamp = minTimestamp + (timeRange * percent / 100);

                handle.style.left = `${percent}%`;
                handle.dataset.timestamp = newTimestamp;
                svgLabel.textContent = formatTimestampForLabel(newTimestamp);

                replaySvgHistory(newTimestamp); // Rejoue l'historique pendant le déplacement
            };
            
            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }
    if (svgHandle) {
        makeSvgSliderDraggable(svgHandle);
    }


    // --- SVG Plan Update Logic ---
    function updateMap(topic, payload) {
        try {
            const data = JSON.parse(payload);
            const svgId = topic.replace(/\//g, '-');
            const groupElement = svgContent?.querySelector(`#${svgId}`);
            if (!groupElement) return;

            for (const key in data) {
                const textElement = groupElement.querySelector(`[data-key="${key}"]`);
                if (textElement) textElement.textContent = data[key];
            }

            groupElement.classList.add('highlight-svg');
            setTimeout(() => groupElement.classList.remove('highlight-svg'), 500);
        } catch (e) { /* Payload is not JSON, ignore for map */ }
    }

    // --- Logique pour afficher/masquer l'historique récent ---
    function toggleRecentHistoryVisibility() {
        if (!topicHistoryContainer) return;
        const isLive = livePayloadToggle.checked;
        topicHistoryContainer.style.display = isLive ? 'none' : 'flex'; 
        document.getElementById('drag-handle-horizontal').style.display = isLive ? 'none' : 'flex';
    }

    // --- Payload Display & Interaction Logic ---
    livePayloadToggle?.addEventListener('change', (event) => {
        if (event.target.checked && selectedNodeContainer) {
            selectedNodeContainer.classList.remove('selected');
            selectedNodeContainer = null;
        }
        toggleRecentHistoryVisibility();
    });
    toggleRecentHistoryVisibility();

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
    
    function updateTopicHistory(topic, data) {
        if (!topicHistoryLog) return;
        topicHistoryLog.innerHTML = '';

        if (!data || data.length === 0) {
            const p = document.createElement('p');
            p.className = 'history-placeholder';
            p.textContent = `No recent history for ${topic}.`;
            topicHistoryLog.appendChild(p);
            return;
        }

        data.forEach(entry => {
            const div = document.createElement('div');
            div.className = 'topic-history-entry';

            const timeSpan = document.createElement('span');
            timeSpan.className = 'history-entry-timestamp';
            timeSpan.textContent = new Date(entry.timestamp).toLocaleTimeString('en-GB');

            const pre = document.createElement('pre');
            pre.className = 'history-entry-payload';
            try {
                const jsonObj = JSON.parse(entry.payload);
                pre.textContent = JSON.stringify(jsonObj, null, 2);
            } catch(e) {
                pre.textContent = entry.payload;
            }
            
            div.appendChild(timeSpan);
            div.appendChild(pre);
            topicHistoryLog.appendChild(div);
        });
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
        
        const parts = topic.split('/').map(part => part.replace(/\./g, '_'));

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
                nodeName.textContent = topic.split('/')[index];

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
            livePayloadToggle.dispatchEvent(new Event('change'));
        }
        
        const topic = targetContainer.dataset.topic;
        const payload = targetContainer.dataset.payload;
        displayPayload(topic, payload);

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'get-topic-history', topic: topic }));
        }
    }

    // --- Logique de redimensionnement des panneaux ---
    const resizerVertical = document.getElementById('drag-handle-vertical');
    const resizerHorizontal = document.getElementById('drag-handle-horizontal');

    // Redimensionnement Vertical
    const resizeVertical = (e) => {
        const treeViewWidth = e.pageX - treeContainer.getBoundingClientRect().left;
        treeContainer.style.flexBasis = `${treeViewWidth}px`;
    };

    resizerVertical?.addEventListener('mousedown', (e) => {
        e.preventDefault();
        document.addEventListener('mousemove', resizeVertical);
        document.addEventListener('mouseup', () => {
            document.removeEventListener('mousemove', resizeVertical);
        });
    });

    // Redimensionnement Horizontal
    const resizeHorizontal = (e) => {
        const payloadAreaHeight = e.pageY - payloadContainer.getBoundingClientRect().top;
        payloadMainArea.style.flexBasis = `${payloadAreaHeight}px`;
    };

    resizerHorizontal?.addEventListener('mousedown', (e) => {
        e.preventDefault();
        document.addEventListener('mousemove', resizeHorizontal);
        document.addEventListener('mouseup', () => {
            document.removeEventListener('mousemove', resizeHorizontal);
        });
    });
});