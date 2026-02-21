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
// [FIX] Implemented refreshSvgLiveState to force immediate refresh when tab is selected
import { initSvgView, updateMap, updateSvgTimelineUI, setSvgHistoryData as setSvgHistoryModuleData, refreshSvgList, refreshSvgLiveState } from './view.svg.js';
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
import { initChatView, toggleChatWidget, onChatStreamMessage } from './view.chat.js'; 
import { initLoginStyles, showLoginOverlay } from './view.login.js';
import { initAdminView, onAdminViewShow } from './view.admin.js';
import { initAlertsView, onAlertsViewShow, onAlertsViewHide, openCreateRuleModal, refreshAlerts } from './view.alerts.js';
document.addEventListener('DOMContentLoaded', () => {
    // Variables must be initialized before being used
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
    const btnCreateAlert = document.getElementById('btn-create-alert-from-tree');
    // View Buttons
    const btnTreeView = document.getElementById('btn-tree-view');
    const btnMapView = document.getElementById('btn-map-view');
    const btnHistoryView = document.getElementById('btn-history-view');
    const btnMapperView = document.getElementById('btn-mapper-view');
    const btnChartView = document.getElementById('btn-chart-view');
    const btnPublishView = document.getElementById('btn-publish-view'); 
    const btnAdminView = document.getElementById('btn-admin-view'); 
    const btnAlertsView = document.getElementById('btn-alerts-view');
    // Views
    const treeView = document.getElementById('tree-view');
    const mapView = document.getElementById('map-view');
    const historyView = document.getElementById('history-view');
    const mapperView = document.getElementById('mapper-view');
    const chartView = document.getElementById('chart-view');
    const publishView = document.getElementById('publish-view'); 
    const adminView = document.getElementById('admin-view'); 
    const alertsView = document.getElementById('alerts-view');
    // Other Elements
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
    // [NEW] Global Alert Banner
    const globalAlertBanner = document.createElement('div');
    globalAlertBanner.className = 'global-alert-banner';
    document.body.appendChild(globalAlertBanner);
    // --- Helper: Inject User Menu in Header ---
    function injectUserMenu(user) {
        const headerContent = document.querySelector('header');
        const existingMenu = document.querySelector('.user-menu');
        if (existingMenu) existingMenu.remove();
        const userDiv = document.createElement('div');
        userDiv.className = 'user-menu';
        userDiv.style.display = 'flex';
        userDiv.style.alignItems = 'center';
        userDiv.style.gap = '10px';
        if (window.innerWidth > 768) {
            userDiv.style.marginLeft = 'auto'; 
            userDiv.style.marginRight = '15px';
        } else {
            userDiv.style.marginTop = '10px';
            userDiv.style.width = '100%';
            userDiv.style.justifyContent = 'space-between';
        }

        // Generate a local SVG avatar data URI instead of using an external API
        function generateLocalAvatar(name) {
            const initial = (name || 'U').charAt(0).toUpperCase();
            let hash = 0;
            for (let i = 0; i < (name || '').length; i++) {
                hash = name.charCodeAt(i) + ((hash << 5) - hash);
            }
            const hue = Math.abs(hash % 360);
            const color = `hsl(${hue}, 70%, 50%)`;
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
                <rect width="32" height="32" fill="${color}" />
                <text x="16" y="22" font-family="-apple-system, Arial, sans-serif" font-size="16" font-weight="bold" fill="white" text-anchor="middle">${initial}</text>
            </svg>`;
            return `data:image/svg+xml;base64,${btoa(svg)}`;
        }

        const avatarUrl = user.avatar || generateLocalAvatar(user.displayName || user.username);
        const isAdminLabel = (user.role === 'admin') ? '<span style="background:var(--color-danger); font-size:0.7em; padding:2px 4px; border-radius:3px; margin-left:5px;">ADMIN</span>' : '';
        
        userDiv.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                <img src="${avatarUrl}" style="width: 32px; height: 32px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.2);">
                <div style="display:flex; flex-direction:column; line-height:1.1;">
                    <span style="font-size: 0.9em; font-weight:bold;">${user.displayName || user.username}</span>
                    ${isAdminLabel}
                </div>
            </div>
            <button id="btn-logout" class="nav-button" style="font-size: 0.8em; padding: 4px 10px; background-color:rgba(220, 53, 69, 0.8);">Logout</button>
        `;
        if (btnConfigView && btnConfigView.parentNode === headerContent) {
            headerContent.insertBefore(userDiv, btnConfigView);
        } else {
            headerContent.appendChild(userDiv);
        }
        document.getElementById('btn-logout').addEventListener('click', async () => {
            try {
                await fetch('auth/logout', { method: 'POST' });
                window.location.reload();
            } catch (e) {
                console.error("Logout failed", e);
                window.location.reload();
            }
        });
    }
    // --- AUTHENTICATION CHECK ---
    initLoginStyles(); 
    // window.currentUser is injected by server.js in index.html
    const currentUser = window.currentUser; 
    if (!currentUser) {
        showLoginOverlay();
        return; 
    }
    console.log("✅ Logged in as:", currentUser.username || currentUser.displayName);
    injectUserMenu(currentUser);
    // --- ADMIN CHECK ---
    // If admin, show the admin tab button
    if (currentUser.role === 'admin' && btnAdminView) {
        btnAdminView.style.display = 'block';
    }
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
    let alertsEnabled = true; // Default
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
    // --- Tab Switching Logic (Updated) ---
    function switchView(viewToShow, updateHistory = true) {
        const views = [treeView, mapView, historyView, mapperView, chartView, publishView, adminView, alertsView];
        const buttons = [btnTreeView, btnMapView, btnHistoryView, btnMapperView, btnChartView, btnPublishView, btnAdminView, btnAlertsView];
        let targetView, targetButton;
        let slug = 'tree'; 
        if (viewToShow === 'map') { targetView = mapView; targetButton = btnMapView; slug = 'svg'; } 
        else if (viewToShow === 'history') { targetView = historyView; targetButton = btnHistoryView; slug = 'history'; }
        else if (viewToShow === 'mapper') { targetView = mapperView; targetButton = btnMapperView; slug = 'mapper'; }
        else if (viewToShow === 'chart') { targetView = chartView; targetButton = btnChartView; slug = 'chart'; }
        else if (viewToShow === 'publish') { targetView = publishView; targetButton = btnPublishView; slug = 'publish'; } 
        else if (viewToShow === 'admin') { targetView = adminView; targetButton = btnAdminView; slug = 'admin'; } 
        else if (viewToShow === 'alerts') { targetView = alertsView; targetButton = btnAlertsView; slug = 'alerts'; }
        else { targetView = treeView; targetButton = btnTreeView; slug = 'tree'; }
        // Safety check for admin view
        if (viewToShow === 'admin' && currentUser.role !== 'admin') {
            console.warn("Unauthorized access to admin view.");
            switchView('tree');
            return;
        }
        views.forEach(v => v?.classList.remove('active'));
        buttons.forEach(b => b?.classList.remove('active'));
        targetView?.classList.add('active');
        targetButton?.classList.add('active');
        trackEvent(`view_switch_${viewToShow || 'tree'}`);
        // View Specific Callbacks
        if (viewToShow === 'history') {
            renderFilteredHistory();
        }
        if (viewToShow === 'admin') {
            onAdminViewShow();
        }
        if (viewToShow === 'alerts') {
            onAlertsViewShow();
        } else {
            onAlertsViewHide(); // Stop polling when hidden
        }
        
        // [FIX] Force SVG to update its DOM from DB instantly when selected
        if (viewToShow === 'map') {
            refreshSvgLiveState();
        }

        if (updateHistory) {
            const base = appBasePath.endsWith('/') ? appBasePath : appBasePath + '/';
            const newUrl = `${base}${slug}/`;
            if (window.location.pathname !== newUrl && window.location.pathname !== newUrl.slice(0, -1)) {
                window.history.pushState({ view: viewToShow }, '', newUrl);
            }
        }
    }
    window.addEventListener('popstate', (event) => {
        if (event.state && event.state.view) {
            switchView(event.state.view, false);
        } else {
            handleRoutingFromUrl();
        }
    });
    function handleRoutingFromUrl() {
        const path = window.location.pathname;
        let viewToLoad = 'tree'; 
        const normalizedBase = appBasePath.endsWith('/') ? appBasePath.slice(0, -1) : appBasePath;
        let relativePath = path;
        if (path.startsWith(normalizedBase)) {
            relativePath = path.substring(normalizedBase.length);
        }
        const cleanPath = relativePath.replace(/^\/|\/$/g, '');
        if (cleanPath === 'svg' || cleanPath === 'map') viewToLoad = 'map';
        else if (cleanPath === 'history') viewToLoad = 'history';
        else if (cleanPath === 'mapper') viewToLoad = 'mapper';
        else if (cleanPath === 'chart') viewToLoad = 'chart';
        else if (cleanPath === 'publish') viewToLoad = 'publish';
        else if (cleanPath === 'admin') viewToLoad = 'admin';
        else if (cleanPath === 'alerts') viewToLoad = 'alerts';
        else viewToLoad = 'tree';
        switchView(viewToLoad, false); 
    }
    btnTreeView?.addEventListener('click', () => switchView('tree'));
    btnMapView?.addEventListener('click', () => switchView('map'));
    btnHistoryView?.addEventListener('click', () => switchView('history'));
    btnMapperView?.addEventListener('click', () => switchView('mapper'));
    btnChartView?.addEventListener('click', () => switchView('chart'));
    btnPublishView?.addEventListener('click', () => switchView('publish')); 
    btnAdminView?.addEventListener('click', () => switchView('admin')); 
    btnAlertsView?.addEventListener('click', () => switchView('alerts'));
    function updateClock() {
        if (!datetimeContainer) return;
        datetimeContainer.textContent = new Date().toLocaleString('sv-SE');
    }
    setInterval(updateClock, 1000);
    updateClock();
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
            if (livePayloadToggle && livePayloadToggle.checked) {
                livePayloadToggle.checked = false;
                livePayloadToggle.dispatchEvent(new Event('change'));
            } else {
                toggleRecentHistoryVisibility();
            }
            const payload = nodeContainer.dataset.payload;
            mainPayloadViewer.display(brokerId, topic, payload);
            // [NEW] Show "Create Alert" button if enabled
            if (btnCreateAlert) {
                // We check if btnAlertsView is visible (enabled) before showing create button
                if (btnAlertsView.style.display !== 'none') {
                    btnCreateAlert.style.display = 'block';
                    btnCreateAlert.onclick = () => {
                        let parsed = null;
                        try { parsed = JSON.parse(payload); } catch(e) {}
                        openCreateRuleModal(topic, parsed); // Call alerts view
                        switchView('alerts');
                    };
                }
            }
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
            console.log(`[App] Requesting History Range: ${new Date(start).toISOString()} -> ${new Date(end).toISOString()}`);
            ws.send(JSON.stringify({ type: 'get-history-range', start: start, end: end, filter: filter }));
        }
    }
    // --- WebSocket Connection & Logic ---
    (async () => {
        try {
            const configResponse = await fetch('api/config');
            if (!configResponse.ok) throw new Error('Failed to fetch config');
            const appConfig = await configResponse.json();
            appBasePath = appConfig.basePath || '/';
            isMultiBroker = appConfig.isMultiBroker || false;
            brokerConfigs = appConfig.brokerConfigs || [];
            alertsEnabled = appConfig.viewAlertsEnabled; // Store enabled state
            const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            let cleanBasePath = appBasePath;
            if (!cleanBasePath.endsWith('/')) {
                cleanBasePath += '/';
            }
            const wsUrl = `${wsProtocol}//${window.location.host}${cleanBasePath}`;
            console.log("Connecting WebSocket to:", wsUrl); 
            ws = new WebSocket(wsUrl);
            ws.onopen = () => finishInitialization(appConfig);
            ws.onmessage = async (event) => {
                const dataText = event.data instanceof Blob ? await event.data.text() : event.data;
                const message = JSON.parse(dataText);
                if (isAppInitialized) processWsMessage(message);
                else messageBuffer.push(message);
            };
            ws.onerror = (err) => console.error("WebSocket Error:", err);
            ws.onclose = (event) => { 
                console.warn(`WebSocket closed (code: ${event.code}). Reconnecting in 3s...`);
                isAppInitialized = false; 
                setTimeout(startApp, 3000); 
            };
        } catch (error) {
            console.error("Failed to fetch initial app configuration:", error);
        }
    })();
    function processWsMessage(message) {
        try {
            switch(message.type) {
                // --- [NEW] Handshake & Chat Stream ---
                case 'welcome':
                    console.log(`[WS] Handshake successful. Client ID: ${message.clientId}`);
                    // Store the Client ID globally so view.chat.js can access it
                    window.wsClientId = message.clientId;
                    break;
                case 'chat-stream':
                    // Route chat stream chunks to the chat view module
                    onChatStreamMessage(message);
                    break;
                // --- [NEW] Global Alert Trigger ---
                case 'alert-triggered':
                    if (alertsEnabled) {
                        showGlobalAlert(message.alert);
                        refreshAlerts(); // Update table if visible
                    }
                    break;
                // --- [ADDED] Alert Updated (e.g. Analysis Complete) ---
                case 'alert-updated':
                    if (alertsEnabled) {
                        // Triggers table refresh to show status change (e.g. Analyzing -> Open) and results
                        refreshAlerts();
                    }
                    break;
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
                case 'simulator-status': updateSimulatorStatuses(message.statuses); break;
                case 'db-bounds':
                    globalDbMin = message.min; globalDbMax = message.max;
                    setDbBounds(globalDbMin, globalDbMax); 
                    updateChartSliderUI(globalDbMin, globalDbMax, true);
                    updateSvgTimelineUI(globalDbMin, globalDbMax);
                    break;
                case 'history-initial-data':
                    allHistoryEntries = message.data.map(entry => ({ ...entry, brokerId: entry.broker_id || entry.brokerId || 'default_broker', timestampMs: new Date(entry.timestamp).getTime() }));
                    console.log(`[App Debug] Initial history loaded: ${allHistoryEntries.length} items.`);
                    setSvgHistoryModuleData(allHistoryEntries);
                    setHistoryData(allHistoryEntries, true, false);
                    populateTreesFromHistory();
                    break;
                case 'history-range-data':
                    console.log(`[App Debug] Received history-range-data: ${message.data.length} entries.`);
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
    function showGlobalAlert(alertData) {
        if (!globalAlertBanner) return;
        const icon = alertData.severity === 'critical' ? '🔥' : '⚠️';
        globalAlertBanner.innerHTML = `
            <span class="alert-banner-icon">${icon}</span>
            <span>ALERT: ${alertData.ruleName}</span>
            <span style="opacity:0.8; font-size:0.9em;">(${alertData.topic})</span>
        `;
        globalAlertBanner.style.backgroundColor = alertData.severity === 'critical' ? 'var(--color-danger)' : '#ff9800';
        globalAlertBanner.classList.add('visible');
        // Hide after 5 seconds
        setTimeout(() => {
            globalAlertBanner.classList.remove('visible');
        }, 5000);
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
    async function startApp() {
        window.location.reload();
    } 
    function finishInitialization(appConfig) {
        if (brokerConfigs.length > 0) {
            const allTopics = brokerConfigs.flatMap(b => b.topics || []);
            subscribedTopicPatterns = [...new Set(allTopics)];
        }
        btnTreeView?.classList.remove('active');
        treeView?.classList.remove('active');
        const views = [
            { enabled: appConfig.viewTreeEnabled, btn: btnTreeView, view: 'tree' },
            { enabled: appConfig.viewSvgEnabled, btn: btnMapView, view: 'map' },
            { enabled: appConfig.viewHistoryEnabled, btn: btnHistoryView, view: 'history' },
            { enabled: appConfig.viewMapperEnabled, btn: btnMapperView, view: 'mapper' },
            { enabled: appConfig.viewChartEnabled, btn: btnChartView, view: 'chart' },
            { enabled: appConfig.viewPublishEnabled, btn: btnPublishView, view: 'publish' },
            { enabled: appConfig.viewAlertsEnabled, btn: btnAlertsView, view: 'alerts' },
        ];
        views.forEach(v => {
            if (v.enabled) {
                v.btn.style.display = 'block';
            } else {
                v.btn.style.display = 'none';
            }
        });
        handleRoutingFromUrl();
        if (btnConfigView) {
            if (appConfig.viewConfigEnabled && currentUser.role === 'admin') {
                const safeBase = appBasePath.endsWith('/') ? appBasePath : appBasePath + '/';
                btnConfigView.href = `${safeBase}config.html`;
                btnConfigView.style.display = 'block';
            } else {
                btnConfigView.style.display = 'none';
            }
        }
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
        initAdminView();
        // [NEW] Conditionally init Alerts view
        if (appConfig.viewAlertsEnabled) {
            initAlertsView();
        }
        if (appConfig.viewChatEnabled) {
            initChatView(appConfig.basePath, () => {
                refreshSvgList();
            });
            const fab = document.getElementById('btn-chat-fab');
            if (fab) fab.style.display = 'flex';
        } else {
            const fab = document.getElementById('btn-chat-fab');
            if (fab) fab.style.display = 'none';
        }
        if (appConfig.isSimulatorEnabled) {
            fetch('api/simulator/status').then(res => res.json()).then(data => updateSimulatorStatuses(data.statuses));
        }
        makeResizable({ resizerEl: document.getElementById('drag-handle-vertical'), direction: 'vertical', panelA: treeViewWrapper });
        makeResizable({ resizerEl: document.getElementById('drag-handle-horizontal'), direction: 'horizontal', panelA: payloadMainArea, containerEl: payloadContainer });
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