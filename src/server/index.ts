/**
 * Hono HTTP + WebSocket server for group chat.
 *
 * Endpoints:
 *   GET  /              → Chat UI (static HTML)
 *   GET  /api/state     → Current session state
 *   GET  /api/relations → Relationship graph data
 *   POST /api/message   → Send a message (HTTP fallback)
 *   WS   /ws            → Real-time WebSocket connection
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { ChatEngine } from '../chat/engine.js';
import type { ServerConfig } from '../types.js';
import { createRoutes } from './routes.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

export async function startServer(config: ServerConfig): Promise<void> {
  // Initialize chat engine
  const engine = new ChatEngine({
    specPath: config.specPath,
    openclawDir: config.openclawDir,
    contextWindowSize: config.contextWindowSize ?? 20,
    responseTimeoutMs: config.responseTimeoutMs ?? 120_000,
    debug: config.debug,
    maxRespondents: config.maxRespondents,
  });

  // Create Hono app
  const app = new Hono();

  // Middleware
  app.use('*', cors());

  // API routes
  const api = createRoutes(engine);
  app.route('/api', api);

  // Resolve public directory
  // Support both development (src/) and production (dist/) paths
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const publicDir = resolve(__dirname, '../../public');

  // Cache static files at startup to avoid blocking readFileSync per request
  const staticCache = new Map<string, string>();
  for (const file of ['index.html', 'style.css', 'script.js']) {
    const filePath = resolve(publicDir, file);
    if (existsSync(filePath)) {
      staticCache.set(file, readFileSync(filePath, 'utf-8'));
    }
  }

  // Health check
  app.get('/health', (c) => c.json({ status: 'ok', universe: engine.getConfig().name }));

  // Serve static files (chat UI)
  app.get('/', (c) => {
    const html = staticCache.get('index.html');
    if (html) return c.html(html);
    return c.text('Chat UI not found. Run from project root.', 404);
  });

  app.get('/style.css', (c) => {
    const css = staticCache.get('style.css');
    if (css) {
      c.header('Content-Type', 'text/css');
      return c.body(css);
    }
    return c.text('', 404);
  });

  app.get('/script.js', (c) => {
    const js = staticCache.get('script.js');
    if (js) {
      c.header('Content-Type', 'application/javascript');
      return c.body(js);
    }
    return c.text('', 404);
  });

  // Start server
  const universeConfig = engine.getConfig();
  console.log('');
  console.log('  \x1b[36m@agents-uni/chat\x1b[0m');
  console.log(`  Universe: \x1b[33m${universeConfig.name}\x1b[0m`);
  console.log(`  Agents:   ${universeConfig.agents.map(a => a.name).join(', ')}`);
  console.log(`  Port:     \x1b[32m${config.port}\x1b[0m`);
  if (config.debug) {
    console.log(`  Debug:    \x1b[35menabled\x1b[0m`);
  }
  console.log('');
  console.log(`  \x1b[2mOpen http://localhost:${config.port} in your browser\x1b[0m`);
  console.log('');

  serve({
    fetch: app.fetch,
    port: config.port,
  });
}
