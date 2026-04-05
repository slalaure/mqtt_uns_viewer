/**
 * @license Apache License, Version 2.0 (the "License")
 */

import { state, subscribe, unsubscribe } from '../state.js';
import { trackEvent, confirmModal, showToast } from '../utils.js';
import './chat-session-list.js';

/**
 * AI Chat Assistant Web Component.
 * Encapsulates the entire floating chat widget, including sessions, 
 * streaming, file uploads, and voice/camera integration.
 */
class AiChatWidget extends HTMLElement {
    constructor() {
        super();
        this.isWidgetOpen = false;
        this.isMounted = false;
        this.isProcessing = false;
        this.currentSessionId = 'default';
        this.conversationHistory = [];
        this.appBasePath = '';
        
        // Voice & TTS State
        this.recognition = null;
        this.isListening = false;
        this.finalTranscript = '';
        this.userWantMicActive = false;
        this.availableVoices = [];
        this.currentUtterance = null;
        
        // Camera State
        this.cameraStream = null;
        this.pendingAttachment = null;

        // Streaming UI State
        this.currentLogDiv = null;
        this.processedChunkIds = new Set();
    }

    connectedCallback() {
        if (this.isMounted) return;
        this.render();
        this.setupEventListeners();
        this.initVoice();
        this.initTTS();
        this.isMounted = true;
    }

    init(basePath) {
        this.appBasePath = basePath || '';
        if (this.appBasePath === '/') this.appBasePath = '';
        if (this.appBasePath.endsWith('/')) this.appBasePath = this.appBasePath.slice(0, -1);
        
        const sessionList = this.querySelector('chat-session-list');
        if (sessionList) {
            sessionList.init(this.appBasePath, this.currentSessionId, {
                onSwitch: (id) => this.switchSession(id),
                onDelete: (id) => this.deleteSession(id),
                onNewChat: () => this.createNewSession()
            });
        }
        
        this.loadSessions();
    }

    render() {
        this.innerHTML = `
            <div id="chat-widget-container" class="chat-widget-container">
                <chat-session-list></chat-session-list>
                <div class="chat-header" id="chat-header">
                    <span>AI Assistant</span>
                    <div class="chat-controls">
                        <button id="btn-chat-sessions" title="History">🕒</button>
                        <button id="btn-chat-clear" title="Delete Session">🗑️</button>
                        <button id="btn-chat-minimize" title="Minimize">_</button>
                    </div>
                </div>
                <div class="chat-body">
                    <div id="chat-history" class="chat-history-container">
                        <div class="chat-message assistant">
                            Hello! I am your UNS Assistant. How can I help?
                        </div>
                    </div>
                    
                    <div id="chat-file-preview" style="display:none; padding:10px; background:var(--color-bg-accent); border-top:1px solid var(--color-border); align-items:center; gap:10px;"></div>

                    <div class="chat-input-area">
                        <button id="btn-chat-attach" class="chat-icon-btn" title="Attach File">📎</button>
                        <button id="btn-chat-cam" class="chat-icon-btn" title="Camera">📷</button>
                        <button id="btn-chat-mic" class="chat-icon-btn" title="Voice Input">🎤</button>
                        <textarea id="chat-input" rows="1" placeholder="Ask..."></textarea>
                        <button id="btn-send-chat">➤</button>
                        <button id="btn-stop-chat" style="display:none;" class="chat-icon-btn" title="Stop">🛑</button>
                    </div>
                </div>
                
                <!-- Resize Handles -->
                <div class="chat-resize-handle chat-resize-nw"></div>
                <div class="chat-resize-handle chat-resize-n"></div>
                <div class="chat-resize-handle chat-resize-ne"></div>
                <div class="chat-resize-handle chat-resize-e"></div>
                <div class="chat-resize-handle chat-resize-se"></div>
                <div class="chat-resize-handle chat-resize-s"></div>
                <div class="chat-resize-handle chat-resize-sw"></div>
                <div class="chat-resize-handle chat-resize-w"></div>
            </div>

            <button id="btn-chat-fab" class="chat-fab" title="Open AI Assistant">💬</button>

            <input type="file" id="chat-file-input" style="display:none;" accept="image/*,.pdf,.txt,.json,.csv,.js">

            <div id="chat-camera-modal" class="chat-camera-modal" style="display:none;">
                <div class="camera-content">
                    <video id="chat-camera-feed" autoplay playsinline></video>
                    <div class="camera-controls">
                        <button class="camera-btn-cancel" id="btn-cam-cancel">Cancel</button>
                        <button class="camera-btn-capture" id="btn-cam-capture" title="Take Photo"></button>
                    </div>
                </div>
            </div>
        `;
    }

