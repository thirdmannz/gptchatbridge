/**
 * ChatGPT Bridge — Dashboard Frontend
 * Chat mode (WS streaming) + Agent mode (SSE agent loop) + sessions + images.
 */

const API = '';
let ws = null;
let sessions = [];
let currentSessionId = null;
let currentMessages = [];
let currentImages = [];
let currentMode = 'chat'; // 'chat' | 'agent'
let isBusy = false;

// Multi-user state
let users = [];
let currentApiKey = localStorage.getItem('bridge-api-key') || '';
let singleUserMode = true;

// Streaming render state
let pendingStreamFull = null;
let streamRafScheduled = false;
let streamingEl = null;

// Agent loop state
let agentEventSource = null;

// ── Init ────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initUserSwitcher();
  initTabs();
  initEventListeners();
  initComposer();
  // Load users first, then connect WS + refresh data (need API key)
  loadUsers().then(() => {
    initWebSocket();
    refreshSessions();
    checkStatus();
    loadModels();
  });
});

// ── Theme ───────────────────────────────────────────

function initTheme() {
  const saved = localStorage.getItem('bridge-theme') || 'dark';
  applyTheme(saved);
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);
}

function applyTheme(theme) {
  const isDark = theme === 'dark';
  document.documentElement.classList.toggle('dark', isDark);
  document.getElementById('icon-moon').classList.toggle('hidden', isDark);
  document.getElementById('icon-sun').classList.toggle('hidden', !isDark);
}

function toggleTheme() {
  const current = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem('bridge-theme', next);
}

// ── User Switcher (multi-user mode) ─────────────────

function initUserSwitcher() {
  const input = document.getElementById('api-key-input');
  if (input) {
    input.value = currentApiKey;
    input.addEventListener('change', (e) => {
      currentApiKey = e.target.value.trim();
      localStorage.setItem('bridge-api-key', currentApiKey);
      // Reconnect WS with new key, then refresh everything
      if (ws) { ws.close(); }
      refreshSessions();
      checkStatus();
      loadModels();
    });
  }
}

async function loadUsers() {
  try {
    const resp = await fetch(`${API}/api/users`);
    const data = await resp.json();
    if (data.ok) {
      users = data.users;
      singleUserMode = data.singleUserMode;
      renderUserSwitcher();
    }
  } catch {
    singleUserMode = true;
    renderUserSwitcher();
  }
}

function renderUserSwitcher() {
  const container = document.getElementById('user-switcher');
  if (!container) return;
  if (singleUserMode) {
    container.classList.add('hidden');
  } else {
    container.classList.remove('hidden');
  }
}

// ── API key helper ──────────────────────────────────

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (currentApiKey) h['x-api-key'] = currentApiKey;
  return h;
}

// ── WebSocket ───────────────────────────────────────

function initWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const keyParam = currentApiKey ? `?key=${encodeURIComponent(currentApiKey)}` : '';
  ws = new WebSocket(`${proto}//${location.host}/ws${keyParam}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'subscribe' }));
    updateConnectionStatus(true);
  };
  ws.onmessage = (evt) => handleWSMessage(JSON.parse(evt.data));
  ws.onclose = () => {
    updateConnectionStatus(false);
    setTimeout(initWebSocket, 3000);
  };
  ws.onerror = () => updateConnectionStatus(false);
}

function handleWSMessage(msg) {
  switch (msg.type) {
    case 'status':
      updateChatGPTStatus(msg);
      break;
    case 'stream':
      updateStreamingMessage(msg);
      break;
    case 'pong':
      break;
  }
}

// ── Status ──────────────────────────────────────────

function updateConnectionStatus(connected) {
  const badge = document.getElementById('status-badge');
  if (connected) {
    badge.className = 'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/15 text-green-400';
    badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-green-400"></span> Connected';
  } else {
    badge.className = 'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-500/15 text-red-400';
    badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-red-400"></span> Disconnected';
  }
}

function updateChatGPTStatus(msg) {
  const indicator = document.getElementById('thinking-indicator');
  const thinkingText = document.getElementById('thinking-text');
  const badge = document.getElementById('status-badge');

  if (msg.status === 'thinking') {
    indicator.classList.remove('hidden');
    thinkingText.textContent = 'Thinking...';
    badge.className = 'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-yellow-500/15 text-yellow-400';
    badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse"></span> Thinking';
  } else if (msg.status === 'streaming' || msg.status === 'generating') {
    indicator.classList.remove('hidden');
    thinkingText.textContent = 'Generating...';
    badge.className = 'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/15 text-green-400';
    badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></span> Generating';
  } else if (msg.status === 'error') {
    indicator.classList.add('hidden');
    toast(`Error: ${msg.error}`, 'error');
  } else if (msg.status === 'done' || msg.status === 'idle') {
    indicator.classList.add('hidden');
    badge.className = 'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/15 text-green-400';
    badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-green-400"></span> Connected';
  } else if (msg.status === 'typing' || msg.status === 'navigating') {
    indicator.classList.remove('hidden');
    thinkingText.textContent = msg.status === 'typing' ? 'Typing...' : 'Navigating...';
  }
}

// ── Streaming preview (Chat mode) ───────────────────

function updateStreamingMessage(msg) {
  if (msg.sessionId && currentSessionId && msg.sessionId !== currentSessionId) return;
  const container = document.getElementById('messages');
  if (!container) return;

  if (msg.done) {
    if (streamRafScheduled) {
      cancelAnimationFrame(streamRafScheduled);
      streamRafScheduled = false;
    }
    if (streamingEl && pendingStreamFull != null) {
      const content = streamingEl.querySelector('.msg-content');
      if (content) content.innerHTML = renderMarkdown(pendingStreamFull);
    }
    if (streamingEl) {
      streamingEl.classList.remove('streaming');
      const cursor = streamingEl.querySelector('.streaming-cursor');
      if (cursor) cursor.remove();
    }
    pendingStreamFull = null;
    streamingEl = null;
    return;
  }

  if (!streamingEl) {
    streamingEl = createMessageEl('assistant', '', true);
    container.appendChild(streamingEl);
  }

  pendingStreamFull = msg.full || '';
  if (!streamRafScheduled) {
    streamRafScheduled = requestAnimationFrame(() => {
      streamRafScheduled = false;
      if (streamingEl && pendingStreamFull != null) {
        const content = streamingEl.querySelector('.msg-content');
        if (content) {
          content.innerHTML = renderMarkdown(pendingStreamFull) + '<span class="streaming-cursor"></span>';
        }
        container.scrollTop = container.scrollHeight;
      }
    });
  }
}

// ── Event Listeners ─────────────────────────────────

function initEventListeners() {
  document.getElementById('session-search').addEventListener('input', (e) => filterSessions(e.target.value));
  document.getElementById('btn-refresh').addEventListener('click', refreshSessions);
  document.getElementById('btn-new-chat').addEventListener('click', newChat);
  document.getElementById('btn-copy-all').addEventListener('click', copyAllMessages);
  document.getElementById('btn-export-md').addEventListener('click', exportMarkdown);

  // Mode toggle
  document.getElementById('mode-chat').addEventListener('click', () => switchMode('chat'));
  document.getElementById('mode-agent').addEventListener('click', () => switchMode('agent'));

  // Model selector
  document.getElementById('model-select').addEventListener('change', (e) => setModel(e.target.value));

  // Send
  document.getElementById('btn-send').addEventListener('click', sendPrompt);
  document.getElementById('prompt-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });
}

// ── Models ──────────────────────────────────────────

async function loadModels() {
  const data = await apiFetch('/models');
  if (!data.ok) return;
  const sel = document.getElementById('model-select');
  sel.innerHTML = '<option value="">Default model</option>';
  data.models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    if (data.current === m) opt.selected = true;
    sel.appendChild(opt);
  });
}

async function setModel(model) {
  if (!model) return;
  const data = await apiFetch('/model', { method: 'POST', body: JSON.stringify({ model }) });
  if (data.ok) toast(`Model set: ${data.model}`, 'success');
}

function initComposer() {
  const input = document.getElementById('prompt-input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    document.getElementById('btn-send').disabled = !input.value.trim() || isBusy;
  });
}

function switchMode(mode) {
  currentMode = mode;
  document.getElementById('mode-chat').classList.toggle('active', mode === 'chat');
  document.getElementById('mode-agent').classList.toggle('active', mode === 'agent');
  document.getElementById('agent-config').classList.toggle('hidden', mode !== 'agent');
}

// ── Tabs ────────────────────────────────────────────

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
      tab.classList.add('active');
      const target = document.getElementById(`tab-${tab.dataset.tab}`);
      if (target) target.classList.remove('hidden');
    });
  });
}

// ── API ─────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
  try {
    const resp = await fetch(`${API}/api${path}`, {
      headers: authHeaders(),
      ...opts,
    });
    return await resp.json();
  } catch (err) {
    toast(`API error: ${err.message}`, 'error');
    return { ok: false, error: err.message };
  }
}

async function checkStatus() {
  const data = await apiFetch('/status');
  if (data.ok) {
    updateConnectionStatus(true);
    if (!data.loggedIn) {
      toast('Not logged in to ChatGPT — run npm run login', 'error');
    }
  }
}

// ── Sessions ────────────────────────────────────────

async function refreshSessions() {
  const list = document.getElementById('session-list');
  list.innerHTML = '<div class="text-center py-8 text-text-faint text-xs">Loading...</div>';
  const data = await apiFetch('/sessions');

  if (data.ok) {
    sessions = data.sessions;
    renderSessions(sessions);
    document.getElementById('session-count').textContent = sessions.length;
  } else {
    list.innerHTML = `<div class="text-center py-8 text-red-400 text-xs">${escapeHtml(data.error)}</div>`;
  }
}

function renderSessions(list) {
  const el = document.getElementById('session-list');
  if (!list || list.length === 0) {
    el.innerHTML = '<div class="text-center py-8 text-text-faint text-xs">No sessions found</div>';
    return;
  }
  el.innerHTML = list.map(s => `
    <div class="session-item ${s.id === currentSessionId ? 'active' : ''}" data-id="${escapeAttr(s.id)}" onclick="selectSession('${escapeAttr(s.id)}')">
      <div class="session-title">${escapeHtml(s.title)}</div>
      <div class="session-id">${escapeHtml(s.id.substring(0, 20))}...</div>
    </div>
  `).join('');
}

function filterSessions(query) {
  if (!query.trim()) return renderSessions(sessions);
  const q = query.toLowerCase();
  renderSessions(sessions.filter(s =>
    (s.title || '').toLowerCase().includes(q) || (s.id || '').toLowerCase().includes(q)
  ));
}

async function selectSession(id) {
  currentSessionId = id;
  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });
  const sess = sessions.find(s => s.id === id);
  document.getElementById('current-session-title').textContent = sess ? sess.title : id;
  await loadMessages(id);
  await loadImages(id);
}

async function loadMessages(id) {
  const el = document.getElementById('messages');
  el.innerHTML = '<div class="text-center py-8 text-text-faint text-xs">Loading messages...</div>';
  const data = await apiFetch(`/sessions/${id}`);

  if (data.ok) {
    currentMessages = data.messages;
    renderMessages(data.messages);
    renderRaw(data.messages);
  } else {
    el.innerHTML = `<div class="text-center py-8 text-red-400 text-xs">${escapeHtml(data.error)}</div>`;
  }
}

// ── Message rendering ───────────────────────────────

function createMessageEl(role, content, isStreaming = false) {
  const div = document.createElement('div');
  div.className = `chat-message ${role}${isStreaming ? ' streaming' : ''}`;
  const avatarText = role === 'user' ? 'U' : 'AI';
  const roleLabel = role === 'user' ? 'You' : 'ChatGPT';
  div.innerHTML = `
    <div class="msg-avatar">${avatarText}</div>
    <div class="msg-body">
      <div class="msg-role">${roleLabel}</div>
      <div class="msg-content">${renderMarkdown(content)}</div>
      <div class="msg-actions">
        <button class="msg-action-btn" onclick="copyMessageText(this)">Copy</button>
      </div>
    </div>
  `;
  // Store raw content for copy
  div.dataset.rawContent = content;
  return div;
}

function renderMessages(messages) {
  const el = document.getElementById('messages');
  if (!messages || messages.length === 0) {
    el.innerHTML = '<div class="empty-state"><h3>No messages</h3></div>';
    return;
  }
  el.innerHTML = '';
  messages.forEach((msg) => {
    const div = createMessageEl(msg.role, msg.content);
    // Add image thumbnails if any
    if (msg.images && msg.images.length > 0) {
      const imgWrap = document.createElement('div');
      imgWrap.className = 'flex flex-wrap gap-2 mt-2';
      msg.images.forEach(img => {
        imgWrap.innerHTML += `<img src="${escapeAttr(img.src)}" alt="${escapeAttr(img.alt || '')}" class="max-h-48 rounded cursor-pointer" onclick="openImageModal('${escapeAttr(img.src)}', '${escapeAttr(img.alt || '')}')" loading="lazy">`;
      });
      div.querySelector('.msg-body').appendChild(imgWrap);
    }
    el.appendChild(div);
  });
  el.scrollTop = el.scrollHeight;
}

function renderRaw(messages) {
  const el = document.getElementById('raw-content');
  const text = messages.map(m => `=== ${m.role.toUpperCase()} ===\n${m.content}\n`).join('\n');
  el.textContent = text;
}

function renderMarkdown(text) {
  if (!text) return '';
  if (typeof marked !== 'undefined') {
    try { return marked.parse(text); } catch { /* fall through */ }
  }
  return escapeHtml(text).replace(/\n/g, '<br>');
}

// ── Images ──────────────────────────────────────────

async function loadImages(id) {
  const data = await apiFetch(`/sessions/${id}/images`);
  if (data.ok) {
    currentImages = data.images;
    renderImagesGrid(data.images);
  }
}

function renderImagesGrid(images) {
  const el = document.getElementById('images-grid');
  if (!images || images.length === 0) {
    el.innerHTML = '<div class="col-span-full text-center py-16 text-text-faint text-sm">No images in this session</div>';
    return;
  }
  el.innerHTML = images.map(img => `
    <div class="image-card" onclick="openImageModal('${escapeAttr(img.src)}', '${escapeAttr(img.alt || '')}')">
      <img src="${escapeAttr(img.src)}" alt="${escapeAttr(img.alt || '')}" loading="lazy">
      <div class="image-meta">${escapeHtml(img.alt || 'Generated image')}</div>
    </div>
  `).join('');
}

// ── Send Prompt (Chat + Agent modes) ────────────────

async function sendPrompt() {
  const input = document.getElementById('prompt-input');
  const prompt = input.value.trim();
  if (!prompt || isBusy) return;
  if (!currentSessionId) {
    toast('Select a session first', 'error');
    return;
  }

  isBusy = true;
  document.getElementById('btn-send').disabled = true;
  document.getElementById('thinking-indicator').classList.remove('hidden');
  input.value = '';
  input.style.height = 'auto';

  // Show user message immediately
  const container = document.getElementById('messages');
  if (currentMessages.length === 0 && !container.querySelector('.chat-message')) {
    container.innerHTML = '';
  }
  container.appendChild(createMessageEl('user', prompt));
  container.scrollTop = container.scrollHeight;

  try {
    if (currentMode === 'agent') {
      await sendAgentPrompt(prompt);
    } else {
      await sendChatPrompt(prompt);
    }
  } catch (err) {
    toast(`Error: ${err.message}`, 'error');
  } finally {
    isBusy = false;
    document.getElementById('btn-send').disabled = !input.value.trim();
    document.getElementById('thinking-indicator').classList.add('hidden');
  }
}

async function sendChatPrompt(prompt) {
  const repoContext = document.getElementById('repo-context-toggle').checked;
  const repoPath = document.getElementById('repo-path').value.trim();
  const body = { prompt };
  if (repoContext && repoPath && currentMode === 'agent') {
    body.repoContext = true;
    body.repoPath = repoPath;
  }

  const resp = await fetch(`${API}/api/sessions/${currentSessionId}/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await resp.json();

  if (data.ok) {
    // Streaming preview already handled via WS; reload to get final state.
    await loadMessages(currentSessionId);
    await loadImages(currentSessionId);
  } else {
    toast(`Error: ${data.error}`, 'error');
  }
}

