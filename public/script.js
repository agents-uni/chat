/**
 * Agents Uni Chat — Frontend Script
 *
 * SSE-based real-time communication with the chat server.
 * Features: theme toggle, agent thinking indicators, search, export,
 * agent popover, toast notifications, timeline, mode selector.
 */

// ─── State ──────────────────────────────────────

let session = null;
let isProcessing = false;
let eventSource = null;
let agents = []; // { id, name, role } — for @mention autocomplete
let isComposing = false; // IME composition guard
let thinkingAgents = new Map(); // agentId → agentName

// Agent colors (rotate through these)
const AGENT_COLORS = [
  '#7c5cfc', '#f472b6', '#34d399', '#fbbf24',
  '#60a5fa', '#c084fc', '#fb923c', '#2dd4bf',
];
const agentColorMap = new Map();
let colorIndex = 0;

function getAgentColor(agentId) {
  if (!agentColorMap.has(agentId)) {
    agentColorMap.set(agentId, AGENT_COLORS[colorIndex % AGENT_COLORS.length]);
    colorIndex++;
  }
  return agentColorMap.get(agentId);
}

// ─── DOM Elements ───────────────────────────────

const messagesContainer = document.getElementById('messagesContainer');
const messageInput = document.getElementById('messageInput');
const sendButton = document.getElementById('sendButton');
const chatStatus = document.getElementById('chatStatus');
const universeName = document.getElementById('universeName');
const participantList = document.getElementById('participantList');
const relationshipList = document.getElementById('relationshipList');
const agentCount = document.getElementById('agentCount');
const chatTitle = document.getElementById('chatTitle');
const inputHint = document.getElementById('inputHint');

// ─── Initialize ─────────────────────────────────

async function init() {
  // Restore theme
  const savedTheme = localStorage.getItem('agents-chat-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcon(savedTheme);

  // Load initial config
  try {
    const configRes = await fetch('/api/config');
    const config = await configRes.json();

    universeName.textContent = config.name;
    chatTitle.textContent = `${config.name} · Group Chat`;
    agentCount.textContent = `${config.agents.length} agents`;
    document.title = `${config.name} · Agents Chat`;

    agents = config.agents;
    renderParticipants(config.agents);
  } catch (err) {
    console.error('Failed to load config:', err);
  }

  // Load current mode
  try {
    const modeRes = await fetch('/api/mode');
    const modeData = await modeRes.json();
    document.getElementById('modeSelector').value = modeData.mode;
  } catch {
    // default
  }

  // Connect SSE
  connectSSE();

  // Setup input handlers
  setupInputHandlers();

  // Load initial relationships
  loadRelationships();
}

// ─── Theme Toggle ───────────────────────────────

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('agents-chat-theme', next);
  updateThemeIcon(next);
}

function updateThemeIcon(theme) {
  const icon = document.getElementById('themeIcon');
  if (icon) icon.textContent = theme === 'dark' ? '🌙' : '☀️';
}

// ─── Mode Selector ──────────────────────────────

async function changeMode(mode) {
  try {
    await fetch('/api/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    showToast(`Mode changed to ${mode}`, 'info');
  } catch {
    showToast('Failed to change mode', 'error');
  }
}

// ─── SSE Connection ─────────────────────────────

function connectSSE() {
  eventSource = new EventSource('/api/events');

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleServerEvent(data);
    } catch (err) {
      console.error('Failed to parse SSE message:', err);
    }
  };

  eventSource.onerror = () => {
    console.warn('SSE connection lost, reconnecting in 3s...');
    eventSource.close();
    setTimeout(connectSSE, 3000);
  };
}

function handleServerEvent(data) {
  switch (data.type) {
    case 'state':
      session = data.session;
      renderExistingMessages(session.messages);
      setProcessingState(session.status === 'processing');
      break;

    case 'chat_message':
      appendMessage(data.message);
      break;

    case 'status_change':
      setProcessingState(data.status === 'processing');
      if (data.status === 'idle') {
        thinkingAgents.clear();
        removeThinkingIndicators();
      }
      break;

    case 'agent_thinking':
      thinkingAgents.set(data.agentId, data.agentName);
      updateThinkingIndicators();
      break;

    case 'agent_done':
      thinkingAgents.delete(data.agentId);
      updateThinkingIndicators();
      break;

    case 'agent_error':
      thinkingAgents.delete(data.agentId);
      updateThinkingIndicators();
      showToast(`Agent error: ${data.error}`, 'error');
      break;

    case 'relationship_update':
      loadRelationships();
      if (data.changes && data.changes.length > 0) {
        const changeDesc = data.changes.map(c => {
          const eventMap = {
            'chat.agreement': 'consensus',
            'chat.disagreement': 'disagreement',
            'chat.collaboration': 'collaboration',
          };
          const label = eventMap[c.eventType] || c.eventType;
          return `${c.from} → ${c.to}: ${label}`;
        }).join('; ');
        showToast(`Relationship: ${changeDesc}`, 'info', 4000);
      }
      break;

    case 'mode_change':
      document.getElementById('modeSelector').value = data.mode;
      showToast(`Mode: ${data.mode}`, 'info');
      break;
  }
}

