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
 * Reusable Payload Viewer Module
 * Manages a payload display panel and its associated history log.
 */

/**
 * Creates a new payload viewer instance.
 * @param {object} elements
 * @param {HTMLElement} elements.topicEl - The element to show the topic in.
 * @param {HTMLElement} elements.contentEl - The <pre> element for the content.
 * @param {HTMLElement} [elements.historyLogEl] - (Optional) The <ul> element for history.
 * @param {HTMLElement} [elements.placeholderEl] - (Optional) Placeholder for history.
 * @param {boolean} [elements.isMultiBroker] - (Optional) Whether to show broker IDs.
 */
export function createPayloadViewer(elements) {
    const { topicEl, contentEl, historyLogEl, placeholderEl, isMultiBroker = false } = elements;

    /**
     * Displays a payload in the main content area.
     * @param {string} brokerId - The broker ID.
     * @param {string} topic - The topic string.
     * @param {string} payload - The payload string.
     */
    function display(brokerId, topic, payload) {
        if (topicEl) {
            if (topic) {
                //  Conditionally show brokerId
                topicEl.textContent = isMultiBroker ? `[${brokerId}] ${topic}` : topic;
            } else {
                topicEl.textContent = "No topic selected";
            }
        }
        if (contentEl) {
            if (payload === undefined || payload === null) {
                contentEl.textContent = "Select a topic with data to see its payload.";
                return;
            }
            try {
                // payload is expected to be a string
                const jsonObj = JSON.parse(payload);
                contentEl.textContent = JSON.stringify(jsonObj, null, 2);
            } catch (e) {
                contentEl.textContent = payload; // It's a raw string
            }
        }
    }

    /**
     * Updates the recent history log for a topic.
     * @param {string} brokerId - The broker ID.
     * @param {string} topic - The topic string.
     * @param {Array} data - Array of history entries from the server.
     */
    function updateHistory(brokerId, topic, data) {
        if (!historyLogEl) return;
        historyLogEl.innerHTML = '';
        
        if (placeholderEl) {
             placeholderEl.style.display = 'none';
        }

        //  Create topic display string
        const displayTopic = isMultiBroker ? `[${brokerId}] ${topic}` : topic;

        if (!data || data.length === 0) {
            if (placeholderEl) {
                placeholderEl.textContent = `No recent history for ${displayTopic}.`;
                placeholderEl.style.display = 'block';
            } else {
                 historyLogEl.innerHTML = `<p class="history-placeholder">No recent history for ${displayTopic}.</p>`;
            }
            return;
        }
        
        data.forEach(entry => {
            const div = document.createElement('div');
            div.className = 'topic-history-entry';
            
            //  Add brokerId to history entry if multi-broker
            const brokerHtml = isMultiBroker ? `<span class="history-entry-broker">[${entry.broker_id}]</span>` : '';
            
            div.innerHTML = `
                <span class="history-entry-timestamp">${new Date(entry.timestamp).toLocaleTimeString('en-GB')}</span>
                ${brokerHtml}
                <pre class="history-entry-payload"></pre>
            `;
            const pre = div.querySelector('.history-entry-payload');
            try {
                // entry.payload is a string from the server
                pre.textContent = JSON.stringify(JSON.parse(entry.payload), null, 2);
            } catch (e) {
                pre.textContent = entry.payload; // It's a raw string
            }
            historyLogEl.appendChild(div);
        });
    }

    /**
     * Clears the payload and history display.
     */
    function clear() {
        if (topicEl) topicEl.textContent = "No topic selected";
        if (contentEl) contentEl.textContent = "Select a topic to see its payload.";
        if (historyLogEl) historyLogEl.innerHTML = '';
        if (placeholderEl) {
             placeholderEl.textContent = 'Select a topic to see its payload.';
             placeholderEl.style.display = 'block';
        }
    }

    return {
        display,
        updateHistory,
        clear
    };
}