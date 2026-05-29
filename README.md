# VibeCode Agent

AI-powered app builder for [FreeAppStore](https://freeappstore.online). Users describe an app in natural language, the agent builds it with React + Vite, and deploys it to R2 via GitHub Actions.

Deployed at `agent.freeappstore.online`. Called by the [VibeCode frontend](https://create.freeappstore.online).

## Architecture

Cloudflare Worker + Durable Objects. Each chat session is a DO instance that holds conversation history, a virtual filesystem, and deploy state.

```
src/
├── index.ts          Worker entry — routes to DO sessions
├── session.ts        Durable Object — chat, deploy, import
├── agent.ts          Agent loop — system prompt + tool dispatch
├── deploy.ts         GitHub repo creation + code push
├── infra.ts          Read-only GitHub Actions / audit queries
├── infra-exec.ts     Tool execution bridge (validation + routing)
├── tools.ts          Tool definitions + execution
├── template.ts       Scaffold files + deploy workflow
├── config.ts         Store config (FAS / FGS)
├── cors.ts           Shared CORS headers
├── github.ts         Shared GitHub API helper
├── push.ts           Web push notifications
└── providers/
    ├── types.ts      Unified types (Message, ToolCall, StreamEvent)
    ├── sse.ts        Shared SSE line reader
    ├── anthropic.ts  Claude adapter
    ├── openai.ts     OpenAI / OpenRouter adapter
    ├── google.ts     Gemini adapter
    └── github.ts     GitHub Models adapter (OpenAI-compat)
```

## Development

```bash
pnpm install
pnpm dev              # local dev server
npx vitest run        # run tests
npx biome check src/  # lint + format
```

## Deployment

Push to `main` auto-deploys via GitHub Actions. Secrets required:
- `GITHUB_TOKEN` — org-level PAT for repo provisioning
- `VAPID_PRIVATE_KEY` — for web push notifications
