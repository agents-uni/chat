/**
 * Chat Dispatcher — adapts chat messages to OpenClaw's TASK.md / SUBMISSION.md protocol.
 *
 * Wraps @agents-uni/core's TaskDispatcher to:
 * 1. Convert user chat messages → TASK.md with chat context
 * 2. Dispatch to all participant workspaces
 * 3. Collect SUBMISSION.md responses
 * 4. Parse responses back into ChatMessages
 */

import { TaskDispatcher, type WorkspaceIO, type DispatchTask, type DispatchResult } from '@agents-uni/core';
import { ContextManager } from './context.js';
import type { ChatMessage, ParticipantInfo, AgentContext } from '../types.js';

export interface ChatDispatcherOptions {
  pollIntervalMs?: number;
  responseTimeoutMs?: number;
}

export class ChatDispatcher {
  private readonly taskDispatcher: TaskDispatcher;
  private readonly io: WorkspaceIO;
  private readonly contextManager: ContextManager;
  private readonly responseTimeoutMs: number;

  constructor(
    io: WorkspaceIO,
    contextManager: ContextManager,
    options: ChatDispatcherOptions = {}
  ) {
    this.io = io;
    this.contextManager = contextManager;
    this.responseTimeoutMs = options.responseTimeoutMs ?? 120_000;

    this.taskDispatcher = new TaskDispatcher(io, {
      pollIntervalMs: options.pollIntervalMs ?? 2000,
      cleanup: true,
    });
  }

  /**
   * Dispatch a user message to all agents and collect their responses.
   *
   * Flow:
   * 1. For each agent, build a personalized TASK.md with chat context
   * 2. Write TASK.md to each agent's workspace
   * 3. Poll for SUBMISSION.md from each agent
   * 4. Parse submissions into ChatMessage[]
   */
  async dispatchAndCollect(
    userMessage: string,
    participants: ParticipantInfo[],
    allMessages: ChatMessage[],
    buildAgentContext: (agentId: string) => AgentContext
  ): Promise<ChatMessage[]> {
    const taskId = `chat-${Date.now()}`;
    const agentIds = participants.map(p => p.id);

    // Write personalized TASK.md for each agent
    const dispatchFailed: string[] = [];
    for (const agent of participants) {
      try {
        const context = buildAgentContext(agent.id);
        const taskContent = this.contextManager.buildTaskContent(context);
        await this.io.writeTask(agent.id, taskContent);
      } catch (err) {
        dispatchFailed.push(agent.id);
        console.warn(
          `[ChatDispatcher] Failed to dispatch to ${agent.id}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    // Clear any stale submissions
    for (const agentId of agentIds) {
      if (!dispatchFailed.includes(agentId)) {
        try {
          await this.io.clearSubmission(agentId);
        } catch {
          // best-effort
        }
      }
    }

    // Re-write tasks (TaskDispatcher clears then writes, so we do it manually)
    // Actually we already wrote the tasks above with personalized content.
    // Now we just poll for submissions manually.
    const activeAgents = agentIds.filter(id => !dispatchFailed.includes(id));
    const responses = await this.pollForResponses(activeAgents, participants);

    return responses;
  }

  /**
   * Poll agent workspaces for SUBMISSION.md responses.
   */
  private async pollForResponses(
    agentIds: string[],
    participants: ParticipantInfo[]
  ): Promise<ChatMessage[]> {
    const startTime = Date.now();
    const remaining = new Set(agentIds);
    const responses: ChatMessage[] = [];
    const participantMap = new Map(participants.map(p => [p.id, p]));

    while (remaining.size > 0) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= this.responseTimeoutMs) break;

      for (const agentId of [...remaining]) {
        try {
          const raw = await this.io.readSubmission(agentId);
          if (raw !== null) {
            const agent = participantMap.get(agentId);
            responses.push({
              id: `msg-${agentId}-${Date.now()}`,
              role: 'agent',
              agentId,
              agentName: agent?.name ?? agentId,
              content: raw.trim(),
              timestamp: new Date().toISOString(),
            });
            remaining.delete(agentId);

            // Clean up immediately
            try {
              await this.io.clearSubmission(agentId);
              await this.io.clearTask(agentId);
            } catch {
              // best-effort cleanup
            }
          }
        } catch {
          // transient read failure, retry next poll
        }
      }

      if (remaining.size === 0) break;

      // Wait before next poll
      const remainingMs = this.responseTimeoutMs - (Date.now() - startTime);
      if (remainingMs <= 0) break;
      await sleep(Math.min(2000, remainingMs));
    }

    // Clean up timed-out agents
    for (const agentId of remaining) {
      try {
        await this.io.clearTask(agentId);
      } catch {
        // best-effort
      }
    }

    return responses;
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}
