# VibeCode Agent — Deployment

## Services

| Service | URL | Source | Deploys via |
|---------|-----|--------|-------------|
| Agent worker | agent.freeappstore.online | `platform/agent/` | `bash scripts/deploy.sh` (safe, doesn't kill DOs) |
| API (auth) | api.freeappstore.online | `platform/packages/backend/` | `npx wrangler deploy` |
| Store site | freeappstore.online | `freeappstore/` | `git push` (GitHub Actions → R2) |
| VibeCode | create.freeappstore.online | `create/` | `git push` (GitHub Actions → R2) |
| Admin | admin.freeappstore.online | `platform/admin/` | `npx wrangler deploy` |
| Publisher | publish.freeappstore.online | `platform/publisher/` | `npx wrangler deploy` |

## Deploy the agent worker

```bash
cd ~/dev/fas/platform/agent
pnpm install
npx tsc --noEmit          # typecheck
bash scripts/deploy.sh    # safe deploy (wrangler versions upload, doesn't kill active DOs)
```

## Deploy the API

```bash
cd ~/dev/fas/platform/api
pnpm install
npx wrangler deploy
```

## Deploy the store site

```bash
cd ~/dev/fas/platform/freeappstore
git add -A && git commit -m "..." && git push
# GitHub Actions deploys to R2 on push to main
```

The build process (`node build.js`) generates:
- `dist/index.html` — app catalog from registry.json + templates
- `dist/apps/*.html` — per-app detail pages
- `dist/quality.html` — quality dashboard
- Copies static files listed in `filesToCopy` array in build.js

**Important:** New HTML files must be added to `filesToCopy` in build.js or they
won't be copied to dist.

## Run tests

```bash
cd ~/dev/fas/platform/agent
bash test.sh                    # 15 integration tests against production
bash test.sh http://localhost:8787  # test against local dev server
```

## Local development

```bash
cd ~/dev/fas/platform/agent
npx wrangler dev                # starts local dev server on :8787
```

For local dev, create a `.dev.vars` file (gitignored):
```
GITHUB_TOKEN=ghp_xxx
```

## Wrangler config

### Agent worker (wrangler.toml)
```toml
name = "freeappstore-agent"
main = "src/index.ts"
compatibility_date = "2025-05-01"
workers_dev = true

[[routes]]
pattern = "agent.freeappstore.online/*"
zone_name = "freeappstore.online"

[durable_objects]
bindings = [
  { name = "SESSION", class_name = "AgentSession" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["AgentSession"]

[vars]
CF_ACCOUNT_ID = "c1089bfcc43c1c6c2aa89e584e86f0bc"
```

### API worker (wrangler.jsonc)
```jsonc
{
  "name": "freeappstore-api",
  "main": "src/index.ts",
  "routes": [{ "pattern": "api.freeappstore.online", "custom_domain": true }],
  "vars": { "GITHUB_CLIENT_ID": "Ov23liuUpYPXc1ikEFm2" },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "fas",
    "database_id": "a32701c0-5a56-4a12-810d-485166202e39"
  }]
}
```

## API Worker

The API worker (`api.freeappstore.online`) handles **platform auth only** — no app-specific routes.
Routes: `/auth/github/url`, `/auth/github/callback`, `/auth/me`, `/auth/github-token`, `/auth/signout`, `/auth/delete`, `/health`.

Individual apps must be fully client-side (localStorage) or have their own worker if they need a backend.

## D1 Database

The API uses a D1 database (`fas`) with tables including:
- `users` — id, github_login, avatar_url, display_name, email, date_of_birth
- `apps` — id, owner_login, category, oneliner, store, repo
- `kv` — app_id, user_id, key, value
- `routes` — slug, zone, r2_prefix (host worker routing)
- `agent_sessions` — session_id, user_id, messages, deploy_state, deploy_log, errors
- `app_logs`, `app_webhooks`, `user_api_keys`, `counters`, `documents`, `app_roles`

Migrations are in `platform/packages/backend/migrations/`. Apply with:
```bash
cd ~/dev/stores/fas/platform/packages/backend
CLOUDFLARE_API_TOKEN=$(doppler secrets get CLOUDFLARE_API_TOKEN --project fas --config prd --plain) \
  npx wrangler d1 migrations apply fas --remote
```

## GitHub OAuth App

- **App ID:** 3576238
- **Client ID:** `Ov23liuUpYPXc1ikEFm2`
- **Settings:** https://github.com/organizations/freeappstore-online/settings/applications/3576238
- **Callback URL:** `https://api.freeappstore.online/auth/github/callback`
- **Scopes requested:** `read:user`, `user:email`, `models:read`

The callback URL MUST be set in the GitHub OAuth App settings. Without it,
sign-in redirects fail with "redirect_uri not associated with this application".

## Custom domains

| Subdomain | Service | Setup method |
|-----------|---------|-------------|
| agent.freeappstore.online | Agent worker | Workers Domains API (auto DNS) |
| api.freeappstore.online | API worker | Custom domain in wrangler.jsonc |
| admin.freeappstore.online | Admin worker | Route in wrangler.toml |
| publish.freeappstore.online | Publisher worker | Route in wrangler.toml |
| *.freeappstore.online (apps) | Host worker | R2 + D1 routes table (host.freeappstore.online) |
