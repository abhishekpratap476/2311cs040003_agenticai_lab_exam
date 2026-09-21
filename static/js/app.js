document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const sidebar = document.getElementById('studioSidebar');
    const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
    const closeSidebarBtn = document.getElementById('closeSidebarBtn');
    const newChatBtn = document.getElementById('newChatBtn');
    const activeFileBadge = document.getElementById('activeFileBadge');
    const historyList = document.getElementById('historyList');
    const clearAllHistoryBtn = document.getElementById('clearAllHistoryBtn');
    const personaSelect = document.getElementById('personaSelect');
    const currentPersonaTag = document.getElementById('currentPersonaTag');
    const engineStatus = document.getElementById('engineStatus');
    const engineState = document.getElementById('engineState');
    const engineModel = document.getElementById('engineModel');

    const currentSessionTitle = document.getElementById('currentSessionTitle');
    const exportMenuBtn = document.getElementById('exportMenuBtn');
    const exportDropdown = document.getElementById('exportDropdown');
    const exportMdBtn = document.getElementById('exportMdBtn');
    const exportJsonBtn = document.getElementById('exportJsonBtn');
    const resetCurrentChatBtn = document.getElementById('resetCurrentChatBtn');

    const chatViewport = document.getElementById('chatViewport');
    const heroContainer = document.getElementById('heroContainer');
    const messagesFeed = document.getElementById('messagesFeed');
    const promptCards = document.querySelectorAll('.prompt-card');

    const promptInput = document.getElementById('promptInput');
    const sendPromptBtn = document.getElementById('sendPromptBtn');
    const stopBtn = document.getElementById('stopBtn');

    // State
    let currentChatFilename = null; // null = new chat, will be created on first turn
    let currentSessionMessages = [];
    let currentSessionPersona = 'Default';
    let isGenerating = false;
    let currentAbortController = null;

    // Persona System Prompts Map
    const PERSONA_PROMPTS = {
        'Default': 'You are a helpful, expert AI assistant powered by Llama 3.2. Provide clear, accurate, and insightful responses.',
        'Senior Code Architect': 'You are a Senior Principal Software Engineer and System Architect. Write clean, production-ready, type-safe code with comments and explain architecture choices thoroughly.',
        'Concise Explainer': 'You are a concise, direct explainer. Answer questions with extreme clarity in as few words as possible without losing essential accuracy.',
        'Technical Researcher': 'You are an academic researcher and deep technical analyst. Cite technical mechanics, theoretical underpinnings, and trade-offs systematically.',
        'Creative Muse': 'You are a creative brainstorming partner. Offer innovative, outside-the-box perspectives, vibrant metaphors, and inspiring concepts.'
    };

    // Configure Marked
    if (window.marked) {
        marked.setOptions({
            breaks: true,
            gfm: true
        });
    }

    // Toggle Sidebar
    toggleSidebarBtn.addEventListener('click', () => {
        if (window.innerWidth <= 768) {
            sidebar.classList.toggle('open');
        } else {
            sidebar.classList.toggle('collapsed');
        }
    });

    closeSidebarBtn.addEventListener('click', () => {
        sidebar.classList.remove('open');
        sidebar.classList.add('collapsed');
    });

    // Auto-resize textarea
    function autoResizeInput() {
        promptInput.style.height = 'auto';
        promptInput.style.height = Math.min(promptInput.scrollHeight, 180) + 'px';
        sendPromptBtn.disabled = promptInput.value.trim().length === 0 || isGenerating;
    }

    promptInput.addEventListener('input', autoResizeInput);

    promptInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!sendPromptBtn.disabled) {
                sendMessage();
            }
        }
    });

    // Keyboard shortcut Ctrl+K / Cmd+K for New Chat
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            startNewChat();
        }
    });

    // Persona Selector
    personaSelect.addEventListener('change', () => {
        currentSessionPersona = personaSelect.value;
        const optionText = personaSelect.options[personaSelect.selectedIndex].text;
        currentPersonaTag.textContent = optionText;
    });

    // Fetch Engine Status & List of Saved JSON Chats
    async function refreshChatsList() {
        try {
            const [statusRes, chatsRes] = await Promise.all([
                fetch('/api/status'),
                fetch('/api/chats')
            ]);

            const statusData = await statusRes.json();
            if (statusRes.ok && statusData.status === 'online') {
                engineStatus.className = 'engine-status online';
                engineState.textContent = 'Ollama Online';
                engineModel.textContent = `Model: ${statusData.active_model}`;
            } else {
                engineStatus.className = 'engine-status offline';
                engineState.textContent = 'Ollama Offline';
            }

            if (chatsRes.ok) {
                const chatsData = await chatsRes.json();
                renderChatsList(chatsData.chats || []);
            }
        } catch (err) {
            console.warn('Status or chats fetch failed:', err);
            engineStatus.className = 'engine-status offline';
            engineState.textContent = 'Disconnected';
        }
    }

    refreshChatsList();
    setInterval(refreshChatsList, 15000);

    // Render Saved Chats (individual JSON files) in Sidebar
    function renderChatsList(chats) {
        historyList.innerHTML = '';
        if (chats.length === 0) {
            historyList.innerHTML = '<div style="padding: 12px; font-size: 0.75rem; color: var(--text-faint); text-align: center;">No saved JSON chats yet</div>';
            return;
        }

        chats.forEach(chat => {
            const item = document.createElement('div');
            item.className = `history-item ${chat.filename === currentChatFilename ? 'active' : ''}`;
            
            const contentDiv = document.createElement('div');
            contentDiv.className = 'history-item-content';

            const titleSpan = document.createElement('span');
            titleSpan.className = 'history-title';
            titleSpan.textContent = chat.title || chat.filename;
            titleSpan.title = chat.filename;

            const fileSpan = document.createElement('span');
            fileSpan.className = 'history-file-tag';
            fileSpan.textContent = `📄 ${chat.filename}`;

            contentDiv.appendChild(titleSpan);
            contentDiv.appendChild(fileSpan);

            const delBtn = document.createElement('button');
            delBtn.className = 'delete-session-btn';
            delBtn.innerHTML = '&times;';
            delBtn.title = `Delete ${chat.filename}`;

            delBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (confirm(`Delete ${chat.filename}?`)) {
                    await deleteChatFile(chat.filename);
                }
            });

            item.addEventListener('click', () => {
                loadChatFile(chat.filename);
            });

            item.appendChild(contentDiv);
            item.appendChild(delBtn);
            historyList.appendChild(item);
        });
    }

    // Load an existing JSON chat file
    async function loadChatFile(filename) {
        try {
            const res = await fetch(`/api/chats/${encodeURIComponent(filename)}`);
            if (!res.ok) throw new Error('Failed to load chat file');
            const data = await res.json();

            currentChatFilename = data.filename || filename;
            currentSessionMessages = [];
            currentSessionTitle.textContent = data.title || filename.replace('.json', '');
            if (activeFileBadge) {
                activeFileBadge.textContent = `📁 ${currentChatFilename}`;
                activeFileBadge.classList.add('has-file');
            }

            heroContainer.style.display = 'none';
            messagesFeed.innerHTML = '';

            if (data.persona) {
                personaSelect.value = data.persona;
                currentSessionPersona = data.persona;
                const opt = Array.from(personaSelect.options).find(o => o.value === data.persona);
                if (opt) currentPersonaTag.textContent = opt.text;
            }

            if (Array.isArray(data.messages)) {
                data.messages.forEach(msg => {
                    appendMessage(msg.role, msg.content, false);
                    currentSessionMessages.push({ role: msg.role, content: msg.content });
                });
            }

            refreshChatsList();
            scrollToBottom();
        } catch (err) {
            console.error('Error loading chat:', err);
            alert('Failed to load chat: ' + err.message);
        }
    }

    // Delete a specific JSON chat file
    async function deleteChatFile(filename) {
        try {
            const res = await fetch(`/api/chats/${encodeURIComponent(filename)}`, {
                method: 'DELETE'
            });
            if (res.ok) {
                if (currentChatFilename === filename) {
                    startNewChat();
                } else {
                    refreshChatsList();
                }
            }
        } catch (e) {
            console.error('Failed to delete chat file:', e);
        }
    }

    // Clear all chat JSON files
    clearAllHistoryBtn.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to delete ALL saved chat JSON files?')) return;
        try {
            const res = await fetch('/api/chats', { method: 'DELETE' });
            if (res.ok) {
                startNewChat();
                refreshChatsList();
            }
        } catch (e) {
            console.error('Failed to clear chats:', e);
        }
    });

    // Start New Chat (will create a new JSON file on first prompt)
    function startNewChat() {
        if (isGenerating && currentAbortController) {
            currentAbortController.abort();
        }
        currentChatFilename = null;
        currentSessionMessages = [];
        currentSessionTitle.textContent = 'New Conversation';
        if (activeFileBadge) {
            activeFileBadge.textContent = '📁 New Chat (Unsaved)';
            activeFileBadge.classList.remove('has-file');
        }
        messagesFeed.innerHTML = '';
        heroContainer.style.display = 'block';
        promptInput.value = '';
        autoResizeInput();
        promptInput.focus();
        refreshChatsList();
    }

    newChatBtn.addEventListener('click', startNewChat);
    resetCurrentChatBtn.addEventListener('click', startNewChat);

    // Prompt starter cards
    promptCards.forEach(card => {
        card.addEventListener('click', () => {
            const prompt = card.getAttribute('data-prompt');
            if (prompt && !isGenerating) {
                promptInput.value = prompt;
                autoResizeInput();
                sendMessage();
            }
        });
    });

    // Scroll chat viewport
    function scrollToBottom() {
        chatViewport.scrollTop = chatViewport.scrollHeight;
    }

    // Enhance code blocks with Highlight.js and Copy button
    function enhanceCodeBlocks(container) {
        container.querySelectorAll('pre code').forEach((block) => {
            if (window.hljs) {
                hljs.highlightElement(block);
            }
            const pre = block.parentElement;
            if (pre.parentElement.classList.contains('code-container')) return;

            const wrapper = document.createElement('div');
            wrapper.className = 'code-container';

            const header = document.createElement('div');
            header.className = 'code-bar';

            const langClass = Array.from(block.classList).find(c => c.startsWith('language-'));
            const langName = langClass ? langClass.replace('language-', '') : 'code';

            header.innerHTML = `
                <span>${langName}</span>
                <button class="copy-code-btn">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                    Copy
                </button>
            `;

            const copyBtn = header.querySelector('.copy-code-btn');
            copyBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(block.innerText);
                    copyBtn.innerHTML = '✓ Copied!';
                    setTimeout(() => {
                        copyBtn.innerHTML = `
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                            </svg>
                            Copy
                        `;
                    }, 2000);
                } catch (e) {
                    copyBtn.textContent = 'Failed';
                }
            });

            pre.parentNode.insertBefore(wrapper, pre);
            wrapper.appendChild(header);
            wrapper.appendChild(pre);
        });
    }

    // Append Message to UI
    function appendMessage(role, content = '', isStreaming = false) {
        heroContainer.style.display = 'none';

        const turn = document.createElement('div');
        turn.className = `msg-turn ${role} ${isStreaming ? 'streaming' : ''}`;

        if (role === 'user') {
            const body = document.createElement('div');
            body.className = 'msg-body';
            body.textContent = content;
            turn.appendChild(body);
        } else {
            const avatarWrapper = document.createElement('div');
            avatarWrapper.className = 'avatar-wrapper';
            const avatar = document.createElement('div');
            avatar.className = 'msg-avatar';
            avatar.textContent = '🦙';
            avatarWrapper.appendChild(avatar);

            const contentWrapper = document.createElement('div');
            contentWrapper.className = 'msg-content-wrapper';

            const body = document.createElement('div');
            body.className = 'msg-body';
            if (content) {
                body.innerHTML = window.marked ? marked.parse(content) : content;
                enhanceCodeBlocks(body);
            }

            const toolbar = document.createElement('div');
            toolbar.className = 'msg-toolbar';

            // Copy Markdown Button
            const copyMdBtn = document.createElement('button');
            copyMdBtn.className = 'toolbar-btn';
            copyMdBtn.innerHTML = `
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                Copy Markdown
            `;
            copyMdBtn.addEventListener('click', async () => {
                await navigator.clipboard.writeText(content);
                copyMdBtn.innerHTML = '✓ Copied';
                setTimeout(() => {
                    copyMdBtn.innerHTML = `
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                        Copy Markdown
                    `;
                }, 2000);
            });

            // Read Aloud (TTS) Button
            const ttsBtn = document.createElement('button');
            ttsBtn.className = 'toolbar-btn';
            ttsBtn.innerHTML = `
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
                </svg>
                Read Aloud
            `;
            ttsBtn.addEventListener('click', () => {
                if ('speechSynthesis' in window) {
                    if (window.speechSynthesis.speaking) {
                        window.speechSynthesis.cancel();
                        ttsBtn.innerHTML = '🔊 Read Aloud';
                        return;
                    }
                    const utterance = new SpeechSynthesisUtterance(body.innerText);
                    utterance.rate = 1.05;
                    utterance.onend = () => { ttsBtn.innerHTML = '🔊 Read Aloud'; };
                    ttsBtn.innerHTML = '⏹ Stop Audio';
                    window.speechSynthesis.speak(utterance);
                } else {
                    alert('Text-to-speech is not supported in this browser.');
                }
            });

            toolbar.appendChild(copyMdBtn);
            toolbar.appendChild(ttsBtn);

            contentWrapper.appendChild(body);
            contentWrapper.appendChild(toolbar);

            turn.appendChild(avatarWrapper);
            turn.appendChild(contentWrapper);
        }

        messagesFeed.appendChild(turn);
        scrollToBottom();

        return { turn, body: turn.querySelector('.msg-body') };
    }

    // Send Message and Stream into the appropriate JSON file
    async function sendMessage() {
        const text = promptInput.value.trim();
        if (!text || isGenerating) return;

        isGenerating = true;
        sendPromptBtn.disabled = true;
        stopBtn.style.display = 'flex';
        promptInput.value = '';
        autoResizeInput();

        // If this is the first message of a new chat, set title
        if (currentSessionMessages.length === 0) {
            currentSessionTitle.textContent = text.length > 40 ? text.substring(0, 40) + '...' : text;
        }

        // Add user message
        appendMessage('user', text);
        currentSessionMessages.push({ role: 'user', content: text });

        // Add assistant placeholder with streaming cursor
        const { turn, body } = appendMessage('assistant', '', true);
        const cursor = document.createElement('span');
        cursor.className = 'stream-cursor';
        body.appendChild(cursor);

        let assistantContent = '';
        currentAbortController = new AbortController();

        // Build message payload including System Persona
        const systemInstruction = PERSONA_PROMPTS[currentSessionPersona] || PERSONA_PROMPTS['Default'];
        const fullPayloadMessages = [
            { role: 'system', content: systemInstruction },
            ...currentSessionMessages
        ];

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: currentAbortController.signal,
                body: JSON.stringify({
                    model: 'llama3.2',
                    filename: currentChatFilename, // null if brand new, string if continuing
                    persona: currentSessionPersona,
                    messages: fullPayloadMessages,
                    stream: true
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || `Server responded with ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('data: ')) {
                        const jsonStr = trimmed.slice(6);
                        try {
                            const data = JSON.parse(jsonStr);
                            if (data.error) throw new Error(data.error);

                            // Capture or update the assigned filename
                            if (data.filename && !currentChatFilename) {
                                currentChatFilename = data.filename;
                                if (activeFileBadge) {
                                    activeFileBadge.textContent = `📁 ${currentChatFilename}`;
                                    activeFileBadge.classList.add('has-file');
                                }
                            }

                            if (data.content) {
                                assistantContent += data.content;
                                body.innerHTML = window.marked ? marked.parse(assistantContent) : assistantContent;
                                body.appendChild(cursor);
                                scrollToBottom();
                            }

                            if (data.saved) {
                                refreshChatsList();
                            }
                        } catch (parseErr) {
                            // Partial chunk
                        }
                    }
                }
            }

            // Finished successfully
            cursor.remove();
            turn.classList.remove('streaming');
            body.innerHTML = window.marked ? marked.parse(assistantContent) : assistantContent;
            enhanceCodeBlocks(body);
            currentSessionMessages.push({ role: 'assistant', content: assistantContent });

        } catch (err) {
            cursor.remove();
            turn.classList.remove('streaming');
            if (err.name === 'AbortError') {
                body.innerHTML += '<p style="color: var(--warning); font-size: 0.8rem; margin-top: 8px;"><em>Generation stopped by user.</em></p>';
                if (assistantContent) {
                    currentSessionMessages.push({ role: 'assistant', content: assistantContent });
                }
            } else {
                body.innerHTML = `<span style="color: var(--danger);">⚠️ Error: ${err.message || 'Inference failed.'}</span>`;
            }
        } finally {
            isGenerating = false;
            stopBtn.style.display = 'none';
            autoResizeInput();
            promptInput.focus();
            scrollToBottom();
            refreshChatsList();
        }
    }

    // Stop Generation
    stopBtn.addEventListener('click', () => {
        if (currentAbortController) {
            currentAbortController.abort();
        }
    });

    sendPromptBtn.addEventListener('click', sendMessage);

    // Export Options
    exportMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        exportDropdown.classList.toggle('show');
    });

    document.addEventListener('click', () => {
        exportDropdown.classList.remove('show');
    });

    exportMdBtn.addEventListener('click', () => {
        if (currentSessionMessages.length === 0) {
            alert('No messages to export.');
            return;
        }
        let md = `# ${currentSessionTitle.textContent}\n*Model: Llama 3.2 | Persona: ${currentSessionPersona}*\n\n---\n\n`;
        currentSessionMessages.forEach(msg => {
            md += `### ${msg.role === 'user' ? 'User' : 'Llama 3.2'}\n\n${msg.content}\n\n`;
        });
        const outName = currentChatFilename ? currentChatFilename.replace('.json', '.md') : 'chat_export.md';
        downloadFile(outName, md, 'text/markdown');
    });

    exportJsonBtn.addEventListener('click', () => {
        if (currentSessionMessages.length === 0) {
            alert('No messages to export.');
            return;
        }
        const sessionData = {
            filename: currentChatFilename || 'untitled_chat.json',
            title: currentSessionTitle.textContent,
            persona: currentSessionPersona,
            messages: currentSessionMessages
        };
        const outName = currentChatFilename || 'chat_export.json';
        downloadFile(outName, JSON.stringify(sessionData, null, 2), 'application/json');
    });

    function downloadFile(filename, text, type) {
        const blob = new Blob([text], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
});
