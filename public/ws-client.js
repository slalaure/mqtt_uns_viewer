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
 * WebSocket Client Module
 * Encapsulates WebSocket connection, reconnection logic, and raw message parsing.
 */

let wsInstance = null;

/**
 * Initializes and connects the WebSocket client.
 * @param {string} url - The WebSocket URL to connect to.
 * @param {Object} callbacks - Event callbacks (onOpen, onMessage, onError, onClose, onReconnect).
 * @returns {WebSocket} The WebSocket instance.
 */
export function connectWebSocket(url, callbacks = {}) {
    console.log("Connecting WebSocket to:", url);
    wsInstance = new WebSocket(url);

    wsInstance.onopen = () => {
        if (callbacks.onOpen) callbacks.onOpen();
    };

    wsInstance.onmessage = async (event) => {
        try {
            const dataText = event.data instanceof Blob ? await event.data.text() : event.data;
            const message = JSON.parse(dataText);
            if (callbacks.onMessage) callbacks.onMessage(message);
        } catch (e) {
            console.error("Error parsing WebSocket message:", e);
        }
    };

    wsInstance.onerror = (err) => {
        console.error("WebSocket Error:", err);
        if (callbacks.onError) callbacks.onError(err);
    };

    wsInstance.onclose = (event) => {
        console.warn(`WebSocket closed (code: ${event.code}). Reconnecting in 3s...`);
        if (callbacks.onClose) callbacks.onClose(event);
        setTimeout(() => {
            if (callbacks.onReconnect) callbacks.onReconnect();
        }, 3000);
    };

    return wsInstance;
}

/**
 * Returns the active WebSocket instance.
 * @returns {WebSocket|null}
 */
export function getWebSocket() {
    return wsInstance;
}

/**
 * Sends a JSON stringified message over the WebSocket connection.
 * @param {Object} data - The data object to send.
 */
export function sendWebSocketMessage(data) {
    if (wsInstance && wsInstance.readyState === WebSocket.OPEN) {
        wsInstance.send(JSON.stringify(data));
    } else {
        console.warn("Cannot send message, WebSocket is not open.");
    }
}