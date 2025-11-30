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
 * View module for the Floating AI Chat Assistant.
 */

import { trackEvent } from './utils.js';

// --- DOM Elements ---
const chatContainer = document.getElementById('chat-widget-container');
const chatHistory = document.getElementById('chat-history');
const chatInput = document.getElementById('chat-input');
const btnSend = document.getElementById('btn-send-chat');
const btnClear = document.getElementById('btn-chat-clear');
const btnMinimize = document.getElementById('btn-chat-minimize');
const fabButton = document.getElementById('btn-chat-fab');

// --- New Elements (Dynamically Injected) ---
let fileInput = null;
let previewContainer = null;

// --- State ---
let conversationHistory = [];
let isProcessing = false;
let isWidgetOpen = false;
let pendingAttachment = null; // { type: 'image'|'text', content: string, name: string }

/**
 * Initializes the Chat View.
 */
export function initChatView() {
    // --- 1. Inject Upload Controls ---
    injectUploadUI();

    loadHistory();

    // FAB Click -> Open Widget
    fabButton?.addEventListener('click', () => {
        toggleChatWidget(true);
    });

    // Minimize Click -> Close Widget
    btnMinimize?.addEventListener('click', () => {
        toggleChatWidget(false);
    });

    // Send Message
    btnSend?.addEventListener('click', sendMessage);
    
    // Input Handling (Enter to send, Shift+Enter for newline)
    chatInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
        // Auto-resize textarea
        chatInput.style.height = 'auto';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 100) + 'px';
    });

    // Clear History
    btnClear?.addEventListener('click', () => {
        if (confirm('Clear conversation history?')) {
            conversationHistory = [];
            saveHistory();
            renderHistory();
            trackEvent('chat_clear_history');
        }
    });
}

/**
 * Injects the file upload button and preview area into the existing DOM.
 */
function injectUploadUI() {
    const inputArea = document.querySelector('.chat-input-area');
    if (!inputArea) return;

    // 1. Create File Input (Hidden)
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'chat-file-input';
    fileInput.accept = 'image/*,.txt,.json,.csv,.js,.md,.log';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', handleFileSelect);
    inputArea.appendChild(fileInput);

    // 2. Create Attachment Button (Paperclip)
    const btnAttach = document.createElement('button');
    btnAttach.id = 'btn-chat-attach';
    btnAttach.innerHTML = '📎';
    btnAttach.title = 'Attach file';
    btnAttach.addEventListener('click', () => fileInput.click());
    
    // Insert before the textarea
    inputArea.insertBefore(btnAttach, chatInput);

    // 3. Create Preview Container (Above input area)
    previewContainer = document.createElement('div');
    previewContainer.id = 'chat-file-preview';
    previewContainer.style.display = 'none';
    
    // Insert into chat-body, before input-area
    const chatBody = document.querySelector('.chat-body');
    if (chatBody) {
        chatBody.insertBefore(previewContainer, inputArea);
    }
}

/**
 * Handles file selection from the input.
 */
function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    const isImage = file.type.startsWith('image/');

    // Max size check (e.g. 2MB)
    if (file.size > 2 * 1024 * 1024) {
        alert("File too large. Max 2MB.");
        fileInput.value = '';
        return;
    }

    reader.onload = (e) => {
        const result = e.target.result;
        
        pendingAttachment = {
            type: isImage ? 'image' : 'text',
            content: result, // Base64 for image, String for text
            name: file.name
        };

        renderPreview();
        chatInput.focus();
    };

    if (isImage) {
        reader.readAsDataURL(file);
    } else {
        reader.readAsText(file);
    }
}

function renderPreview() {
    if (!pendingAttachment) {
        previewContainer.style.display = 'none';
        previewContainer.innerHTML = '';
        return;
    }

    previewContainer.style.display = 'flex';
    previewContainer.innerHTML = `
        <div class="preview-item">
            ${pendingAttachment.type === 'image' 
                ? `<img src="${pendingAttachment.content}" alt="preview">` 
                : `<div class="file-icon">📄</div>`
            }
            <span class="file-name">${pendingAttachment.name}</span>
            <button class="btn-remove-attachment">×</button>
        </div>
    `;

    previewContainer.querySelector('.btn-remove-attachment').addEventListener('click', () => {
        pendingAttachment = null;
        fileInput.value = '';
        renderPreview();
    });
}

/**
 * Toggles the visibility of the floating widget.
 * @param {boolean} show - True to show, false to hide.
 */
export function toggleChatWidget(show) {
    isWidgetOpen = show;
    if (show) {
        chatContainer.classList.add('active');
        fabButton.style.display = 'none'; // Hide FAB when open
        trackEvent('chat_widget_open');
        setTimeout(() => {
            scrollToBottom();
            chatInput.focus();
        }, 300);
    } else {
        chatContainer.classList.remove('active');
        fabButton.style.display = 'flex'; // Show FAB when closed
        trackEvent('chat_widget_minimize');
    }
}

/**
 * Loads conversation history from LocalStorage.
 */
function loadHistory() {
    try {
        const saved = localStorage.getItem('chat_history');
        if (saved) {
            conversationHistory = JSON.parse(saved);
            renderHistory();
        } else {
            // Initial welcome message
            addMessageToState('system', 'Hello! I am your UNS Assistant. I can help you explore topics, search history, and control simulators.');
        }
    } catch (e) {
        console.error("Failed to load chat history", e);
        conversationHistory = [];
    }
}

function saveHistory() {
    localStorage.setItem('chat_history', JSON.stringify(conversationHistory));
}

/**
 * Adds a message to the state and updates UI.
 */
