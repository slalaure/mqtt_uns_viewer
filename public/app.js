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
    let recentlyPrunedPatterns = new Set();
    const PRUNE_IGNORE_DURATION_MS = 10000; // Ignore re-appearing messages for 10 seconds
    
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

    // --- History View Elements ---
    const historyLogContainer = document.getElementById('historical-log-container');
    const historyTotalMessages = document.getElementById('history-total-messages');
    const historyDbSize = document.getElementById('history-db-size');
    const historyDbLimit = document.getElementById('history-db-limit');
    const pruningIndicator = document.getElementById('pruning-indicator');
    const historySearchInput = document.getElementById('history-search-input');
    const timeRangeSliderContainer = document.getElementById('time-range-slider-container');
    const handleMin = document.getElementById('handle-min');
    const handleMax = document.getElementById('handle-max');
    const sliderRange = document.getElementById('slider-range');
    const labelMin = document.getElementById('label-min');
    const labelMax = document.getElementById('label-max');

    // --- SVG View Elements ---
    const svgContent = document.getElementById('svg-content');
    const svgHistoryToggle = document.getElementById('svg-history-toggle');
    const svgTimelineSlider = document.getElementById('svg-timeline-slider-container');
    const svgHandle = document.getElementById('svg-handle');
    const svgLabel = document.getElementById('svg-label');
    let svgInitialTextValues = new Map();

    // --- History State ---
    let allHistoryEntries = [];
    let minTimestamp = 0;
    let maxTimestamp = 0;
    let currentMinTimestamp = 0;
    let currentMaxTimestamp = 0;
    let isSvgHistoryMode = false;

    // --- Simulator UI Elements ---
    const btnStartSim = document.getElementById('btn-start-sim');
    const btnStopSim = document.getElementById('btn-stop-sim');
    const simStatusIndicator = document.getElementById('sim-status');
    const simulatorControls = document.querySelector('.simulator-controls');

    // --- [NEW V2] Mapper View Elements ---
    const mapperTreeWrapper = document.querySelector('.mapper-tree-wrapper');
    const mapperTreeContainer = document.getElementById('mapper-tree'); // This is the mapper tree
    const mapperPayloadContainer = document.getElementById('mapper-payload-container');
    const mapperPayloadArea = document.getElementById('mapper-payload-area');
    const mapperPayloadTopic = document.getElementById('mapper-payload-topic');
    const mapperPayloadContent = document.getElementById('mapper-payload-content');
    const mapperTransformArea = document.getElementById('mapper-transform-area');
    const mapperTransformPlaceholder = document.getElementById('mapper-transform-placeholder');
    const mapperTransformForm = document.getElementById('mapper-transform-form');
    const mapperVersionSelect = document.getElementById('mapper-version-select');
    const mapperSaveButton = document.getElementById('mapper-save-button');
    const mapperSaveAsNewButton = document.getElementById('mapper-save-as-new-button');
    const mapperSaveStatus = document.getElementById('mapper-save-status');
    const mapperSourceTopicInput = document.getElementById('mapper-source-topic');
    const mapperAddTargetButton = document.getElementById('mapper-add-target-button');
    const mapperTargetsList = document.getElementById('mapper-targets-list');
    const mapperTargetsPlaceholder = document.getElementById('mapper-targets-placeholder');
    const mapperTargetTemplate = document.getElementById('mapper-target-template');
    let selectedMapperNode = null;

    // --- [NEW V2] Mapper State ---
    let mapperConfig = { versions: [], activeVersionId: null };
    let mapperMetrics = {};
    let mappedTargetTopics = new Set(); // Set of locally generated topics
    let mapperSaveTimer = null;
    let currentEditingSourceTopic = null;
    let defaultJSCode = ''; // Will be fetched from server

    // --- [NEW] Delete Modal Elements ---
    const deleteModalBackdrop = document.getElementById('delete-rule-modal-backdrop');
    const deleteModalTopic = document.getElementById('delete-modal-topic');
    const deleteModalPattern = document.getElementById('delete-modal-pattern');
    const modalBtnCancel = document.getElementById('modal-btn-cancel');
    const modalBtnDeleteRule = document.getElementById('modal-btn-delete-rule');
    const modalBtnDeletePrune = document.getElementById('modal-btn-delete-prune');
    let deleteModalContext = null; // Will store { rule, target }

    // --- Application Initialization ---
    async function initializeApp() {
        try {
            const response = await fetch('api/config');
            const appConfig = await response.json(); // Renamed to avoid conflict

            // --- [MODIFIED] Store subscribed topics ---
            if (appConfig.subscribedTopics) {
                subscribedTopicPatterns = appConfig.subscribedTopics.split(',').map(t => t.trim());
                console.log("Subscribed Topic Patterns:", subscribedTopicPatterns);
            } else {
                 console.warn("Could not retrieve subscribed topics from API.");
                 subscribedTopicPatterns = ['#']; // Default fallback: subscribe to everything
            }
            // --- END MODIFICATION ---


            if (appConfig.isSimulatorEnabled && simulatorControls) {
                simulatorControls.style.display = 'flex';
                const statusRes = await fetch('api/simulator/status');
                const statusData = await statusRes.json();
                updateSimulatorStatusUI(statusData.status);
            }
        } catch (error) {
            console.error("Failed to fetch app configuration:", error);
        }
        loadSvgPlan();
        loadMapperConfig(); // Load mapper config
    }

    // --- Dynamic SVG Plan Loading ---
    async function loadSvgPlan() {
        try {
            const response = await fetch('view.svg');
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const svgText = await response.text();
            if (svgContent) {
                svgContent.innerHTML = svgText;
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
    const basePath = document.querySelector('base')?.getAttribute('href') || '/';
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}${basePath}`;

    const ws = new WebSocket(wsUrl);
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
                    // ---  Check if topic was recently pruned ---
                    let ignoreForTreeUpdate = false; // Renamed variable for clarity
                    for (const pattern of recentlyPrunedPatterns) {
                        try {
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

                    // --- SVG Update (Happens *before* potentially skipping tree update) ---
                    if (!isSvgHistoryMode) {
                        updateMap(message.topic, message.payload);
                    }
                    // --- End SVG Update ---

                    // --- History Update (Happens *before* potentially skipping tree update) ---
                    const newEntry = { ...message, timestampMs: new Date(message.timestamp).getTime() };
                    const wasLive = currentMaxTimestamp === maxTimestamp;
                    allHistoryEntries.unshift(newEntry);
                    if (newEntry.timestampMs > maxTimestamp) maxTimestamp = newEntry.timestampMs;
                    if (wasLive) {
                        currentMaxTimestamp = maxTimestamp;
                         // Apply filters only if not ignoring (otherwise history might look inconsistent temporarily)
                         if (!ignoreForTreeUpdate) {
                              applyAndRenderFilters();
                         }
                    }
                    updateSliderUI();
                    updateSvgTimelineUI();
                    // --- End History Update ---


                    // --- Tree Updates (Potentially Skipped) ---
                    if (!ignoreForTreeUpdate) {
                         const options = {
                             enableAnimations: true,
                             rulesConfig: mapperConfig,
                             targetTopics: mappedTargetTopics
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

                // --- [NEW V2] Mapper Messages ---
                case 'mapper-config-update':
                    console.log("Received config update from server");
                    mapperConfig = message.config;
                    updateMapperVersionSelector();
                    // Re-color trees
                    colorTreeNodes(treeContainer);
                    colorTreeNodes(mapperTreeContainer);
                    break;
                case 'mapped-topic-generated':
                    mappedTargetTopics.add(message.topic);
                    // No need to re-color tree here, updateTree will handle it
                    // on the next message for that topic.
                    break;
                case 'mapper-metrics-update':
                    mapperMetrics = message.metrics;
                    // If the user is currently editing a rule, update its metrics
                    if (currentEditingSourceTopic) {
                        updateMetricsForEditor(currentEditingSourceTopic);
                    }
                    break;
            }
        } catch (e) {
            console.error("JSON Parsing Error:", dataText, e);
        }
    };

    // --- History View Filtering Logic ---
    function initializeHistoryFilters() {
        if (allHistoryEntries.length === 0) {
            if(timeRangeSliderContainer) timeRangeSliderContainer.style.display = 'none';
            return;
        }
        if(timeRangeSliderContainer) timeRangeSliderContainer.style.display = 'block';
        minTimestamp = allHistoryEntries[allHistoryEntries.length - 1].timestampMs;
        maxTimestamp = allHistoryEntries[0].timestampMs;
        currentMinTimestamp = minTimestamp;
        currentMaxTimestamp = maxTimestamp;
        updateSliderUI();
        updateSvgTimelineUI();
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
        if (!handle) return;
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const sliderRect = timeRangeSliderContainer.getBoundingClientRect();
            const onMouseMove = (moveEvent) => {
                let x = moveEvent.clientX - sliderRect.left;
                let percent = (x / sliderRect.width) * 100;
                percent = Math.max(0, Math.min(100, percent));
                const timeRange = maxTimestamp - minTimestamp;
                const newTimestamp = minTimestamp + (timeRange * percent / 100);
                if (isMin) currentMinTimestamp = Math.min(newTimestamp, currentMaxTimestamp);
                else currentMaxTimestamp = Math.max(newTimestamp, currentMinTimestamp);
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

    // --- SVG Replay Logic ---

    svgHistoryToggle?.addEventListener('change', (e) => {
        isSvgHistoryMode = e.target.checked;
        if(svgTimelineSlider) svgTimelineSlider.style.display = isSvgHistoryMode ? 'flex' : 'none';
        
        // When toggling, replay state up to the end to get in sync
        replaySvgHistory(maxTimestamp);
    });

    function updateSvgTimelineUI() {
        if (!svgHandle || !isSvgHistoryMode) return;
        
        const timeRange = maxTimestamp - minTimestamp;
        if (timeRange <= 0) return;

        const currentTimestamp = parseFloat(svgHandle.dataset.timestamp || maxTimestamp);
        const currentPercent = ((currentTimestamp - minTimestamp) / timeRange) * 100;
        svgHandle.style.left = `${currentPercent}%`;
        svgLabel.textContent = formatTimestampForLabel(currentTimestamp);
    }

    function replaySvgHistory(replayUntilTimestamp) {
        if (!svgContent) return;

        // 1. Reset SVG to its initial state
        svgInitialTextValues.forEach((text, element) => {
            element.textContent = text;
        });

        // 2. Filter messages up to the replay timestamp
        const entriesToReplay = allHistoryEntries.filter(e => e.timestampMs <= replayUntilTimestamp);
        
        // 3. Determine the final state of each topic at that point in time
        const finalState = new Map();
        // Iterate backwards (from oldest to newest) so the last value overwrites previous ones
        for (let i = entriesToReplay.length - 1; i >= 0; i--) {
            const entry = entriesToReplay[i];
            if (!finalState.has(entry.topic)) {
                 finalState.set(entry.topic, entry.payload);
            }
        }

        // 4. Apply the final state to the SVG view
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

                replaySvgHistory(newTimestamp); // Replay history while dragging
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
                const jsonObj = JSON.parse(payload);
                contentEl.textContent = JSON.stringify(jsonObj, null, 2);
            } catch (e) {
                contentEl.textContent = payload;
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
                pre.textContent = JSON.stringify(JSON.parse(entry.payload), null, 2);
            } catch(e) {
                pre.textContent = entry.payload;
            }
            topicHistoryLog.appendChild(div);
        });
    }

    // --- [NEW V2] Unified Tree View Function ---

    /**
     * Finds the active rule configuration for a given topic.
     * @param {string} topic The topic string.
     * @param {object} rulesConfig The full mapper config object.
     * @returns {string|null} 'source' or 'target' if a rule applies, or null.
     */
    function getTopicMappingStatus(topic, rulesConfig, targetTopics) {
        if (!rulesConfig || !rulesConfig.versions) return null;

        // Check if it's a target topic (fast check)
        if (targetTopics.has(topic)) return 'target';

        const activeVersion = rulesConfig.versions.find(v => v.id === rulesConfig.activeVersionId);
        if (!activeVersion) return null;

        // Check if it's a source topic
        for (const rule of activeVersion.rules) {
            if (rule.sourceTopic === topic) {
                return 'source';
            }
            // Check if it's a parent of a rule
            const pattern = rule.sourceTopic.replace(/(\/\+.*|\/\#.*)/g, '');
             if (topic === pattern && topic !== rule.sourceTopic) {
                 return 'source'; // Mark parent folder as source too
            }
        }
        return null;
    }

    /**
     * Recursively colors all nodes in a tree based on mapping rules.
     * @param {HTMLElement} treeRoot The root <ul> element of the tree.
     */
    function colorTreeNodes(treeRoot) {
        if (!treeRoot || !mapperConfig) return;

        const allNodes = treeRoot.querySelectorAll('li');
        allNodes.forEach(li => {
            const nodeContainer = li.querySelector(':scope > .node-container');
            if (!nodeContainer || !nodeContainer.dataset.topic) return;

            const topic = nodeContainer.dataset.topic;
            const status = getTopicMappingStatus(topic, mapperConfig, mappedTargetTopics);

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

                // --- [CORRECTION VERIFIED] ---
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
                    nodeContainer.addEventListener('click', handleMapperNodeClick); // Mapper tree click
                }

                nodeContainer.querySelector('.node-name').textContent = part;
                nodeContainer.dataset.topic = currentTopicPath; // Store full path
                li.appendChild(nodeContainer);
                ul.appendChild(li);
            }

            // Apply coloring
            const mappingStatus = getTopicMappingStatus(currentTopicPath, rulesConfig, targetTopics);
            li.classList.remove('mapped-source', 'mapped-target');
            if (mappingStatus === 'source') li.classList.add('mapped-source');
            else if (mappingStatus === 'target') li.classList.add('mapped-target');

            const nodeContainer = li.querySelector('.node-container');
            const timestampSpan = nodeContainer.querySelector('.node-timestamp');
            if(timestampSpan) timestampSpan.textContent = formattedTimestamp;
            affectedNodes.push({ element: li, isNew: isNewNode });

            // Store payload on the node container regardless of file/folder
            // This ensures folders clicked in mapper view have latest payload of children available
            nodeContainer.dataset.payload = payload;

            if (isLastPart) {
                li.classList.add('is-file');
                li.classList.remove('is-folder', 'collapsed');
            } else {
                li.classList.add('is-folder');
                // --- [CORRECTION VERIFIED] ---
                if (treeRoot === treeContainer) { // Only main tree supports collapse click
                    // Add listener for expanding/collapsing only once
                    if (!nodeContainer.dataset.folderListener) {
                         // Attach listener for collapse/expand
                         nodeContainer.addEventListener('click', handleNodeClick);
                         nodeContainer.dataset.folderListener = 'true';
                    }
                } else { // Mapper tree folders are just for navigation
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
            const payload = targetContainer.dataset.payload;
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

    // --- [NEW V2] Mapper View Logic ---

    // Load initial config from server
    async function loadMapperConfig() {
        try {
            const response = await fetch('api/mapper/config');
            if (!response.ok) throw new Error('Failed to fetch mapper config');
            mapperConfig = await response.json();

            // Fetch default code snippet from server
            // For now, use a hardcoded default.
            defaultJSCode = `// 'msg' object contains msg.topic and msg.payload (parsed JSON).
// Return the modified 'msg' object to publish.
// Return null or undefined to skip publishing.

return msg;
`;

            updateMapperVersionSelector();
            colorTreeNodes(treeContainer);
            colorTreeNodes(mapperTreeContainer);
        } catch (error) {
            console.error('Error loading mapper config:', error);
            showMapperSaveStatus('Error loading config', 'error');
        }
    }

    // Populate the version <select>
    function updateMapperVersionSelector() {
        if (!mapperVersionSelect) return;
        mapperVersionSelect.innerHTML = '';
        mapperConfig.versions.forEach(version => {
            const option = document.createElement('option');
            option.value = version.id;
            option.textContent = version.name;
            if (version.id === mapperConfig.activeVersionId) {
                option.selected = true;
            }
            mapperVersionSelect.appendChild(option);
        });
    }

    // Handle click on Mapper tree node
    function handleMapperNodeClick(event) {
        const targetContainer = event.currentTarget;
        const li = targetContainer.closest('li');

        // Remove selection from old node
        if (selectedMapperNode) {
            selectedMapperNode.classList.remove('selected');
        }
        // Add selection to new node
        selectedMapperNode = targetContainer;
        selectedMapperNode.classList.add('selected');

        const topic = targetContainer.dataset.topic;
        const payload = targetContainer.dataset.payload; // Payload is stored on all nodes

        // --- Check if it's a file or folder ---
        if (li.classList.contains('is-file')) {
            // It's a file node (object) - show payload and editor
            currentEditingSourceTopic = topic; // Store this
            displayPayload(topic, payload, mapperPayloadTopic, mapperPayloadContent);
            renderTransformEditor(topic);
        } else {
            // It's a folder node - show placeholder, hide editor
            currentEditingSourceTopic = null; // Clear editing topic
            displayPayload(topic, "N/A (Folder selected)", mapperPayloadTopic, mapperPayloadContent); // Show folder info
            mapperTransformPlaceholder.style.display = 'block'; // Show placeholder
            mapperTransformForm.style.display = 'none'; // Hide form
        }
    }

    // Find or create a rule object in the active version
    function getRuleForTopic(sourceTopic, createIfMissing = false) {
        const activeVersion = mapperConfig.versions.find(v => v.id === mapperConfig.activeVersionId);
        if (!activeVersion) return null;

        let rule = activeVersion.rules.find(r => r.sourceTopic === sourceTopic);
        if (!rule && createIfMissing) {
            rule = {
                sourceTopic: sourceTopic,
                targets: []
            };
            activeVersion.rules.push(rule);
        }
        return rule;
    }

    // Render the bottom-right editor panel
    function renderTransformEditor(sourceTopic) {
        mapperTransformPlaceholder.style.display = 'none';
        mapperTransformForm.style.display = 'flex';
        mapperSourceTopicInput.value = sourceTopic;
        mapperTargetsList.innerHTML = '';

        const rule = getRuleForTopic(sourceTopic, false); // Don't create yet

        if (!rule || rule.targets.length === 0) {
            mapperTargetsPlaceholder.style.display = 'block';
        } else {
            mapperTargetsPlaceholder.style.display = 'none';
            rule.targets.forEach(target => {
                const targetEditor = createTargetEditor(rule, target);
                mapperTargetsList.appendChild(targetEditor);
            });
        }
        // Ensure metrics are updated when editor is shown
        updateMetricsForEditor(sourceTopic);
    }

    // --- [NEW] MQTT Topic Matching Logic (Simplified Client-Side) ---
    /**
     * Converts an MQTT pattern to a RegExp for simple client-side matching.
     * Note: This is a simplified version and might not cover all edge cases perfectly.
     */
    function mqttPatternToClientRegex(pattern) {
        const regexString = pattern
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
            .replace(/\+/g, '[^/]+') // '+' matches one level segment
            .replace(/#/g, '.*'); // '#' matches zero or more levels at the end
        return new RegExp(`^${regexString}$`);
    }

    /**
     * Checks if a given topic matches any of the subscription patterns.
     */
    function isTopicSubscribed(outputTopic, subscriptionPatterns) {
        if (!subscriptionPatterns || subscriptionPatterns.length === 0) {
            return false; // Should not happen if fallback is '#'
        }
        // Special case: If subscribed to '#', any topic is valid
        if (subscriptionPatterns.includes('#')) {
             return true;
        }

        for (const pattern of subscriptionPatterns) {
             // Handle simple prefix matching for '#' ending patterns
             if (pattern.endsWith('/#')) {
                 const prefix = pattern.substring(0, pattern.length - 1); // Get 'a/b/' from 'a/b/#'
                 if (outputTopic.startsWith(prefix)) {
                     return true;
                 }
             }
             // Handle exact match or '+' matching using Regex (simplified)
             else {
                  const regex = mqttPatternToClientRegex(pattern);
                  if (regex.test(outputTopic)) {
                      return true;
                  }
             }
        }
        return false; // No pattern matched
    }
    // --- END NEW MQTT Topic Matching ---

    // Create the DOM for a single target editor (JavaScript Only Mode)
    function createTargetEditor(rule, target) {
        const template = mapperTargetTemplate.content.cloneNode(true);
        const editorDiv = template.querySelector('.mapper-target-editor');
        editorDiv.dataset.targetId = target.id;

        const isSourceSparkplug = rule.sourceTopic.startsWith('spBv1.0/'); // Check if the rule's source is Sparkplug

        const title = editorDiv.querySelector('.target-editor-title');
        title.textContent = `Target: ${target.id.substring(0, 8)}`;

        const enabledToggle = editorDiv.querySelector('.target-enabled-toggle');
        enabledToggle.checked = target.enabled;
        enabledToggle.addEventListener('change', () => {
            target.enabled = enabledToggle.checked;
        });

        const deleteButton = editorDiv.querySelector('.target-delete-button');
        deleteButton.addEventListener('click', () => {
            showPruneModal(rule, target);
        });

        const outputTopicInput = editorDiv.querySelector('.target-output-topic');
        outputTopicInput.value = target.outputTopic;

        // --- MODIFIED Validation logic ---
        const validateTopic = () => {
            const topicValue = outputTopicInput.value.trim();
            target.outputTopic = topicValue; // Update data model immediately

            let warningMessage = ''; // Store warning message
            let isError = false; // Flag for invalid mapping

            if (topicValue) {
                // Check subscription validity (Warning)
                if (!isTopicSubscribed(topicValue, subscribedTopicPatterns)) {
                    warningMessage = 'Warning: This topic might not be covered by current subscriptions.';
                }
                // Check if republishing Sparkplug to Sparkplug namespace (Warning)
                if (isSourceSparkplug && topicValue.startsWith('spBv1.0/')) {
                    warningMessage += (warningMessage ? '\n' : '') + 'Warning: Republishing Sparkplug data to spBv1.0/ namespace can cause decoding loops. Consider using your UNS namespace.';
                }
                // --- [NEW] Check if mapping JSON source to Sparkplug target (Error/Prevent) ---
                if (!isSourceSparkplug && topicValue.startsWith('spBv1.0/')) {
                    warningMessage = 'ERROR: Cannot map a non-Sparkplug source to the spBv1.0/ namespace. Target topic is invalid.';
                    isError = true; // Mark as error
                }
                // --- END NEW Check ---
            }

            // Apply styles based on validation result
            outputTopicInput.classList.remove('input-warning', 'input-error'); // Clear previous states
            if (isError) {
                outputTopicInput.classList.add('input-error'); // Use a stronger style for errors
                outputTopicInput.title = warningMessage;
            } else if (warningMessage) {
                outputTopicInput.classList.add('input-warning');
                outputTopicInput.title = warningMessage;
            } else {
                outputTopicInput.title = ''; // Clear title if no warnings/errors
            }
        };
        outputTopicInput.addEventListener('input', validateTopic);
        validateTopic(); // Initial validation check
        // --- END MODIFIED Validation ---

        const codeLabel = editorDiv.querySelector('.target-code-label');
        codeLabel.textContent = 'Transform (JavaScript)'; // Label is always JS

        const codeEditor = editorDiv.querySelector('.target-code-editor');
        target.code = (target.code && target.code.includes('return msg;')) ? target.code : defaultJSCode;
        codeEditor.value = target.code;

        codeEditor.addEventListener('input', () => {
            target.code = codeEditor.value;
        });

        updateMetricsForTarget(editorDiv, rule.sourceTopic, target.id);

        return editorDiv;
    }

    // Add New Target button
    mapperAddTargetButton.addEventListener('click', () => {
        if (!currentEditingSourceTopic) return;

        const rule = getRuleForTopic(currentEditingSourceTopic, true); // Create rule if needed

        // --- [NEW] Generate Default Output Topic ---
        // Simple default: append random int to the source topic
        // More complex logic could be added (e.g., replace last segment)
        const defaultOutputTopic = currentEditingSourceTopic + Math.floor(Math.random() * 100);;
        // --- END Default ---

        const newTarget = {
            id: `tgt_${Date.now()}`,
            enabled: true,
            outputTopic: defaultOutputTopic, // Use the default
            mode: "js",
            code: defaultJSCode
        };

        rule.targets.push(newTarget);
        renderTransformEditor(currentEditingSourceTopic); // Re-render
    });

    
    // Update metrics display for all targets in the editor
    function updateMetricsForEditor(sourceTopic) {
        if (!sourceTopic || sourceTopic !== currentEditingSourceTopic) return;

        const rule = getRuleForTopic(sourceTopic, false);
        if (!rule) return; // Exit if the rule doesn't exist (e.g., cleared after delete)

        rule.targets.forEach(target => {
            const editorDiv = mapperTargetsList.querySelector(`.mapper-target-editor[data-target-id="${target.id}"]`);
            if (editorDiv) {
                updateMetricsForTarget(editorDiv, sourceTopic, target.id);
            }
        });
    }


    // Update metrics for a single target editor
    function updateMetricsForTarget(editorDiv, sourceTopic, targetId) {
        const ruleId = `${sourceTopic}::${targetId}`;
        const ruleMetrics = mapperMetrics[ruleId];

        const countSpan = editorDiv.querySelector('.metric-count');
        const logsList = editorDiv.querySelector('.target-logs-list');

        if (ruleMetrics) {
            countSpan.textContent = ruleMetrics.count;
            if (ruleMetrics.logs && ruleMetrics.logs.length > 0) {
                logsList.innerHTML = '';
                ruleMetrics.logs.forEach(log => {
                    const logDiv = document.createElement('div');
                    logDiv.className = 'target-log-entry';
                    logDiv.innerHTML = `
                        <span class="log-entry-ts">${new Date(log.ts).toLocaleTimeString()}</span>
                        <span class="log-entry-topic">${log.outTopic}</span>
                    `;
                    logDiv.title = `Payload: ${log.outPayload}`;
                    logsList.appendChild(logDiv);
                });
            } else {
                logsList.innerHTML = '<p class="history-placeholder">No executions yet.</p>';
            }
        } else {
            countSpan.textContent = '0';
            logsList.innerHTML = '<p class="history-placeholder">No executions yet.</p>';
        }
    }

    // --- Mapper Versioning and Save Logic ---

    // Save button
    mapperSaveButton.addEventListener('click', async () => {
        // --- [NEW] Validation before saving ---
        let hasInvalidMapping = false;
        const activeVersion = mapperConfig.versions.find(v => v.id === mapperConfig.activeVersionId);
        if (activeVersion && activeVersion.rules) {
            for (const rule of activeVersion.rules) {
                const isSourceSparkplug = rule.sourceTopic.startsWith('spBv1.0/');
                for (const target of rule.targets) {
                    if (!isSourceSparkplug && target.outputTopic.startsWith('spBv1.0/')) {
                        hasInvalidMapping = true;
                        console.error(`Invalid Mapping Found: Rule for "${rule.sourceTopic}" targets Sparkplug namespace "${target.outputTopic}" but source is not Sparkplug.`);
                        // Optionally highlight the invalid input field if the editor is currently showing it
                        if (currentEditingSourceTopic === rule.sourceTopic) {
                             const editorDiv = mapperTargetsList.querySelector(`.mapper-target-editor[data-target-id="${target.id}"]`);
                             if(editorDiv) {
                                 const outputTopicInput = editorDiv.querySelector('.target-output-topic');
                                 outputTopicInput?.classList.add('input-error');
                                 outputTopicInput?.focus();
                             }
                        }
                        // break; // Uncomment to stop checking after first error
                    }
                }
                // if (hasInvalidMapping) break; // Uncomment to stop checking after first error
            }
        }

        if (hasInvalidMapping) {
            showMapperSaveStatus('ERROR: Invalid mapping(s) found (JSON Source -> spBv1.0/ Target). Cannot save.', 'error');
            return; // Abort save
        }
        // --- [END] Validation ---


        showMapperSaveStatus('Saving...');
        try {
            // Clean up empty rules (rules with no targets) before saving
            // const activeVersion = mapperConfig.versions.find(v => v.id === mapperConfig.activeVersionId); // Already defined above
            if(activeVersion) {
                activeVersion.rules = activeVersion.rules.filter(r => r.targets && r.targets.length > 0);
            }

            const response = await fetch('api/mapper/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(mapperConfig)
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error || 'Failed to save');
            }
            showMapperSaveStatus('Saved!', 'success');
            // Re-color trees with new rules
            colorTreeNodes(treeContainer);
            colorTreeNodes(mapperTreeContainer);
        } catch (error) {
            console.error('Error saving mapper config:', error);
            showMapperSaveStatus(error.message, 'error');
        }
    });

    // Save as New... button
    mapperSaveAsNewButton.addEventListener('click', () => {
        const activeVersionName = mapperVersionSelect.options[mapperVersionSelect.selectedIndex]?.text || 'current';
        const newVersionName = prompt("Enter a name for the new version:", `Copy of ${activeVersionName}`);
        if (!newVersionName) return;

        const activeVersion = mapperConfig.versions.find(v => v.id === mapperConfig.activeVersionId);
        if (!activeVersion) return;

        // Deep copy the active version
        const newVersion = JSON.parse(JSON.stringify(activeVersion));
        newVersion.id = `v_${Date.now()}`;
        newVersion.name = newVersionName;
        newVersion.createdAt = new Date().toISOString();

        // Clean up empty rules in the new version
        newVersion.rules = newVersion.rules.filter(r => r.targets && r.targets.length > 0);


        mapperConfig.versions.push(newVersion);
        mapperConfig.activeVersionId = newVersion.id;

        updateMapperVersionSelector();
        mapperSaveButton.click(); // Trigger a save
    });

    // Version select change
    mapperVersionSelect.addEventListener('change', () => {
        mapperConfig.activeVersionId = mapperVersionSelect.value;

        // Re-render editor
        if (currentEditingSourceTopic) {
            renderTransformEditor(currentEditingSourceTopic);
        } else {
            // If no topic was selected, hide the editor
             mapperTransformPlaceholder.style.display = 'block';
             mapperTransformForm.style.display = 'none';
        }

        // Re-color trees
        colorTreeNodes(treeContainer);
        colorTreeNodes(mapperTreeContainer);

        // We don't auto-save on version change, user must click "Save"
        // to make this the default active version on next load.
        // But for this session, it's active.
    });

    function showMapperSaveStatus(message, type = 'success') {
        if (!mapperSaveStatus) return;
        mapperSaveStatus.textContent = message;
        mapperSaveStatus.className = type;
        clearTimeout(mapperSaveTimer);
        mapperSaveTimer = setTimeout(() => {
            mapperSaveStatus.textContent = '';
            mapperSaveStatus.className = '';
        }, 3000);
    }

    // --- [ADDED BACK] Delete Modal Logic ---

    function showPruneModal(rule, target) {
        deleteModalContext = { rule, target }; // Store context

        deleteModalTopic.textContent = target.outputTopic;

        // Default pattern suggestion: the exact target topic first
        let pattern = target.outputTopic;
        // If it contains mustaches, try to create a pattern with wildcards
        if (pattern.includes('{{')) {
            // Convertit {{...}} en + (wildcard)
             pattern = target.outputTopic.replace(/\{\{.+?\}\}/g, '+');
            // Si ça se termine par /+, ajoute /#
            if (pattern.endsWith('/+')) {
                pattern = pattern.substring(0, pattern.length - 1) + '#';
            }
        }
        deleteModalPattern.value = pattern;

        deleteModalBackdrop.style.display = 'flex';
    }

    function hidePruneModal() {
        deleteModalBackdrop.style.display = 'none';
        deleteModalContext = null;
    }

    // "Annuler"
    modalBtnCancel.addEventListener('click', hidePruneModal);

    // "Supprimer la règle seulement"
    modalBtnDeleteRule.addEventListener('click', () => {
        if (!deleteModalContext) return;
        const { rule, target } = deleteModalContext;

        // 1. Remove rule from local config
        rule.targets = rule.targets.filter(t => t.id !== target.id);

        // If the rule has no more targets, remove the rule itself
        if (rule.targets.length === 0) {
            const activeVersion = mapperConfig.versions.find(v => v.id === mapperConfig.activeVersionId);
            if(activeVersion) {
                activeVersion.rules = activeVersion.rules.filter(r => r.sourceTopic !== rule.sourceTopic);
            }
             // Hide editor as the rule is gone
             currentEditingSourceTopic = null;
             mapperTransformPlaceholder.style.display = 'block';
             mapperTransformForm.style.display = 'none';
        } else {
            // 2. Re-render editor (only if rule still exists)
            renderTransformEditor(rule.sourceTopic);
        }

        // 3. Save config to backend
        mapperSaveButton.click(); // This will also re-color trees

        // 4. Hide modal
        hidePruneModal();
    });

    // "Supprimer ET Purger l'historique"
    modalBtnDeletePrune.addEventListener('click', async () => {
        if (!deleteModalContext) return;
        const { rule, target } = deleteModalContext;
        const topicPattern = deleteModalPattern.value;

        recentlyPrunedPatterns.add(topicPattern);
        console.log(`Added pattern to ignore list: ${topicPattern}`);
        setTimeout(() => {
             recentlyPrunedPatterns.delete(topicPattern);
             console.log(`Removed pattern from ignore list: ${topicPattern}`);
        }, PRUNE_IGNORE_DURATION_MS);

        // Disable button to prevent double click
        modalBtnDeletePrune.disabled = true;
        showMapperSaveStatus('Purging history...', 'info');

        try {
            // 1. Call backend to prune DB
            const response = await fetch('/api/context/prune-topic', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ topicPattern })
            });
            if (!response.ok) {
                 const errData = await response.json();
                 throw new Error(errData.error || 'Failed to prune database.');
            }
            const result = await response.json();
            console.log(`Pruned ${result.count} entries from DB.`);

            // 2. Remove rule from local config
            rule.targets = rule.targets.filter(t => t.id !== target.id);

             // If the rule has no more targets, remove the rule itself
            let ruleWasRemoved = false;
            if (rule.targets.length === 0) {
                const activeVersion = mapperConfig.versions.find(v => v.id === mapperConfig.activeVersionId);
                if(activeVersion) {
                    activeVersion.rules = activeVersion.rules.filter(r => r.sourceTopic !== rule.sourceTopic);
                }
                 ruleWasRemoved = true;
            }

            // 3. Save config to backend BEFORE pruning frontend
            await mapperSaveButton.click(); // Wait for save to complete (this re-colors trees)

            // 4. Prune frontend data and rebuild trees
            await pruneTopicFromFrontend(topicPattern);

            // 5. Update editor view
            if(ruleWasRemoved) {
                 // Hide editor as the rule is gone
                 currentEditingSourceTopic = null;
                 mapperTransformPlaceholder.style.display = 'block';
                 mapperTransformForm.style.display = 'none';
            } else {
                 // Re-render editor if the rule still exists (other targets remain)
                 renderTransformEditor(rule.sourceTopic);
            }


            showMapperSaveStatus(`Rule deleted & ${result.count} entries pruned.`, 'success');
            hidePruneModal();

        } catch (err) {
            console.error('Error during prune operation:', err);
            showMapperSaveStatus(`Prune failed: ${err.message}`, 'error');
            hidePruneModal();
        } finally {
             modalBtnDeletePrune.disabled = false; // Re-enable button
        }
    });

    /**
     * Converts an MQTT topic pattern to a RegExp.
     * Handles '+' and '#' wildcards.
     */
    function mqttPatternToRegex(pattern) {
        // Escape characters with special meaning in regex, except for '+' and '#'
        const escapedPattern = pattern.replace(/[.^$*?()[\]{}|\\]/g, '\\$&');
        // Convert MQTT wildcards to regex equivalents
        const regexString = escapedPattern
            .replace(/\+/g, '[^/]+')       // '+' matches one level
            .replace(/#/g, '.*');          // '#' matches multiple levels (including zero)
        // Anchor the pattern to match the whole topic string
        return new RegExp(`^${regexString}$`);
    }


    /**
     * Rebuilds both trees from the filtered history.
     */
    function populateTreesFromHistory() {
        // 1. Wipe both trees
        if(treeContainer) treeContainer.innerHTML = '';
        if(mapperTreeContainer) mapperTreeContainer.innerHTML = '';

        // 2. Get latest entry for each topic from filtered history
        const uniqueTopics = new Map();
        // Iterate chronologically to get the latest
        for (let i = allHistoryEntries.length - 1; i >= 0; i--) {
            const entry = allHistoryEntries[i];
             if (!uniqueTopics.has(entry.topic)) {
                 uniqueTopics.set(entry.topic, entry);
             }
        }


        // 3. Re-populate both trees (no animations)
        const options = {
            enableAnimations: false,
            rulesConfig: mapperConfig,
            targetTopics: mappedTargetTopics
        };
        console.log("Repopulated trees from history."); // Add log

        // Sort topics alphabetically before populating for consistent order
        const sortedTopics = Array.from(uniqueTopics.keys()).sort();

        for (const topic of sortedTopics) {
             const entry = uniqueTopics.get(topic);
             updateTree(topic, entry.payload, entry.timestamp, treeContainer, options);
             updateTree(topic, entry.payload, entry.timestamp, mapperTreeContainer, options);
         }
    }

    /**
     * Filters frontend data stores and rebuilds trees after a prune.
     */
    async function pruneTopicFromFrontend(topicPattern) {
        console.log(`Pruning frontend with pattern: ${topicPattern}`);
        const regex = mqttPatternToRegex(topicPattern);

        const initialLength = allHistoryEntries.length;
        allHistoryEntries = allHistoryEntries.filter(entry => !regex.test(entry.topic));
        console.log(`Filtered allHistoryEntries: ${initialLength} -> ${allHistoryEntries.length}`);

        // 2. Filter mappedTargetTopics
        const topicsToRemove = [];
        mappedTargetTopics.forEach(topic => {
            if (regex.test(topic)) {
                topicsToRemove.push(topic);
            }
        });
        topicsToRemove.forEach(topic => mappedTargetTopics.delete(topic));
        console.log(`Removed target topics matching pattern:`, topicsToRemove);

        // 3. Re-render history tab (using the now filtered allHistoryEntries)
        applyAndRenderFilters();

        // 4. Rebuild both trees from the filtered history
        populateTreesFromHistory();

        // 5. If the currently selected node in mapper was pruned, clear selection/editor
         if (selectedMapperNode && regex.test(selectedMapperNode.dataset.topic)) {
             console.log("Clearing selected mapper node.");
             selectedMapperNode.classList.remove('selected');
             selectedMapperNode = null;
             currentEditingSourceTopic = null;
             mapperTransformPlaceholder.style.display = 'block';
             mapperTransformForm.style.display = 'none';
             displayPayload(null, null, mapperPayloadTopic, mapperPayloadContent); // Clear payload display
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
    // --- [FIN AJOUT MODAL LOGIC] ---


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
            const mouseMoveHandler = (ev) => resizePanel(ev, mapperTreeWrapper);
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
            const mouseMoveHandler = (ev) => resizeHorizontalPanel(ev, mapperPayloadArea, mapperPayloadContainer);
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