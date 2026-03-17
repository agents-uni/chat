#!/usr/bin/env node
/**
 * @agents-uni/chat — Group chat CLI entry point.
 *
 * Usage:
 *   agents-chat serve --spec universe.yaml --port 3000
 *   agents-chat serve  (auto-detect universe.yaml in cwd)
 */

import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from './server/index.js';

const program = new Command();

program
  .name('agents-chat')
  .description('Group chat service for agent universes')
  .version('0.1.0');

program
  .command('serve')
  .description('Start the group chat web server')
  .option('-s, --spec <path>', 'Path to universe.yaml spec file')
  .option('-p, --port <number>', 'Server port', '3000')
  .option('--openclaw-dir <path>', 'OpenClaw workspace directory')
  .option('--context-window <number>', 'Max messages in context window', '20')
  .option('--timeout <number>', 'Agent response timeout in seconds', '120')
  .action(async (opts) => {
    // Resolve spec path
    let specPath = opts.spec;
    if (!specPath) {
      // Auto-detect in cwd
      const candidates = ['universe.yaml', 'universe.yml'];
      for (const candidate of candidates) {
        const fullPath = resolve(process.cwd(), candidate);
        if (existsSync(fullPath)) {
          specPath = fullPath;
          break;
        }
      }
    }

    if (!specPath) {
      console.error('Error: No universe.yaml found. Use --spec to specify the path.');
      process.exit(1);
    }

    specPath = resolve(specPath);
    if (!existsSync(specPath)) {
      console.error(`Error: Spec file not found: ${specPath}`);
      process.exit(1);
    }

    const port = parseInt(opts.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error('Error: Invalid port number');
      process.exit(1);
    }

    await startServer({
      port,
      specPath,
      openclawDir: opts.openclawDir,
      contextWindowSize: parseInt(opts.contextWindow, 10),
      responseTimeoutMs: parseInt(opts.timeout, 10) * 1000,
    });
  });

program.parse();

// Re-export for library usage
export { ChatEngine } from './chat/engine.js';
export { ContextManager } from './chat/context.js';
export { ChatDispatcher } from './chat/dispatcher.js';
export { RelationshipTracker } from './relationship/tracker.js';
export { startServer } from './server/index.js';
export type {
  ChatMessage,
  ChatSession,
  ChatStatus,
  ParticipantInfo,
  ChatEngineOptions,
  ServerConfig,
  RelationshipChange,
} from './types.js';
