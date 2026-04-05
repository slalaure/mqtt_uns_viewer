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
 * View module for the Floating AI Chat Assistant.
 * Refactored to delegate all logic to the <ai-chat-widget> Web Component.
 */
import { sendWebSocketMessage } from './ws-client.js';
import './components/ai-chat-widget.js';

let chatWidget = null;

/**
 * Initializes the Chat View (Called once).
 */
export function initChatView(basePath) {
    chatWidget = document.querySelector('ai-chat-widget');
    if (chatWidget) {
        chatWidget.init(basePath);
        
        // Listen for internal events from the component to bridge with WebSocket
        window.addEventListener('send-chat-message', (e) => {
            sendWebSocketMessage({
                type: 'chat_message',
                ...e.detail
            });
        });

        window.addEventListener('stop-chat-generation', (e) => {
            sendWebSocketMessage({
                type: 'chat_stop',
                ...e.detail
            });
        });
    }
}

/**
 * Mounts the view (Optional lifecycle).
 */
export function mountChatView() {
    console.log("[Chat View] Mounted (via Web Component).");
}

/**
 * Unmounts the view (Optional lifecycle).
 */
export function unmountChatView() {
    console.log("[Chat View] Unmounted.");
}

/**
 * Global bridge for streaming messages received via WebSocket.
 */
export function onChatStreamMessage(data) {
    if (chatWidget) {
        chatWidget.onStreamMessage(data);
    }
}

/**
 * Bridge for manual widget toggling if needed from other views.
 */
export function toggleChatWidget(open) {
    if (chatWidget) {
        chatWidget.toggleWidget(open);
    }
}