function addMessageToState(role, content, toolCalls = null) {
    const msg = { role, content, timestamp: Date.now() };
    if (toolCalls) msg.tool_calls = toolCalls;
    
    conversationHistory.push(msg);
    
    // Keep context window reasonable (last 30 messages)
    if (conversationHistory.length > 30) {
        conversationHistory = conversationHistory.slice(conversationHistory.length - 30);
    }
    
    saveHistory();
    appendMessageToUI(msg);
}

/**
 * Renders the entire history.
 */
function renderHistory() {
    if (!chatHistory) return;
    chatHistory.innerHTML = '';
    conversationHistory.forEach(msg => appendMessageToUI(msg));
    scrollToBottom();
}

/**
 * Appends a single message bubble to the UI.
 */
function appendMessageToUI(msg) {
    if (!chatHistory) return;

    const div = document.createElement('div');
    div.className = `chat-message ${msg.role}`;
    
    let contentToFormat = msg.content;
    
    // Handle Array Content (Multimodal - Image + Text)
    if (Array.isArray(msg.content)) {
        let htmlParts = '';
        msg.content.forEach(part => {
            if (part.type === 'text') {
                htmlParts += formatMessageContent(part.text);
            } else if (part.type === 'image_url') {
                htmlParts += `<div class="chat-image-container"><img src="${part.image_url.url}" alt="User Upload" class="chat-image"></div>`;
            }
        });
        div.innerHTML = htmlParts;
    } else {
        // Standard Text Content
        let htmlContent = formatMessageContent(msg.content || '');

        // Visualize tool usage if present
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
            msg.tool_calls.forEach(tool => {
                const args = tool.function.arguments.length > 50 
                    ? tool.function.arguments.substring(0, 50) + '...' 
                    : tool.function.arguments;
                    
                htmlContent += `
                    <div class="tool-usage">
                        <div class="tool-usage-header">🔧 ${tool.function.name}</div>
                        <code>${args}</code>
                    </div>
                `;
            });
        }
        
        // Handle tool output messages
        if (msg.role === 'tool') {
            div.classList.add('system'); 
            div.innerHTML = `<div class="tool-usage-header">📋 Output (${msg.name}):</div>` + 
                            `<small>${htmlContent.substring(0, 150)}${htmlContent.length > 150 ? '...' : ''}</small>`;
        } else {
            div.innerHTML = htmlContent;
        }
    }

    chatHistory.appendChild(div);
    scrollToBottom();
}

/**
 * Basic formatter for Markdown-like syntax.
 */
function formatMessageContent(text) {
    if (!text) return '';
    let formatted = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    formatted = formatted.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
    formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
    formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    formatted = formatted.replace(/\n/g, '<br>');
    return formatted;
}

function scrollToBottom() {
    if (chatHistory) chatHistory.scrollTop = chatHistory.scrollHeight;
}

/**
 * Sends the user message to the backend API.
 */
async function sendMessage() {
    if (isProcessing) return;
    
    const text = chatInput.value.trim();
    if (!text && !pendingAttachment) return;

    let messageContent = text;

    // --- Prepare Payload with Attachment ---
    if (pendingAttachment) {
        if (pendingAttachment.type === 'image') {
            // OpenAI/Gemini Multimodal Format
            messageContent = [
                { type: "text", text: text },
                { 
                    type: "image_url", 
                    image_url: { 
                        url: pendingAttachment.content 
                    } 
                }
            ];
        } else {
            // Text File: Append content to prompt
            const cleanContent = pendingAttachment.content.length > 10000 
                ? pendingAttachment.content.substring(0, 10000) + "\n...[TRUNCATED]..." 
                : pendingAttachment.content;
            
            messageContent = `${text}\n\n--- ATTACHED FILE: ${pendingAttachment.name} ---\n${cleanContent}\n--- END OF FILE ---`;
        }
    }

    // 1. UI Updates
    chatInput.value = '';
    chatInput.style.height = 'auto';
    
    // Clear attachment state
    pendingAttachment = null;
    renderPreview();
    fileInput.value = '';

    addMessageToState('user', messageContent);
    
    isProcessing = true;
    btnSend.disabled = true;
    
    // Show blinking dots
    showTypingIndicator(true);

    // 2. Prepare Payload (Backend handles keys/urls)
    const messagesPayload = conversationHistory.map(m => {
        const apiMsg = { role: m.role, content: m.content };
        if (m.tool_calls) apiMsg.tool_calls = m.tool_calls;
        if (m.tool_call_id) apiMsg.tool_call_id = m.tool_call_id;
        if (m.name) apiMsg.name = m.name;
        return apiMsg;
    });

    // 3. Send to Backend Agent
    try {
        const response = await fetch('api/chat/completion', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: messagesPayload })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || `API Error: ${response.statusText}`);
        }

        const data = await response.json();
        const assistantMsg = data.choices[0].message;

        addMessageToState('assistant', assistantMsg.content, assistantMsg.tool_calls);
        trackEvent('chat_message_sent');

    } catch (error) {
        console.error("Chat Error:", error);
        // Add error directly to chat state to visualize it
        addMessageToState('error', `Error: ${error.message}`);
    } finally {
        isProcessing = false;
        btnSend.disabled = false;
        // Hide blinking dots
        showTypingIndicator(false);
        chatInput.focus();
    }
}

/**
 * Shows or hides a blinking dots indicator.
 * @param {boolean} show
 */
function showTypingIndicator(show) {
    if (!chatHistory) return;
    const existing = document.getElementById('typing-indicator');
    
    if (show) {
        if (!existing) {
            const div = document.createElement('div');
            div.id = 'typing-indicator';
            div.className = 'typing-indicator-container';
            div.innerHTML = `
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            `;
            chatHistory.appendChild(div);
            scrollToBottom();
        }
    } else {
        if (existing) existing.remove();
    }
}