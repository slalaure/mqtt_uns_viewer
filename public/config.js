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

document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('config-form');
    const saveButton = document.getElementById('save-config-button');
    const statusMessage = document.getElementById('status-message');

    // Load current configuration from the server
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

    // Load config when the page starts
    loadConfig();
});