// ─── Thinking Indicators ────────────────────────

function updateThinkingIndicators() {
  removeThinkingIndicators();

  if (thinkingAgents.size === 0) return;

  const container = document.createElement('div');
  container.className = 'thinking-agents';
  container.id = 'thinkingIndicator';

  for (const [agentId, agentName] of thinkingAgents) {
    const color = getAgentColor(agentId);
    const initial = agentName.charAt(0).toUpperCase();
    const item = document.createElement('div');
    item.className = 'thinking-agent';
    item.innerHTML = `
      <div class="thinking-agent-avatar" style="background: ${color}">${initial}</div>
      <span>${escapeHtml(agentName)} is thinking</span>
      <div class="typing-dots"><span></span><span></span><span></span></div>
    `;
    container.appendChild(item);
  }

  messagesContainer.appendChild(container);
  scrollToBottom();
}

function removeThinkingIndicators() {
  const el = document.getElementById('thinkingIndicator');
  if (el) el.remove();
  // Also remove legacy processing indicators
  const legacy = messagesContainer.querySelector('.processing-indicator');
  if (legacy) legacy.remove();
}

// ─── Input Handling ─────────────────────────────

function setupInputHandlers() {
  messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
    handleMentionInput();
    updateSendButtonState();
  });

  messageInput.addEventListener('compositionstart', () => { isComposing = true; });
  messageInput.addEventListener('compositionend', () => { isComposing = false; });

  messageInput.addEventListener('keydown', (e) => {
    // Mention dropdown navigation
    if (mentionDropdown && mentionDropdown.style.display !== 'none') {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveMentionSelection(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveMentionSelection(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); confirmMentionSelection(); return; }
      if (e.key === 'Escape') { hideMentionDropdown(); return; }
    }

    // Normal Enter to send
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendButton.addEventListener('click', sendMessage);
  updateSendButtonState();

  document.addEventListener('click', (e) => {
    if (mentionDropdown && !mentionDropdown.contains(e.target) && e.target !== messageInput) {
      hideMentionDropdown();
    }
    // Close popover on outside click
    const popover = document.getElementById('agentPopover');
    if (popover.classList.contains('open') && !popover.contains(e.target) && !e.target.closest('.message-avatar') && !e.target.closest('.participant-item')) {
      closeAgentPopover();
    }
  });

  // Ctrl+K for search
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      openSearchModal();
    }
  });

  createMentionDropdown();
}

// ─── @Mention Autocomplete ──────────────────────

let mentionDropdown = null;
let mentionSelectedIndex = 0;
let mentionFilteredAgents = [];
let mentionStartPos = -1;

function createMentionDropdown() {
  mentionDropdown = document.createElement('div');
  mentionDropdown.className = 'mention-dropdown';
  mentionDropdown.style.display = 'none';
  document.querySelector('.input-wrapper').appendChild(mentionDropdown);
}

function handleMentionInput() {
  const value = messageInput.value;
  const cursorPos = messageInput.selectionStart;
  const textBeforeCursor = value.substring(0, cursorPos);
  const atMatch = textBeforeCursor.match(/@(\S*)$/);

  if (!atMatch) { hideMentionDropdown(); return; }

  mentionStartPos = cursorPos - atMatch[0].length;
  const query = atMatch[1].toLowerCase();

  mentionFilteredAgents = [
    { id: '_all', name: 'all', role: 'Everyone' },
    ...agents,
  ].filter(a => a.id.toLowerCase().includes(query) || a.name.toLowerCase().includes(query));

  if (mentionFilteredAgents.length === 0) { hideMentionDropdown(); return; }

  mentionSelectedIndex = 0;
  renderMentionDropdown();
}

