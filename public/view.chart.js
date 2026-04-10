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
 * View module for the Chart tab.
 * Handles configuration, data extraction (including primitives), and rendering.
 * [UPDATED] Migrated to Proxy-based reactive state for unsaved changes tracking.
 * [UPDATED] Implemented View Lifecycle Teardown (mount/unmount) to prevent memory leaks.
 * [UPDATED] Chart Rendering Optimization: Update datasets directly without destroying chart instance.
 */

// Import shared utilities and state
import { state, subscribe, unsubscribe } from "./state.js";
import {
  formatTimestampForLabel,
  trackEvent,
  confirmModal,
  showToast,
} from "./utils.js";
import { createPayloadViewer } from "./payload-viewer.js";
import './components/chart-config-bar.js';
import './components/chart-time-slider.js';
import './components/chart-variable-list.js';
import { 
    isBooleanLike, 
    guessGroupKey, 
    getAxisHue, 
    buildChartDatasets,
    PALETTE_HUES 
} from "./libs/chart-logic.mjs";

// --- DOM Element Querying ---
let chartVariableList = null;
let chartMainArea = null;
let chartCanvas = null;
let chartPlaceholder = null;

// Web Components
let configBar = null;
let timeSlider = null;

// --- Module-level State ---
let chartInstance = null;
let selectedChartSourceId = null;
let selectedChartTopic = null;
let chartedVariables = new Map();
let minTimestamp = 0;
let maxTimestamp = 0;
let currentMinTimestamp = 0;
let currentMaxTimestamp = 0;
let isChartLive = true;
let allChartConfigs = { configurations: [] };
let currentConfigId = null;
let maxChartsLimit = 0;
let isMultiSource = false;
let chartSlider = null;
let chartRefreshTimer = null;
let isUserInteracting = false;
let lastSliderUpdate = 0;
let isMounted = false; // Lifecycle flag

// Configuration for Chart
const MAX_POINTS_PER_SERIES = 500;

// --- Semantic Color Palette (Now imported from chart-logic.mjs) ---

let payloadViewer = null;

let appCallbacks = {
  colorChartTreeCallback: () => console.error("colorChartTreeCallback not set"),
};

export function refreshChart() {
  onGenerateChart(false);
}

export function getChartedTopics() {
  return chartedVariables;
}

export function pruneChartedVariables(regex) {
  let wasPruned = false;
  for (const [varId, varInfo] of chartedVariables.entries()) {
    if (regex.test(varInfo.topic)) {
      chartedVariables.delete(varId);
      wasPruned = true;
    }
  }
  if (wasPruned) {
    state.chartUnsaved = true;
    onGenerateChart();
    appCallbacks.colorChartTreeCallback();
    if (selectedChartTopic && regex.test(selectedChartTopic))
      populateChartVariables(null);
  }
}

function toDateTimeLocal(timestamp) {
  if (!timestamp) return "";
  const d = new Date(timestamp);
  const offsetMs = d.getTimezoneOffset() * 60 * 1000;
  return new Date(d.getTime() - offsetMs).toISOString().slice(0, 16);
}

function showChartLoader() {
  if (chartCanvas) chartCanvas.style.opacity = "0.3";
  if (!document.getElementById("chart-spinner-overlay")) {
    const overlay = document.createElement("div");
    overlay.id = "chart-spinner-overlay";
    overlay.style.position = "absolute";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.width = "100%";
    overlay.style.height = "100%";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.backgroundColor = "var(--color-bg-secondary)";
    overlay.style.opacity = "0.7";
    overlay.style.zIndex = "10";
    // CSS Spinner
    overlay.innerHTML = `
            <div style="border: 4px solid var(--color-border); border-top: 4px solid var(--color-primary); border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite;"></div>
            <style>@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }</style>
        `;
    const container = document.getElementById("chart-canvas-container");
    if (container) container.appendChild(overlay);
  }
}

function hideChartLoader() {
  if (chartCanvas) chartCanvas.style.opacity = "1";
  const overlay = document.getElementById("chart-spinner-overlay");
  if (overlay) overlay.remove();
  if (chartedVariables.size === 0 && chartPlaceholder) {
    chartPlaceholder.style.display = "block";
    chartPlaceholder.textContent =
      "Select a topic and check variables to plot, or load a saved chart.";
  } else if (chartPlaceholder) {
    chartPlaceholder.style.display = "none";
  }
}

// --- Named Event Handlers (For easy removal on unmount) ---

const onChartUnsavedChange = (isUnsaved) => {
  if (configBar) {
    const btnChartSaveCurrent = configBar.querySelector("#btn-chart-save-current");
    if (isUnsaved) {
      if (btnChartSaveCurrent && !btnChartSaveCurrent.disabled) {
        btnChartSaveCurrent.classList.add("btn-unsaved");
      }
    } else {
      if (btnChartSaveCurrent) {
        btnChartSaveCurrent.classList.remove("btn-unsaved");
      }
    }
  }
};

const onTypeSelectChange = () => {
  state.chartUnsaved = true;
  onGenerateChart(true);
};
const onConnectNullsChange = () => {
  state.chartUnsaved = true;
  onGenerateChart(true);
};
const onSmartAxisChange = () => {
  state.chartUnsaved = true;
  onGenerateChart(true);
};
const onAggSelectChange = () => {
  state.chartUnsaved = true;
  onGenerateChart(true);
};

const onDateChange = () => {
  if (!configBar) return;
  const startInput = configBar.getStartDateInput();
  const endInput = configBar.getEndDateInput();
  
  const start = startInput && startInput.value
    ? new Date(startInput.value).getTime()
    : 0;
  const end = endInput && endInput.value
    ? new Date(endInput.value).getTime()
    : Date.now();
  if (start && end && start < end) {
    isChartLive = Math.abs(end - Date.now()) < 60000;
    currentMinTimestamp = start;
    currentMaxTimestamp = end;
    updateChartSliderUI(minTimestamp, maxTimestamp, false, true);
    triggerDataFetch();
  }
};

const onCurrentTopicChange = (topic) => {
  if (topic && state.currentSourceId) {
    const node = document.querySelector(
      `#chart-tree .node-container[data-topic="${topic}"][data-source-id="${state.currentSourceId}"]`,
    );
    if (node) {
      document
        .querySelectorAll("#chart-tree .selected")
        .forEach((n) => n.classList.remove("selected"));
      node.classList.add("selected");

      // Expand parents
      let parentLi = node.closest("li").parentElement.closest("li");
      while (parentLi) {
        parentLi.classList.remove("collapsed");
        parentLi = parentLi.parentElement.closest("li");
      }

      // TRIGGER BUSINESS LOGIC: Populate variables and payload viewer
      handleChartNodeClick(null, node, state.currentSourceId, topic);
    }
  }
};

const onCurrentSourceIdChange = (sourceId) => {
  // Optional broker sync
};

function initializeElements() {
  chartMainArea = document.getElementById("chart-main-area");
  chartCanvas = document.getElementById("chart-canvas");
  chartPlaceholder = document.getElementById("chart-placeholder");
  configBar = document.querySelector("chart-config-bar");
  timeSlider = document.querySelector("chart-time-slider");
  chartVariableList = document.querySelector("chart-variable-list");

  payloadViewer = createPayloadViewer({
    topicEl: document.getElementById("chart-payload-topic"),
    contentEl: document.getElementById("chart-payload-content"),
    historyLogEl: null,
    placeholderEl: null,
    isMultiSource: false,
  });
}

/**
 * Initializes the Chart View DOM structure (Called once on app start).
 */
