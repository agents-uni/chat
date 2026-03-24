/**
 * Chat Dispatcher — serial agent execution via OpenClaw CLI.
 *
 * Key design (aligned with edict's orchestrator pattern):
 * - Agents are triggered ONE AT A TIME, serially
 * - Each agent's response is collected before the next is triggered
 * - Later agents see earlier agents' responses in their context
 * - Uses `openclaw agent` CLI to trigger execution
 */

import { spawn, type ChildProcess } from 'node:child_process';
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
  '4) After writing SUBMISSION.md, create an empty file named .SUBMISSION_DONE in the same directory to signal completion. ' +
  'Only write the response content to SUBMISSION.md — no metadata or headers.';

/**
 * Callback invoked after each individual agent responds.
 * Used by the engine to add the response to history and broadcast in real-time.
 */
export type OnAgentResponse = (response: ChatMessage) => void;

export interface DispatcherLifecycleCallbacks {
  onAgentThinking?: (agentId: string, agentName: string) => void;
  onAgentDone?: (agentId: string) => void;
  onAgentError?: (agentId: string, error: string) => void;
}

export interface DispatchResult {
  response: ChatMessage | null;
  outcome: 'success' | 'timeout' | 'crash';
}

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
    onResponse?: OnAgentResponse,
    lifecycle?: DispatcherLifecycleCallbacks
  ): Promise<ChatMessage[]> {
    const responses: ChatMessage[] = [];

    this.logger?.debug(
      'Dispatcher',
      'dispatchSerial',
      `agents=${JSON.stringify(participants.map(p => p.id))}, count=${participants.length}`
    );

    for (const agent of participants) {
      this.logger?.debug('Dispatcher', 'startAgent', `serial dispatch`, agent.id);
      lifecycle?.onAgentThinking?.(agent.id, agent.name);

      try {
        const result = await this.dispatchSingleAgent(agent, buildAgentContext);

        if (result.outcome === 'crash') {
          // Retry once on crash
          this.logger?.debug('Dispatcher', 'retryAfterCrash', 'retrying once', agent.id);
          const retryResult = await this.dispatchSingleAgent(agent, buildAgentContext);

          if (retryResult.response) {
            responses.push(retryResult.response);
            onResponse?.(retryResult.response);
            lifecycle?.onAgentDone?.(agent.id);
            this.logger?.debug('Dispatcher', 'retrySuccess', `length=${retryResult.response.content.length}`, agent.id);
          } else {
            // Both attempts failed — notify user
            const errorMsg = `[Agent ${agent.name} encountered an error and could not respond]`;
            lifecycle?.onAgentError?.(agent.id, errorMsg);
            const systemMsg: ChatMessage = {
              id: `msg-err-${agent.id}-${Date.now()}`,
              role: 'system',
              content: errorMsg,
              timestamp: new Date().toISOString(),
            };
            responses.push(systemMsg);
            onResponse?.(systemMsg);
          }
        } else if (result.response) {
          responses.push(result.response);
          onResponse?.(result.response);
          lifecycle?.onAgentDone?.(agent.id);
          this.logger?.debug('Dispatcher', 'responseReceived', `length=${result.response.content.length}`, agent.id);
        } else {
          lifecycle?.onAgentDone?.(agent.id);
          this.logger?.debug('Dispatcher', 'timeout', undefined, agent.id);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        lifecycle?.onAgentError?.(agent.id, errorMsg);
        this.logger?.debug('Dispatcher', 'agentFailed', errorMsg, agent.id);
        this.logger?.warn('Dispatcher', 'agentFailed', `agent=${agent.id}: ${errorMsg}`);
      }
    }

    return responses;
  }

  /**
   * Dispatch to a single agent and return a structured result.
   */
  private async dispatchSingleAgent(
    agent: ParticipantInfo,
    buildAgentContext: (agentId: string) => AgentContext
  ): Promise<DispatchResult> {
    try {
      const context = buildAgentContext(agent.id);
      const taskContent = this.contextManager.buildTaskContent(context);

      await this.io.writeTask(agent.id, taskContent);
      this.logger?.debug('Dispatcher', 'writeTask', `contentLength=${taskContent.length}`, agent.id);

      try {
        await this.io.clearSubmission(agent.id);
      } catch {
        // best-effort
      }

      const child = this.triggerAgent(agent.id);
      const response = await this.pollForSingleResponse(agent, child);

      // Clean up
      try {
        await this.io.clearTask(agent.id);
        await this.io.clearSubmission(agent.id);
      } catch {
        // best-effort
      }

      if (response) {
        return { response, outcome: 'success' };
      }

      // Check if it was a crash (non-zero exit) vs timeout
      // We detect this by checking if the child exited with non-zero
      if (child) {
        return { response: null, outcome: 'crash' };
      }
      return { response: null, outcome: 'timeout' };
    } catch (err) {
      this.logger?.debug(
        'Dispatcher',
        'dispatchSingleFailed',
        err instanceof Error ? err.message : String(err),
        agent.id
      );
      return { response: null, outcome: 'crash' };
    }
  }

  /**
   * Trigger a single agent via `openclaw agent` CLI.
   * Returns the ChildProcess so the poller can detect crashes.
   */
  private triggerAgent(agentId: string): ChildProcess | null {
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

      return child;
    } catch (err) {
      this.logger?.debug(
        'Dispatcher',
        'triggerAgentFailed',
        err instanceof Error ? err.message : String(err),
        agentId
      );
      this.logger?.warn(
        'Dispatcher',
        'triggerAgentFailed',
        `agent=${agentId}: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  /**
   * Poll for a single agent's SUBMISSION.md response.
   * Detects agent crashes via the child process exit code.
   */
  private async pollForSingleResponse(
    agent: ParticipantInfo,
    child: ChildProcess | null
  ): Promise<ChatMessage | null> {
    const startTime = Date.now();
    const CRASH_GRACE_MS = 5000;

    // Track child process exit
    let childExited = false;
    let childExitCode: number | null = null;

    if (child) {
      child.on('exit', (code) => {
        childExited = true;
        childExitCode = code;
      });
    } else {
      // spawn failed — treat as immediate crash
      childExited = true;
      childExitCode = 1;
    }

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
      } catch (err) {
        // transient read failure — log and retry
        this.logger?.debug(
          'Dispatcher',
          'readRetry',
          err instanceof Error ? err.message : String(err),
          agent.id
        );
      }

      // Crash detection: process exited with non-zero and no submission
      if (childExited && childExitCode !== 0) {
        this.logger?.debug(
          'Dispatcher',
          'agentCrashed',
          `exitCode=${childExitCode}`,
          agent.id
        );
        return null;
      }

      // Normal exit (code 0) but no submission yet — short grace window
      if (childExited && childExitCode === 0) {
        const sinceStart = Date.now() - startTime;
        // Give a short grace period after clean exit for file flush
        if (sinceStart > CRASH_GRACE_MS) {
          this.logger?.debug(
            'Dispatcher',
            'agentExitedNoSubmission',
            `gracePeriodExceeded`,
            agent.id
          );
          return null;
        }
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
