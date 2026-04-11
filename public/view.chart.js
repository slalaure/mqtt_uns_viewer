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
 * Coordinates between UI components and specialized services.
 */

// Import shared utilities and state
import { state, subscribe, unsubscribe } from "./state.js";
import {
  trackEvent,
  confirmModal,
  showToast,
} from "./utils.js";
import { createPayloadViewer } from "./payload-viewer.js";

// Import Components
import './components/chart-config-bar.js';
import './components/chart-time-slider.js';
import './components/chart-variable-list.js';
import { openAIStudio } from "./components/ai-learning-studio.js";

// Import Services & Helpers
import { 
    guessGroupKey, 
    buildChartDatasets,
} from "./libs/chart-logic.mjs";
import { chartConfigService } from "./services/chart-config-service.js";
import { fetchAggregatedData } from "./services/chart-data-service.js";

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
let currentConfigId = null;
let maxChartsLimit = 0;
let isMultiSource = false;
let chartRefreshTimer = null;
let isUserInteracting = false;
let lastSliderUpdate = 0;
let isMounted = false; // Lifecycle flag
let appLlmModels = [];

// Configuration for Chart
const MAX_POINTS_PER_SERIES = 500;

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

// --- Named Event Handlers ---

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
  
  const start = startInput && startInput.value ? new Date(startInput.value).getTime() : 0;
  const end = endInput && endInput.value ? new Date(endInput.value).getTime() : Date.now();
  
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
      document.querySelectorAll("#chart-tree .selected").forEach((n) => n.classList.remove("selected"));
      node.classList.add("selected");

      // Expand parents
      let parentLi = node.closest("li").parentElement.closest("li");
      while (parentLi) {
        parentLi.classList.remove("collapsed");
        parentLi = parentLi.parentElement.closest("li");
      }
      handleChartNodeClick(null, node, state.currentSourceId, topic);
    }
  }
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
 * Initializes the Chart View DOM structure.
 */
export async function initChartView(callbacks) {
  const {
    displayPayload,
    maxSavedChartConfigs,
    isMultiSource: multiBrokerState,
    requestRangeCallback,
    getHistory,
    llmModels,
    ...otherCallbacks
  } = callbacks;
  appCallbacks = { ...appCallbacks, ...otherCallbacks };
  maxChartsLimit = maxSavedChartConfigs || 0;
  isMultiSource = multiBrokerState || false;
  appLlmModels = llmModels || [];

  try {
    const response = await fetch("html/view.chart.html");
    const html = await response.text();
    const container = document.getElementById("chart-view");
    if (container) container.innerHTML = html;
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
    // Inject Aggregation Dropdown Dynamically if not in component template
    const typeSelect = configBar.getTypeSelect();
    if (typeSelect && !document.getElementById("chart-aggregation-select")) {
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
      ["1h", "6h", "24h", "7d", "1M", "3M", "1Y"].forEach(r => {
          const hours = r.includes('h') ? parseInt(r) : r.includes('d') ? parseInt(r)*24 : r.includes('M') ? parseInt(r)*24*30 : parseInt(r)*24*365;
          rangeButtons.appendChild(createRangeBtn(r, hours));
      });
      rangeButtons.appendChild(createRangeBtn("Full", "FULL"));
    }
  }

  try {
    await chartConfigService.loadConfigs();
    populateChartConfigSelect();
    const configs = chartConfigService.getConfigurations();
    if (configs.length > 0) {
      currentConfigId = configs[0].id;
      if (configBar && configBar.getSelectElement()) configBar.getSelectElement().value = currentConfigId;
      onChartConfigChange(false);
    } else {
      onClearAll();
    }
  } catch (e) {
      showToast("Failed to load chart configurations", "error");
  }
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
    timeSlider.updateUI(minTimestamp, maxTimestamp, currentMinTimestamp, currentMaxTimestamp);
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
 * Mounts the view.
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
    configBar.addEventListener("profile-and-learn", () => openAIStudio(chartedVariables, currentMinTimestamp, currentMaxTimestamp, showChartLoader, hideChartLoader, appLlmModels));
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

  subscribe("chartUnsaved", onChartUnsavedChange);
  subscribe("currentTopic", onCurrentTopicChange, true);

  if (state.currentTopic && state.currentSourceId) {
      onCurrentTopicChange(state.currentTopic);
  } else if (chartedVariables.size > 0 && !chartInstance) {
      onGenerateChart();
  }

  isMounted = true;
}

/**
 * Unmounts the view.
 */