export async function initChartView(callbacks) {
  const {
    displayPayload,
    maxSavedChartConfigs,
    isMultiSource: multiBrokerState,
    requestRangeCallback,
    getHistory,
    ...otherCallbacks
  } = callbacks;
  appCallbacks = { ...appCallbacks, ...otherCallbacks };
  maxChartsLimit = maxSavedChartConfigs || 0;
  isMultiSource = multiBrokerState || false;

  // Load the template
  try {
    const response = await fetch("html/view.chart.html");
    const html = await response.text();
    const container = document.getElementById("chart-view");
    if (container) {
      container.innerHTML = html;
    }
  } catch (error) {
    console.error("Failed to load chart view template:", error);
  }

  initializeElements();

  // Initialize resizers
  if (appCallbacks.makeResizable) {
    appCallbacks.makeResizable({
      resizerEl: document.getElementById("drag-handle-vertical-chart"),
      direction: "vertical",
      panelA: document.querySelector(".chart-tree-wrapper"),
    });
    appCallbacks.makeResizable({
      resizerEl: document.getElementById("drag-handle-horizontal-chart"),
      direction: "horizontal",
      panelA: document.getElementById("chart-payload-area"),
      containerEl: document.getElementById("chart-payload-container"),
    });
  }

  if (configBar) {
    const typeSelect = configBar.getTypeSelect();
    if (typeSelect) {
      // Remove pie option from selector
      for (let i = 0; i < typeSelect.options.length; i++) {
        if (typeSelect.options[i].value === "pie") {
          typeSelect.remove(i);
          break;
        }
      }

      // Inject Aggregation Dropdown Dynamically
      if (!document.getElementById("chart-aggregation-select")) {
        const typeGroup = typeSelect.closest(".form-group");
        if (typeGroup) {
          const aggGroup = document.createElement("div");
          aggGroup.className = "form-group";
          aggGroup.innerHTML = `
              <label for="chart-aggregation-select">Aggregation:</label>
              <select id="chart-aggregation-select" style="padding: 4px 8px; font-size: 0.9em; border-radius: 4px; border: 1px solid var(--color-border); background-color: var(--color-bg-tertiary); color: var(--color-text);">
                  <option value="AUTO">Auto (Mean)</option>
                  <option value="MIN">Min</option>
                  <option value="MAX">Max</option>
                  <option value="MEAN">Mean</option>
                  <option value="MEDIAN">Median</option>
              </select>
          `;
          typeGroup.parentNode.insertBefore(aggGroup, typeGroup);
        }
      }
    }

    const rangeButtons = configBar.getRangeButtonsContainer();
    if (rangeButtons) {
      const createRangeBtn = (text, hours) => {
        const btn = document.createElement("button");
        btn.textContent = text;
        btn.className = "tool-button";
        btn.style.padding = "4px 8px";
        btn.style.fontSize = "0.85em";
        btn.onclick = () => setRelativeRange(hours);
        return btn;
      };
      rangeButtons.innerHTML = "";
      rangeButtons.appendChild(createRangeBtn("1h", 1));
      rangeButtons.appendChild(createRangeBtn("6h", 6));
      rangeButtons.appendChild(createRangeBtn("24h", 24));
      rangeButtons.appendChild(createRangeBtn("7d", 24 * 7));
      rangeButtons.appendChild(createRangeBtn("1M", 24 * 30));
      rangeButtons.appendChild(createRangeBtn("3M", 24 * 30 * 3));
      rangeButtons.appendChild(createRangeBtn("1Y", 24 * 365));
      rangeButtons.appendChild(createRangeBtn("Full", "FULL"));
    }
  }

  loadChartConfig();
}

const onTimeDrag = (event) => {
  const newMin = event.detail.min;
  const newMax = event.detail.max;
  isUserInteracting = true;
  currentMinTimestamp = newMin;
  currentMaxTimestamp = newMax;
  const timeRange = maxTimestamp - minTimestamp;
  if (timeRange > 0) {
    const maxPercent = ((newMax - minTimestamp) / timeRange) * 100;
    isChartLive = maxPercent > 99.9;
  }
  if (configBar) {
    const startInput = configBar.getStartDateInput();
    const endInput = configBar.getEndDateInput();
    if (startInput) startInput.value = toDateTimeLocal(currentMinTimestamp);
    if (endInput) endInput.value = toDateTimeLocal(currentMaxTimestamp);
  }
  if (timeSlider) {
    timeSlider.updateUI(
      minTimestamp,
      maxTimestamp,
      currentMinTimestamp,
      currentMaxTimestamp,
    );
  }
};

const onTimeDragEnd = (event) => {
  const newMin = event.detail.min;
  const newMax = event.detail.max;
  isUserInteracting = false;
  currentMinTimestamp = newMin;
  currentMaxTimestamp = newMax;
  if (configBar) {
    const startInput = configBar.getStartDateInput();
    const endInput = configBar.getEndDateInput();
    if (startInput) startInput.value = toDateTimeLocal(currentMinTimestamp);
    if (endInput) endInput.value = toDateTimeLocal(currentMaxTimestamp);
  }
  triggerDataFetch();
};

const onChartConfigChangeWrapper = () => onChartConfigChange(true);

/**
 * Mounts the view (attaches event listeners).
 * Called by the router when navigating to this view.
 */
export function mountChartView() {
  if (isMounted) return;

  if (configBar) {
    configBar.addEventListener("config-selected", onChartConfigChangeWrapper);
    configBar.addEventListener("save-current", onSaveCurrent);
    configBar.addEventListener("save-as", onSaveAsNew);
    configBar.addEventListener("delete-config", onDeleteConfig);
    configBar.addEventListener("type-changed", onTypeSelectChange);
    configBar.addEventListener("connect-nulls-changed", onConnectNullsChange);
    configBar.addEventListener("smart-axis-changed", onSmartAxisChange);
    configBar.addEventListener("date-changed", onDateChange);
    configBar.addEventListener("clear-all", onClearAll);
    configBar.addEventListener("profile-and-learn", onProfileAndLearn);
    configBar.addEventListener("export-csv", onExportCSV);
    configBar.addEventListener("export-png", onExportPNG);
    configBar.addEventListener("toggle-fullscreen", toggleChartFullscreen);
  }

  if (timeSlider) {
    timeSlider.addEventListener("time-drag", onTimeDrag);
    timeSlider.addEventListener("time-drag-end", onTimeDragEnd);
  }

  const aggSelect = document.getElementById("chart-aggregation-select");
  aggSelect?.addEventListener("change", onAggSelectChange);

  if (chartVariableList) {
    chartVariableList.addEventListener("variable-toggled", onVariableToggled);
    chartVariableList.addEventListener("color-changed", onColorChanged);
  }

  // Subscriptions
  subscribe("chartUnsaved", onChartUnsavedChange);
  subscribe("currentTopic", onCurrentTopicChange, true);
  subscribe("currentSourceId", onCurrentSourceIdChange);

  // Hydrate from global state if something was selected in another view
  if (state.currentTopic && state.currentSourceId) {
      onCurrentTopicChange(state.currentTopic);
  } else if (chartedVariables.size > 0 && !chartInstance) {
      onGenerateChart();
  }

  isMounted = true;  console.log("[Chart View] Mounted.");
}

/**
 * Unmounts the view (removes listeners, destroys heavy objects).
 * Called by the router when navigating away from this view.
 */