function renderMentionDropdown() {
  mentionDropdown.innerHTML = '';
  mentionDropdown.style.display = 'block';

  mentionFilteredAgents.forEach((agent, index) => {
    const item = document.createElement('div');
    item.className = 'mention-item' + (index === mentionSelectedIndex ? ' selected' : '');
    const color = agent.id === '_all' ? '#fbbf24' : getAgentColor(agent.id);
    const initial = agent.name.charAt(0).toUpperCase();
    item.innerHTML = `
      <span class="mention-avatar" style="background: ${color}">${initial}</span>
      <span class="mention-name">${escapeHtml(agent.name)}</span>
      <span class="mention-role">${escapeHtml(agent.role)}</span>
    `;
    item.addEventListener('mouseenter', () => { mentionSelectedIndex = index; renderMentionDropdown(); });
    item.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); mentionSelectedIndex = index; confirmMentionSelection(); });
    mentionDropdown.appendChild(item);
  });
}

function moveMentionSelection(delta) {
  mentionSelectedIndex = (mentionSelectedIndex + delta + mentionFilteredAgents.length) % mentionFilteredAgents.length;
  renderMentionDropdown();
}

function confirmMentionSelection() {
  if (mentionFilteredAgents.length === 0) return;
  const agent = mentionFilteredAgents[mentionSelectedIndex];
  const value = messageInput.value;
  const cursorPos = messageInput.selectionStart;
  const before = value.substring(0, mentionStartPos);
  const after = value.substring(cursorPos);
  const mentionText = agent.id === '_all' ? '@all ' : `@${agent.name} `;
  messageInput.value = before + mentionText + after;
  const newPos = mentionStartPos + mentionText.length;
  messageInput.selectionStart = newPos;
  messageInput.selectionEnd = newPos;
  hideMentionDropdown();
  messageInput.focus();
}

function hideMentionDropdown() {
  if (mentionDropdown) mentionDropdown.style.display = 'none';
  mentionStartPos = -1;
  mentionFilteredAgents = [];
}

async function sendMessage() {
  const content = messageInput.value.trim();
  if (!content || isProcessing) return;

  messageInput.value = '';
  messageInput.style.height = 'auto';
  updateSendButtonState();

  try {
    setProcessingState(true);
    const res = await fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });

    if (!res.ok) {
      const error = await res.json();
      showToast(error.error || 'Failed to send message', 'error');
      setProcessingState(false);
    }
  } catch {
    showToast('Network error. Please check your connection.', 'error');
    setProcessingState(false);
  }
}

// ─── Rendering ──────────────────────────────────

function renderParticipants(agentsList) {
  participantList.innerHTML = '';

  const userItem = createParticipantItem({ id: 'user', name: 'You', role: 'Ruler' }, '#7c5cfc');
  participantList.appendChild(userItem);

  for (const agent of agentsList) {
    const color = getAgentColor(agent.id);
    const item = createParticipantItem(agent, color);
    participantList.appendChild(item);
  }
}

function createParticipantItem(agent, color) {
  const div = document.createElement('div');
  div.className = 'participant-item';
  if (agent.id !== 'user') {
    div.title = `Click to @${agent.name}`;
    div.style.cursor = 'pointer';
    div.addEventListener('click', (e) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        showAgentPopover(agent.id, e.currentTarget);
      } else {
        insertMention(agent.name);
      }
    });
  }
  div.innerHTML = `
    <div class="participant-avatar" style="background: ${color}">
      ${agent.name.charAt(0).toUpperCase()}
    </div>
    <div class="participant-info">
      <div class="participant-name">${escapeHtml(agent.name)}</div>
      <div class="participant-role">${escapeHtml(agent.role)}</div>
    </div>
  `;
  return div;
}

let msgCounter = 0;

function renderExistingMessages(messages) {
  if (!messages || messages.length === 0) return;
  const welcome = messagesContainer.querySelector('.welcome-message');
  if (welcome) welcome.remove();
  for (const msg of messages) {
    appendMessage(msg, false);
  }
}