async function sendAgentPrompt(prompt) {
  const repoPath = document.getElementById('repo-path').value.trim();
  const repoContext = document.getElementById('repo-context-toggle').checked;

  if (!repoPath) {
    toast('Agent mode requires a repo path', 'error');
    return;
  }

  // Close any existing SSE
  if (agentEventSource) agentEventSource.close();

  const container = document.getElementById('messages');
  const body = { prompt, repoPath };
  if (repoContext) body.repoContext = true;

  // Use fetch + ReadableStream for SSE (EventSource doesn't support POST)
  const resp = await fetch(`${API}/api/sessions/${currentSessionId}/agent?stream=1`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try { handleAgentEvent(JSON.parse(line.slice(6)), container); } catch {}
      }
    }
  }
}

// ── Agent event handling ────────────────────────────

function handleAgentEvent(evt, container) {
  switch (evt.type) {
    case 'start':
      // Clear streaming element if present
      if (streamingEl) { streamingEl.remove(); streamingEl = null; }
      break;

    case 'agent':
      handleAgentStep(evt, container);
      break;

    case 'done':
      document.getElementById('thinking-indicator').classList.add('hidden');
      if (evt.finalText) {
        const el = createMessageEl('assistant', evt.finalText);
        container.appendChild(el);
        container.scrollTop = container.scrollHeight;
      }
      toast(`Agent done (${evt.iterations} iterations)`, 'success');
      // Reload full message history
      loadMessages(currentSessionId);
      break;

    case 'error':
      toast(`Agent error: ${evt.error}`, 'error');
      break;
  }
}

