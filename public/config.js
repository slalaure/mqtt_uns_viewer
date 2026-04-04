/**
 * @license Apache License, Version 2.0 (the "License")
 * @author Sebastien Lalaurette
 *
 * Configuration Page Script
 * Manages the interactive Wizard, Advanced .env editor, Import/Export, and Assets.
 */
import { showToast, confirmModal } from './utils.js';

document.addEventListener('DOMContentLoaded', () => {
    // --- Global State ---
    let currentConfigData = {};
    let currentWizardStep = 1;
    const totalWizardSteps = 5;
    let providersList = [];
    let editingProviderIndex = -1;
    let availableCertFiles = [];

    // --- DOM Elements: Core ---
    const btnModeWizard = document.getElementById('btn-mode-wizard');
    const btnModeAdvanced = document.getElementById('btn-mode-advanced');
    const wizardView = document.getElementById('wizard-view');
    const advancedView = document.getElementById('advanced-view');
    const advancedForm = document.getElementById('config-form');
    const advancedSaveBtn = document.getElementById('save-config-button');

    // --- DOM Elements: Wizard ---
    const wizardForm = document.getElementById('wizard-form');
    const btnWizPrev = document.getElementById('btn-wiz-prev');
    const btnWizNext = document.getElementById('btn-wiz-next');
    const btnWizSave = document.getElementById('btn-wiz-save');
    const stepIndicators = document.querySelectorAll('.step-indicator');
    const wizardSteps = document.querySelectorAll('.wizard-step');
    const perennialSelect = document.getElementById('wiz-PERENNIAL_DRIVER');

    // --- DOM Elements: AI ---
    const presetSelect = document.getElementById('llm-provider-preset');
    const llmUrlInput = document.getElementById('wiz-LLM_API_URL');
    const llmKeyInput = document.getElementById('wiz-LLM_API_KEY');
    const btnFetchModels = document.getElementById('btn-fetch-models');
    const modelsDatalist = document.getElementById('llm-models-list');
    const llmModelInput = document.getElementById('wiz-LLM_MODEL');

    // --- DOM Elements: Import/Export ---
    const btnExport = document.getElementById('btn-export-config');
    const btnImport = document.getElementById('btn-import-config');
    const importInput = document.getElementById('import-config-input');

    // --- DOM Elements: Providers Builder ---
    const providersListContainer = document.getElementById('providers-list-container');
    const btnAddProvider = document.getElementById('btn-add-provider');
    const providerModal = document.getElementById('provider-builder-modal');
    const providerBuilderForm = document.getElementById('provider-builder-form');
    const provTypeSelect = document.getElementById('prov-type');
    const btnProvCancel = document.getElementById('btn-prov-cancel');

    // --- DOM Elements: Assets ---
    const certList = document.getElementById('cert-list');
    const certUploadInput = document.getElementById('cert-upload-input');
    const modelEditor = document.getElementById('uns-model-editor');
    const btnSaveModel = document.getElementById('btn-save-model');
    const modelUploadInput = document.getElementById('model-upload-input');
    const btnUploadModel = document.getElementById('btn-upload-model');

    // ==========================================
    // 1. DATA LOADING & POPULATION
    // ==========================================

    async function loadConfig() {
        try {
            const response = await fetch('api/env');
            if (!response.ok) throw new Error('Failed to load configuration.');
            currentConfigData = await response.json();
            
            // Extract Providers
            try {
                let pData = currentConfigData['DATA_PROVIDERS'];
                if (typeof pData === 'string') pData = pData.replace(/^'|'$/g, '');
                providersList = pData ? JSON.parse(pData) : [];
            } catch(e) {
                providersList = [];
            }

            populateAdvancedForm(currentConfigData);
            populateWizard(currentConfigData);
            renderProvidersList();
            updatePerennialGroups();
            
            // Re-trigger populate certificates in case they loaded before config
            if (availableCertFiles.length > 0) populateCertSelects();

        } catch (error) {
            showToast(error.message, "error");
        }
    }

    function populateAdvancedForm(configObj) {
        const immutableKeys = ['PORT', 'SESSION_SECRET', 'BASE_PATH', 'DUCKDB_MAX_SIZE_MB'];
        
        advancedForm.innerHTML = '';
        for (const key in configObj) {
            const group = document.createElement('div');
            group.className = 'form-group';
            
            const isImmutable = immutableKeys.includes(key);
            const badgeClass = isImmutable ? 'badge-immutable' : 'badge-dynamic';
            const badgeText = isImmutable ? 'IMMUTABLE' : 'DYNAMIC';
            const badgeStyle = isImmutable ? 'background:#555; color:white;' : 'background:var(--color-primary); color:white;';

            const labelContainer = document.createElement('div');
            labelContainer.style.display = 'flex';
            labelContainer.style.justifyContent = 'space-between';
            labelContainer.style.alignItems = 'center';
            labelContainer.style.marginBottom = '5px';

            const label = document.createElement('label');
            label.htmlFor = `adv-${key}`;
            label.textContent = key;
            label.style.marginBottom = '0';
            
            const badge = document.createElement('span');
            badge.textContent = badgeText;
            badge.style.cssText = `font-size:0.65em; font-weight:bold; padding:2px 5px; border-radius:3px; ${badgeStyle}`;
            
            labelContainer.appendChild(label);
            labelContainer.appendChild(badge);
            group.appendChild(labelContainer);

            if (key === 'MQTT_BROKERS' || key === 'DATA_PROVIDERS') {
                const textarea = document.createElement('textarea');
                textarea.id = `adv-${key}`;
                textarea.name = key;
                let rawValue = configObj[key];
                if (typeof rawValue === 'string') rawValue = rawValue.replace(/^'|'$/g, '');
                try {
                    textarea.value = JSON.stringify(JSON.parse(rawValue), null, 4);
                } catch (e) {
                    textarea.value = rawValue || '';
                }
                group.appendChild(textarea);
            } else {
                const input = document.createElement('input');
                input.type = 'text';
                input.id = `adv-${key}`;
                input.name = key;
                input.value = configObj[key] || '';
                group.appendChild(input);
            }
            advancedForm.appendChild(group);
        }
    }

    function populateWizard(configObj) {
        const wizInputs = document.querySelectorAll('#wizard-form input, #wizard-form select, #wizard-form textarea');
        wizInputs.forEach(input => {
            const envKey = input.name;
            if (!envKey || configObj[envKey] === undefined) return;

            if (input.type === 'checkbox') {
                input.checked = (configObj[envKey] === 'true' || configObj[envKey] === true);
            } else if (input.tagName === 'TEXTAREA') {
                // Handled by builder
            } else {
                input.value = configObj[envKey];
            }
        });
    }

    // ==========================================
    // 2. WIZARD: PERENNIAL STORAGE & AI
    // ==========================================

    function updatePerennialGroups() {
        const driver = perennialSelect.value;
        document.querySelectorAll('#wizard-form .conditional-group').forEach(el => {
            if (el.id.startsWith('perennial-config-')) {
                el.classList.toggle('active', el.id === `perennial-config-${driver}`);
            }
        });
    }
    perennialSelect.addEventListener('change', updatePerennialGroups);

    // AI Provider Presets
    presetSelect.addEventListener('change', (e) => {
        if (e.target.value !== 'custom' && e.target.value !== '') {
            llmUrlInput.value = e.target.value;
        }
    });

    // Fetch LLM Models via OpenAI compatible endpoint
    btnFetchModels.addEventListener('click', async () => {
        let url = llmUrlInput.value.trim();
        const key = llmKeyInput.value.trim();
        if (!url) return showToast("Base URL is required to fetch models.", "warning");
        if (!key) return showToast("API Key is required to fetch models.", "warning");

        btnFetchModels.disabled = true;
        btnFetchModels.textContent = "Fetching...";

        try {
            let fetchUrl = url;
            if (fetchUrl.endsWith('/chat/completions')) fetchUrl = fetchUrl.replace('/chat/completions', '/models');
            else if (!fetchUrl.endsWith('/models')) fetchUrl = fetchUrl.endsWith('/') ? fetchUrl + 'models' : fetchUrl + '/models';

            const res = await fetch(fetchUrl, {
                headers: { 'Authorization': `Bearer ${key}` }
            });

            if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
            
            const data = await res.json();
            modelsDatalist.innerHTML = '';
            
            let modelsArray = data.data || data.models || [];
            
            if (modelsArray.length > 0) {
                // Clear the input so the datalist is fully expanded for the user
                llmModelInput.value = '';
                
                modelsArray.forEach(m => {
                    const opt = document.createElement('option');
                    let val = m.id || m.name; 
                    // Clean up Gemini model prefix to make it more readable
                    val = val.replace('models/', '');
                    opt.value = val;
                    modelsDatalist.appendChild(opt);
                });
                showToast(`Successfully loaded ${modelsArray.length} models. (If a specific model is missing, you can still type it manually).`, "success");
            } else {
                throw new Error("No models found in response.");
            }
        } catch (e) {
            console.error("Model fetch failed:", e);
            showToast("Failed to fetch models via API. You can still type the exact model name manually.", "warning");
        } finally {
            btnFetchModels.disabled = false;
            btnFetchModels.textContent = "🔄 Fetch Models";
        }
    });

    // ==========================================
    // 3. WIZARD: PROVIDERS BUILDER
    // ==========================================

    function renderProvidersList() {
        providersListContainer.innerHTML = '';
        if (providersList.length === 0) {
            providersListContainer.innerHTML = '<p style="color:var(--color-text-secondary); font-style:italic;">No data providers configured. The embedded MQTT fallback will be used.</p>';
            return;
        }

        providersList.forEach((prov, index) => {
            const card = document.createElement('div');
            card.className = 'provider-card';
            
            const subs = Array.isArray(prov.subscribe) ? prov.subscribe.join(', ') : 'None';
            const pubs = Array.isArray(prov.publish) && prov.publish.length > 0 ? prov.publish.join(', ') : 'Read-Only';
            
            card.innerHTML = `
                <div class="provider-info">
                    <h4>${prov.id} <span style="font-size:0.8em; color:var(--color-text-muted);">[${prov.type.toUpperCase()}]</span></h4>
                    <p>Sub: ${subs}</p>
                    <p>Pub: ${pubs}</p>
                </div>
                <div class="provider-actions">
                    <button type="button" class="tool-button btn-edit-prov" data-index="${index}">Edit</button>
                    <button type="button" class="tool-button button-danger btn-del-prov" data-index="${index}">Delete</button>
                </div>
            `;
            providersListContainer.appendChild(card);
        });

        document.querySelectorAll('.btn-edit-prov').forEach(btn => btn.onclick = (e) => openProviderModal(e.target.dataset.index));
        document.querySelectorAll('.btn-del-prov').forEach(btn => btn.onclick = (e) => deleteProvider(e.target.dataset.index));
    }

    function updateProvConditionalGroups() {
        const t = provTypeSelect.value;
        document.getElementById('prov-group-mqtt').classList.toggle('active', t === 'mqtt');
        document.getElementById('prov-group-opcua').classList.toggle('active', t === 'opcua');
        document.getElementById('prov-group-http').classList.toggle('active', t === 'http');
        document.getElementById('prov-group-file').classList.toggle('active', t === 'file');
    }
    provTypeSelect.addEventListener('change', updateProvConditionalGroups);

    function openProviderModal(index = -1) {
        editingProviderIndex = parseInt(index);
        document.getElementById('provider-modal-title').textContent = index >= 0 ? "Edit Provider" : "Add Provider";
        providerBuilderForm.reset();
        
        if (index >= 0) {
            const p = providersList[index];
            document.getElementById('prov-id').value = p.id || '';
            document.getElementById('prov-type').value = p.type || 'mqtt';
            document.getElementById('prov-subscribe').value = Array.isArray(p.subscribe) ? p.subscribe.join(', ') : '#';
            document.getElementById('prov-publish').value = Array.isArray(p.publish) ? p.publish.join(', ') : '';

            if (p.type === 'mqtt') {
                document.getElementById('prov-mqtt-host').value = p.host || '';
                document.getElementById('prov-mqtt-port').value = p.port || '';
                document.getElementById('prov-mqtt-protocol').value = p.protocol || 'mqtt';
                document.getElementById('prov-mqtt-client').value = p.clientId || '';
                document.getElementById('prov-mqtt-user').value = p.username || '';
                document.getElementById('prov-mqtt-alpn').value = p.alpnProtocol || '';
                document.getElementById('prov-mqtt-keepalive').value = p.keepalive || '';
                document.getElementById('prov-mqtt-clean').checked = p.clean !== false;
                document.getElementById('prov-mqtt-ca').value = p.caFilename || '';
                document.getElementById('prov-mqtt-cert').value = p.certFilename || '';
                document.getElementById('prov-mqtt-key').value = p.keyFilename || '';
                document.getElementById('prov-mqtt-reject').value = p.rejectUnauthorized === false ? 'false' : 'true';
            } else if (p.type === 'opcua') {
                document.getElementById('prov-opcua-url').value = p.endpointUrl || '';
                document.getElementById('prov-opcua-user').value = p.username || '';
            } else if (p.type === 'http') {
                document.getElementById('prov-http-path').value = p.pathPrefix || '';
            } else if (p.type === 'file') {
                document.getElementById('prov-file-path').value = p.filePath || '';
                document.getElementById('prov-file-topic').value = p.defaultTopic || '';
                document.getElementById('prov-file-rate').value = p.streamRateMs || '';
            }
        }
        
        updateProvConditionalGroups();
        providerModal.style.display = 'flex';
    }

    btnProvCancel.onclick = () => { providerModal.style.display = 'none'; };
    btnAddProvider.onclick = () => openProviderModal(-1);

    providerBuilderForm.onsubmit = (e) => {
        e.preventDefault();
        const type = provTypeSelect.value;
        
        const subStr = document.getElementById('prov-subscribe').value;
        const pubStr = document.getElementById('prov-publish').value;

        const newProv = {
            id: document.getElementById('prov-id').value.trim(),
            type: type,
            subscribe: subStr ? subStr.split(',').map(s=>s.trim()).filter(Boolean) : [],
            publish: pubStr ? pubStr.split(',').map(s=>s.trim()).filter(Boolean) : []
        };

        if (type === 'mqtt') {
            newProv.host = document.getElementById('prov-mqtt-host').value.trim();
            newProv.port = parseInt(document.getElementById('prov-mqtt-port').value) || 1883;
            newProv.protocol = document.getElementById('prov-mqtt-protocol').value;
            newProv.clientId = document.getElementById('prov-mqtt-client').value.trim();
            newProv.username = document.getElementById('prov-mqtt-user').value.trim();
            newProv.alpnProtocol = document.getElementById('prov-mqtt-alpn').value.trim();
            
            const keepAliveVal = document.getElementById('prov-mqtt-keepalive').value;
            if (keepAliveVal) newProv.keepalive = parseInt(keepAliveVal);
            
            newProv.clean = document.getElementById('prov-mqtt-clean').checked;
            
            const pass = document.getElementById('prov-mqtt-pass').value;
            if (pass) newProv.password = pass; 
            else if (editingProviderIndex >= 0 && providersList[editingProviderIndex].password) {
                newProv.password = providersList[editingProviderIndex].password; 
            }

            // Using select values populated by loadCertificates()
            newProv.caFilename = document.getElementById('prov-mqtt-ca').value.trim();
            newProv.certFilename = document.getElementById('prov-mqtt-cert').value.trim();
            newProv.keyFilename = document.getElementById('prov-mqtt-key').value.trim();
            newProv.rejectUnauthorized = document.getElementById('prov-mqtt-reject').value === 'true';
        } else if (type === 'opcua') {
            newProv.endpointUrl = document.getElementById('prov-opcua-url').value.trim();
            newProv.username = document.getElementById('prov-opcua-user').value.trim();
            const pass = document.getElementById('prov-opcua-pass').value;
            if (pass) newProv.password = pass; 
            else if (editingProviderIndex >= 0 && providersList[editingProviderIndex].password) {
                newProv.password = providersList[editingProviderIndex].password; 
            }
        } else if (type === 'http') {
            newProv.pathPrefix = document.getElementById('prov-http-path').value.trim();
        } else if (type === 'file') {
            newProv.filePath = document.getElementById('prov-file-path').value.trim();
            newProv.defaultTopic = document.getElementById('prov-file-topic').value.trim();
            newProv.streamRateMs = parseInt(document.getElementById('prov-file-rate').value) || 1000;
        }

        if (editingProviderIndex >= 0) {
            providersList[editingProviderIndex] = newProv;
        } else {
            providersList.push(newProv);
        }

        providerModal.style.display = 'none';
        renderProvidersList();
    };

    async function deleteProvider(index) {
        if(await confirmModal("Delete Provider", "Remove this data provider?", "Delete", true)) {
            providersList.splice(index, 1);
            renderProvidersList();
        }
    }


    // ==========================================
    // 4. SAVING & SYNCING CONFIG
    // ==========================================

    async function saveConfigToServer(payload) {
        try {
            const response = await fetch('api/env', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!response.ok) throw new Error((await response.json()).error || 'Failed to save.');
            
            const result = await response.json();

            if (result.restartRequired) {
                const restart = await confirmModal(
                    "Restart Required", 
                    "Configuration saved!\nA server restart is required for changes to take effect (e.g. Port or Base Path).\n\nRestart now?", 
                    "Restart Now", false
                );
                
                if (restart) {
                    showToast('Restarting server...', 'info');
                    fetch('api/env/restart', { method: 'POST' });
                } else {
                    showToast('Configuration saved (Restart pending).', 'success');
                }
            } else {
                showToast('Configuration saved and hot-reloaded!', 'success');
                // Reload config to update UI with normalized values
                loadConfig();
            }
        } catch (error) {
            showToast(error.message, "error");
        }
    }

    // Handle Advanced Save
    advancedForm.addEventListener('submit', (e) => {
        e.preventDefault();
        advancedSaveBtn.disabled = true;
        advancedSaveBtn.textContent = 'Saving...';

        const formData = new FormData(advancedForm);
        const configPayload = Object.fromEntries(formData.entries());

        ['MQTT_BROKERS', 'DATA_PROVIDERS'].forEach(key => {
            if (configPayload[key]) {
                try { configPayload[key] = JSON.stringify(JSON.parse(configPayload[key])); } 
                catch (e) {}
            }
        });

        saveConfigToServer(configPayload).finally(() => {
            advancedSaveBtn.disabled = false;
            advancedSaveBtn.textContent = 'Save Advanced Config';
        });
    });

    // Handle Wizard Save
    wizardForm.addEventListener('submit', (e) => {
        e.preventDefault();
        btnWizSave.disabled = true;
        btnWizSave.textContent = 'Saving...';

        const configPayload = { ...currentConfigData };

        const wizInputs = document.querySelectorAll('#wizard-form input, #wizard-form select');
        wizInputs.forEach(input => {
            const envKey = input.name;
            if (!envKey) return;
            if (input.type === 'checkbox') configPayload[envKey] = input.checked ? 'true' : 'false';
            else if (input.value !== "") configPayload[envKey] = input.value;
        });

        configPayload['DATA_PROVIDERS'] = JSON.stringify(providersList);

        saveConfigToServer(configPayload).finally(() => {
            btnWizSave.disabled = false;
            btnWizSave.textContent = 'Save & Apply Configurations';
        });
    });


    // ==========================================
    // 5. UI BEHAVIORS: TABS & WIZARD NAVIGATION
    // ==========================================

    btnModeWizard.addEventListener('click', () => {
        btnModeWizard.classList.add('active');
        btnModeAdvanced.classList.remove('active');
        wizardView.style.display = 'block';
        advancedView.style.display = 'none';
        populateWizard(currentConfigData); 
    });

    btnModeAdvanced.addEventListener('click', () => {
        btnModeAdvanced.classList.add('active');
        btnModeWizard.classList.remove('active');
        advancedView.style.display = 'block';
        wizardView.style.display = 'none';
        currentConfigData['DATA_PROVIDERS'] = JSON.stringify(providersList);
        populateAdvancedForm(currentConfigData);
    });

    function updateWizardUI() {
        wizardSteps.forEach((step, idx) => step.classList.toggle('active', idx + 1 === currentWizardStep));
        stepIndicators.forEach((ind, idx) => ind.classList.toggle('active', idx + 1 === currentWizardStep));
        
        btnWizPrev.style.visibility = currentWizardStep > 1 ? 'visible' : 'hidden';
        if (currentWizardStep === totalWizardSteps) {
            btnWizNext.style.display = 'none';
            btnWizSave.style.display = 'inline-block';
        } else {
            btnWizNext.style.display = 'inline-block';
            btnWizSave.style.display = 'none';
        }
    }

    btnWizNext.onclick = () => { if (currentWizardStep < totalWizardSteps) { currentWizardStep++; updateWizardUI(); } };
    btnWizPrev.onclick = () => { if (currentWizardStep > 1) { currentWizardStep--; updateWizardUI(); } };
    stepIndicators.forEach(ind => {
        ind.onclick = (e) => { currentWizardStep = parseInt(e.target.dataset.step, 10); updateWizardUI(); };
    });

    // ==========================================
    // 6. IMPORT / EXPORT JSON
    // ==========================================

    btnExport.addEventListener('click', () => {
        if (Object.keys(currentConfigData).length === 0) return showToast("No config loaded.", "warning");
        const exportData = { ...currentConfigData };
        exportData['DATA_PROVIDERS'] = JSON.stringify(providersList);
        
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData, null, 2));
        const a = document.createElement('a');
        a.href = dataStr;
        a.download = `korelate_config_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
    });

    btnImport.addEventListener('click', () => importInput.click());

    importInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (evt) => {
            try {
                const importedConfig = JSON.parse(evt.target.result);
                currentConfigData = { ...currentConfigData, ...importedConfig };
                
                try {
                    let pData = currentConfigData['DATA_PROVIDERS'];
                    if (typeof pData === 'string') pData = pData.replace(/^'|'$/g, '');
                    providersList = pData ? JSON.parse(pData) : [];
                } catch(e) { providersList = []; }

                populateAdvancedForm(currentConfigData);
                populateWizard(currentConfigData);
                renderProvidersList();
                updatePerennialGroups();
                
                showToast("Configuration imported! Click Save to apply.", "info");
            } catch (err) {
                showToast("Invalid JSON file.", "error");
            }
            importInput.value = '';
        };
        reader.readAsText(file);
    });

    // ==========================================
    // 7. ASSETS & MODELS 
    // ==========================================

    function populateCertSelects() {
        document.querySelectorAll('.cert-select').forEach(select => {
            // Check if we are currently holding a value from the provider builder (via id)
            // Or from the global env configs (via name)
            const nameKey = select.getAttribute('name');
            const targetVal = select.value || (nameKey ? currentConfigData[nameKey] : null);

            select.innerHTML = '<option value="">-- None / Default --</option>';
            availableCertFiles.forEach(f => {
                const opt = document.createElement('option');
                opt.value = f;
                opt.textContent = f;
                select.appendChild(opt);
            });
            
            if (availableCertFiles.includes(targetVal)) {
                select.value = targetVal;
            }
        });
    }

    async function loadUnsModel() {
        try {
            const res = await fetch('api/env/model');
            if (!res.ok) throw new Error("Failed to fetch UNS Model.");
            modelEditor.value = JSON.stringify(await res.json(), null, 2);
        } catch (e) {
            modelEditor.value = `// Error loading model: ${e.message}\n[]`;
        }
    }

    async function saveUnsModel(modelData) {
        btnSaveModel.disabled = true; btnSaveModel.textContent = "Saving...";
        try {
            const res = await fetch('api/env/model', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(typeof modelData === 'string' ? JSON.parse(modelData) : modelData)
            });
            if (!res.ok) throw new Error((await res.json()).error || "Save failed.");
            showToast("UNS Model saved!", "success");
            loadUnsModel(); 
        } catch (e) { showToast(`Error: ${e.message}`, "error"); } 
        finally { btnSaveModel.disabled = false; btnSaveModel.textContent = "Save Model"; }
    }

    btnSaveModel.onclick = () => saveUnsModel(modelEditor.value);
    btnUploadModel.onclick = () => {
        const file = modelUploadInput.files[0];
        if (!file) return showToast("Select a JSON file.", "warning");
        const reader = new FileReader();
        reader.onload = (e) => {
            try { saveUnsModel(JSON.parse(e.target.result)); modelUploadInput.value = ''; } 
            catch (err) { showToast("Invalid JSON: " + err.message, "error"); }
        };
        reader.readAsText(file);
    };

    async function loadCertificates() {
        try {
            const res = await fetch('api/env/certs');
            if (!res.ok) throw new Error("Fetch failed.");
            availableCertFiles = await res.json();
            
            certList.innerHTML = availableCertFiles.length === 0 ? '<li class="cert-item" style="justify-content:center; color:#888;">No certificates</li>' : '';
            availableCertFiles.forEach(f => {
                const li = document.createElement('li'); li.className = 'cert-item';
                li.innerHTML = `<span>${f}</span><button type="button" class="btn-copy-cert">Copy Name</button>`;
                li.querySelector('button').onclick = (e) => {
                    navigator.clipboard.writeText(f);
                    e.target.textContent = 'Copied!';
                    setTimeout(() => e.target.textContent = 'Copy Name', 1500);
                };
                certList.appendChild(li);
            });
            populateCertSelects();
        } catch (e) { certList.innerHTML = `<li class="cert-item" style="color:var(--color-danger);">Error: ${e.message}</li>`; }
    }

    // Automatically handle file upload for Certificates when the input changes
    certUploadInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const fd = new FormData(); 
        fd.append('certificate', file);
        showToast("Uploading certificate...", "info");
        
        try {
            const res = await fetch('api/env/certs', { method: 'POST', body: fd });
            if (!res.ok) throw new Error((await res.json()).error || 'Upload failed');
            
            showToast("Certificate uploaded!", "success");
            certUploadInput.value = ''; 
            loadCertificates(); 
        } catch (e) { 
            showToast(`Upload error: ${e.message}`, "error"); 
        }
    });

    // --- Init ---
    loadConfig();
    loadCertificates();
    loadUnsModel();
});