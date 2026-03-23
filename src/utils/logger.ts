/**
 * Logger utility — debug logging for group chat dispatch pipeline.
 *
 * When debug mode is enabled, logs are:
 * 1. Printed to terminal with color (via chalk)
 * 2. Forwarded to registered onLog callbacks (for SSE push)
 *
 * When debug mode is off, debug() is a no-op and info() still prints.
 */

import chalk from 'chalk';
import type { DebugLogEntry } from '../types.js';

export interface Logger {
  /** Verbose log — only outputs when debug=true */
  debug(source: string, action: string, detail?: string, agentId?: string): void;
  /** Always outputs (startup info, etc.) */
  info(source: string, action: string, detail?: string): void;
  /** Warning — always outputs */
  warn(source: string, action: string, detail?: string): void;
  /** Error — always outputs */
  error(source: string, action: string, detail?: string): void;
  /** Register a callback to receive log entries (for SSE push) */
  onLog(callback: LogCallback): void;
}

export type LogCallback = (entry: DebugLogEntry) => void;

export function createLogger(debug: boolean): Logger {
  const listeners: LogCallback[] = [];

  function buildEntry(source: string, action: string, detail?: string, agentId?: string): DebugLogEntry {
    return {
      timestamp: new Date().toISOString(),
      source,
      action,
      ...(detail !== undefined && { detail }),
      ...(agentId !== undefined && { agentId }),
    };
  }

  function notifyListeners(entry: DebugLogEntry): void {
    for (const cb of listeners) {
      cb(entry);
    }
  }

  function formatTerminal(entry: DebugLogEntry): string {
    const tag = chalk.gray(`[DEBUG]`) + chalk.cyan(`[${entry.source}]`);
    const agentTag = entry.agentId ? chalk.yellow(` (${entry.agentId})`) : '';
    const detail = entry.detail ? ` ${chalk.white(entry.detail)}` : '';
    return `${tag} ${entry.action}${agentTag}${detail}`;
  }

  function registerOnLog(callback: LogCallback): void {
    listeners.push(callback);
  }

  if (debug) {
    return {
      debug(source, action, detail?, agentId?) {
        const entry = buildEntry(source, action, detail, agentId);
        console.log(formatTerminal(entry));
        notifyListeners(entry);
      },
      info(source, action, detail?) {
        const entry = buildEntry(source, action, detail);
        console.log(chalk.blue(`[INFO][${source}]`) + ` ${action}` + (detail ? ` ${detail}` : ''));
        notifyListeners(entry);
      },
      warn(source, action, detail?) {
        const entry = buildEntry(source, action, detail);
        console.warn(chalk.yellow(`[WARN][${source}]`) + ` ${action}` + (detail ? ` ${detail}` : ''));
        notifyListeners(entry);
      },
      error(source, action, detail?) {
        const entry = buildEntry(source, action, detail);
        console.error(chalk.red(`[ERROR][${source}]`) + ` ${action}` + (detail ? ` ${detail}` : ''));
        notifyListeners(entry);
      },
      onLog: registerOnLog,
    };
  }

  return {
    debug() {
      // no-op when debug is off
    },
    info(source, action, detail?) {
      console.log(`[${source}] ${action}` + (detail ? ` ${detail}` : ''));
    },
    warn(source, action, detail?) {
      console.warn(`[WARN][${source}] ${action}` + (detail ? ` ${detail}` : ''));
    },
    error(source, action, detail?) {
      console.error(`[ERROR][${source}] ${action}` + (detail ? ` ${detail}` : ''));
    },
    onLog: registerOnLog,
  };
}
