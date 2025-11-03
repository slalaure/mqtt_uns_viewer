/**
 * @license MIT
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
 */
export function createPayloadViewer(elements) {
    const { topicEl, contentEl, historyLogEl, placeholderEl } = elements;

    /**
     * Displays a payload in the main content area.
     * @param {string} topic - The topic string.
     * @param {string} payload - The payload string.
     */
    function display(topic, payload) {
        if (topicEl) {
            topicEl.textContent = topic || "No topic selected";
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
     * @param {string} topic - The topic string.
     * @param {Array} data - Array of history entries from the server.
     */
    function updateHistory(topic, data) {
        if (!historyLogEl) return;
        historyLogEl.innerHTML = '';
        
        if (placeholderEl) {
             placeholderEl.style.display = 'none';
        }

        if (!data || data.length === 0) {
            if (placeholderEl) {
                placeholderEl.textContent = `No recent history for ${topic}.`;
                placeholderEl.style.display = 'block';
            } else {
                 historyLogEl.innerHTML = `<p class="history-placeholder">No recent history for ${topic}.</p>`;
            }
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