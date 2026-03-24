/**
 * @agents-uni/chat — Type definitions for group chat service.
 */

// ─── Conversation Modes ─────────────────────────

export type ConversationMode = 'sequential' | 'debate' | 'brainstorm';
export type ExportFormat = 'json' | 'markdown';

export interface PaginatedMessages {
  messages: ChatMessage[];
  page: number;
  total: number;
  hasMore: boolean;
}

// ─── Chat Messages ──────────────────────────────

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  /** Agent ID (only for agent messages) */
  agentId?: string;
  /** Display name */
  agentName?: string;
  content: string;
  timestamp: string;
  /** Optional: which message this replies to */
  replyTo?: string;
  /** @mentioned agent IDs (parsed from content) */
  mentions?: string[];
}

// ─── Chat Session ───────────────────────────────

export type ChatStatus = 'idle' | 'processing';

export interface ChatSession {
  id: string;
  universeId: string;
  participants: ParticipantInfo[];
  messages: ChatMessage[];
  status: ChatStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ParticipantInfo {
  id: string;
  name: string;
  role: string;
  department?: string;
  traits?: Record<string, number>;
}

// ─── Chat Engine Options ────────────────────────

export interface ChatEngineOptions {
  /** Path to universe.yaml */
  specPath: string;
  /** Max messages in context window sent to agents (default: 20) */
  contextWindowSize?: number;
  /** Max time to wait for agent responses (ms, default: 120000) */
  responseTimeoutMs?: number;
  /** Polling interval for checking agent submissions (ms, default: 2000) */
  pollIntervalMs?: number;
  /** OpenClaw workspace directory (default: ~/.openclaw) */
  openclawDir?: string;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Max agents to respond when no @mention (default: 3) */
  maxRespondents?: number;
  /** Conversation mode (default: 'sequential') */
  mode?: ConversationMode;
}

// ─── Server Config ──────────────────────────────

export interface ServerConfig {
  port: number;
  specPath: string;
  openclawDir?: string;
  contextWindowSize?: number;
  responseTimeoutMs?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Max agents to respond when no @mention (default: 3) */
  maxRespondents?: number;
}

// ─── WebSocket Messages ─────────────────────────

export type WSClientMessage =
  | { type: 'send_message'; content: string }
  | { type: 'get_state' };

export type WSServerMessage =
  | { type: 'chat_message'; message: ChatMessage }
  | { type: 'status_change'; status: ChatStatus }
  | { type: 'state'; session: ChatSession }
  | { type: 'error'; message: string }
  | { type: 'relationship_update'; changes: RelationshipChange[] }
  | { type: 'debug_log'; log: DebugLogEntry }
  | { type: 'agent_thinking'; agentId: string; agentName: string }
  | { type: 'agent_done'; agentId: string }
  | { type: 'agent_error'; agentId: string; error: string };

// ─── Relationship Tracking ──────────────────────

export interface RelationshipChange {
  from: string;
  to: string;
  eventType: string;
  dimensionChanges: Record<string, { before: number; after: number }>;
}

// ─── Chat Context (internal) ────────────────────

export interface AgentContext {
  agentId: string;
  agentName: string;
  roleDescription: string;
  traits: string;
  constraints: string;
  participants: ParticipantInfo[];
  recentMessages: ChatMessage[];
  currentMessage: string;
  relationshipSummary?: string;
  /** Whether this agent was @mentioned in the current message */
  isMentioned?: boolean;
  /** Whether the message is targeted (has @mentions at all) */
  isTargeted?: boolean;
}

// ─── Debug Logging ─────────────────────────────

export interface DebugLogEntry {
  timestamp: string;
  source: string;
  action: string;
  detail?: string;
  agentId?: string;
}
