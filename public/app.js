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
 * [UPDATED] Fixed "Live Update" logic to properly tail incoming messages without requiring node selection.
 * [UPDATED] Fixed real-time queue flushing to prevent older messages from overwriting newer ones in the UI.
 * [UPDATED] Replaced explicit I3X UI Toggle with continuous, native I3X model integration inside trees.
 * [UPDATED] Dynamically registers new Data Providers (like CSV parsers) across UI views when they connect.
 * [UPDATED] Integrated Vanilla JS Proxy state manager for reactive UI updates and data-driven routing.
 */

// ---  Module Imports ---
import { state, subscribe } from './state.js';
import { mqttPatternToRegex, makeResizable, trackEvent } from './utils.js';
import { createTreeManager } from './tree-manager.js';
import { createPayloadViewer } from './payload-viewer.js';
import { 
    initHmiView, 
    updateMap, 
    updateHmiTimelineUI, 
    setHmiHistoryData, 
    refreshHmiList, 
    refreshHmiLiveState,
    onHmiViewHide,
    onHmiViewShow
} from './view.hmi.js';

// --- Frontend error tracking ---
const FRONTEND_LOG_ENDPOINT = '/api/logs/frontend';
let isSendingFrontendLog = false;

async function reportFrontendError(eventData) {
    if (isSendingFrontendLog) return;
    isSendingFrontendLog = true;
    try {
        await fetch(FRONTEND_LOG_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(eventData),
            credentials: 'same-origin'
        });
    } catch (err) {
        console.warn('Failed to report frontend error', err);
    } finally {
        isSendingFrontendLog = false;
    }
}

window.onerror = function(message, source, line, column, error) {
    const payload = {
        type: 'error',
        message: message?.toString(),
        source: source || null,
        line: line || null,
        column: column || null,
        stack: (error && error.stack) ? error.stack.toString() : null,
        user: window.currentUser ? window.currentUser.username || window.currentUser.id : null,
        location: window.location.href,
        timestamp: new Date().toISOString()
    };
    reportFrontendError(payload);
};

window.onunhandledrejection = function(event) {
    const reason = event?.reason;
    const payload = {
        type: 'unhandledrejection',
        message: (reason && reason.message) ? reason.message : (reason ? reason.toString() : 'Unknown'),
        stack: (reason && reason.stack) ? reason.stack.toString() : null,
        user: window.currentUser ? window.currentUser.username || window.currentUser.id : null,
        location: window.location.href,
        timestamp: new Date().toISOString(),
        reason
    };
    reportFrontendError(payload);
};

