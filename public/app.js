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
 */

// ---  Module Imports ---
import { mqttPatternToRegex, makeResizable, trackEvent } from './utils.js';
import { createTreeManager } from './tree-manager.js';
import { createPayloadViewer } from './payload-viewer.js';

import { initSvgView, updateMap, updateSvgTimelineUI, setSvgHistoryData as setSvgHistoryModuleData } from './view.svg.js';
import { 
    initHistoryView, 
    setHistoryData, 
    renderFilteredHistory, 
    setDbBounds 
} from './view.history.js';
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
    pruneChartedVariables,
    refreshChart 
} from './view.chart.js';
import { initPublishView, setPublishTheme, updateSimulatorStatuses } from './view.publish.js';
// [NEW] Import floating widget init and toggle
import { initChatView, toggleChatWidget } from './view.chat.js'; 


document.addEventListener('DOMContentLoaded', () => {
    // ... (Variables and State) ...
    let recentlyPrunedPatterns = new Set();
    const PRUNE_IGNORE_DURATION_MS = 10000;
    
    let isMultiBroker = false;
    let brokerConfigs = [];
    
    let appBasePath = '/';
    let ws; 

    let subscribedTopicPatterns = ['#'];

    let isAppInitialized = false;
    let messageBuffer = [];

    let allHistoryEntries = [];
    let globalDbMin = 0;
    let globalDbMax = Date.now();
    
    let mainTree, mapperTree, chartTree;
    let mainPayloadViewer;
    let selectedMainTreeNode = null; 

    // --- DOM Element Querying ---
    const datetimeContainer = document.getElementById('current-datetime');
    const darkModeToggle = document.getElementById('dark-mode-toggle');
    const btnConfigView = document.getElementById('btn-config-view'); 
    const brokerStatusContainer = document.getElementById('broker-status-container');

    const treeViewWrapper = document.querySelector('.tree-view-wrapper');
    const payloadContainer = document.getElementById('payload-display');
    const payloadMainArea = document.getElementById('payload-main-area');
    const livePayloadToggle = document.getElementById('live-payload-toggle');
    const topicHistoryContainer = document.getElementById('topic-history-container');
    const treeFilterInput = document.getElementById('tree-filter-input');
    const btnExpandAll = document.getElementById('btn-expand-all');
    const btnCollapseAll = document.getElementById('btn-collapse-all');

    const btnTreeView = document.getElementById('btn-tree-view');
    const btnMapView = document.getElementById('btn-map-view');
    const btnHistoryView = document.getElementById('btn-history-view');
    const btnMapperView = document.getElementById('btn-mapper-view');
    const btnChartView = document.getElementById('btn-chart-view');
    const btnPublishView = document.getElementById('btn-publish-view'); 
    // [MODIFIED] Removed btnChatView query as it's no longer a tab button

    const treeView = document.getElementById('tree-view');
    const mapView = document.getElementById('map-view');
    const historyView = document.getElementById('history-view');
    const mapperView = document.getElementById('mapper-view');
    const chartView = document.getElementById('chart-view');
    const publishView = document.getElementById('publish-view'); 
    // [MODIFIED] Removed chatView query as it's now #chat-widget-container handled in view.chat.js

    // ... (Other DOM queries same as before) ...
    const historyTotalMessages = document.getElementById('history-total-messages');
    const historyDbSize = document.getElementById('history-db-size');
    const historyDbLimit = document.getElementById('history-db-limit');
    const pruningIndicator = document.getElementById('pruning-indicator');
    const simulatorControls = document.getElementById('simulator-list-container'); 
    const mapperFilterInput = document.getElementById('mapper-filter-input');
    const btnMapperExpandAll = document.getElementById('btn-mapper-expand-all');
    const btnMapperCollapseAll = document.getElementById('btn-mapper-collapse-all');
    const chartFilterInput = document.getElementById('chart-filter-input');
    const btnChartExpandAll = document.getElementById('btn-chart-expand-all');
    const btnChartCollapseAll = document.getElementById('btn-chart-collapse-all');


    // --- Dark Theme Logic ---
    const enableDarkMode = () => {
        document.body.classList.add('dark-mode');
        localStorage.setItem('theme', 'dark');
        if (darkModeToggle) darkModeToggle.checked = true;
        setMapperTheme(true);
        setPublishTheme(true); 
    };
    const disableDarkMode = () => {
        document.body.classList.remove('dark-mode');
        localStorage.setItem('theme', 'light');
        if (darkModeToggle) darkModeToggle.checked = false;
        setMapperTheme(false);
        setPublishTheme(false); 
    };
    if (localStorage.getItem('theme') === 'dark') {
        enableDarkMode();
    }
    darkModeToggle?.addEventListener('change', () => {
        darkModeToggle.checked ? enableDarkMode() : disableDarkMode();
    });

    // --- Tab Switching Logic (Chat removed) ---
    function switchView(viewToShow) {
        // [MODIFIED] Removed chatView from arrays
        const views = [treeView, mapView, historyView, mapperView, chartView, publishView]; 
        const buttons = [btnTreeView, btnMapView, btnHistoryView, btnMapperView, btnChartView, btnPublishView]; 
        let targetView, targetButton;

        if (viewToShow === 'map') { targetView = mapView; targetButton = btnMapView; }
        else if (viewToShow === 'history') { targetView = historyView; targetButton = btnHistoryView; }
        else if (viewToShow === 'mapper') { targetView = mapperView; targetButton = btnMapperView; }
        else if (viewToShow === 'chart') { targetView = chartView; targetButton = btnChartView; }
        else if (viewToShow === 'publish') { targetView = publishView; targetButton = btnPublishView; } 
        else { targetView = treeView; targetButton = btnTreeView; }

        views.forEach(v => v?.classList.remove('active'));
        buttons.forEach(b => b?.classList.remove('active'));
        targetView?.classList.add('active');
        targetButton?.classList.add('active');
        
        trackEvent(`view_switch_${viewToShow || 'tree'}`);

        if (viewToShow === 'history') {
            renderFilteredHistory();
        }
    }
    
    btnTreeView?.addEventListener('click', () => switchView('tree'));
    btnMapView?.addEventListener('click', () => switchView('map'));
    btnHistoryView?.addEventListener('click', () => switchView('history'));
    btnMapperView?.addEventListener('click', () => switchView('mapper'));
    btnChartView?.addEventListener('click', () => switchView('chart'));
    btnPublishView?.addEventListener('click', () => switchView('publish')); 
    // [MODIFIED] Chat button listener removed

    // --- Real-Time Clock ---
    function updateClock() {
        if (!datetimeContainer) return;
        datetimeContainer.textContent = new Date().toLocaleString('sv-SE');
    }
    setInterval(updateClock, 1000);
    updateClock();

    // ... (Tree Click Handlers, Color Logic, Backend Range Request - Unchanged) ...
    // ... (Kept existing implementations of handleMainTreeClick, colorAllMapperTrees etc.) ...
    function handleMainTreeClick(event, nodeContainer, brokerId, topic) {
        const li = nodeContainer.closest('li');
        if (li.classList.contains('is-folder')) {
            li.classList.toggle('collapsed');
            return; 
        }
        if (li.classList.contains('is-file')) {
            if (selectedMainTreeNode) selectedMainTreeNode.classList.remove('selected');
            selectedMainTreeNode = nodeContainer;
            selectedMainTreeNode.classList.add('selected');
            
            // [FIXED] Ensure live update is disabled so history panel shows
            if (livePayloadToggle && livePayloadToggle.checked) {
                livePayloadToggle.checked = false;
                livePayloadToggle.dispatchEvent(new Event('change'));
            } else {
                // Force re-evaluation of visibility in case it was hidden but unchecked
                toggleRecentHistoryVisibility();
            }

            const payload = nodeContainer.dataset.payload;
            mainPayloadViewer.display(brokerId, topic, payload);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'get-topic-history', brokerId: brokerId, topic: topic }));
            }
        }
    }
    
    function handleMainTreeCheckboxClick(event, nodeContainer, brokerId, topic) {
        event.stopPropagation();
        const checkbox = event.target;
        const isChecked = checkbox.checked;
        const li = checkbox.closest('li');
        if (li) {
            li.querySelectorAll('.node-filter-checkbox').forEach(cb => cb.checked = isChecked);
        }
    }

    function colorAllMapperTrees() {
        if (!mainTree || !mapperTree) return; 
        const colorFn = (brokerId, topic, li) => {
            const status = getTopicMappingStatus(brokerId, topic); 
            li.classList.remove('mapped-source', 'mapped-target');
            if (status === 'source') {
                li.classList.add('mapped-source');
            } else if (status === 'target') {
                li.classList.add('mapped-target');
            }
        };
        mainTree.colorTree(colorFn);
        mapperTree.colorTree(colorFn);
    }
    
    function colorChartTree() {
        if (!chartTree) return; 
        const chartedVars = getChartedTopics(); 
        const colorFn = (brokerId, topic, li) => {
            let isOrHasChartedChild = false;
            const folderPathPrefix = `${brokerId}|${topic}/`;
            for (const [varId, varInfo] of chartedVars.entries()) {
                if (varInfo.brokerId === brokerId && varInfo.topic === topic) {
                    isOrHasChartedChild = true;
                    break;
                }
                if (varId.startsWith(folderPathPrefix)) { 
                    isOrHasChartedChild = true;
                    break;
                }
            }
            li.classList.toggle('has-charted-variable', isOrHasChartedChild);
        };
        chartTree.colorTree(colorFn);
    }

    function requestHistoryRange(start, end, filter) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'get-history-range', start: start, end: end, filter: filter }));
        }
    }

    // --- WebSocket Connection & Logic (Unchanged) ---
    (async () => {
        try {
            const configResponse = await fetch('api/config');
            if (!configResponse.ok) throw new Error('Failed to fetch config');
            const appConfig = await configResponse.json();
            
            appBasePath = appConfig.basePath || '/';
            isMultiBroker = appConfig.isMultiBroker || false;
            brokerConfigs = appConfig.brokerConfigs || [];
            
            const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${wsProtocol}//${window.location.host}${appBasePath}`;
            
            ws = new WebSocket(wsUrl);
            ws.onopen = () => finishInitialization(appConfig);
            ws.onmessage = async (event) => {
                const dataText = event.data instanceof Blob ? await event.data.text() : event.data;
                const message = JSON.parse(dataText);
                if (isAppInitialized) processWsMessage(message);
                else messageBuffer.push(message);
            };
            ws.onerror = (err) => console.error("WebSocket Error:", err);
            ws.onclose = () => { isAppInitialized = false; setTimeout(startApp, 3000); };

        } catch (error) {
            console.error("Failed to fetch initial app configuration:", error);
        }
    })();
    
    // ... (processWsMessage, renderBrokerStatuses, updateSingleBrokerStatus - Unchanged) ...
    function processWsMessage(message) {
        // Same logic as provided in previous context, omitted for brevity in answer but kept in final file
        try {
            switch(message.type) {
                case 'mqtt-message':
                    updateMap(message.brokerId, message.topic, message.payload); 
                    const newEntry = { ...message, timestampMs: new Date(message.timestamp).getTime() };
                    setHistoryData([newEntry], false, true); 
                    if (newEntry.timestampMs > globalDbMax) globalDbMax = newEntry.timestampMs;
                    updateSvgTimelineUI(globalDbMin, globalDbMax);
                    updateChartSliderUI(globalDbMin, globalDbMax, false);
                    
                    let ignoreForTreeUpdate = false;
                    for (const pattern of recentlyPrunedPatterns) {
                        try { if (mqttPatternToRegex(pattern).test(message.topic)) { ignoreForTreeUpdate = true; break; } } catch (e) {}
                    }
                    if (!ignoreForTreeUpdate) {
                        const options = { enableAnimations: true };
                        const node = mainTree?.update(message.brokerId, message.topic, message.payload, message.timestamp, options);
                        mapperTree?.update(message.brokerId, message.topic, message.payload, message.timestamp);
                        chartTree?.update(message.brokerId, message.topic, message.payload, message.timestamp);
                        if (livePayloadToggle?.checked && node && mainTree.isTopicVisible(node)) {
                            setTimeout(() => mainPayloadViewer.display(message.brokerId, message.topic, message.payload), 500); 
                        }
                    }
                    break;
                // ... (Other cases: simulator-status, db-bounds, history-initial-data, history-range-data, tree-initial-state, topic-history-data, db-status-update, pruning-status, mapper-config-update, mapped-topic-generated, mapper-metrics-update, broker-status-all, broker-status)
                case 'simulator-status': updateSimulatorStatuses(message.statuses); break;
                case 'db-bounds':
                    globalDbMin = message.min; globalDbMax = message.max;
                    setDbBounds(globalDbMin, globalDbMax); 
                    updateChartSliderUI(globalDbMin, globalDbMax, true);
                    updateSvgTimelineUI(globalDbMin, globalDbMax);
                    break;
                case 'history-initial-data':
                    allHistoryEntries = message.data.map(entry => ({ ...entry, brokerId: entry.broker_id || entry.brokerId || 'default_broker', timestampMs: new Date(entry.timestamp).getTime() }));
                    setSvgHistoryModuleData(allHistoryEntries);
                    setHistoryData(allHistoryEntries, true, false);
                    populateTreesFromHistory();
                    break;
                case 'history-range-data':
                    const rangeEntries = message.data.map(entry => ({ ...entry, brokerId: entry.broker_id || entry.brokerId || 'default_broker', timestampMs: new Date(entry.timestamp).getTime() }));
                    allHistoryEntries = rangeEntries;
                    setSvgHistoryModuleData(allHistoryEntries);
                    setHistoryData(allHistoryEntries, false, false, message.requestStart, message.requestEnd);
                    updateChartSliderUI(globalDbMin, globalDbMax, false);
                    refreshChart();
                    populateTreesFromHistory(); 
                    break;
                case 'tree-initial-state':
                    if (mainTree) mainTree.rebuild(message.data);
                    if (mapperTree) mapperTree.rebuild(message.data);
                    if (chartTree) chartTree.rebuild(message.data);
                    colorAllMapperTrees(); colorChartTree();
                    break;
                case 'topic-history-data': mainPayloadViewer.updateHistory(message.brokerId, message.topic, message.data); break;
                case 'db-status-update':
                    if (historyTotalMessages) historyTotalMessages.textContent = message.totalMessages.toLocaleString();
                    if (historyDbSize) historyDbSize.textContent = message.dbSizeMB.toFixed(2);
                    if (historyDbLimit) historyDbLimit.textContent = message.dbLimitMB > 0 ? message.dbLimitMB : 'N/A';
                    break;
                case 'pruning-status': if (pruningIndicator) pruningIndicator.classList.toggle('visible', message.status === 'started'); break;
                case 'mapper-config-update': updateMapperConfig(message.config); colorAllMapperTrees(); break;
                case 'mapped-topic-generated': addMappedTargetTopic(message.brokerId, message.topic); colorAllMapperTrees(); break;
                case 'mapper-metrics-update': updateMapperMetrics(message.metrics); break;
                case 'broker-status-all': renderBrokerStatuses(message.data); break;
                case 'broker-status': updateSingleBrokerStatus(message.brokerId, message.status, message.error); break;
            }
        } catch (e) { console.error("Error processing message:", e, message); }
    }

    function renderBrokerStatuses(statusMap) {
        if (!brokerStatusContainer) return;
        brokerStatusContainer.innerHTML = ''; 
        for (const [brokerId, info] of Object.entries(statusMap)) {
            createBrokerStatusElement(brokerId, info.status, info.error);
        }
    }
    
    function createBrokerStatusElement(brokerId, status, error) {
        const item = document.createElement('div');
        item.className = `broker-status-item status-${status}`;
        item.id = `broker-status-${brokerId}`;
        if (error) item.title = `Error: ${error}`; else item.title = `${brokerId}: ${status}`;
        item.innerHTML = `<span class="broker-dot"></span><span class="broker-name">${brokerId}</span>`;
        brokerStatusContainer.appendChild(item);
    }
    
    function updateSingleBrokerStatus(brokerId, status, error) {
        let item = document.getElementById(`broker-status-${brokerId}`);
        if (!item) { createBrokerStatusElement(brokerId, status, error); return; }
        item.classList.remove('status-connected', 'status-connecting', 'status-error', 'status-offline', 'status-disconnected');
        item.classList.add(`status-${status}`);
        if (error) item.title = `Error: ${error}`; else item.title = `${brokerId}: ${status}`;
    }

    async function startApp() {} // Wrapper for reconnect logic

    function finishInitialization(appConfig) {
        if (brokerConfigs.length > 0) {
            const allTopics = brokerConfigs.flatMap(b => b.topics || []);
            subscribedTopicPatterns = [...new Set(allTopics)];
        }

        btnTreeView?.classList.remove('active');
        treeView?.classList.remove('active');
        let defaultViewActivated = false;

        const views = [
            { enabled: appConfig.viewTreeEnabled, btn: btnTreeView, view: 'tree' },
            { enabled: appConfig.viewSvgEnabled, btn: btnMapView, view: 'map' },
            { enabled: appConfig.viewHistoryEnabled, btn: btnHistoryView, view: 'history' },
            { enabled: appConfig.viewMapperEnabled, btn: btnMapperView, view: 'mapper' },
            { enabled: appConfig.viewChartEnabled, btn: btnChartView, view: 'chart' },
            { enabled: appConfig.viewPublishEnabled, btn: btnPublishView, view: 'publish' },
            // [MODIFIED] Chat view is handled separately by the widget logic
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
        
        if (!defaultViewActivated) switchView('tree'); 

        if (btnConfigView) btnConfigView.style.display = appConfig.viewConfigEnabled ? 'block' : 'none';
        
        // --- Init View Managers ---
        mainPayloadViewer = createPayloadViewer({
            topicEl: document.getElementById('payload-topic'),
            contentEl: document.getElementById('payload-content'),
            historyLogEl: document.getElementById('topic-history-log'),
            placeholderEl: document.querySelector('.topic-history-log .history-placeholder'),
            isMultiBroker: isMultiBroker 
        });

        mainTree = createTreeManager(document.getElementById('mqtt-tree'), {
            treeId: 'main',
            onNodeClick: handleMainTreeClick, 
            onCheckboxClick: handleMainTreeCheckboxClick,
            showCheckboxes: true,
            allowFolderCollapse: true,
            isMultiBroker: isMultiBroker 
        });
        
        mapperTree = createTreeManager(document.getElementById('mapper-tree'), {
            treeId: 'mapper',
            onNodeClick: (e, node, brokerId, topic) => { 
                handleMapperNodeClick(e, node, brokerId, topic); 
                document.querySelectorAll('#mapper-tree .selected').forEach(n => n.classList.remove('selected'));
                node.classList.add('selected');
            },
            allowFolderCollapse: true,
            isMultiBroker: isMultiBroker 
        });
        
        chartTree = createTreeManager(document.getElementById('chart-tree'), {
            treeId: 'chart',
            onNodeClick: (e, node, brokerId, topic) => { 
                handleChartNodeClick(e, node, brokerId, topic);
                document.querySelectorAll('#chart-tree .selected').forEach(n => n.classList.remove('selected'));
                node.classList.add('selected');
            },
            allowFolderCollapse: true,
            isMultiBroker: isMultiBroker 
        });

        initSvgView(appConfig);
        initHistoryView({ 
            isMultiBroker: isMultiBroker,
            brokerConfigs: brokerConfigs,
            requestRangeCallback: requestHistoryRange 
        }); 
        
        initMapperView({
            pruneTopicFromFrontend: pruneTopicFromFrontend,
            getSubscribedTopics: () => subscribedTopicPatterns, 
            colorAllTrees: colorAllMapperTrees,
            addPruneIgnorePattern: (pattern) => {
                recentlyPrunedPatterns.add(pattern);
                setTimeout(() => recentlyPrunedPatterns.delete(pattern), PRUNE_IGNORE_DURATION_MS);
            },
            maxSavedMapperVersions: appConfig.maxSavedMapperVersions || 0,
            isMultiBroker: isMultiBroker,
            brokerConfigs: brokerConfigs 
        });

        initChartView({
            getHistory: () => allHistoryEntries,
            requestRangeCallback: requestHistoryRange, 
            colorChartTreeCallback: colorChartTree,
            maxSavedChartConfigs: appConfig.maxSavedChartConfigs || 0,
            isMultiBroker: isMultiBroker 
        });

        initPublishView({
            subscribedTopics: subscribedTopicPatterns, 
            simulatorListContainer: simulatorControls,
            isMultiBroker: isMultiBroker, 
            brokerConfigs: brokerConfigs 
        });

        // [NEW] Initialize Floating Chat Widget Logic
        if (appConfig.viewChatEnabled) {
            initChatView();
            // Only show the FAB if enabled
            const fab = document.getElementById('btn-chat-fab');
            if (fab) fab.style.display = 'flex';
        } else {
            // Hide everything if disabled
            const fab = document.getElementById('btn-chat-fab');
            if (fab) fab.style.display = 'none';
        }
        
        if (appConfig.isSimulatorEnabled) {
            fetch('api/simulator/status').then(res => res.json()).then(data => updateSimulatorStatuses(data.statuses));
        }
        
        makeResizable({ resizerEl: document.getElementById('drag-handle-vertical'), direction: 'vertical', panelA: treeViewWrapper });
        makeResizable({ resizerEl: document.getElementById('drag-handle-horizontal'), direction: 'horizontal', panelA: payloadMainArea, containerEl: payloadContainer });
        // ... (other resizers kept as is) ...
        makeResizable({ resizerEl: document.getElementById('drag-handle-vertical-mapper'), direction: 'vertical', panelA: document.querySelector('.mapper-tree-wrapper') });
        makeResizable({ resizerEl: document.getElementById('drag-handle-horizontal-mapper'), direction: 'horizontal', panelA: document.getElementById('mapper-payload-area'), containerEl: document.getElementById('mapper-payload-container') });
        makeResizable({ resizerEl: document.getElementById('drag-handle-vertical-chart'), direction: 'vertical', panelA: document.querySelector('.chart-tree-wrapper') });
        makeResizable({ resizerEl: document.getElementById('drag-handle-horizontal-chart'), direction: 'horizontal', panelA: document.getElementById('chart-payload-area'), containerEl: document.getElementById('chart-payload-container') });
        makeResizable({ resizerEl: document.getElementById('drag-handle-vertical-publish'), direction: 'vertical', panelA: document.querySelector('.publish-panel-wrapper') });

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
        // ... (other expand/collapse listeners kept as is) ...
        btnMapperExpandAll?.addEventListener('click', () => mapperTree.toggleAllFolders(false));
        btnMapperCollapseAll?.addEventListener('click', () => mapperTree.toggleAllFolders(true));
        mapperFilterInput?.addEventListener('input', () => mapperTree.applyFilter(mapperFilterInput.value));
        btnChartExpandAll?.addEventListener('click', () => chartTree.toggleAllFolders(false));
        btnChartCollapseAll?.addEventListener('click', () => chartTree.toggleAllFolders(true));
        chartFilterInput?.addEventListener('input', () => chartTree.applyFilter(chartFilterInput.value));

        isAppInitialized = true;
        messageBuffer.forEach(msg => processWsMessage(msg));
        messageBuffer = []; 
    }
    
    function toggleRecentHistoryVisibility() {
        if (!topicHistoryContainer) return;
        const isLive = livePayloadToggle.checked;
        topicHistoryContainer.style.display = isLive ? 'none' : 'flex';
        document.getElementById('drag-handle-horizontal').style.display = isLive ? 'none' : 'flex';
    }

    function populateTreesFromHistory() {
        const uniqueTopicsMap = new Map();
        for (let i = allHistoryEntries.length - 1; i >= 0; i--) { 
            const entry = allHistoryEntries[i];
            const key = `${entry.brokerId}|${entry.topic}`; 
            uniqueTopicsMap.set(key, entry);
        }
        const entries = Array.from(uniqueTopicsMap.values());
        if (mainTree) mainTree.rebuild(entries);
        if (mapperTree) mapperTree.rebuild(entries);
        if (chartTree) chartTree.rebuild(entries);
        
        if (getTopicMappingStatus) colorAllMapperTrees();
        if (getChartedTopics) colorChartTree();
    }

    async function pruneTopicFromFrontend(topicPattern) {
        const regex = mqttPatternToRegex(topicPattern);
        allHistoryEntries = allHistoryEntries.filter(entry => !regex.test(entry.topic));
        setSvgHistoryModuleData(allHistoryEntries);
        
        const newState = setHistoryData(allHistoryEntries, false, false); 
        updateChartSliderUI(globalDbMin, globalDbMax, true); 
        pruneChartedVariables(regex); 

        const targetMap = getMappedTargetTopics();
        const keysToRemove = [];
        for (const [key, value] of targetMap.entries()) {
            if (regex.test(value.topic)) keysToRemove.push(key);
        }
        keysToRemove.forEach(key => targetMap.delete(key));

        populateTreesFromHistory(); 

        if (selectedMainTreeNode && regex.test(selectedMainTreeNode.dataset.topic)) {
            selectedMainTreeNode.classList.remove('selected');
            selectedMainTreeNode = null;
            mainPayloadViewer.clear();
        }
    }
});