function handleAgentStep(evt, container) {
  switch (evt.type) {
    case 'iteration':
      const iter = document.createElement('div');
      iter.className = 'agent-iteration';
      iter.textContent = `Iteration ${evt.index}`;
      container.appendChild(iter);
      container.scrollTop = container.scrollHeight;
      break;

    case 'tool_call':
      const card = document.createElement('div');
      card.className = 'tool-card';
      card.dataset.toolCallId = `${evt.iteration}-${evt.tool}-${Date.now()}`;
      const argsStr = JSON.stringify(evt.args);
      card.innerHTML = `
        <div class="tool-card-header" onclick="this.parentElement.classList.toggle('expanded')">
          <span class="tool-name">${escapeHtml(evt.tool)}</span>
          <span class="tool-args">${escapeHtml(argsStr)}</span>
          <span class="tool-status">running...</span>
        </div>
        <div class="tool-card-body"><pre>Executing...</pre></div>
      `;
      container.appendChild(card);
      container.scrollTop = container.scrollHeight;
      break;

    case 'tool_result':
      // Update the last tool card for this iteration
      const cards = container.querySelectorAll('.tool-card');
      const lastCard = cards[cards.length - 1];
      if (lastCard) {
        const status = lastCard.querySelector('.tool-status');
        const body = lastCard.querySelector('.tool-card-body pre');
        if (evt.error) {
          status.textContent = 'error';
          status.className = 'tool-status error';
          body.innerHTML = `<span class="tool-error">${escapeHtml(evt.error)}</span>`;
        } else {
          status.textContent = 'done';
          status.className = 'tool-status done';
          body.textContent = JSON.stringify(evt.result, null, 2);
        }
      }
      container.scrollTop = container.scrollHeight;
      break;

    case 'assistant':
      // Show assistant intermediate reply (may contain tool calls)
      const msg = createMessageEl('assistant', evt.content);
      container.appendChild(msg);
      container.scrollTop = container.scrollHeight;
      break;
  }
}