function appendMessage(msg, animate = true) {
  const welcome = messagesContainer.querySelector('.welcome-message');
  if (welcome) welcome.remove();

  if (msg.role === 'agent') {
    removeThinkingIndicators();
  }

  const div = document.createElement('div');
  div.className = `message ${msg.role}`;
  div.setAttribute('data-msg-id', msg.id);
  if (!animate) div.style.animation = 'none';

  const avatarColor = msg.role === 'user' ? '#7c5cfc' : getAgentColor(msg.agentId || 'system');
  const senderName = msg.role === 'user' ? 'You' : (msg.agentName || msg.agentId || 'System');
  const avatarChar = senderName.charAt(0).toUpperCase();
  const time = new Date(msg.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

  const escapedContent = escapeHtml(msg.content);
  const renderedContent = msg.role === 'agent' ? renderMarkdown(escapedContent) : highlightMentions(escapedContent);

  if (msg.role === 'system') {
    div.innerHTML = `<div class="message-body"><div class="message-content">${renderedContent}</div></div>`;
  } else {
    const avatarOnClick = msg.role === 'agent' && msg.agentId
      ? `onclick="showAgentPopover('${escapeHtml(msg.agentId)}', this)"`
      : '';
    div.innerHTML = `
      <div class="message-avatar" style="background: ${avatarColor}" ${avatarOnClick}>${avatarChar}</div>
      <div class="message-body">
        <div class="message-sender">${escapeHtml(senderName)}</div>
        <div class="message-content">${renderedContent}</div>
        <div class="message-time">${time}</div>
      </div>
    `;
  }

  messagesContainer.appendChild(div);
  scrollToBottom();
}

function setProcessingState(processing) {
  isProcessing = processing;
  const statusDot = chatStatus.querySelector('.status-dot');
  const statusText = chatStatus.querySelector('.status-text');

  if (processing) {
    statusDot.className = 'status-dot processing';
    statusText.textContent = 'Processing...';
    messageInput.disabled = true;
    sendButton.disabled = true;
    messageInput.placeholder = 'Waiting for agents...';
    inputHint.textContent = 'Agents are generating responses...';
  } else {
    statusDot.className = 'status-dot idle';
    statusText.textContent = 'Ready';
    messageInput.disabled = false;
    sendButton.disabled = false;
    messageInput.placeholder = 'Type your message...';
    inputHint.innerHTML = 'Press <kbd>Enter</kbd> to send, <kbd>Shift+Enter</kbd> for new line · <kbd>Ctrl+K</kbd> search';
    removeThinkingIndicators();
    messageInput.focus();
  }
}

// ─── Toast Notifications ────────────────────────

const toastQueue = [];
const MAX_TOASTS = 3;

function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toastContainer');
  const icons = { info: 'ℹ️', success: '✓', warning: '⚠️', error: '✕' };

  // Limit toasts
  while (container.children.length >= MAX_TOASTS) {
    container.removeChild(container.firstChild);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ─── Search Modal ───────────────────────────────

function openSearchModal() {
  const modal = document.getElementById('searchModal');
  modal.classList.add('open');
  const input = document.getElementById('searchInput');
  input.value = '';
  input.focus();
  document.getElementById('searchResults').innerHTML = '<div class="search-empty">Type to search messages...</div>';

  input.addEventListener('input', debounce(handleSearchInput, 200));
}

function closeSearchModal() {
  document.getElementById('searchModal').classList.remove('open');
}

function handleSearchInput() {
  const query = document.getElementById('searchInput').value.trim().toLowerCase();
  const resultsDiv = document.getElementById('searchResults');

  if (!query) {
    resultsDiv.innerHTML = '<div class="search-empty">Type to search messages...</div>';
    return;
  }

  const allMessages = session?.messages || [];
  const matches = allMessages.filter(m => m.content.toLowerCase().includes(query));

  if (matches.length === 0) {
    resultsDiv.innerHTML = '<div class="search-empty">No results found</div>';
    return;
  }

  resultsDiv.innerHTML = '';
  for (const msg of matches.slice(0, 30)) {
    const sender = msg.role === 'user' ? 'You' : (msg.agentName || msg.agentId || 'System');
    const highlighted = escapeHtml(msg.content).replace(
      new RegExp(`(${escapeRegExp(query)})`, 'gi'),
      '<mark>$1</mark>'
    );

    const item = document.createElement('div');
    item.className = 'search-result-item';
    item.innerHTML = `
      <div class="search-result-sender">${escapeHtml(sender)}</div>
      <div class="search-result-content">${highlighted.slice(0, 200)}${msg.content.length > 200 ? '...' : ''}</div>
    `;
    item.addEventListener('click', () => {
      closeSearchModal();
      const msgEl = messagesContainer.querySelector(`[data-msg-id="${msg.id}"]`);
      if (msgEl) {
        msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        msgEl.style.outline = '2px solid var(--accent)';
        setTimeout(() => { msgEl.style.outline = ''; }, 2000);
      }
    });
    resultsDiv.appendChild(item);
  }
}

// ESC/click outside to close search
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.getElementById('searchModal').classList.contains('open')) {
      closeSearchModal();
      return;
    }
    if (document.getElementById('graphModal').classList.contains('open')) {
      closeGraphModal();
      return;
    }
    closeAgentPopover();
  }
});

document.getElementById('searchModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeSearchModal();
});

