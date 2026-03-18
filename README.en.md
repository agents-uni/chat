*English | [中文](README.md)*

# @agents-uni/chat

> Group chat service for agent universes — a conversational wrapper over OpenClaw

## What is agents-uni/chat?

`@agents-uni/chat` provides a local web-based group chat service for agent universes. Users can chat with all agents in a browser, while agents can reference, discuss, and collaborate with each other.

Under the hood, it wraps OpenClaw's file protocol (TASK.md / SUBMISSION.md) in a chat interface.

## Features

- **Chat UI** — Dark-themed web interface with real-time agent responses
- **Context Management** — Sliding window mechanism with per-agent personalized context
- **Sequential Execution** — One message at a time; wait for all agents before sending the next
- **Relationship Evolution** — Automatically infers relationship events from conversations (agreement/disagreement/collaboration/consensus)
- **SSE Real-time** — Agent responses pushed to the browser instantly
- **Debug Mode** — `--debug` enables full dispatch logging to terminal + SSE
- **OpenClaw Compatible** — Uses TASK.md/SUBMISSION.md file protocol underneath

## Quick Start

### Prerequisites

1. **Install and configure OpenClaw** — agents run on the OpenClaw runtime
2. **Deploy Universe** — use `bridge import` to import agents and run `deploy` to ensure `~/.openclaw/workspace-{agentId}/SOUL.md` exists for each agent
3. **Start OpenClaw Gateway** — run `openclaw` to start the gateway. The chat service triggers agents via the `openclaw agent` CLI

```bash
# 1. Import agents (if not already imported)
agents-uni bridge import ./agency-agents

# 2. Deploy to OpenClaw
agents-uni deploy

# 3. Start OpenClaw gateway (keep running)
openclaw
```

> **Important**: If the OpenClaw gateway is not running, the chat service will still start but all agents will time out with no responses.

### Install

```bash
npm install @agents-uni/chat
```

### Launch

```bash
# In a directory containing universe.yaml
npx agents-chat serve

# Or specify the config file
npx agents-chat serve --spec path/to/universe.yaml --port 3000
```

Open `http://localhost:3000` in your browser to start chatting.

### CLI Options

```
agents-chat serve [options]

Options:
  -s, --spec <path>           Path to universe.yaml (auto-detected by default)
  -p, --port <number>         Port number (default: 3000)
  --openclaw-dir <path>       OpenClaw workspace directory
  --context-window <number>   Context window size (default: 20 messages)
  --timeout <number>          Agent response timeout in seconds (default: 120)
  --debug                     Enable debug logging (default: off)
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│                Browser (Chat UI)                 │
│         HTML/CSS/JS · SSE Real-time              │
└────────────────────┬────────────────────────────┘
                     │ HTTP + SSE
┌────────────────────┴────────────────────────────┐
│              Hono Server (localhost)              │
│  POST /api/message  GET /api/events  GET /api/*  │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────┴────────────────────────────┐
│                 ChatEngine                        │
│                                                   │
│  ContextManager    ChatDispatcher    RelTracker   │
│  (sliding window)  (TASK.md adapter) (inference)  │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────┴────────────────────────────┐
│            OpenClaw File Protocol                 │
│                                                   │
│  TASK.md ──→ openclaw agent ──→ SUBMISSION.md    │
│              (CLI trigger)                         │
│  @agents-uni/core    @agents-uni/rel              │
│  (Universe parser)   (Relationship engine)        │
└──────────────────────────────────────────────────┘
```

## Core Mechanisms

### Message Flow

1. User sends a message in the UI
2. ChatEngine sets status to `processing` (input disabled)
3. ContextManager builds personalized TASK.md for each agent (identity, relationships, chat history)
4. ChatDispatcher writes TASK.md to each agent's OpenClaw workspace
5. Triggers each agent via `openclaw agent --agent {id}` CLI
6. Polls for SUBMISSION.md, collects agent responses
7. RelationshipTracker infers relationship events from responses
7. Events fed to EvolutionEngine for relationship evolution
8. Status returns to `idle`, user can send the next message

### Context Window

Each agent receives a TASK.md containing:

- **Identity** — Role, personality traits, constraints
- **Participant list** — Everyone in the chat
- **Relationship summary** — Multi-dimensional relationships with other agents
- **Chat history** — Last N messages (sliding window)
- **Current message** — The user's latest message

