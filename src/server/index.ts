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
import { serveStatic } from '@hono/node-server/serve-static';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { ChatEngine } from '../chat/engine.js';
import type { ServerConfig, WSServerMessage } from '../types.js';
import { createRoutes } from './routes.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function startServer(config: ServerConfig): Promise<void> {
  // Initialize chat engine
  const engine = new ChatEngine({
    specPath: config.specPath,
    openclawDir: config.openclawDir,
    contextWindowSize: config.contextWindowSize ?? 20,
    responseTimeoutMs: config.responseTimeoutMs ?? 120_000,
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
  let publicDir = resolve(__dirname, '../../public');

  // Health check
  app.get('/health', (c) => c.json({ status: 'ok', universe: engine.getConfig().name }));

  // Serve static files (chat UI)
  app.get('/', async (c) => {
    const fs = await import('node:fs');
    const indexPath = resolve(publicDir, 'index.html');
    try {
      const html = fs.readFileSync(indexPath, 'utf-8');
      return c.html(html);
    } catch {
      return c.text('Chat UI not found. Run from project root.', 404);
    }
  });

  app.get('/style.css', async (c) => {
    const fs = await import('node:fs');
    const cssPath = resolve(publicDir, 'style.css');
    try {
      const css = fs.readFileSync(cssPath, 'utf-8');
      c.header('Content-Type', 'text/css');
      return c.body(css);
    } catch {
      return c.text('', 404);
    }
  });

  app.get('/script.js', async (c) => {
    const fs = await import('node:fs');
    const jsPath = resolve(publicDir, 'script.js');
    try {
      const js = fs.readFileSync(jsPath, 'utf-8');
      c.header('Content-Type', 'application/javascript');
      return c.body(js);
    } catch {
      return c.text('', 404);
    }
  });

  // Start server
  const universeConfig = engine.getConfig();
  console.log('');
  console.log('  \x1b[36m@agents-uni/chat\x1b[0m');
  console.log(`  Universe: \x1b[33m${universeConfig.name}\x1b[0m`);
  console.log(`  Agents:   ${universeConfig.agents.map(a => a.name).join(', ')}`);
  console.log(`  Port:     \x1b[32m${config.port}\x1b[0m`);
  console.log('');
  console.log(`  \x1b[2mOpen http://localhost:${config.port} in your browser\x1b[0m`);
  console.log('');

  serve({
    fetch: app.fetch,
    port: config.port,
  });
}
