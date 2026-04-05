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
 * [UPDATED] Uses Proxy-based state manager to inject current UI context (topic/broker) into AI prompts.
 * [UPDATED] Integrated showToast system to replace native alerts for camera/mic issues.
 * [UPDATED] Implemented View Lifecycle Teardown (mount/unmount) to prevent memory leaks.
 * [UPDATED] Fixed Catch-22 where FAB listener was never bound by mounting globally on init.
 * [UPDATED] Implemented strict DOMPurify HTML sanitization to prevent XSS payloads from malicious models/messages.
 */
import { state } from './state.js';
import { trackEvent, confirmModal, showToast } from './utils.js';

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

// Session UI
let sessionMenuBtn = null;
let sessionOverlay = null;
let sessionListContainer = null;
let btnNewChat = null;

// Stop UI
let btnStop = null;

// --- State ---
let conversationHistory = [];
let isProcessing = false;
let isWidgetOpen = false;
let pendingAttachment = null;
let currentSessionId = 'default';
let isMounted = false;

// --- Storage & Path State ---
let appBasePath = ''; // Store base path for API calls

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
let currentLogDiv = null; 
let hasToolActivity = false; 
let pendingApproval = null; // Store pending approval chunk

// --- Deduplication Set ---
let processedChunkIds = new Set();

const onCurrentTopicChange = (topic) => {
    // We don't need to do anything specific here as sendMessage 
    // reads state.currentTopic directly, but having the subscription 
    // ensures the reactive loop is consistent.
};

// --- Safe HTML Sanitization Wrapper ---
const sanitizeHtml = (dirtyHtml) => {
    return window.DOMPurify ? window.DOMPurify.sanitize(dirtyHtml) : dirtyHtml.replace(/</g, "&lt;").replace(/>/g, "&gt;");
};

// --- Named Event Handlers ---
const onFabClick = () => toggleChatWidget(true);
const onMinimizeClick = () => toggleChatWidget(false);
const onSendClick = () => sendMessage(false);
const onStopClick = () => stopGeneration();
const onInputKeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(false);
    }
    autoResizeInput();
};
const onClearClick = async () => {
    const isConfirmed = await confirmModal('Delete Session', 'Are you sure you want to delete this chat session?', 'Delete', true);
    if (isConfirmed) {
        await deleteSession(currentSessionId);
        const remaining = await loadSessionsList();
        if (remaining.length > 0) {
            switchSession(remaining[0].id);
        } else {
            createNewSession();
        }
    }
};
const onFullscreenChange = () => {
    const fsElement = document.fullscreenElement;
    if (fsElement && fsElement !== document.body) {
        fsElement.appendChild(chatContainer);
        if (fabButton) fsElement.appendChild(fabButton);
        if (cameraModal) fsElement.appendChild(cameraModal);
    } else {
        document.body.appendChild(chatContainer);
        if (fabButton) document.body.appendChild(fabButton);
        if (cameraModal) document.body.appendChild(cameraModal);
    }
};

/**
 * Initializes the Chat View (Called once).
 */
export function initChatView(basePath, onFileCreated) {
    // 1. Store and normalize base path for API calls
    appBasePath = basePath || '';
    if (appBasePath === '/') appBasePath = '';
    if (appBasePath.endsWith('/')) appBasePath = appBasePath.slice(0, -1);

    if (onFileCreated) {
        onFileCreatedCallback = onFileCreated;
    }

    injectUploadUI();
    injectVoiceUI(); 
    injectCameraUI(); 
    injectSessionUI(); // Add Sidebar and Menu button
    injectStopButton(); // Add Stop button
    makeWidgetDraggableAndResizable(); // Add drag/resize capabilities

    // Load Sessions List first, then load latest
    loadSessionsList().then(sessions => {
        if (sessions && sessions.length > 0) {
            switchSession(sessions[0].id);
        } else {
            createNewSession();
        }
    });

    // Pre-load voices aggressively for Chrome/Safari
    if ('speechSynthesis' in window) {
        const loadVoices = () => {
            availableVoices = window.speechSynthesis.getVoices();
            console.log(`[TTS] Loaded ${availableVoices.length} voices.`);
        };
        loadVoices();
        // Chrome fires this when voices are ready
        window.speechSynthesis.onvoiceschanged = loadVoices;
    }

    // Mount the view immediately since the Chat is a global widget
    // This ensures the FAB (Floating Action Button) event listener is registered
    mountChatView();
}

