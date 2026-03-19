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
let isComposing = false; // IME composition guard

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
        const changeDesc = data.changes.map(c => {
          const eventMap = {
            'chat.agreement': '达成共识',
            'chat.disagreement': '产生分歧',
            'chat.trust': '信任增加',
            'chat.distrust': '信任降低',
            'chat.support': '表示支持',
            'chat.oppose': '表示反对',
          };
          const label = eventMap[c.eventType] || c.eventType;
          return `${c.from} → ${c.to}：${label}`;
        }).join('；');
        appendMessage({
          id: `rel-${Date.now()}`,
          role: 'system',
          content: `关系变化：${changeDesc}`,
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
    updateSendButtonState();
  });

  // IME composition guards (prevents Enter from sending during CJK input)
  messageInput.addEventListener('compositionstart', () => { isComposing = true; });
  messageInput.addEventListener('compositionend', () => { isComposing = false; });

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

    // Normal Enter to send — skip if IME is composing
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendButton.addEventListener('click', sendMessage);

  // Initialize send button state
  updateSendButtonState();

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
  updateSendButtonState();

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

  // Render content: Markdown for agent messages, plain escape for others
  const escapedContent = escapeHtml(msg.content);
  const renderedContent = msg.role === 'agent'
    ? renderMarkdown(escapedContent)
    : highlightMentions(escapedContent);

  if (msg.role === 'system') {
    // Compact pill style for system messages
    div.innerHTML = `
      <div class="message-body">
        <div class="message-content">${renderedContent}</div>
      </div>
    `;
  } else {
    div.innerHTML = `
      <div class="message-avatar" style="background: ${avatarColor}">${avatarChar}</div>
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
    relationshipList.innerHTML = '<div class="empty-state">开始对话后，Agent 之间的关系将在这里展示</div>';
    return;
  }

  relationshipList.innerHTML = '';

  for (const edge of relations) {
    if (!edge.dimensions || edge.dimensions.length === 0) continue;

    const div = document.createElement('div');
    div.className = 'relationship-item';

    const fromColor = getAgentColor(edge.from);
    const toColor = getAgentColor(edge.to);

    const dims = edge.dimensions
      .filter(d => Math.abs(d.value) > 0.1)
      .map(d => {
        const cls = d.value >= 0 ? 'positive' : 'negative';
        const sign = d.value >= 0 ? '+' : '';
        const pct = Math.min(Math.abs(d.value) * 100, 100);
        return `
          <div class="rel-dim-row">
            <span class="rel-dim ${cls}">${d.type} ${sign}${d.value.toFixed(1)}</span>
            <div class="rel-strength-bar">
              <div class="rel-strength-fill ${cls}" style="width: ${pct}%"></div>
            </div>
          </div>
        `;
      })
      .join('');

    div.innerHTML = `
      <div class="rel-agents">
        <span style="color: ${fromColor}">${escapeHtml(edge.from)}</span>
        <span class="rel-arrow">→</span>
        <span style="color: ${toColor}">${escapeHtml(edge.to)}</span>
      </div>
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

  // Compute per-node average valence for glow color
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
      id: n.id,
      label: n.label || n.id,
      size: 12 + n.influence * 22,
      color: {
        background: baseColor,
        border: glowColor,
        highlight: { background: '#c084fc', border: '#7c3aed' },
        hover: { background: baseColor, border: '#fff' },
      },
      borderWidth: 3,
      borderWidthSelected: 4,
      font: { color: '#e0e0e8', size: 12, strokeWidth: 3, strokeColor: '#0a0a0f' },
      shadow: { enabled: true, color: glowColor, size: 10, x: 0, y: 0 },
    };
  }));

  // Map valence to color gradient (red → gray → green)
  function valenceToColor(v) {
    const clamped = Math.max(-1, Math.min(1, v));
    if (clamped >= 0) {
      const t = clamped;
      const r = Math.round(100 + (74 - 100) * t);
      const g = Math.round(116 + (222 - 116) * t);
      const b = Math.round(139 + (128 - 139) * t);
      return `rgb(${r},${g},${b})`;
    }
    const t = -clamped;
    const r = Math.round(100 + (248 - 100) * t);
    const g = Math.round(116 + (113 - 116) * t);
    const b = Math.round(139 + (113 - 139) * t);
    return `rgb(${r},${g},${b})`;
  }

  const edges = new vis.DataSet((vizData.edges || []).map(e => ({
    id: e.id,
    from: e.from,
    to: e.to,
    width: 1 + e.strength * 4,
    color: {
      color: valenceToColor(e.valence || 0),
      highlight: '#c084fc',
      hover: '#e0e0e8',
    },
    arrows: { to: { enabled: true, scaleFactor: 0.5 } },
    smooth: { type: 'curvedCW', roundness: 0.2 },
    hoverWidth: 1.5,
  })));

  if (relNetwork) {
    relNetwork.destroy();
  }

  relNetwork = new vis.Network(container, { nodes, edges }, {
    physics: {
      barnesHut: {
        gravitationalConstant: -1500,
        springLength: 150,
        springConstant: 0.04,
        damping: 0.09,
      },
      stabilization: { iterations: 100, fit: true },
    },
    interaction: { hover: true, tooltipDelay: 200 },
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
  const threshold = 100;
  const distFromBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight;
  if (distFromBottom < threshold) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

/**
 * Lightweight Markdown renderer for agent messages.
 * Input must already be HTML-escaped for XSS safety.
 */
function renderMarkdown(escapedText) {
  let text = escapedText;

  // Code blocks: ```...```
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre class="md-code-block"><code>${code.trim()}</code></pre>`;
  });

  // Inline code: `...`
  text = text.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>');

  // Bold: **...**
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic: *...*
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Unordered lists: lines starting with - or *
  text = text.replace(/^([*\-]) (.+)$/gm, '<li>$2</li>');
  text = text.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul class="md-list">$1</ul>');

  // Ordered lists: lines starting with 1. 2. etc.
  text = text.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  text = text.replace(/((?:<li>.*<\/li>\n?)+)/g, (match) => {
    // Avoid double-wrapping already wrapped <ul>
    if (match.startsWith('<ul')) return match;
    return `<ol class="md-list">${match}</ol>`;
  });

  // Highlight @mentions
  text = highlightMentions(text);

  return text;
}

/**
 * Update send button disabled state based on input content.
 */
function updateSendButtonState() {
  const hasContent = messageInput.value.trim().length > 0;
  sendButton.classList.toggle('empty', !hasContent && !isProcessing);
}

/**
 * Toggle mobile sidebar.
 */
function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.querySelector('.sidebar-overlay');
  sidebar.classList.toggle('open');
  overlay.classList.toggle('open');
}

// ─── Start ──────────────────────────────────────

init();
