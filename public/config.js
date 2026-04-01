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
 * Configuration Page Script
 * Manages System Infrastructure: Certificates, UNS Model, and Environment Variables.
 * [UPDATED] Operational tasks (DB, Alerts) moved to Admin View.
 * [UPDATED] Replaced native alerts with centralized showToast and confirmModal system.
 */
import { showToast, confirmModal } from './utils.js';

document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('config-form');
    const saveButton = document.getElementById('save-config-button');

    // Cert Manager Elements
    const certList = document.getElementById('cert-list');
    const uploadInput = document.getElementById('cert-upload-input');
    const btnUpload = document.getElementById('btn-upload-cert');

    // Model Manager Elements
    const modelEditor = document.getElementById('uns-model-editor');
    const btnSaveModel = document.getElementById('btn-save-model');
    const modelUploadInput = document.getElementById('model-upload-input');
    const btnUploadModel = document.getElementById('btn-upload-model');

    // --- UNS Model Manager Logic ---
    async function loadUnsModel() {
        try {
            const response = await fetch('api/env/model');
            if (!response.ok) throw new Error("Failed to fetch UNS Model.");
            const model = await response.json();
            // Pretty print JSON in textarea
            modelEditor.value = JSON.stringify(model, null, 2);
        } catch (e) {
            modelEditor.value = `// Error loading model: ${e.message}\n[]`;
        }
    }

    async function saveUnsModel(modelData) {
        btnSaveModel.disabled = true;
        btnSaveModel.textContent = "Saving...";
        try {
            // Validate JSON
            let jsonPayload;
            if (typeof modelData === 'string') {
                jsonPayload = JSON.parse(modelData);
            } else {
                jsonPayload = modelData;
            }

            const response = await fetch('api/env/model', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(jsonPayload)
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || "Failed to save model.");
            }
            
            showToast("UNS Model saved successfully!", "success");
            loadUnsModel(); // Reload to formatting
        } catch (e) {
            showToast(`Error saving model: ${e.message}`, "error");
        } finally {
            btnSaveModel.disabled = false;
            btnSaveModel.textContent = "Save Model";
        }
    }

    // Save Button Click (Textarea content)
    btnSaveModel.addEventListener('click', () => {
        saveUnsModel(modelEditor.value);
    });

    // Upload File Click
    btnUploadModel.addEventListener('click', () => {
        const file = modelUploadInput.files[0];
        if (!file) {
            showToast("Please select a JSON file first.", "warning");
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const json = JSON.parse(e.target.result);
                // We save immediately upon upload
                saveUnsModel(json);
                showToast("Uploaded & Saved!", "success");
                modelUploadInput.value = '';
            } catch (err) {
                showToast("Invalid JSON file: " + err.message, "error");
            }
        };
        reader.readAsText(file);
    });

    // --- Certificate Manager Logic ---
    async function loadCertificates() {
        try {
            const response = await fetch('api/env/certs');
            if (!response.ok) throw new Error("Failed to fetch certificates.");
            const files = await response.json();
            certList.innerHTML = '';
            if (files.length === 0) {
                certList.innerHTML = '<li class="cert-item" style="justify-content: center; color: var(--color-text-secondary);">No certificates found.</li>';
                return;
            }
            files.forEach(filename => {
                const li = document.createElement('li');
                li.className = 'cert-item';
                const nameSpan = document.createElement('span');
                nameSpan.textContent = filename;
                
                const copyBtn = document.createElement('button');
                copyBtn.className = 'btn-copy-cert';
                copyBtn.textContent = 'Copy Name';
                copyBtn.type = 'button'; // Prevent form submission
                copyBtn.onclick = () => {
                    navigator.clipboard.writeText(filename);
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => copyBtn.textContent = 'Copy Name', 1500);
                };

                li.appendChild(nameSpan);
                li.appendChild(copyBtn);
                certList.appendChild(li);
            });
        } catch (e) {
            certList.innerHTML = `<li class="cert-item" style="color: var(--color-danger);">Error: ${e.message}</li>`;
        }
    }

    btnUpload.addEventListener('click', async () => {
        const file = uploadInput.files[0];
        if (!file) {
            showToast("Please select a file first.", "warning");
            return;
        }
        
        const formData = new FormData();
        formData.append('certificate', file);

        btnUpload.disabled = true;
        btnUpload.textContent = 'Uploading...';

        try {
            const response = await fetch('api/env/certs', {
                method: 'POST',
                body: formData
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Upload failed');
            
            showToast("Certificate uploaded successfully!", "success");
            uploadInput.value = ''; // Clear input
            loadCertificates(); // Refresh list
        } catch (e) {
            showToast(`Upload error: ${e.message}`, "error");
        } finally {
            btnUpload.disabled = false;
            btnUpload.textContent = 'Upload';
        }
    });

    // --- Environment Configuration Logic ---
    async function loadConfig() {
        try {
            const response = await fetch('api/env');
            if (!response.ok) {
                if (response.status === 401) {
                    throw new Error('Authentication failed. Please check your credentials.');
                }
                throw new Error('Failed to load configuration.');
            }
            const config = await response.json();
            
            // Clear form before populating
            form.innerHTML = '';

            // Dynamically create form fields
            for (const key in config) {
                const group = document.createElement('div');
                group.className = 'form-group';
                
                const label = document.createElement('label');
                label.htmlFor = `input-${key}`;
                label.textContent = key;
                group.appendChild(label);

                //  Special handling for MQTT_BROKERS to use a Textarea
                if (key === 'MQTT_BROKERS') {
                    const textarea = document.createElement('textarea');
                    textarea.id = `input-${key}`;
                    textarea.name = key;
                    
                    let rawValue = config[key];
                    // Remove potential surrounding single quotes from .env parsing
                    if (typeof rawValue === 'string') {
                        rawValue = rawValue.replace(/^'|'$/g, '');
                    }

                    try {
                        // Try to parse and pretty-print the JSON
                        const jsonObj = JSON.parse(rawValue);
                        textarea.value = JSON.stringify(jsonObj, null, 4);
                    } catch (e) {
                        // If not valid JSON, display raw value
                        textarea.value = rawValue;
                    }
                    group.appendChild(textarea);
                } else {
                    // Default Input field
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.id = `input-${key}`;
                    input.name = key;
                    input.value = config[key];
                    group.appendChild(input);
                }
                
                form.appendChild(group);
            }
        } catch (error) {
            showToast(error.message, "error");
        }
    }

    // Handle saving the configuration
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        saveButton.disabled = true;
        saveButton.textContent = 'Saving...';

        const formData = new FormData(form);
        const configData = Object.fromEntries(formData.entries());

        //  Minify MQTT_BROKERS JSON back to a single line string
        if (configData['MQTT_BROKERS']) {
            try {
                const jsonContent = configData['MQTT_BROKERS'];
                const parsed = JSON.parse(jsonContent);
                // Minify to single line for .env compatibility
                configData['MQTT_BROKERS'] = JSON.stringify(parsed);
            } catch (e) {
                showToast('Error: Invalid JSON in MQTT_BROKERS field.', 'error');
                saveButton.disabled = false;
                saveButton.textContent = 'Save Configuration';
                return; // Stop submission
            }
        }

        try {
            const response = await fetch('api/env', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(configData),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to save configuration.');
            }
            
            const restart = await confirmModal(
                "Restart Required", 
                "Configuration saved!\nA server restart is required for changes to take effect.\n\nRestart now?", 
                "Restart Now", 
                false
            );
            
            if (restart) {
                showToast('Restarting server...', 'info');
                fetch('api/env/restart', { method: 'POST' });
            } else {
                showToast('Configuration saved! Restart the server later to apply changes.', 'success');
            }

        } catch (error) {
            showToast(error.message, "error");
        } finally {
            saveButton.disabled = false;
            saveButton.textContent = 'Save Configuration';
        }
    });

    // Load config, certs, and model when the page starts
    loadConfig();
    loadCertificates();
    loadUnsModel();
});