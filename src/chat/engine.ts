/**
 * Chat Engine — the central orchestrator for group chat.
 *
 * Orchestration model (inspired by edict's conductor pattern):
 * - @mention: dispatch ONLY to mentioned agent(s), serially
 * - No @mention: pick up to `maxRespondents` relevant agents, serially
 * - Each agent responds one at a time; later agents see earlier responses
 * - Responses are broadcast in real-time as they arrive
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

import { computeInfluence } from '@agents-uni/rel';
import type { VisualizationData, VisualizationOptions } from '@agents-uni/rel';

import { ContextManager } from './context.js';
import { ChatDispatcher } from './dispatcher.js';
import { RelationshipTracker } from '../relationship/tracker.js';
import { createLogger, type Logger } from '../utils/logger.js';
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
  private readonly logger: Logger;
  private readonly maxRespondents: number;

  private session: ChatSession;
  private callbacks: ChatEngineCallbacks = {};

  constructor(options: ChatEngineOptions) {
    // Initialize logger
    this.logger = createLogger(options.debug ?? false);

    // Parse universe config
    this.config = parseSpecFile(options.specPath);
    this.logger.debug('Engine', 'init', `universe="${this.config.name}", agents=${this.config.agents.length}`);

    // Max agents to respond when no @mention (default 3)
    this.maxRespondents = options.maxRespondents ?? 3;

    // Initialize workspace IO
    this.io = new FileWorkspaceIO({
      openclawDir: options.openclawDir,
    });

    // Initialize context manager
    this.contextManager = new ContextManager({
      windowSize: options.contextWindowSize ?? 20,
    });

    // Initialize chat dispatcher (serial execution)
    this.chatDispatcher = new ChatDispatcher(this.io, this.contextManager, {
      responseTimeoutMs: options.responseTimeoutMs ?? 120_000,
      pollIntervalMs: options.pollIntervalMs ?? 2000,
    }, this.logger);

    // Initialize relationship engine
    this.relBundle = createRelEngine(this.config);

    // Initialize relationship tracker
    this.relationshipTracker = new RelationshipTracker(this.logger);

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
   * Get the logger instance (for registering onLog callbacks).
   */
  getLogger(): Logger {
    return this.logger;
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
   * Get relationship visualization data (standardized format).
   */
  getVisualizationData(): VisualizationData {
    const agentMetadata: Record<string, { name?: string; role?: string; department?: string }> = {};
    for (const agent of this.config.agents) {
      agentMetadata[agent.id] = {
        name: agent.name,
        role: agent.role.title,
        department: agent.role.department,
      };
    }
    return this.relBundle.graph.toVisualizationData({ agentMetadata });
  }

  /**
   * Get the relationship engine bundle for external use.
   */
  getRelBundle(): RelEngineBundle {
    return this.relBundle;
  }

  /**
   * Process a user message through the group chat.
   *
   * Routing:
   * - @mention → dispatch ONLY to mentioned agent(s)
   * - No @mention → pick up to maxRespondents relevant agents
   *
   * Execution: serial, one agent at a time. Each response is broadcast
   * immediately and visible to subsequent agents.
   */
  async processMessage(content: string): Promise<ChatMessage[]> {
    if (this.session.status === 'processing') {
      throw new Error('Chat is currently processing. Please wait for agents to respond.');
    }

    // Set processing status
    this.setStatus('processing');

    try {
      // Parse @mentions
      const allParticipants = this.session.participants;
      const mentions = this.contextManager.parseMentions(content, allParticipants);
      const isTargeted = mentions.length > 0;
      this.logger.debug('Engine', 'processMessage', `content="${content.slice(0, 80)}"`);
      this.logger.debug('Engine', 'parseMentions', `found=${JSON.stringify(mentions)}`);

      // Create user message
      const userMessage: ChatMessage = {
        id: `msg-user-${Date.now()}`,
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
        mentions: mentions.length > 0 ? mentions : undefined,
      };

      // Add to history
      this.session.messages.push(userMessage);
      this.callbacks.onMessage?.(userMessage);

      // Route: @mention → only those agents; no @mention → pick relevant subset
      const targetParticipants = isTargeted
        ? allParticipants.filter(p => mentions.includes(p.id))
        : this.selectRespondents(content, allParticipants);

      this.logger.debug(
        'Engine',
        'routing',
        `targeted=${isTargeted}, agents=${JSON.stringify(targetParticipants.map(p => p.id))}`
      );

      // Serial dispatch with per-response callback
      const responses = await this.chatDispatcher.dispatchAndCollect(
        content,
        targetParticipants,
        this.session.messages,
        (agentId: string) => this.buildAgentContext(agentId, content, {
          isMentioned: mentions.includes(agentId),
          isTargeted,
        }),
        // Called after each agent responds — adds to history so next agent sees it
        (response: ChatMessage) => {
          this.session.messages.push(response);
          this.callbacks.onMessage?.(response);
        }
      );

      // Infer relationship events
      const inferredEvents = this.relationshipTracker.inferEvents(responses, allParticipants);
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
        this.logger.debug('Engine', 'relationshipChanges', `count=${relationshipChanges.length}`);
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

  /**
   * Select which agents should respond when no @mention is present.
   *
   * Picks up to `maxRespondents` agents based on:
   * 1. Keyword match against agent role/duties
   * 2. Relationship scoring (allies/advisors of recent respondent get boost)
   * 3. Influence scoring (high influence agents prioritized)
   * 4. Department diversity (avoid all from same department)
   * 5. Falls back to round-robin if no match
   */
  private selectRespondents(
    content: string,
    participants: ParticipantInfo[]
  ): ParticipantInfo[] {
    const max = this.maxRespondents;
    if (participants.length <= max) return participants;

    const contentLower = content.toLowerCase();

    // Compute influence scores
    const influenceScores = computeInfluence(this.relBundle.graph);
    const influenceMap = new Map<string, number>();
    for (const score of influenceScores) {
      influenceMap.set(score.agentId, score.score);
    }

    // Get recent respondent IDs for relationship-based boosting
    const recentRespondentIds = this.getRecentRespondentIds(3);

    // Score each agent by keyword relevance + relationship boost
    const scored = participants.map(p => {
      let score = 0;

      // Keyword match against role title
      if (p.role && contentLower.includes(p.role.toLowerCase())) score += 3;
      // Keyword match against agent name
      if (contentLower.includes(p.name.toLowerCase())) score += 5;
      // Keyword match against department
      if (p.department && contentLower.includes(p.department.toLowerCase())) score += 2;

      // Relationship boost: allies/advisors of recent respondents
      for (const recentId of recentRespondentIds) {
        const trustValue = this.relBundle.graph.getDimensionValue(recentId, p.id, 'trust');
        if (trustValue !== undefined && trustValue > 0.3) score += 1;

        const rivalryValue = this.relBundle.graph.getDimensionValue(recentId, p.id, 'rivalry');
        if (rivalryValue !== undefined && rivalryValue > 0.3) score += 0.5;
      }

      // Influence boost
      const influence = influenceMap.get(p.id) ?? 0;
      score += influence * 2;

      return { participant: p, score };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    this.logger.debug('Engine', 'selectRespondents', `scores=${JSON.stringify(scored.map(s => ({ id: s.participant.id, score: s.score.toFixed(2) })))}`);

    // If nobody has keyword/relationship matches (only influence), use diverse selection
    const hasKeywordMatch = scored.some(s => {
      const influence = influenceMap.get(s.participant.id) ?? 0;
      return s.score - influence * 2 > 0;
    });

    if (!hasKeywordMatch) {
      return this.selectDiverse(participants, max);
    }

    // Take top scored, ensuring department diversity
    const selected: ParticipantInfo[] = [];
    const departments = new Set<string>();

    for (const { participant, score } of scored) {
      if (selected.length >= max) break;
      // Allow same department only if they have a positive score
      if (score > 0 || !departments.has(participant.department ?? '')) {
        selected.push(participant);
        if (participant.department) departments.add(participant.department);
      }
    }

    // Fill remaining slots if needed
    if (selected.length < max) {
      for (const { participant } of scored) {
        if (selected.length >= max) break;
        if (!selected.includes(participant)) {
          selected.push(participant);
        }
      }
    }

    return selected;
  }

  /**
   * Select a diverse set of agents across departments (round-robin style).
   */
  private selectDiverse(
    participants: ParticipantInfo[],
    max: number
  ): ParticipantInfo[] {
    // Group by department
    const byDept = new Map<string, ParticipantInfo[]>();
    for (const p of participants) {
      const dept = p.department ?? 'unknown';
      const list = byDept.get(dept) ?? [];
      list.push(p);
      byDept.set(dept, list);
    }

    // Round-robin across departments
    const selected: ParticipantInfo[] = [];
    const deptIterators = [...byDept.values()].map(list => ({ list, idx: 0 }));
    let round = 0;

    while (selected.length < max && round < participants.length) {
      for (const iter of deptIterators) {
        if (selected.length >= max) break;
        if (iter.idx < iter.list.length) {
          selected.push(iter.list[iter.idx]);
          iter.idx++;
        }
      }
      round++;
    }

    return selected;
  }

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

  /**
   * Get IDs of the N most recent agent respondents (for relationship boosting).
   */
  private getRecentRespondentIds(n: number): string[] {
    const ids: string[] = [];
    const messages = this.session.messages;
    for (let i = messages.length - 1; i >= 0 && ids.length < n; i--) {
      const msg = messages[i];
      if (msg.role === 'agent' && msg.agentId && !ids.includes(msg.agentId)) {
        ids.push(msg.agentId);
      }
    }
    return ids;
  }

  private buildAgentContext(
    agentId: string,
    currentMessage: string,
    mentionInfo: { isMentioned: boolean; isTargeted: boolean } = { isMentioned: false, isTargeted: false }
  ): AgentContext {
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
      isMentioned: mentionInfo.isMentioned,
      isTargeted: mentionInfo.isTargeted,
    };
  }

  private setStatus(status: ChatStatus): void {
    this.session.status = status;
    this.callbacks.onStatusChange?.(status);
  }
}
