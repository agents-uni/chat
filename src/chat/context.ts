/**
 * Context Manager — builds agent-specific context from chat history.
 *
 * Core mechanism:
 * 1. Sliding window: keep last N messages in full
 * 2. Older messages: compressed into a brief summary
 * 3. Agent identity: role, traits, constraints injected per-agent
 * 4. Participant list: who's in the chat
 *
 * The output is a TASK.md-compatible markdown string that OpenClaw agents can process.
 */

import type { ChatMessage, ParticipantInfo, AgentContext } from '../types.js';

export interface ContextManagerOptions {
  /** Max messages in the sliding window (default: 20) */
  windowSize: number;
}

export class ContextManager {
  private readonly windowSize: number;

  constructor(options: ContextManagerOptions = { windowSize: 20 }) {
    this.windowSize = options.windowSize;
  }

  /**
   * Build a TASK.md content string for a specific agent, given the chat context.
   */
  buildTaskContent(context: AgentContext): string {
    const lines: string[] = [];

    // ── Header ──
    lines.push('# Group Chat');
    lines.push('');

    // ── Agent Identity ──
    lines.push('## Your Identity');
    lines.push(`You are **${context.agentName}**, ${context.roleDescription}.`);
    if (context.traits) {
      lines.push(`Personality: ${context.traits}`);
    }
    if (context.constraints) {
      lines.push(`Constraints: ${context.constraints}`);
    }
    lines.push('');

    // ── Participants ──
    lines.push('## Participants');
    lines.push('');
    for (const p of context.participants) {
      const isSelf = p.id === context.agentId;
      const suffix = isSelf ? ' (you)' : '';
      lines.push(`- **${p.name}**${suffix} — ${p.role}${p.department ? ` [${p.department}]` : ''}`);
    }
    lines.push('- **User** — ruler/user');
    lines.push('');

    // ── Relationship Summary ──
    if (context.relationshipSummary) {
      lines.push('## Your Relationships');
      lines.push('');
      lines.push(context.relationshipSummary);
      lines.push('');
    }

    // ── Chat History ──
    if (context.recentMessages.length > 0) {
      lines.push('## Chat History');
      lines.push('');
      for (const msg of context.recentMessages) {
        const sender = msg.role === 'user' ? 'User' : (msg.agentName ?? msg.agentId ?? 'System');
        const time = new Date(msg.timestamp).toLocaleTimeString('en-US', { hour12: false });
        lines.push(`[${sender}] ${time}: ${msg.content}`);
      }
      lines.push('');
    }

    // ── Current Message ──
    lines.push('## Current Message');
    lines.push('');
    lines.push(`[User]: ${context.currentMessage}`);
    lines.push('');

    // ── Instructions ──
    lines.push('## Instructions');
    lines.push('');
    lines.push('Respond naturally as your character in this group chat.');
    lines.push('You may address other participants by name.');
    lines.push('You may agree, disagree, or build upon others\' ideas.');
    lines.push('Keep your response concise (1-3 paragraphs).');
    lines.push('');
    lines.push('Write your response to `SUBMISSION.md` (only your message content, no metadata).');

    return lines.join('\n');
  }

  /**
   * Extract the recent messages within the sliding window.
   */
  getRecentMessages(allMessages: ChatMessage[]): ChatMessage[] {
    if (allMessages.length <= this.windowSize) {
      return [...allMessages];
    }
    return allMessages.slice(-this.windowSize);
  }

  /**
   * Generate a brief summary of older messages (outside the window).
   * MVP: simple extraction of key points. Future: LLM summarization.
   */
  summarizeOlderMessages(allMessages: ChatMessage[]): string | undefined {
    if (allMessages.length <= this.windowSize) {
      return undefined;
    }

    const olderMessages = allMessages.slice(0, -this.windowSize);
    const count = olderMessages.length;

    // MVP: count by sender + extract last few topics
    const senderCounts = new Map<string, number>();
    for (const msg of olderMessages) {
      const sender = msg.role === 'user' ? 'User' : (msg.agentName ?? msg.agentId ?? 'unknown');
      senderCounts.set(sender, (senderCounts.get(sender) ?? 0) + 1);
    }

    const senderSummary = [...senderCounts.entries()]
      .map(([name, n]) => `${name}(${n})`)
      .join(', ');

    return `[Earlier: ${count} messages from ${senderSummary}]`;
  }

  /**
   * Format traits record into human-readable string.
   */
  formatTraits(traits?: Record<string, number>): string {
    if (!traits || Object.keys(traits).length === 0) return '';
    return Object.entries(traits)
      .map(([key, value]) => {
        const level = value >= 0.8 ? 'very high' : value >= 0.6 ? 'high' : value >= 0.4 ? 'moderate' : 'low';
        return `${key}: ${level}`;
      })
      .join(', ');
  }
}