export function unmountChartView() {
  if (!isMounted) return;

  // Destroy Chart.js instance to free memory
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }

  if (configBar) {
    configBar.removeEventListener("config-selected", onChartConfigChangeWrapper);
    configBar.removeEventListener("save-current", onSaveCurrent);
    configBar.removeEventListener("save-as", onSaveAsNew);
    configBar.removeEventListener("delete-config", onDeleteConfig);
    configBar.removeEventListener("type-changed", onTypeSelectChange);
    configBar.removeEventListener("connect-nulls-changed", onConnectNullsChange);
    configBar.removeEventListener("smart-axis-changed", onSmartAxisChange);
    configBar.removeEventListener("date-changed", onDateChange);
    configBar.removeEventListener("clear-all", onClearAll);
    configBar.removeEventListener("profile-and-learn", onProfileAndLearn);
    configBar.removeEventListener("export-csv", onExportCSV);
    configBar.removeEventListener("export-png", onExportPNG);
    configBar.removeEventListener("toggle-fullscreen", toggleChartFullscreen);
  }

  if (timeSlider) {
    timeSlider.removeEventListener("time-drag", onTimeDrag);
    timeSlider.removeEventListener("time-drag-end", onTimeDragEnd);
  }

  const aggSelect = document.getElementById("chart-aggregation-select");
  aggSelect?.removeEventListener("change", onAggSelectChange);

  if (chartVariableList) {
    chartVariableList.removeEventListener("variable-toggled", onVariableToggled);
    chartVariableList.removeEventListener("color-changed", onColorChanged);
  }

  // Clean up subscriptions
  unsubscribe("chartUnsaved", onChartUnsavedChange);
  unsubscribe("currentTopic", onCurrentTopicChange, true);
  unsubscribe("currentSourceId", onCurrentSourceIdChange);

  isMounted = false;
  console.log("[Chart View] Unmounted & Cleaned up.");
}

function triggerDataFetch() {
  showChartLoader();
  clearTimeout(chartRefreshTimer);
  chartRefreshTimer = setTimeout(() => {
    onGenerateChart(); // Will trigger the backend API fetch
  }, 200);
}

