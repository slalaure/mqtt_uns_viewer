/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025-2026 Sebastien Lalaurette
 *
 * [UPDATED] Fixed "Live Update" logic to properly tail incoming messages without requiring node selection.
 * [UPDATED] Fixed real-time queue flushing to prevent older messages from overwriting newer ones in the UI.
 * [UPDATED] Replaced explicit I3X UI Toggle with continuous, native I3X model integration inside trees.
 * [UPDATED] Dynamically registers new Data Providers (like CSV parsers) across UI views when they connect.
 * [UPDATED] Integrated Vanilla JS Proxy state manager for reactive UI updates and data-driven routing.
 * [UPDATED] Implemented WebSocket Backpressure UI Feedback for high data rates.
 * [UPDATED] Decoupled WebSocket and Routing logic into dedicated modules.
 * [UPDATED] Fixed Router ViewCallbacks mapping for Mapper and Publish views.
 * [UPDATED] Strongly guarded view initialization and dynamic route generation based on config.
 */

// ---  Module Imports ---
import { state, subscribe } from './state.js';
import { mqttPatternToRegex, makeResizable, trackEvent } from './utils.js';
import { createTreeManager } from './tree-manager.js';
import { createPayloadViewer } from './payload-viewer.js';
import { connectWebSocket, getWebSocket, sendWebSocketMessage } from './ws-client.js';
import realtimeService from './services/realtime-service.js';
import { initRouter, handleRoutingFromUrl } from './router.js';
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
    addAvailableHistoryProvider,
    mountHistoryView,
    unmountHistoryView
} from './view.history.js';
import { initModelerView, onModelerViewShow, unmountModelerView } from './view.modeler.js'; 
import {
    initMapperView,
    updateMapperMetrics,
    updateMapperConfig,
    handleMapperNodeClick,
    getMapperConfig,
    getMappedTargetTopics,
    getTopicMappingStatus,
    addMappedTargetTopic,
    setMapperTheme,
    mountMapperView,
    unmountMapperView
} from './view.mapper.js';
import { 
    initChartView, 
    mountChartView,
    unmountChartView,
    handleChartNodeClick, 
    updateChartSliderUI, 
    getChartedTopics,
    pruneChartedVariables,
    refreshChart 
} from './view.chart.js';
import { 
    initPublishView, 
    setPublishTheme, 
    updateSimulatorStatuses,
    mountPublishView,
    unmountPublishView
} from './view.publish.js';
import { initChatView, toggleChatWidget, onChatStreamMessage } from './view.chat.js'; 
import { initLoginStyles, showLoginOverlay } from './view.login.js';
import { initAdminView, onAdminViewShow, unmountAdminView } from './view.admin.js';
import { initAlertsView, onAlertsViewShow, onAlertsViewHide, openCreateRuleModal, refreshAlerts } from './view.alerts.js';

