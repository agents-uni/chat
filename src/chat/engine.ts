/**
 * Chat Engine — the central orchestrator for group chat.
 *
 * Coordinates:
 * 1. Universe loading (agents, relationships)
 * 2. Chat session lifecycle (create, message, history)
 * 3. Context building per agent
 * 4. Dispatch to OpenClaw workspaces
 * 5. Response collection
 * 6. Relationship event inference + evolution
 *
 * Sequential model: one message at a time. User must wait for all agents
 * to respond before sending the next message.
 */

import {
  parseSpecFile,
  FileWorkspaceIO,
  createRelEngine,
  type UniverseConfig,
  type AgentDefinition,
  type WorkspaceIO,
  type RelEngineBundle,
} from '@agents-uni/core';

import { ContextManager } from './context.js';
import { ChatDispatcher } from './dispatcher.js';
import { RelationshipTracker } from '../relationship/tracker.js';
import type {
  ChatMessage,
  ChatSession,
  ChatStatus,
  ParticipantInfo,
  AgentContext,
  ChatEngineOptions,
  RelationshipChange,
} from '../types.js';

// ─── Event Callback Types ───────────────────────

export interface ChatEngineCallbacks {
  onMessage?: (message: ChatMessage) => void;
  onStatusChange?: (status: ChatStatus) => void;
  onRelationshipChange?: (changes: RelationshipChange[]) => void;
}

// ─── Chat Engine ────────────────────────────────

export class ChatEngine {
  private readonly config: UniverseConfig;
  private readonly io: WorkspaceIO;
  private readonly contextManager: ContextManager;
  private readonly chatDispatcher: ChatDispatcher;
  private readonly relationshipTracker: RelationshipTracker;
  private readonly relBundle: RelEngineBundle;

  private session: ChatSession;
  private callbacks: ChatEngineCallbacks = {};

  constructor(options: ChatEngineOptions) {
    // Parse universe config
    this.config = parseSpecFile(options.specPath);

    // Initialize workspace IO
    this.io = new FileWorkspaceIO({
      openclawDir: options.openclawDir,
    });

    // Initialize context manager
    this.contextManager = new ContextManager({
      windowSize: options.contextWindowSize ?? 20,
    });

    // Initialize chat dispatcher
    this.chatDispatcher = new ChatDispatcher(this.io, this.contextManager, {
      responseTimeoutMs: options.responseTimeoutMs ?? 120_000,
      pollIntervalMs: options.pollIntervalMs ?? 2000,
    });

    // Initialize relationship engine
    this.relBundle = createRelEngine(this.config);

    // Initialize relationship tracker
    this.relationshipTracker = new RelationshipTracker();

    // Initialize session
    this.session = this.createSession();
  }

