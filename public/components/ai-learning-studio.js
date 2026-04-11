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
 * AI Learning Studio Component.
 * Profiles data and provides AI-generated suggestions for UNS model and alert rules.
 */

import { showToast, confirmModal } from "../utils.js";

/**
 * Opens the AI Learning Studio modal.
 * @param {Map} chartedVariables Map of currently charted variables.
 * @param {number} minTs Current minimum timestamp.
 * @param {number} maxTs Current maximum timestamp.
 * @param {Function} showLoader Callback to show loader.
 * @param {Function} hideLoader Callback to hide loader.
 * @param {Array} llmModels Available LLM models.
 */
export async function openAIStudio(chartedVariables, minTs, maxTs, showLoader, hideLoader, llmModels = []) {
  if (chartedVariables.size === 0) {
    showToast("Please add variables to the chart first.", "warning");
    return;
  }

  let modelSelectHtml = '';
  if (llmModels && llmModels.length > 0) {
      modelSelectHtml = `
      <div style="margin-top: 15px; margin-bottom: 5px;">
        <label style="display:block; margin-bottom:5px; font-weight:bold; font-size:0.9em;">Select LLM Model:</label>
        <select id="studio-model-select" style="width:100%; padding:8px; border-radius:4px; border:1px solid var(--color-border); background:var(--color-bg-tertiary); color:var(--color-text);">
            ${llmModels.map(m => `<option value="${m}">${m.replace('models/', '')}</option>`).join('')}
        </select>
      </div>`;
  }

  let selectedModel = llmModels.length > 0 ? llmModels[0] : undefined;
  const updateModel = (e) => {
      if (e.target.id === 'studio-model-select') selectedModel = e.target.value;
  };
  document.body.addEventListener('change', updateModel);

  const isConfirmed = await confirmModal(
    "AI Learning Studio",
    `Profile the selected range and generate AI suggestions for UNS model and alert rules?${modelSelectHtml}`,
    "Start Analysis",
  );

  document.body.removeEventListener('change', updateModel);

  if (!isConfirmed) return;

  showLoader();
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
        startDate: new Date(minTs).toISOString(),
        endDate: new Date(maxTs).toISOString(),
      }),
    });

    if (!profileResponse.ok) throw new Error("Profiling API failed");
    const profileData = await profileResponse.json();

    // 3. Call AI Synthesis
    const learnResponse = await fetch("api/context/learn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileData, model: selectedModel })
    });

    if (!learnResponse.ok) {
        const err = await learnResponse.json();
        throw new Error(err.error || "AI Synthesis failed");
    }
    const suggestions = await learnResponse.json();

    hideLoader();

    // 4. Display Suggestions
    if (suggestions.error) {
        showToast("AI returned invalid JSON. Check console.", "warning");
        console.warn("AI Raw Output:", suggestions.raw);
        await confirmModal("AI Raw Output", `<pre style="white-space: pre-wrap; font-size: 0.85em; max-height: 400px; overflow-y: auto; text-align: left; background: var(--color-bg-tertiary); padding: 10px; border-radius: 4px;">${suggestions.raw}</pre>`, "Close", false);
    } else {
        let localSuggestions = JSON.parse(JSON.stringify(suggestions)); // Deep copy for mutability

        const html = renderStudioHTML(localSuggestions);

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
            showLoader();
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
            hideLoader();
        }
    }

  } catch (err) {
    hideLoader();
    console.error("Learning Studio Error:", err);
    showToast(err.message, "error");
  }
}

/**
 * Helper to format relationships as editable inputs
 */
function formatRels(rels, objIdx) {
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
}

function renderStudioHTML(localSuggestions) {
    return `
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
}
