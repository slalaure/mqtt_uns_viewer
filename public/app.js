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
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOTT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// --- [NEW] Module Imports ---
// Import shared utilities
import { mqttPatternToRegex, mqttPatternToClientRegex, formatTimestampForLabel } from './utils.js';
// Import view-specific modules
import { initSvgView, updateMap, updateSvgTimelineUI, setSvgHistoryData as setSvgHistoryModuleData } from './view.svg.js';
import { initHistoryView, setHistoryData } from './view.history.js';
// [MODIFIED] Add import for new mapper module
import {
    initMapperView,
    updateMapperMetrics,
    updateMapperConfig,
    handleMapperNodeClick,
    getMapperConfig,
    getMappedTargetTopics,
    getTopicMappingStatus,
    addMappedTargetTopic
} from './view.mapper.js';
// --- [END NEW] ---


document.addEventListener('DOMContentLoaded', () => {
    let recentlyPrunedPatterns = new Set();
    const PRUNE_IGNORE_DURATION_MS = 10000; // Ignore re-appearing messages for 10 seconds
    let subscribedTopicPatterns = ['#']; // [NEW] Default fallback
    
    // --- [NEW] Global variable for the application's base path ---
    let appBasePath = '/';
    
    // --- Dark Theme Logic ---
    const darkModeToggle = document.getElementById('dark-mode-toggle');

    const enableDarkMode = () => {
        document.body.classList.add('dark-mode');
        localStorage.setItem('theme', 'dark');
        if (darkModeToggle) darkModeToggle.checked = true;
    };

    const disableDarkMode = () => {
        document.body.classList.remove('dark-mode');
        localStorage.setItem('theme', 'light');
        if (darkModeToggle) darkModeToggle.checked = false;
    };

    // Apply saved theme on load
    if (localStorage.getItem('theme') === 'dark') {
        enableDarkMode();
    }

    // Add event listener for the toggle
    darkModeToggle?.addEventListener('change', () => {
        if (darkModeToggle.checked) {
            enableDarkMode();
        } else {
            disableDarkMode();
        }
    });


    // --- DOM Element Initialization ---
    const datetimeContainer = document.getElementById('current-datetime');

    // --- Tree View Elements ---
    const treeViewWrapper = document.querySelector('.tree-view-wrapper');
    const treeContainer = document.getElementById('mqtt-tree'); // This is the main tree
    const payloadContainer = document.getElementById('payload-display');
    const payloadMainArea = document.getElementById('payload-main-area');
    const payloadContent = document.getElementById('payload-content');
    const payloadTopic = document.getElementById('payload-topic');
    const livePayloadToggle = document.getElementById('live-payload-toggle');
    const topicHistoryContainer = document.getElementById('topic-history-container');
    const topicHistoryLog = document.getElementById('topic-history-log');
    let selectedNodeContainer = null;
    const treeFilterInput = document.getElementById('tree-filter-input');
    const btnExpandAll = document.getElementById('btn-expand-all');
    const btnCollapseAll = document.getElementById('btn-collapse-all');

    // --- Tab Navigation ---
    const btnTreeView = document.getElementById('btn-tree-view');
    const btnMapView = document.getElementById('btn-map-view');
    const btnHistoryView = document.getElementById('btn-history-view');
    const btnMapperView = document.getElementById('btn-mapper-view');
    const treeView = document.getElementById('tree-view');
    const mapView = document.getElementById('map-view');
    const historyView = document.getElementById('history-view');
    const mapperView = document.getElementById('mapper-view');

    // --- History View Elements (Shared) ---
    const historyTotalMessages = document.getElementById('history-total-messages');
    const historyDbSize = document.getElementById('history-db-size');
    const historyDbLimit = document.getElementById('history-db-limit');
    const pruningIndicator = document.getElementById('pruning-indicator');

    // --- History State ---
    let allHistoryEntries = [];
    let minTimestamp = 0;
    let maxTimestamp = 0;
    let currentMinTimestamp = 0;
    let currentMaxTimestamp = 0;

    // --- Simulator UI Elements ---
    const btnStartSim = document.getElementById('btn-start-sim');
    const btnStopSim = document.getElementById('btn-stop-sim');
    const simStatusIndicator = document.getElementById('sim-status');
    const simulatorControls = document.querySelector('.simulator-controls');

    // --- [REMOVED] Mapper View Elements ---
    // (This logic is now in public/view.mapper.js)
    const mapperTreeContainer = document.getElementById('mapper-tree');
    // ... all other mapper elements removed ...
    
    // --- [REMOVED] Mapper State ---
    // (This logic is now in public/view.mapper.js)

    // --- [REMOVED] Delete Modal Elements ---
    // (This logic is now in public/view.mapper.js)


    // --- Tab Switching Logic ---
    function switchView(viewToShow) {
        const views = [treeView, mapView, historyView, mapperView];
        const buttons = [btnTreeView, btnMapView, btnHistoryView, btnMapperView];

        let targetView, targetButton;
        if (viewToShow === 'map') {
            targetView = mapView;
            targetButton = btnMapView;
        } else if (viewToShow === 'history') {
            targetView = historyView;
            targetButton = btnHistoryView;
        } else if (viewToShow === 'mapper') {
            targetView = mapperView;
            targetButton = btnMapperView;
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
    btnMapperView?.addEventListener('click', () => switchView('mapper'));

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
    btnStartSim?.addEventListener('click', () => fetch('api/simulator/start', { method: 'POST' }));
    btnStopSim?.addEventListener('click', () => fetch('api/simulator/stop', { method: 'POST' }));

    // --- WebSocket Connection ---
    let ws; // Declare ws variable in the outer scope
    
    // 1. Fetch config first to get base path
    (async () => {
        let configResponse;
        try {
            configResponse = await fetch('api/config');
            if (!configResponse.ok) throw new Error('Failed to fetch config');
            const appConfig = await configResponse.json();
            
            // Set global base path
            appBasePath = appConfig.basePath || '/';
            
            // Now connect to WebSocket using the correct path
            const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${wsProtocol}//${window.location.host}${appBasePath}`;
            
            console.log(`Connecting to WebSocket at: ${wsUrl}`);
            ws = new WebSocket(wsUrl);

            // Assign handlers
            ws.onopen = () => {
                console.log("Connected to WebSocket server.");
                // Now run the *rest* of the initialization
                finishInitialization(appConfig); 
            };

            ws.onmessage = async (event) => {
                const dataText = event.data instanceof Blob ? await event.data.text() : event.data;
                try {
                    const message = JSON.parse(dataText);

                    switch(message.type) {
                        case 'mqtt-message': {
                            // ---  Check if topic was recently pruned ---
                            let ignoreForTreeUpdate = false; // Renamed variable for clarity
                            for (const pattern of recentlyPrunedPatterns) {
                                try {
                                        // [MODIFIED] Use imported function
                                        const regex = mqttPatternToRegex(pattern); // Use existing regex function
                                        if (regex.test(message.topic)) {
                                            console.warn(`Ignoring tree update for recently pruned topic: ${message.topic} (matches pattern: ${pattern})`);
                                            ignoreForTreeUpdate = true; // Flag to skip tree updates only
                                            break;
                                        }
                                } catch (e) {
                                        console.error("Error creating regex for pruned pattern check:", pattern, e);
                                }
                            }
                            // --- [END] Check ---

                            // --- [MODIFIED] SVG Update ---
                            updateMap(message.topic, message.payload);
                            // --- End SVG Update ---

                            // --- History Update (Happens *before* potentially skipping tree update) ---
                            // message.payload is already a string here
                            const newEntry = { ...message, timestampMs: new Date(message.timestamp).getTime() };
                            const wasLive = currentMaxTimestamp === maxTimestamp;
                            allHistoryEntries.unshift(newEntry);
                            
                            // [MODIFIED] Send data to history module and get back new state
                            const newState = setHistoryData(allHistoryEntries, false, wasLive);
                            minTimestamp = newState.min;
                            maxTimestamp = newState.max;
                            currentMinTimestamp = newState.currentMin;
                            currentMaxTimestamp = newState.currentMax;
                            // [END MODIFIED]
                            
                            // [MODIFIED] Push new history data to modules
                            setSvgHistoryModuleData(allHistoryEntries);
                            
                            // [MODIFIED] Call imported function
                            updateSvgTimelineUI(minTimestamp, maxTimestamp);
                            // --- End History Update ---


                            // --- Tree Updates (Potentially Skipped) ---
                            if (!ignoreForTreeUpdate) {
                                    const options = {
                                        enableAnimations: true,
                                        // [MODIFIED] Get config/topics from mapper module
                                        rulesConfig: getMapperConfig(),
                                        targetTopics: getMappedTargetTopics()
                                    };
                                    // Update main tree
                                    updateTree(message.topic, message.payload, message.timestamp, treeContainer, options);

                                    // Update mapper tree (no animations)
                                    options.enableAnimations = false;
                                    updateTree(message.topic, message.payload, message.timestamp, mapperTreeContainer, options);
                            }
                            // --- End Tree Updates ---

                            break; // End of 'mqtt-message' case
                        }
                        case 'simulator-status':
                            updateSimulatorStatusUI(message.status);
                            break;
                        case 'history-initial-data':
                            // Server now sends string payloads, so no special mapping needed
                            allHistoryEntries = message.data.map(entry => ({ ...entry, timestampMs: new Date(entry.timestamp).getTime() }));
                            
                            // [MODIFIED] Push new history data to modules
                            setSvgHistoryModuleData(allHistoryEntries);
                            
                            // [MODIFIED] Send data to history module and get back new state
                            const newState = setHistoryData(allHistoryEntries, true, true);
                            minTimestamp = newState.min;
                            maxTimestamp = newState.max;
                            currentMinTimestamp = newState.currentMin;
                            currentMaxTimestamp = newState.currentMax;

                            // [MODIFIED] Call imported function
                            updateSvgTimelineUI(minTimestamp, maxTimestamp);
                            
                            // [MODIFIED] We now use 'tree-initial-state' to populate the tree
                            break;
                        case 'tree-initial-state': {
                            console.log(`Received initial tree state with ${message.data.length} topics.`);
                            const options = {
                                enableAnimations: false,
                                rulesConfig: getMapperConfig(),
                                targetTopics: getMappedTargetTopics()
                            };

                            // Server already sorts by topic ASC
                            for (const entry of message.data) {
                                // payload is already a string from the server
                                updateTree(entry.topic, entry.payload, entry.timestamp, treeContainer, options);
                                updateTree(entry.topic, entry.payload, entry.timestamp, mapperTreeContainer, options);
                            }
                            break;
                        }
                        case 'topic-history-data':
                            // Server now sends string payloads
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

                        // --- [MODIFIED] Mapper Messages ---
                        case 'mapper-config-update':
                            // Pass the new config to the mapper module
                            updateMapperConfig(message.config);
                            break;
                        case 'mapped-topic-generated':
                            // Pass the new topic to the mapper module
                            addMappedTargetTopic(message.topic);
                            break;
                        case 'mapper-metrics-update':
                            // Pass the new metrics to the mapper module
                            updateMapperMetrics(message.metrics);
                            break;
                    }
                } catch (e) {
                    console.error("JSON Parsing Error:", dataText, e);
                }
            };
            
            ws.onerror = (err) => {
                console.error("WebSocket Error:", err);
            };

            ws.onclose = () => {
                console.log("WebSocket connection closed. Attempting to reconnect...");
                // Implement a backoff strategy here if needed
                setTimeout(startAppAndWebSocket, 3000); // Re-run the whole connect logic
            };

        } catch (error) {
            console.error("Failed to fetch initial app configuration:", error);
            // Handle fatal error (e.g., show an overlay)
        }
    })();
    
    // [NEW] This function contains the rest of the original initializeApp()
    async function finishInitialization(appConfig) {
        try {
            // --- Hide/Show tabs based on config ---
            btnTreeView?.classList.remove('active');
            treeView?.classList.remove('active');

            let defaultViewActivated = false;

            if (appConfig.viewTreeEnabled) {
                btnTreeView.style.display = 'block'; 
                if (!defaultViewActivated) {
                    switchView('tree');
                    defaultViewActivated = true;
                }
            } else {
                btnTreeView.style.display = 'none';
            }

            if (appConfig.viewSvgEnabled) {
                btnMapView.style.display = 'block';
                if (!defaultViewActivated) {
                    switchView('map');
                    defaultViewActivated = true;
                }
            } else {
                btnMapView.style.display = 'none';
            }

            if (appConfig.viewHistoryEnabled) {
                btnHistoryView.style.display = 'block';
                if (!defaultViewActivated) {
                    switchView('history');
                    defaultViewActivated = true;
                }
            } else {
                btnHistoryView.style.display = 'none';
            }

            if (appConfig.viewMapperEnabled) {
                btnMapperView.style.display = 'block';
                if (!defaultViewActivated) {
                    switchView('mapper');
                    defaultViewActivated = true;
                }
            } else {
                btnMapperView.style.display = 'none';
            }
            
            if (!defaultViewActivated) {
                    switchView('tree');
                    console.warn("All views are disabled in configuration.");
            }

            // --- [MODIFIED] Initialize modules ---
            initSvgView(appConfig);
            initHistoryView(); // Init history view listeners
            
            // Init mapper view, passing callbacks it needs from the main app
            initMapperView({
                pruneTopicFromFrontend: pruneTopicFromFrontend,
                getSubscribedTopics: () => subscribedTopicPatterns,
                colorAllTrees: () => {
                    colorTreeNodes(treeContainer);
                    colorTreeNodes(mapperTreeContainer);
                },
                addPruneIgnorePattern: (pattern) => {
                    recentlyPrunedPatterns.add(pattern);
                    console.log(`Added pattern to ignore list: ${pattern}`);
                    setTimeout(() => {
                        recentlyPrunedPatterns.delete(pattern);
                        console.log(`Removed pattern from ignore list: ${pattern}`);
                    }, PRUNE_IGNORE_DURATION_MS);
                },
                displayPayload: displayPayload // Pass the shared displayPayload function
            });
            // --- [END MODIFIED] ---
            
            // --- Store subscribed topics ---
            if (appConfig.subscribedTopics) {
                subscribedTopicPatterns = appConfig.subscribedTopics.split(',').map(t => t.trim());
                console.log("Subscribed Topic Patterns:", subscribedTopicPatterns);
            } else {
                    console.warn("Could not retrieve subscribed topics from API.");
                    subscribedTopicPatterns = ['#']; 
            }
            
            // --- Simulator Status ---
            if (appConfig.isSimulatorEnabled && simulatorControls) {
                simulatorControls.style.display = 'flex';
                // Fetch is relative, will use base path correctly
                const statusRes = await fetch('api/simulator/status'); 
                const statusData = await statusRes.json();
                updateSimulatorStatusUI(statusData.status);
            }
        } catch (error) {
            console.error("Failed to finish app initialization:", error);
        }
        
        // [REMOVED] loadMapperConfig(); // (Now handled by initMapperView)
    }
    // --- [END NEW] Revised Initialization Logic ---


    // --- Payload Display & Interaction Logic (Tree View) ---
    livePayloadToggle?.addEventListener('change', (event) => {
        if (event.target.checked && selectedNodeContainer) {
            selectedNodeContainer.classList.remove('selected');
            selectedNodeContainer = null;
        }
        toggleRecentHistoryVisibility();
    });
    toggleRecentHistoryVisibility();

    function toggleRecentHistoryVisibility() {
        if (!topicHistoryContainer) return;
        const isLive = livePayloadToggle.checked;
        topicHistoryContainer.style.display = isLive ? 'none' : 'flex';
        document.getElementById('drag-handle-horizontal').style.display = isLive ? 'none' : 'flex';
    }

    /**
     * [SHARED] Displays a payload in a given DOM element.
     * @param {string} topic - The topic string.
     * @param {string} payload - The payload string.
     * @param {HTMLElement} topicEl - The element to show the topic in.
     * @param {HTMLElement} contentEl - The <pre> element for the content.
     */
    function displayPayload(topic, payload, topicEl, contentEl) {
        if (topicEl) {
            topicEl.textContent = topic || "No topic selected";
        }
        if (contentEl) {
            if (payload === undefined || payload === null) {
                contentEl.textContent = "Select a topic with data to see its payload.";
                return;
            }
            try {
                // payload is expected to be a string
                const jsonObj = JSON.parse(payload);
                contentEl.textContent = JSON.stringify(jsonObj, null, 2);
            } catch (e) {
                contentEl.textContent = payload; // It's a raw string
            }
        }
    }

    function updateTopicHistory(topic, data) {
        if (!topicHistoryLog) return;
        topicHistoryLog.innerHTML = '';
        if (!data || data.length === 0) {
            topicHistoryLog.innerHTML = `<p class="history-placeholder">No recent history for ${topic}.</p>`;
            return;
        }
        data.forEach(entry => {
            const div = document.createElement('div');
            div.className = 'topic-history-entry';
            div.innerHTML = `
                <span class="history-entry-timestamp">${new Date(entry.timestamp).toLocaleTimeString('en-GB')}</span>
                <pre class="history-entry-payload"></pre>
            `;
            const pre = div.querySelector('.history-entry-payload');
            try {
                 // entry.payload is a string from the server
                pre.textContent = JSON.stringify(JSON.parse(entry.payload), null, 2);
            } catch(e) {
                pre.textContent = entry.payload; // It's a raw string
            }
            topicHistoryLog.appendChild(div);
        });
    }

    // --- [NEW V2] Unified Tree View Function ---

    /**
     * [SHARED] Recursively colors all nodes in a tree based on mapping rules.
     * @param {HTMLElement} treeRoot The root <ul> element of the tree.
     */
    function colorTreeNodes(treeRoot) {
        if (!treeRoot) return;

        const allNodes = treeRoot.querySelectorAll('li');
        allNodes.forEach(li => {
            const nodeContainer = li.querySelector(':scope > .node-container');
            if (!nodeContainer || !nodeContainer.dataset.topic) return;

            const topic = nodeContainer.dataset.topic;
            // [MODIFIED] Use imported function from mapper module
            const status = getTopicMappingStatus(topic);

            li.classList.remove('mapped-source', 'mapped-target');
            if (status === 'source') {
                li.classList.add('mapped-source');
            } else if (status === 'target') {
                li.classList.add('mapped-target');
            }
        });
    }

    /**
     * Creates or updates a node in one of the trees.
     * @param {string} topic Full topic string.
     * @param {string} payload The payload string.
     * @param {string} timestamp ISO timestamp.
     * @param {HTMLElement} treeRoot The root <ul> element of the tree (e.g., treeContainer or mapperTreeContainer).
     * @param {object} options Options object (e.g., enableAnimations).
     */
    function updateTree(topic, payload, timestamp, treeRoot, options = {}) {
        if (!treeRoot) return;

        // [MODIFIED] Options are now passed in from the ws handler
        const { enableAnimations = false, rulesConfig = null, targetTopics = new Set() } = options;

        const parts = topic.split('/');
        let currentTopicPath = '';
        let currentNode = treeRoot;
        const affectedNodes = [];
        const formattedTimestamp = new Date(timestamp).toLocaleTimeString('en-GB');

        parts.forEach((part, index) => {
            currentTopicPath += (index > 0 ? '/' : '') + part;
            const isLastPart = index === parts.length - 1;
            // Ensure unique ID per tree
            const partId = 'node-' + treeRoot.id + '-' + currentTopicPath.replace(/[^a-zA-Z0-9_-]/g, '_');


            let ul = currentNode.querySelector(':scope > ul');
            if (!ul) {
                ul = document.createElement('ul');
                currentNode.appendChild(ul);
            }

            let li = ul.querySelector(`:scope > li#${partId}`);
            let isNewNode = false;

            if (!li) {
                isNewNode = true;
                li = document.createElement('li');
                li.id = partId;
                if (enableAnimations) li.classList.add('new-node');

                const nodeContainer = document.createElement('div');
                nodeContainer.className = 'node-container';

                if (treeRoot === treeContainer) { // Main Tree (ID: mqtt-tree)
                    nodeContainer.innerHTML = `
                        <input type="checkbox" class="node-filter-checkbox" checked>
                        <span class="node-name"></span>
                        <span class="node-timestamp"></span>
                    `;
                    nodeContainer.querySelector('.node-filter-checkbox').addEventListener('click', handleCheckboxClick);
                    nodeContainer.addEventListener('click', handleNodeClick); // Main tree click
                } else { // Mapper Tree (ID: mapper-tree)
                    nodeContainer.innerHTML = `
                        <span class="node-name"></span>
                        <span class="node-timestamp"></span>
                    `;
                    // [MODIFIED] Attach imported handler
                    nodeContainer.addEventListener('click', handleMapperNodeClick);
                }

                nodeContainer.querySelector('.node-name').textContent = part;
                nodeContainer.dataset.topic = currentTopicPath; // Store full path
                li.appendChild(nodeContainer);
                ul.appendChild(li);
            }

            // Apply coloring
            // [MODIFIED] Use imported function
            const mappingStatus = getTopicMappingStatus(currentTopicPath);
            li.classList.remove('mapped-source', 'mapped-target');
            if (mappingStatus === 'source') li.classList.add('mapped-source');
            else if (mappingStatus === 'target') li.classList.add('mapped-target');

            const nodeContainer = li.querySelector('.node-container');
            const timestampSpan = nodeContainer.querySelector('.node-timestamp');
            if(timestampSpan) timestampSpan.textContent = formattedTimestamp;
            affectedNodes.push({ element: li, isNew: isNewNode });

            // Store payload on the node container regardless of file/folder
            // payload is a string
            nodeContainer.dataset.payload = payload;

            if (isLastPart) {
                li.classList.add('is-file');
                li.classList.remove('is-folder', 'collapsed');
            } else {
                li.classList.add('is-folder');
                if (treeRoot === treeContainer) { // Only main tree supports collapse click
                    if (!nodeContainer.dataset.folderListener) {
                            nodeContainer.addEventListener('click', handleNodeClick);
                            nodeContainer.dataset.folderListener = 'true';
                    }
                } else { // Mapper tree folders are just for navigation
                    // [MODIFIED] Attach imported handler
                    nodeContainer.addEventListener('click', handleMapperNodeClick);
                }
            }
            currentNode = li;
        });

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

        // Live update for Tree View
        if (enableAnimations && livePayloadToggle?.checked && isTopicVisible(currentNode)) {
            const totalAnimationTime = affectedNodes.length * 150;
            setTimeout(() => {
                displayPayload(topic, payload, payloadTopic, payloadContent);
            }, totalAnimationTime);
        }
    }


    // --- Tree View Specific Click Handlers ---
    function handleCheckboxClick(event) {
        event.stopPropagation();
        const checkbox = event.target;
        const isChecked = checkbox.checked;
        const li = checkbox.closest('li');
        if (li) {
            li.querySelectorAll('.node-filter-checkbox').forEach(cb => cb.checked = isChecked);
        }
    }

    function isTopicVisible(targetLi) {
        let currentNode = targetLi;
        while (currentNode && currentNode !== treeContainer) { // Check up to the tree root
            const checkbox = currentNode.querySelector(':scope > .node-container > .node-filter-checkbox');
            // If any parent checkbox is unchecked, it's not visible
            if (checkbox && !checkbox.checked) return false;
            // Move up to the parent li
            currentNode = currentNode.parentElement.closest('li');
        }
        return true; // If we reached the root or top, it's visible
    }


    function handleNodeClick(event) {
        const targetContainer = event.currentTarget;
        const li = targetContainer.closest('li');

        // Folder click in Tree View (Collapse/Expand)
        if (li.classList.contains('is-folder') && event.target.closest('.node-name')) {
                if (li.id.startsWith('node-mqtt-tree')) { // Only collapse/expand main tree
                    li.classList.toggle('collapsed');
                }
            return; // Don't process further for folder clicks in main tree
        }

        // File click in Tree View (Show Payload/History)
        if (li.classList.contains('is-file') && li.id.startsWith('node-mqtt-tree')) {
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
            const payload = targetContainer.dataset.payload; // This is a string
            displayPayload(topic, payload, payloadTopic, payloadContent);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'get-topic-history', topic: topic }));
            }
        }
    }

    // --- Tree Controls Logic (Tree View) ---
    btnExpandAll?.addEventListener('click', () => {
        treeContainer?.querySelectorAll('.is-folder').forEach(folderLi => {
            folderLi.classList.remove('collapsed');
        });
    });
    btnCollapseAll?.addEventListener('click', () => {
        treeContainer?.querySelectorAll('.is-folder').forEach(folderLi => {
            folderLi.classList.add('collapsed');
        });
    });
    treeFilterInput?.addEventListener('input', () => {
        const filterText = treeFilterInput.value.toLowerCase();
        const allNodes = treeContainer?.querySelectorAll('#mqtt-tree > ul > li');
        if (!allNodes) return;
        allNodes.forEach(node => filterNode(node, filterText));
    });

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

    // --- [REMOVED] Mapper View Logic ---
    // (This logic is now in public/view.mapper.js)
    
    // --- [REMOVED] Delete Modal Logic ---
    // (This logic is now in public/view.mapper.js)


    /**
     * [SHARED] Rebuilds both trees from the filtered history.
     */
    function populateTreesFromHistory() {
        // 1. Wipe both trees
        if(treeContainer) treeContainer.innerHTML = '';
        if(mapperTreeContainer) mapperTreeContainer.innerHTML = '';

        // 2. Get latest entry for each topic from filtered history
        const uniqueTopics = new Map();
        // allHistoryEntries is [newest, ..., oldest]
        // Iterate chronologically (from oldest to newest) to get the latest
        for (let i = allHistoryEntries.length - 1; i >= 0; i--) { // Iterates from oldest (end of array)
            const entry = allHistoryEntries[i];
            // [FIX] Always set, overwriting older ones. The last one set (newest) will be kept.
            uniqueTopics.set(entry.topic, entry);
        }


        // 3. Re-populate both trees (no animations)
        const options = {
            enableAnimations: false,
            // [MODIFIED] Get config/topics from mapper module
            rulesConfig: getMapperConfig(),
            targetTopics: getMappedTargetTopics()
        };
        console.log("Repopulated trees from history."); // Add log

        // Sort topics alphabetically before populating for consistent order
        const sortedTopics = Array.from(uniqueTopics.keys()).sort();

        for (const topic of sortedTopics) {
                const entry = uniqueTopics.get(topic);
                // entry.payload is a string because 'history-initial-data' and 'mqtt-message'
                // both store strings in allHistoryEntries
                updateTree(topic, entry.payload, entry.timestamp, treeContainer, options);
                updateTree(topic, entry.payload, entry.timestamp, mapperTreeContainer, options);
            }
    }

    /**
     * [SHARED] Filters frontend data stores and rebuilds trees after a prune.
     * This function is passed as a callback to the mapper module.
     * @param {string} topicPattern - The MQTT pattern to prune.
     */
    async function pruneTopicFromFrontend(topicPattern) {
        console.log(`Pruning frontend with pattern: ${topicPattern}`);
        // [MODIFIED] Use imported function
        const regex = mqttPatternToRegex(topicPattern);

        const initialLength = allHistoryEntries.length;
        // allHistoryEntries entries have string payloads, this filter is fine
        allHistoryEntries = allHistoryEntries.filter(entry => !regex.test(entry.topic));
        console.log(`Filtered allHistoryEntries: ${initialLength} -> ${allHistoryEntries.length}`);

        // [MODIFIED] Push pruned history data to modules
        setSvgHistoryModuleData(allHistoryEntries);
        // [MODIFIED] Update history view with pruned data
        const newState = setHistoryData(allHistoryEntries, false, false); // Not initial load, not live
        minTimestamp = newState.min;
        maxTimestamp = newState.max;
        currentMinTimestamp = newState.currentMin;
        currentMaxTimestamp = newState.currentMax;
        // [END MODIFIED]

        // 2. Filter mappedTargetTopics
        const topicsToRemove = [];
        // [MODIFIED] Get topics from mapper module
        getMappedTargetTopics().forEach(topic => {
            if (regex.test(topic)) {
                topicsToRemove.push(topic);
            }
        });
        // This needs to be handled *inside* the mapper module.
        // Let's adjust. The mapper module should expose a function for this.
        // For now, we'll just re-build the tree, which is the most important part.
        // We will refine this in the next step.
        
        // This is a temporary fix:
        const newMappedTopics = getMappedTargetTopics();
        topicsToRemove.forEach(topic => newMappedTopics.delete(topic));
        console.log(`Removed target topics matching pattern:`, topicsToRemove);


        // 3. Re-render history tab (already done by setHistoryData)

        // 4. Rebuild both trees from the filtered history
        populateTreesFromHistory(); // This now works correctly

        // 5. If the currently selected node in mapper was pruned, clear selection/editor
            // [MODIFIED] We need to ask the mapper module to clear its own state.
            // This is another refinement for the next step.
            // For now, this DOM check is "good enough"
            const selectedMapperNode = mapperTreeContainer.querySelector('.selected');
            if (selectedMapperNode && regex.test(selectedMapperNode.dataset.topic)) {
                console.log("Clearing selected mapper node.");
                selectedMapperNode.classList.remove('selected');
                // Manually clear the mapper payload display
                displayPayload(null, null, document.getElementById('mapper-payload-topic'), document.getElementById('mapper-payload-content'));
                document.getElementById('mapper-transform-placeholder').style.display = 'block';
                document.getElementById('mapper-transform-form').style.display = 'none';
            }

            // 6. If the currently selected node in treeview was pruned, clear selection
            if (selectedNodeContainer && regex.test(selectedNodeContainer.dataset.topic)) {
                console.log("Clearing selected treeview node.");
                selectedNodeContainer.classList.remove('selected');
                selectedNodeContainer = null;
                displayPayload(null, null, payloadTopic, payloadContent); // Clear payload display
                topicHistoryLog.innerHTML = '<p class="history-placeholder">Select a topic to see its recent history.</p>'; // Clear history log
            }
            console.log("Frontend prune finished.");
    }
    // --- [END MODAL LOGIC] ---


    // --- Panel Resizing Logic ---
    const resizerVertical = document.getElementById('drag-handle-vertical');
    const resizerHorizontal = document.getElementById('drag-handle-horizontal');
    const resizerVerticalMapper = document.getElementById('drag-handle-vertical-mapper');
    const resizerHorizontalMapper = document.getElementById('drag-handle-horizontal-mapper');

    // Vertical Resizing (generic function)
    const resizePanel = (e, panel) => {
        if (!panel) return;
        // Prevent resizing beyond reasonable limits if needed
        const minWidth = 200; // Example minimum width
        const containerRect = panel.parentElement.getBoundingClientRect();
        let panelWidth = e.pageX - panel.getBoundingClientRect().left;

        // Simple boundary check (can be made more sophisticated)
        if (panelWidth < minWidth) panelWidth = minWidth;
        // Ensure right panel also has min width
        if (containerRect.width - panelWidth < minWidth) {
                panelWidth = containerRect.width - minWidth;
        }

        panel.style.flexBasis = `${panelWidth}px`;
    }

    // Horizontal Resizing (generic function)
    const resizeHorizontalPanel = (e, topPanel, container) => {
            if (!topPanel || !container) return;
            const minHeight = 100; // Example minimum height
            const containerRect = container.getBoundingClientRect();
            let panelHeight = e.pageY - containerRect.top;

            if (panelHeight < minHeight) panelHeight = minHeight;
            // Ensure bottom panel also has min height
            if (containerRect.height - panelHeight < minHeight) {
                panelHeight = containerRect.height - minHeight;
            }

            topPanel.style.flexBasis = `${panelHeight}px`;
    };


    // Vertical Resizer (Tree View)
    if (resizerVertical) {
        resizerVertical.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const mouseMoveHandler = (ev) => resizePanel(ev, treeViewWrapper);
            const mouseUpHandler = () => {
                document.removeEventListener('mousemove', mouseMoveHandler);
                // No need to remove mouseup here due to { once: true }
            };
            document.addEventListener('mousemove', mouseMoveHandler);
            document.addEventListener('mouseup', mouseUpHandler, { once: true });
        });
    } else {
        console.error("Could not find element with ID 'drag-handle-vertical'");
    }

    // Vertical Resizer (Mapper View)
    if (resizerVerticalMapper) {
        resizerVerticalMapper.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const mouseMoveHandler = (ev) => resizePanel(ev, document.querySelector('.mapper-tree-wrapper')); // Use querySelector as element is in mapper module
                const mouseUpHandler = () => {
                document.removeEventListener('mousemove', mouseMoveHandler);
            };
            document.addEventListener('mousemove', mouseMoveHandler);
            document.addEventListener('mouseup', mouseUpHandler, { once: true });
        });
    } else {
        console.error("Could not find element with ID 'drag-handle-vertical-mapper'");
    }

    // Horizontal Resizer (Tree View)
    if (resizerHorizontal) {
        resizerHorizontal.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const mouseMoveHandler = (ev) => resizeHorizontalPanel(ev, payloadMainArea, payloadContainer);
                const mouseUpHandler = () => {
                document.removeEventListener('mousemove', mouseMoveHandler);
            };
            document.addEventListener('mousemove', mouseMoveHandler);
            document.addEventListener('mouseup', mouseUpHandler, { once: true });
        });
    } else {
        console.error("Could not find element with ID 'drag-handle-horizontal'");
    }

    // Horizontal Resizer (Mapper View)
    if (resizerHorizontalMapper) {
        resizerHorizontalMapper.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const mouseMoveHandler = (ev) => resizeHorizontalPanel(ev, document.getElementById('mapper-payload-area'), document.getElementById('mapper-payload-container'));
            const mouseUpHandler = () => {
                document.removeEventListener('mousemove', mouseMoveHandler);
            };
            document.addEventListener('mousemove', mouseMoveHandler);
            document.addEventListener('mouseup', mouseUpHandler, { once: true });
        });
    } else {
        console.error("Could not find element with ID 'drag-handle-horizontal-mapper'");
    }
});