async function onProfileAndLearn() {
  if (chartedVariables.size === 0) {
    showToast("Please add variables to the chart first.", "warning");
    return;
  }

  const isConfirmed = await confirmModal(
    "AI Learning Studio",
    `Profile the selected range and generate AI suggestions for UNS model and alert rules?`,
    "Start Analysis",
  );

  if (!isConfirmed) return;

  showChartLoader();
  try {
    // 1. Group variables by topic/broker
    const topicsMap = new Map();
    chartedVariables.forEach((varInfo, varId) => {
      const key = `${varInfo.sourceId}|${varInfo.topic}`;
      if (!topicsMap.has(key)) {
        topicsMap.set(key, {
          sourceId: varInfo.sourceId,
          topic: varInfo.topic,
          variables: [],
        });
      }
      let jsonPath = varInfo.path;
      if (jsonPath !== "(value)") {
        jsonPath = jsonPath.startsWith("[") ? "$" + jsonPath : "$." + jsonPath;
      }
      topicsMap.get(key).variables.push({ id: varId, path: jsonPath });
    });

    // 2. Call Profiling API
    const profileResponse = await fetch("api/context/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topics: Array.from(topicsMap.values()),
        startDate: new Date(currentMinTimestamp).toISOString(),
        endDate: new Date(currentMaxTimestamp).toISOString(),
      }),
    });

    if (!profileResponse.ok) throw new Error("Profiling API failed");
    const profileData = await profileResponse.json();

    // 3. Call AI Synthesis
    const learnResponse = await fetch("api/context/learn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileData })
    });

    if (!learnResponse.ok) {
        const err = await learnResponse.json();
        throw new Error(err.error || "AI Synthesis failed");
    }
    const suggestions = await learnResponse.json();

    hideChartLoader();

    // 4. Display Suggestions
    if (suggestions.error) {
        showToast("AI returned invalid JSON. Check console.", "warning");
        console.warn("AI Raw Output:", suggestions.raw);
        await confirmModal("AI Raw Output", `<pre style="white-space: pre-wrap; font-size: 0.85em; max-height: 400px; overflow-y: auto; text-align: left; background: var(--color-bg-tertiary); padding: 10px; border-radius: 4px;">${suggestions.raw}</pre>`, "Close", false);
    } else {
        let localSuggestions = JSON.parse(JSON.stringify(suggestions)); // Deep copy for mutability

        // Helper to format relationships as editable inputs
        const formatRels = (rels, objIdx) => {
            const safeRels = rels || [];
            // We ensure there's at least one empty slot for adding new relationships
            if (safeRels.length === 0 || safeRels[safeRels.length - 1].type) {
                safeRels.push({ type: '', target: '' });
            }
            return safeRels.map((r, relIdx) => `
                <div style="display: flex; gap: 5px; align-items: center; margin-bottom: 5px;">
                    <input list="rel-types-list" class="ai-suggestion-input" style="width: 130px; padding: 4px;" data-path="new_objects.${objIdx}.relationships.${relIdx}.type" value="${r.type}" placeholder="Type">
                    <span>➡️</span>
                    <input list="element-ids-list" class="ai-suggestion-input" style="flex: 1; padding: 4px;" data-path="new_objects.${objIdx}.relationships.${relIdx}.target" value="${r.target}" placeholder="Target Element">
                </div>
            `).join('');
        };

        const html = `
        <style>
            /* Override modal width for this specific studio view */
            #confirm-modal-backdrop .generic-modal-content {
                max-width: 90vw !important;
                width: 1100px !important;
                max-height: 90vh !important;
                display: flex;
                flex-direction: column;
                padding-bottom: 15px !important;
            }
            #confirm-modal-backdrop .generic-modal-body {
                flex: 1;
                overflow-y: auto;
                padding-right: 10px;
                margin-bottom: 15px;
            }
            .ai-studio-grid {
                display: flex;
                flex-direction: column;
                gap: 20px;
                text-align: left;
            }
            .ai-section {
                background: var(--color-bg-secondary);
                border: 1px solid var(--color-border);
                border-radius: 8px;
                padding: 15px;
            }
            .ai-section h4 {
                margin-top: 0;
                padding-bottom: 10px;
                border-bottom: 1px solid var(--color-border);
            }
            .ai-card {
                background: var(--color-bg-primary);
                border: 1px solid var(--color-border);
                border-radius: 6px;
                padding: 15px;
                margin-bottom: 15px;
            }
            .ai-card-header {
                display: flex;
                align-items: center;
                gap: 10px;
                font-size: 1.1em;
                font-weight: bold;
                margin-bottom: 10px;
                padding-bottom: 10px;
                border-bottom: 1px dashed var(--color-border);
            }
            .ai-card-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                gap: 15px;
            }
            .ai-input-group {
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            .ai-input-group label {
                font-size: 0.85em;
                font-weight: bold;
                color: var(--color-text-muted);
            }
            .ai-input-group label span {
                cursor: help;
                border-bottom: 1px dotted var(--color-text-muted);
            }
            .ai-suggestion-input {
                background: var(--color-bg-tertiary);
                color: var(--color-text);
                border: 1px solid var(--color-border);
                padding: 8px;
                border-radius: 4px;
                font-size: 0.9em;
                width: 100%;
                box-sizing: border-box;
            }
            .ai-suggestion-input:focus {
                outline: 1px solid var(--color-primary);
                border-color: var(--color-primary);
            }
            .info-box {
                background: rgba(54, 162, 235, 0.1);
                border-left: 3px solid #36a2eb;
                padding: 10px;
                font-size: 0.85em;
                margin-bottom: 15px;
                border-radius: 0 4px 4px 0;
            }
        </style>
        
        <datalist id="element-ids-list">
            ${(localSuggestions.meta?.existingElementIds || []).map(id => `<option value="${id}"></option>`).join('')}
        </datalist>
        <datalist id="type-ids-list">
            ${(localSuggestions.meta?.existingTypeIds || []).map(id => `<option value="${id}"></option>`).join('')}
        </datalist>
        <datalist id="rel-types-list">
            ${(localSuggestions.meta?.relTypes || []).map(type => `<option value="${type}"></option>`).join('')}
        </datalist>

        <div class="ai-studio-grid">
            
            <!-- New Objects -->
            ${(localSuggestions.new_objects && localSuggestions.new_objects.length > 0) ? `
            <div class="ai-section">
                <h4 style="color: var(--color-success);">🛠️ New UNS Objects Inference</h4>
                <div class="info-box" style="border-left-color: var(--color-success); background: rgba(76, 175, 80, 0.1);">
                    <strong>Ontology Guide:</strong>
                    <ul style="margin-top: 5px; margin-bottom: 0; padding-left: 20px;">
                        <li><span title="Unique identifier in the UNS tree (e.g., 'pump_01')"><b>Element ID</b></span>: The unique instance name.</li>
                        <li><span title="The abstract ObjectType defining this instance's schema (e.g., 'PumpType')"><b>Type ID</b></span>: The class/template it inherits from.</li>
                        <li><span title="The physical MQTT/Kafka topic mapped to this element"><b>Topic</b></span>: The physical data stream.</li>
                        <li><b>Relationships</b>: Link Instances to Instances (e.g., <code>HasParent</code> ➡️ <code>line_1</code>) to build the physical hierarchy. Types belong to Namespaces.</li>
                    </ul>
                </div>
                ${localSuggestions.new_objects.map((o, i) => `
                    <div class="ai-card" style="border-left: 4px solid var(--color-success);">
                        <div class="ai-card-header">
                            <input type="checkbox" data-path="new_objects.${i}._approved" checked style="transform: scale(1.2); cursor: pointer;">
                            <span>${o.elementId}</span>
                        </div>
                        <div class="ai-card-grid">
                            <div class="ai-input-group">
                                <label><span title="Unique identifier in the UNS tree (e.g., 'pump_01')">Element ID ℹ️</span></label>
                                <input type="text" list="element-ids-list" data-path="new_objects.${i}.elementId" value="${o.elementId}" class="ai-suggestion-input">
                            </div>
                            <div class="ai-input-group">
                                <label><span title="The abstract ObjectType defining this instance's schema (e.g., 'PumpType')">Type ID ℹ️</span></label>
                                <input type="text" list="type-ids-list" data-path="new_objects.${i}.type" value="${o.type}" class="ai-suggestion-input">
                            </div>
                            <div class="ai-input-group">
                                <label><span title="The physical MQTT/Kafka topic mapped to this element">Topic Mapping ℹ️</span></label>
                                <input type="text" data-path="new_objects.${i}.topic_mapping" value="${o.topic_mapping || ''}" class="ai-suggestion-input">
                            </div>
                        </div>
                        <div style="margin-top: 15px; font-size: 0.9em; display: flex; flex-direction: column; gap: 10px;">
                            <div><b>Description:</b> ${o.description}</div>
                            <div style="background: var(--color-bg-tertiary); padding: 10px; border-radius: 4px; border: 1px dashed var(--color-border);">
                                <div style="margin-bottom: 8px;"><b>Relationships:</b></div>
                                ${formatRels(o.relationships, i)}
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>` : ''}

            <!-- Schema Updates -->
            <div class="ai-section">
                <h4 style="color: var(--color-primary);">📊 Schema Profiling & Boundaries</h4>
                ${(localSuggestions.schema_updates || []).length > 0 ? `
                <div style="display: flex; flex-direction: column; gap: 10px;">
                    ${(localSuggestions.schema_updates || []).map((s, i) => `
                        <div class="ai-card" style="display: flex; align-items: center; gap: 15px; margin-bottom: 0; padding: 10px 15px;">
                            <input type="checkbox" data-path="schema_updates.${i}._approved" checked style="transform: scale(1.2); cursor: pointer;">
                            <div style="flex: 1; display: flex; align-items: center; gap: 15px; flex-wrap: wrap;">
                                <div style="min-width: 200px; font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${s.variable}">
                                    ${s.variable}
                                </div>
                                <div class="ai-input-group" style="flex-direction: row; align-items: center;">
                                    <label>Nominal:</label>
                                    <input type="number" step="any" data-path="schema_updates.${i}.suggestions.nominal_value" value="${s.suggestions.nominal_value}" class="ai-suggestion-input" style="width: 80px;">
                                </div>
                                <div class="ai-input-group" style="flex-direction: row; align-items: center;">
                                    <label>Min:</label>
                                    <input type="number" step="any" data-path="schema_updates.${i}.suggestions.expected_range.0" value="${s.suggestions.expected_range[0] || 0}" class="ai-suggestion-input" style="width: 80px;">
                                </div>
                                <div class="ai-input-group" style="flex-direction: row; align-items: center;">
                                    <label>Max:</label>
                                    <input type="number" step="any" data-path="schema_updates.${i}.suggestions.expected_range.1" value="${s.suggestions.expected_range[1] || 0}" class="ai-suggestion-input" style="width: 80px;">
                                </div>
                                <div class="ai-input-group" style="flex-direction: row; align-items: center;">
                                    <label>Freq(s):</label>
                                    <input type="number" step="any" data-path="schema_updates.${i}.suggestions.data_frequency_seconds" value="${Math.round(s.suggestions.data_frequency_seconds || 0)}" class="ai-suggestion-input" style="width: 80px;">
                                </div>
                                <div style="margin-left: auto; font-size: 0.85em; color: ${s.suggestions.quality_score > 0.8 ? 'var(--color-success)' : 'var(--color-warning)'}">
                                    Standard Quality Level: ${Math.round(s.suggestions.quality_score * 100)}%
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>` : '<i>No schema updates suggested.</i>'}
            </div>

            <!-- Alert Rules -->
            <div class="ai-section">
                <h4 style="color: var(--color-warning);">🚨 Proposed Smart Alert Rules</h4>
                <div class="info-box" style="border-left-color: var(--color-warning); background: rgba(255, 193, 7, 0.1);">
                    <strong>Rule Constraints:</strong> Conditions must be valid JavaScript (e.g. <code>value > 50</code>). 
                    AI uses debouncing to prevent spam from noisy signals.
                </div>
                ${(localSuggestions.alert_rules || []).map((r, i) => `
                    <div class="ai-card" style="border-left: 4px solid var(--color-warning);">
                        <div class="ai-card-header">
                            <input type="checkbox" data-path="alert_rules.${i}._approved" checked style="transform: scale(1.2); cursor: pointer;">
                            <input type="text" data-path="alert_rules.${i}.name" value="${r.name}" class="ai-suggestion-input" style="font-weight: bold; font-size: 1em; padding: 4px 8px;">
                            <select data-path="alert_rules.${i}.severity" class="ai-suggestion-input" style="width: 120px; margin-left: auto;">
                                <option value="info" ${r.severity==='info'?'selected':''}>Info</option>
                                <option value="warning" ${r.severity==='warning'?'selected':''}>Warning</option>
                                <option value="critical" ${r.severity==='critical'?'selected':''}>Critical</option>
                            </select>
                        </div>
                        <div class="ai-input-group" style="margin-bottom: 10px;">
                            <label>JavaScript Condition</label>
                            <textarea data-path="alert_rules.${i}.condition" class="ai-suggestion-input" style="font-family: 'Courier New', Courier, monospace; height: 60px; resize: vertical;">${r.condition}</textarea>
                        </div>
                        <div style="font-size: 0.9em; display: flex; flex-direction: column; gap: 5px;">
                            <div><b>Description:</b> ${r.description}</div>
                            <div style="color: var(--color-text-muted);"><i>Rationale: ${r.rationale}</i></div>
                        </div>
                    </div>
                `).join('')}
                ${(!localSuggestions.alert_rules || localSuggestions.alert_rules.length === 0) ? '<i>No alert rules suggested.</i>' : ''}
            </div>
            
        </div>
        `;

        // Initialize _approved flag
        if (localSuggestions.new_objects) localSuggestions.new_objects.forEach(o => o._approved = true);
        if (localSuggestions.schema_updates) localSuggestions.schema_updates.forEach(o => o._approved = true);
        if (localSuggestions.alert_rules) localSuggestions.alert_rules.forEach(o => o._approved = true);

        // Global change handler attached to body (since modal DOM is dynamically created/destroyed)
        const updateModelFromInput = (e) => {
            if (!e.target.matches('.ai-suggestion-input, [data-path]')) return;
            const path = e.target.getAttribute('data-path');
            if (!path) return;
            
            const parts = path.split('.');
            let current = localSuggestions;
            for (let i = 0; i < parts.length - 1; i++) {
                if (current[parts[i]] === undefined) {
                    current[parts[i]] = isNaN(parts[i + 1]) ? {} : [];
                }
                current = current[parts[i]];
            }
            const key = parts[parts.length - 1];
            
            if (e.target.type === 'checkbox') {
                current[key] = e.target.checked;
            } else if (e.target.type === 'number') {
                current[key] = parseFloat(e.target.value);
            } else {
                current[key] = e.target.value;
            }
        };

        document.body.addEventListener('change', updateModelFromInput);

        const isApply = await confirmModal("AI Learning Studio - Approval", html, "Apply Approved Changes", false);
        
        document.body.removeEventListener('change', updateModelFromInput);

        if (isApply) {
            showChartLoader();
            try {
                const applyRes = await fetch("api/context/apply-learn", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(localSuggestions)
                });
                const applyResData = await applyRes.json();
                if (!applyRes.ok) {
                    throw new Error(applyResData.error || "Failed to apply changes");
                }
                showToast("Learning applied! UNS Model and Alert Rules updated.", "success");
                if (applyResData.modelChanged) {
                    setTimeout(() => {
                        window.location.reload();
                    }, 1500);
                }
            } catch(e) {
                showToast("Apply Failed: " + e.message, "error");
            }
            hideChartLoader();
        }
    }

  } catch (err) {
    hideChartLoader();
    console.error("Learning Studio Error:", err);
    showToast(err.message, "error");
  }
}