// ─── Export ─────────────────────────────────────

async function exportConversation() {
  try {
    const res = await fetch('/api/export?format=markdown');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat-export-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Conversation exported', 'success');
  } catch {
    showToast('Export failed', 'error');
  }
}

// ─── Agent Detail Popover ───────────────────────

function showAgentPopover(agentId, triggerEl) {
  const agent = agents.find(a => a.id === agentId);
  if (!agent) return;

  const popover = document.getElementById('agentPopover');
  const content = document.getElementById('agentPopoverContent');
  const color = getAgentColor(agentId);

  // Build traits display
  const traits = agent.traits || {};
  const traitsHtml = Object.entries(traits).length > 0
    ? Object.entries(traits).map(([k, v]) => `<span class="popover-trait">${escapeHtml(k)}: ${(v * 100).toFixed(0)}%</span>`).join('')
    : '<span class="popover-trait">No traits defined</span>';

  // Build relationship info
  let relsHtml = '';
  if (lastVizData && lastVizData.edges) {
    const relEdges = lastVizData.edges.filter(e => e.from === agentId || e.to === agentId);
    if (relEdges.length > 0) {
      relsHtml = relEdges.slice(0, 5).map(e => {
        const otherId = e.from === agentId ? e.to : e.from;
        const dims = (e.dimensions || []).filter(d => Math.abs(d.value) > 0.1)
          .map(d => `${d.type}: ${d.value > 0 ? '+' : ''}${d.value.toFixed(1)}`).join(', ');
        return `<div class="popover-rel-item">${escapeHtml(otherId)}: ${dims || 'neutral'}</div>`;
      }).join('');
    }
  }

  content.innerHTML = `
    <div class="popover-header">
      <div class="popover-avatar" style="background: ${color}">${agent.name.charAt(0).toUpperCase()}</div>
      <div>
        <div class="popover-name">${escapeHtml(agent.name)}</div>
        <div class="popover-role">${escapeHtml(agent.role)}${agent.department ? ` · ${escapeHtml(agent.department)}` : ''}</div>
      </div>
    </div>
    <div class="popover-section">
      <div class="popover-section-title">Traits</div>
      <div class="popover-traits">${traitsHtml}</div>
    </div>
    ${relsHtml ? `<div class="popover-section"><div class="popover-section-title">Relationships</div>${relsHtml}</div>` : ''}
  `;

  // Position
  const rect = triggerEl.getBoundingClientRect();
  const isMobile = window.innerWidth <= 768;

  if (isMobile) {
    popover.style.left = '0';
    popover.style.right = '0';
    popover.style.bottom = '0';
    popover.style.top = 'auto';
  } else {
    popover.style.left = (rect.left + rect.width + 8) + 'px';
    popover.style.top = rect.top + 'px';
    popover.style.right = 'auto';
    popover.style.bottom = 'auto';
  }

  popover.classList.add('open');
}

function closeAgentPopover() {
  document.getElementById('agentPopover').classList.remove('open');
}

// ─── Relationships ──────────────────────────────

let relViewMode = 'list';
let relNetwork = null;
let lastVizData = null;

async function loadRelationships() {
  try {
    const res = await fetch('/api/relations');
    const vizData = await res.json();
    lastVizData = vizData;

    if (relViewMode === 'list') {
      renderRelationships(vizData);
    } else if (relViewMode === 'graph') {
      renderRelationshipGraph(vizData);
    } else if (relViewMode === 'timeline') {
      loadTimeline();
    }
  } catch {
    // Silently fail
  }
}

function setRelView(mode) {
  relViewMode = mode;
  document.getElementById('listViewBtn').classList.toggle('active', mode === 'list');
  document.getElementById('graphViewBtn').classList.toggle('active', mode === 'graph');
  document.getElementById('timelineViewBtn').classList.toggle('active', mode === 'timeline');
  document.getElementById('relationshipList').style.display = mode === 'list' ? '' : 'none';
  document.getElementById('relationshipGraph').style.display = mode === 'graph' ? '' : 'none';
  document.getElementById('relationshipTimeline').style.display = mode === 'timeline' ? '' : 'none';

  if (mode === 'timeline') {
    loadTimeline();
  } else if (lastVizData) {
    if (mode === 'list') renderRelationships(lastVizData);
    else renderRelationshipGraph(lastVizData);
  }
}

// ─── Timeline ───────────────────────────────────

