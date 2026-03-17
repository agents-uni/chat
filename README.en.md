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
- **OpenClaw Compatible** — Uses TASK.md/SUBMISSION.md file protocol underneath

## Quick Start

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
│  TASK.md ──→ Agent Workspace ──→ SUBMISSION.md   │
│                                                   │
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
5. Polls for SUBMISSION.md, collects agent responses
6. RelationshipTracker infers relationship events from responses
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

## API

### HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/state` | Current session state |
| GET | `/api/config` | Universe configuration |
| GET | `/api/relations` | Relationship graph data |
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

## Design Philosophy

- **OpenClaw First** — Wraps the file protocol, doesn't bypass it
- **Sequential Simplicity** — MVP: one message at a time; can be iterated to concurrent later
- **Relationship Driven** — Every conversation round produces relationship signals; agent relationships evolve through dialogue
- **Minimal Dependencies** — Frontend is pure HTML/CSS/JS, zero build step

## License

MIT