/**
 * Mounts the view (attaches event listeners).
 */
export function mountChatView() {
    if (isMounted) return;
    
    fabButton?.addEventListener('click', onFabClick);
    btnMinimize?.addEventListener('click', onMinimizeClick);
    btnSend?.addEventListener('click', onSendClick);
    btnStop?.addEventListener('click', onStopClick);
    chatInput?.addEventListener('keydown', onInputKeydown);
    btnClear?.addEventListener('click', onClearClick);
    document.addEventListener('fullscreenchange', onFullscreenChange);

    // Subscriptions
    import('./state.js').then(m => m.subscribe('currentTopic', onCurrentTopicChange));

    isMounted = true;
    console.log("[Chat View] Mounted.");
}

/**
 * Unmounts the view (removes event listeners and cleans up APIs).
 */
export function unmountChatView() {
    if (!isMounted) return;

    fabButton?.removeEventListener('click', onFabClick);
    btnMinimize?.removeEventListener('click', onMinimizeClick);
    btnSend?.removeEventListener('click', onSendClick);
    btnStop?.removeEventListener('click', onStopClick);
    chatInput?.removeEventListener('keydown', onInputKeydown);
    btnClear?.removeEventListener('click', onClearClick);
    document.removeEventListener('fullscreenchange', onFullscreenChange);

    // Subscriptions
    import('./state.js').then(m => m.unsubscribe('currentTopic', onCurrentTopicChange));

    // Stop active speech recognition or synthesis
    if (recognition && isListening) {
        userWantMicActive = false;
        try { recognition.stop(); } catch(e){}
    }
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
    }
    closeCamera(); // Ensure camera is released

    isMounted = false;
    console.log("[Chat View] Unmounted & Cleaned up.");
}

/**
 * Handles incoming stream chunks from WebSocket (via app.js).
 * Uses processedChunkIds to prevent duplication with HTTP stream.
 */
export function onChatStreamMessage(message) {
    if (!message || !message.id) return;

    // Deduplication check
    if (processedChunkIds.has(message.id)) {
        return; 
    }
    processedChunkIds.add(message.id);

    // Create log div if missing
    if (!currentLogDiv && isProcessing) {
        currentLogDiv = createLogDiv();
    }

    // Reuse the same logic as HTTP streaming
    processStreamChunk(message.chunkType, message.content);
}

function autoResizeInput() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 100) + 'px';
}

// --- Session Management UI Injection ---
function injectSessionUI() {
    const header = document.querySelector('.chat-header');
    if (!header) return;

    // 1. Menu Button
    sessionMenuBtn = document.createElement('button');
    sessionMenuBtn.innerHTML = '☰';
    sessionMenuBtn.title = "Chat History";
    sessionMenuBtn.style.marginRight = '10px';
    sessionMenuBtn.onclick = toggleSessionOverlay;

    // Insert before title
    header.insertBefore(sessionMenuBtn, header.firstChild);

    // 2. Session Overlay (Drawer)
    sessionOverlay = document.createElement('div');
    sessionOverlay.className = 'chat-session-overlay';
    sessionOverlay.style.cssText = `
        position: absolute; top: 0; left: 0; width: 250px; height: 100%;
        background: var(--color-bg-secondary); border-right: 1px solid var(--color-border);
        z-index: 100; transform: translateX(-100%); transition: transform 0.3s ease;
        display: flex; flex-direction: column; padding: 10px; box-sizing: border-box;
    `;

    const overlayHeader = document.createElement('div');
    overlayHeader.style.cssText = "display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; border-bottom:1px solid var(--color-border); padding-bottom:5px;";
    overlayHeader.innerHTML = `<strong>History</strong><button id="btn-close-sessions" style="background:none; border:none; cursor:pointer;">✕</button>`;

    btnNewChat = document.createElement('button');
    btnNewChat.textContent = "+ New Chat";
    btnNewChat.className = "tool-button"; 
    btnNewChat.style.width = "100%";
    btnNewChat.style.marginBottom = "10px";
    btnNewChat.onclick = createNewSession;

    sessionListContainer = document.createElement('div');
    sessionListContainer.style.cssText = "flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:5px;";

    sessionOverlay.appendChild(overlayHeader);
    sessionOverlay.appendChild(btnNewChat);
    sessionOverlay.appendChild(sessionListContainer);

    // Append to widget
    document.querySelector('.chat-widget-container').appendChild(sessionOverlay);

    sessionOverlay.querySelector('#btn-close-sessions').onclick = toggleSessionOverlay;
}

