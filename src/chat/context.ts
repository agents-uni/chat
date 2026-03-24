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
    if (context.isMentioned) {
      lines.push('');
      lines.push('> **⚡ You were @mentioned in this message. The user is specifically addressing you.**');
    }
    lines.push('');

    // ── Instructions ──
    lines.push('## Instructions');
    lines.push('');
    if (context.isMentioned) {
      lines.push('**You were directly @mentioned.** Respond with a focused, relevant answer.');
    } else if (context.isTargeted) {
      lines.push('Note: The user @mentioned specific agents (not you). You may still respond if you have something valuable to add, but keep it brief.');
    } else {
      lines.push('Respond naturally as your character in this group chat.');
    }
    lines.push('You may address other participants by @name.');
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
   * Generate a structured summary of older messages (outside the window).
   * Extracts topics, decisions, and disagreements.
   */
  summarizeOlderMessages(allMessages: ChatMessage[]): string | undefined {
    if (allMessages.length <= this.windowSize) {
      return undefined;
    }

    const olderMessages = allMessages.slice(0, -this.windowSize);
    const count = olderMessages.length;

    // Count by sender
    const senderCounts = new Map<string, number>();
    for (const msg of olderMessages) {
      const sender = msg.role === 'user' ? 'User' : (msg.agentName ?? msg.agentId ?? 'unknown');
      senderCounts.set(sender, (senderCounts.get(sender) ?? 0) + 1);
    }

    const senderSummary = [...senderCounts.entries()]
      .map(([name, n]) => `${name}(${n})`)
      .join(', ');

    // Extract high-frequency keywords as topics
    const wordFreq = new Map<string, number>();
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'that',
      'this', 'it', 'not', 'but', 'and', 'or', 'if', 'so', 'we', 'they',
      'you', 'i', 'my', 'me', 'our', 'your', 'his', 'her', 'its',
      '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都',
      '一', '这', '上', '也', '而', '对', '中', '他', '她', '们',
    ]);

    for (const msg of olderMessages) {
      const words = msg.content.toLowerCase().split(/[\s,;.!?，；。！？]+/).filter(w => w.length > 2);
      for (const word of words) {
        if (!stopWords.has(word)) {
          wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
        }
      }
    }

    const topics = [...wordFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);

    // Detect decisions
    const decisionPatterns = /\b(agree|agreed|decided|decision|let's go with|approved|confirmed|同意|决定|通过|确认|就这样|采纳)\b/i;
    const decisions: string[] = [];
    for (const msg of olderMessages) {
      if (decisionPatterns.test(msg.content)) {
        const sender = msg.role === 'user' ? 'User' : (msg.agentName ?? msg.agentId ?? 'unknown');
        decisions.push(`${sender}: ${msg.content.slice(0, 60)}...`);
        if (decisions.length >= 3) break;
      }
    }

    // Detect disagreements
    const disagreementPatterns = /\b(disagree|however|but I think|on the contrary|不同意|但是|反对|不过我认为|我觉得不)\b/i;
    const disagreements: string[] = [];
    for (const msg of olderMessages) {
      if (disagreementPatterns.test(msg.content)) {
        const sender = msg.role === 'user' ? 'User' : (msg.agentName ?? msg.agentId ?? 'unknown');
        disagreements.push(`${sender}: ${msg.content.slice(0, 60)}...`);
        if (disagreements.length >= 3) break;
      }
    }

    // Build structured summary
    const parts: string[] = [];
    parts.push(`[Earlier: ${count} messages from ${senderSummary}]`);

    if (topics.length > 0) {
      parts.push(`Topics: ${topics.join(', ')}`);
    }
    if (decisions.length > 0) {
      parts.push(`Decisions: ${decisions.join(' | ')}`);
    }
    if (disagreements.length > 0) {
      parts.push(`Disagreements: ${disagreements.join(' | ')}`);
    }

    return parts.join('\n');
  }

  /**
   * Parse @mentions from message content.
   * Supports: @agentId, @agentName (case-insensitive)
   * Returns list of matched agent IDs.
   */
  parseMentions(content: string, participants: ParticipantInfo[]): string[] {
    const contentLower = content.toLowerCase();
    const mentions: string[] = [];
    const seen = new Set<string>();

    // Check for @all first
    const allMatch = content.match(/@(all|所有人|全体)(?:\s|$)/i);
    if (allMatch) {
      return participants.map(p => p.id);
    }

    // Build candidate names sorted by length descending (greedy match longer names first)
    // Each candidate maps to its agent ID
    const candidates: Array<{ pattern: string; id: string }> = [];
    for (const p of participants) {
      candidates.push({ pattern: p.name.toLowerCase(), id: p.id });
      candidates.push({ pattern: p.id.toLowerCase(), id: p.id });
    }
    candidates.sort((a, b) => b.pattern.length - a.pattern.length);

    // Find all @ positions and try to match multi-word names
    let idx = 0;
    while (idx < contentLower.length) {
      const atPos = contentLower.indexOf('@', idx);
      if (atPos === -1) break;

      const afterAt = contentLower.slice(atPos + 1);
      let matched = false;

      for (const { pattern, id } of candidates) {
        if (seen.has(id)) continue;
        if (afterAt.startsWith(pattern)) {
          // Ensure the match ends at a word boundary (end of string, space, punctuation)
          const charAfter = afterAt[pattern.length];
          if (charAfter === undefined || /[\s,;.!?]/.test(charAfter)) {
            mentions.push(id);
            seen.add(id);
            idx = atPos + 1 + pattern.length;
            matched = true;
            break;
          }
        }
      }

      if (!matched) {
        idx = atPos + 1;
      }
    }

    return mentions;
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
