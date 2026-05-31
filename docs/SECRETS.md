# VibeCode Agent — Secrets Setup

## How secrets work

The agent worker needs 1 secret to deploy apps (create repos + push code).
GitHub Actions handles the R2 deploy automatically on push.
Secrets are set via `wrangler secret put` and accessed by the Durable Object
through its `env` parameter (constructor injection — no header passing).

```
GITHUB_TOKEN     ← wrangler secret (org repo access)
VAPID_PUBLIC_KEY ← wrangler secret (web push notifications)
VAPID_PRIVATE_KEY← wrangler secret (web push notifications)
```

**Note:** `CF_API_TOKEN` is no longer needed. Deploy creates a GitHub repo and
pushes code — GitHub Actions handles the R2 upload via org-level secrets (synced
from Doppler).

## Verify secrets are set

```bash
curl -s https://agent.freeappstore.online/health
# Should show: "ok": true
```

## Where to get each secret

### GITHUB_TOKEN
**What:** GitHub Personal Access Token with org repo access.
**Where:** https://github.com/settings/tokens

For a **fine-grained PAT** (preferred):
- Resource owner: `freeappstore-online`
- Repository access: All repositories
- Permissions: Contents (read/write), Metadata (read)

**Quick method** (uses your gh CLI token):
```bash
echo "$(gh auth token)" | npx wrangler secret put GITHUB_TOKEN
```

## Set secrets

```bash
cd ~/dev/stores/fas/agent

echo "$(gh auth token)" | npx wrangler secret put GITHUB_TOKEN

# Verify
sleep 3
curl -s https://agent.freeappstore.online/health | jq .ok
```

## Secret rotation

Secrets can be rotated by running `wrangler secret put` again with the new value.
No redeployment needed — secrets are hot-swapped.

```bash
echo "new_token_value" | npx wrangler secret put GITHUB_TOKEN
```

## Common issues

| Issue | Cause | Fix |
|-------|-------|-----|
| Deploy fails "no GITHUB_TOKEN" | Secret is empty | Re-set with `echo "value" \| npx wrangler secret put GITHUB_TOKEN` |
| Wrangler secret put hangs | No TTY input | Always pipe via `echo "value" \|` |
| GitHub API 401 | Token expired or wrong scope | Regenerate PAT with correct scopes |
| GH Actions deploy fails | Org secrets not synced from Doppler | Check `doppler secrets --project fas --config prd` |