import { 
    initHistoryView, 
    setHistoryData, 
    renderFilteredHistory, 
    setDbBounds,
    addAvailableHistoryProvider
} from './view.history.js';
import { initModelerView, onModelerViewShow } from './view.modeler.js'; 
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
    // Global Elements
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

    // Global Alert Banner
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
    const currentUser = window.currentUser; 
    if (!currentUser) {
        showLoginOverlay();
        return; 
    }
    console.log("✅ Logged in as:", currentUser.username || currentUser.displayName);
    injectUserMenu(currentUser);

    // If admin, ensure the admin tab button exists and is visible
    const btnAdminView = document.getElementById('btn-admin-view');
    if (currentUser.role === 'admin' && btnAdminView) {
        btnAdminView.style.display = 'block';
    }

    // --- Variables and State ---
    let recentlyPrunedPatterns = new Set();
    const PRUNE_IGNORE_DURATION_MS = 10000;
    
    let isMultiBroker = false;
    let brokerConfigs = [];
    let dataProviders = [];
    let appBasePath = '/';
    let ws; 
    let subscribedTopicPatterns = ['#'];
    let isAppInitialized = false;
    let messageBuffer = [];
    let allHistoryEntries = [];
    let globalDbMin = 0;
    let globalDbMax = Date.now();
    let cachedI3xObjects = [];
    
    let mainTree, mapperTree, chartTree;
    let mainPayloadViewer;
    let selectedMainTreeNode = null; 
    let alertsEnabled = true;

    // --- Global Providers Map ---
    const providersMap = {};

    function guessProviderType(brokerId) {
        if (!brokerId) return 'mqtt';
        const lower = brokerId.toLowerCase();
        if (lower.includes('csv') || lower.includes('file')) return 'file';
        if (lower.includes('opc')) return 'opcua';
        return 'mqtt';
    }

    // --- Frontend Realtime Queue State ---
    let realtimeMessageQueue = [];
    let isFlushingRealtimeQueue = false;
    const REALTIME_QUEUE_LIMIT = 5000;

    async function refreshSemanticTrees() {
        try {
            const safeBasePath = appBasePath.endsWith('/') ? appBasePath.slice(0, -1) : appBasePath;
            const res = await fetch(`${safeBasePath}/api/i3x/objects`);
            if (res.ok) {
                cachedI3xObjects = await res.json();
                mainTree?.buildI3xTree(cachedI3xObjects);
                mapperTree?.buildI3xTree(cachedI3xObjects);
                chartTree?.buildI3xTree(cachedI3xObjects);
            }
        } catch (e) {
            console.error("I3X fetch error:", e);
        }
    }

    window.appCallbacks = {
        ...window.appCallbacks,
        refreshSemanticTrees
    };

    // --- Dark Theme Logic (State Driven) ---
    subscribe('isDarkMode', (isDark) => {
        if (isDark) {
            document.body.classList.add('dark-mode');
            localStorage.setItem('theme', 'dark');
            if (darkModeToggle) darkModeToggle.checked = true;
            setMapperTheme(true);
            if (typeof setPublishTheme === 'function') setPublishTheme(true);
        } else {
            document.body.classList.remove('dark-mode');
            localStorage.setItem('theme', 'light');
            if (darkModeToggle) darkModeToggle.checked = false;
            setMapperTheme(false);
            if (typeof setPublishTheme === 'function') setPublishTheme(false);
        }
    }, true); 

    darkModeToggle?.addEventListener('change', (e) => {
        state.isDarkMode = e.target.checked;
    });

    // ============================================================================
    // --- Data-Driven Routing & View Management ---
    // ============================================================================

    // 1. Subscribe to state.activeView to handle generic DOM toggling & lifecycle
    subscribe('activeView', (newView, oldView) => {
        if (newView === oldView) return;

        // Reset DOM visually
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));

        const targetView = document.getElementById(`${newView}-view`);
        const targetBtn = document.getElementById(`btn-${newView}-view`);

        if (targetView) targetView.classList.add('active');
        if (targetBtn) targetBtn.classList.add('active');

        trackEvent(`view_switch_${newView}`);

        // Handle specific view lifecycle hooks
        switch (newView) {
            case 'history':
                renderFilteredHistory();
                break;
            case 'admin':
                onAdminViewShow();
                break;
            case 'modeler':
                onModelerViewShow();
                break;
            case 'alerts':
                onAlertsViewShow();
                break;
            case 'hmi':
                onHmiViewShow();
                refreshHmiLiveState();
                break;
        }

        // Cleanup hooks for leaving views
        if (oldView === 'alerts') onAlertsViewHide();
        if (oldView === 'hmi') onHmiViewHide();

        // Manage URL History API
        const base = appBasePath.endsWith('/') ? appBasePath : appBasePath + '/';
        const newUrl = `${base}${newView}/`;
        if (window.location.pathname !== newUrl && window.location.pathname !== newUrl.slice(0, -1)) {
            window.history.pushState({ view: newView }, '', newUrl);
        }
    });

    // 2. Bind all navigation buttons dynamically
    const routeNames = ['tree', 'hmi', 'history', 'modeler', 'mapper', 'chart', 'publish', 'admin', 'alerts'];
    routeNames.forEach(route => {
        const btn = document.getElementById(`btn-${route}-view`);
        if (btn) {
            btn.addEventListener('click', () => {
                // Safety Checks
                if (route === 'admin' && currentUser.role !== 'admin') {
                    console.warn("Unauthorized access to admin view.");
                    state.activeView = 'tree';
                    return;
                }
                if (route === 'modeler' && (!window.viewModelerEnabled || currentUser.role !== 'admin')) {
                    console.warn("Unauthorized access to modeler view or view is disabled.");
                    state.activeView = 'tree';
                    return;
                }
                // Update Reactive State
                state.activeView = route;
            });
        }
    });

    // 3. Handle browser back/forward buttons
    window.addEventListener('popstate', (event) => {
        if (event.state && event.state.view) {
            state.activeView = event.state.view;
        } else {
            handleRoutingFromUrl();
        }
    });

    function handleRoutingFromUrl() {
        const path = window.location.pathname;
        const normalizedBase = appBasePath.endsWith('/') ? appBasePath.slice(0, -1) : appBasePath;
        let relativePath = path;
        
        if (path.startsWith(normalizedBase)) {
            relativePath = path.substring(normalizedBase.length);
        }
        const cleanPath = relativePath.replace(/^\/|\/$/g, '');

        // Map URL aliases
        if (cleanPath === 'map' || cleanPath === 'svg') state.activeView = 'hmi';
        else if (routeNames.includes(cleanPath)) state.activeView = cleanPath;
        else state.activeView = 'tree'; // Default fallback
    }

    // ============================================================================

    function updateClock() {
        if (!datetimeContainer) return;
        datetimeContainer.textContent = new Date().toLocaleString('sv-SE');
    }
    setInterval(updateClock, 1000);
    updateClock();

    /**
     * --- Tree Click Handler ---
     */
    async function handleMainTreeClick(event, nodeContainer, brokerId, topic) {
        const li = nodeContainer.closest('li');
        
        if (selectedMainTreeNode) selectedMainTreeNode.classList.remove('selected');
        selectedMainTreeNode = nodeContainer;
        selectedMainTreeNode.classList.add('selected');
        
        // Update reactive state
        state.currentTopic = topic;
        state.currentBrokerId = brokerId;
        
        if (livePayloadToggle && livePayloadToggle.checked) {
            state.isLivePayload = false; 
            livePayloadToggle.checked = false;
            livePayloadToggle.dispatchEvent(new Event('change'));
        } else {
            toggleRecentHistoryVisibility();
        }

        // Handle I3X Semantic Concept Click
        if (nodeContainer.dataset.isI3x === "true") {
            if (!topic && brokerId === 'i3x') {
                li.classList.toggle('collapsed');
                mainPayloadViewer.display('I3X', 'Root', 'Semantic Model Root');
                return;
            }
            const elementId = nodeContainer.dataset.elementId;
            const safeBasePath = appBasePath.endsWith('/') ? appBasePath.slice(0, -1) : appBasePath;
            try {
                mainPayloadViewer.display('I3X Semantic Node', elementId, 'Fetching Contextual Data...');
                const res = await fetch(`${safeBasePath}/api/i3x/objects/value`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ elementIds: [elementId], maxDepth: 1 })
                });
                
                if (res.ok) {
                    const data = await res.json();
                    mainPayloadViewer.display('I3X Semantic Node', elementId, JSON.stringify(data[elementId] || {}, null, 2));
                } else {
                    throw new Error(`API returned ${res.status}`);
                }
            } catch(e) {
                mainPayloadViewer.display('I3X Error', elementId, `Failed to load values: ${e.message}`);
            }
            return; 
        }

        // Structural Nodes don't have payload data
        if (!topic) {
            li.classList.toggle('collapsed');
            mainPayloadViewer.display(brokerId, topic || "Folder", "Structural node, no payload.");
            return;
        }

        // Regular Data Payload
        const payload = nodeContainer.dataset.payload;
        mainPayloadViewer.display(brokerId, topic, payload);
        
        if (btnCreateAlert) {
            if (document.getElementById('btn-alerts-view').style.display !== 'none') {
                btnCreateAlert.style.display = 'block';
                btnCreateAlert.onclick = () => {
                    let parsed = null;
                    try { parsed = JSON.parse(payload); } catch(e) {}
                    openCreateRuleModal(topic, parsed); 
                    state.activeView = 'alerts';
                };
            }
        }

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'get-topic-history', brokerId: brokerId, topic: topic }));
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
            if (!topic || brokerId === 'i3x') return; // Skip structural and I3X nodes
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
            if (!topic || brokerId === 'i3x') return;
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
            dataProviders = appConfig.dataProviders || [];
            alertsEnabled = appConfig.viewAlertsEnabled; 
            
            // Store globally for routing logic
            window.viewModelerEnabled = appConfig.viewModelerEnabled;

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

    // --- Process Batched Realtime Messages ---
    function flushRealtimeMessageQueue() {
        if (realtimeMessageQueue.length === 0) {
            isFlushingRealtimeQueue = false;
            return;
        }

        const batch = realtimeMessageQueue;
        realtimeMessageQueue = [];

        const uniqueTopics = new Map();
        const historyEntries = [];
        let localMax = globalDbMax;

        // Reverse batch to make it Newest -> Oldest for History unshift
        for (let i = batch.length - 1; i >= 0; i--) {
            const msg = batch[i];
            
            const topicKey = `${msg.brokerId}|${msg.topic}`;
            if (!uniqueTopics.has(topicKey)) {
                uniqueTopics.set(topicKey, msg); 
                updateMap(msg.brokerId, msg.topic, msg.payload);
            }
            
            const timestampMs = new Date(msg.timestamp).getTime();
            if (timestampMs > localMax) localMax = timestampMs;
            
            historyEntries.push({ ...msg, timestampMs });
        }

        globalDbMax = localMax;
        
        // Push bulk to history
        setHistoryData(historyEntries, false, true);
        updateHmiTimelineUI(globalDbMin, globalDbMax);
        updateChartSliderUI(globalDbMin, globalDbMax, false);

        // Tree Updates (Deduplicated)
        for (const msg of uniqueTopics.values()) {
            let ignoreForTreeUpdate = false;
            for (const pattern of recentlyPrunedPatterns) {
                try { if (mqttPatternToRegex(pattern).test(msg.topic)) { ignoreForTreeUpdate = true; break; } } catch (e) {}
            }
            if (!ignoreForTreeUpdate) {
                const options = { enableAnimations: true };
                const node = mainTree?.update(msg.brokerId, msg.topic, msg.payload, msg.timestamp, options);
                mapperTree?.update(msg.brokerId, msg.topic, msg.payload, msg.timestamp);
                chartTree?.update(msg.brokerId, msg.topic, msg.payload, msg.timestamp);
                
                // Live Payload Viewer update
                if (state.isLivePayload && node && mainTree?.isTopicVisible(node)) {
                    mainPayloadViewer.display(msg.brokerId, msg.topic, msg.payload);
                }
            }
        }
        
        isFlushingRealtimeQueue = false;
    }

    function processWsMessage(message) {
        try {
            switch(message.type) {
                case 'welcome':
                    console.log(`[WS] Handshake successful. Client ID: ${message.clientId}`);
                    window.wsClientId = message.clientId;
                    break;
                case 'chat-stream':
                    onChatStreamMessage(message);
                    break;
                case 'alert-triggered':
                    if (alertsEnabled) {
                        showGlobalAlert(message.alert);
                        refreshAlerts(); 
                    }
                    break;
                case 'alert-updated':
                    if (alertsEnabled) refreshAlerts();
                    break;
                case 'mqtt-message':
                    if (realtimeMessageQueue.length > REALTIME_QUEUE_LIMIT) {
                        realtimeMessageQueue.splice(0, realtimeMessageQueue.length - (REALTIME_QUEUE_LIMIT / 2));
                    }
                    realtimeMessageQueue.push(message);
                    if (!isFlushingRealtimeQueue) {
                        isFlushingRealtimeQueue = true;
                        requestAnimationFrame(flushRealtimeMessageQueue);
                    }
                    break;
                case 'simulator-status': updateSimulatorStatuses(message.statuses); break;
                case 'db-bounds':
                    globalDbMin = message.min; globalDbMax = message.max;
                    setDbBounds(globalDbMin, globalDbMax); 
                    updateChartSliderUI(globalDbMin, globalDbMax, true);
                    updateHmiTimelineUI(globalDbMin, globalDbMax);
                    break;
                case 'history-initial-data':
                    allHistoryEntries = message.data.map(entry => ({ ...entry, brokerId: entry.broker_id || entry.brokerId || 'default_broker', timestampMs: new Date(entry.timestamp).getTime() }));
                    setHmiHistoryData(allHistoryEntries);
                    setHistoryData(allHistoryEntries, true, false);
                    populateTreesFromHistory();
                    break;
                case 'history-range-data':
                    const rangeEntries = message.data.map(entry => ({ ...entry, brokerId: entry.broker_id || entry.brokerId || 'default_broker', timestampMs: new Date(entry.timestamp).getTime() }));
                    allHistoryEntries = rangeEntries;
                    setHmiHistoryData(allHistoryEntries);
                    setHistoryData(allHistoryEntries, false, false, message.requestStart, message.requestEnd);
                    updateChartSliderUI(globalDbMin, globalDbMax, false);
                    refreshChart();
                    populateTreesFromHistory(); 
                    break;
                case 'tree-initial-state':
                    if (mainTree) mainTree.rebuild(message.data);
                    if (mapperTree) mapperTree.rebuild(message.data);
                    if (chartTree) chartTree.rebuild(message.data);
                    
                    mainTree?.buildI3xTree(cachedI3xObjects);
                    mapperTree?.buildI3xTree(cachedI3xObjects);
                    chartTree?.buildI3xTree(cachedI3xObjects);
                    
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
                
                case 'broker-status-all': 
                    for (const brokerId of Object.keys(message.data)) {
                        if (!providersMap[brokerId]) {
                            const guessedType = guessProviderType(brokerId);
                            providersMap[brokerId] = guessedType;
                            
                            if (typeof addAvailableHistoryProvider === 'function') {
                                addAvailableHistoryProvider(brokerId, guessedType);
                            }
                            
                            import('./view.publish.js').then(m => {
                                if (m.addAvailablePublishProvider) {
                                    m.addAvailablePublishProvider(brokerId, guessedType);
                                }
                            }).catch(err => { /* ignore */ });
                        }
                    }
                    renderBrokerStatuses(message.data); 
                    break;

                case 'broker-status': 
                    import('./view.mapper.js').then(m => {
                        if (m.addAvailableMapperProvider) m.addAvailableMapperProvider(message.brokerId, guessProviderType(message.brokerId));
                    }).catch(err => { /* ignore */ });
                    updateSingleBrokerStatus(message.brokerId, message.status, message.error); 
                    break;
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
        if (!item) { 
            createBrokerStatusElement(brokerId, status, error); 
            
            if (!providersMap[brokerId]) {
                const guessedType = guessProviderType(brokerId);
                providersMap[brokerId] = guessedType; 
                
                if (typeof addAvailableHistoryProvider === 'function') {
                    addAvailableHistoryProvider(brokerId, guessedType);
                }
                
                import('./view.publish.js').then(m => {
                    if (m.addAvailablePublishProvider) {
                        m.addAvailablePublishProvider(brokerId, guessedType);
                    }
                }).catch(err => { /* Silently ignore if not ready */ });
            }
            return; 
        }
        
        item.classList.remove('status-connected', 'status-connecting', 'status-error', 'status-offline', 'status-disconnected');
        item.classList.add(`status-${status}`);
        
        if (error) item.title = `Error: ${error}`; else item.title = `${brokerId}: ${status}`;
    }

    async function startApp() {
        window.location.reload();
    } 

    function finishInitialization(appConfig) {
        if (brokerConfigs.length > 0) {
            const allTopics = brokerConfigs.flatMap(b => b.topics || b.subscribe || []);
            subscribedTopicPatterns = [...new Set(allTopics)];
        }
        
        (appConfig.brokerConfigs || []).forEach(b => { providersMap[b.id] = b.type || 'mqtt'; });
        (appConfig.dataProviders || []).forEach(p => { providersMap[p.id] = p.type || 'file'; });

        // Set visibility of navigation buttons based on config
        const viewsConfig = [
            { enabled: appConfig.viewTreeEnabled, id: 'btn-tree-view' },
            { enabled: appConfig.viewHmiEnabled, id: 'btn-hmi-view' },
            { enabled: appConfig.viewHistoryEnabled, id: 'btn-history-view' },
            { enabled: appConfig.viewModelerEnabled && currentUser.role === 'admin', id: 'btn-modeler-view' }, 
            { enabled: appConfig.viewMapperEnabled, id: 'btn-mapper-view' },
            { enabled: appConfig.viewChartEnabled, id: 'btn-chart-view' },
            { enabled: appConfig.viewPublishEnabled, id: 'btn-publish-view' },
            { enabled: appConfig.viewAlertsEnabled, id: 'btn-alerts-view' },
        ];

        viewsConfig.forEach(v => {
            const btn = document.getElementById(v.id);
            if (btn) btn.style.display = v.enabled ? 'block' : 'none';
        });

        // Use URL to set initial state, triggering routing automatically
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
            isMultiBroker: isMultiBroker,
            providersMap: providersMap
        });

        mapperTree = createTreeManager(document.getElementById('mapper-tree'), {
            treeId: 'mapper',
            onNodeClick: (e, node, brokerId, topic) => { 
                if (!topic && node.dataset.isI3x !== "true") {
                    node.closest('li').classList.toggle('collapsed');
                    return;
                }
                if (node.dataset.isI3x === "true" && (!topic && brokerId === 'i3x')) {
                    node.closest('li').classList.toggle('collapsed');
                    return;
                }
                handleMapperNodeClick(e, node, brokerId, topic); 
                document.querySelectorAll('#mapper-tree .selected').forEach(n => n.classList.remove('selected'));
                node.classList.add('selected');
            },
            allowFolderCollapse: true,
            isMultiBroker: isMultiBroker,
            providersMap: providersMap 
        });

        chartTree = createTreeManager(document.getElementById('chart-tree'), {
            treeId: 'chart',
            onNodeClick: (e, node, brokerId, topic) => { 
                if (!topic && node.dataset.isI3x !== "true") {
                    node.closest('li').classList.toggle('collapsed');
                    return;
                }
                if (node.dataset.isI3x === "true" && (!topic && brokerId === 'i3x')) {
                    node.closest('li').classList.toggle('collapsed');
                    return;
                }
                handleChartNodeClick(e, node, brokerId, topic);
                document.querySelectorAll('#chart-tree .selected').forEach(n => n.classList.remove('selected'));
                node.classList.add('selected');
            },
            allowFolderCollapse: true,
            isMultiBroker: isMultiBroker,
            providersMap: providersMap
        });

        refreshSemanticTrees();

        initHmiView(appConfig);

        initHistoryView({ 
            isMultiBroker: isMultiBroker,
            brokerConfigs: brokerConfigs,
            dataProviders: dataProviders,
            requestRangeCallback: requestHistoryRange 
        }); 

        // Initialize Modeler
        initModelerView();

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
            brokerConfigs: brokerConfigs,
            dataProviders: dataProviders
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
            brokerConfigs: brokerConfigs,
            dataProviders: dataProviders
        });

        initAdminView();

        if (appConfig.viewAlertsEnabled) {
            initAlertsView({
                isMultiBroker: isMultiBroker,
                brokerConfigs: brokerConfigs
            });
        }

        if (appConfig.viewChatEnabled) {
            initChatView(appConfig.basePath, () => {
                refreshHmiList();
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
            state.isLivePayload = event.target.checked;
            if (state.isLivePayload && selectedMainTreeNode) {
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
        const isLive = state.isLivePayload;
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
        
        mainTree?.buildI3xTree(cachedI3xObjects);
        mapperTree?.buildI3xTree(cachedI3xObjects);
        chartTree?.buildI3xTree(cachedI3xObjects);

        if (getTopicMappingStatus) colorAllMapperTrees();
        if (getChartedTopics) colorChartTree();
    }

    async function pruneTopicFromFrontend(topicPattern) {
        const regex = mqttPatternToRegex(topicPattern);
        
        allHistoryEntries = allHistoryEntries.filter(entry => !regex.test(entry.topic));
        
        setHmiHistoryData(allHistoryEntries);
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