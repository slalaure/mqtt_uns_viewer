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
 * Includes Continuous Voice Input and Language-Aware Output.
 * Optimized for Chrome "Google" Voices & Safari compatibility.
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

// --- New Elements ---
let fileInput = null;
let previewContainer = null;
let btnMic = null; 
let btnCam = null; 
let cameraModal = null; 
let cameraVideo = null; 
let cameraStream = null; 

// --- State ---
let conversationHistory = [];
let isProcessing = false;
let isWidgetOpen = false;
let pendingAttachment = null;

// --- Storage & Path State ---
let storageKey = 'chat_history'; // Default key
let appBasePath = ''; // [NEW] Store base path for API calls

// --- Voice State ---
let recognition = null;
let isListening = false;
let wasLastInputVoice = false; 
let finalTranscript = ''; 
let userWantMicActive = false;

// Global reference for TTS to prevent Garbage Collection
let currentUtterance = null; 
// Cache for voices
let availableVoices = [];

let onFileCreatedCallback = null;

// --- Streaming UI ---
let currentLogDiv = null; // [MODIFIED] Renamed from currentStatusDiv to indicate persistence
let hasToolActivity = false; // [NEW] Track if tools were used

/**
 * Initializes the Chat View.
 * @param {string} basePath - The base path of the application.
 * @param {function} onFileCreated - Optional callback when AI creates a file.
 */
export function initChatView(basePath, onFileCreated) {
    // 1. Store and normalize base path for API calls
    appBasePath = basePath || '';
    if (appBasePath === '/') appBasePath = '';
    if (appBasePath.endsWith('/')) appBasePath = appBasePath.slice(0, -1);

    // 2. Generate scoped key based on path
    if (basePath && basePath !== '/' && basePath !== '') {
        const cleanPath = basePath.replace(/^\/|\/$/g, '').replace(/\//g, '_');
        if (cleanPath) {
            storageKey = `chat_history_${cleanPath}`;
            console.log(`[ChatView] Using scoped history key: ${storageKey}`);
        }
    }

    if (onFileCreated) {
        onFileCreatedCallback = onFileCreated;
    }

    injectUploadUI();
    injectVoiceUI(); 
    injectCameraUI(); 
    loadHistory();

    // [FIX] Pre-load voices aggressively for Chrome/Safari
    if ('speechSynthesis' in window) {
        const loadVoices = () => {
            availableVoices = window.speechSynthesis.getVoices();
            console.log(`[TTS] Loaded ${availableVoices.length} voices.`);
        };
        loadVoices();
        // Chrome fires this when voices are ready
        window.speechSynthesis.onvoiceschanged = loadVoices;
    }

    fabButton?.addEventListener('click', () => toggleChatWidget(true));
    btnMinimize?.addEventListener('click', () => toggleChatWidget(false));
    btnSend?.addEventListener('click', () => sendMessage(false));
    chatInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage(false);
        }
        autoResizeInput();
    });
    btnClear?.addEventListener('click', () => {
        if (confirm('Clear conversation history?')) {
            conversationHistory = [];
            saveHistory();
            renderHistory();
            trackEvent('chat_clear_history');
            window.speechSynthesis.cancel();
        }
    });
}

function autoResizeInput() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 100) + 'px';
}

function injectCameraUI() {
    const inputArea = document.querySelector('.chat-input-area');
    if (!inputArea) return;

    btnCam = document.createElement('button');
    btnCam.id = 'btn-chat-cam';
    btnCam.innerHTML = '📷';
    btnCam.title = 'Take Photo';
    btnCam.className = 'chat-icon-btn';
    
    if (btnMic) inputArea.insertBefore(btnCam, btnMic);
    else inputArea.insertBefore(btnCam, btnSend);

    cameraModal = document.createElement('div');
    cameraModal.className = 'chat-camera-modal';
    cameraModal.style.display = 'none';
    cameraModal.innerHTML = `
        <div class="camera-content">
            <video id="chat-camera-feed" autoplay playsinline></video>
            <div class="camera-controls">
                <button id="btn-camera-cancel" class="camera-btn-cancel">Cancel</button>
                <button id="btn-camera-capture" class="camera-btn-capture"></button>
            </div>
        </div>
    `;
    document.body.appendChild(cameraModal);

    cameraVideo = document.getElementById('chat-camera-feed');
    document.getElementById('btn-camera-cancel').addEventListener('click', closeCamera);
    document.getElementById('btn-camera-capture').addEventListener('click', takePicture);

    btnCam.addEventListener('click', openCamera);
}