function setRelativeRange(hours) {
  let start,
    end = Date.now();
  isUserInteracting = false;
  if (hours === "FULL") {
    start = minTimestamp > 0 ? minTimestamp : end - 24 * 60 * 60 * 1000;
    isChartLive = true;
  } else {
    start = end - hours * 60 * 60 * 1000;
    if (minTimestamp > 0 && start < minTimestamp) start = minTimestamp;
    isChartLive = true;
  }
  currentMinTimestamp = start;
  currentMaxTimestamp = end;
  updateChartSliderUI(minTimestamp, maxTimestamp, false, true);
  triggerDataFetch();
}

export function handleChartNodeClick(event, nodeContainer, sourceId, topic) {
  const payload = nodeContainer.dataset.payload;
  selectedChartSourceId = sourceId;
  selectedChartTopic = topic;
  if (payloadViewer) {
    payloadViewer.display(sourceId, topic, payload);
  }
  populateChartVariables(payload);
}

export function updateChartSliderUI(
  min,
  max,
  isInitialLoad = false,
  force = false,
) {
  if (!timeSlider) return;
  if (isUserInteracting && !force) return;
  if (!isInitialLoad && !force && Date.now() - lastSliderUpdate < 1000) return;

  lastSliderUpdate = Date.now();
  minTimestamp = min;
  maxTimestamp = max;

  if (isInitialLoad) {
    currentMinTimestamp = min;
    currentMaxTimestamp = max;
    isChartLive = true;
  } else if (isChartLive && !force) {
    const duration = currentMaxTimestamp - currentMinTimestamp;
    currentMaxTimestamp = max;
    currentMinTimestamp = max - duration;
    if (currentMinTimestamp < min) currentMinTimestamp = min;
  }

  if (configBar) {
    const startInput = configBar.getStartDateInput();
    const endInput = configBar.getEndDateInput();
    if (startInput)
      startInput.value = toDateTimeLocal(currentMinTimestamp);
    if (endInput)
      endInput.value = toDateTimeLocal(currentMaxTimestamp);
  }

  // Use component logic to control visibility if possible, or assume it handles it
  if (timeSlider) {
     const container = timeSlider.querySelector('#chart-time-range-slider-container');
     if (container) {
         container.style.display = min === 0 && max === 0 ? "none" : "flex";
     }
  }

  timeSlider.updateUI(
    minTimestamp,
    maxTimestamp,
    currentMinTimestamp,
    currentMaxTimestamp,
  );

  if (isChartLive && !isInitialLoad && !force && chartedVariables.size > 0) {
    onGenerateChart(false);
  }
}

// --- Helpers: Parsing ---
function getNestedValue(obj, path) {
  if (typeof path !== "string" || !obj) return undefined;
  const parts = path.split(/\.|\[|\]/).filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current)) {
      const metric = current.find((m) => m.name === part);
      current = metric ? metric.value : undefined;
    } else {
      current = current[part];
    }
  }
  return current;
}

function findNumericKeys(obj, path = "", list = []) {
  if (obj === null || typeof obj !== "object") return list;
  if (Array.isArray(obj)) {
    if (
      obj.length > 0 &&
      obj.every(
        (item) =>
          typeof item === "object" &&
          item.hasOwnProperty("name") &&
          item.hasOwnProperty("value"),
      )
    ) {
      obj.forEach((metric) => {
        const newPath = path ? `${path}[${metric.name}]` : `[${metric.name}]`;
        const value = metric.value;
        if (typeof value === "number") {
          list.push({
            path: newPath,
            type: Number.isInteger(value) ? "int" : "float",
            value: value
          });
        } else if (typeof value === "string" && value.trim() !== "") {
          if (!isNaN(parseFloat(value)) && isFinite(Number(value))) {
            list.push({
              path: newPath,
              type: value.includes(".") ? "float (string)" : "int (string)",
              value: value
            });
          }
        }
      });
    }
    return list;
  }
  for (const key of Object.keys(obj)) {
    const newPath = path ? `${path}.${key}` : key;
    const value = obj[key];
    if (typeof value === "number") {
      list.push({
        path: newPath,
        type: Number.isInteger(value) ? "int" : "float",
        value: value
      });
    } else if (typeof value === "string" && value.trim() !== "") {
      if (!isNaN(parseFloat(value)) && isFinite(Number(value))) {
        list.push({
          path: newPath,
          type: value.includes(".") ? "float (string)" : "int (string)",
          value: value
        });
      }
    } else if (typeof value === "object") {
      findNumericKeys(value, newPath, list);
    }
  }
  return list;
}

