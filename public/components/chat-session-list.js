/**
 * @license Apache License, Version 2.0 (the "License")
 */

import { confirmModal } from '../utils.js';

/**
 * Web Component for Chat Session History sidebar.
 */
class ChatSessionList extends HTMLElement {
    constructor() {
        super();
        this.sessions = [];
        this.currentSessionId = null;
        this.appBasePath = '';
    }

    connectedCallback() {
        this.render();
    }

    init(basePath, currentSessionId, callbacks) {
        this.appBasePath = basePath;
        this.currentSessionId = currentSessionId;
        this.callbacks = callbacks || {};
        this.loadSessions();
    }

    async loadSessions() {
        try {
            const res = await fetch(`${this.appBasePath}/api/chat/sessions`);
            if (!res.ok) throw new Error("Failed to load sessions");
            this.sessions = await res.json();
            this.renderList();
        } catch (e) {
            console.error(e);
        }
    }

    renderList() {
        const container = this.querySelector('#session-list-container');
        if (!container) return;

        container.innerHTML = '';
        if (this.sessions.length === 0) {
            container.innerHTML = '<div style="color:var(--color-text-secondary); font-style:italic; padding:10px;">No history</div>';
            return;
        }

        this.sessions.forEach(session => {
            const div = document.createElement('div');
            div.className = 'session-item';
            div.style.cssText = `
                display: flex; justify-content: space-between; align-items: center;
                padding: 8px; cursor: pointer; border-radius: 4px; margin-bottom: 5px;
                background: ${session.id === this.currentSessionId ? 'var(--color-bg-accent)' : 'transparent'};
                border: 1px solid ${session.id === this.currentSessionId ? 'var(--color-primary)' : 'transparent'};
                font-size: 0.9em;
            `;
            
            const titleSpan = document.createElement('span');
            titleSpan.style.cssText = "white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-grow: 1; color: var(--color-text);";
            titleSpan.textContent = session.title || "Untitled Chat";
            titleSpan.onclick = () => this.callbacks.onSwitch(session.id);
            
            const delBtn = document.createElement('button');
            delBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';
            delBtn.style.cssText = "background: none; border: none; cursor: pointer; color: var(--color-text-secondary); display: flex; align-items: center; justify-content: center; padding: 4px; border-radius: 4px; transition: color 0.2s, background-color 0.2s;";
            
            delBtn.onmouseover = () => { delBtn.style.color = 'var(--color-danger)'; delBtn.style.backgroundColor = 'rgba(220, 53, 69, 0.1)'; };
            delBtn.onmouseout = () => { delBtn.style.color = 'var(--color-text-secondary)'; delBtn.style.backgroundColor = 'transparent'; };

            delBtn.onclick = async (e) => {
                e.stopPropagation();
                const confirmed = await confirmModal('Delete Session', 'Are you sure?', 'Delete', true);
                if (confirmed) {
                    this.callbacks.onDelete(session.id);
                }
            };
            
            div.appendChild(titleSpan);
            div.appendChild(delBtn);
            container.appendChild(div);
        });
    }

    render() {
        this.innerHTML = `
            <div class="chat-session-overlay" style="position: absolute; top: 0; left: 0; width: 250px; height: 100%; background: var(--color-bg-secondary); border-right: 1px solid var(--color-border); z-index: 100; transform: translateX(-100%); transition: transform 0.3s ease; display: flex; flex-direction: column; padding: 10px; box-sizing: border-box;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; border-bottom:1px solid var(--color-border); padding-bottom:5px;">
                    <strong style="color: var(--color-text);">Sessions</strong>
                    <button id="btn-close-sessions" title="Close" style="background:none; border:none; color:var(--color-text); cursor:pointer; display:flex; align-items:center; justify-content:center; padding:4px; border-radius:4px; transition: background-color 0.2s;">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                </div>
                <button id="btn-new-chat" class="tool-button" style="width: 100%; margin-bottom: 10px;">+ New Chat</button>
                <div id="session-list-container" style="flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:5px;"></div>
            </div>
        `;

        const closeBtn = this.querySelector('#btn-close-sessions');
        closeBtn.onmouseover = () => { closeBtn.style.backgroundColor = 'var(--color-bg-accent)'; };
        closeBtn.onmouseout = () => { closeBtn.style.backgroundColor = 'transparent'; };
        closeBtn.onclick = () => this.toggle(false);

        this.querySelector('#btn-new-chat').onclick = () => this.callbacks.onNewChat();
    }

    toggle(open) {
        const overlay = this.querySelector('.chat-session-overlay');
        overlay.style.transform = open ? 'translateX(0%)' : 'translateX(-100%)';
        if (open) this.loadSessions();
    }
}

customElements.define('chat-session-list', ChatSessionList);