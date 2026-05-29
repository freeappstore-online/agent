# FreeAppStore — Secrets Register

Last updated: 2026-05-11

## Master Credentials (6 unique secrets)

| # | Name | What it is | Where to get/roll | Used by |
|---|------|-----------|-------------------|---------|
| 1 | **GITHUB_TOKEN** | GitHub Personal Access Token (classic) for the `freeappstore-online` org | https://github.com/settings/tokens → Generate → scopes: `repo`, `admin:org` | Agent, Admin, Publisher |
| 2 | **CF_API_TOKEN** | Cloudflare API Token with Pages edit access | https://dash.cloudflare.com/profile/api-tokens → Create Token → template "Edit Cloudflare Pages" | Agent, Admin, Publisher |
| 3 | **CF_GLOBAL_KEY** | Cloudflare Global API Key (for DNS record creation) | https://dash.cloudflare.com/profile/api-tokens → "Global API Key" → View | Publisher only |
| 4 | **CF_EMAIL** | Cloudflare account email (pairs with Global Key) | Your Cloudflare login email | Publisher only |
| 5 | **GITHUB_CLIENT_SECRET** | OAuth App secret for "FreeAppStore" GitHub OAuth app | https://github.com/organizations/freeappstore-online/settings/applications/3576238 → Client Secret → Generate | API |
| 6 | **MAX_APPS_PER_USER** | Per-user app limit for publisher (not a secret, but a config) | Env var on publisher worker | Publisher |

## Where each secret is deployed

```
                        Agent   Admin   Publisher   API
GITHUB_TOKEN              ✓       ✓        ✓
CF_API_TOKEN              ✓       ✓        ✓
CF_GLOBAL_KEY                              ✓
CF_EMAIL                                   ✓
GITHUB_CLIENT_SECRET                                 ✓
```

Notes:
- Agent only needs GITHUB_TOKEN + CF_API_TOKEN (deploy creates repo + CF Pages, no DNS)
- Admin only needs GITHUB_TOKEN + CF_API_TOKEN (monitoring + registry reads/writes)
- Publisher needs all 4 infra secrets (creates DNS CNAME during publish)
- CF_GLOBAL_KEY and CF_EMAIL were removed from admin (no longer provisions)

## Public config (not secret — committed to code)

| Name | Value | Where |
|------|-------|-------|
| CF_ACCOUNT_ID | `c1089bfcc43c1c6c2aa89e584e86f0bc` | wrangler.toml `[vars]` |
| GITHUB_CLIENT_ID | `Ov23liuUpYPXc1ikEFm2` | API wrangler.jsonc `vars` |
| D1 Database ID | `2e998d10-6c2f-4e35-8dc8-9305888a5f58` | API wrangler.jsonc |
| Zone ID (freeappstore) | `ebe8a9b64cb958520b8c32114f7f06ec` | publisher publish.ts |
| Zone ID (freegamestore) | `fd33f88109b97569f2c5d6f1e5bb62ae` | publisher publish.ts |
| OAuth App ID | `3576238` | GitHub org settings |

## How to set secrets

### Quick method (sets all workers at once)

```bash
# 1. GITHUB_TOKEN (from gh CLI)
GH_TOKEN=$(gh auth token)
for worker in freeappstore-agent freeappstore-admin freeappstore-publisher; do
  echo "$GH_TOKEN" | npx wrangler secret put GITHUB_TOKEN --name "$worker"
done

# 2. CF_API_TOKEN (long-lived, from CF dashboard)
read -sp "CF API Token: " CF_TOKEN && echo
for worker in freeappstore-agent freeappstore-admin freeappstore-publisher; do
  echo "$CF_TOKEN" | npx wrangler secret put CF_API_TOKEN --name "$worker"
done

# 3. CF_GLOBAL_KEY (publisher only — for DNS)
read -sp "CF Global Key: " CF_KEY && echo
echo "$CF_KEY" | npx wrangler secret put CF_GLOBAL_KEY --name freeappstore-publisher

# 4. CF_EMAIL (publisher only)
echo "your@email.com" | npx wrangler secret put CF_EMAIL --name freeappstore-publisher

# 5. GITHUB_CLIENT_SECRET (API only — from GitHub OAuth app settings)
read -sp "GitHub OAuth Client Secret: " GH_SECRET && echo
echo "$GH_SECRET" | npx wrangler secret put GITHUB_CLIENT_SECRET --name freeappstore-api
```

### Verify

```bash
curl -s https://agent.freeappstore.online/health | jq .hasSecrets
# true

curl -s https://api.freeappstore.online/health
# {"ok":true, ...}
```

## How to roll (rotate) each secret

| Secret | How to roll | Impact |
|--------|------------|--------|
| GITHUB_TOKEN | Generate new PAT → set on agent + admin + publisher | Old token stops working immediately |
| CF_API_TOKEN | Create new token in CF dashboard → set on agent + admin + publisher | Old token revoked manually |
| CF_GLOBAL_KEY | Cannot be rolled (tied to account) | N/A |
| CF_EMAIL | Cannot change without changing CF account | N/A |
| GITHUB_CLIENT_SECRET | Regenerate in OAuth App settings → set on API | Old secret stops working — users must re-sign-in |