// ── New Chat ────────────────────────────────────────

async function newChat() {
  const data = await apiFetch('/sessions/new', { method: 'POST' });
  if (data.ok) {
    toast('New chat created', 'success');
    currentSessionId = null;
    document.getElementById('current-session-title').textContent = 'New conversation';
    document.getElementById('messages').innerHTML = `
      <div class="flex flex-col items-center justify-center h-full text-center px-6">
        <div class="w-12 h-12 rounded-full bg-accent-muted flex items-center justify-center mb-4">
          <svg class="w-6 h-6 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M8 10h8M8 14h5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
        </div>
        <h3 class="text-base font-medium text-text-secondary mb-1">New conversation</h3>
        <p class="text-sm text-text-faint">Send a message below to start</p>
      </div>`;
    await refreshSessions();
  } else {
    toast(`Error: ${data.error}`, 'error');
  }
}

// ── Copy / Export ───────────────────────────────────

function copyMessageText(btn) {
  const msgEl = btn.closest('.chat-message');
  const content = msgEl ? msgEl.dataset.rawContent : '';
  navigator.clipboard.writeText(content).then(() => toast('Copied', 'success'));
}

async function copyAllMessages() {
  const text = currentMessages.map(m =>
    `${m.role === 'user' ? 'You' : 'ChatGPT'}:\n${m.content}`
  ).join('\n\n---\n\n');
  await navigator.clipboard.writeText(text);
  toast('All messages copied', 'success');
}