function injectStopButton() {
    const inputArea = document.querySelector('.chat-input-area');
    btnStop = document.createElement('button');
    btnStop.id = 'btn-chat-stop';
    btnStop.innerHTML = '⏹';
    btnStop.className = 'chat-icon-btn';
    btnStop.style.display = 'none'; 
    btnStop.style.color = 'var(--color-danger)';
    btnStop.title = "Stop Generating";
    inputArea.insertBefore(btnStop, btnSend);
}

function toggleSessionOverlay() {
    const isOpen = sessionOverlay.style.transform === 'translateX(0%)';
    sessionOverlay.style.transform = isOpen ? 'translateX(-100%)' : 'translateX(0%)';
    if (!isOpen) loadSessionsList(); 
}

async function loadSessionsList() {
    try {
        const res = await fetch(`${appBasePath}/api/chat/sessions`);
        if (!res.ok) throw new Error("Failed to load sessions");
        const sessions = await res.json();
        renderSessionList(sessions);
        return sessions;
    } catch (e) {
        console.error(e);
        return [];
    }
}

function renderSessionList(sessions) {
    sessionListContainer.innerHTML = '';
    if (sessions.length === 0) {
        sessionListContainer.innerHTML = '<div style="color:var(--color-text-secondary); font-style:italic; padding:10px;">No history</div>';
        return;
    }

    sessions.forEach(session => {
        const div = document.createElement('div');
        div.className = 'session-item';
        div.style.cssText = `
            display: flex; justify-content: space-between; align-items: center;
            padding: 8px; cursor: pointer; border-radius: 4px;
            background: ${session.id === currentSessionId ? 'var(--color-bg-accent)' : 'transparent'};
            border: 1px solid ${session.id === currentSessionId ? 'var(--color-primary)' : 'transparent'};
            font-size: 0.9em;
        `;
        
        const titleSpan = document.createElement('span');
        titleSpan.style.cssText = "white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-grow: 1;";
        titleSpan.textContent = session.title || "Untitled Chat";
        titleSpan.onclick = () => switchSession(session.id);
        
        const delBtn = document.createElement('button');
        delBtn.innerHTML = '🗑️';
        delBtn.title = "Delete Chat";
        delBtn.style.cssText = "background: none; border: none; cursor: pointer; font-size: 1.1em; opacity: 0.6; padding: 0 4px; flex-shrink: 0;";
        delBtn.onmouseover = () => delBtn.style.opacity = '1';
        delBtn.onmouseout = () => delBtn.style.opacity = '0.6';
        delBtn.onclick = async (e) => {
            e.stopPropagation();
            const isConfirmed = await confirmModal('Delete Session', 'Are you sure you want to delete this chat session?', 'Delete', true);
            if (isConfirmed) {
                await deleteSession(session.id);
                const remaining = await loadSessionsList();
                if (currentSessionId === session.id) {
                    if (remaining.length > 0) switchSession(remaining[0].id);
                    else createNewSession();
                }
            }
        };
        
        div.appendChild(titleSpan);
        div.appendChild(delBtn);
        sessionListContainer.appendChild(div);
    });
}

async function switchSession(id) {
    if (id === currentSessionId) {
        toggleSessionOverlay(); 
        return;
    }
    currentSessionId = id;
    loadHistory(); 
    toggleSessionOverlay();
}

async function createNewSession() {
    const newId = `chat_${Date.now()}`;
    currentSessionId = newId;
    conversationHistory = [];
    chatHistory.innerHTML = '';
    addMessageToState('assistant', 'Hello! I am your UNS Assistant. How can I help?');
    toggleSessionOverlay(); 
}

async function deleteSession(id) {
    try {
        await fetch(`${appBasePath}/api/chat/session/${id}`, { method: 'DELETE' });
    } catch (e) {
        showToast("Failed to delete session", "error");
    }
}