export function unmountChartView() {
  if (!isMounted) return;

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

  unsubscribe("chartUnsaved", onChartUnsavedChange);
  unsubscribe("currentTopic", onCurrentTopicChange, true);

  isMounted = false;
}

function triggerDataFetch() {
  showChartLoader();
  clearTimeout(chartRefreshTimer);
  chartRefreshTimer = setTimeout(() => {
    onGenerateChart();
  }, 200);
}

function setRelativeRange(hours) {
  let start, end = Date.now();
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

export function updateChartSliderUI(min, max, isInitialLoad = false, force = false) {
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
    if (startInput) startInput.value = toDateTimeLocal(currentMinTimestamp);
    if (endInput) endInput.value = toDateTimeLocal(currentMaxTimestamp);
  }

  timeSlider.updateUI(minTimestamp, maxTimestamp, currentMinTimestamp, currentMaxTimestamp);

  if (isChartLive && !isInitialLoad && !force && chartedVariables.size > 0) {
    onGenerateChart(false);
  }
}

// --- Helpers: Parsing ---
function findNumericKeys(obj, path = "", list = []) {
  if (obj === null || typeof obj !== "object") return list;
  if (Array.isArray(obj)) {
    if (obj.length > 0 && obj.every(i => typeof i === "object" && i !== null && i.hasOwnProperty("name") && i.hasOwnProperty("value"))) {
      obj.forEach((metric) => {
        const newPath = path ? `${path}[${metric.name}]` : `[${metric.name}]`;
        if (typeof metric.value === "number") list.push({ path: newPath, type: "number", value: metric.value });
        else if (typeof metric.value === "boolean") list.push({ path: newPath, type: "boolean", value: metric.value ? 1 : 0 });
      });
      return list;
    }
    // Generic array traversal
    obj.forEach((item, index) => {
        const newPath = path ? `${path}[${index}]` : `[${index}]`;
        findNumericKeys(item, newPath, list);
    });
    return list;
  }
  for (const key of Object.keys(obj)) {
    if (key === '_i3x') continue; // Ignore internal I3X semantic metadata

    const newPath = path ? `${path}.${key}` : key;
    const value = obj[key];
    if (typeof value === "number") list.push({ path: newPath, type: "number", value });
    else if (typeof value === "boolean") list.push({ path: newPath, type: "boolean", value: value ? 1 : 0 });
    else if (typeof value === "string" && !isNaN(parseFloat(value)) && isFinite(Number(value))) list.push({ path: newPath, type: "number", value });
    else if (typeof value === "object") findNumericKeys(value, newPath, list);
  }
  return list;
}

function populateChartVariables(payloadString) {
  if (!chartVariableList) return;
  if (!selectedChartTopic || !selectedChartSourceId || payloadString === null) {
    chartVariableList.updateData(selectedChartTopic, selectedChartSourceId, [], chartedVariables);
    return;
  }
  try {
    const payload = JSON.parse(payloadString);
    let numericKeys = [];
    if (typeof payload === "number" || (typeof payload === "string" && !isNaN(parseFloat(payload)))) {
        numericKeys = [{ path: "(value)", type: "number", value: payload }];
    } else if (typeof payload === "boolean") {
        numericKeys = [{ path: "(value)", type: "boolean", value: payload ? 1 : 0 }];
    } else {
        numericKeys = findNumericKeys(payload);
    }
    chartVariableList.updateData(selectedChartTopic, selectedChartSourceId, numericKeys, chartedVariables);
  } catch (e) {
    chartVariableList.updateData(selectedChartTopic, selectedChartSourceId, [], chartedVariables);
  }
}

function onClearAll() {
  trackEvent("chart_clear_all");
  chartedVariables.clear();
  chartVariableList?.renderList();
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
    chartedVariables.set(id, { sourceId, topic, path });
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
  if (isUserInteracting) return;
  if (currentMaxTimestamp === 0) { setRelativeRange(1); return; }
  if (showLoader) showChartLoader();
  clearTimeout(chartRefreshTimer);
  chartRefreshTimer = setTimeout(() => processChartData(), 300);
}

