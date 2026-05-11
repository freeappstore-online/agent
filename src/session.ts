/** Durable Object: one instance per agent session.
 *  Stores conversation history, virtual filesystem, token usage, deploy status. */

import type { Message, AIConfig, TokenUsage } from "./providers/types";
import type { DeployStatus, DeployEnv } from "./deploy";
import type { Env } from "./index";
import type { StoreConfig } from "./config";
import { getConfig } from "./config";
import { getTemplateFiles } from "./template";
import { runAgentTurn } from "./agent";
import { executeInfraTool } from "./infra-exec";

interface ErrorEntry {
  timestamp: string;
  source: string;
  message: string;
}

interface SessionState {
  messages: Message[];
  files: Record<string, string>;
  tokenUsage: TokenUsage;
  deployStatus: DeployStatus | null;
  appId: string | null;
  appName: string | null;
  errors: ErrorEntry[];
}

export class AgentSession implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private config: StoreConfig;
  private session: SessionState | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.config = getConfig(env.STORE);
  }

  private async load(): Promise<SessionState> {
    if (this.session) return this.session;
    const stored = await this.state.storage.get<SessionState>("session");
    if (stored) {
      this.session = stored;
    } else {
      this.session = {
        messages: [],
        files: { ...getTemplateFiles(this.config) },
        tokenUsage: { input: 0, output: 0 },
        deployStatus: null,
        appId: null,
        appName: null,
        errors: [],
      };
      await this.save();
    }
    // Migrate old sessions without errors field
    if (!this.session.errors) this.session.errors = [];
    return this.session;
  }

  private async save(): Promise<void> {
    if (this.session) {
      await this.state.storage.put("session", this.session);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, this.config.domain) });
    }

    try {
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
      if (path === "/reset" && request.method === "POST") {
        return this.handleReset(request);
      }
      return json({ error: "not found" }, 404, request, this.config.domain);
    } catch (err) {
      return json({ error: String(err) }, 500, request, this.config.domain);
    }
  }

  /** POST /chat — stream an agent turn via SSE */
  private async handleChat(request: Request): Promise<Response> {
    const body = await request.json<{
      message: string;
      aiConfig: AIConfig;
    }>();

    if (!body.message || !body.aiConfig?.apiKey || !body.aiConfig?.provider || !body.aiConfig?.model) {
      return json({ error: "message, aiConfig.provider, aiConfig.model, and aiConfig.apiKey are required" }, 400, request, this.config.domain);
    }

    const session = await this.load();
    const files = new Map(Object.entries(session.files));

    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();

    // Build deploy env directly from DO's env bindings (no header passing)
    const deployEnv: DeployEnv | null =
      this.env.GITHUB_TOKEN && this.env.CF_API_TOKEN
        ? {
            GITHUB_TOKEN: this.env.GITHUB_TOKEN,
            CF_API_TOKEN: this.env.CF_API_TOKEN,
            CF_ACCOUNT_ID: this.env.CF_ACCOUNT_ID,
            CF_GLOBAL_KEY: this.env.CF_GLOBAL_KEY,
            CF_EMAIL: this.env.CF_EMAIL,
          }
        : null;

    const config = this.config;

    // Run the agent in the background
    (async () => {
      const encoder = new TextEncoder();
      const sendSSE = (evt: { type: string; data: string }) => {
        writer.write(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`)).catch(() => {});
      };

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
        session.files = Object.fromEntries(files);
        await this.save();

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
        }

        sendSSE({ type: "done", data: "" });
      } catch (err) {
        this.logError("chat", String(err));
        sendSSE({ type: "error", data: String(err) });
      } finally {
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
        appUrl: session.deployStatus?.phase === "live" ? (session.deployStatus as any).appUrl : null,
      },
      200,
      request,
      this.config.domain,
    );
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

  /** POST /reset — start over */
  private async handleReset(request: Request): Promise<Response> {
    this.session = {
      messages: [],
      files: { ...getTemplateFiles(this.config) },
      tokenUsage: { input: 0, output: 0 },
      deployStatus: null,
      appId: null,
      appName: null,
      errors: [],
    };
    await this.save();
    return json({ ok: true }, 200, request, this.config.domain);
  }
}

function corsHeaders(request: Request, domain: string): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowed =
    origin &&
    (origin.endsWith(`.${domain}`) ||
      origin === `https://${domain}` ||
      origin.endsWith(".pages.dev") ||
      origin.startsWith("http://localhost"))
      ? origin
      : `https://${domain}`;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
  };
}

function json(data: unknown, status: number, request: Request, domain: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request, domain) },
  });
}