function stopGeneration() {
    if (!isProcessing) return;
    fetch(`${appBasePath}/api/chat/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: window.wsClientId })
    }).catch(console.error);

    if (currentLogDiv) {
        appendToLog(currentLogDiv, "⛔ Stopped by user.", 'error');
    }
    isProcessing = false;
    updateUIState(false);
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
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        showToast("Camera requires HTTPS or localhost.", "warning");
        return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return showToast("Camera not supported", "error");
    }

    try {
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        cameraVideo.srcObject = cameraStream;
        cameraModal.style.display = 'flex';

        if (userWantMicActive) {
            userWantMicActive = false;
            recognition?.stop();
        }
    } catch (err) { showToast("Camera error: " + err.message, "error"); }
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
            try { recognition.start(); } catch(e) {}
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
            showToast("Voice input requires HTTPS security.", "warning");
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
    currentUtterance.rate = 1.0; 

    if (availableVoices.length === 0) {
        availableVoices = window.speechSynthesis.getVoices();
    }

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

    // Insert logic
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
    previewContainer.innerHTML = `<div class="preview-item"><img src="${pendingAttachment.type==='image'?sanitizeHtml(pendingAttachment.content):''}">${pendingAttachment.type==='image'?'':`<div class="file-icon">📄</div>`}<span class="file-name">${sanitizeHtml(pendingAttachment.name)}</span><button class="btn-remove-attachment">×</button></div>`;
    previewContainer.querySelector('.btn-remove-attachment').onclick = () => { pendingAttachment=null; fileInput.value=''; renderPreview(); };
}

export function toggleChatWidget(show) {
    isWidgetOpen = show;
    chatContainer.classList.toggle('active', show);
    fabButton.style.display = show ? 'none' : 'flex';
    if(show) {
        // Mount logic (if called from external button)
        if (!isMounted) mountChatView();
        setTimeout(() => { scrollToBottom(); chatInput.focus(); }, 300);
    }
}

// --- History Persistence ---
async function loadHistory() {
    try {
        const res = await fetch(`${appBasePath}/api/chat/session/${currentSessionId}`);
        if (res.ok) {
            let serverHistory = await res.json();
            conversationHistory = serverHistory.filter(msg => msg.role !== 'error');
            renderHistory();
        } else {
            conversationHistory = [];
        }
    } catch (e) {
        console.error("Error loading chat history:", e);
        conversationHistory = [];
    }

    if (conversationHistory.length === 0) {
        addMessageToState('assistant', 'Hello! I am your UNS Assistant. How can I help?');
    }
}

async function saveHistory() {
    try {
        await fetch(`${appBasePath}/api/chat/session/${currentSessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(conversationHistory)
        });
    } catch (e) {
        console.error("Failed to sync chat history to server:", e);
    }
}

function addMessageToState(role, content, toolCalls=null, toolCallId=null, name=null) {
    const msg = { role, content, timestamp: Date.now() };
    if (toolCalls) msg.tool_calls = toolCalls;
    if (toolCallId) msg.tool_call_id = toolCallId;
    if (name) msg.name = name;
    
    conversationHistory.push(msg);
    if(conversationHistory.length > 50) conversationHistory = conversationHistory.slice(-50);
    saveHistory(); 
    appendMessageToUI(msg);
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
            else if (part.type === 'image_url') htmlParts += `<div class="chat-image-container"><img src="${sanitizeHtml(part.image_url.url)}" class="chat-image"></div>`;
        });
        div.innerHTML = sanitizeHtml(htmlParts);
    } else {
        let htmlContent = formatMessageContent(msg.content || '');

        if (msg.tool_calls) {
            msg.tool_calls.forEach(t => htmlContent += `<div class="tool-usage">🔧 ${sanitizeHtml(t.function.name)}</div>`);
        }

        if (msg.role === 'tool') {
            div.classList.add('system');
            div.innerHTML = sanitizeHtml(`<div class="tool-usage-header">Output (${msg.name}):</div><small>${htmlContent.substring(0,150)}...</small>`);
        } else {
            div.innerHTML = sanitizeHtml(htmlContent);
        }
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
    let rawHtml = '';
    if (window.marked) {
        try {
            rawHtml = window.marked.parse(text);
        } catch (e) {
            console.warn("Markdown parsing failed, falling back to basic formatting.", e);
            rawHtml = basicFormat(text);
        }
    } else {
        rawHtml = basicFormat(text);
    }
    return rawHtml;
}