function renderVariableList(topic, sourceId, variables) {
  if (chartVariableList) {
    chartVariableList.updateData(topic, sourceId, variables, chartedVariables);
  }
}

function populateChartVariables(payloadString) {
  if (!chartVariableList) return;
  if (!selectedChartTopic || !selectedChartSourceId) {
    renderVariableList(selectedChartTopic, selectedChartSourceId, []);
    return;
  }
  if (payloadString === null || payloadString === undefined) {
    renderVariableList(selectedChartTopic, selectedChartSourceId, []);
    return;
  }
  try {
    const payload = JSON.parse(payloadString);
    let numericKeys = [];
    if (typeof payload === "number" || typeof payload === "boolean") {
      numericKeys.push({ path: "(value)", type: typeof payload, value: payload });
    } else if (
      typeof payload === "string" &&
      !isNaN(parseFloat(payload)) &&
      isFinite(Number(payload))
    ) {
      numericKeys.push({ path: "(value)", type: "float (string)", value: payload });
    } else {
      numericKeys = findNumericKeys(payload);
    }
    
    renderVariableList(selectedChartTopic, selectedChartSourceId, numericKeys);
  } catch (e) {
    renderVariableList(selectedChartTopic, selectedChartSourceId, []);
  }
}

function onClearAll() {
  trackEvent("chart_clear_all");
  chartedVariables.clear();
  if (chartVariableList && typeof chartVariableList.renderList === 'function') {
    chartVariableList.renderList();
  }
  if (configBar) {
    const typeSelect = configBar.getTypeSelect();
    if (typeSelect) typeSelect.value = "line";
    const connectNulls = configBar.getConnectNullsToggle();
    if (connectNulls) connectNulls.checked = false;
    const configSelect = configBar.getSelectElement();
    if (configSelect) configSelect.value = "";
  }
  currentConfigId = null;
  state.chartUnsaved = false;
  onGenerateChart(true);
  appCallbacks.colorChartTreeCallback();
}

const onVariableToggled = (e) => {
  const { id, sourceId, topic, path, checked } = e.detail;
  state.chartUnsaved = true;

  if (checked) {
    if (!chartedVariables.has(id)) {
      chartedVariables.set(id, {
        sourceId: sourceId,
        topic: topic,
        path: path,
      });
    }
    trackEvent("chart_add_variable");
  } else {
    chartedVariables.delete(id);
    trackEvent("chart_remove_variable");
  }
  onGenerateChart(true);
  appCallbacks.colorChartTreeCallback();
};

const onColorChanged = (e) => {
  const { id, color } = e.detail;
  if (chartedVariables.has(id)) {
    chartedVariables.get(id).color = color;
    state.chartUnsaved = true;
    onGenerateChart(false);
  }
};

function onGenerateChart(showLoader = false) {
  trackEvent("chart_generate_refresh");
  if (isUserInteracting) {
    return;
  }
  
  // Default to 1 hour range if not set
  if (currentMaxTimestamp === 0) {
      setRelativeRange(1);
      return;
  }

  if (showLoader) showChartLoader();

  // Debounce to prevent API spam in live mode
  clearTimeout(chartRefreshTimer);
  chartRefreshTimer = setTimeout(() => {
    processChartData();
  }, 300);
}

// Calls Backend API for Aggregated Data
async function processChartData() {
  if (chartedVariables.size === 0) {
    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }
    hideChartLoader(); // Includes logic to show placeholder
    if (chartCanvas) chartCanvas.style.display = "none";
    return;
  }

  const aggregationSelect = document.getElementById("chart-aggregation-select");
  const aggregation = aggregationSelect ? aggregationSelect.value : "AUTO";

  // Group variables by topic/broker
  const topicsMap = new Map();
  chartedVariables.forEach((varInfo, varId) => {
    const key = `${varInfo.sourceId}|${varInfo.topic}`;
    if (!topicsMap.has(key)) {
      topicsMap.set(key, {
        sourceId: varInfo.sourceId,
        topic: varInfo.topic,
        variables: [],
      });
    }

    // Convert JS path to valid JSONPath
    let jsonPath = varInfo.path;
    if (jsonPath !== "(value)") {
      jsonPath = jsonPath.startsWith("[") ? "$" + jsonPath : "$." + jsonPath;
    }
    topicsMap.get(key).variables.push({
      id: varId,
      path: jsonPath,
      originalPath: varInfo.path,
    });
  });

  const topicsArray = Array.from(topicsMap.values());

  try {
    const response = await fetch("api/context/aggregate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topics: topicsArray,
        startDate: new Date(currentMinTimestamp).toISOString(),
        endDate: new Date(currentMaxTimestamp).toISOString(),
        aggregation: aggregation,
        maxPoints: MAX_POINTS_PER_SERIES,
      }),
    });

    if (!response.ok) throw new Error("Aggregation API failed");
    const results = await response.json();

    // Transform results back to rawPointsMap format for drawing
    const rawPointsMap = new Map();
    chartedVariables.forEach((v, id) => rawPointsMap.set(id, []));

    results.forEach((topicResult) => {
      if (topicResult.error) {
        console.error(
          "Aggregation error for topic:",
          topicResult.topic,
          topicResult.error,
        );
        return;
      }
      if (topicResult.data) {
        topicResult.data.forEach((row) => {
          const ts = row.ts_ms;
          Object.keys(row).forEach((col) => {
            if (col !== "ts_ms" && row[col] !== null) {
              rawPointsMap.get(col).push({ x: ts, y: row[col] });
            }
          });
        });
      }
    });

    // --- Build Datasets & Scales using Shared Logic ---
    const chartType = configBar && configBar.getTypeSelect() ? configBar.getTypeSelect().value : "line";
    const connectNulls = configBar && configBar.getConnectNullsToggle() ? configBar.getConnectNullsToggle().checked : false;
    const useSmartAxis = configBar && configBar.getSmartAxisToggle() ? configBar.getSmartAxisToggle().checked : false;

    const axisGroups = new Map();
    chartedVariables.forEach((varInfo, varId) => {
      const cleanPath = varInfo.path.replace(/\[|\]/g, "");
      const axisKey = useSmartAxis
        ? guessGroupKey(varInfo.topic, cleanPath)
        : varId;
      if (!axisGroups.has(axisKey)) axisGroups.set(axisKey, 0);
      axisGroups.set(axisKey, axisGroups.get(axisKey) + 1);
    });
    const distinctAxes = Array.from(axisGroups.keys());

    const { datasets, scalesMeta } = buildChartDatasets(
      rawPointsMap,
      chartedVariables,
      {
        useSmartAxis,
        connectNulls,
        distinctAxes,
      },
    );

    // Sync UI color pickers with the dynamically generated colors
    if (chartVariableList && typeof chartVariableList.setEffectiveColors === 'function') {
      const effectiveColors = new Map();
      datasets.forEach(ds => effectiveColors.set(ds.varId, ds.borderColor));
      chartVariableList.setEffectiveColors(effectiveColors);
    }

    // Apply UI-specific Scale styling
    const isDarkMode = document.body.classList.contains("dark-mode");
    const gridColor = isDarkMode
      ? "rgba(255, 255, 255, 0.1)"
      : "rgba(0, 0, 0, 0.1)";
    const textColor = isDarkMode ? "#e0e0e0" : "#333";

    const dynamicScales = {
      x: {
        type: "time",
        time: {
          tooltipFormat: "yyyy-MM-dd HH:mm:ss",
          displayFormats: {
            millisecond: "HH:mm:ss.SSS",
            second: "HH:mm:ss",
            minute: "HH:mm",
            hour: "dd/MM HH:mm",
            day: "yyyy-MM-dd",
          },
        },
        grid: { color: gridColor },
        ticks: { color: textColor },
        min: currentMinTimestamp,
        max: currentMaxTimestamp,
      },
    };

    Object.values(scalesMeta).forEach((meta) => {
      const yAxisId = meta.id;
      const position =
        Object.keys(scalesMeta).indexOf(yAxisId) % 2 === 0 ? "left" : "right";

      dynamicScales[yAxisId] = {
        type: "linear",
        display: true,
        position: position,
        stack: useSmartAxis
          ? position === "left"
            ? "left-stack"
            : "right-stack"
          : undefined,
        title: {
          display: true,
          text: useSmartAxis ? meta.axisKey.toUpperCase() : meta.label,
          color: `hsl(${meta.hue}, 100%, 40%)`,
        },
      };

      if (meta.isBoolean) {
        dynamicScales[yAxisId].min = 0;
        dynamicScales[yAxisId].max = 1.2;
        dynamicScales[yAxisId].ticks = { stepSize: 1 };
      }
    });

    // Prolong last value for live chart logic
    if (connectNulls && datasets.length > 0 && isChartLive) {
      const prolongTarget = currentMaxTimestamp;
      datasets.forEach((ds) => {
        if (ds.data.length > 0) {
          const lastPt = ds.data[ds.data.length - 1];
          if (lastPt.x < prolongTarget) {
            ds.data.push({ x: prolongTarget, y: lastPt.y });
          }
        }
      });
    }

    if (chartInstance && chartInstance.config.type === chartType) {
      // Re-use chart instance to avoid UI flicker
      chartInstance.data.datasets = datasets;
      chartInstance.options.scales = dynamicScales;
      chartInstance.update("none"); // 'none' prevents animation recalculation
      if (chartCanvas) chartCanvas.style.display = "block";
    } else {
      // Destroy and rebuild if type changes
      if (chartInstance) chartInstance.destroy();
      if (chartCanvas) {
        chartCanvas.style.display = "block";
        chartInstance = new Chart(chartCanvas, {
          type: chartType,
          data: { datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: dynamicScales,
            plugins: {
              legend: { labels: { color: textColor } },
              zoom: {
                zoom: {
                  drag: {
                    enabled: true,
                    backgroundColor: "rgba(54, 162, 235, 0.3)",
                  },
                  mode: "x",
                  onZoomComplete: ({ chart }) => {
                    const { min, max } = chart.scales.x;
                    currentMinTimestamp = min;
                    currentMaxTimestamp = max;
                    isUserInteracting = false; // Fix infinite load
                    isChartLive = false;
                    updateChartSliderUI(min, max, false, true);
                    setTimeout(() => triggerDataFetch(), 0);
                  },
                },
              },
            },
            animation: false,
            parsing: false,
            normalized: true,
          },
        });
      }
    }
    hideChartLoader();
  } catch (err) {
    console.error("Chart aggregation error:", err);
    hideChartLoader();
  }
}