async function loadTimeline() {
  const container = document.getElementById('relationshipTimeline');
  try {
    const res = await fetch('/api/relations/timeline');
    const events = await res.json();

    if (!events || events.length === 0) {
      container.innerHTML = '<div class="empty-state">No relationship events yet</div>';
      return;
    }

    container.innerHTML = '';
    for (const evt of events.slice(0, 30)) {
      const dotClass = evt.type.includes('agreement') || evt.type.includes('consensus') ? 'consensus'
        : evt.type.includes('disagree') ? 'disagreement'
        : evt.type.includes('collab') ? 'collaboration' : 'default';

      const time = new Date(evt.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const div = document.createElement('div');
      div.className = 'timeline-event';
      div.innerHTML = `
        <div class="timeline-dot ${dotClass}"></div>
        <div class="timeline-info">
          <div class="timeline-desc">${escapeHtml(evt.from)} → ${escapeHtml(evt.to)}: ${escapeHtml(evt.type.replace('chat.', ''))}</div>
          ${evt.description ? `<div class="timeline-meta">${escapeHtml(evt.description.slice(0, 80))}</div>` : ''}
          <div class="timeline-meta">${time}</div>
        </div>
      `;
      container.appendChild(div);
    }
  } catch {
    container.innerHTML = '<div class="empty-state">Failed to load timeline</div>';
  }
}

function renderRelationshipGraph(vizData) {
  const container = document.getElementById('relationshipGraph');
  if (!container || typeof vis === 'undefined') return;
  if (relNetwork) relNetwork.destroy();
  const { nodes, edges, options } = createGraphConfig(vizData);
  relNetwork = new vis.Network(container, { nodes, edges }, options);
}

function createGraphConfig(vizData) {
  const CLUSTER_COLORS = ['#7c5cfc', '#f472b6', '#34d399', '#fbbf24', '#60a5fa', '#c084fc', '#fb923c', '#2dd4bf'];
  const clusterColorMap = {};
  (vizData.clusters || []).forEach((c, i) => { clusterColorMap[c.id] = CLUSTER_COLORS[i % CLUSTER_COLORS.length]; });

  const nodeValence = {};
  (vizData.edges || []).forEach(e => {
    [e.from, e.to].forEach(nid => {
      if (!nodeValence[nid]) nodeValence[nid] = [];
      nodeValence[nid].push(e.valence || 0);
    });
  });

  const nodes = new vis.DataSet((vizData.nodes || []).map(n => {
    const baseColor = clusterColorMap[n.clusterId] || '#64748b';
    const vals = nodeValence[n.id] || [0];
    const avgValence = vals.reduce((a, b) => a + b, 0) / vals.length;
    const glowColor = avgValence > 0.1 ? 'rgba(74,222,128,0.4)' : avgValence < -0.1 ? 'rgba(248,113,113,0.4)' : 'rgba(100,116,139,0.3)';
    return {
      id: n.id, label: n.label || n.id,
      title: n.role ? `${n.label || n.id}\n${n.role}` : (n.label || n.id),
      size: 12 + n.influence * 22,
      color: { background: baseColor, border: glowColor, highlight: { background: '#c084fc', border: '#7c3aed' }, hover: { background: baseColor, border: '#fff' } },
      borderWidth: 3, borderWidthSelected: 4,
      font: { color: '#e0e0e8', size: 12, strokeWidth: 3, strokeColor: '#0a0a0f' },
      shadow: { enabled: true, color: glowColor, size: 10, x: 0, y: 0 },
    };
  }));

  function valenceToColor(v) {
    const clamped = Math.max(-1, Math.min(1, v));
    if (clamped >= 0) { const t = clamped; return `rgb(${Math.round(100+(74-100)*t)},${Math.round(116+(222-116)*t)},${Math.round(139+(128-139)*t)})`; }
    const t = -clamped; return `rgb(${Math.round(100+(248-100)*t)},${Math.round(116+(113-116)*t)},${Math.round(139+(113-139)*t)})`;
  }

  const edges = new vis.DataSet((vizData.edges || []).map(e => {
    const dimTooltip = (e.dimensions || []).map(d => `${d.type}: ${d.value >= 0 ? '+' : ''}${d.value.toFixed(2)}`).join('\n');
    return {
      id: e.id, from: e.from, to: e.to, width: 1 + e.strength * 4,
      title: `${e.from} → ${e.to}\n${dimTooltip}`,
      color: { color: valenceToColor(e.valence || 0), highlight: '#c084fc', hover: '#e0e0e8' },
      arrows: { to: { enabled: true, scaleFactor: 0.5 } },
      smooth: { type: 'curvedCW', roundness: 0.2 }, hoverWidth: 1.5,
    };
  }));

  const options = {
    physics: { barnesHut: { gravitationalConstant: -1500, springLength: 150, springConstant: 0.04, damping: 0.09 }, stabilization: { iterations: 100, fit: true } },
    interaction: { hover: true, tooltipDelay: 200 }, layout: { improvedLayout: true },
  };
  return { nodes, edges, options };
}

// ─── Utilities ──────────────────────────────────

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function debounce(fn, ms) {
  let timer;
  return function (...args) { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), ms); };
}

