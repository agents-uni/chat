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
      break;
  }
}

// ─── Input Handling ─────────────────────────────

function setupInputHandlers() {
  // Auto-resize textarea
  messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
  });

  // Enter to send, Shift+Enter for newline
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendButton.addEventListener('click', sendMessage);
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
      <div class="message-content">${escapeHtml(msg.content)}</div>
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

async function loadRelationships() {
  try {
    const res = await fetch('/api/relations');
    const relations = await res.json();
    renderRelationships(relations);
  } catch {
    // Silently fail
  }
}

function renderRelationships(relations) {
  if (!relations || relations.length === 0) {
    relationshipList.innerHTML = '<div class="empty-state">No relationship data yet</div>';
    return;
  }

  relationshipList.innerHTML = '';

  for (const rel of relations) {
    if (!rel.dimensions || rel.dimensions.length === 0) continue;

    const div = document.createElement('div');
    div.className = 'relationship-item';

    const dims = rel.dimensions
      .filter(d => Math.abs(d.value) > 0.1)
      .map(d => {
        const cls = d.value >= 0 ? 'positive' : 'negative';
        const sign = d.value >= 0 ? '+' : '';
        return `<span class="rel-dim ${cls}">${d.type} ${sign}${d.value.toFixed(1)}</span>`;
      })
      .join(' ');

    div.innerHTML = `
      <span class="rel-agents">${escapeHtml(rel.from)} → ${escapeHtml(rel.to)}</span>
      ${dims}
    `;
    relationshipList.appendChild(div);
  }
}

// ─── Utilities ──────────────────────────────────

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// ─── Start ──────────────────────────────────────

init();