function toggleChartFullscreen() {
  trackEvent("chart_fullscreen");
  if (!chartMainArea) return;
  const isMaximized = chartMainArea.classList.toggle("maximized");
  const btnChartFullscreen = configBar ? configBar.querySelector("#btn-chart-fullscreen") : null;
  
  if (isMaximized) {
    if (btnChartFullscreen) btnChartFullscreen.innerHTML = "✖ Minimize";
    chartMainArea.style.position = "fixed";
    chartMainArea.style.top = "0";
    chartMainArea.style.left = "0";
    chartMainArea.style.right = "0";
    chartMainArea.style.bottom = "0";
    chartMainArea.style.zIndex = "10000";
    chartMainArea.style.backgroundColor = "var(--color-bg-secondary)";
  } else {
    if (btnChartFullscreen) btnChartFullscreen.innerHTML = "⛶ Maximize";
    chartMainArea.style.position = "";
    chartMainArea.style.top = "";
    chartMainArea.style.left = "";
    chartMainArea.style.right = "";
    chartMainArea.style.bottom = "";
    chartMainArea.style.zIndex = "";
    chartMainArea.style.backgroundColor = "";
  }
  if (chartInstance) {
    setTimeout(() => chartInstance.resize(), 50);
  }
}

function onExportPNG() {
  trackEvent("chart_export_png");
  if (!chartInstance) {
    showToast("Please generate a chart first.", "warning");
    return;
  }
  const a = document.createElement("a");
  a.href = chartInstance.toBase64Image();
  a.download = `multi_topic_chart.png`;
  a.click();
}

function onExportCSV() {
  trackEvent("chart_export_csv");
  if (
    !chartInstance ||
    !chartInstance.data.datasets ||
    chartInstance.data.datasets.length === 0
  ) {
    showToast("Please generate a chart first.", "warning");
    return;
  }
  let csvContent = "data:text/csv;charset=utf-8,";
  const headers = [
    "timestamp",
    ...chartInstance.data.datasets.map((d) => `"${d.label}"`),
  ];
  csvContent += headers.join(",") + "\r\n";

  const allTimestamps = new Set();
  chartInstance.data.datasets.forEach((ds) => {
    ds.data.forEach((point) => allTimestamps.add(point.x));
  });

  const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);
  const dataMap = chartInstance.data.datasets.map((ds) => {
    const map = new Map();
    ds.data.forEach((p) => map.set(p.x, p.y));
    return map;
  });

  sortedTimestamps.forEach((ts) => {
    const row = [new Date(ts).toISOString()];
    dataMap.forEach((map) => {
      row.push(map.has(ts) ? map.get(ts) : "");
    });
    csvContent += row.join(",") + "\r\n";
  });

  const encodedUri = encodeURI(csvContent);
  const a = document.createElement("a");
  a.href = encodedUri;
  a.download = "chart_data.csv";
  a.click();
}

async function loadChartConfig() {
  try {
    const response = await fetch("api/chart/config");
    if (!response.ok) throw new Error("Failed to fetch chart config");
    let savedConfig = await response.json();
    if (Array.isArray(savedConfig)) {
      allChartConfigs = {
        configurations: [
          {
            id: `chart_${Date.now()}`,
            name: "Migrated Chart",
            chartType: "line",
            connectNulls: false,
            variables: savedConfig.map((v) => ({
              sourceId: "default",
              topic: v.topic,
              path: v.path,
            })),
          },
        ],
      };
      await saveAllChartConfigs(allChartConfigs, false);
    } else if (savedConfig && Array.isArray(savedConfig.configurations)) {
      allChartConfigs = savedConfig;
    } else {
      allChartConfigs = { configurations: [] };
    }
    populateChartConfigSelect();
    if (allChartConfigs.configurations.length > 0) {
      chartConfigSelect.value = allChartConfigs.configurations[0].id;
      onChartConfigChange(false); // Suppress toast on initial load
    } else {
      onClearAll();
    }
  } catch (error) {
    showToast("Load failed", "error");
  }
}

function populateChartConfigSelect() {
  if (!configBar) return;
  const chartConfigSelect = configBar.getSelectElement();
  if (!chartConfigSelect) return;
  chartConfigSelect.innerHTML = "";
  const newOption = document.createElement("option");
  newOption.value = "";
  newOption.textContent = "-- New Chart --";
  chartConfigSelect.appendChild(newOption);

  allChartConfigs.configurations.forEach((config) => {
    const option = document.createElement("option");
    option.value = config.id;
    option.textContent = config.name + (config._isGlobal ? " [GLOBAL]" : "");
    chartConfigSelect.appendChild(option);
  });
  chartConfigSelect.value = currentConfigId || "";
}

