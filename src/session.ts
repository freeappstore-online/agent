/** Durable Object: one instance per agent session.
 *  Stores conversation history, virtual filesystem, token usage, deploy status. */

import { runAgentTurn } from "./agent";
import type { StoreConfig } from "./config";
import { getConfig } from "./config";
import { corsHeaders, json } from "./cors";
import type { DeployEnv, DeployStatus } from "./deploy";
import type { Env } from "./index";
import { executeInfraTool } from "./infra-exec";
import type { AIConfig, Message, TokenUsage } from "./providers/types";
import { type PushSubscription, sendWebPush } from "./push";
import { getTemplateFiles } from "./template";

interface ErrorEntry {
  timestamp: string;
  source: string;
  message: string;
}

const MAX_MESSAGES = 200;
const MAX_FILES = 100;
const MAX_ERRORS = 50;

interface SessionState {
  messages: Message[];
  files: Record<string, string>;
  tokenUsage: TokenUsage;
  deployStatus: DeployStatus | null;
  appId: string | null;
  appName: string | null;
  errors: ErrorEntry[];
  ownerId: string | null;
  tokenHash: string | null;
  tokenValidatedAt: number | null;
}

const TOKEN_REVALIDATE_MS = 30 * 60 * 1000; // Re-verify token every 30 min

