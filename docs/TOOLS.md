# VibeCode Agent — Tool Reference

## File tools (local, fast)

| Tool | Description | Auth |
|------|-------------|------|
| `write_file` | Create or overwrite a project file | None |
| `read_file` | Read a project file | None |
| `list_files` | List all project files | None |
| `delete_file` | Delete a project file | None |
| `search_files` | Grep across all project files | None |
| `run_compliance_check` | Validate project against platform rules | None |

## Infra tools (server-side, needs secrets)

| Tool | Description | Auth |
|------|-------------|------|
| `deploy` | Create GitHub repo + CF Pages project + push code (preview only — no DNS, no registry) | Session-scoped (sets appId) |
| `push_update` | Push code update to existing app | Session-scoped (must match appId) |
| `check_deploy_status` | Check CF Pages build status | Session-scoped |
| `get_build_logs` | Read CF Pages build logs | Session-scoped |
| `get_ci_results` | Read GitHub Actions check results | Session-scoped |
| `get_audit_results` | Read quality audit results | Any session |
| `list_deployed_apps` | List all apps in registry | Any session |
| `fetch_url` | Fetch a public HTTPS URL | SSRF-protected |

## Deploy vs Publish

The `deploy` tool creates a **preview** — not a published store listing:

| | Deploy (agent) | Publish (future / publisher portal) |
|---|---|---|
| GitHub repo | Creates in org | Already exists |
| CF Pages project | Creates (name: `{id}` or `{id}-{rand}`) | Creates (`free{id}app`) |
| DNS CNAME | No | Yes |
| Custom domain | No | Yes (`{id}.freeappstore.online`) |
| Registry entry | No | Yes |
| Store visibility | No — preview on `.pages.dev` only | Yes — listed on store |

## Compliance checks (run_compliance_check)

Validates 12 rules matching the CI compliance workflow:

1. MIT License file exists
2. No .env.production committed
3. No tracking SDKs (google-analytics, gtag, amplitude, etc.)
4. Brand fonts referenced (Manrope + Fraunces)
5. CSS variables present (--paper, --ink, --accent)
6. HTML meta tags (lang, viewport, title)
7. PWA manifest (name, display, start_url)
8. PWA meta tags (apple-mobile-web-app-capable)
9. FreeAppStore link in source
10. Dark mode support (prefers-color-scheme)
11. pnpm workspace configured
12. No APPNAME placeholders remaining

## Tool execution flow

```
User message
    │
    ▼
Agent loop (agent.ts)
    │
    ├── File tool? → executeTool() locally → result in conversation
    │
    └── Infra tool? → collect, break loop
                          │
                          ▼
                  Session (session.ts)
                      │
                      ├── Auth check: does target ID match session.appId?
                      ├── Execute with env secrets
                      ├── Send SSE tool_result to client
                      └── Feed result into conversation history
```