document.addEventListener('DOMContentLoaded', () => {
    // Global Elements
    const datetimeContainer = document.getElementById('current-datetime');
    const darkModeToggle = document.getElementById('dark-mode-toggle');
    const btnConfigView = document.getElementById('btn-config-view'); 
    const brokerStatusContainer = document.getElementById('connector-status-container');
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

    // --- Sampling Warning Badge (Backpressure UI) ---
    let samplingWarningTimer = null;
    const samplingBadge = document.createElement('div');
    samplingBadge.id = 'sampling-warning-badge';
    samplingBadge.style.cssText = 'display: none; align-items: center; gap: 6px; font-size: 0.75em; font-weight: bold; background-color: rgba(255, 193, 7, 0.2); color: #ffc107; padding: 2px 8px; border-radius: 12px; border: 1px solid rgba(255, 193, 7, 0.5); white-space: nowrap; flex-shrink: 0;';
    samplingBadge.innerHTML = '⚠️ Data rate too high. Displaying sampled data.';
    
    const headerSubRow = document.querySelector('.header-sub-row');
    if (headerSubRow && brokerStatusContainer) {
        headerSubRow.insertBefore(samplingBadge, brokerStatusContainer);
    }

    function showSamplingWarning() {
        if (samplingBadge) {
            samplingBadge.style.display = 'flex';
            clearTimeout(samplingWarningTimer);
            samplingWarningTimer = setTimeout(() => {
                samplingBadge.style.display = 'none';
            }, 3000);
        }
    }

    // --- Helper: Inject User Menu in Header ---
    function injectUserMenu(user) {
        const headerContent = document.querySelector('header');
        const headerActions = document.querySelector('.header-actions');
        const existingMenu = document.querySelector('.user-menu');
        if (existingMenu) existingMenu.remove();

        const userDiv = document.createElement('div');
        userDiv.className = 'user-menu';
        userDiv.style.display = 'flex';
        userDiv.style.alignItems = 'center';
        userDiv.style.gap = '10px';

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
        const isAdminLabel = (user.role === 'admin') ? '<span style="background:var(--color-danger); font-size:0.7em; padding:2px 4px; border-radius:3px; margin-left:5px; color:white;">ADMIN</span>' : '';

        userDiv.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                <img src="${avatarUrl}" style="width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--color-border);">
                <div style="display:flex; flex-direction:column; line-height:1.1;">
                    <span style="font-size: 0.9em; font-weight:bold; white-space: nowrap;">${user.displayName || user.username}</span>
                    ${isAdminLabel}
                </div>
            </div>
            <button id="btn-logout" class="nav-button" style="font-size: 0.8em; padding: 4px 10px; background-color:var(--color-danger); color:white; border:none; cursor:pointer;">Logout</button>
        `;

        if (window.innerWidth > 768 && headerActions) {
            headerActions.appendChild(userDiv);
        } else {
            // Mobile layout
            userDiv.style.marginTop = '10px';
            userDiv.style.width = '100%';
            userDiv.style.justifyContent = 'space-between';
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
        btnAdminView.style.display = 'flex';
    }

    // --- Variables and State ---
    let recentlyPrunedPatterns = new Set();
    const PRUNE_IGNORE_DURATION_MS = 10000;
    
    let isMultiSource = false;
    let providerConfigs = [];
    let dataProviders = [];
    let appBasePath = '/';
    let subscribedTopicPatterns = ['#'];
    let isAppInitialized = false;
    let messageBuffer = [];
    let allHistoryEntries = [];
    let globalDbMin = 0;
    let globalDbMax = Date.now();
    let cachedI3xObjects = [];
    let allKnownTopicsState = new Map(); // [NEW] Keep track of all topics ever seen

    let mainTree, mapperTree, chartTree;    let mainPayloadViewer;
    let selectedMainTreeNode = null; 
    let alertsEnabled = true;

    // --- Global Providers Map ---
    const providersMap = {};

    function guessProviderType(sourceId) {
        if (!sourceId) return 'mqtt';
        const lower = sourceId.toLowerCase();
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

    function updateClock() {
        if (!datetimeContainer) return;
        datetimeContainer.textContent = new Date().toLocaleString('sv-SE');
    }
    setInterval(updateClock, 1000);
    updateClock();

    // --- Reactive Topic Selection ---
    subscribe('currentTopic', (topic) => {
        if (!topic || !state.currentSourceId) return;
        
        // 1. Sync Tree selection (Main Tree)
        const node = document.querySelector(`#mqtt-tree .node-container[data-topic="${topic}"][data-source-id="${state.currentSourceId}"]`);
        if (node && node !== selectedMainTreeNode) {
            if (selectedMainTreeNode) selectedMainTreeNode.classList.remove('selected');
            selectedMainTreeNode = node;
            selectedMainTreeNode.classList.add('selected');
            
            // Expand parents
            let parentLi = node.closest('li').parentElement.closest('li');
            while (parentLi) {
                parentLi.classList.remove('collapsed');
                parentLi = parentLi.parentElement.closest('li');
            }

            // Sync Payload Viewer
            const payload = node.dataset.payload;
            mainPayloadViewer.display(state.currentSourceId, topic, payload);
        }
    });

    /**
     * --- Tree Click Handler ---
     */
    async function handleMainTreeClick(event, nodeContainer, sourceId, topic) {
        const li = nodeContainer.closest('li');
        
        if (selectedMainTreeNode) selectedMainTreeNode.classList.remove('selected');
        selectedMainTreeNode = nodeContainer;
        selectedMainTreeNode.classList.add('selected');
        
        // Update reactive state
        state.currentSourceId = sourceId;
        state.currentTopic = topic;
        
        if (livePayloadToggle && livePayloadToggle.checked) {
            state.isLivePayload = false; 
            livePayloadToggle.checked = false;
            livePayloadToggle.dispatchEvent(new Event('change'));
        } else {
            toggleRecentHistoryVisibility();
        }

        // Handle I3X Semantic Concept Click
        if (nodeContainer.dataset.isI3x === "true") {
            if (!topic && sourceId === 'i3x') {
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
            mainPayloadViewer.display(sourceId, topic || "Folder", "Structural node, no payload.");
            return;
        }

        // Regular Data Payload
        const payload = nodeContainer.dataset.payload;
        mainPayloadViewer.display(sourceId, topic, payload);
        
        if (btnCreateAlert) {
            if (document.getElementById('btn-alerts-view').style.display !== 'none') {
                btnCreateAlert.style.display = 'block';
                btnCreateAlert.onclick = () => {
                    let parsed = null;
                    try { parsed = JSON.parse(payload); } catch(e) {}
                    state.activeView = 'alerts';
                    openCreateRuleModal(topic, parsed);
                };            }
        }

        sendWebSocketMessage({ type: 'get-topic-history', sourceId: sourceId, topic: topic });
    }

    function handleMainTreeCheckboxClick(event, nodeContainer, sourceId, topic) {
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
        const colorFn = (sourceId, topic, li) => {
            if (!topic || sourceId === 'i3x') return; // Skip structural and I3X nodes
            const status = getTopicMappingStatus(sourceId, topic); 
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
        const colorFn = (sourceId, topic, li) => {
            if (!topic || sourceId === 'i3x') return;
            let isOrHasChartedChild = false;
            const folderPathPrefix = `${sourceId}|${topic}/`;
            
            for (const [varId, varInfo] of chartedVars.entries()) {
                if (varInfo.sourceId === sourceId && varInfo.topic === topic) {
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
        console.log(`[App] Requesting History Range: ${new Date(start).toISOString()} -> ${new Date(end).toISOString()}`);
        sendWebSocketMessage({ type: 'get-history-range', start: start, end: end, filter: filter });
    }

    // --- WebSocket Connection & Realtime Service Logic ---
    (async () => {
        try {
            const configResponse = await fetch('api/config');
            if (!configResponse.ok) throw new Error('Failed to fetch config');
            
            const appConfig = await configResponse.json();
            
            appBasePath = appConfig.basePath || '/';
            isMultiSource = appConfig.isMultiSource || false;
            providerConfigs = appConfig.providerConfigs || [];
            dataProviders = appConfig.dataProviders || [];
            alertsEnabled = appConfig.viewAlertsEnabled; 
            
            window.viewModelerEnabled = appConfig.viewModelerEnabled;

            const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            let cleanBasePath = appBasePath;
            if (!cleanBasePath.endsWith('/')) cleanBasePath += '/';
            const wsUrl = `${wsProtocol}//${window.location.host}${cleanBasePath}`;
            
            realtimeService.init(wsUrl, {
                onOpen: () => finishInitialization(appConfig),
                onTopicUpdate: (sourceId, topic, payload) => {
                    updateMap(sourceId, topic, payload);
                },
                onBatchProcessed: (historyEntries) => {
                    const localEntries = historyEntries.map(msg => ({ ...msg, timestampMs: new Date(msg.timestamp).getTime() }));
                    setHistoryData(localEntries, false, true);
                    
                    let localMax = globalDbMax;
                    localEntries.forEach(e => { if (e.timestampMs > localMax) localMax = e.timestampMs; });
                    globalDbMax = localMax;

                    updateHmiTimelineUI(globalDbMin, globalDbMax);
                    updateChartSliderUI(globalDbMin, globalDbMax, false);

                    // Update trees and payload viewer
                    const uniqueInBatch = new Map();
                    localEntries.forEach(e => uniqueInBatch.set(`${e.sourceId}|${e.topic}`, e));

                    uniqueInBatch.forEach(msg => {
                        let ignore = false;
                        for (const pattern of recentlyPrunedPatterns) {
                            try { if (mqttPatternToRegex(pattern).test(msg.topic)) { ignore = true; break; } } catch (e) {}
                        }
                        if (!ignore) {
                            const options = { enableAnimations: true };
                            const node = mainTree?.update(msg.sourceId, msg.topic, msg.payload, msg.timestamp, options);
                            mapperTree?.update(msg.sourceId, msg.topic, msg.payload, msg.timestamp);
                            chartTree?.update(msg.sourceId, msg.topic, msg.payload, msg.timestamp);
                            
                            if (state.isLivePayload && node && mainTree?.isTopicVisible(node)) {
                                mainPayloadViewer.display(msg.sourceId, msg.topic, msg.payload);
                            }
                        }
                    });
                },
                onOtherMessage: (message) => {
                    if (!isAppInitialized) {
                        messageBuffer.push(message);
                        return; // DO NOT PROCESS BEFORE TREES EXIST
                    }
                    processWsMessage(message);
                },
                onSamplingWarning: () => showSamplingWarning(),
                onError: (err) => console.error("Realtime Service Error:", err),
                onClose: () => { isAppInitialized = false; },
                onReconnect: () => startApp()
            });

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
            
            const topicKey = `${msg.sourceId}|${msg.topic}`;
            if (!uniqueTopics.has(topicKey)) {
                uniqueTopics.set(topicKey, msg); 
                updateMap(msg.sourceId, msg.topic, msg.payload);
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
                allKnownTopicsState.set(`${msg.sourceId}|${msg.topic}`, msg); // [NEW] Keep track of live topics
                const options = { enableAnimations: true };
                const node = mainTree?.update(msg.sourceId, msg.topic, msg.payload, msg.timestamp, options);
                mapperTree?.update(msg.sourceId, msg.topic, msg.payload, msg.timestamp);
                chartTree?.update(msg.sourceId, msg.topic, msg.payload, msg.timestamp);
                
                // Live Payload Viewer update
                if (state.isLivePayload && node && mainTree?.isTopicVisible(node)) {
                    mainPayloadViewer.display(msg.sourceId, msg.topic, msg.payload);
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
                case 'korelate-event':
                    if (realtimeMessageQueue.length > REALTIME_QUEUE_LIMIT) {
                        realtimeMessageQueue.splice(0, realtimeMessageQueue.length - (REALTIME_QUEUE_LIMIT / 2));
                        showSamplingWarning();
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
                    allHistoryEntries = message.data.map(entry => ({ ...entry, sourceId: entry.source_id || entry.sourceId || 'default_connector', timestampMs: new Date(entry.timestamp).getTime() }));
                    setHmiHistoryData(allHistoryEntries);
                    setHistoryData(allHistoryEntries, true, false);
                    populateTreesFromHistory();
                    break;
                case 'history-range-data':
                    const rangeEntries = message.data.map(entry => ({ ...entry, sourceId: entry.source_id || entry.sourceId || 'default_connector', timestampMs: new Date(entry.timestamp).getTime() }));
                    allHistoryEntries = rangeEntries;
                    setHmiHistoryData(allHistoryEntries);
                    setHistoryData(allHistoryEntries, false, false, message.requestStart, message.requestEnd);
                    updateChartSliderUI(globalDbMin, globalDbMax, false);
                    refreshChart();
                    populateTreesFromHistory(); 
                    break;
                case 'tree-initial-state':
                    message.data.forEach(entry => {
                        allKnownTopicsState.set(`${entry.source_id || entry.sourceId}|${entry.topic}`, entry);
                    });
                    if (mainTree) mainTree.rebuild(Array.from(allKnownTopicsState.values()));
                    if (mapperTree) mapperTree.rebuild(Array.from(allKnownTopicsState.values()));
                    if (chartTree) chartTree.rebuild(Array.from(allKnownTopicsState.values()));
                    
                    mainTree?.buildI3xTree(cachedI3xObjects);
                    mapperTree?.buildI3xTree(cachedI3xObjects);
                    chartTree?.buildI3xTree(cachedI3xObjects);
                    
                    colorAllMapperTrees(); colorChartTree();
                    break;
                case 'topic-history-data': mainPayloadViewer.updateHistory(message.sourceId, message.topic, message.data); break;
                case 'db-status-update':
                    if (historyTotalMessages) historyTotalMessages.textContent = message.totalMessages.toLocaleString();
                    if (historyDbSize) historyDbSize.textContent = message.dbSizeMB.toFixed(2);
                    if (historyDbLimit) historyDbLimit.textContent = message.dbLimitMB > 0 ? message.dbLimitMB : 'N/A';
                    break;
                case 'pruning-status': if (pruningIndicator) pruningIndicator.classList.toggle('visible', message.status === 'started'); break;
                case 'mapper-config-update': updateMapperConfig(message.config); colorAllMapperTrees(); break;
                case 'mapped-topic-generated': addMappedTargetTopic(message.sourceId, message.topic); colorAllMapperTrees(); break;
                case 'mapper-metrics-update': updateMapperMetrics(message.metrics); break;
                
                case 'connector-status-all': 
                    for (const sourceId of Object.keys(message.data)) {
                        if (!providersMap[sourceId]) {
                            const guessedType = guessProviderType(sourceId);
                            providersMap[sourceId] = guessedType;
                            
                            if (typeof addAvailableHistoryProvider === 'function') {
                                addAvailableHistoryProvider(sourceId, guessedType);
                            }
                            
                            import('./view.publish.js').then(m => {
                                if (m.addAvailablePublishProvider) {
                                    m.addAvailablePublishProvider(sourceId, guessedType);
                                }
                            }).catch(err => { /* ignore */ });
                        }
                    }
                    renderBrokerStatuses(message.data); 
                    break;

                case 'connector-status': 
                    import('./view.mapper.js').then(m => {
                        if (m.addAvailableMapperProvider) m.addAvailableMapperProvider(message.sourceId, guessProviderType(message.sourceId));
                    }).catch(err => { /* ignore */ });
                    updateSingleBrokerStatus(message.sourceId, message.status, message.error); 
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
        for (const [sourceId, info] of Object.entries(statusMap)) {
            createBrokerStatusElement(sourceId, info.status, info.error);
        }
    }

    function createBrokerStatusElement(sourceId, status, error) {
        const item = document.createElement('div');
        item.className = `connector-status-item status-${status}`;
        item.id = `connector-status-${sourceId}`;
        if (error) item.title = `Error: ${error}`; else item.title = `${sourceId}: ${status}`;
        
        item.innerHTML = `<span class="connector-dot"></span><span class="source-name">${sourceId}</span>`;
        brokerStatusContainer.appendChild(item);
    }

    function updateSingleBrokerStatus(sourceId, status, error) {
        let item = document.getElementById(`connector-status-${sourceId}`);
        if (!item) { 
            createBrokerStatusElement(sourceId, status, error); 
            
            if (!providersMap[sourceId]) {
                const guessedType = guessProviderType(sourceId);
                providersMap[sourceId] = guessedType; 
                
                if (typeof addAvailableHistoryProvider === 'function') {
                    addAvailableHistoryProvider(sourceId, guessedType);
                }
                
                import('./view.publish.js').then(m => {
                    if (m.addAvailablePublishProvider) {
                        m.addAvailablePublishProvider(sourceId, guessedType);
                    }
                }).catch(err => { /* Silently ignore if not ready */ });
            }
            return; 
        }
        
        item.classList.remove('status-connected', 'status-connecting', 'status-error', 'status-offline', 'status-disconnected');
        item.classList.add(`status-${status}`);
        
        if (error) item.title = `Error: ${error}`; else item.title = `${sourceId}: ${status}`;
    }

    async function startApp() {
        window.location.reload();
    } 

    async function finishInitialization(appConfig) {
        if (providerConfigs.length > 0) {
            const allTopics = providerConfigs.flatMap(b => b.topics || b.subscribe || []);
            subscribedTopicPatterns = [...new Set(allTopics)];
        }

        (appConfig.providerConfigs || []).forEach(b => { providersMap[b.id] = b.type || 'mqtt'; });
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
            if (btn) btn.style.display = v.enabled ? 'flex' : 'none'; // Use flex for proper icon + text alignment
        });

        if (btnConfigView) {
            if (appConfig.viewConfigEnabled && currentUser.role === 'admin') {
                const safeBase = appBasePath.endsWith('/') ? appBasePath : appBasePath + '/';
                btnConfigView.href = `${safeBase}config.html`;
                btnConfigView.style.display = 'block';
            } else {
                btnConfigView.style.display = 'none';
            }
        }

        // --- Initialize Chart View BEFORE Tree ---
        if (appConfig.viewChartEnabled) {
            await initChartView({
                getHistory: () => allHistoryEntries,
                requestRangeCallback: requestHistoryRange,
                colorChartTreeCallback: colorChartTree,
                maxSavedChartConfigs: appConfig.maxSavedChartConfigs || 0,
                isMultiSource: isMultiSource,
                llmModels: appConfig.llmModels,
                makeResizable: makeResizable
            });
        }

        // --- Init View Managers ---
        mainPayloadViewer = createPayloadViewer({
            topicEl: document.getElementById('payload-topic'),
            contentEl: document.getElementById('payload-content'),
            historyLogEl: document.getElementById('topic-history-log'),
            placeholderEl: document.querySelector('.topic-history-log .history-placeholder'),
            isMultiSource: isMultiSource
        });

        mainTree = createTreeManager('mqtt-tree', {
            treeId: 'main',
            onNodeClick: handleMainTreeClick,
            onCheckboxClick: handleMainTreeCheckboxClick,
            showCheckboxes: true,
            allowFolderCollapse: true,
            isMultiSource: isMultiSource,
            providersMap: providersMap
        });

        mapperTree = createTreeManager('mapper-tree', {
            treeId: 'mapper',
            onNodeClick: (e, node, sourceId, topic) => {
                if (!topic && node.dataset.isI3x !== "true") {
                    node.closest('li').classList.toggle('collapsed');
                    return;
                }
                if (node.dataset.isI3x === "true" && (!topic && sourceId === 'i3x')) {
                    node.closest('li').classList.toggle('collapsed');
                    return;
                }
                handleMapperNodeClick(e, node, sourceId, topic);
                document.querySelectorAll('#mapper-tree .selected').forEach(n => n.classList.remove('selected'));
                node.classList.add('selected');
            },
            allowFolderCollapse: true,
            isMultiSource: isMultiSource,
            providersMap: providersMap
        });

        if (appConfig.viewChartEnabled) {
            chartTree = createTreeManager('chart-tree', {
                treeId: 'chart',
                onNodeClick: (e, node, sourceId, topic) => {
                    if (!topic && node.dataset.isI3x !== "true") {
                        node.closest('li').classList.toggle('collapsed');
                        return;
                    }
                    if (node.dataset.isI3x === "true" && (!topic && sourceId === 'i3x')) {
                        node.closest('li').classList.toggle('collapsed');
                        return;
                    }
                    handleChartNodeClick(e, node, sourceId, topic);
                    document.querySelectorAll('#chart-tree .selected').forEach(n => n.classList.remove('selected'));
                    node.classList.add('selected');
                },
                allowFolderCollapse: true,
                isMultiSource: isMultiSource,
                providersMap: providersMap
            });
        }

        refreshSemanticTrees();

        // Dynamically initialize the configured views to prevent background loading of disabled modules
        if (appConfig.viewHmiEnabled) {
            initHmiView(appConfig);
        }

        if (appConfig.viewHistoryEnabled) {
            initHistoryView({
                isMultiSource: isMultiSource,
                providerConfigs: providerConfigs,
                dataProviders: dataProviders,
                requestRangeCallback: requestHistoryRange
            });
        }

        // Initialize Modeler
        if (appConfig.viewModelerEnabled && currentUser.role === 'admin') {
            initModelerView();
        }

        if (appConfig.viewMapperEnabled) {
            await initMapperView({
                pruneTopicFromFrontend: pruneTopicFromFrontend,
                getSubscribedTopics: () => subscribedTopicPatterns,
                colorAllTrees: colorAllMapperTrees,
                addPruneIgnorePattern: (pattern) => {
                    recentlyPrunedPatterns.add(pattern);
                    setTimeout(() => recentlyPrunedPatterns.delete(pattern), PRUNE_IGNORE_DURATION_MS);
                },
                maxSavedMapperVersions: appConfig.maxSavedMapperVersions || 0,
                isMultiSource: isMultiSource,
                providerConfigs: providerConfigs,
                dataProviders: dataProviders,
                makeResizable: makeResizable
            });
        }

        if (appConfig.viewPublishEnabled) {
            initPublishView({
                subscribedTopics: subscribedTopicPatterns,
                simulatorListContainer: simulatorControls,
                isMultiSource: isMultiSource,
                providerConfigs: providerConfigs,
                dataProviders: dataProviders
            });
        }
        if (currentUser.role === 'admin') {
            initAdminView();
        }

        if (appConfig.viewAlertsEnabled) {
            initAlertsView({
                isMultiSource: isMultiSource,
                providerConfigs: providerConfigs
            });
        }

        if (appConfig.viewChatEnabled) {
            initChatView(appConfig.basePath, appConfig.llmModels, () => {
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

        document.getElementById('btn-mapper-expand-all')?.addEventListener('click', () => mapperTree.toggleAllFolders(false));
        document.getElementById('btn-mapper-collapse-all')?.addEventListener('click', () => mapperTree.toggleAllFolders(true));
        document.getElementById('mapper-filter-input')?.addEventListener('input', (e) => mapperTree.applyFilter(e.target.value));

        document.getElementById('btn-chart-expand-all')?.addEventListener('click', () => chartTree.toggleAllFolders(false));
        document.getElementById('btn-chart-collapse-all')?.addEventListener('click', () => chartTree.toggleAllFolders(true));
        document.getElementById('chart-filter-input')?.addEventListener('input', (e) => chartTree.applyFilter(e.target.value));

        const ROLES = { 'viewer': 10, 'operator': 20, 'engineer': 30, 'admin': 100 };
        const hasRole = (minRole) => {
            const userRole = currentUser?.role || 'viewer';
            return (ROLES[userRole] || 10) >= (ROLES[minRole] || 0);
        };

        // --- Role-Based Tab Visibility ---
        const btnAdmin = document.getElementById('btn-admin-view');
        if (btnAdmin) btnAdmin.style.display = hasRole('admin') ? 'flex' : 'none';
        
        const btnModeler = document.getElementById('btn-modeler-view');
        if (btnModeler) btnModeler.style.display = (appConfig.viewModelerEnabled && hasRole('engineer')) ? 'flex' : 'none';

        const btnMapper = document.getElementById('btn-mapper-view');
        if (btnMapper) btnMapper.style.display = (appConfig.viewMapperEnabled && hasRole('engineer')) ? 'flex' : 'none';

        const btnPublish = document.getElementById('btn-publish-view');
        if (btnPublish) btnPublish.style.display = (appConfig.viewPublishEnabled && hasRole('operator')) ? 'flex' : 'none';

        // Dynamically build the allowed route names
        const routeNames = ['tree'];
        if (appConfig.viewHmiEnabled) routeNames.push('hmi');
        if (appConfig.viewHistoryEnabled) routeNames.push('history');
        if (appConfig.viewModelerEnabled && hasRole('engineer')) routeNames.push('modeler');
        if (appConfig.viewMapperEnabled && hasRole('engineer')) routeNames.push('mapper');
        if (appConfig.viewChartEnabled) routeNames.push('chart');
        if (appConfig.viewPublishEnabled && hasRole('operator')) routeNames.push('publish');
        if (hasRole('admin')) routeNames.push('admin');
        if (appConfig.viewAlertsEnabled) routeNames.push('alerts');

        const viewCallbacks = {
            history: mountHistoryView,
            admin: onAdminViewShow,
            modeler: onModelerViewShow,
            alerts: onAlertsViewShow,
            hmi: () => {
                onHmiViewShow();
                refreshHmiLiveState();
            },
            chart: mountChartView,
            mapper: mountMapperView,
            publish: mountPublishView,
            
            historyHide: unmountHistoryView,
            alertsHide: onAlertsViewHide,
            hmiHide: onHmiViewHide,
            chartHide: unmountChartView,
            mapperHide: unmountMapperView,
            publishHide: unmountPublishView,
            adminHide: unmountAdminView,
            modelerHide: unmountModelerView
        };
        initRouter(appBasePath, routeNames, currentUser, viewCallbacks);
        handleRoutingFromUrl(appBasePath, routeNames);

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
        const mergedTopicsMap = new Map(allKnownTopicsState);
        for (let i = allHistoryEntries.length - 1; i >= 0; i--) { 
            const entry = allHistoryEntries[i];
            const key = `${entry.sourceId}|${entry.topic}`; 
            mergedTopicsMap.set(key, entry);
        }
        const entries = Array.from(mergedTopicsMap.values());
        
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