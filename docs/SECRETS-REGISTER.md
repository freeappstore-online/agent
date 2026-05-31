# FreeAppStore — Secrets Register

Last updated: 2026-05-31

## Master Credentials

All infra secrets are managed in **Doppler** (project: `fas`, config: `prd`).
Doppler auto-syncs to GitHub org secrets. See `~/dev/stores/SECRETS.md` for full docs.

| # | Name | What it is | Where it lives | Used by |
|---|------|-----------|----------------|---------|
| 1 | **GITHUB_TOKEN** | Fine-grained PAT for `freeappstore-online` org | Doppler `fas` + wrangler secret on agent | Agent (repo create + push) |
| 2 | **SESSION_SIGNING_KEY** | HMAC key for session tokens | Doppler `fas` + wrangler secret on API | API (auth) |
| 3 | **APP_SECRET_KEK** | AES-256 key for app secrets encryption | Doppler `fas` + wrangler secret on API | API (secrets vault) |
| 4 | **GITHUB_CLIENT_SECRET** | OAuth App secret | Doppler `fas` + wrangler secret on API | API (GitHub OAuth) |
| 5 | **RESEND_API_KEY** | Transactional email | Doppler `fas` + wrangler secret on API | API (email) |
| 6 | **CLOUDFLARE_API_TOKEN** | R2/D1 access for GitHub Actions | Doppler `fas` → auto-synced to GH org | GitHub Actions (deploy) |

## Where each secret is deployed

```
                        Agent   API   Admin   Host
GITHUB_TOKEN              ✓
SESSION_SIGNING_KEY               ✓
APP_SECRET_KEK                    ✓
GITHUB_CLIENT_SECRET              ✓
RESEND_API_KEY                    ✓
CLOUDFLARE_API_TOKEN    (GH Actions — org-level, all repos)
```

Notes:
- Agent only needs GITHUB_TOKEN (creates repo + pushes; GH Actions does R2 deploy)
- CF_API_TOKEN is **no longer used** by the agent (legacy from CF Pages era)
- All secrets are in Doppler → auto-synced to GitHub org secrets
- Worker secrets (`wrangler secret put`) must also be updated in Doppler

## How to set/rotate secrets

```bash
# Update in Doppler (source of truth — auto-syncs to GitHub)
doppler secrets set KEY=value --project fas --config prd

# For Worker secrets, also update via wrangler:
echo "value" | npx wrangler secret put KEY --name worker-name
```

## Verify

```bash
curl -s https://agent.freeappstore.online/health | jq .ok
curl -s https://api.freeappstore.online/health | jq .ok
```
