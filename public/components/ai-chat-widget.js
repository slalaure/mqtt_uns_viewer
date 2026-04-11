/**
 * @license Apache License, Version 2.0 (the "License")
 */

import { state, subscribe, unsubscribe } from '../state.js';
import { trackEvent, confirmModal, showToast } from '../utils.js';
import './chat-session-list.js';

// SVG Icon Dictionary for internal logic
const ICONS = {
    speaker: '<svg xmlns="http://www.w3.org/2000/svg" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
    wrench: '<svg xmlns="http://www.w3.org/2000/svg" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    check: '<svg xmlns="http://www.w3.org/2000/svg" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--color-success);"><polyline points="20 6 9 17 4 12"/></svg>',
    loader: '<svg xmlns="http://www.w3.org/2000/svg" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: spin 2s linear infinite;"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>',
    file: '<svg xmlns="http://www.w3.org/2000/svg" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
    close: '<svg xmlns="http://www.w3.org/2000/svg" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--color-danger); cursor:pointer;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    alert: '<svg xmlns="http://www.w3.org/2000/svg" class="protocol-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--color-danger);"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
};

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
        // Wait for init() to be called by app.js so we have the correct basePath before fetching templates.
    }

    async init(basePath, llmModels = []) {
        if (this.isMounted) return;

        this.appBasePath = basePath || '';
        if (this.appBasePath === '/') this.appBasePath = '';
        if (this.appBasePath.endsWith('/')) this.appBasePath = this.appBasePath.slice(0, -1);

        await this.render();
        this.setupEventListeners();
        this.initVoice();
        this.initTTS();

        const modelSelect = this.querySelector('#chat-model-select');
        if (modelSelect && llmModels.length > 0) {
            modelSelect.innerHTML = '';
            llmModels.forEach(model => {
                const opt = document.createElement('option');
                opt.value = model;
                opt.textContent = model.replace('models/', '');
                modelSelect.appendChild(opt);
            });
            modelSelect.style.display = 'block';
        }

        const sessionList = this.querySelector('chat-session-list');        if (sessionList) {
            sessionList.init(this.appBasePath, this.currentSessionId, {
                onSwitch: (id) => this.switchSession(id),
                onDelete: (id) => this.deleteSession(id),
                onNewChat: () => this.createNewSession()
            });
        }
        
        this.loadSessions();
        this.isMounted = true;
    }

    async render() {
        try {
            const response = await fetch(`${this.appBasePath}/components/templates/ai-chat-widget.html`);
            if (!response.ok) throw new Error(`Failed to load template: ${response.statusText}`);
            this.innerHTML = await response.text();
        } catch (error) {
            console.error("Error rendering AiChatWidget:", error);
            this.innerHTML = `<div class="error">Failed to load Chat Assistant UI</div>`;
        }
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

        const modelSelect = this.querySelector('#chat-model-select');
        const selectedModel = modelSelect ? modelSelect.value : undefined;

        try {
            const payload = {
                sessionId: this.currentSessionId,
                messages: this.conversationHistory,
                model: selectedModel,
                context: {
                    currentTopic: state.currentTopic,
                    currentSourceId: state.currentSourceId
                }
            };

            window.dispatchEvent(new CustomEvent('send-chat-message', { detail: payload }));            
        } catch (e) {
            this.appendMessageToUI({ role: 'assistant', content: `Error sending message: ${e.message}`, type: 'error' });
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
            if (!this.currentLogDiv) this.currentLogDiv = this.createLogContainer();
        } else if (data.type === 'status') {
            this.removeTypingIndicator();
            if (!this.currentLogDiv) this.currentLogDiv = this.createLogContainer();
            
            const statusDiv = document.createElement('div');
            statusDiv.className = 'chat-status-update';
            statusDiv.style.fontSize = '0.85em';
            statusDiv.style.color = 'var(--color-text-muted)';
            statusDiv.style.fontStyle = 'italic';
            statusDiv.style.marginBottom = '5px';
            statusDiv.innerHTML = `${ICONS.loader} ${data.content}`;
            this.currentLogDiv.appendChild(statusDiv);
            this.scrollToBottom();
            
        } else if (data.type === 'chunk') {
            if (this.processedChunkIds.has(data.chunkId)) return;
            this.processedChunkIds.add(data.chunkId);
            this.appendToLog(this.currentLogDiv, data.content, data.chunkType);
        } else if (data.type === 'message') {
            this.conversationHistory.push(data.content);
        } else if (data.type === 'done') {
            this.isProcessing = false;
            this.updateProcessingUI(false);
            this.currentLogDiv = null;
            this.refreshSession();
        } else if (data.type === 'error') {
            this.appendMessageToUI({ role: 'assistant', content: data.content, type: 'error' });
            this.isProcessing = false;
            this.updateProcessingUI(false);
        } else if (data.type === 'approval_required') {
            this.isProcessing = false;
            this.updateProcessingUI(false);
            this.currentLogDiv = null;
            this.handleApprovalRequired(data.content.toolCalls);
        }
    }

    async handleApprovalRequired(toolCalls) {
        if (!toolCalls || toolCalls.length === 0) return;
        
        let html = '<div style="text-align: left; font-size: 0.9em;">';
        html += '<p>The AI wants to execute the following sensitive actions. Do you approve?</p>';
        html += '<ul style="padding-left: 20px; list-style-type: disc;">';
        
        toolCalls.forEach(t => {
            let argsStr = "";
            try { 
                const args = JSON.parse(t.function.arguments); 
                argsStr = JSON.stringify(args, null, 2);
            } catch(e) { argsStr = t.function.arguments; }
            
            html += `<li style="margin-bottom: 10px;">
                <b>${this.sanitize(t.function.name)}</b>
                <pre style="background: var(--color-bg-secondary); padding: 5px; border-radius: 4px; max-height: 150px; overflow-y: auto;"><code>${this.sanitize(argsStr)}</code></pre>
            </li>`;
        });
        html += '</ul></div>';

        const approved = await confirmModal("Action Required", html, "Approve Actions", false);
        
        if (approved) {
            this.isProcessing = true;
            this.updateProcessingUI(true);
            
            // Re-send the last message, but append the approved IDs so the backend proceeds
            const approvedIds = toolCalls.map(t => t.id);
            try {
                const payload = {
                    sessionId: this.currentSessionId,
                    messages: this.conversationHistory, // backend already has the latest state via history
                    approvedToolCallIds: approvedIds,
                    context: {
                        currentTopic: state.currentTopic,
                        currentSourceId: state.currentSourceId
                    }
                };
                window.dispatchEvent(new CustomEvent('send-chat-message', { detail: payload }));
            } catch (e) {
                this.appendMessageToUI({ role: 'assistant', content: 'Error resuming: ' + e.message, type: 'error' });
                this.isProcessing = false;
                this.updateProcessingUI(false);
            }
        } else {
            // Remove the LLM tool request we just appended to history
            const last = this.conversationHistory[this.conversationHistory.length - 1];
            if (last && last.role === 'assistant' && last.tool_calls) {
                this.conversationHistory.pop();
            }
            this.appendMessageToUI({ role: 'assistant', content: 'Actions rejected by user.', type: 'error' });
            this.refreshSession();
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
        
        if (msg.type === 'error') {
            div.innerHTML = `${ICONS.alert} <span>${this.sanitize(msg.content)}</span>`;
        } else if (Array.isArray(msg.content)) {
            let htmlParts = '';
            msg.content.forEach(part => {
                if (part.type === 'text') htmlParts += this.formatMarkdown(part.text);
                else if (part.type === 'image_url') htmlParts += `<div class="chat-image-container"><img src="${this.sanitize(part.image_url.url)}" class="chat-image"></div>`;
            });
            div.innerHTML = this.sanitize(htmlParts);
        } else {
            let htmlContent = this.formatMarkdown(msg.content || '');
            if (msg.tool_calls) {
                msg.tool_calls.forEach(t => htmlContent += `<div class="tool-usage">${ICONS.wrench} ${this.sanitize(t.function.name)}</div>`);
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
            speakerBtn.innerHTML = ICONS.speaker;
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

    appendToLog(container, content, type) {
        if (!container) return;
        
        if (type === 'text') {
            // Text chunks from LLM are just appended directly to the container
            // Since LLM streams are no longer chunk-by-chunk in this implementation, 
            // 'text' actually contains the full response so far.
            // We find or create the text wrapper.
            let textWrapper = container.querySelector('.streaming-text-content');
            if (!textWrapper) {
                textWrapper = document.createElement('div');
                textWrapper.className = 'streaming-text-content';
                container.appendChild(textWrapper);
            }
            textWrapper.innerHTML = this.formatMarkdown(content);
            
        } else if (type === 'tool_start') {
            const toolId = `tool-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            const toolDiv = document.createElement('div');
            toolDiv.id = toolId;
            toolDiv.className = 'tool-usage';
            toolDiv.style.display = 'flex';
            toolDiv.style.justifyContent = 'space-between';
            toolDiv.innerHTML = `<span><span class="typing-dot" style="display:inline-block; width:6px; height:6px; margin-right:5px; background:var(--color-primary)"></span> ${ICONS.wrench} Executing <b>${content}</b>...</span> <span class="tool-timer"></span>`;
            
            // Stash the tool ID in the container for the result chunk to find
            if (!container.dataset.activeTools) container.dataset.activeTools = "{}";
            const activeTools = JSON.parse(container.dataset.activeTools);
            activeTools[content] = toolId;
            container.dataset.activeTools = JSON.stringify(activeTools);
            
            container.appendChild(toolDiv);
            
        } else if (type === 'tool_result') {
            // Content shape is { name: fnName, result: "Done", duration: ms }
            if (container.dataset.activeTools) {
                const activeTools = JSON.parse(container.dataset.activeTools);
                const toolId = activeTools[content.name];
                if (toolId) {
                    const toolDiv = container.querySelector(`#${toolId}`);
                    if (toolDiv) {
                        toolDiv.style.borderLeftColor = 'var(--color-success)';
                        toolDiv.innerHTML = `<span>${ICONS.check} Finished <b>${content.name}</b></span> <span style="font-size:0.85em; color:var(--color-text-muted)">${(content.duration / 1000).toFixed(2)}s</span>`;
                    }
                    delete activeTools[content.name];
                    container.dataset.activeTools = JSON.stringify(activeTools);
                }
            }
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
            <div class="preview-item" style="display:flex; align-items:center; gap:10px; background:var(--color-bg-secondary); padding:5px 10px; border-radius:5px; border:1px solid var(--color-border); max-width: 100%;">
                ${this.pendingAttachment.type === 'image' ? `<img src="${this.pendingAttachment.content}" style="height:30px; border-radius:3px;">` : ICONS.file}
                <span style="font-size:0.8em; max-width:150px; overflow:hidden; text-overflow:ellipsis;">${this.pendingAttachment.name}</span>
                <button id="btn-remove-file" style="background:none; border:none; cursor:pointer; padding: 0;">${ICONS.close}</button>
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