async function processChartData() {
  if (chartedVariables.size === 0) {
    chartInstance?.destroy();
    chartInstance = null;
    hideChartLoader();
    if (chartCanvas) chartCanvas.style.display = "none";
    return;
  }

  const aggregation = document.getElementById("chart-aggregation-select")?.value || "AUTO";

  try {
    const rawPointsMap = await fetchAggregatedData(chartedVariables, currentMinTimestamp, currentMaxTimestamp, aggregation, MAX_POINTS_PER_SERIES);

    const chartType = configBar?.getTypeSelect()?.value || "line";
    const connectNulls = configBar?.getConnectNullsToggle()?.checked || false;
    const useSmartAxis = configBar?.getSmartAxisToggle()?.checked || false;

    const axisGroups = new Map();
    chartedVariables.forEach((v, id) => {
      const axisKey = useSmartAxis ? guessGroupKey(v.topic, v.path.replace(/\[|\]/g, "")) : id;
      axisGroups.set(axisKey, (axisGroups.get(axisKey) || 0) + 1);
    });

    const { datasets, scalesMeta } = buildChartDatasets(rawPointsMap, chartedVariables, {
      useSmartAxis, connectNulls, distinctAxes: Array.from(axisGroups.keys())
    });

    // Sync UI Colors
    if (typeof chartVariableList.setEffectiveColors === 'function') {
        const effectiveColors = new Map();
        datasets.forEach(ds => effectiveColors.set(ds.varId, ds.borderColor));
        chartVariableList.setEffectiveColors(effectiveColors);
    }

    const isDarkMode = document.body.classList.contains("dark-mode");
    const textColor = isDarkMode ? "#e0e0e0" : "#333";
    const gridColor = isDarkMode ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.1)";

    const dynamicScales = {
      x: {
        type: "time",
        grid: { color: gridColor },
        ticks: { color: textColor },
        min: currentMinTimestamp,
        max: currentMaxTimestamp,
      },
    };

    Object.values(scalesMeta).forEach((meta) => {
      const position = Object.keys(scalesMeta).indexOf(meta.id) % 2 === 0 ? "left" : "right";
      dynamicScales[meta.id] = {
        type: "linear",
        display: true,
        position,
        stack: useSmartAxis ? (position === "left" ? "left-stack" : "right-stack") : undefined,
        title: {
          display: true,
          text: useSmartAxis ? meta.axisKey.toUpperCase() : meta.label,
          color: `hsl(${meta.hue}, 100%, 40%)`,
        },
        min: meta.isBoolean ? 0 : undefined,
        max: meta.isBoolean ? 1.2 : undefined,
        ticks: meta.isBoolean ? { stepSize: 1 } : undefined
      };
    });

    if (chartInstance && chartInstance.config.type === chartType) {
      chartInstance.data.datasets = datasets;
      chartInstance.options.scales = dynamicScales;
      chartInstance.update("none");
    } else {
      chartInstance?.destroy();
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
                  drag: { enabled: true, backgroundColor: "rgba(54, 162, 235, 0.3)" },
                  mode: "x",
                  onZoomComplete: ({ chart }) => {
                    const { min, max } = chart.scales.x;
                    currentMinTimestamp = min; currentMaxTimestamp = max;
                    isChartLive = false;
                    updateChartSliderUI(min, max, false, true);
                    triggerDataFetch();
                  },
                },
              },
            },
            animation: false, parsing: false, normalized: true,
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
  if (!chartMainArea) return;
  const isMaximized = chartMainArea.classList.toggle("maximized");
  const btn = configBar?.querySelector("#btn-chart-fullscreen");
  if (btn) btn.innerHTML = isMaximized ? "✖ Minimize" : "⛶ Maximize";
  
  Object.assign(chartMainArea.style, isMaximized ? {
    position: "fixed", top: "0", left: "0", right: "0", bottom: "0", zIndex: "10000", backgroundColor: "var(--color-bg-secondary)"
  } : {
    position: "", top: "", left: "", right: "", bottom: "", zIndex: "", backgroundColor: ""
  });
  
  setTimeout(() => chartInstance?.resize(), 50);
}

function onExportPNG() {
  if (!chartInstance) { showToast("Please generate a chart first.", "warning"); return; }
  const a = document.createElement("a");
  a.href = chartInstance.toBase64Image();
  a.download = `chart_export_${Date.now()}.png`;
  a.click();
}

function onExportCSV() {
  if (!chartInstance?.data.datasets.length) { showToast("Please generate a chart first.", "warning"); return; }
  let csv = "timestamp," + chartInstance.data.datasets.map(d => `"${d.label}"`).join(",") + "\r\n";
  const allTs = Array.from(new Set(chartInstance.data.datasets.flatMap(ds => ds.data.map(p => p.x)))).sort((a,b) => a-b);
  const dataMaps = chartInstance.data.datasets.map(ds => new Map(ds.data.map(p => [p.x, p.y])));
  allTs.forEach(ts => {
    csv += new Date(ts).toISOString() + "," + dataMaps.map(m => m.get(ts) ?? "").join(",") + "\r\n";
  });
  const a = document.createElement("a");
  a.href = encodeURI("data:text/csv;charset=utf-8," + csv);
  a.download = "chart_data.csv";
  a.click();
}

