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
// [MODIFIED] Import for Chart module
import { 
    initChartView, 
    handleChartNodeClick, 
    updateChartSliderUI, 
    getChartedTopics,
    pruneChartedVariables // [MODIFIED] Import pruneChartedVariables
} from './view.chart.js';
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
    const btnChartView = document.getElementById('btn-chart-view'); // [NEW]
    const treeView = document.getElementById('tree-view');
    const mapView = document.getElementById('map-view');
    const historyView = document.getElementById('history-view');
    const mapperView = document.getElementById('mapper-view');
    const chartView = document.getElementById('chart-view'); // [NEW]

    // --- History View Elements (Shared) ---
    const historyTotalMessages = document.getElementById('history-total-messages');
    const historyDbSize = document.getElementById('history-db-size');
    const historyDbLimit = document.getElementById('history-db-limit');
    const pruningIndicator = document.getElementById('pruning-indicator');

    // --- History State ---
    let allHistoryEntries = [];
    let minTimestamp = 0;
    let maxTimestamp = 0;
    // [MODIFIED] Removed currentMinTimestamp and currentMaxTimestamp
    // They are now managed internally by view.history.js

    // --- Simulator UI Elements ---
    const btnStartSim = document.getElementById('btn-start-sim');
    const btnStopSim = document.getElementById('btn-stop-sim');
    const simStatusIndicator = document.getElementById('sim-status');
    const simulatorControls = document.querySelector('.simulator-controls');

    // --- [REMOVED] Mapper View Elements ---
    const mapperTreeContainer = document.getElementById('mapper-tree');
    // [NEW] Chart View Elements
    const chartTreeContainer = document.getElementById('chart-tree');


    // --- Tab Switching Logic ---
    function switchView(viewToShow) {
        // [MODIFIED] Add chart view
        const views = [treeView, mapView, historyView, mapperView, chartView];
        const buttons = [btnTreeView, btnMapView, btnHistoryView, btnMapperView, btnChartView];

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
        } else if (viewToShow === 'chart') { // [NEW]
            targetView = chartView;
            targetButton = btnChartView;
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
    btnChartView?.addEventListener('click', () => switchView('chart')); // [NEW]

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
                            // [MODIFIED] Removed wasLive check.
                            allHistoryEntries.unshift(newEntry);
                            
                            // [MODIFIED] Send data to history module and get back new state
                            const newState = setHistoryData(allHistoryEntries, false); // Removed wasLive
                            minTimestamp = newState.min;
                            maxTimestamp = newState.max;
                            // [MODIFIED] Removed currentMin/MaxTimestamp updates
                            // [END MODIFIED]
                            
                            // [MODIFIED] Push new history data to modules
                            setSvgHistoryModuleData(allHistoryEntries);
                            
                            // [MODIFIED] Call imported function
                            updateSvgTimelineUI(minTimestamp, maxTimestamp);
                            updateChartSliderUI(minTimestamp, maxTimestamp, false); // [NEW]
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
                                    updateTree(message.topic, message.payload, message.timestamp, chartTreeContainer, options); // [NEW]
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
                            const newState = setHistoryData(allHistoryEntries, true); // Removed wasLive
                            minTimestamp = newState.min;
                            maxTimestamp = newState.max;
                            // [MODIFIED] Removed currentMin/MaxTimestamp updates

                            // [MODIFIED] Call imported function
                            updateSvgTimelineUI(minTimestamp, maxTimestamp);
                            updateChartSliderUI(minTimestamp, maxTimestamp, true); // [NEW]
                            
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
                                updateTree(entry.topic, entry.payload, entry.timestamp, chartTreeContainer, options); // [NEW]
                            }
                            
                            // [NEW] Color the chart tree after initial load
                            colorChartTree();
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

            // [NEW] Chart View Toggle
            if (appConfig.viewChartEnabled) {
                btnChartView.style.display = 'block';
                if (!defaultViewActivated) {
                    switchView('chart');
                    defaultViewActivated = true;
                }
            } else {
                btnChartView.style.display = 'none';
            }
            
            if (!defaultViewActivated) {
                    switchView('tree');
                    console.warn("All views are disabled in configuration.");
            }

            // --- [MODIFIED] Initialize modules ---
            initSvgView(appConfig);
            initHistoryView(); // Init history view listeners
            
            // Init mapper view
            initMapperView({
                pruneTopicFromFrontend: pruneTopicFromFrontend,
                getSubscribedTopics: () => subscribedTopicPatterns,
                colorAllTrees: () => {
                    colorTreeNodes(treeContainer);
                    colorTreeNodes(mapperTreeContainer);
                    // [NEW] color chart tree? No, chart tree doesn't need mapping colors.
                },
                addPruneIgnorePattern: (pattern) => {
                    recentlyPrunedPatterns.add(pattern);
                    console.log(`Added pattern to ignore list: ${pattern}`);
                    setTimeout(() => {
                        recentlyPrunedPatterns.delete(pattern);
                        console.log(`Removed pattern from ignore list: ${pattern}`);
                    }, PRUNE_IGNORE_DURATION_MS);
                },
                displayPayload: displayPayload
            });

            // [NEW] Init chart view
            initChartView({
                getHistory: () => allHistoryEntries,
                displayPayload: displayPayload, // Pass the shared displayPayload function
                colorChartTreeCallback: colorChartTree // [MODIFIED] Pass callback
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
     * [NEW] Colors the chart tree based on globally selected variables.
     */
    function colorChartTree() {
        if (!chartTreeContainer) return;
        
        const chartedTopics = getChartedTopics(); // Get the Set of topics
        if (chartedTopics.size === 0) {
            // Optimization: If no topics are selected, clear all highlights
            chartTreeContainer.querySelectorAll('.has-charted-variable').forEach(el => {
                el.classList.remove('has-charted-variable');
            });
            return;
        }

        chartTreeContainer.querySelectorAll('li').forEach(li => {
            const nodeContainer = li.querySelector(':scope > .node-container');
            if (!nodeContainer) return;
            const topic = nodeContainer.dataset.topic;
            if (!topic) return;

            let isOrHasChartedChild = false;
            // Check if this exact topic is selected
            if (chartedTopics.has(topic)) {
                isOrHasChartedChild = true;
            } else {
                // Check if this is a parent folder of a selected topic
                const folderPath = topic + '/';
                for (const t of chartedTopics) {
                    if (t.startsWith(folderPath)) {
                        isOrHasChartedChild = true;
                        break;
                    }
                }
            }

            // Toggle the class based on the result
            li.classList.toggle('has-charted-variable', isOrHasChartedChild);
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
                } else if (treeRoot === mapperTreeContainer) { // Mapper Tree (ID: mapper-tree)
                    nodeContainer.innerHTML = `
                        <span class="node-name"></span>
                        <span class="node-timestamp"></span>
                    `;
                    // [MODIFIED] Attach imported handler
                    nodeContainer.addEventListener('click', handleMapperNodeClick);
                } else if (treeRoot === chartTreeContainer) { // [NEW] Chart Tree (ID: chart-tree)
                    nodeContainer.innerHTML = `
                        <span class="node-name"></span>
                        <span class="node-timestamp"></span>
                    `;
                    // [NEW] Attach imported handler
                    nodeContainer.addEventListener('click', handleChartNodeClick);
                }

                nodeContainer.querySelector('.node-name').textContent = part;
                nodeContainer.dataset.topic = currentTopicPath; // Store full path
                li.appendChild(nodeContainer);
                ul.appendChild(li);
            }

            // [MODIFIED] Apply coloring (Mapper or Chart)
            if (treeRoot === mapperTreeContainer) {
                const mappingStatus = getTopicMappingStatus(currentTopicPath);
                li.classList.remove('mapped-source', 'mapped-target');
                if (mappingStatus === 'source') li.classList.add('mapped-source');
                else if (mappingStatus === 'target') li.classList.add('mapped-target');
            } else if (treeRoot === chartTreeContainer) {
                // Check chart status *only if* not animating
                // The main colorChartTree() function will handle this
                // to avoid performance issues on every single message.
                if (!enableAnimations) {
                    const chartedTopics = getChartedTopics();
                    let isOrHasChartedChild = false;
                    if (chartedTopics.has(currentTopicPath)) {
                        isOrHasChartedChild = true;
                    } else {
                        const folderPath = currentTopicPath + '/';
                        for (const t of chartedTopics) {
                            if (t.startsWith(folderPath)) {
                                isOrHasChartedChild = true;
                                break;
                            }
                        }
                    }
                    li.classList.toggle('has-charted-variable', isOrHasChartedChild);
                }
            }


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
                } else if (treeRoot === mapperTreeContainer) { // Mapper tree folders
                    // [MODIFIED] Attach imported handler
                    nodeContainer.addEventListener('click', handleMapperNodeClick);
                } else if (treeRoot === chartTreeContainer) { // [NEW] Chart tree folders
                    // [NEW] Attach imported handler
                    nodeContainer.addEventListener('click', handleChartNodeClick);
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

    /**
     * [SHARED] Rebuilds all trees from the filtered history.
     */
    function populateTreesFromHistory() {
        // 1. Wipe all trees
        if(treeContainer) treeContainer.innerHTML = '';
        if(mapperTreeContainer) mapperTreeContainer.innerHTML = '';
        if(chartTreeContainer) chartTreeContainer.innerHTML = ''; // [NEW]

        // 2. Get latest entry for each topic from filtered history
        const uniqueTopics = new Map();
        for (let i = allHistoryEntries.length - 1; i >= 0; i--) { 
            const entry = allHistoryEntries[i];
            uniqueTopics.set(entry.topic, entry);
        }


        // 3. Re-populate all trees (no animations)
        const options = {
            enableAnimations: false,
            rulesConfig: getMapperConfig(),
            targetTopics: getMappedTargetTopics()
        };
        console.log("Repopulated trees from history."); 

        const sortedTopics = Array.from(uniqueTopics.keys()).sort();

        for (const topic of sortedTopics) {
                const entry = uniqueTopics.get(topic);
                updateTree(topic, entry.payload, entry.timestamp, treeContainer, options);
                updateTree(topic, entry.payload, entry.timestamp, mapperTreeContainer, options);
                updateTree(topic, entry.payload, entry.timestamp, chartTreeContainer, options); // [NEW]
            }
        
        // [NEW] Re-color the chart tree after repopulating
        colorChartTree();
    }

    /**
     * [SHARED] Filters frontend data stores and rebuilds trees after a prune.
     * This function is passed as a callback to the mapper module.
     * @param {string} topicPattern - The MQTT pattern to prune.
     */
    async function pruneTopicFromFrontend(topicPattern) {
        console.log(`Pruning frontend with pattern: ${topicPattern}`);
        const regex = mqttPatternToRegex(topicPattern);

        const initialLength = allHistoryEntries.length;
        allHistoryEntries = allHistoryEntries.filter(entry => !regex.test(entry.topic));
        console.log(`Filtered allHistoryEntries: ${initialLength} -> ${allHistoryEntries.length}`);

        // [MODIFIED] Push pruned history data to modules
        setSvgHistoryModuleData(allHistoryEntries);
        
        // [MODIFIED] Update history view with pruned data
        const newState = setHistoryData(allHistoryEntries, false); // Not initial load
        minTimestamp = newState.min;
        maxTimestamp = newState.max;
        // [MODIFIED] Removed currentMin/MaxTimestamp updates

        // [NEW] Update chart slider
        updateChartSliderUI(minTimestamp, maxTimestamp, true);
        // [END MODIFIED]

        // [MODIFIED] Prune charted variables
        pruneChartedVariables(regex);
        // [END MODIFIED]

        // ... (Mapper topic filtering logic remains) ...
        const topicsToRemove = [];
        getMappedTargetTopics().forEach(topic => {
            if (regex.test(topic)) {
                topicsToRemove.push(topic);
            }
        });
        const newMappedTopics = getMappedTargetTopics();
        topicsToRemove.forEach(topic => newMappedTopics.delete(topic));
        console.log(`Removed target topics matching pattern:`, topicsToRemove);


        // 3. Re-render history tab (already done by setHistoryData)

        // 4. Rebuild both trees from the filtered history
        populateTreesFromHistory(); // This now rebuilds all 3 trees

        // 5. If the currently selected node in mapper was pruned, clear selection
            const selectedMapperNode = mapperTreeContainer.querySelector('.selected');
            if (selectedMapperNode && regex.test(selectedMapperNode.dataset.topic)) {
                console.log("Clearing selected mapper node.");
                selectedMapperNode.classList.remove('selected');
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

            // 7. [NEW] If the currently selected node in chart view was pruned, clear selection
            const selectedChartNode = chartTreeContainer.querySelector('.selected');
            if (selectedChartNode && regex.test(selectedChartNode.dataset.topic)) {
                 console.log("Clearing selected chart node.");
                 selectedChartNode.classList.remove('selected');
                 displayPayload(null, null, document.getElementById('chart-payload-topic'), document.getElementById('chart-payload-content'));
                 document.getElementById('chart-variable-list').innerHTML = '<p class="history-placeholder">Numeric variables will appear here.</p>';
            }

            console.log("Frontend prune finished.");
    }
    // --- [END MODAL LOGIC] ---


    // --- Panel Resizing Logic ---
    const resizerVertical = document.getElementById('drag-handle-vertical');
    const resizerHorizontal = document.getElementById('drag-handle-horizontal');
    const resizerVerticalMapper = document.getElementById('drag-handle-vertical-mapper');
    const resizerHorizontalMapper = document.getElementById('drag-handle-horizontal-mapper');
    const resizerVerticalChart = document.getElementById('drag-handle-vertical-chart'); // [NEW]
    const resizerHorizontalChart = document.getElementById('drag-handle-horizontal-chart'); // [NEW]

    // Vertical Resizing (generic function)
    const resizePanel = (e, panel) => {
        if (!panel) return;
        const minWidth = 200; 
        const containerRect = panel.parentElement.getBoundingClientRect();
        let panelWidth = e.pageX - panel.getBoundingClientRect().left;

        if (panelWidth < minWidth) panelWidth = minWidth;
        if (containerRect.width - panelWidth < minWidth) {
                panelWidth = containerRect.width - minWidth;
        }
        panel.style.flexBasis = `${panelWidth}px`;
    }

    // Horizontal Resizing (generic function)
    const resizeHorizontalPanel = (e, topPanel, container) => {
            if (!topPanel || !container) return;
            const minHeight = 100; 
            const containerRect = container.getBoundingClientRect();
            let panelHeight = e.pageY - containerRect.top;

            if (panelHeight < minHeight) panelHeight = minHeight;
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
            };
            document.addEventListener('mousemove', mouseMoveHandler);
            document.addEventListener('mouseup', mouseUpHandler, { once: true });
        });
    }

    // Vertical Resizer (Mapper View)
    if (resizerVerticalMapper) {
        resizerVerticalMapper.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const mouseMoveHandler = (ev) => resizePanel(ev, document.querySelector('.mapper-tree-wrapper'));
                const mouseUpHandler = () => {
                document.removeEventListener('mousemove', mouseMoveHandler);
            };
            document.addEventListener('mousemove', mouseMoveHandler);
            document.addEventListener('mouseup', mouseUpHandler, { once: true });
        });
    }

    // [NEW] Vertical Resizer (Chart View)
    if (resizerVerticalChart) {
        resizerVerticalChart.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const mouseMoveHandler = (ev) => resizePanel(ev, document.querySelector('.chart-tree-wrapper'));
            const mouseUpHandler = () => {
                document.removeEventListener('mousemove', mouseMoveHandler);
            };
            document.addEventListener('mousemove', mouseMoveHandler);
            document.addEventListener('mouseup', mouseUpHandler, { once: true });
        });
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
    }

    // [NEW] Horizontal Resizer (Chart View)
    if (resizerHorizontalChart) {
        resizerHorizontalChart.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const mouseMoveHandler = (ev) => resizeHorizontalPanel(ev, document.getElementById('chart-payload-area'), document.getElementById('chart-payload-container'));
            const mouseUpHandler = () => {
                document.removeEventListener('mousemove', mouseMoveHandler);
            };
            document.addEventListener('mousemove', mouseMoveHandler);
            document.addEventListener('mouseup', mouseUpHandler, { once: true });
        });
    }
});