  /**
   * Register callbacks for real-time updates.
   */
  onEvent(callbacks: ChatEngineCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * Get the current chat session state.
   */
  getSession(): ChatSession {
    return { ...this.session };
  }

  /**
   * Get the universe config.
   */
  getConfig(): UniverseConfig {
    return this.config;
  }

  /**
   * Get relationship data for display.
   */
  getRelationships(): Array<{
    from: string;
    to: string;
    dimensions: Array<{ type: string; value: number }>;
  }> {
    const results: Array<{
      from: string;
      to: string;
      dimensions: Array<{ type: string; value: number }>;
    }> = [];

    for (const agent of this.config.agents) {
      const outgoing = this.relBundle.graph.getOutgoing(agent.id);
      for (const rel of outgoing) {
        results.push({
          from: rel.from,
          to: rel.to,
          dimensions: rel.dimensions.map(d => ({ type: d.type, value: d.value })),
        });
      }
    }

    return results;
  }

  /**
   * Process a user message through the group chat.
   *
   * Sequential model:
   * 1. Reject if already processing
   * 2. Set status to 'processing'
   * 3. Add user message to history
   * 4. Dispatch to all agents
   * 5. Collect responses
   * 6. Infer relationship events
   * 7. Set status back to 'idle'
   */
  async processMessage(content: string): Promise<ChatMessage[]> {
    if (this.session.status === 'processing') {
      throw new Error('Chat is currently processing. Please wait for agents to respond.');
    }

    // Set processing status
    this.setStatus('processing');

    try {
      // Create user message
      const userMessage: ChatMessage = {
        id: `msg-user-${Date.now()}`,
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      };

      // Add to history
      this.session.messages.push(userMessage);
      this.callbacks.onMessage?.(userMessage);

      // Get participants
      const participants = this.session.participants;

      // Build per-agent context and dispatch
      const responses = await this.chatDispatcher.dispatchAndCollect(
        content,
        participants,
        this.session.messages,
        (agentId: string) => this.buildAgentContext(agentId, content)
      );

      // Add responses to history and broadcast
      for (const response of responses) {
        this.session.messages.push(response);
        this.callbacks.onMessage?.(response);
      }

      // Infer relationship events
      const inferredEvents = this.relationshipTracker.inferEvents(responses, participants);
      const relationshipChanges: RelationshipChange[] = [];

      for (const event of inferredEvents) {
        try {
          const results = this.relBundle.evolution.processEvent(
            event.from,
            event.to,
            event.type,
            { description: event.description }
          );

          for (const result of results) {
            relationshipChanges.push({
              from: result.from,
              to: result.to,
              eventType: event.type,
              dimensionChanges: result.dimensionChanges,
            });
          }
        } catch {
          // Evolution processing failure is non-fatal
        }
      }

      if (relationshipChanges.length > 0) {
        this.callbacks.onRelationshipChange?.(relationshipChanges);
      }

      // Update session timestamp
      this.session.updatedAt = new Date().toISOString();

      return responses;
    } finally {
      // Always reset status
      this.setStatus('idle');
    }
  }

  // ─── Private Methods ──────────────────────────

  private createSession(): ChatSession {
    const participants: ParticipantInfo[] = this.config.agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      role: agent.role.title,
      department: agent.role.department,
      traits: agent.traits,
    }));

    return {
      id: `session-${Date.now()}`,
      universeId: this.config.name,
      participants,
      messages: [],
      status: 'idle',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private buildAgentContext(agentId: string, currentMessage: string): AgentContext {
    const agent = this.config.agents.find(a => a.id === agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const recentMessages = this.contextManager.getRecentMessages(this.session.messages);
    const olderSummary = this.contextManager.summarizeOlderMessages(this.session.messages);

    // Build relationship summary for this agent
    let relationshipSummary: string | undefined;
    try {
      const outgoing = this.relBundle.graph.getOutgoing(agentId);
      const incoming = this.relBundle.graph.getIncoming(agentId);
      const allRels = [...outgoing, ...incoming];

      if (allRels.length > 0) {
        const lines: string[] = [];
        for (const rel of allRels) {
          const otherId = rel.from === agentId ? rel.to : rel.from;
          const otherAgent = this.config.agents.find(a => a.id === otherId);
          const otherName = otherAgent?.name ?? otherId;
          const dims = rel.dimensions
            .filter(d => Math.abs(d.value) > 0.1)
            .map(d => `${d.type}: ${d.value > 0 ? '+' : ''}${d.value.toFixed(1)}`)
            .join(', ');
          if (dims) {
            lines.push(`- ${otherName}: ${dims}`);
          }
        }
        if (lines.length > 0) {
          relationshipSummary = lines.join('\n');
        }
      }
    } catch {
      // Relationship query failure is non-fatal
    }

    // Prepend older summary to recent messages if needed
    const messagesWithContext = olderSummary
      ? [
          {
            id: 'summary',
            role: 'system' as const,
            content: olderSummary,
            timestamp: recentMessages[0]?.timestamp ?? new Date().toISOString(),
          },
          ...recentMessages,
        ]
      : recentMessages;

    return {
      agentId,
      agentName: agent.name,
      roleDescription: agent.role.title + (agent.role.duties?.length
        ? ` (${agent.role.duties.join(', ')})`
        : ''),
      traits: this.contextManager.formatTraits(agent.traits),
      constraints: agent.constraints?.join('; ') ?? '',
      participants: this.session.participants,
      recentMessages: messagesWithContext,
      currentMessage,
      relationshipSummary,
    };
  }

  private setStatus(status: ChatStatus): void {
    this.session.status = status;
    this.callbacks.onStatusChange?.(status);
  }
}
