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

  // Register debug log callback for SSE push
  engine.getLogger().onLog((entry) => {
    broadcast({ type: 'debug_log', log: entry });
  });

  // ── SSE Broadcast ──

  const encoder = new TextEncoder();

  function broadcast(data: Record<string, unknown>): void {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    const deadClients: string[] = [];

    for (const client of clients) {
      try {
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
        const client: SSEClient = { id: clientId, controller };
        clients.push(client);

        // Send initial state
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

        // Store keepAlive ref for cleanup on cancel
        (controller as unknown as Record<string, unknown>).__keepAlive = keepAlive;
        (controller as unknown as Record<string, unknown>).__clientId = clientId;
      },
      cancel(controller) {
        // Client disconnected — clean up keepalive and remove from list
        const ctrl = controller as unknown as Record<string, unknown>;
        if (ctrl.__keepAlive) {
          clearInterval(ctrl.__keepAlive as ReturnType<typeof setInterval>);
        }
        const clientId = ctrl.__clientId as string | undefined;
        if (clientId) {
          const idx = clients.findIndex(c => c.id === clientId);
          if (idx >= 0) clients.splice(idx, 1);
        }
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
   * GET /api/relations — Relationship visualization data (enhanced format)
   */
  app.get('/relations', (c) => {
    return c.json(engine.getVisualizationData());
  });

  /**
   * GET /api/relations/timeline — Recent relationship events (last 50)
   */
  app.get('/relations/timeline', (c) => {
    const relBundle = engine.getRelBundle();
    const allRels = relBundle.graph.getAllRelationships();
    const events: Array<{
      timestamp: string;
      from: string;
      to: string;
      type: string;
      description?: string;
    }> = [];

    for (const rel of allRels) {
      for (const evt of rel.memory.shortTerm) {
        events.push({
          timestamp: evt.timestamp,
          from: rel.from,
          to: rel.to,
          type: evt.type,
          description: evt.description,
        });
      }
    }

    // Sort by timestamp descending, take 50
    events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return c.json(events.slice(0, 50));
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
   * PATCH /api/relations — Manually correct a relationship dimension value
   *
   * Body: { from: string, to: string, dimension: string, value: number }
   */
  app.patch('/relations', async (c) => {
    try {
      const body = await c.req.json<{
        from: string;
        to: string;
        dimension: string;
        value: number;
      }>();

      if (!body.from || !body.to || !body.dimension || typeof body.value !== 'number') {
        return c.json({ error: 'from, to, dimension (string) and value (number) are required' }, 400);
      }

      if (body.value < -1 || body.value > 1) {
        return c.json({ error: 'value must be between -1 and 1' }, 400);
      }

      const relBundle = engine.getRelBundle();
      const currentValue = relBundle.graph.getDimensionValue(body.from, body.to, body.dimension);
      const delta = body.value - (currentValue ?? 0);

      relBundle.graph.applyEventBetween(body.from, body.to, {
        type: 'manual.correction',
        impact: { [body.dimension]: delta },
      });

      broadcast({
        type: 'relationship_update',
        changes: [{
          from: body.from,
          to: body.to,
          eventType: 'manual.correction',
        }],
      });

      return c.json(engine.getVisualizationData());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[ChatServer] Error updating relation:', err);
      return c.json({ error: message }, 500);
    }
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