async function openCamera() {
    if (!window.isSecureContext) {
        alert("Camera requires HTTPS or localhost.");
        return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return alert("Camera not supported");
    
    try {
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        cameraVideo.srcObject = cameraStream;
        cameraModal.style.display = 'flex';
        if (userWantMicActive) {
            userWantMicActive = false;
            recognition?.stop();
        }
    } catch (err) { alert("Camera error: " + err.message); }
}

function closeCamera() {
    if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
    if (cameraModal) cameraModal.style.display = 'none';
}

function takePicture() {
    if (!cameraVideo || !cameraStream) return;
    const canvas = document.createElement('canvas');
    canvas.width = cameraVideo.videoWidth;
    canvas.height = cameraVideo.videoHeight;
    canvas.getContext('2d').drawImage(cameraVideo, 0, 0);
    pendingAttachment = { type: 'image', content: canvas.toDataURL('image/jpeg', 0.8), name: `capture_${Date.now()}.jpg` };
    closeCamera();
    renderPreview();
}

function injectVoiceUI() {
    const inputArea = document.querySelector('.chat-input-area');
    if (!inputArea) return;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    btnMic = document.createElement('button');
    btnMic.id = 'btn-chat-mic';
    btnMic.innerHTML = '🎤'; 
    btnMic.title = 'Voice Input (Click to Start/Stop)';
    btnMic.className = 'chat-icon-btn';
    inputArea.insertBefore(btnMic, btnSend);

    recognition = new SpeechRecognition();
    recognition.continuous = true; 
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    recognition.onstart = () => {
        isListening = true;
        btnMic.classList.add('listening');
        chatInput.placeholder = "Listening... (Click mic to stop)";
    };

    recognition.onend = () => {
        isListening = false;
        if (userWantMicActive) {
            try { recognition.start(); } catch(e) { /* ignore */ }
        } else {
            btnMic.classList.remove('listening');
            chatInput.placeholder = "Ask...";
            if (chatInput.value.trim().length > 0) {
                wasLastInputVoice = true;
            }
        }
    };

    recognition.onresult = (event) => {
        let interimTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                finalTranscript += event.results[i][0].transcript + ' ';
            } else {
                interimTranscript += event.results[i][0].transcript;
            }
        }
        chatInput.value = finalTranscript + interimTranscript;
        autoResizeInput();
        chatInput.scrollTop = chatInput.scrollHeight;
    };

    recognition.onerror = (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
            userWantMicActive = false;
            isListening = false;
            btnMic.classList.remove('listening');
        }
    };

    btnMic.addEventListener('click', () => {
        if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
            alert("Voice input requires HTTPS security.");
            return;
        }
        if (userWantMicActive) {
            userWantMicActive = false;
            recognition.stop();
        } else {
            window.speechSynthesis.cancel();
            userWantMicActive = true;
            if (!chatInput.value.trim()) {
                finalTranscript = '';
            } else {
                finalTranscript = chatInput.value + ' ';
            }
            try { recognition.start(); } catch(e) { console.error(e); }
        }
    });
}

/**
 * [FIX] Enhanced Speak Text
 * - Prioritizes "Google" voices for better quality.
 * - Handles language matching strictly.
 * - Ensures voices are loaded before speaking.
 */
