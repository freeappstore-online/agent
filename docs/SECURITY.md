# VibeCode Agent — Security Model

## Threat model

Users interact with an AI agent that can write code and deploy it. Key threats:
1. **Cross-user access** — User A deploys to User B's app
2. **Prompt injection** — User tricks the agent into harmful actions
3. **SSRF** — Agent's fetch_url tool used to scan internal networks
4. **Token abuse** — Platform tokens used beyond intended scope
5. **Resource exhaustion** — User creates unlimited apps/sessions

## Defenses

### 1. Session-scoped authorization (enforced server-side)

Every session tracks which app was deployed (`session.appId`).
Write operations are locked to that app:

```
deploy          → sets session.appId, can only be called once per session
push_update     → target ID must match session.appId
get_build_logs  → target ID must match session.appId
get_ci_results  → target ID must match session.appId
check_deploy_status → target ID must match session.appId
```

If a user (or a prompt-injected agent) tries `push_update(id="timer")` but the
session deployed `meditation-timer`, the server returns:
```
Error: you can only push_update on your own app "meditation-timer".
You don't have permission to access "timer".
```

This is enforced in `session.ts` before any API call is made. The LLM cannot
bypass it — it's not a prompt-level restriction.

### 2. App ID validation

Before deploy, the app ID is validated:
- Must match `[a-z0-9]([a-z0-9-]*[a-z0-9])?`
- Max 58 characters
- Cannot start with `free` or `pro` (reserved prefixes)
- Cannot deploy a different app if session already deployed one

### 3. SSRF protection

The `fetch_url` tool blocks private/internal IPs:
- `localhost`, `127.*`, `10.*`, `192.168.*`, `172.16-31.*`, `169.254.*`
- Only HTTPS URLs allowed

### 4. Read-only tools are unrestricted

These tools are safe for any session to call:
- `list_deployed_apps` — reads the public registry
- `get_audit_results` — reads public audit data
- `fetch_url` — fetches public URLs (with SSRF protection)

### 5. System prompt reinforcement

The system prompt tells the agent:
- You can ONLY deploy/push to apps created in THIS session
- You CANNOT modify other users' apps
- If asked, refuse and explain

This is defense-in-depth — the server enforces it regardless of what the LLM does.

### 6. Auth via GitHub OAuth

Users must sign in with GitHub before accessing the agent. The session cookie
is set on `.freeappstore.online` and checked by the create page.

GitHub Models access uses the user's own GitHub OAuth token (stored in the
D1 sessions table). Users can only make AI calls they're authorized for.

## Token scope analysis

| Token | Scope | Risk | Mitigation |
|-------|-------|------|-----------|
| GITHUB_TOKEN | Org-wide repo access | Can create/push to any org repo | Session-scoped authorization limits writes to session's own app |
| CF_API_TOKEN | Account-wide Pages | Can create/modify any Pages project | Only used through the deploy pipeline which validates app ID |
| CF_GLOBAL_KEY | Account-wide DNS | Can modify any DNS record | Not used by agent (DNS creation is in the publisher worker during publish, not deploy) |
| User's GitHub token | `read:user`, `user:email`, `models:read` | Can read user info + call GitHub Models | Minimal scope, stored per-session, not reusable for repo access |

### Ideal future state

Replace the org-wide GITHUB_TOKEN with **GitHub App installation tokens**:
- Create a GitHub App in the org
- The App gets installation-level access (can be scoped per-repo)
- On deploy, mint a short-lived installation token scoped to only the new repo
- This eliminates the org-wide PAT risk entirely

## Rate limiting

Currently limited by:
- GitHub Models rate limits (per-user, enforced by GitHub)
- CF Pages project limits (per-account)
- GitHub repo creation limits (per-org)

No explicit per-user rate limiting in the agent. Future: add a rate limiter
in the session (max N deploys per user per hour).

## What's NOT protected

- **App content** — the agent writes whatever code the user asks for. There's no
  content moderation on the generated code. Compliance checks catch some issues
  (tracking SDKs, etc.) but not malicious code.
- **Store listing** — the agent can set any name/description/icon for the app.
  Offensive content could end up in the store registry.
- **Denial of service** — a user could create many sessions/projects, each creating
  a repo + CF Pages project. Rate limiting should be added.
