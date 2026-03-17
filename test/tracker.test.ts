import { describe, it, expect } from 'vitest';
import { RelationshipTracker } from '../src/relationship/tracker.js';
import type { ChatMessage, ParticipantInfo } from '../src/types.js';

const participants: ParticipantInfo[] = [
  { id: 'alice', name: 'Alice', role: 'Engineer' },
  { id: 'bob', name: 'Bob', role: 'Designer' },
  { id: 'charlie', name: 'Charlie', role: 'Manager' },
];

function agentMessage(agentId: string, agentName: string, content: string): ChatMessage {
  return {
    id: `msg-${agentId}-${Date.now()}`,
    role: 'agent',
    agentId,
    agentName,
    content,
    timestamp: new Date().toISOString(),
  };
}

describe('RelationshipTracker', () => {
  const tracker = new RelationshipTracker();

  describe('inferEvents', () => {
    it('should detect positive mention (agreement)', () => {
      const responses = [
        agentMessage('alice', 'Alice', 'I agree with Bob, that is an excellent idea.'),
      ];

      const events = tracker.inferEvents(responses, participants);

      expect(events.length).toBeGreaterThanOrEqual(1);
      const aliceToBob = events.find(e => e.from === 'alice' && e.to === 'bob');
      expect(aliceToBob).toBeDefined();
      expect(aliceToBob!.type).toBe('chat.agreement');
      expect(aliceToBob!.impact.trust).toBeGreaterThan(0);
    });

    it('should detect negative mention (disagreement)', () => {
      const responses = [
        agentMessage('alice', 'Alice', 'I disagree with Bob. His approach is wrong.'),
      ];

      const events = tracker.inferEvents(responses, participants);

      const aliceToBob = events.find(e => e.from === 'alice' && e.to === 'bob');
      expect(aliceToBob).toBeDefined();
      expect(aliceToBob!.type).toBe('chat.disagreement');
      expect(aliceToBob!.impact.rivalry).toBeGreaterThan(0);
    });

    it('should detect collaborative mention', () => {
      const responses = [
        agentMessage('alice', 'Alice', 'Building on what Bob said, I think we should also...'),
      ];

      const events = tracker.inferEvents(responses, participants);

      const aliceToBob = events.find(e => e.from === 'alice' && e.to === 'bob');
      expect(aliceToBob).toBeDefined();
      expect(aliceToBob!.type).toBe('chat.collaboration');
      expect(aliceToBob!.impact.synergy).toBeGreaterThan(0);
    });

    it('should not create events for messages without agent mentions', () => {
      const responses = [
        agentMessage('alice', 'Alice', 'I think the project should focus on performance.'),
      ];

      const events = tracker.inferEvents(responses, participants);
      expect(events).toHaveLength(0);
    });

    it('should detect Chinese sentiment patterns', () => {
      const responses = [
        agentMessage('alice', 'Alice', '我赞同 Bob 的观点，说得好。'),
      ];

      const events = tracker.inferEvents(responses, participants);

      const aliceToBob = events.find(e => e.from === 'alice' && e.to === 'bob');
      expect(aliceToBob).toBeDefined();
      expect(aliceToBob!.type).toBe('chat.agreement');
    });

    it('should detect consensus when most agents agree', () => {
      const responses = [
        agentMessage('alice', 'Alice', 'I agree with the plan. Bob makes a good point.'),
        agentMessage('bob', 'Bob', 'I support this approach. Alice is correct.'),
        agentMessage('charlie', 'Charlie', 'I agree with everyone. Great ideas from Alice.'),
      ];

      const events = tracker.inferEvents(responses, participants);

      const consensusEvents = events.filter(e => e.type === 'chat.consensus');
      expect(consensusEvents.length).toBeGreaterThan(0);
    });

    it('should skip non-agent messages', () => {
      const responses: ChatMessage[] = [
        {
          id: 'msg-1',
          role: 'user',
          content: 'I agree with Bob',
          timestamp: new Date().toISOString(),
        },
      ];

      const events = tracker.inferEvents(responses, participants);
      expect(events).toHaveLength(0);
    });
  });
});