function onChartConfigChange(showNotification = true) {
  if (!configBar) return;
  const chartConfigSelect = configBar.getSelectElement();
  const configId = chartConfigSelect ? chartConfigSelect.value : null;
  currentConfigId = configId;
  if (!configId) {
    onClearAll();
    return;
  }

  const config = allChartConfigs.configurations.find((c) => c.id === configId);
  if (!config) {
    onClearAll();
    return;
  }

  const userRole = window.currentUser ? window.currentUser.role : "user";
  const isGlobal = config._isGlobal === true;

  const btnChartSaveCurrent = configBar.querySelector("#btn-chart-save-current");
  const btnChartSaveAs = configBar.querySelector("#btn-chart-save-as");
  const btnChartDeleteConfig = configBar.querySelector("#btn-chart-delete-config");

  if (isGlobal && userRole !== "admin") {
    if (btnChartSaveCurrent) {
        btnChartSaveCurrent.disabled = true;
        btnChartSaveCurrent.textContent = "🔒 Locked";
        btnChartSaveCurrent.title =
          "Global charts are read-only. Use 'Save As' to create a private copy.";
    }
    if (btnChartDeleteConfig) {
        btnChartDeleteConfig.disabled = true;
        btnChartDeleteConfig.title = "Cannot delete Global chart.";
    }

    // Ensure "Save As" is available
    if (btnChartSaveAs) btnChartSaveAs.disabled = false;
  } else {
    // Unlock controls
    if (btnChartSaveCurrent) {
        btnChartSaveCurrent.disabled = false;
        btnChartSaveCurrent.textContent = "Save";
        btnChartSaveCurrent.title = "Save changes to this chart";
    }
    if (btnChartDeleteConfig) {
        btnChartDeleteConfig.disabled = false;
        btnChartDeleteConfig.title = "Delete this chart";
    }
  }

  const typeSelect = configBar.getTypeSelect();
  if (typeSelect) typeSelect.value = config.chartType || "line";
  const connectNulls = configBar.getConnectNullsToggle();
  if (connectNulls) connectNulls.checked = config.connectNulls || false;

  chartedVariables.clear();
  if (Array.isArray(config.variables)) {
    config.variables.forEach((v) => {
      const sourceId = v.sourceId || "default_connector";
      const varId = `${sourceId}|${v.topic}|${v.path}`;
      chartedVariables.set(varId, { ...v, sourceId: sourceId });
    });
  }

  state.chartUnsaved = false;
  onGenerateChart(true);
  appCallbacks.colorChartTreeCallback();

  if (selectedChartTopic && selectedChartSourceId) {
    const node = document.querySelector(
      `.node-container[data-topic="${selectedChartTopic}"][data-source-id="${selectedChartSourceId}"]`,
    );
    if (node) populateChartVariables(node.dataset.payload);
  }

  if (showNotification) {
    showToast(`Loaded '${config.name}'`, "success");
  }
}
async function saveAllChartConfigs(configObject, notify = true) {
  if (notify && configBar) configBar.setSaveStatus("Saving...");
  try {
    const response = await fetch("api/chart/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(configObject),
    });
    if (!response.ok) throw new Error("Failed to save");

    if (notify && configBar) configBar.setSaveStatus("Saved!");
    return true;
  } catch (error) {
    if (notify && configBar) configBar.setSaveStatus(`Error: ${error.message}`);
    return false;
  }
}

async function onSaveCurrent() {
  trackEvent("chart_save_current");
  if (!currentConfigId) {
    onSaveAsNew();
    return;
  }

  const config = allChartConfigs.configurations.find(
    (c) => c.id === currentConfigId,
  );
  if (!config) {
    showToast("Error: Config not found", "error");
    return;
  }

  const chartConfigSelect = configBar ? configBar.getSelectElement() : null;
  const typeSelect = configBar ? configBar.getTypeSelect() : null;
  const connectNulls = configBar ? configBar.getConnectNullsToggle() : null;

  if (chartConfigSelect && chartConfigSelect.options.length > 0) {
      config.name = chartConfigSelect.options[chartConfigSelect.selectedIndex].text;
  }
  if (typeSelect) config.chartType = typeSelect.value;
  if (connectNulls) config.connectNulls = connectNulls.checked;
  config.variables = Array.from(chartedVariables.values());

  const success = await saveAllChartConfigs(allChartConfigs);
  if (success) {
    state.chartUnsaved = false;
  }
}

async function onSaveAsNew() {
  trackEvent("chart_save_as_new");
  if (
    maxChartsLimit > 0 &&
    allChartConfigs.configurations.length >= maxChartsLimit
  ) {
    showToast(
      `Limit reached (${maxChartsLimit}). Delete a chart first.`,
      "warning",
    );
    return;
  }

  const chartConfigSelect = configBar ? configBar.getSelectElement() : null;
  const activeVersionName =
    chartConfigSelect && chartConfigSelect.options.length > 0 && chartConfigSelect.selectedIndex >= 0
        ? chartConfigSelect.options[chartConfigSelect.selectedIndex]?.text
        : "current";
  const name = prompt(
    "Enter a name for this new chart configuration:",
    `Copy of ${activeVersionName}`,
  );
  if (!name || name.trim().length === 0) return;

  const typeSelect = configBar ? configBar.getTypeSelect() : null;
  const connectNulls = configBar ? configBar.getConnectNullsToggle() : null;

  const newConfig = {
    id: `chart_${Date.now()}`,
    name: name.trim(),
    chartType: typeSelect ? typeSelect.value : "line",
    connectNulls: connectNulls ? connectNulls.checked : false,
    variables: Array.from(chartedVariables.values()),
  };

  allChartConfigs.configurations.push(newConfig);
  currentConfigId = newConfig.id;

  const success = await saveAllChartConfigs(allChartConfigs);
  if (success) {
    // Manually trigger reload to get correct global/private flags if needed,
    // or just update UI locally
    populateChartConfigSelect();

    // Reset UI lock since it's a new (Private) chart
    if (configBar) {
        const btnChartSaveCurrent = configBar.querySelector("#btn-chart-save-current");
        const btnChartDeleteConfig = configBar.querySelector("#btn-chart-delete-config");
        if (btnChartSaveCurrent) {
            btnChartSaveCurrent.disabled = false;
            btnChartSaveCurrent.textContent = "Save";
        }
        if (btnChartDeleteConfig) {
            btnChartDeleteConfig.disabled = false;
        }
    }
    state.chartUnsaved = false;
  }
}

async function onDeleteConfig() {
  trackEvent("chart_delete_config");
  if (!currentConfigId) {
    showToast("No chart selected.", "warning");
    return;
  }

  const chartConfigSelect = configBar ? configBar.getSelectElement() : null;
  const chartName = chartConfigSelect && chartConfigSelect.selectedIndex >= 0
    ? chartConfigSelect.options[chartConfigSelect.selectedIndex].text
    : "this chart";
  const isConfirmed = await confirmModal(
    "Delete Chart",
    `Are you sure you want to delete the chart '${chartName}'?\nThis action cannot be undone.`,
    "Delete",
    true,
  );

  if (!isConfirmed) return;

  allChartConfigs.configurations = allChartConfigs.configurations.filter(
    (c) => c.id !== currentConfigId,
  );
  const success = await saveAllChartConfigs(allChartConfigs);
  if (success) {
    onClearAll();
    populateChartConfigSelect();
  }
}
