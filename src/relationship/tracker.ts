/**
 * Relationship Tracker — infers relationship events from group chat interactions.
 *
 * Detection patterns:
 * 1. Agent A mentions Agent B by name + positive sentiment → trust/affinity event
 * 2. Agent A disagrees with Agent B → debate/rivalry event
 * 3. Agent A builds on Agent B's idea → collaboration/synergy event
 * 4. Multiple agents reach consensus → group.consensus event
 *
 * MVP: keyword-based detection. Future: LLM-powered analysis.
 */

import type { ChatMessage, ParticipantInfo, RelationshipChange } from '../types.js';
import type { Logger } from '../utils/logger.js';

// ─── Sentiment Patterns ─────────────────────────

const POSITIVE_PATTERNS = [
  /agree/i, /excellent/i, /good point/i, /well said/i,
  /support/i, /exactly/i, /correct/i, /great idea/i,
  /赞同/i, /同意/i, /说得好/i, /有道理/i, /不错/i, /好主意/i,
  /精妙/i, /高见/i, /附议/i,
];

const NEGATIVE_PATTERNS = [
  /disagree/i, /incorrect/i, /wrong/i, /however/i,
  /but I think/i, /on the contrary/i, /not quite/i,
  /不同意/i, /不对/i, /恐怕不行/i, /此言差矣/i,
  /未必/i, /不敢苟同/i, /有待商榷/i,
];

const COLLABORATIVE_PATTERNS = [
  /building on/i, /to add to/i, /expanding on/i,
  /as .+ mentioned/i, /like .+ said/i,
  /补充/i, /在.*基础上/i, /正如.*所说/i, /接着.*的思路/i,
];

// ─── Event Types ────────────────────────────────

interface InferredEvent {
  from: string;
  to: string;
  type: string;
  impact: Record<string, number>;
  description: string;
}

// ─── Tracker ────────────────────────────────────

export class RelationshipTracker {
  private readonly logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  /**
   * Analyze a round of agent responses and infer relationship events.
   *
   * @param responses - Agent messages from this round
   * @param participants - All participants in the chat
   * @returns Inferred events that can be fed to EvolutionEngine
   */
  inferEvents(
    responses: ChatMessage[],
    participants: ParticipantInfo[]
  ): InferredEvent[] {
    const events: InferredEvent[] = [];

    for (const response of responses) {
      if (response.role !== 'agent' || !response.agentId) continue;

      const authorId = response.agentId;
      const content = response.content;

      // Check if this agent mentions other agents
      for (const participant of participants) {
        if (participant.id === authorId) continue;

        const mentionsAgent = this.mentionsAgent(content, participant);
        if (!mentionsAgent) continue;

        // Determine sentiment toward the mentioned agent
        const sentiment = this.detectSentiment(content, participant);

        if (sentiment === 'positive') {
          this.logger?.debug('Tracker', 'sentiment', `from="${authorId}" → to="${participant.id}", type="chat.agreement"`, authorId);
          events.push({
            from: authorId,
            to: participant.id,
            type: 'chat.agreement',
            impact: { trust: 0.05, affinity: 0.03 },
            description: `${response.agentName} agreed with ${participant.name} in group chat`,
          });
        } else if (sentiment === 'negative') {
          this.logger?.debug('Tracker', 'sentiment', `from="${authorId}" → to="${participant.id}", type="chat.disagreement"`, authorId);
          events.push({
            from: authorId,
            to: participant.id,
            type: 'chat.disagreement',
            impact: { rivalry: 0.03, respect: 0.01 },
            description: `${response.agentName} disagreed with ${participant.name} in group chat`,
          });
        } else if (sentiment === 'collaborative') {
          this.logger?.debug('Tracker', 'sentiment', `from="${authorId}" → to="${participant.id}", type="chat.collaboration"`, authorId);
          events.push({
            from: authorId,
            to: participant.id,
            type: 'chat.collaboration',
            impact: { trust: 0.03, synergy: 0.05 },
            description: `${response.agentName} built on ${participant.name}'s ideas in group chat`,
          });
        }
      }
    }

    // Check for group consensus (all agents express agreement with each other)
    if (responses.length >= 2) {
      const consensus = this.detectConsensus(responses, participants);
      if (consensus) {
        this.logger?.debug('Tracker', 'consensus', `detected among ${responses.length} agents`);
        // Pairwise events for consensus
        for (let i = 0; i < responses.length; i++) {
          for (let j = i + 1; j < responses.length; j++) {
            const a = responses[i];
            const b = responses[j];
            if (a.agentId && b.agentId) {
              events.push({
                from: a.agentId,
                to: b.agentId,
                type: 'chat.consensus',
                impact: { trust: 0.02, synergy: 0.02, affinity: 0.01 },
                description: `Group consensus reached between ${a.agentName} and ${b.agentName}`,
              });
            }
          }
        }
      }
    }

    return events;
  }

  /**
   * Check if content mentions a specific agent by name.
   */
  private mentionsAgent(content: string, agent: ParticipantInfo): boolean {
    const namePattern = new RegExp(this.escapeRegExp(agent.name), 'i');
    const idPattern = new RegExp(this.escapeRegExp(agent.id), 'i');
    return namePattern.test(content) || idPattern.test(content);
  }

  /**
   * Detect sentiment toward a mentioned agent.
   */
  private detectSentiment(
    content: string,
    _target: ParticipantInfo
  ): 'positive' | 'negative' | 'collaborative' | 'neutral' {
    // Check collaborative first (more specific)
    for (const pattern of COLLABORATIVE_PATTERNS) {
      if (pattern.test(content)) return 'collaborative';
    }

    // Check positive
    let positiveCount = 0;
    for (const pattern of POSITIVE_PATTERNS) {
      if (pattern.test(content)) positiveCount++;
    }

    // Check negative
    let negativeCount = 0;
    for (const pattern of NEGATIVE_PATTERNS) {
      if (pattern.test(content)) negativeCount++;
    }

    if (positiveCount > negativeCount && positiveCount > 0) return 'positive';
    if (negativeCount > positiveCount && negativeCount > 0) return 'negative';
    return 'neutral';
  }

  /**
   * Detect if agents reached a consensus.
   * MVP: check if most agents use agreement language.
   */
  private detectConsensus(
    responses: ChatMessage[],
    _participants: ParticipantInfo[]
  ): boolean {
    if (responses.length < 2) return false;

    let agreementCount = 0;
    for (const response of responses) {
      for (const pattern of POSITIVE_PATTERNS) {
        if (pattern.test(response.content)) {
          agreementCount++;
          break;
        }
      }
    }

    // Consensus if >60% of agents express agreement
    return agreementCount / responses.length > 0.6;
  }

  private escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
