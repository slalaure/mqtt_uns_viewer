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
import { mqttPatternToRegex, makeResizable, trackEvent } from './utils.js'; // [MODIFIED] Import trackEvent
import { createTreeManager } from './tree-manager.js';
import { createPayloadViewer } from './payload-viewer.js';

import { initSvgView, updateMap, updateSvgTimelineUI, setSvgHistoryData as setSvgHistoryModuleData } from './view.svg.js';
// [MODIFIED] Import the new renderFilteredHistory function
import { initHistoryView, setHistoryData, renderFilteredHistory } from './view.history.js';
import {
    initMapperView,
    updateMapperMetrics,
    updateMapperConfig,
    handleMapperNodeClick,
    getMapperConfig,
    getMappedTargetTopics,
    getTopicMappingStatus,
    addMappedTargetTopic,
    setMapperTheme
} from './view.mapper.js';
import { 
    initChartView, 
    handleChartNodeClick, 
    updateChartSliderUI, 
    getChartedTopics,
    pruneChartedVariables
} from './view.chart.js';
// [NEW] Import publish view modules
import { initPublishView, setPublishTheme } from './view.publish.js';
// --- [END NEW] ---


document.addEventListener('DOMContentLoaded', () => {
    let recentlyPrunedPatterns = new Set();
    const PRUNE_IGNORE_DURATION_MS = 10000;
    // [MODIFIÉ] Ajout d'une limite pour l'historique en mémoire
    const MAX_HISTORY_ENTRIES = 5000;
    let subscribedTopicPatterns = ['#'];
    let appBasePath = '/';
    let ws; // WebSocket instance

    // --- [NEW] State for initialization buffering ---
    let isAppInitialized = false;
    let messageBuffer = [];
    // --- [END NEW] ---

    // --- History State ---
    let allHistoryEntries = [];
    let minTimestamp = 0;
    let maxTimestamp = 0;
    
    // --- [NEW] Module Instances ---
    let mainTree, mapperTree, chartTree;
    let mainPayloadViewer;
    let selectedMainTreeNode = null; // Track selection for main tree

    // --- DOM Element Querying ---
    const datetimeContainer = document.getElementById('current-datetime');
    const darkModeToggle = document.getElementById('dark-mode-toggle');
    const btnConfigView = document.getElementById('btn-config-view'); // [MODIFIED] Added config button

    // --- Tree View Elements ---
    const treeViewWrapper = document.querySelector('.tree-view-wrapper');
    const payloadContainer = document.getElementById('payload-display');
    const payloadMainArea = document.getElementById('payload-main-area');
    const livePayloadToggle = document.getElementById('live-payload-toggle');
    const topicHistoryContainer = document.getElementById('topic-history-container');
    const treeFilterInput = document.getElementById('tree-filter-input');
    const btnExpandAll = document.getElementById('btn-expand-all');
    const btnCollapseAll = document.getElementById('btn-collapse-all');

    // --- Tab Navigation ---
    const btnTreeView = document.getElementById('btn-tree-view');
    const btnMapView = document.getElementById('btn-map-view');
    const btnHistoryView = document.getElementById('btn-history-view');
    const btnMapperView = document.getElementById('btn-mapper-view');
    const btnChartView = document.getElementById('btn-chart-view');
    const btnPublishView = document.getElementById('btn-publish-view'); // [NEW]
    const treeView = document.getElementById('tree-view');
    const mapView = document.getElementById('map-view');
    const historyView = document.getElementById('history-view');
    const mapperView = document.getElementById('mapper-view');
    const chartView = document.getElementById('chart-view');
    const publishView = document.getElementById('publish-view'); // [NEW]

    // --- History View Elements (Shared) ---
    const historyTotalMessages = document.getElementById('history-total-messages');
    const historyDbSize = document.getElementById('history-db-size');
    const historyDbLimit = document.getElementById('history-db-limit');
    const pruningIndicator = document.getElementById('pruning-indicator');

    // --- Simulator UI Elements (Now in Publish View) ---
    const btnStartSim = document.getElementById('btn-start-sim');
    const btnStopSim = document.getElementById('btn-stop-sim');
    const simStatusIndicator = document.getElementById('sim-status');
    const simulatorControls = document.querySelector('.simulator-controls'); // [MODIFIED] This query is still valid

    // --- [NEW] Mapper View Elements ---
    const mapperFilterInput = document.getElementById('mapper-filter-input');
    const btnMapperExpandAll = document.getElementById('btn-mapper-expand-all');
    const btnMapperCollapseAll = document.getElementById('btn-mapper-collapse-all');

    // --- [NEW] Chart View Elements ---
    const chartFilterInput = document.getElementById('chart-filter-input');
    const btnChartExpandAll = document.getElementById('btn-chart-expand-all');
    const btnChartCollapseAll = document.getElementById('btn-chart-collapse-all');


    // --- Dark Theme Logic ---
    const enableDarkMode = () => {
        document.body.classList.add('dark-mode');
        localStorage.setItem('theme', 'dark');
        if (darkModeToggle) darkModeToggle.checked = true;
        setMapperTheme(true);
        setPublishTheme(true); // [NEW]
    };
    const disableDarkMode = () => {
        document.body.classList.remove('dark-mode');
        localStorage.setItem('theme', 'light');
        if (darkModeToggle) darkModeToggle.checked = false;
        setMapperTheme(false);
        setPublishTheme(false); // [NEW]
    };
    if (localStorage.getItem('theme') === 'dark') {
        enableDarkMode();
    }
    darkModeToggle?.addEventListener('change', () => {
        darkModeToggle.checked ? enableDarkMode() : disableDarkMode();
    });

    // --- Tab Switching Logic ---
    function switchView(viewToShow) {
        const views = [treeView, mapView, historyView, mapperView, chartView, publishView]; // [MODIFIED]
        const buttons = [btnTreeView, btnMapView, btnHistoryView, btnMapperView, btnChartView, btnPublishView]; // [MODIFIED]
        let targetView, targetButton;

        if (viewToShow === 'map') { targetView = mapView; targetButton = btnMapView; }
        else if (viewToShow === 'history') { targetView = historyView; targetButton = btnHistoryView; }
        else if (viewToShow === 'mapper') { targetView = mapperView; targetButton = btnMapperView; }
        else if (viewToShow === 'chart') { targetView = chartView; targetButton = btnChartView; }
        else if (viewToShow === 'publish') { targetView = publishView; targetButton = btnPublishView; } // [NEW]
        else { targetView = treeView; targetButton = btnTreeView; }

        views.forEach(v => v?.classList.remove('active'));
        buttons.forEach(b => b?.classList.remove('active'));
        targetView?.classList.add('active');
        targetButton?.classList.add('active');
        
        // [NEW] Track the view change event
        trackEvent(`view_switch_${viewToShow || 'tree'}`);

        // [MODIFIED] Trigger a render if switching TO history view
        if (viewToShow === 'history') {
            // This will re-render the log with all new data
            renderFilteredHistory();
        }
    }
    btnTreeView?.addEventListener('click', () => switchView('tree'));
    btnMapView?.addEventListener('click', () => switchView('map'));
    btnHistoryView?.addEventListener('click', () => switchView('history'));
    btnMapperView?.addEventListener('click', () => switchView('mapper'));
    btnChartView?.addEventListener('click', () => switchView('chart'));
    btnPublishView?.addEventListener('click', () => switchView('publish')); // [NEW]

    // --- Real-Time Clock ---
    function updateClock() {
        if (!datetimeContainer) return;
        datetimeContainer.textContent = new Date().toLocaleString('sv-SE'); // YYYY-MM-DD HH:MM:SS
    }
    setInterval(updateClock, 1000);
    updateClock();

    // --- Simulator UI Logic [MODIFIED] ---
    // This logic remains valid as IDs are the same
    function updateSimulatorStatusUI(status) {
        if (!simStatusIndicator) return;
        if (status === 'running') {
            simStatusIndicator.textContent = 'Running';
            simStatusIndicator.classList.add('running');
            simStatusIndicator.classList.remove('stopped');
            btnStartSim?.setAttribute('disabled', true); // Disable Start button
            btnStopSim?.removeAttribute('disabled');     // Enable Stop button
        } else {
            simStatusIndicator.textContent = 'Stopped';
            simStatusIndicator.classList.add('stopped');
            simStatusIndicator.classList.remove('running');
            btnStartSim?.removeAttribute('disabled'); // Enable Start button
            btnStopSim?.setAttribute('disabled', true);  // Disable Stop button
        }
    }
    btnStartSim?.addEventListener('click', () => {
        fetch('api/simulator/start', { method: 'POST' });
        trackEvent('simulator_start'); // [NEW]
    });
    btnStopSim?.addEventListener('click', () => {
        fetch('api/simulator/stop', { method: 'POST' });
        trackEvent('simulator_stop'); // [NEW]
    });

    // --- [NEW] Tree Click Handlers ---
    
    /**
     * [MODIFIED] Click handler for the main tree.
     * Clicks on folders toggle collapse.
     * Clicks on files select them and show payload.
     */
    function handleMainTreeClick(event, nodeContainer, topic) {
        const li = nodeContainer.closest('li');

        // Folder click
        if (li.classList.contains('is-folder')) {
            li.classList.toggle('collapsed');
            return; // Stop here, don't select folders in main tree
        }

        // File click
        if (li.classList.contains('is-file')) {
            if (selectedMainTreeNode) {
                selectedMainTreeNode.classList.remove('selected');
            }
            selectedMainTreeNode = nodeContainer;
            selectedMainTreeNode.classList.add('selected');

            if (livePayloadToggle) {
                livePayloadToggle.checked = false;
                livePayloadToggle.dispatchEvent(new Event('change'));
            }

            const payload = nodeContainer.dataset.payload;
            mainPayloadViewer.display(topic, payload);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'get-topic-history', topic: topic }));
            }
        }
    }

    function handleMainTreeCheckboxClick(event, nodeContainer, topic) {
        event.stopPropagation();
        const checkbox = event.target;
        const isChecked = checkbox.checked;
        const li = checkbox.closest('li');
        if (li) {
            li.querySelectorAll('.node-filter-checkbox').forEach(cb => cb.checked = isChecked);
        }
    }

    // --- [NEW] Color Logic for Trees ---
    
    function colorAllMapperTrees() {
        if (!mainTree || !mapperTree) return; // Guard against calls before init
        const colorFn = (topic, li) => {
            const status = getTopicMappingStatus(topic);
            li.classList.remove('mapped-source', 'mapped-target');
            if (status === 'source') {
                li.classList.add('mapped-source');
            } else if (status === 'target') {
                li.classList.add('mapped-target');
            }
        };
        mainTree.colorTree(colorFn);
        mapperTree.colorTree(colorFn);
        // Note: We don't color the chart tree with mapper logic
    }
    
    function colorChartTree() {
        if (!chartTree) return; // Guard against calls before init
        const chartedTopics = getChartedTopics();
        const colorFn = (topic, li) => {
            let isOrHasChartedChild = false;
            if (chartedTopics.has(topic)) {
                isOrHasChartedChild = true;
            } else {
                const folderPath = topic + '/';
                for (const t of chartedTopics) {
                    if (t.startsWith(folderPath)) {
                        isOrHasChartedChild = true;
                        break;
                    }
                }
            }
            li.classList.toggle('has-charted-variable', isOrHasChartedChild);
        };
        chartTree.colorTree(colorFn);
    }

    // --- WebSocket Connection ---
    (async () => {
        try {
            const configResponse = await fetch('api/config');
            if (!configResponse.ok) throw new Error('Failed to fetch config');
            const appConfig = await configResponse.json();
            
            appBasePath = appConfig.basePath || '/';
            
            const wsProtocol = window.location.protocol === 'https:?' ? 'wss:' : 'ws:';
            const wsUrl = `${wsProtocol}//${window.location.host}${appBasePath}`;
            
            console.log(`[DEBUG] Connecting to WebSocket at: ${wsUrl}`);
            ws = new WebSocket(wsUrl);

            ws.onopen = () => {
                console.log("[DEBUG] WebSocket connected. Initializing app...");
                finishInitialization(appConfig); 
            };

            // [MODIFIED] Handle buffering
            ws.onmessage = async (event) => {
                const dataText = event.data instanceof Blob ? await event.data.text() : event.data;
                const message = JSON.parse(dataText);

                if (isAppInitialized) {
                    // If app is ready, process immediately
                    // console.log("[DEBUG] Processing WS message:", message.type); // [DEBUG LOG]
                    processWsMessage(message);
                } else {
                    // If app is not ready, buffer the message
                    console.log(`[DEBUG] Buffering WS message (app not ready): ${message.type}`); // [DEBUG LOG]
                    messageBuffer.push(message);
                }
            };
            
            ws.onerror = (err) => console.error("WebSocket Error:", err);
            ws.onclose = () => {
                console.log("WebSocket connection closed. Attempting to reconnect...");
                isAppInitialized = false; // [NEW] Reset flag
                setTimeout(startApp, 3000); // Use named function
            };

        } catch (error) {
            console.error("Failed to fetch initial app configuration:", error);
        }
    })();
    
    // [NEW] Central message processing function
    function processWsMessage(message) {
        try {
            switch(message.type) {
                case 'mqtt-message': {
                    let ignoreForTreeUpdate = false;
                    for (const pattern of recentlyPrunedPatterns) {
                        try {
                            const regex = mqttPatternToRegex(pattern);
                            if (regex.test(message.topic)) {
                                ignoreForTreeUpdate = true;
                                break;
                            }
                        } catch (e) { console.error("Regex error:", e); }
                    }

                    updateMap(message.topic, message.payload); // Update SVG

                    // --- History Update ---
                    const newEntry = { ...message, timestampMs: new Date(message.timestamp).getTime() };
                    allHistoryEntries.unshift(newEntry);

                    // [MODIFIÉ] Plafonner le tableau d'historique pour éviter la fuite de mémoire
                    if (allHistoryEntries.length > MAX_HISTORY_ENTRIES) {
                        allHistoryEntries.pop(); // Retirer l'entrée la plus ancienne
                    }
                    
                    // [MODIFIED] This call is now lightweight and fast.
                    // It just updates timestamps and slider ranges, it does NOT re-render the log.
                    const newState = setHistoryData(allHistoryEntries, false);
                    
                    minTimestamp = newState.min;
                    maxTimestamp = newState.max;
                    setSvgHistoryModuleData(allHistoryEntries); // This just updates the array, which is fine
                    updateSvgTimelineUI(minTimestamp, maxTimestamp);
                    updateChartSliderUI(minTimestamp, maxTimestamp, false);
                    // --- End History Update ---

                    // --- [NEW] Tree Updates ---
                    if (!ignoreForTreeUpdate) {
                        const options = { enableAnimations: true };
                        // Guard checks in case trees aren't ready (though they should be)
                        const node = mainTree?.update(message.topic, message.payload, message.timestamp, options);
                        mapperTree?.update(message.topic, message.payload, message.timestamp);
                        chartTree?.update(message.topic, message.payload, message.timestamp);
                        
                        // Live update for Tree View
                        if (livePayloadToggle?.checked && node && mainTree.isTopicVisible(node)) {
                            setTimeout(() => {
                                mainPayloadViewer.display(message.topic, message.payload);
                            }, 500); // Small delay for animation
                        }
                    }
                    break;
                }
                case 'simulator-status':
                    updateSimulatorStatusUI(message.status);
                    break;
                case 'history-initial-data':
                    console.log(`[DEBUG] Received history-initial-data with ${message.data.length} entries.`); // [DEBUG LOG]
                    allHistoryEntries = message.data.map(entry => ({ ...entry, timestampMs: new Date(entry.timestamp).getTime() }));
                    setSvgHistoryModuleData(allHistoryEntries);
                    
                    // [MODIFIED] This call will now also trigger the initial render
                    const newState = setHistoryData(allHistoryEntries, true);
                    minTimestamp = newState.min;
                    maxTimestamp = newState.max;
                    
                    updateSvgTimelineUI(minTimestamp, maxTimestamp);
                    updateChartSliderUI(minTimestamp, maxTimestamp, true);
                    
                    // [MODIFIED] This is the fix. Populate trees from initial history.
                    populateTreesFromHistory();
                    
                    break;
                case 'tree-initial-state': {
                    console.log(`[DEBUG] Received tree-initial-state with ${message.data.length} topics.`); // [DEBUG LOG]
                    const topicMap = new Map();
                    for (const entry of message.data) {
                        topicMap.set(entry.topic, entry);
                    }
                    // These calls will *update* the trees built from history
                    if (mainTree) mainTree.rebuild(topicMap);
                    if (mapperTree) mapperTree.rebuild(topicMap);
                    if (chartTree) chartTree.rebuild(topicMap);
                    
                    colorAllMapperTrees();
                    colorChartTree();
                    break;
                }
                case 'topic-history-data':
                    mainPayloadViewer.updateHistory(message.topic, message.data);
                    break;
                case 'db-status-update':
                    if (historyTotalMessages) historyTotalMessages.textContent = message.totalMessages.toLocaleString();
                    if (historyDbSize) historyDbSize.textContent = message.dbSizeMB.toFixed(2);
                    if (historyDbLimit) historyDbLimit.textContent = message.dbLimitMB > 0 ? message.dbLimitMB : 'N/A';
                    break;
                case 'pruning-status':
                    if (pruningIndicator) pruningIndicator.classList.toggle('visible', message.status === 'started');
                    break;
                case 'mapper-config-update':
                    updateMapperConfig(message.config);
                    colorAllMapperTrees(); // Re-color after config change
                    break;
                case 'mapped-topic-generated':
                    addMappedTargetTopic(message.topic);
                    colorAllMapperTrees(); // Re-color after new topic
                    break;
                case 'mapper-metrics-update':
                    updateMapperMetrics(message.metrics);
                    break;
            }
        } catch (e) {
            console.error("Error processing message:", e, message);
        }
    }
    
    // [NEW] Renamed startApp function
    async function startApp() {
        // This wrapper is for the websocket reconnect logic
        // The main logic is now inside the async IIFE above
    }
    
    function finishInitialization(appConfig) {
        try {
            console.log("[DEBUG] finishInitialization() called."); // [DEBUG LOG]
            
            // --- Store subscribed topics (needed for publish view) ---
            if (appConfig.subscribedTopics) {
                subscribedTopicPatterns = appConfig.subscribedTopics.split(',').map(t => t.trim());
            }

            // --- Hide/Show tabs based on config ---
            btnTreeView?.classList.remove('active');
            treeView?.classList.remove('active');
            let defaultViewActivated = false;

            const views = [
                { enabled: appConfig.viewTreeEnabled, btn: btnTreeView, view: 'tree' },
                { enabled: appConfig.viewSvgEnabled, btn: btnMapView, view: 'map' },
                { enabled: appConfig.viewHistoryEnabled, btn: btnHistoryView, view: 'history' },
                { enabled: appConfig.viewMapperEnabled, btn: btnMapperView, view: 'mapper' },
                { enabled: appConfig.viewChartEnabled, btn: btnChartView, view: 'chart' },
                { enabled: appConfig.viewPublishEnabled, btn: btnPublishView, view: 'publish' } // [NEW]
            ];

            views.forEach(v => {
                if (v.enabled) {
                    v.btn.style.display = 'block';
                    if (!defaultViewActivated) {
                        switchView(v.view);
                        defaultViewActivated = true;
                    }
                } else {
                    v.btn.style.display = 'none';
                }
            });
            
            if (!defaultViewActivated) {
                switchView('tree'); // Fallback
            }

            // [MODIFIED] Hide config button if disabled
            if (btnConfigView) {
                btnConfigView.style.display = appConfig.viewConfigEnabled ? 'block' : 'none';
            }
            // --- [END MODIFIED] ---

            // --- [NEW] Initialize Modules & Managers ---
            
            // 1. Payload Viewers
            mainPayloadViewer = createPayloadViewer({
                topicEl: document.getElementById('payload-topic'),
                contentEl: document.getElementById('payload-content'),
                historyLogEl: document.getElementById('topic-history-log'),
                placeholderEl: document.querySelector('.topic-history-log .history-placeholder')
            });
            console.log("[DEBUG] Payload viewer initialized."); // [DEBUG LOG]

            // 2. Tree Managers
            mainTree = createTreeManager(document.getElementById('mqtt-tree'), {
                treeId: 'main',
                onNodeClick: handleMainTreeClick, // [MODIFIED] Use updated handler
                onCheckboxClick: handleMainTreeCheckboxClick,
                showCheckboxes: true,
                allowFolderCollapse: true
            });
            mapperTree = createTreeManager(document.getElementById('mapper-tree'), {
                treeId: 'mapper',
                onNodeClick: (e, node, topic) => { // [MODIFIED] Use updated handler
                    const li = node.closest('li');
                    
                    if (li.classList.contains('is-folder')) {
                        li.classList.toggle('collapsed');
                    }
                    
                    // Pass selection to mapper module (for folders & files)
                    handleMapperNodeClick(e, node, topic);
                    // Also update the selected node highlight
                    document.querySelectorAll('#mapper-tree .selected').forEach(n => n.classList.remove('selected'));
                    node.classList.add('selected');
                },
                allowFolderCollapse: true 
            });
            chartTree = createTreeManager(document.getElementById('chart-tree'), {
                treeId: 'chart',
                onNodeClick: (e, node, topic) => { // [MODIFIED] Use updated handler
                    const li = node.closest('li');

                    if (li.classList.contains('is-folder')) {
                        li.classList.toggle('collapsed');
                    }
                    
                    // Pass selection to chart module (for folders & files)
                    handleChartNodeClick(e, node, topic);
                    // Also update the selected node highlight
                    document.querySelectorAll('#chart-tree .selected').forEach(n => n.classList.remove('selected'));
                    node.classList.add('selected');
                },
                allowFolderCollapse: true 
            });
            console.log("[DEBUG] All 3 tree managers initialized."); // [DEBUG LOG]

            // 3. View-Specific Modules
            initSvgView(appConfig);
            initHistoryView();
            initMapperView({
                pruneTopicFromFrontend: pruneTopicFromFrontend,
                getSubscribedTopics: () => subscribedTopicPatterns,
                colorAllTrees: colorAllMapperTrees,
                addPruneIgnorePattern: (pattern) => {
                    recentlyPrunedPatterns.add(pattern);
                    setTimeout(() => recentlyPrunedPatterns.delete(pattern), PRUNE_IGNORE_DURATION_MS);
                },
                // [NEW] Pass the limit
                maxSavedMapperVersions: appConfig.maxSavedMapperVersions || 0
            });
            initChartView({
                getHistory: () => allHistoryEntries,
                colorChartTreeCallback: colorChartTree,
                // [NEW] Pass the limit
                maxSavedChartConfigs: appConfig.maxSavedChartConfigs || 0
            });
            // [NEW] Init Publish View
            initPublishView({
                subscribedTopics: subscribedTopicPatterns
            });
            
            // --- Simulator Status (UI is now in publish view) ---
            if (appConfig.isSimulatorEnabled && simulatorControls) {
                simulatorControls.style.display = 'flex'; // This is the .simulator-controls container
                fetch('api/simulator/status')
                    .then(res => res.json())
                    .then(data => updateSimulatorStatusUI(data.status));
            }
            
            // --- [NEW] Init Resizers ---
            makeResizable({
                resizerEl: document.getElementById('drag-handle-vertical'),
                direction: 'vertical',
                panelA: treeViewWrapper
            });
            makeResizable({
                resizerEl: document.getElementById('drag-handle-horizontal'),
                direction: 'horizontal',
                panelA: payloadMainArea,
                containerEl: payloadContainer
            });
            makeResizable({
                resizerEl: document.getElementById('drag-handle-vertical-mapper'),
                direction: 'vertical',
                panelA: document.querySelector('.mapper-tree-wrapper')
            });
            makeResizable({
                resizerEl: document.getElementById('drag-handle-horizontal-mapper'),
                direction: 'horizontal',
                panelA: document.getElementById('mapper-payload-area'),
                containerEl: document.getElementById('mapper-payload-container')
            });
            makeResizable({
                resizerEl: document.getElementById('drag-handle-vertical-chart'),
                direction: 'vertical',
                panelA: document.querySelector('.chart-tree-wrapper')
            });
            makeResizable({
                resizerEl: document.getElementById('drag-handle-horizontal-chart'),
                direction: 'horizontal',
                panelA: document.getElementById('chart-payload-area'),
                containerEl: document.getElementById('chart-payload-container')
            });
            // [NEW] Resizer for publish view
            makeResizable({
                resizerEl: document.getElementById('drag-handle-vertical-publish'),
                direction: 'vertical',
                panelA: document.querySelector('.publish-panel-wrapper')
            });


            // --- [NEW] Init Tree View Controls ---
            livePayloadToggle?.addEventListener('change', (event) => {
                if (event.target.checked && selectedMainTreeNode) {
                    selectedMainTreeNode.classList.remove('selected');
                    selectedMainTreeNode = null;
                }
                toggleRecentHistoryVisibility();
            });
            toggleRecentHistoryVisibility();
            
            btnExpandAll?.addEventListener('click', () => mainTree.toggleAllFolders(false));
            btnCollapseAll?.addEventListener('click', () => mainTree.toggleAllFolders(true));
            treeFilterInput?.addEventListener('input', () => mainTree.applyFilter(treeFilterInput.value));

            // --- [NEW] Init Mapper Tree Controls ---
            btnMapperExpandAll?.addEventListener('click', () => mapperTree.toggleAllFolders(false));
            btnMapperCollapseAll?.addEventListener('click', () => mapperTree.toggleAllFolders(true));
            mapperFilterInput?.addEventListener('input', () => mapperTree.applyFilter(mapperFilterInput.value));

            // --- [NEW] Init Chart Tree Controls ---
            btnChartExpandAll?.addEventListener('click', () => chartTree.toggleAllFolders(false));
            btnChartCollapseAll?.addEventListener('click', () => chartTree.toggleAllFolders(true));
            chartFilterInput?.addEventListener('input', () => chartTree.applyFilter(chartFilterInput.value));


            // --- [MODIFIED] Mark app as initialized and process buffer ---
            isAppInitialized = true;
            console.log(`[DEBUG] App initialized. Processing ${messageBuffer.length} buffered messages.`);
            messageBuffer.forEach(msg => processWsMessage(msg));
            messageBuffer = []; // Clear the buffer
            // --- [END MODIFIED] ---

        } catch (error) {
            console.error("Failed to finish app initialization:", error);
        }
    }
    
    function toggleRecentHistoryVisibility() {
        if (!topicHistoryContainer) return;
        const isLive = livePayloadToggle.checked;
        topicHistoryContainer.style.display = isLive ? 'none' : 'flex';
        document.getElementById('drag-handle-horizontal').style.display = isLive ? 'none' : 'flex';
    }

    /**
     * [SHARED] Rebuilds all trees from the filtered history.
     */
    function populateTreesFromHistory() {
        console.log(`[DEBUG] populateTreesFromHistory() called with ${allHistoryEntries.length} entries.`); // [DEBUG LOG]
        const uniqueTopics = new Map();
        // [FIX] Iterate over all entries, not just the first 200
        for (let i = allHistoryEntries.length - 1; i >= 0; i--) { 
            const entry = allHistoryEntries[i];
            uniqueTopics.set(entry.topic, entry);
        }
        console.log(`[DEBUG] Found ${uniqueTopics.size} unique topics from history.`); // [DEBUG LOG]

        // [FIXJ] Check if trees are initialized before rebuilding
        if (mainTree) {
            console.log("[DEBUG] Rebuilding mainTree..."); // [DEBUG LOG]
            mainTree.rebuild(uniqueTopics);
        }
        if (mapperTree) {
            console.log("[DEBUG] Rebuilding mapperTree..."); // [DEBUG LOG]
            mapperTree.rebuild(uniqueTopics);
        }
        if (chartTree) {
            console.log("[DEBUG] Rebuilding chartTree..."); // [DEBUG LOG]
            chartTree.rebuild(uniqueTopics);
        }
        
        // [FIX] Check if these are initialized
        if (getTopicMappingStatus) colorAllMapperTrees();
        if (getChartedTopics) colorChartTree();
        console.log("[DEBUG] populateTreesFromHistory() finished."); // [DEBUG LOG]
    }

    /**
     * [SHARED] Prune function passed to mapper module.
     */
    async function pruneTopicFromFrontend(topicPattern) {
        console.log(`Pruning frontend with pattern: ${topicPattern}`);
        const regex = mqttPatternToRegex(topicPattern);

        allHistoryEntries = allHistoryEntries.filter(entry => !regex.test(entry.topic));
        setSvgHistoryModuleData(allHistoryEntries);
        
        const newState = setHistoryData(allHistoryEntries, false);
        minTimestamp = newState.min;
        maxTimestamp = newState.max;
        updateChartSliderUI(minTimestamp, maxTimestamp, true);
        pruneChartedVariables(regex);

        const topicsToRemove = [];
        getMappedTargetTopics().forEach(topic => {
            if (regex.test(topic)) {
                topicsToRemove.push(topic);
            }
        });
        topicsToRemove.forEach(topic => getMappedTargetTopics().delete(topic));

        populateTreesFromHistory();

        // Clear selection if pruned
        if (selectedMainTreeNode && regex.test(selectedMainTreeNode.dataset.topic)) {
            selectedMainTreeNode.classList.remove('selected');
            selectedMainTreeNode = null;
            mainPayloadViewer.clear();
        }
    }
});