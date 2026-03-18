/**
 * Agents Uni Chat — Frontend Script
 *
 * SSE-based real-time communication with the chat server.
 * Sequential message model: input is disabled while agents are processing.
 */

// ─── State ──────────────────────────────────────

let session = null;
let isProcessing = false;
let eventSource = null;
let agents = []; // { id, name, role } — for @mention autocomplete

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

  // Connect SSE
  connectSSE();

  // Setup input handlers
  setupInputHandlers();

  // Load initial relationships
  loadRelationships();
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
      break;

    case 'relationship_update':
      loadRelationships();
      // Show lightweight notification in chat
      if (data.changes && data.changes.length > 0) {
        const changeDesc = data.changes.map(c =>
          `${c.from} → ${c.to}: ${c.eventType}`
        ).join(', ');
        appendMessage({
          id: `rel-${Date.now()}`,
          role: 'system',
          content: `Relationship update: ${changeDesc}`,
          timestamp: new Date().toISOString(),
        });
      }
      break;
  }
}

// ─── Input Handling ─────────────────────────────

function setupInputHandlers() {
  // Auto-resize textarea
  messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
    handleMentionInput();
  });

  // Keyboard navigation
  messageInput.addEventListener('keydown', (e) => {
    // If mention dropdown is open, handle navigation
    if (mentionDropdown && mentionDropdown.style.display !== 'none') {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveMentionSelection(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveMentionSelection(-1);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        confirmMentionSelection();
        return;
      }
      if (e.key === 'Escape') {
        hideMentionDropdown();
        return;
      }
    }

    // Normal Enter to send
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendButton.addEventListener('click', sendMessage);

  // Click outside to close dropdown
  document.addEventListener('click', (e) => {
    if (mentionDropdown && !mentionDropdown.contains(e.target) && e.target !== messageInput) {
      hideMentionDropdown();
    }
  });

  // Create mention dropdown element
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

  // Find the @ before cursor
  const textBeforeCursor = value.substring(0, cursorPos);
  const atMatch = textBeforeCursor.match(/@(\S*)$/);

  if (!atMatch) {
    hideMentionDropdown();
    return;
  }

  mentionStartPos = cursorPos - atMatch[0].length;
  const query = atMatch[1].toLowerCase();

  // Filter agents by query
  mentionFilteredAgents = [
    { id: '_all', name: 'all', role: 'Everyone' },
    ...agents,
  ].filter(a =>
    a.id.toLowerCase().includes(query) ||
    a.name.toLowerCase().includes(query)
  );

  if (mentionFilteredAgents.length === 0) {
    hideMentionDropdown();
    return;
  }

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

    item.addEventListener('mouseenter', () => {
      mentionSelectedIndex = index;
      renderMentionDropdown();
    });

    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      mentionSelectedIndex = index;
      confirmMentionSelection();
    });

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

  // Replace @query with @name
  const before = value.substring(0, mentionStartPos);
  const after = value.substring(cursorPos);
  const mentionText = agent.id === '_all' ? '@all ' : `@${agent.name} `;

  messageInput.value = before + mentionText + after;

  // Move cursor after the mention
  const newPos = mentionStartPos + mentionText.length;
  messageInput.selectionStart = newPos;
  messageInput.selectionEnd = newPos;

  hideMentionDropdown();
  messageInput.focus();
}

function hideMentionDropdown() {
  if (mentionDropdown) {
    mentionDropdown.style.display = 'none';
  }
  mentionStartPos = -1;
  mentionFilteredAgents = [];
}

async function sendMessage() {
  const content = messageInput.value.trim();
  if (!content || isProcessing) return;

  // Clear input immediately
  messageInput.value = '';
  messageInput.style.height = 'auto';

  // Send via HTTP (SSE will broadcast the messages)
  try {
    setProcessingState(true);

    const res = await fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });

    if (!res.ok) {
      const error = await res.json();
      showError(error.error || 'Failed to send message');
      setProcessingState(false);
    }
    // Success: SSE will handle status_change back to idle
  } catch (err) {
    showError('Network error. Please check your connection.');
    setProcessingState(false);
  }
}