function speakText(text) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();

    let cleanText = text
        .replace(/\*\*/g, '') 
        .replace(/`/g, '')    
        .replace(/#/g, '')    
        .replace(/\[(.*?)\]\(.*?\)/g, '$1') 
        .replace(/```[\s\S]*?```/g, 'Code block skipped.') 
        .replace(/<[^>]*>/g, '');

    currentUtterance = new SpeechSynthesisUtterance(cleanText);
    const targetLang = navigator.language || 'en-US';
    currentUtterance.lang = targetLang;
    currentUtterance.rate = 1.0; // Standard speed for natural voices

    // Ensure voices are loaded
    if (availableVoices.length === 0) {
        availableVoices = window.speechSynthesis.getVoices();
    }

    // Voice Selection Strategy (Priority Order)
    // 1. Exact language match AND contains "Google" (High Quality Chrome)
    // 2. Exact language match
    // 3. Approximate language match (fr-FR vs fr-CA) AND contains "Google"
    // 4. Approximate language match
    let voice = availableVoices.find(v => v.lang === targetLang && v.name.includes('Google'));
    if (!voice) {
        voice = availableVoices.find(v => v.lang === targetLang);
    }
    if (!voice) {
        voice = availableVoices.find(v => v.lang.startsWith(targetLang.substring(0, 2)) && v.name.includes('Google'));
    }
    if (!voice) {
        voice = availableVoices.find(v => v.lang.startsWith(targetLang.substring(0, 2)));
    }

    if (voice) {
        console.log(`[TTS] Speaking with voice: ${voice.name} (${voice.lang})`);
        currentUtterance.voice = voice;
    } else {
        console.warn(`[TTS] No matching voice found for ${targetLang}. Using default.`);
    }

    currentUtterance.onend = () => { currentUtterance = null; };
    currentUtterance.onerror = (e) => { console.error("TTS Error:", e); currentUtterance = null; };
    window.speechSynthesis.speak(currentUtterance);
}

function injectUploadUI() {
    const inputArea = document.querySelector('.chat-input-area');
    if (!inputArea) return;

    fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.id = 'chat-file-input'; fileInput.style.display = 'none';
    fileInput.addEventListener('change', handleFileSelect);
    inputArea.appendChild(fileInput);

    const btnAttach = document.createElement('button');
    btnAttach.id = 'btn-chat-attach'; btnAttach.innerHTML = '📎'; btnAttach.className = 'chat-icon-btn';
    btnAttach.addEventListener('click', () => fileInput.click());

    if(btnCam) inputArea.insertBefore(btnAttach, btnCam);
    else if (btnMic) inputArea.insertBefore(btnAttach, btnMic);
    else inputArea.insertBefore(btnAttach, chatInput);

    previewContainer = document.createElement('div');
    previewContainer.id = 'chat-file-preview'; previewContainer.style.display = 'none';
    document.querySelector('.chat-body')?.insertBefore(previewContainer, inputArea);
}

function handleFileSelect(e) {
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
        pendingAttachment = { type: file.type.startsWith('image/')?'image':'text', content: evt.target.result, name: file.name };
        renderPreview(); chatInput.focus();
    };
    if (file.type.startsWith('image/')) reader.readAsDataURL(file); else reader.readAsText(file);
}

function renderPreview() {
    if(!pendingAttachment) { previewContainer.style.display='none'; return; }
    previewContainer.style.display='flex';
    previewContainer.innerHTML = `<div class="preview-item">${pendingAttachment.type==='image'?`<img src="${pendingAttachment.content}">`:`<div class="file-icon">📄</div>`}<span class="file-name">${pendingAttachment.name}</span><button class="btn-remove-attachment">×</button></div>`;
    previewContainer.querySelector('.btn-remove-attachment').onclick = () => { pendingAttachment=null; fileInput.value=''; renderPreview(); };
}

export function toggleChatWidget(show) {
    isWidgetOpen = show;
    chatContainer.classList.toggle('active', show);
    fabButton.style.display = show ? 'none' : 'flex';
    if(show) setTimeout(() => { scrollToBottom(); chatInput.focus(); }, 300);
}

// [FIX] Sanitizing history on load to remove corrupted data from storage
function loadHistory() {
    try { 
        let rawHistory = JSON.parse(localStorage.getItem(storageKey) || '[]'); 
        // Automatically filter out messages with 'error' role that cause 400 Bad Request
        conversationHistory = rawHistory.filter(msg => msg.role !== 'error');
        
        // If we found and removed errors, update storage immediately
        if (conversationHistory.length !== rawHistory.length) {
            console.log(`[Chat] Sanitized ${rawHistory.length - conversationHistory.length} corrupted messages from history.`);
            saveHistory();
        }
        renderHistory(); 
    } 
    catch { conversationHistory = []; }
    if(conversationHistory.length===0) addMessageToState('system', 'Hello! I am your UNS Assistant.');
}

function saveHistory() { localStorage.setItem(storageKey, JSON.stringify(conversationHistory)); }

function addMessageToState(role, content, toolCalls=null) {
    const msg = { role, content, timestamp: Date.now(), tool_calls: toolCalls };
    conversationHistory.push(msg);
    if(conversationHistory.length>30) conversationHistory=conversationHistory.slice(-30);
    saveHistory(); appendMessageToUI(msg);
}

function renderHistory() { chatHistory.innerHTML=''; conversationHistory.forEach(appendMessageToUI); scrollToBottom(); }
function scrollToBottom() { chatHistory.scrollTop = chatHistory.scrollHeight; }

function appendMessageToUI(msg) {
    if (!chatHistory) return;
    const div = document.createElement('div');
    div.className = `chat-message ${msg.role}`;
    
    if (Array.isArray(msg.content)) {
        let htmlParts = '';
        msg.content.forEach(part => {
            if (part.type === 'text') htmlParts += formatMessageContent(part.text);
            else if (part.type === 'image_url') htmlParts += `<div class="chat-image-container"><img src="${part.image_url.url}" class="chat-image"></div>`;
        });
        div.innerHTML = htmlParts;
    } else {
        let htmlContent = formatMessageContent(msg.content || '');
        if (msg.tool_calls) {
            msg.tool_calls.forEach(t => htmlContent += `<div class="tool-usage">🔧 ${t.function.name}</div>`);
        }
        if (msg.role === 'tool') div.classList.add('system'), div.innerHTML = `<div class="tool-usage-header">Output (${msg.name}):</div><small>${htmlContent.substring(0,150)}...</small>`;
        else div.innerHTML = htmlContent;
    }

    if (msg.role === 'assistant' && msg.content && !Array.isArray(msg.content)) {
        const speakerBtn = document.createElement('button');
        speakerBtn.className = 'btn-message-speak';
        speakerBtn.innerHTML = '🔊';
        speakerBtn.onclick = () => speakText(msg.content);
        div.appendChild(speakerBtn);
    }
    chatHistory.appendChild(div);
    scrollToBottom();
}

function formatMessageContent(text) {
    if (!text) return '';
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
               .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
               .replace(/`([^`]+)`/g, '<code>$1</code>')
               .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
               .replace(/\n/g, '<br>');
}

// --- NEW PERSISTENT LOG UI ---
// Creates a new log container for the current process
function createLogDiv() {
    const div = document.createElement('div');
    div.className = 'chat-message system status-log';
    div.style.textAlign = 'left'; // Ensure text is aligned left for list
    div.style.fontSize = '0.85em';
    div.style.lineHeight = '1.5';
    chatHistory.appendChild(div);
    scrollToBottom();
    return div;
}

// Appends a line to the current log container
function appendToLog(container, text, type = 'info') {
    if (!container) return;
    const line = document.createElement('div');
    
    if (type === 'tool_start') {
        line.innerHTML = `<span class="typing-dot" style="width:6px;height:6px;margin-right:5px;display:inline-block;animation:typing-blink 1s infinite"></span> ${text}`;
    } else if (type === 'tool_result') {
        line.innerHTML = `✅ ${text}`;
        line.style.color = 'var(--color-success)';
    } else if (type === 'error') {
        line.innerHTML = `⚠️ ${text}`;
        line.style.color = 'var(--color-danger)';
    } else {
        // Default / Status
        line.innerHTML = `<small style="opacity:0.8">${text}</small>`;
    }
    
    container.appendChild(line);
    scrollToBottom();
}

// --- STREAMING SEND MESSAGE ---
async function sendMessage(fromVoice = false) {
    if (isProcessing) return;
    window.speechSynthesis.cancel();
    
    if (userWantMicActive || isListening) {
        userWantMicActive = false;
        if(recognition) recognition.stop();
    }

    const isVoice = fromVoice || wasLastInputVoice;
    wasLastInputVoice = false; 
    
    const text = chatInput.value.trim();
    if (!text && !pendingAttachment) return;

    let messageContent = text;
    if (pendingAttachment) {
        if (pendingAttachment.type === 'image') {
            messageContent = [{ type: "text", text: text }, { type: "image_url", image_url: { url: pendingAttachment.content } }];
        } else {
            messageContent = `${text}\n\n--- FILE: ${pendingAttachment.name} ---\n${pendingAttachment.content}`;
        }
    }

    chatInput.value = ''; autoResizeInput();
    pendingAttachment = null; renderPreview(); fileInput.value = '';
    
    addMessageToState('user', messageContent);
    isProcessing = true;
    hasToolActivity = false; // Reset tool flag
    
    btnSend.disabled = true; if(btnMic) btnMic.disabled = true; if(btnCam) btnCam.disabled = true;
    
    // [MODIFIED] Create a persistent log container for this interaction
    currentLogDiv = createLogDiv();

    const validHistory = conversationHistory.filter(m => m.role !== 'error');
    const messagesPayload = validHistory.map(m => {
        const apiMsg = { role: m.role, content: m.content };
        if (m.tool_calls) apiMsg.tool_calls = m.tool_calls;
        if (m.tool_call_id) apiMsg.tool_call_id = m.tool_call_id;
        if (m.name) apiMsg.name = m.name;
        return apiMsg;
    });

    try {
        const url = `${appBasePath}/api/chat/completion`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                messages: messagesPayload,
                userLanguage: navigator.language 
            })
        });

        if (!response.ok) throw new Error(`API Error: ${response.statusText}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let assistantMsg = null;
        let buffer = "";

        // Helper to process a line of NDJSON
        const processLine = (line) => {
            if (!line.trim()) return;
            try {
                const chunk = JSON.parse(line);
                if (chunk.type === 'status') {
                    // Append status update (Thinking..., Synthesizing...)
                    appendToLog(currentLogDiv, chunk.content);
                } else if (chunk.type === 'tool_start') {
                    // Append tool start
                    appendToLog(currentLogDiv, `Executing: ${chunk.content.name}...`, 'tool_start');
                    hasToolActivity = true;
                } else if (chunk.type === 'tool_result') {
                    // [MODIFIED] Append tool result with duration
                    const durationStr = chunk.content.duration ? `(${chunk.content.duration}ms)` : '';
                    appendToLog(currentLogDiv, `Completed: ${chunk.content.name} ${durationStr}`, 'tool_result');
                } else if (chunk.type === 'message') {
                    assistantMsg = chunk.content;
                } else if (chunk.type === 'error') {
                    throw new Error(chunk.content);
                }
            } catch (e) {
                if (e.message.startsWith('API Error') || e.message.startsWith('Error')) throw e;
                console.warn("Stream parse error:", e);
            }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (value) {
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // Keep partial line
                lines.forEach(processLine);
            }
            if (done) {
                if (buffer.trim()) processLine(buffer);
                break;
            }
        }

        // [MODIFIED] Do NOT remove the log div. It stays as history of the "thought process".
        currentLogDiv = null; // Detach reference for next message

        // Handle case where tools ran but no final message (e.g. backend summary failed)
        if (!assistantMsg && hasToolActivity) {
            assistantMsg = { role: 'assistant', content: "✅ Operation completed (No text summary provided)." };
        }

        if (assistantMsg) {
            // Check for file creation tool usage
            if (assistantMsg.tool_calls && onFileCreatedCallback) {
                const hasCreatedFile = assistantMsg.tool_calls.some(tool => tool.function.name === 'create_dynamic_view' || tool.function.name === 'save_file_to_data_directory');
                if (hasCreatedFile) setTimeout(() => onFileCreatedCallback(), 1000);
            }
            
            // OpenAI/Gemini might return null content if only tools were called in the final turn
            if (assistantMsg.content === null) {
                 assistantMsg.content = "✅ Operation completed.";
            }

            addMessageToState('assistant', assistantMsg.content, assistantMsg.tool_calls);
            trackEvent('chat_message_sent');
            if (isVoice && assistantMsg.content) {
                speakText(assistantMsg.content);
            }
        } else if (!hasToolActivity) {
            // No message and no tools? That's an error.
            throw new Error("Empty response from server.");
        }

    } catch (error) {
        console.error(error);
        if (currentLogDiv) {
             appendToLog(currentLogDiv, `Error: ${error.message}`, 'error');
             currentLogDiv = null;
        } else {
             addMessageToState('error', `Error: ${error.message}`);
        }
    } finally {
        isProcessing = false;
        btnSend.disabled = false; if(btnMic) btnMic.disabled = false; if(btnCam) btnCam.disabled = false;
        chatInput.focus();
    }
}