function populateChartConfigSelect() {
  if (!configBar) return;
  const select = configBar.getSelectElement();
  if (!select) return;
  select.innerHTML = '<option value="">-- New Chart --</option>';
  chartConfigService.getConfigurations().forEach(config => {
    const opt = document.createElement("option");
    opt.value = config.id;
    opt.textContent = config.name + (config._isGlobal ? " [GLOBAL]" : "");
    select.appendChild(opt);
  });
  select.value = currentConfigId || "";
}

function onChartConfigChange(showNotification = true) {
  const select = configBar?.getSelectElement();
  currentConfigId = select?.value || null;
  if (!currentConfigId) { onClearAll(); return; }

  const config = chartConfigService.getConfig(currentConfigId);
  if (!config) { onClearAll(); return; }

  const userRole = window.currentUser?.role || "user";
  const isGlobal = config._isGlobal === true;

  if (configBar) {
      const btnSave = configBar.querySelector("#btn-chart-save-current");
      const btnDelete = configBar.querySelector("#btn-chart-delete-config");
      if (btnSave) {
          btnSave.disabled = isGlobal && userRole !== "admin";
          btnSave.textContent = btnSave.disabled ? "🔒 Locked" : "Save";
      }
      if (btnDelete) btnDelete.disabled = isGlobal && userRole !== "admin";
      
      const typeSelect = configBar.getTypeSelect();
      if (typeSelect) typeSelect.value = config.chartType || "line";
      const connectNulls = configBar.getConnectNullsToggle();
      if (connectNulls) connectNulls.checked = config.connectNulls || false;
  }

  chartedVariables.clear();
  config.variables?.forEach(v => {
      const sourceId = v.sourceId || "default_connector";
      chartedVariables.set(`${sourceId}|${v.topic}|${v.path}`, { ...v, sourceId });
  });

  state.chartUnsaved = false;
  onGenerateChart(true);
  appCallbacks.colorChartTreeCallback();
  if (selectedChartTopic && selectedChartSourceId) {
      const node = document.querySelector(`.node-container[data-topic="${selectedChartTopic}"][data-source-id="${selectedChartSourceId}"]`);
      if (node) populateChartVariables(node.dataset.payload);
  }
  if (showNotification) showToast(`Loaded '${config.name}'`, "success");
}

async function onSaveCurrent() {
  if (!currentConfigId) { onSaveAsNew(); return; }
  const config = chartConfigService.getConfig(currentConfigId);
  if (!config) return;

  const select = configBar?.getSelectElement();
  if (select) config.name = select.options[select.selectedIndex].text;
  config.chartType = configBar?.getTypeSelect()?.value;
  config.connectNulls = configBar?.getConnectNullsToggle()?.checked;
  config.variables = Array.from(chartedVariables.values());

  if (await chartConfigService.saveAllConfigs()) {
      state.chartUnsaved = false;
      configBar?.setSaveStatus("Saved!");
  }
}

async function onSaveAsNew() {
  if (maxChartsLimit > 0 && chartConfigService.getConfigurations().length >= maxChartsLimit) {
    showToast(`Limit reached (${maxChartsLimit}).`, "warning"); return;
  }
  const select = configBar?.getSelectElement();
  const currentName = select?.selectedIndex >= 0 ? select.options[select.selectedIndex].text : "current";
  const name = prompt("Enter name:", `Copy of ${currentName}`);
  if (!name?.trim()) return;

  const newConfig = {
    id: `chart_${Date.now()}`,
    name: name.trim(),
    chartType: configBar?.getTypeSelect()?.value || "line",
    connectNulls: configBar?.getConnectNullsToggle()?.checked || false,
    variables: Array.from(chartedVariables.values()),
  };

  if (await chartConfigService.addConfig(newConfig)) {
    currentConfigId = newConfig.id;
    populateChartConfigSelect();
    state.chartUnsaved = false;
  }
}

async function onDeleteConfig() {
  if (!currentConfigId) return;
  const select = configBar?.getSelectElement();
  const name = select?.options[select.selectedIndex].text || "this chart";
  if (!await confirmModal("Delete Chart", `Are you sure you want to delete '${name}'?`, "Delete", true)) return;

  if (await chartConfigService.deleteConfig(currentConfigId)) {
    onClearAll();
    populateChartConfigSelect();
  }
}
