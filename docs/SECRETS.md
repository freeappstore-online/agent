# VibeCode Agent — Secrets Setup

## How secrets work

The agent worker needs 2 secrets to deploy apps (create repos + CF Pages projects).
Secrets are set via `wrangler secret put` and accessed by the Durable Object
through its `env` parameter (constructor injection — no header passing).

```
CF_ACCOUNT_ID    ← plain var in wrangler.toml (not secret)
GITHUB_TOKEN     ← wrangler secret
CF_API_TOKEN     ← wrangler secret
```

**Note:** `CF_GLOBAL_KEY` and `CF_EMAIL` are declared in the DeployEnv interface but
not used by the agent's deploy flow. DNS CNAME creation happens during *publish*
(publisher worker), not during deploy. They're kept in the type for future use.

## Verify secrets are set

```bash
curl -s https://agent.freeappstore.online/health
# Should show: "hasSecrets": true
```

If `false`, one or more secrets are empty/missing.

## Where to get each secret

### GITHUB_TOKEN
**What:** GitHub Personal Access Token with org repo access.
**Where:** https://github.com/settings/tokens

For a **classic PAT**: select scopes `repo`, `admin:org` (for team membership).

For a **fine-grained PAT** (preferred):
- Resource owner: `freeappstore-online`
- Repository access: All repositories
- Permissions: Contents (read/write), Metadata (read)

**Quick method** (uses your gh CLI token):
```bash
echo "$(gh auth token)" | npx wrangler secret put GITHUB_TOKEN
```

### CF_API_TOKEN
**What:** Cloudflare API token with Pages write access.
**Where:** https://dash.cloudflare.com/profile/api-tokens → Create Token

Use template: "Edit Cloudflare Pages" or custom with:
- Account: your account
- Permissions: Account > Cloudflare Pages (Edit)

**Quick method** (uses wrangler's OAuth token — expires every 2h):
```bash
WRANGLER_TOKEN=$(grep oauth_token ~/Library/Preferences/.wrangler/config/default.toml | cut -d'"' -f2)
echo "$WRANGLER_TOKEN" | npx wrangler secret put CF_API_TOKEN
```

**Better:** Create a long-lived API token from the CF dashboard and store in Bitwarden.

## Set all secrets at once

```bash
cd ~/dev/fas/platform/agent

echo "$(gh auth token)" | npx wrangler secret put GITHUB_TOKEN
echo "YOUR_CF_API_TOKEN" | npx wrangler secret put CF_API_TOKEN

# Verify
sleep 3
curl -s https://agent.freeappstore.online/health | jq .hasSecrets
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
| `hasSecrets: false` | Secrets are empty strings | Re-set with `echo "value" \| npx wrangler secret put NAME` |
| Wrangler secret put hangs | No TTY input | Always pipe via `echo "value" \|` |
| GitHub API 401 | Token expired or wrong scope | Regenerate PAT with correct scopes |
| CF API 403 | Token missing Pages permission | Create new token with Pages Edit scope |
