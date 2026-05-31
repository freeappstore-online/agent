# VibeCode Agent — Architecture

## Overview

The VibeCode agent lets users build and deploy FreeAppStore apps through conversation.
Users describe what they want, the AI agent writes code, and deploys it — all from the browser.

```
┌─────────────────────────────────────────────────────────┐
│  create.freeappstore.online                              │
│  ┌──────────────────────┐  ┌──────────────────────────┐ │
│  │  Chat panel           │  │  Preview panel           │ │
│  │  (SSE streaming)      │  │  (iframe of deployed app)│ │
│  └──────────┬───────────┘  └──────────────────────────┘ │
└─────────────┼───────────────────────────────────────────┘
              │ POST /session/:id/chat
              ▼
┌─────────────────────────────────────────────────────────┐
│  agent.freeappstore.online (Cloudflare Worker)           │
│  src/index.ts — routes to Durable Objects                │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  AgentSession (Durable Object per session)         │  │
│  │                                                    │  │
│  │  State: messages[], files{}, appId, deployStatus   │  │
│  │                                                    │  │
│  │  Agent Loop (agent.ts):                            │  │
│  │    1. Send messages + tools to AI provider         │  │
│  │    2. Stream text/tool_calls back to client        │  │
│  │    3. Execute file tools locally                   │  │
│  │    4. Return infra tools to session for execution  │  │
│  │    5. Repeat until no more tool calls              │  │
│  │                                                    │  │
│  │  Infra execution (session.ts):                     │  │
│  │    - deploy → GitHub repo + push → GH Actions → R2     │  │
│  │    - push_update → new commit to existing repo     │  │
│  │    - get_build_logs, get_ci_results, etc.          │  │
│  │    - Results fed back into conversation history    │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  Providers:                                              │
│    github.ts  → models.github.ai (free, uses GH token)  │
│    openai.ts  → api.openai.com                           │
│    anthropic.ts → api.anthropic.com                      │
│    google.ts  → generativelanguage.googleapis.com        │
└─────────────────────────────────────────────────────────┘
              │
              ▼ on deploy
┌─────────────────────────────────────────────────────────┐
│  GitHub (freeappstore-online org)                        │
│  → Creates repo, pushes code                             │
│                                                          │
│  GitHub Actions → R2 (fas-apps bucket)                   │
│  → Auto-deploys on push, preview on {id}.freeappstore.online │
└─────────────────────────────────────────────────────────┘
```

## File Structure

```
platform/agent/
├── docs/
│   ├── ARCHITECTURE.md      ← this file
│   ├── SECRETS.md           ← how to set up secrets
│   └── SECURITY.md          ← security model
├── src/
│   ├── index.ts             ← Worker entry, routing, CORS
│   ├── session.ts           ← Durable Object: state, chat handler, infra execution
│   ├── agent.ts             ← Agent loop: AI call → tool execution → repeat
│   ├── tools.ts             ← Tool definitions + local execution (file ops, compliance)
│   ├── deploy.ts            ← Deploy pipeline: repo + push → GH Actions → R2 (write operations)
│   ├── infra.ts             ← Query tools: build logs, CI, audit, list apps (read ops)
│   ├── infra-exec.ts        ← Infra tool execution + authorization checks
│   ├── template.ts          ← Template files + system prompt
│   └── providers/
│       ├── types.ts          ← Shared types (AIConfig, Message, ToolCall, etc.)
│       ├── anthropic.ts      ← Anthropic Claude adapter (streaming SSE)
│       ├── openai.ts         ← OpenAI adapter (streaming SSE)
│       ├── google.ts         ← Google Gemini adapter (streaming SSE)
│       └── github.ts         ← GitHub Models adapter (extends OpenAI)
├── test.sh                   ← Integration tests (15 tests)
├── wrangler.toml             ← Worker config, DO bindings, vars
├── tsconfig.json
└── package.json
```

## Key Design Decisions

### Durable Objects for session state
Each user project gets its own DO instance (keyed by session UUID). The DO stores:
- `messages[]` — full conversation history (survives refresh)
- `files{}` — virtual filesystem (template files + user code)
- `appId` / `appName` — which app was deployed from this session
- `deployStatus` — current deploy pipeline state
- `errors[]` — server-side error log

### File tools vs infra tools
- **File tools** (write_file, read_file, etc.) execute locally in the agent loop — fast, no network
- **Infra tools** (deploy, push_update, etc.) execute in the session with access to env secrets
- Results from infra tools are fed back into the conversation so the agent can react to failures

### Provider adapters
All providers implement the same `ProviderAdapter` interface: `run(systemPrompt, messages, tools) → AsyncGenerator<StreamEvent>`.
The adapters handle SSE parsing, tool call accumulation, and token usage tracking.
GitHub Models adapter extends OpenAI (same API, different base URL).

### SSE streaming
The chat endpoint returns `text/event-stream`. Events:
- `text` — streamed text from the AI
- `tool_call` — agent is calling a tool (shown in UI as tool labels)
- `tool_result` — result of a tool execution
- `usage` — token counts (input/output)
- `deploy_status` — deploy pipeline progress (provisioning steps, building, live)
- `error` — error from provider or tool
- `done` — turn complete

### APPNAME replacement
Template files contain `APPNAME` placeholders. Before deploy, the session replaces them:
- `package.json`, `web/package.json` → app ID (lowercase, e.g. "meditation-timer")
- Everything else → display name (e.g. "Meditation Timer")