function exportMarkdown() {
  const md = currentMessages.map(m =>
    `## ${m.role === 'user' ? 'User' : 'ChatGPT'}\n\n${m.content}`
  ).join('\n\n---\n\n');
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chatgpt-export-${currentSessionId || Date.now()}.md`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Exported as Markdown', 'success');
}

// ── Image modal ─────────────────────────────────────

let modalImageUrl = '';

function openImageModal(url, alt) {
  modalImageUrl = url;
  document.getElementById('modal-image').src = url;
  document.getElementById('image-modal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('image-modal').classList.add('hidden');
}

async function copyImage() {
  if (!modalImageUrl) return;
  try {
    const resp = await fetch(modalImageUrl);
    const blob = await resp.blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    toast('Image copied', 'success');
  } catch (err) {
    toast(`Copy failed: ${err.message}`, 'error');
  }
}

async function downloadImage() {
  if (!modalImageUrl) return;
  const filename = `chatgpt_${Date.now()}.png`;
  try {
    const data = await apiFetch('/images/save', {
      method: 'POST',
      body: JSON.stringify({ url: modalImageUrl, filename }),
    });
    if (data.ok) { toast(`Saved: ${data.path}`, 'success'); return; }
  } catch {}
  // Fallback browser download
  const a = document.createElement('a');
  a.href = modalImageUrl;
  a.download = filename;
  a.target = '_blank';
  a.click();
}

async function copyImageUrl() {
  if (!modalImageUrl) return;
  await navigator.clipboard.writeText(modalImageUrl);
  toast('URL copied', 'success');
}

// ── Utilities ───────────────────────────────────────

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function escapeAttr(text) {
  if (!text) return '';
  return String(text).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 4000);
}
