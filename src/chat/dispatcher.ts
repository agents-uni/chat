/**
 * Chat Dispatcher — serial agent execution via OpenClaw CLI.
 *
 * Key design (aligned with edict's orchestrator pattern):
 * - Agents are triggered ONE AT A TIME, serially
 * - Each agent's response is collected before the next is triggered
 * - Later agents see earlier agents' responses in their context
 * - Uses `openclaw agent` CLI to trigger execution
 */

import { spawn } from 'node:child_process';
import { TaskDispatcher, type WorkspaceIO } from '@agents-uni/core';
import { ContextManager } from './context.js';
import type { ChatMessage, ParticipantInfo, AgentContext } from '../types.js';
import type { Logger } from '../utils/logger.js';

export interface ChatDispatcherOptions {
  pollIntervalMs?: number;
  responseTimeoutMs?: number;
}

const AGENT_TRIGGER_MESSAGE =
  'A TASK.md has been placed in your workspace directory. Please: ' +
  '1) Read the TASK.md file. ' +
  '2) Complete the task described in it. ' +
  '3) Write your complete response to a file called SUBMISSION.md in the same workspace directory using the write tool. ' +
  'Only write the response content to SUBMISSION.md — no metadata or headers.';

/**
 * Callback invoked after each individual agent responds.
 * Used by the engine to add the response to history and broadcast in real-time.
 */
export type OnAgentResponse = (response: ChatMessage) => void;

export class ChatDispatcher {
  private readonly io: WorkspaceIO;
  private readonly contextManager: ContextManager;
  private readonly responseTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly logger?: Logger;

  constructor(
    io: WorkspaceIO,
    contextManager: ContextManager,
    options: ChatDispatcherOptions = {},
    logger?: Logger
  ) {
    this.io = io;
    this.contextManager = contextManager;
    this.responseTimeoutMs = options.responseTimeoutMs ?? 120_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.logger = logger;
  }

  /**
   * Dispatch to agents SERIALLY and collect responses one by one.
   *
   * Flow for each agent:
   * 1. Build personalized TASK.md (includes prior agents' responses)
   * 2. Write TASK.md to workspace
   * 3. Trigger via `openclaw agent` CLI
   * 4. Poll for SUBMISSION.md
   * 5. On response: invoke onResponse callback (broadcast + add to history)
   * 6. Move to next agent
   */
  async dispatchAndCollect(
    userMessage: string,
    participants: ParticipantInfo[],
    allMessages: ChatMessage[],
    buildAgentContext: (agentId: string) => AgentContext,
    onResponse?: OnAgentResponse
  ): Promise<ChatMessage[]> {
    const responses: ChatMessage[] = [];

    this.logger?.debug(
      'Dispatcher',
      'dispatchSerial',
      `agents=${JSON.stringify(participants.map(p => p.id))}, count=${participants.length}`
    );

    for (const agent of participants) {
      this.logger?.debug('Dispatcher', 'startAgent', `serial dispatch`, agent.id);

      try {
        // Build context (includes responses from agents who already replied this round)
        const context = buildAgentContext(agent.id);
        const taskContent = this.contextManager.buildTaskContent(context);

        // Write TASK.md
        await this.io.writeTask(agent.id, taskContent);
        this.logger?.debug('Dispatcher', 'writeTask', `contentLength=${taskContent.length}`, agent.id);

        // Clear stale submission
        try {
          await this.io.clearSubmission(agent.id);
        } catch {
          // best-effort
        }

        // Trigger agent via openclaw CLI
        this.triggerAgent(agent.id);

        // Poll for this agent's response
        const response = await this.pollForSingleResponse(agent);

        if (response) {
          responses.push(response);
          // Immediately notify engine so the response is added to history
          // and subsequent agents can see it in their context
          onResponse?.(response);
          this.logger?.debug('Dispatcher', 'responseReceived', `length=${response.content.length}`, agent.id);
        } else {
          this.logger?.debug('Dispatcher', 'timeout', undefined, agent.id);
        }

        // Clean up
        try {
          await this.io.clearTask(agent.id);
          await this.io.clearSubmission(agent.id);
        } catch {
          // best-effort
        }
      } catch (err) {
        this.logger?.debug(
          'Dispatcher',
          'agentFailed',
          err instanceof Error ? err.message : String(err),
          agent.id
        );
        console.warn(
          `[ChatDispatcher] Failed to dispatch to ${agent.id}:`,
          err instanceof Error ? err.message : err
        );
        // Continue to next agent
      }
    }

    return responses;
  }

  /**
   * Trigger a single agent via `openclaw agent` CLI.
   * Fire-and-forget — the polling loop detects the response.
   */
  private triggerAgent(agentId: string): void {
    try {
      const child = spawn('openclaw', [
        'agent',
        '--agent', agentId,
        '--message', AGENT_TRIGGER_MESSAGE,
      ], {
        stdio: 'ignore',
      });

      this.logger?.debug('Dispatcher', 'triggerAgent', 'spawned', agentId);

      child.on('error', (err) => {
        this.logger?.debug('Dispatcher', 'triggerAgentFailed', err.message, agentId);
      });
    } catch (err) {
      this.logger?.debug(
        'Dispatcher',
        'triggerAgentFailed',
        err instanceof Error ? err.message : String(err),
        agentId
      );
      console.warn(
        `[ChatDispatcher] Failed to trigger agent ${agentId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Poll for a single agent's SUBMISSION.md response.
   */
  private async pollForSingleResponse(
    agent: ParticipantInfo
  ): Promise<ChatMessage | null> {
    const startTime = Date.now();

    while (true) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= this.responseTimeoutMs) return null;

      try {
        const raw = await this.io.readSubmission(agent.id);
        if (raw !== null) {
          return {
            id: `msg-${agent.id}-${Date.now()}`,
            role: 'agent',
            agentId: agent.id,
            agentName: agent.name ?? agent.id,
            content: raw.trim(),
            timestamp: new Date().toISOString(),
          };
        }
      } catch {
        // transient read failure, retry
      }

      const remainingMs = this.responseTimeoutMs - (Date.now() - startTime);
      if (remainingMs <= 0) return null;
      await sleep(Math.min(this.pollIntervalMs, remainingMs));
    }
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}