export class AgentSession implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private config: StoreConfig;
  private session: SessionState | null = null;
  private chatInProgress = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.config = getConfig(env.STORE);
  }

  private freshSession(overrides?: Partial<SessionState>): SessionState {
    return {
      messages: [],
      files: { ...getTemplateFiles(this.config) },
      tokenUsage: { input: 0, output: 0 },
      deployStatus: null,
      appId: null,
      appName: null,
      errors: [],
      ownerId: null,
      tokenHash: null,
      tokenValidatedAt: null,
      ...overrides,
    };
  }

  private async load(): Promise<SessionState> {
    if (this.session) return this.session;
    const stored = await this.state.storage.get<SessionState>("session");
    if (stored) {
      this.session = stored;
    } else {
      this.session = this.freshSession();
      await this.save();
    }
    // Migrate old sessions
    if (!this.session.errors) this.session.errors = [];
    if (this.session.ownerId === undefined) this.session.ownerId = null;
    if (this.session.tokenHash === undefined) this.session.tokenHash = null;
    if (this.session.tokenValidatedAt === undefined) this.session.tokenValidatedAt = null;
    return this.session;
  }

  private async save(): Promise<void> {
    if (this.session) {
      await this.state.storage.put("session", this.session);
    }
  }

  /** Validate Bearer token, bind session to user on first authenticated call. */
  private async validateAuth(request: Request, requireAuth: boolean): Promise<{ userId: string | null; error: Response | null }> {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      if (requireAuth) {
        return { userId: null, error: json({ error: "Authorization required" }, 401, request, this.config.domain) };
      }
      return { userId: null, error: null };
    }

    const token = authHeader.slice(7);
    const session = await this.load();

    // If we already have an owner and the token hash matches, check TTL
    if (session.ownerId && session.tokenHash) {
      const hash = await hashToken(token);
      if (hash === session.tokenHash) {
        const age = session.tokenValidatedAt ? Date.now() - session.tokenValidatedAt : Infinity;
        if (age < TOKEN_REVALIDATE_MS) {
          return { userId: session.ownerId, error: null };
        }
        // TTL expired — fall through to re-validate
      }
    }

    // Validate token against the platform API
    const res = await fetch("https://api.freeappstore.online/v1/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      return { userId: null, error: json({ error: "Invalid auth token" }, 401, request, this.config.domain) };
    }

    const user = (await res.json()) as { id: string; login: string };

    if (session.ownerId && session.ownerId !== user.id) {
      return { userId: null, error: json({ error: "Session belongs to another user" }, 403, request, this.config.domain) };
    }

    // Bind or refresh session auth
    session.ownerId = user.id;
    session.tokenHash = await hashToken(token);
    session.tokenValidatedAt = Date.now();
    await this.save();

    return { userId: user.id, error: null };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, this.config.domain) });
    }

    try {
      // Require auth on all endpoints that expose session data; only /status is public
      const isPublic = path === "/status";
      const auth = await this.validateAuth(request, !isPublic);
      if (auth.error) return auth.error;

      if (path === "/chat" && request.method === "POST") {
        return this.handleChat(request);
      }
      if (path === "/status" && request.method === "GET") {
        return this.handleStatus(request);
      }
      if (path === "/files" && request.method === "GET") {
        return this.handleListFiles(request);
      }
      if (path === "/history" && request.method === "GET") {
        return this.handleHistory(request);
      }
      if (path === "/errors" && request.method === "GET") {
        return this.handleErrors(request);
      }
      if (path === "/import" && request.method === "POST") {
        return this.handleImport(request);
      }
      if (path === "/reset" && request.method === "POST") {
        return this.handleReset(request);
      }
      if (path === "/push-subscribe" && request.method === "POST") {
        return this.handlePushSubscribe(request);
      }
      return json({ error: "not found" }, 404, request, this.config.domain);
    } catch (err) {
      console.error("Session error:", err);
      return json({ error: "Internal server error" }, 500, request, this.config.domain);
    }
  }

  /**
   * Persist a turn that failed validation before the agent ran (e.g. no API
   * key, bad provider). Without this the user's message + the error would live
   * only in the browser and get overwritten on reconnect, because /history
   * (DO-first) wouldn't know the turn happened. Every message must be saved.
   */
  private async recordErrorTurn(message: string, errorText: string): Promise<void> {
    const session = await this.load();
    session.messages.push({ role: "user", content: message.slice(0, 50_000) });
    session.messages.push({ role: "assistant", content: `Error: ${errorText}` });
    if (session.messages.length > MAX_MESSAGES) session.messages = session.messages.slice(-MAX_MESSAGES);
    await this.save();
  }

  /** POST /chat — stream an agent turn via SSE */
  private async handleChat(request: Request): Promise<Response> {
    if (this.chatInProgress) {
      return json({ error: "A chat request is already in progress. Wait for it to finish." }, 429, request, this.config.domain);
    }
    // Validate BEFORE setting chatInProgress (early returns must not lock the session)
    const contentLength = parseInt(request.headers.get("Content-Length") || "0", 10);
    if (contentLength > 200_000) {
      return json({ error: "Request too large (max 200KB)" }, 413, request, this.config.domain);
    }

    const body = await request.json<{
      message: string;
      aiConfig: AIConfig;
    }>();

    if (!body.message || !body.aiConfig?.provider || !body.aiConfig?.model) {
      return json({ error: "message, aiConfig.provider, and aiConfig.model are required" }, 400, request, this.config.domain);
    }
    // apiKey may be empty if the worker resolved it from the platform vault
    // and injected it into the body before forwarding to the DO.
    if (!body.aiConfig.apiKey) {
      const msg = "No API key found. Add one in Profile → AI Providers, or configure it in the platform key vault.";
      await this.recordErrorTurn(body.message, msg);
      return json({ error: msg }, 400, request, this.config.domain);
    }

    const validProviders = ["anthropic", "openai", "google", "github", "openrouter"];
    if (!validProviders.includes(body.aiConfig.provider)) {
      const msg = `Invalid provider. Use: ${validProviders.join(", ")}`;
      await this.recordErrorTurn(body.message, msg);
      return json({ error: msg }, 400, request, this.config.domain);
    }

    // Truncate message to prevent storage abuse
    if (body.message.length > 50_000) {
      body.message = body.message.slice(0, 50_000);
    }

    // All validation passed — lock the session for this chat turn
    this.chatInProgress = true;

    const session = await this.load();
    const files = new Map(Object.entries(session.files));

    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();

    // Build deploy env directly from DO's env bindings (no header passing)
    const deployEnv: DeployEnv | null = this.env.GITHUB_TOKEN
      ? { GITHUB_TOKEN: this.env.GITHUB_TOKEN, DB: this.env.DB }
      : null;

    const config = this.config;

    // Scrub the user's API key from any error messages before streaming
    const apiKey = body.aiConfig.apiKey;
    const scrubKey = (s: string) => (apiKey && apiKey.length > 8 ? s.replaceAll(apiKey, "[REDACTED]") : s);

    // Run the agent in the background
    (async () => {
      const encoder = new TextEncoder();
      const sendSSE = (evt: { type: string; data: string }) => {
        const safe = evt.type === "error" || evt.type === "text" ? { ...evt, data: scrubKey(evt.data) } : evt;
        writer.write(encoder.encode(`data: ${JSON.stringify(safe)}\n\n`)).catch(() => {});
      };
      let turnSaved = false;

      try {
        const sessionCtx = {
          appId: session.appId,
          appName: session.appName,
          fileCount: files.size,
          fileList: [...files.keys()].sort().join(", "),
        };
        const result = await runAgentTurn(body.aiConfig, session.messages, body.message, files, writer, config, sessionCtx).catch((err) => {
          this.logError("agent", String(err));
          throw err;
        });

        session.messages.push(...result.newMessages);
        // Enforce limits to prevent unbounded storage growth
        if (session.messages.length > MAX_MESSAGES) session.messages = session.messages.slice(-MAX_MESSAGES);
        if (session.errors.length > MAX_ERRORS) session.errors = session.errors.slice(-MAX_ERRORS);
        const fileKeys = Object.keys(files);
        if (fileKeys.length > MAX_FILES) {
          const keep = new Set(fileKeys.slice(-MAX_FILES));
          for (const k of fileKeys) {
            if (!keep.has(k)) files.delete(k);
          }
        }
        session.files = Object.fromEntries(files);
        await this.save();
        turnSaved = true;

        // Execute infra tools server-side and feed results back to agent
        if (result.infraRequests.length > 0) {
          if (!deployEnv) {
            sendSSE({ type: "error", data: "Server configuration error: deploy environment not available." });
            sendSSE({ type: "done", data: "" });
            return;
          }

          const infraResults: { id: string; content: string }[] = [];
          for (const req of result.infraRequests) {
            const tc = req.toolCall;
            let toolResult: string;

            try {
              toolResult = await executeInfraTool(tc, {
                appId: session.appId,
                files,
                env: deployEnv,
                config,
                onDeployStatus: (status) => {
                  session.deployStatus = status;
                  this.state.storage.put("session", session);
                  sendSSE({ type: "deploy_status", data: JSON.stringify(status) });
                  if (status.phase === "live") {
                    this.sendPush("Your build is live!");
                  } else if (status.phase === "error") {
                    this.sendPush("Build failed");
                  }
                },
                onAppDeployed: (id, name) => {
                  session.appId = id;
                  session.appName = name;
                  session.deployStatus = { phase: "provisioning", steps: [] };
                  this.state.storage.put("session", session);
                },
              });
            } catch (err) {
              toolResult = `Tool ${tc.name} threw an error: ${String(err)}`;
            }

            sendSSE({ type: "tool_result", data: JSON.stringify({ id: tc.id, tool: tc.name, result: toolResult.slice(0, 500) }) });
            infraResults.push({ id: tc.id, content: toolResult.slice(0, 3000) });
          }

          // Build a single tool_result message with all infra results
          // (matches the assistant message that had the tool calls)
          const infraResultMsg: Message = {
            role: "tool_result",
            content: "",
            toolResults: infraResults,
          };
          session.messages.push(infraResultMsg);

          // Persist state after all infra tools complete
          session.files = Object.fromEntries(files);
          await this.save();

          // Follow-up: let the AI react to infra tool results.
          // If deploy/push failed, the AI can diagnose and retry.
          const hasError = infraResults.some((r) => /error|fail|threw/i.test(r.content));
          const followUpPrompt = hasError
            ? "The tool action above returned an error. Analyze the error, fix the issue if possible, and retry the action. Do not ask the user — just fix it."
            : "The action completed. Summarize the result briefly for the user.";

          try {
            const followUp = await runAgentTurn(body.aiConfig, session.messages, followUpPrompt, files, writer, config, {
              appId: session.appId,
              appName: session.appName,
              fileCount: files.size,
              fileList: [...files.keys()].sort().join(", "),
            });
            session.messages.push(...followUp.newMessages);
            if (session.messages.length > MAX_MESSAGES) session.messages = session.messages.slice(-MAX_MESSAGES);
            session.files = Object.fromEntries(files);

            // If the follow-up itself produced more infra requests, execute them too
            if (followUp.infraRequests.length > 0) {
              const retryResults: { id: string; content: string }[] = [];
              for (const req of followUp.infraRequests) {
                const tc = req.toolCall;
                let toolResult: string;
                try {
                  toolResult = await executeInfraTool(tc, {
                    appId: session.appId,
                    files,
                    env: deployEnv,
                    config,
                    onDeployStatus: (status) => {
                      session.deployStatus = status;
                      this.state.storage.put("session", session);
                      sendSSE({ type: "deploy_status", data: JSON.stringify(status) });
                      if (status.phase === "live") this.sendPush("Your build is live!");
                      else if (status.phase === "error") this.sendPush("Build failed");
                    },
                    onAppDeployed: (id, name) => {
                      session.appId = id;
                      session.appName = name;
                      session.deployStatus = { phase: "provisioning", steps: [] };
                      this.state.storage.put("session", session);
                    },
                  });
                } catch (err) {
                  toolResult = `Tool ${tc.name} threw an error: ${String(err)}`;
                }
                sendSSE({ type: "tool_result", data: JSON.stringify({ id: tc.id, tool: tc.name, result: toolResult.slice(0, 500) }) });
                retryResults.push({ id: tc.id, content: toolResult.slice(0, 3000) });
              }
              session.messages.push({ role: "tool_result", content: "", toolResults: retryResults });
              session.files = Object.fromEntries(files);
            }
            await this.save();
          } catch (followUpErr) {
            this.logError("follow-up", scrubKey(String(followUpErr)));
            // Follow-up failed — not critical, the infra action already completed
          }
        }

        sendSSE({ type: "done", data: "" });
      } catch (err) {
        this.logError("chat", scrubKey(String(err)));
        sendSSE({ type: "error", data: String(err) });
        // If the turn threw before we saved it, the user's message + this error
        // would be lost on reconnect. Persist them so every message is kept.
        if (!turnSaved) {
          try {
            await this.recordErrorTurn(body.message, scrubKey(String(err)));
          } catch {
            /* best effort */
          }
        }
      } finally {
        this.chatInProgress = false;
        writer.close().catch(() => {});
      }
    })();

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders(request, this.config.domain),
      },
    });
  }

  /** GET /status — current session state */
  private async handleStatus(request: Request): Promise<Response> {
    const session = await this.load();
    return json(
      {
        messageCount: session.messages.length,
        fileCount: Object.keys(session.files).length,
        tokenUsage: session.tokenUsage,
        deployStatus: session.deployStatus,
        appId: session.appId,
        appUrl: session.deployStatus?.phase === "live" ? session.deployStatus.appUrl : null,
        devStatus: this.computeDevStatus(session),
      },
      200,
      request,
      this.config.domain,
    );
  }

  /**
   * Coarse "what is the agent doing right now" for the My Apps list.
   *   working   — a chat turn is actively streaming in this DO (pulsing)
   *   deploying — provisioning/building/pushing
   *   error     — last deploy failed (red)
   *   idle      — finished / never started / disconnected (blank)
   * `working` reflects chatInProgress, which stays true while the turn runs
   * server-side even after the client disconnects — so the list shows the
   * agent is still building after you've switched apps.
   */
  private computeDevStatus(session: SessionState): { state: string; detail: string } {
    const phase = session.deployStatus?.phase;
    const deploying = !!phase && !["live", "error"].includes(phase);
    if (this.chatInProgress) return { state: "working", detail: "Building…" };
    if (deploying) return { state: "deploying", detail: `Deploying — ${phase}` };
    if (phase === "error") {
      return { state: "error", detail: (session.deployStatus?.error || "Build failed").slice(0, 80) };
    }
    if (phase === "live") return { state: "idle", detail: "Live" };
    return { state: "idle", detail: session.messages.length > 1 ? "Idle" : "Empty" };
  }

  /** GET /files — list files with sizes */
  private async handleListFiles(request: Request): Promise<Response> {
    const session = await this.load();
    const files = Object.entries(session.files).map(([path, content]) => ({
      path,
      size: content.length,
    }));
    return json({ files }, 200, request, this.config.domain);
  }

  private logError(source: string, message: string) {
    if (!this.session) return;
    this.session.errors.push({ timestamp: new Date().toISOString(), source, message: message.slice(0, 500) });
    // Keep last 50 errors
    if (this.session.errors.length > 50) this.session.errors = this.session.errors.slice(-50);
  }

  /** GET /errors — return server-side errors for debugging */
  private async handleErrors(request: Request): Promise<Response> {
    const session = await this.load();
    return json({ errors: session.errors }, 200, request, this.config.domain);
  }

  /** GET /history — return all conversation messages for restoring UI */
  private async handleHistory(request: Request): Promise<Response> {
    const session = await this.load();
    const history = session.messages.map((m) => ({
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls?.map((tc) => ({
        name: tc.name,
        input: { path: tc.input.path, id: tc.input.id },
      })),
      toolResults: m.toolResults?.map((tr) => ({
        id: tr.id,
        content: tr.content.slice(0, 500),
      })),
    }));
    return json(
      {
        messages: history,
        appId: session.appId,
        appName: session.appName,
        deployStatus: session.deployStatus,
        tokenUsage: session.tokenUsage,
        fileCount: Object.keys(session.files).length,
      },
      200,
      request,
      this.config.domain,
    );
  }

  /** POST /import — load files from an existing GitHub repo into this session.
   *  Body: { appId: string }. Fetches the repo tree + file contents from
   *  GitHub and replaces the session's files so the agent can see and edit
   *  the existing code. */
  private async handleImport(request: Request): Promise<Response> {
    const body = await request.json<{ appId?: string }>();
    const appId = body?.appId;
    if (!appId || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(appId)) {
      return json({ error: "valid appId required" }, 400, request, this.config.domain);
    }
    const session = await this.load();
    if (session.appId && session.appId !== appId) {
      return json({ error: "session already linked to a different app" }, 409, request, this.config.domain);
    }

    const repo = `${this.config.org}/${appId}`;
    const files = await fetchRepoFiles(repo, this.config.agentName, this.env.GITHUB_TOKEN);
    if (!files) {
      return json({ error: `Could not read repo ${repo}` }, 404, request, this.config.domain);
    }

    session.files = files;
    session.appId = appId;
    session.appName = appId;
    session.deployStatus = { phase: "live", appUrl: `https://${appId}.${this.config.domain}` } as DeployStatus;
    await this.save();

    return json({ ok: true, fileCount: Object.keys(files).length }, 200, request, this.config.domain);
  }

  /** POST /reset — start over */
  private async handleReset(request: Request): Promise<Response> {
    this.session = this.freshSession({
      ownerId: this.session?.ownerId ?? null,
      tokenHash: this.session?.tokenHash ?? null,
      tokenValidatedAt: this.session?.tokenValidatedAt ?? null,
    });
    await this.save();
    return json({ ok: true }, 200, request, this.config.domain);
  }

  /** POST /push-subscribe — store push subscription for notifications */
  private async handlePushSubscribe(request: Request): Promise<Response> {
    const sub = await request.json<PushSubscription>();
    if (!sub.endpoint) {
      return json({ error: "endpoint required" }, 400, request, this.config.domain);
    }
    // Validate push endpoint is a known push service (prevents SSRF via push notifications)
    try {
      const host = new URL(sub.endpoint).hostname;
      const allowed =
        host.endsWith(".push.services.mozilla.com") ||
        host.endsWith(".google.com") ||
        host.endsWith(".googleapis.com") ||
        host.endsWith(".windows.com") ||
        host.endsWith(".push.apple.com") ||
        host.endsWith(".web.push.apple.com") ||
        host.endsWith(".notify.windows.com");
      if (!allowed) {
        return json({ error: "Invalid push endpoint domain" }, 400, request, this.config.domain);
      }
    } catch {
      return json({ error: "Invalid push endpoint URL" }, 400, request, this.config.domain);
    }
    await this.state.storage.put("pushSubscription", sub);
    return json({ ok: true }, 200, request, this.config.domain);
  }

  /** Send a push notification to the subscribed client */
  private async sendPush(_message: string): Promise<void> {
    if (!this.env.VAPID_PUBLIC_KEY || !this.env.VAPID_PRIVATE_KEY) return;
    const sub = await this.state.storage.get<PushSubscription>("pushSubscription");
    if (!sub) return;
    try {
      await sendWebPush(sub, this.env.VAPID_PUBLIC_KEY, this.env.VAPID_PRIVATE_KEY);
    } catch {
      // Push failed (subscription expired, etc.) — don't crash the session
    }
  }
}