### Relationship Inference

Detects the following patterns from agent responses:

| Pattern | Event Type | Dimension Impact |
|---------|-----------|-----------------|
| Mentions agent + agreement language | `chat.agreement` | trust +0.05, affinity +0.03 |
| Mentions agent + disagreement language | `chat.disagreement` | rivalry +0.03, respect +0.01 |
| References/expands another agent's ideas | `chat.collaboration` | trust +0.03, synergy +0.05 |
| Majority of agents express agreement | `chat.consensus` | trust +0.02, synergy +0.02 |

### Relationship-Driven Routing

`selectRespondents()` now layers relationship scoring on top of keyword matching:

- Allies of the most recent responding agent (trust > 0.3): +1 point
- Rivals of the most recent responding agent (rivalry > 0.3): +0.5 points
- High-influence agents: +influence×2 points
- Behavior is unchanged when no relationships exist, fully backward-compatible

### Graph Visualization

The sidebar now includes a List/Graph toggle. Graph mode uses vis-network to render the relationship graph:

- Node size = influence, color = cluster
- Edge color = valence, thickness = strength
- Auto-refreshes on relationship changes + displays notifications in the chat stream

### Event Timeline

New `GET /api/relations/timeline` endpoint returns the 50 most recent relationship change events.

## API

### HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/state` | Current session state |
| GET | `/api/config` | Universe configuration |
| GET | `/api/relations` | Relationship graph data |
| GET | `/api/relations/timeline` | 50 most recent relationship change events |
| GET | `/api/events` | SSE real-time event stream |
| POST | `/api/message` | Send a user message |

### Programmatic Usage

```typescript
import { ChatEngine } from '@agents-uni/chat';

const engine = new ChatEngine({
  specPath: './universe.yaml',
  contextWindowSize: 20,
  responseTimeoutMs: 120_000,
});

engine.onEvent({
  onMessage: (msg) => console.log(`[${msg.agentName}] ${msg.content}`),
  onStatusChange: (status) => console.log(`Status: ${status}`),
  onRelationshipChange: (changes) => console.log('Relations evolved:', changes),
});

const responses = await engine.processMessage('What do you all think about this plan?');
```

## Dependencies

- `@agents-uni/core` — Universe parsing, TaskDispatcher, WorkspaceIO
- `@agents-uni/rel` — Multi-dimensional relationship engine, EvolutionEngine
- `hono` — HTTP server
- `commander` — CLI

## Debug Mode

Add `--debug` when starting to enable verbose dispatch logging:

```bash
npx agents-chat serve --debug --spec universe.yaml
```

The terminal will show colored logs for the entire dispatch pipeline:

```
[DEBUG][Engine] processMessage: content="@Alice what do you think?"
[DEBUG][Engine] parseMentions: found=["alice"]
[DEBUG][Engine] routing: targeted=true, agents=["alice"]
[DEBUG][Dispatcher] writeTask: contentLength=1234 (alice)
[DEBUG][Dispatcher] clearSubmission: (alice)
[DEBUG][Dispatcher] poll: waiting=["alice"], elapsed=0ms
[DEBUG][Dispatcher] poll: waiting=["alice"], elapsed=2000ms
[DEBUG][Dispatcher] responseReceived: length=256 (alice)
[DEBUG][Tracker] sentiment: from="alice" → to="dana", type="chat.agreement"
[DEBUG][Engine] relationshipChanges: count=1
```

Debug logs are also pushed to the frontend via SSE (`debug_log` event type), making it easy to inspect in the browser console.

Programmatic usage:

```typescript
const engine = new ChatEngine({
  specPath: './universe.yaml',
  debug: true,
});

// Listen to debug logs
engine.getLogger().onLog((entry) => {
  console.log(entry.source, entry.action, entry.detail);
});
```

## Design Philosophy

- **OpenClaw First** — Wraps the file protocol, doesn't bypass it
- **Sequential Simplicity** — MVP: one message at a time; can be iterated to concurrent later
- **Relationship Driven** — Every conversation round produces relationship signals; agent relationships evolve through dialogue
- **Minimal Dependencies** — Frontend is pure HTML/CSS/JS, zero build step

## License

MIT
