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
    const form = document.getElementById('config-form');
    const saveButton = document.getElementById('save-config-button');
    const statusMessage = document.getElementById('status-message');

    // Charge la configuration actuelle depuis le serveur
    async function loadConfig() {
        try {
            const response = await fetch('/api/env');
            if (!response.ok) {
                throw new Error('Failed to load configuration.');
            }
            const config = await response.json();

            // Vide le formulaire avant de le remplir
            form.innerHTML = '';

            // Crée dynamiquement les champs du formulaire
            for (const key in config) {
                const group = document.createElement('div');
                group.className = 'form-group';

                const label = document.createElement('label');
                label.htmlFor = `input-${key}`;
                label.textContent = key;

                const input = document.createElement('input');
                input.type = 'text';
                input.id = `input-${key}`;
                input.name = key;
                input.value = config[key];

                group.appendChild(label);
                group.appendChild(input);
                form.appendChild(group);
            }
        } catch (error) {
            statusMessage.textContent = error.message;
            statusMessage.className = 'status-message error';
        }
    }

    // Gère la sauvegarde de la configuration
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        saveButton.disabled = true;
        saveButton.textContent = 'Saving...';
        statusMessage.textContent = '';
        statusMessage.className = 'status-message';

        const formData = new FormData(form);
        const configData = Object.fromEntries(formData.entries());

        try {
            const response = await fetch('/api/env', {
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
                // Appelle la nouvelle API de redémarrage
                fetch('/api/env/restart', { method: 'POST' });
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

    // Charge la configuration au démarrage de la page
    loadConfig();
});