function basicFormat(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
               .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
               .replace(/`([^`]+)`/g, '<code>$1</code>')
               .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
               .replace(/\n/g, '<br>');
}

// --- PERSISTENT LOG UI ---
function createLogDiv() {
    const div = document.createElement('div');
    div.className = 'chat-message system status-log';
    div.style.textAlign = 'left'; 
    div.style.fontSize = '0.85em';
    div.style.lineHeight = '1.5';
    chatHistory.appendChild(div);
    scrollToBottom();
    return div;
}

function appendToLog(container, text, type = 'info') {
    if (!container) return;

    const line = document.createElement('div');
    const safeText = sanitizeHtml(text);

    // Legacy Deduplication (Keep it for safety)
    if (container.lastChild && container.lastChild.textContent.includes(text)) {
        return;
    }

    if (type === 'tool_start') {
        line.innerHTML = `<span class="typing-dot" style="width:6px;height:6px;margin-right:5px;display:inline-block;animation:typing-blink 1s infinite"></span> ${safeText}`;
    } else if (type === 'tool_result') {
        line.innerHTML = `✅ ${safeText}`;
        line.style.color = 'var(--color-success)';
    } else if (type === 'error') {
        line.innerHTML = `⚠️ ${safeText}`;
        line.style.color = 'var(--color-danger)';
    } else {
        line.innerHTML = `<small style="opacity:0.8">${safeText}</small>`;
    }

    container.appendChild(line);
    scrollToBottom();
}

// --- SHARED CHUNK PROCESSOR (HTTP & WS) ---
let assistantMsgFromStream = null;

function processStreamChunk(type, content) {
    if (!currentLogDiv && type !== 'message' && type !== 'error' && type !== 'approval_required') {
        // If we missed the start, create log div now
        currentLogDiv = createLogDiv();
    }

    if (type === 'status') {
        appendToLog(currentLogDiv, content);
    } else if (type === 'tool_start') {
        appendToLog(currentLogDiv, `Executing: ${content.name}...`, 'tool_start');
        hasToolActivity = true;
    } else if (type === 'tool_result') {
        const durationStr = content.duration ? `(${content.duration}ms)` : '';
        appendToLog(currentLogDiv, `Completed: ${content.name} ${durationStr}`, 'tool_result');
    } else if (type === 'message') {
        assistantMsgFromStream = content;
    } else if (type === 'error') {
        // Handle stopping/error gracefully in UI
        if (currentLogDiv) appendToLog(currentLogDiv, content, 'error');
        throw new Error(content);
    } else if (type === 'approval_required') {
        pendingApproval = content;
    }
}

function renderApprovalUI(approvalData) {
    const div = document.createElement('div');
    div.className = `chat-message system`;
    div.style.borderLeft = '3px solid var(--color-warning)';
    div.style.background = 'color-mix(in srgb, var(--color-warning) 10%, transparent)';
    
    let html = `<div style="font-weight:bold; margin-bottom:5px;">⚠️ Approval Required</div>`;
    html += `<div style="font-size:0.9em; margin-bottom:10px;">The AI wants to perform potentially destructive actions:</div>`;
    
    approvalData.toolCalls.forEach(tc => {
        html += `<div style="font-family:monospace; font-size:0.85em; background:var(--color-bg-secondary); padding:5px; border-radius:4px; margin-bottom:5px;">
            > ${sanitizeHtml(tc.function.name)}(...)
        </div>`;
    });

    html += `<div style="display:flex; gap:5px; margin-top:10px; flex-wrap:wrap;">
        <button class="tool-button button-primary btn-approve-once" style="flex:1;">Approve Once</button>
        <button class="tool-button btn-approve-session" style="flex:1;">Approve for Session</button>
        <button class="tool-button button-danger btn-deny" style="flex:1;">Deny</button>
    </div>`;

    div.innerHTML = sanitizeHtml(html); // Ensure overall DOM is clean
    chatHistory.appendChild(div);
    scrollToBottom();

    div.querySelector('.btn-approve-once').onclick = () => {
        window.approvedToolCallIds = approvalData.toolCalls.map(tc => tc.id);
        div.style.opacity = '0.5';
        div.style.pointerEvents = 'none';
        sendMessage(false, true); // Resume
    };

    div.querySelector('.btn-approve-session').onclick = () => {
        window.autoApproveSession = true;
        div.style.opacity = '0.5';
        div.style.pointerEvents = 'none';
        sendMessage(false, true); // Resume
    };

    div.querySelector('.btn-deny').onclick = () => {
        approvalData.toolCalls.forEach(tc => {
            addMessageToState('tool', "User denied execution.", null, tc.id, tc.function.name);
        });
        div.style.opacity = '0.5';
        div.style.pointerEvents = 'none';
        sendMessage(false, true); // Resume with denial responses
    };
}

function updateUIState(processing) {
    btnSend.disabled = processing;
    btnStop.style.display = processing ? 'flex' : 'none';
    btnSend.style.display = processing ? 'none' : 'flex'; 
    if (btnMic) btnMic.disabled = processing;
    if (btnCam) btnCam.disabled = processing;

    if (!processing) chatInput.focus();
}

// --- STREAMING SEND MESSAGE ---
async function sendMessage(fromVoice = false, isResuming = false) {
    if (isProcessing) return;

    window.speechSynthesis.cancel();
    if (userWantMicActive || isListening) {
        userWantMicActive = false;
        if(recognition) recognition.stop();
    }

    const isVoice = fromVoice || wasLastInputVoice;
    wasLastInputVoice = false; 

    // If not resuming, it's a fresh user message
    if (!isResuming) {
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
        
        // --- REACTIVE CONTEXT INJECTION ---
        // Secretly provide the AI with the exact topic the user is looking at
        if (state.currentTopic) {
            const contextBlurb = `\n\n[SYSTEM CONTEXT: The user is currently inspecting the topic '${state.currentTopic}' on broker '${state.currentBrokerId}'. Use this if they refer to "this" or "here".]`;
            if (typeof messageContent === 'string') {
                messageContent += contextBlurb;
            } else if (Array.isArray(messageContent) && messageContent[0] && messageContent[0].type === 'text') {
                messageContent[0].text += contextBlurb;
            }
        }

        chatInput.value = ''; autoResizeInput();
        pendingAttachment = null; renderPreview(); fileInput.value = '';

        addMessageToState('user', messageContent);
    }

    isProcessing = true;
    hasToolActivity = false; 
    assistantMsgFromStream = null; 
    pendingApproval = null;
    processedChunkIds.clear(); 

    updateUIState(true); 
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
        const requestBody = { 
            messages: messagesPayload,
            userLanguage: navigator.language,
            clientId: window.wsClientId || null,
            autoApproveSession: window.autoApproveSession || false,
            approvedToolCallIds: window.approvedToolCallIds || []
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        // Reset single-use approvals
        window.approvedToolCallIds = [];

        if (!response.ok) throw new Error(`API Error: ${response.statusText}`);

        // Read the HTTP stream (NDJSON)
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (value) {
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); 

                for (const line of lines) {
                    if (line.trim()) {
                        try {
                            const chunk = JSON.parse(line);
                            // Check ID before processing
                            if (chunk.id && !processedChunkIds.has(chunk.id)) {
                                processedChunkIds.add(chunk.id);
                                processStreamChunk(chunk.type, chunk.content);
                            }
                        } catch (e) { console.warn("Stream parse error:", e); }
                    }
                }
            }
            if (done) break;
        }

        currentLogDiv = null; 

        // Handle final state
        if (!assistantMsgFromStream && hasToolActivity) {
            assistantMsgFromStream = { role: 'assistant', content: "✅ Operation completed (No text summary provided)." };
        }

        if (assistantMsgFromStream) {
            if (assistantMsgFromStream.tool_calls && onFileCreatedCallback) {
                const hasCreatedFile = assistantMsgFromStream.tool_calls.some(tool => tool.function.name === 'create_dynamic_view' || tool.function.name === 'save_file_to_data_directory');
                if (hasCreatedFile) setTimeout(() => onFileCreatedCallback(), 1000);
            }
            if (assistantMsgFromStream.content === null) {
                 assistantMsgFromStream.content = "✅ Operation completed.";
            }

            addMessageToState('assistant', assistantMsgFromStream.content, assistantMsgFromStream.tool_calls);
            trackEvent('chat_message_sent');

            if (isVoice && assistantMsgFromStream.content) {
                speakText(assistantMsgFromStream.content);
            }
            
            if (pendingApproval) {
                renderApprovalUI(pendingApproval);
            }
        } 

    } catch (error) {
        console.error(error);
        if (currentLogDiv) {
             appendToLog(currentLogDiv, `Error: ${error.message}`, 'error');
             currentLogDiv = null;
        } else {
             // Only add error bubble if not already logged in stream
             addMessageToState('error', `Error: ${error.message}`);
        }
    } finally {
        isProcessing = false;
        updateUIState(false);
    }
}

/**
 * Make the Chat Widget Draggable and Resizable from all 4 corners
 */
function makeWidgetDraggableAndResizable() {
    const header = document.querySelector('.chat-header');
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    const switchToAbsolute = () => {
        if (chatContainer.style.bottom || !chatContainer.style.top) {
            const rect = chatContainer.getBoundingClientRect();
            chatContainer.style.bottom = 'auto';
            chatContainer.style.right = 'auto';
            chatContainer.style.left = rect.left + 'px';
            chatContainer.style.top = rect.top + 'px';
        }
    };

    // Dragging
    header.addEventListener('mousedown', (e) => {
        if (e.target.closest && e.target.closest('button')) return; // Do not drag if clicking buttons
        isDragging = true;
        switchToAbsolute();
        
        // keep opacity transition, disable transform to avoid conflicts
        chatContainer.style.transition = 'opacity 0.3s ease'; 
        
        startX = e.clientX;
        startY = e.clientY;
        initialLeft = chatContainer.offsetLeft;
        initialTop = chatContainer.offsetTop;

        document.addEventListener('mousemove', onDrag);
        document.addEventListener('mouseup', stopDrag);
    });

    function onDrag(e) {
        if (!isDragging) return;
        e.preventDefault(); // Prevent text selection
        
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        
        let newLeft = initialLeft + dx;
        let newTop = initialTop + dy;
        
        // Boundaries to keep it on screen
        const maxX = window.innerWidth - chatContainer.offsetWidth;
        const maxY = window.innerHeight - chatContainer.offsetHeight;
        
        newLeft = Math.max(0, Math.min(newLeft, maxX));
        newTop = Math.max(0, Math.min(newTop, maxY));
        
        chatContainer.style.left = newLeft + 'px';
        chatContainer.style.top = newTop + 'px';
    }

    function stopDrag() {
        isDragging = false;
        document.removeEventListener('mousemove', onDrag);
        document.removeEventListener('mouseup', stopDrag);
        // Restore transitions (transform uses scale now)
        chatContainer.style.transition = 'transform 0.3s cubic-bezier(0.4, 0.0, 0.2, 1), opacity 0.3s ease';
    }

    // Resizing
    const positions = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    positions.forEach(pos => {
        const handle = document.createElement('div');
        handle.className = `chat-resize-handle chat-resize-${pos}`;
        chatContainer.appendChild(handle);

        handle.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            switchToAbsolute();
            chatContainer.style.transition = 'opacity 0.3s ease';
            
            const startX = e.clientX;
            const startY = e.clientY;
            const startWidth = chatContainer.offsetWidth;
            const startHeight = chatContainer.offsetHeight;
            const startLeft = chatContainer.offsetLeft;
            const startTop = chatContainer.offsetTop;

            function doResize(moveEvent) {
                moveEvent.preventDefault();
                const dx = moveEvent.clientX - startX;
                const dy = moveEvent.clientY - startY;

                let newWidth = startWidth;
                let newHeight = startHeight;
                let newLeft = startLeft;
                let newTop = startTop;

                if (pos.includes('e')) newWidth = startWidth + dx;
                if (pos.includes('w')) {
                    newWidth = startWidth - dx;
                    newLeft = startLeft + dx;
                }
                if (pos.includes('s')) newHeight = startHeight + dy;
                if (pos.includes('n')) {
                    newHeight = startHeight - dy;
                    newTop = startTop + dy;
                }

                // Apply constraints (min 300x400)
                if (newWidth >= 300) {
                    chatContainer.style.width = newWidth + 'px';
                    if (pos.includes('w')) chatContainer.style.left = newLeft + 'px';
                }
                if (newHeight >= 400) {
                    chatContainer.style.height = newHeight + 'px';
                    if (pos.includes('n')) chatContainer.style.top = newTop + 'px';
                }
            }

            function stopResize() {
                document.removeEventListener('mousemove', doResize);
                document.removeEventListener('mouseup', stopResize);
                chatContainer.style.transition = 'transform 0.3s cubic-bezier(0.4, 0.0, 0.2, 1), opacity 0.3s ease';
            }

            document.addEventListener('mousemove', doResize);
            document.addEventListener('mouseup', stopResize);
        });
    });
}