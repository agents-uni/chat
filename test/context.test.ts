import { describe, it, expect } from 'vitest';
import { ContextManager } from '../src/chat/context.js';
import type { ChatMessage, AgentContext, ParticipantInfo } from '../src/types.js';

function createMessage(
  id: string,
  role: 'user' | 'agent' | 'system',
  content: string,
  agentId?: string,
  agentName?: string
): ChatMessage {
  return {
    id,
    role,
    content,
    agentId,
    agentName,
    timestamp: new Date().toISOString(),
  };
}

const participants: ParticipantInfo[] = [
  { id: 'alice', name: 'Alice', role: 'Engineer' },
  { id: 'bob', name: 'Bob', role: 'Designer' },
];

describe('ContextManager', () => {
  describe('getRecentMessages', () => {
    it('should return all messages when within window', () => {
      const cm = new ContextManager({ windowSize: 10 });
      const messages = [
        createMessage('1', 'user', 'hello'),
        createMessage('2', 'agent', 'hi', 'alice', 'Alice'),
      ];

      const recent = cm.getRecentMessages(messages);
      expect(recent).toHaveLength(2);
      expect(recent[0].content).toBe('hello');
    });

    it('should slice to window size when messages exceed window', () => {
      const cm = new ContextManager({ windowSize: 3 });
      const messages = Array.from({ length: 10 }, (_, i) =>
        createMessage(`${i}`, 'user', `message ${i}`)
      );

      const recent = cm.getRecentMessages(messages);
      expect(recent).toHaveLength(3);
      expect(recent[0].content).toBe('message 7');
      expect(recent[2].content).toBe('message 9');
    });

    it('should return empty array for no messages', () => {
      const cm = new ContextManager({ windowSize: 10 });
      expect(cm.getRecentMessages([])).toHaveLength(0);
    });
  });

  describe('summarizeOlderMessages', () => {
    it('should return undefined when all messages fit in window', () => {
      const cm = new ContextManager({ windowSize: 10 });
      const messages = [createMessage('1', 'user', 'hello')];

      expect(cm.summarizeOlderMessages(messages)).toBeUndefined();
    });

    it('should summarize older messages outside window', () => {
      const cm = new ContextManager({ windowSize: 2 });
      const messages = [
        createMessage('1', 'user', 'first'),
        createMessage('2', 'agent', 'reply', 'alice', 'Alice'),
        createMessage('3', 'user', 'second'),
        createMessage('4', 'agent', 'reply2', 'bob', 'Bob'),
      ];

      const summary = cm.summarizeOlderMessages(messages);
      expect(summary).toBeDefined();
      expect(summary).toContain('2 messages');
      expect(summary).toContain('User');
      expect(summary).toContain('Alice');
    });
  });

  describe('formatTraits', () => {
    it('should format traits with appropriate levels', () => {
      const cm = new ContextManager({ windowSize: 10 });

      const result = cm.formatTraits({ intelligence: 0.9, creativity: 0.5 });
      expect(result).toContain('intelligence: very high');
      expect(result).toContain('creativity: moderate');
    });

    it('should return empty string for undefined traits', () => {
      const cm = new ContextManager({ windowSize: 10 });
      expect(cm.formatTraits(undefined)).toBe('');
      expect(cm.formatTraits({})).toBe('');
    });
  });

  describe('parseMentions', () => {
    const cm = new ContextManager({ windowSize: 10 });

    it('should parse @agentId mentions', () => {
      const result = cm.parseMentions('@alice what do you think?', participants);
      expect(result).toEqual(['alice']);
    });

    it('should parse @agentName mentions (case-insensitive)', () => {
      const result = cm.parseMentions('@Bob please review', participants);
      expect(result).toEqual(['bob']);
    });

    it('should parse multiple mentions', () => {
      const result = cm.parseMentions('@Alice and @Bob please discuss', participants);
      expect(result).toContain('alice');
      expect(result).toContain('bob');
      expect(result).toHaveLength(2);
    });

    it('should handle @all and return all participants', () => {
      const result = cm.parseMentions('@all what do you think?', participants);
      expect(result).toEqual(['alice', 'bob']);
    });

    it('should handle Chinese @所有人', () => {
      const result = cm.parseMentions('@所有人 大家好', participants);
      expect(result).toEqual(['alice', 'bob']);
    });

    it('should return empty array when no mentions', () => {
      const result = cm.parseMentions('hello everyone', participants);
      expect(result).toEqual([]);
    });

    it('should ignore unknown @mentions', () => {
      const result = cm.parseMentions('@unknown hi there', participants);
      expect(result).toEqual([]);
    });

    it('should not duplicate mentions', () => {
      const result = cm.parseMentions('@alice @Alice @alice', participants);
      expect(result).toEqual(['alice']);
    });
  });

  describe('buildTaskContent', () => {
    it('should generate valid TASK.md content', () => {
      const cm = new ContextManager({ windowSize: 10 });

      const context: AgentContext = {
        agentId: 'alice',
        agentName: 'Alice',
        roleDescription: 'Senior Engineer',
        traits: 'intelligence: very high',
        constraints: 'Must be polite',
        participants,
        recentMessages: [
          createMessage('1', 'user', 'What do you think about the project?'),
        ],
        currentMessage: 'Any suggestions?',
        relationshipSummary: '- Bob: trust +0.6',
      };

      const content = cm.buildTaskContent(context);

      expect(content).toContain('# Group Chat');
      expect(content).toContain('Alice');
      expect(content).toContain('Senior Engineer');
      expect(content).toContain('intelligence: very high');
      expect(content).toContain('Must be polite');
      expect(content).toContain('Bob');
      expect(content).toContain('(you)');
      expect(content).toContain('Any suggestions?');
      expect(content).toContain('SUBMISSION.md');
      expect(content).toContain('trust +0.6');
    });

    it('should indicate @mention in TASK.md when agent is mentioned', () => {
      const cm = new ContextManager({ windowSize: 10 });

      const context: AgentContext = {
        agentId: 'alice',
        agentName: 'Alice',
        roleDescription: 'Engineer',
        traits: '',
        constraints: '',
        participants,
        recentMessages: [],
        currentMessage: '@Alice what do you think?',
        isMentioned: true,
        isTargeted: true,
      };

      const content = cm.buildTaskContent(context);

      expect(content).toContain('You were @mentioned');
      expect(content).toContain('directly @mentioned');
    });

    it('should indicate non-mentioned status when others are targeted', () => {
      const cm = new ContextManager({ windowSize: 10 });

      const context: AgentContext = {
        agentId: 'bob',
        agentName: 'Bob',
        roleDescription: 'Designer',
        traits: '',
        constraints: '',
        participants,
        recentMessages: [],
        currentMessage: '@Alice what do you think?',
        isMentioned: false,
        isTargeted: true,
      };

      const content = cm.buildTaskContent(context);

      expect(content).toContain('@mentioned specific agents (not you)');
    });

    it('should handle empty messages and no relationships', () => {
      const cm = new ContextManager({ windowSize: 10 });

      const context: AgentContext = {
        agentId: 'alice',
        agentName: 'Alice',
        roleDescription: 'Engineer',
        traits: '',
        constraints: '',
        participants,
        recentMessages: [],
        currentMessage: 'Hello everyone',
      };

      const content = cm.buildTaskContent(context);

      expect(content).toContain('Hello everyone');
      expect(content).not.toContain('Your Relationships');
    });
  });
});