async function hashToken(token: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const IMPORTABLE_EXTS = new Set(["ts", "tsx", "js", "jsx", "json", "html", "css", "md", "yaml", "yml", "toml", "txt", "svg", "sh"]);
const SKIP_PATHS = ["node_modules/", "dist/"];
const SKIP_FILES = new Set(["pnpm-lock.yaml", "package-lock.json"]);

function isImportable(e: { path: string; type: string; size?: number }): boolean {
  if (e.type !== "blob") return false;
  if (e.path.startsWith(".") || SKIP_PATHS.some((p) => e.path.includes(p))) return false;
  if (SKIP_FILES.has(e.path)) return false;
  const ext = e.path.split(".").pop()?.toLowerCase() ?? "";
  return IMPORTABLE_EXTS.has(ext) && (e.size ?? 0) <= 100_000;
}

async function fetchRepoFiles(repo: string, agentName: string, token?: string): Promise<Record<string, string> | null> {
  const ghHeaders: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": agentName };
  if (token) ghHeaders.Authorization = `Bearer ${token}`;

  const treeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees/main?recursive=1`, { headers: ghHeaders });
  if (!treeRes.ok) return null;
  const treeData = (await treeRes.json()) as { tree: { path: string; type: string; size?: number }[] };
  const candidates = treeData.tree.filter(isImportable).slice(0, 80);
  if (candidates.length === 0) return null;

  const files: Record<string, string> = {};
  const rawHeaders = { ...ghHeaders, Accept: "application/vnd.github.raw+json" };
  for (let i = 0; i < candidates.length; i += 10) {
    const batch = candidates.slice(i, i + 10);
    const results = await Promise.all(
      batch.map(async (f) => {
        const fileRes = await fetch(`https://api.github.com/repos/${repo}/contents/${f.path}?ref=main`, { headers: rawHeaders });
        return fileRes.ok ? { path: f.path, content: await fileRes.text() } : null;
      }),
    );
    for (const r of results) if (r) files[r.path] = r.content;
  }
  return files;
}
