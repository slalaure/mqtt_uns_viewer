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
 */
document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('config-form');
    const saveButton = document.getElementById('save-config-button');
    const statusMessage = document.getElementById('status-message');

    // Cert Manager Elements
    const certList = document.getElementById('cert-list');
    const uploadInput = document.getElementById('cert-upload-input');
    const btnUpload = document.getElementById('btn-upload-cert');
    const uploadStatus = document.getElementById('cert-upload-status');

    // Model Manager Elements
    const modelEditor = document.getElementById('uns-model-editor');
    const btnSaveModel = document.getElementById('btn-save-model');
    const modelUploadInput = document.getElementById('model-upload-input');
    const btnUploadModel = document.getElementById('btn-upload-model');
    const modelUploadStatus = document.getElementById('model-upload-status');

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
            alert("UNS Model saved successfully!");
            loadUnsModel(); // Reload to formatting
        } catch (e) {
            alert(`Error saving model: ${e.message}`);
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
            alert("Please select a JSON file first.");
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const json = JSON.parse(e.target.result);
                // We save immediately upon upload
                saveUnsModel(json);
                modelUploadStatus.textContent = "✅ Uploaded & Saved!";
                modelUploadStatus.style.color = 'var(--color-success)';
                modelUploadInput.value = '';
                setTimeout(() => { modelUploadStatus.textContent = ''; }, 3000);
            } catch (err) {
                alert("Invalid JSON file: " + err.message);
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
            alert("Please select a file first.");
            return;
        }
        
        const formData = new FormData();
        formData.append('certificate', file);

        btnUpload.disabled = true;
        btnUpload.textContent = 'Uploading...';
        uploadStatus.textContent = '';

        try {
            const response = await fetch('api/env/certs', {
                method: 'POST',
                body: formData
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Upload failed');
            
            uploadStatus.textContent = '✅ Uploaded!';
            uploadStatus.style.color = 'var(--color-success)';
            uploadInput.value = ''; // Clear input
            loadCertificates(); // Refresh list
        } catch (e) {
            uploadStatus.textContent = `❌ ${e.message}`;
            uploadStatus.style.color = 'var(--color-danger)';
        } finally {
            btnUpload.disabled = false;
            btnUpload.textContent = 'Upload';
            setTimeout(() => { uploadStatus.textContent = ''; }, 3000);
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
            statusMessage.textContent = error.message;
            statusMessage.className = 'status-message error';
        }
    }

    // Handle saving the configuration
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        saveButton.disabled = true;
        saveButton.textContent = 'Saving...';
        statusMessage.textContent = '';
        statusMessage.className = 'status-message';

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
                statusMessage.textContent = 'Error: Invalid JSON in MQTT_BROKERS field.';
                statusMessage.className = 'status-message error';
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

            statusMessage.textContent = 'Configuration saved! Please restart the server for changes to take effect.';
            statusMessage.className = 'status-message success';
            
            const restart = confirm("Configuration saved!\nA server restart is required for changes to take effect.\n\nRestart now?");
            if (restart) {
                statusMessage.textContent = 'Restarting server...';
                statusMessage.className = 'status-message success';
                fetch('api/env/restart', { method: 'POST' });
            } else {
                statusMessage.textContent = 'Configuration saved! Restart the server later to apply changes.';
                statusMessage.className = 'status-message success';
            }

        } catch (error) {
            statusMessage.textContent = error.message;
            statusMessage.className = 'status-message error';
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