// ─── Rendering ──────────────────────────────────

function renderParticipants(agents) {
  participantList.innerHTML = '';

  // Add user first
  const userItem = createParticipantItem({
    id: 'user',
    name: 'You',
    role: 'Ruler',
  }, '#7c5cfc');
  participantList.appendChild(userItem);

  // Add agents
  for (const agent of agents) {
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
    div.addEventListener('click', () => insertMention(agent.name));
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

function renderExistingMessages(messages) {
  if (!messages || messages.length === 0) return;

  // Clear welcome message
  const welcome = messagesContainer.querySelector('.welcome-message');
  if (welcome) welcome.remove();

  // Render all messages
  for (const msg of messages) {
    appendMessage(msg, false);
  }
}

function appendMessage(msg, animate = true) {
  // Remove welcome message if present
  const welcome = messagesContainer.querySelector('.welcome-message');
  if (welcome) welcome.remove();

  // Remove processing indicator if agent message
  if (msg.role === 'agent') {
    removeProcessingIndicator();
  }

  const div = document.createElement('div');
  div.className = `message ${msg.role}`;
  if (!animate) div.style.animation = 'none';

  const avatarColor = msg.role === 'user'
    ? '#7c5cfc'
    : getAgentColor(msg.agentId || 'system');

  const senderName = msg.role === 'user'
    ? 'You'
    : (msg.agentName || msg.agentId || 'System');

  const avatarChar = senderName.charAt(0).toUpperCase();
  const time = new Date(msg.timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  div.innerHTML = `
    <div class="message-avatar" style="background: ${avatarColor}">${avatarChar}</div>
    <div class="message-body">
      <div class="message-sender">${escapeHtml(senderName)}</div>
      <div class="message-content">${highlightMentions(escapeHtml(msg.content))}</div>
      <div class="message-time">${time}</div>
    </div>
  `;

  messagesContainer.appendChild(div);
  scrollToBottom();
}

function showProcessingIndicator() {
  // Don't duplicate
  if (messagesContainer.querySelector('.processing-indicator')) return;

  const div = document.createElement('div');
  div.className = 'processing-indicator';
  div.innerHTML = `
    <div class="typing-dots">
      <span></span><span></span><span></span>
    </div>
    <span>Agents are thinking...</span>
  `;
  messagesContainer.appendChild(div);
  scrollToBottom();
}

function removeProcessingIndicator() {
  const indicator = messagesContainer.querySelector('.processing-indicator');
  if (indicator) indicator.remove();
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
    showProcessingIndicator();
  } else {
    statusDot.className = 'status-dot idle';
    statusText.textContent = 'Ready';
    messageInput.disabled = false;
    sendButton.disabled = false;
    messageInput.placeholder = 'Type your message...';
    inputHint.innerHTML = 'Press <kbd>Enter</kbd> to send, <kbd>Shift+Enter</kbd> for new line';
    removeProcessingIndicator();
    messageInput.focus();
  }
}

function showError(message) {
  const msg = {
    id: `err-${Date.now()}`,
    role: 'system',
    content: `Error: ${message}`,
    timestamp: new Date().toISOString(),
  };
  appendMessage(msg);
}

// ─── Relationships ──────────────────────────────

let relViewMode = 'list'; // 'list' or 'graph'
let relNetwork = null;
let lastVizData = null;

async function loadRelationships() {
  try {
    const res = await fetch('/api/relations');
    const vizData = await res.json();
    lastVizData = vizData;

    if (relViewMode === 'list') {
      renderRelationships(vizData);
    } else {
      renderRelationshipGraph(vizData);
    }
  } catch {
    // Silently fail
  }
}

function setRelView(mode) {
  relViewMode = mode;
  document.getElementById('listViewBtn').classList.toggle('active', mode === 'list');
  document.getElementById('graphViewBtn').classList.toggle('active', mode === 'graph');
  document.getElementById('relationshipList').style.display = mode === 'list' ? '' : 'none';
  document.getElementById('relationshipGraph').style.display = mode === 'graph' ? '' : 'none';

  if (lastVizData) {
    if (mode === 'list') {
      renderRelationships(lastVizData);
    } else {
      renderRelationshipGraph(lastVizData);
    }
  }
}

function renderRelationships(vizData) {
  // Convert VisualizationData edges to the list format
  const relations = vizData.edges || [];
  if (!relations || relations.length === 0) {
    relationshipList.innerHTML = '<div class="empty-state">No relationship data yet</div>';
    return;
  }

  relationshipList.innerHTML = '';

  for (const edge of relations) {
    if (!edge.dimensions || edge.dimensions.length === 0) continue;

    const div = document.createElement('div');
    div.className = 'relationship-item';

    const dims = edge.dimensions
      .filter(d => Math.abs(d.value) > 0.1)
      .map(d => {
        const cls = d.value >= 0 ? 'positive' : 'negative';
        const sign = d.value >= 0 ? '+' : '';
        return `<span class="rel-dim ${cls}">${d.type} ${sign}${d.value.toFixed(1)}</span>`;
      })
      .join(' ');

    div.innerHTML = `
      <span class="rel-agents">${escapeHtml(edge.from)} → ${escapeHtml(edge.to)}</span>
      ${dims}
    `;
    relationshipList.appendChild(div);
  }
}

function renderRelationshipGraph(vizData) {
  const container = document.getElementById('relationshipGraph');
  if (!container || typeof vis === 'undefined') return;

  const CLUSTER_COLORS = [
    '#7c5cfc', '#f472b6', '#34d399', '#fbbf24',
    '#60a5fa', '#c084fc', '#fb923c', '#2dd4bf',
  ];

  const clusterColorMap = {};
  (vizData.clusters || []).forEach((c, i) => {
    clusterColorMap[c.id] = CLUSTER_COLORS[i % CLUSTER_COLORS.length];
  });

  const nodes = new vis.DataSet((vizData.nodes || []).map(n => ({
    id: n.id,
    label: n.label || n.id,
    size: 10 + n.influence * 20,
    color: {
      background: clusterColorMap[n.clusterId] || '#64748b',
      border: '#334155',
      highlight: { background: '#c084fc', border: '#7c3aed' },
    },
    font: { color: '#e0e0e8', size: 10 },
  })));

  const edges = new vis.DataSet((vizData.edges || []).map(e => ({
    id: e.id,
    from: e.from,
    to: e.to,
    width: 1 + e.strength * 3,
    color: {
      color: e.valence > 0.1 ? '#4ade80' : e.valence < -0.1 ? '#f87171' : '#64748b',
    },
    arrows: 'to',
    smooth: { type: 'curvedCW', roundness: 0.2 },
  })));

  if (relNetwork) {
    relNetwork.destroy();
  }

  relNetwork = new vis.Network(container, { nodes, edges }, {
    physics: { barnesHut: { gravitationalConstant: -2000, springLength: 100 } },
    interaction: { hover: true },
    layout: { improvedLayout: true },
  });
}

// ─── Utilities ──────────────────────────────────

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Highlight @mentions in message text with colored spans.
 * Input is already HTML-escaped.
 */
function highlightMentions(escapedText) {
  return escapedText.replace(/@(\S+)/g, (match, name) => {
    const lower = name.toLowerCase();
    // Check if it's a known agent or "all"
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

/**
 * Insert @mention for a specific agent into the input.
 */
function insertMention(agentName) {
  const value = messageInput.value;
  const suffix = value.length > 0 && !value.endsWith(' ') ? ' ' : '';
  messageInput.value = value + suffix + '@' + agentName + ' ';
  messageInput.focus();
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// ─── Start ──────────────────────────────────────

init();