function highlightMentions(escapedText) {
  return escapedText.replace(/@(\S+)/g, (match, name) => {
    const lower = name.toLowerCase();
    const agent = agents.find(a => a.name.toLowerCase() === lower || a.id.toLowerCase() === lower);
    if (agent) {
      const color = getAgentColor(agent.id);
      return `<span class="mention-highlight" style="color: ${color}">@${escapeHtml(agent.name)}</span>`;
    }
    if (lower === 'all' || lower === '所有人' || lower === '全体') {
      return `<span class="mention-highlight mention-all">@${name}</span>`;
    }
    return match;
  });
}

function insertMention(agentName) {
  const value = messageInput.value;
  const suffix = value.length > 0 && !value.endsWith(' ') ? ' ' : '';
  messageInput.value = value + suffix + '@' + agentName + ' ';
  messageInput.focus();
}

function scrollToBottom() {
  const threshold = 100;
  const distFromBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight;
  if (distFromBottom < threshold) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

function renderMarkdown(escapedText) {
  let text = escapedText;
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => `<pre class="md-code-block"><code>${code.trim()}</code></pre>`);
  text = text.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  text = text.replace(/^([*\-]) (.+)$/gm, '<li>$2</li>');
  text = text.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul class="md-list">$1</ul>');
  text = text.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  text = text.replace(/((?:<li>.*<\/li>\n?)+)/g, (match) => match.startsWith('<ul') ? match : `<ol class="md-list">${match}</ol>`);
  text = highlightMentions(text);
  return text;
}

function updateSendButtonState() {
  const hasContent = messageInput.value.trim().length > 0;
  sendButton.classList.toggle('empty', !hasContent && !isProcessing);
}

function toggleSidebar() {
  document.querySelector('.sidebar').classList.toggle('open');
  document.querySelector('.sidebar-overlay').classList.toggle('open');
}

// ─── Fullscreen Graph Modal ─────────────────────

let modalNetwork = null;

function openGraphModal() {
  const modal = document.getElementById('graphModal');
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  if (lastVizData) renderModalGraph(lastVizData);
}

function closeGraphModal() {
  const modal = document.getElementById('graphModal');
  modal.classList.remove('open');
  document.body.style.overflow = '';
  closeModalPanel();
  if (modalNetwork) { modalNetwork.destroy(); modalNetwork = null; }
}

function renderModalGraph(vizData) {
  const container = document.getElementById('graphModalCanvas');
  if (!container || typeof vis === 'undefined') return;
  if (modalNetwork) modalNetwork.destroy();
  const { nodes, edges, options } = createGraphConfig(vizData);
  modalNetwork = new vis.Network(container, { nodes, edges }, options);
  modalNetwork.on('selectEdge', (params) => {
    if (params.edges.length === 1) {
      const edge = (vizData.edges || []).find(e => e.id === params.edges[0]);
      if (edge) showModalEdgePanel(edge);
    }
  });
  modalNetwork.on('deselectEdge', () => closeModalPanel());
}

function showModalEdgePanel(edge) {
  const panel = document.getElementById('graphModalPanel');
  panel.classList.add('open');
  const dims = edge.dimensions || [];
  const dimRows = dims.map(d => `
    <div class="edit-dim-row">
      <label class="edit-dim-label">${escapeHtml(d.type)}</label>
      <input type="range" class="edit-dim-slider" min="-1" max="1" step="0.1" value="${d.value}" data-dim="${escapeHtml(d.type)}" oninput="this.nextElementSibling.textContent = parseFloat(this.value).toFixed(1)">
      <span class="edit-dim-value">${d.value.toFixed(1)}</span>
    </div>
  `).join('');

  panel.innerHTML = `
    <div class="edit-panel-header"><h4>${escapeHtml(edge.from)} → ${escapeHtml(edge.to)}</h4><button class="edit-panel-close" onclick="closeModalPanel()">&times;</button></div>
    <div class="edit-panel-body">${dims.length === 0 ? '<p class="edit-empty">No dimension data</p>' : dimRows}</div>
    ${dims.length > 0 ? `<div class="edit-panel-footer"><button class="edit-save-btn" onclick="saveModalEdge('${escapeHtml(edge.from)}', '${escapeHtml(edge.to)}')">Save</button><button class="edit-cancel-btn" onclick="closeModalPanel()">Cancel</button></div>` : ''}
  `;
}