    setupEventListeners() {
        const fab = this.querySelector('#btn-chat-fab');
        const minimize = this.querySelector('#btn-chat-minimize');
        const send = this.querySelector('#btn-send-chat');
        const stop = this.querySelector('#btn-stop-chat');
        const input = this.querySelector('#chat-input');
        const clear = this.querySelector('#btn-chat-clear');
        const sessionsBtn = this.querySelector('#btn-chat-sessions');
        const attachBtn = this.querySelector('#btn-chat-attach');
        const fileInput = this.querySelector('#chat-file-input');
        const camBtn = this.querySelector('#btn-chat-cam');
        const micBtn = this.querySelector('#btn-chat-mic');
        const camCancel = this.querySelector('#btn-cam-cancel');
        const camCapture = this.querySelector('#btn-cam-capture');
        
        fab?.addEventListener('click', () => this.toggleWidget(true));
        minimize?.addEventListener('click', () => this.toggleWidget(false));
        send?.addEventListener('click', () => this.sendMessage());
        stop?.addEventListener('click', () => this.stopGeneration());
        
        input?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
            this.autoResizeInput();
        });

        clear?.addEventListener('click', () => this.onClearClick());
        sessionsBtn?.addEventListener('click', () => this.toggleSessions(true));
        attachBtn?.addEventListener('click', () => fileInput.click());
        fileInput?.addEventListener('change', (e) => this.handleFileSelect(e));
        camBtn?.addEventListener('click', () => this.openCamera());
        micBtn?.addEventListener('click', () => this.toggleMic());
        camCancel?.addEventListener('click', () => this.closeCamera());
        camCapture?.addEventListener('click', () => this.capturePhoto());

        this.makeDraggable();
        this.makeResizable();
    }

    // --- State Management ---
    async loadSessions() {
        const sessionList = this.querySelector('chat-session-list');
        if (sessionList) await sessionList.loadSessions();
        
        try {
            const res = await fetch(`${this.appBasePath}/api/chat/sessions`);
            const sessions = await res.json();
            if (sessions.length > 0) this.switchSession(sessions[0].id);
            else this.createNewSession();
        } catch (e) { console.error(e); }
    }

    async switchSession(id) {
        this.currentSessionId = id;
        this.processedChunkIds.clear();
        this.querySelector('#chat-history').innerHTML = '';
        
        try {
            const res = await fetch(`${this.appBasePath}/api/chat/session/${id}`);
            const session = await res.json();
            this.conversationHistory = session.messages || [];
            if (this.conversationHistory.length === 0) {
                this.appendMessageToUI({ role: 'assistant', content: 'Hello! I am your UNS Assistant. How can I help?' });
            } else {
                this.conversationHistory.forEach(msg => this.appendMessageToUI(msg));
            }
            this.scrollToBottom();
            this.toggleSessions(false);
            const sessionList = this.querySelector('chat-session-list');
            if (sessionList) sessionList.currentSessionId = id;
        } catch (e) { console.error(e); }
    }

    async createNewSession() {
        this.currentSessionId = `chat_${Date.now()}`;
        this.conversationHistory = [];
        this.querySelector('#chat-history').innerHTML = '';
        this.appendMessageToUI({ role: 'assistant', content: 'Hello! I am your UNS Assistant. How can I help?' });
        const sessionList = this.querySelector('chat-session-list');
        if (sessionList) {
            sessionList.currentSessionId = this.currentSessionId;
            sessionList.loadSessions();
        }
    }

    async deleteSession(id) {
        try {
            await fetch(`${this.appBasePath}/api/chat/session/${id}`, { method: 'DELETE' });
            if (this.currentSessionId === id) this.loadSessions();
            else this.querySelector('chat-session-list')?.loadSessions();
        } catch (e) { console.error(e); }
    }

    // --- UI Actions ---
    toggleWidget(open) {
        this.isWidgetOpen = open;
        const container = this.querySelector('#chat-widget-container');
        const fab = this.querySelector('#btn-chat-fab');
        
        if (open) {
            container.classList.add('active');
            fab.style.display = 'none';
            this.querySelector('#chat-input')?.focus();
            setTimeout(() => this.scrollToBottom(), 300);
            trackEvent('chat_open');
        } else {
            container.classList.remove('active');
            fab.style.display = 'flex';
        }
    }

    toggleSessions(open) {
        this.querySelector('chat-session-list')?.toggle(open);
    }

    autoResizeInput() {
        const input = this.querySelector('#chat-input');
        input.style.height = 'auto';
        input.style.height = (input.scrollHeight) + 'px';
    }

    scrollToBottom() {
        const history = this.querySelector('#chat-history');
        history.scrollTop = history.scrollHeight;
    }

    async onClearClick() {
        const confirmed = await confirmModal('Delete Session', 'Permanently delete this chat session?', 'Delete', true);
        if (confirmed) this.deleteSession(this.currentSessionId);
    }

    // --- Core Logic: Send Message ---
    async sendMessage() {
        if (this.isProcessing) return;
        const input = this.querySelector('#chat-input');
        const text = input.value.trim();
        if (!text && !this.pendingAttachment) return;

        this.isProcessing = true;
        this.updateProcessingUI(true);

        const userMsg = { role: 'user', content: text };
        if (this.pendingAttachment) {
            userMsg.content = [
                { type: 'text', text: text || 'Analyze this.' },
                { type: this.pendingAttachment.type === 'image' ? 'image_url' : 'file', 
                  [this.pendingAttachment.type === 'image' ? 'image_url' : 'file']: { 
                      url: this.pendingAttachment.content,
                      name: this.pendingAttachment.name
                  }
                }
            ];
            this.pendingAttachment = null;
            this.renderFilePreview();
        }

        this.conversationHistory.push(userMsg);
        this.appendMessageToUI(userMsg);
        input.value = '';
        this.autoResizeInput();
        this.scrollToBottom();

        try {
            const payload = {
                sessionId: this.currentSessionId,
                messages: this.conversationHistory,
                context: {
                    currentTopic: state.currentTopic,
                    currentSourceId: state.currentSourceId
                }
            };
            
            window.dispatchEvent(new CustomEvent('send-chat-message', { detail: payload }));
            
        } catch (e) {
            this.appendMessageToUI({ role: 'assistant', content: '⚠️ Error sending message: ' + e.message, type: 'error' });
            this.isProcessing = false;
            this.updateProcessingUI(false);
        }
    }

    stopGeneration() {
        window.dispatchEvent(new CustomEvent('stop-chat-generation', { detail: { sessionId: this.currentSessionId } }));
        this.isProcessing = false;
        this.updateProcessingUI(false);
    }

    updateProcessingUI(processing) {
        const btnSend = this.querySelector('#btn-send-chat');
        const btnStop = this.querySelector('#btn-stop-chat');
        const input = this.querySelector('#chat-input');

        if (processing) {
            btnSend.style.display = 'none';
            btnStop.style.display = 'flex';
            input.placeholder = 'AI is thinking...';
            this.showTypingIndicator();
        } else {
            btnSend.style.display = 'flex';
            btnStop.style.display = 'none';
            input.placeholder = 'Ask...';
            this.removeTypingIndicator();
        }
    }

    // --- Streaming Updates ---
    onStreamMessage(data) {
        if (data.sessionId !== this.currentSessionId) return;

        if (data.type === 'start') {
            this.removeTypingIndicator();
            this.currentLogDiv = this.createLogContainer();
        } else if (data.type === 'chunk') {
            if (this.processedChunkIds.has(data.chunkId)) return;
            this.processedChunkIds.add(data.chunkId);
            this.appendToLog(this.currentLogDiv, data.content, data.chunkType);
        } else if (data.type === 'done') {
            this.isProcessing = false;
            this.updateProcessingUI(false);
            this.currentLogDiv = null;
            this.refreshSession();
        } else if (data.type === 'error') {
            this.appendMessageToUI({ role: 'assistant', content: data.content, type: 'error' });
            this.isProcessing = false;
            this.updateProcessingUI(false);
        }
    }

    async refreshSession() {
        try {
            const res = await fetch(`${this.appBasePath}/api/chat/session/${this.currentSessionId}`);
            const session = await res.json();
            this.conversationHistory = session.messages || [];
            this.querySelector('#chat-history').innerHTML = '';
            this.conversationHistory.forEach(msg => this.appendMessageToUI(msg));
            this.scrollToBottom();
            
            // Speak last message if it's from assistant and was voice-driven
            const lastMsg = this.conversationHistory[this.conversationHistory.length - 1];
            if (lastMsg && lastMsg.role === 'assistant' && this.userWantMicActive) {
                this.speakText(lastMsg.content);
            }
        } catch (e) { console.error(e); }
    }

    // --- Helpers: UI Rendering ---
    appendMessageToUI(msg) {
        const history = this.querySelector('#chat-history');
        const div = document.createElement('div');
        div.className = `chat-message ${msg.role} ${msg.type || ''}`;
        
        if (Array.isArray(msg.content)) {
            let htmlParts = '';
            msg.content.forEach(part => {
                if (part.type === 'text') htmlParts += this.formatMarkdown(part.text);
                else if (part.type === 'image_url') htmlParts += `<div class="chat-image-container"><img src="${this.sanitize(part.image_url.url)}" class="chat-image"></div>`;
            });
            div.innerHTML = this.sanitize(htmlParts);
        } else {
            let htmlContent = this.formatMarkdown(msg.content || '');
            if (msg.tool_calls) {
                msg.tool_calls.forEach(t => htmlContent += `<div class="tool-usage">🔧 ${this.sanitize(t.function.name)}</div>`);
            }
            if (msg.role === 'tool') {
                div.classList.add('system');
                div.innerHTML = this.sanitize(`<div class="tool-usage-header">Output (${msg.name}):</div><small>${htmlContent.substring(0,150)}...</small>`);
            } else {
                div.innerHTML = this.sanitize(htmlContent);
            }
        }

        if (msg.role === 'assistant' && msg.content && !Array.isArray(msg.content)) {
            const speakerBtn = document.createElement('button');
            speakerBtn.className = 'btn-message-speak';
            speakerBtn.innerHTML = '🔊';
            speakerBtn.onclick = () => this.speakText(msg.content);
            div.appendChild(speakerBtn);
        }

        history.appendChild(div);
        this.scrollToBottom();
    }

    formatMarkdown(text) {
        if (!text) return '';
        let rawHtml = '';
        if (window.marked) {
            try { rawHtml = window.marked.parse(text); } 
            catch (e) { rawHtml = this.basicFormat(text); }
        } else {
            rawHtml = this.basicFormat(text);
        }
        return rawHtml;
    }

    basicFormat(text) {
        return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
                   .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
                   .replace(/`([^`]+)`/g, '<code>$1</code>')
                   .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
                   .replace(/\n/g, '<br>');
    }

    sanitize(str) {
        return window.DOMPurify ? window.DOMPurify.sanitize(str) : str;
    }

    showTypingIndicator() {
        const history = this.querySelector('#chat-history');
        const div = document.createElement('div');
        div.id = 'typing-indicator';
        div.className = 'typing-indicator-container';
        div.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
        history.appendChild(div);
        this.scrollToBottom();
    }

    removeTypingIndicator() {
        this.querySelector('#typing-indicator')?.remove();
    }

    createLogContainer() {
        const history = this.querySelector('#chat-history');
        const div = document.createElement('div');
        div.className = 'chat-message assistant streaming';
        history.appendChild(div);
        return div;
    }

    appendToLog(container, text, type) {
        if (!container) return;
        if (type === 'text') {
            container.innerHTML = this.formatMarkdown(text);
        } else if (type === 'tool_start') {
            const toolDiv = document.createElement('div');
            toolDiv.className = 'tool-usage';
            toolDiv.textContent = `🔧 Using tool: ${text}`;
            container.appendChild(toolDiv);
        }
        this.scrollToBottom();
    }

    // --- Voice Integration (STT) ---
    initVoice() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) return;

        this.recognition = new SpeechRecognition();
        this.recognition.continuous = true;
        this.recognition.interimResults = true;
        this.recognition.lang = navigator.language || 'en-US';

        this.recognition.onstart = () => {
            this.isListening = true;
            this.querySelector('#btn-chat-mic')?.classList.add('listening');
            this.querySelector('#chat-input').placeholder = "Listening...";
        };

        this.recognition.onend = () => {
            this.isListening = false;
            if (this.userWantMicActive) {
                try { this.recognition.start(); } catch(e) {}
            } else {
                this.querySelector('#btn-chat-mic')?.classList.remove('listening');
                this.querySelector('#chat-input').placeholder = "Ask...";
            }
        };

        this.recognition.onresult = (event) => {
            let interimTranscript = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) this.finalTranscript += event.results[i][0].transcript + ' ';
                else interimTranscript += event.results[i][0].transcript;
            }
            const input = this.querySelector('#chat-input');
            input.value = this.finalTranscript + interimTranscript;
            this.autoResizeInput();
        };

        this.recognition.onerror = (e) => {
            if (e.error === 'not-allowed') {
                this.userWantMicActive = false;
                this.querySelector('#btn-chat-mic')?.classList.remove('listening');
            }
        };
    }

    toggleMic() {
        if (!this.recognition) return showToast("Voice recognition not supported in this browser.", "warning");
        if (this.userWantMicActive) {
            this.userWantMicActive = false;
            this.recognition.stop();
        } else {
            window.speechSynthesis.cancel();
            this.userWantMicActive = true;
            const input = this.querySelector('#chat-input');
            this.finalTranscript = input.value ? input.value + ' ' : '';
            try { this.recognition.start(); } catch(e) {}
        }
    }

    // --- Text-to-Speech (TTS) ---
    initTTS() {
        if (!('speechSynthesis' in window)) return;
        const loadVoices = () => { this.availableVoices = window.speechSynthesis.getVoices(); };
        loadVoices();
        window.speechSynthesis.onvoiceschanged = loadVoices;
    }

    speakText(text) {
        if (!('speechSynthesis' in window)) return;
        window.speechSynthesis.cancel();
        
        const cleanText = text.replace(/\*\*/g, '').replace(/`/g, '').replace(/#/g, '').replace(/<[^>]*>/g, '');
        this.currentUtterance = new SpeechSynthesisUtterance(cleanText);
        this.currentUtterance.lang = navigator.language || 'en-US';
        
        const voice = this.availableVoices.find(v => v.lang === this.currentUtterance.lang && v.name.includes('Google')) 
                   || this.availableVoices.find(v => v.lang === this.currentUtterance.lang);
        if (voice) this.currentUtterance.voice = voice;
        
        window.speechSynthesis.speak(this.currentUtterance);
    }

    // --- Camera Integration ---
    async openCamera() {
        const modal = this.querySelector('#chat-camera-modal');
        const video = this.querySelector('#chat-camera-feed');
        modal.style.display = 'flex';
        try {
            this.cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
            video.srcObject = this.cameraStream;
        } catch (e) {
            showToast("Camera access denied.", "error");
            this.closeCamera();
        }
    }

    closeCamera() {
        if (this.cameraStream) {
            this.cameraStream.getTracks().forEach(t => t.stop());
            this.cameraStream = null;
        }
        this.querySelector('#chat-camera-modal').style.display = 'none';
    }

    capturePhoto() {
        const video = this.querySelector('#chat-camera-feed');
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        this.pendingAttachment = { type: 'image', content: canvas.toDataURL('image/jpeg'), name: `camera_${Date.now()}.jpg` };
        this.renderFilePreview();
        this.closeCamera();
    }

    // --- File Selection ---
    handleFileSelect(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
            this.pendingAttachment = { 
                type: file.type.startsWith('image/') ? 'image' : 'text', 
                content: evt.target.result, 
                name: file.name 
            };
            this.renderFilePreview();
        };
        if (file.type.startsWith('image/')) reader.readAsDataURL(file);
        else reader.readAsText(file);
    }

    renderFilePreview() {
        const preview = this.querySelector('#chat-file-preview');
        if (!this.pendingAttachment) {
            preview.style.display = 'none';
            return;
        }
        preview.style.display = 'flex';
        preview.innerHTML = `
            <div class="preview-item" style="display:flex; align-items:center; gap:10px; background:var(--color-bg-secondary); padding:5px 10px; border-radius:5px; border:1px solid var(--color-border);">
                ${this.pendingAttachment.type === 'image' ? `<img src="${this.pendingAttachment.content}" style="height:30px; border-radius:3px;">` : '📄'}
                <span style="font-size:0.8em; max-width:150px; overflow:hidden; text-overflow:ellipsis;">${this.pendingAttachment.name}</span>
                <button id="btn-remove-file" style="background:none; border:none; cursor:pointer; color:var(--color-danger);">✕</button>
            </div>
        `;
        this.querySelector('#btn-remove-file').onclick = () => {
            this.pendingAttachment = null;
            this.renderFilePreview();
        };
    }

    // --- Draggable & Resizable ---
    makeDraggable() {
        const header = this.querySelector('#chat-header');
        const widget = this.querySelector('#chat-widget-container');
        let isDragging = false, startX, startY, initialLeft, initialTop;

        const switchToAbsolute = () => {
            if (widget.style.bottom || !widget.style.top) {
                const rect = widget.getBoundingClientRect();
                widget.style.bottom = 'auto'; widget.style.right = 'auto';
                widget.style.left = rect.left + 'px'; widget.style.top = rect.top + 'px';
            }
        };

        header.onmousedown = (e) => {
            if (e.target.closest('button')) return;
            isDragging = true;
            switchToAbsolute();
            startX = e.clientX; startY = e.clientY;
            initialLeft = widget.offsetLeft; initialTop = widget.offsetTop;
            document.onmousemove = (e) => {
                if (!isDragging) return;
                widget.style.left = (initialLeft + e.clientX - startX) + "px";
                widget.style.top = (initialTop + e.clientY - startY) + "px";
            };
            document.onmouseup = () => { isDragging = false; document.onmousemove = null; };
        };
    }

    makeResizable() {
        const widget = this.querySelector('#chat-widget-container');
        const handles = this.querySelectorAll('.chat-resize-handle');
        
        handles.forEach(handle => {
            handle.onmousedown = (e) => {
                e.preventDefault();
                const pos = handle.className.split('chat-resize-').pop();
                const startX = e.clientX, startY = e.clientY;
                const startWidth = widget.offsetWidth, startHeight = widget.offsetHeight;
                const startLeft = widget.offsetLeft, startTop = widget.offsetTop;

                document.onmousemove = (me) => {
                    const dx = me.clientX - startX, dy = me.clientY - startY;
                    if (pos.includes('e')) widget.style.width = (startWidth + dx) + 'px';
                    if (pos.includes('s')) widget.style.height = (startHeight + dy) + 'px';
                    if (pos.includes('w')) { widget.style.width = (startWidth - dx) + 'px'; widget.style.left = (startLeft + dx) + 'px'; }
                    if (pos.includes('n')) { widget.style.height = (startHeight - dy) + 'px'; widget.style.top = (startTop + dy) + 'px'; }
                };
                document.onmouseup = () => { document.onmousemove = null; };
            };
        });
    }
}

customElements.define('ai-chat-widget', AiChatWidget);
