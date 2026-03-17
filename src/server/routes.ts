/**
 * API Routes for group chat service.
 *
 * All endpoints are prefixed with /api by the parent router.
 */

import { Hono } from 'hono';
import type { ChatEngine } from '../chat/engine.js';

// ─── Connected clients for SSE-based broadcasting ──

interface SSEClient {
  id: string;
  controller: ReadableStreamDefaultController;
}

export function createRoutes(engine: ChatEngine): Hono {
  const app = new Hono();
  const clients: SSEClient[] = [];

  // Register engine callbacks for broadcasting
  engine.onEvent({
    onMessage: (message) => {
      broadcast({ type: 'chat_message', message });
    },
    onStatusChange: (status) => {
      broadcast({ type: 'status_change', status });
    },
    onRelationshipChange: (changes) => {
      broadcast({ type: 'relationship_update', changes });
    },
  });

  // ── SSE Broadcast ──

  function broadcast(data: Record<string, unknown>): void {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    const deadClients: string[] = [];

    for (const client of clients) {
      try {
        const encoder = new TextEncoder();
        client.controller.enqueue(encoder.encode(payload));
      } catch {
        deadClients.push(client.id);
      }
    }

    // Remove dead clients
    for (const id of deadClients) {
      const idx = clients.findIndex(c => c.id === id);
      if (idx >= 0) clients.splice(idx, 1);
    }
  }

  // ── SSE Endpoint (replaces WebSocket for simplicity) ──

  app.get('/events', (c) => {
    const stream = new ReadableStream({
      start(controller) {
        const clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        clients.push({ id: clientId, controller });

        // Send initial state
        const encoder = new TextEncoder();
        const session = engine.getSession();
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'state', session })}\n\n`)
        );

        // Keep-alive ping every 30s
        const keepAlive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {
            clearInterval(keepAlive);
          }
        }, 30_000);
      },
      cancel() {
        // Client disconnected — cleanup handled by broadcast
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  });

  // ── REST Endpoints ──

  /**
   * GET /api/state — Current session state
   */
  app.get('/state', (c) => {
    return c.json(engine.getSession());
  });

  /**
   * GET /api/relations — Relationship graph data
   */
  app.get('/relations', (c) => {
    return c.json(engine.getRelationships());
  });

  /**
   * GET /api/config — Universe configuration
   */
  app.get('/config', (c) => {
    const config = engine.getConfig();
    return c.json({
      name: config.name,
      description: config.description,
      type: config.type,
      agents: config.agents.map(a => ({
        id: a.id,
        name: a.name,
        role: a.role.title,
        department: a.role.department,
      })),
    });
  });

  /**
   * POST /api/message — Send a user message
   *
   * Body: { content: string }
   * Returns: { responses: ChatMessage[] }
   */
  app.post('/message', async (c) => {
    try {
      const body = await c.req.json<{ content: string }>();

      if (!body.content || typeof body.content !== 'string') {
        return c.json({ error: 'content is required' }, 400);
      }

      if (body.content.trim().length === 0) {
        return c.json({ error: 'content cannot be empty' }, 400);
      }

      const responses = await engine.processMessage(body.content.trim());

      return c.json({
        responses,
        session: engine.getSession(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';

      if (message.includes('currently processing')) {
        return c.json({ error: message }, 409);
      }

      console.error('[ChatServer] Error processing message:', err);
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