function closeModalPanel() {
  const panel = document.getElementById('graphModalPanel');
  panel.classList.remove('open');
  panel.innerHTML = '';
}

async function saveModalEdge(from, to) {
  const panel = document.getElementById('graphModalPanel');
  const sliders = panel.querySelectorAll('.edit-dim-slider');
  const saveBtn = panel.querySelector('.edit-save-btn');
  if (saveBtn) saveBtn.disabled = true;
  for (const slider of sliders) {
    await updateRelationDimension(from, to, slider.dataset.dim, parseFloat(slider.value));
  }
  closeModalPanel();
}

// ─── Inline Relation Editing ────────────────────

function renderRelationships(vizData) {
  const relations = vizData.edges || [];
  if (!relations || relations.length === 0) {
    relationshipList.innerHTML = '<div class="empty-state">Start a conversation to see agent relationships here</div>';
    return;
  }
  relationshipList.innerHTML = '';
  for (const edge of relations) {
    if (!edge.dimensions || edge.dimensions.length === 0) continue;
    const div = document.createElement('div');
    div.className = 'relationship-item';
    const fromColor = getAgentColor(edge.from);
    const toColor = getAgentColor(edge.to);
    const dims = edge.dimensions.filter(d => Math.abs(d.value) > 0.1).map(d => {
      const cls = d.value >= 0 ? 'positive' : 'negative';
      const sign = d.value >= 0 ? '+' : '';
      const pct = Math.min(Math.abs(d.value) * 100, 100);
      return `<div class="rel-dim-row"><span class="rel-dim ${cls}">${d.type} ${sign}${d.value.toFixed(1)}</span><div class="rel-strength-bar"><div class="rel-strength-fill ${cls}" style="width: ${pct}%"></div></div></div>`;
    }).join('');

    div.innerHTML = `
      <div class="rel-agents">
        <span style="color: ${fromColor}">${escapeHtml(edge.from)}</span>
        <span class="rel-arrow">→</span>
        <span style="color: ${toColor}">${escapeHtml(edge.to)}</span>
        <button class="rel-edit-btn" onclick="toggleInlineEdit(this, '${escapeHtml(edge.from)}', '${escapeHtml(edge.to)}')" title="Edit">&#9998;</button>
      </div>
      ${dims}
      <div class="rel-inline-edit" style="display:none;"></div>
    `;
    relationshipList.appendChild(div);
  }
}

function toggleInlineEdit(btn, from, to) {
  const item = btn.closest('.relationship-item');
  const editDiv = item.querySelector('.rel-inline-edit');
  if (editDiv.style.display !== 'none') { editDiv.style.display = 'none'; editDiv.innerHTML = ''; return; }
  const edge = (lastVizData?.edges || []).find(e => e.from === from && e.to === to);
  if (!edge || !edge.dimensions) return;
  const dimRows = edge.dimensions.map(d => `<div class="edit-dim-row"><label class="edit-dim-label">${escapeHtml(d.type)}</label><input type="range" class="edit-dim-slider" min="-1" max="1" step="0.1" value="${d.value}" data-dim="${escapeHtml(d.type)}" oninput="this.nextElementSibling.textContent = parseFloat(this.value).toFixed(1)"><span class="edit-dim-value">${d.value.toFixed(1)}</span></div>`).join('');
  editDiv.innerHTML = `${dimRows}<div class="edit-inline-actions"><button class="edit-save-btn" onclick="saveInlineEdit(this, '${escapeHtml(from)}', '${escapeHtml(to)}')">Save</button><button class="edit-cancel-btn" onclick="this.closest('.rel-inline-edit').style.display='none'">Cancel</button></div>`;
  editDiv.style.display = 'block';
}

async function saveInlineEdit(btn, from, to) {
  const editDiv = btn.closest('.rel-inline-edit');
  const sliders = editDiv.querySelectorAll('.edit-dim-slider');
  btn.disabled = true;
  for (const slider of sliders) {
    await updateRelationDimension(from, to, slider.dataset.dim, parseFloat(slider.value));
  }
  editDiv.style.display = 'none';
  editDiv.innerHTML = '';
}

async function updateRelationDimension(from, to, dimension, value) {
  await fetch('/api/relations', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, dimension, value }),
  });
  await loadRelationships();
}

// ─── Start ──────────────────────────────────────

init();
