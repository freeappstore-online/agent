/** Worker entry — routes requests to the correct Durable Object session. */

import { getConfig } from "./config";

export { AgentSession } from "./session";

export interface Env {
  SESSION: DurableObjectNamespace;
  PLATFORM?: Fetcher;
  GITHUB_TOKEN: string;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_GLOBAL_KEY: string;
  CF_EMAIL: string;
  STORE: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
}

/** Map VibeCode provider names to platform key vault provider IDs. */
function mapProviderToVault(provider: string): string | null {
  const map: Record<string, string> = {
    openrouter: "openrouter",
    anthropic: "anthropic",
    openai: "openai",
    google: "google-ai",
  };
  return map[provider] ?? null;
}

function corsHeaders(request: Request, domain: string): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowed =
    origin &&
    (origin.endsWith(`.${domain}`) ||
      origin === `https://${domain}` ||
      origin.startsWith("http://localhost"))
      ? origin
      : `https://${domain}`;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = getConfig(env.STORE);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, config.domain) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === "/" || path === "/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: config.agentName,
        }),
        {
          headers: { "Content-Type": "application/json", ...corsHeaders(request, config.domain) },
        },
      );
    }

    // Routes: /session/:id/chat, /session/:id/status, /session/:id/files, /session/:id/reset
    const match = path.match(/^\/session\/([a-zA-Z0-9_-]{1,64})\/(chat|status|files|history|errors|reset|push-subscribe)$/);
    if (!match) {
      return new Response(JSON.stringify({ error: "not found", hint: "Use /session/:id/chat" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders(request, config.domain) },
      });
    }

    const [, sessionId, route] = match;
    const subpath = `/${route}`;
    const doId = env.SESSION.idFromName(sessionId);
    const stub = env.SESSION.get(doId);

    // For /chat: try to resolve API key from platform vault before forwarding.
    // If the browser sent a key, use it (backwards compat). If not, check vault.
    let forwardBody: BodyInit | undefined = request.method === "POST" ? (request.body ?? undefined) : undefined;

    if (route === "chat" && request.method === "POST" && env.PLATFORM) {
      try {
        const bodyText = await request.text();
        const body = JSON.parse(bodyText);
        const authHeader = request.headers.get("Authorization") || "";

        // If no API key in request but user is authenticated, try the vault
        if (body.aiConfig && !body.aiConfig.apiKey && authHeader) {
          const provider = mapProviderToVault(body.aiConfig.provider);
          if (provider) {
            const vaultRes = await env.PLATFORM.fetch(`https://api.freeappstore.online/v1/keys/resolve/${provider}`, {
              headers: { Authorization: authHeader },
            });
            if (vaultRes.ok) {
              const { key } = (await vaultRes.json()) as { key: string | null };
              if (key) body.aiConfig.apiKey = key;
            }
          }
        }
        forwardBody = JSON.stringify(body);
      } catch {
        // Parse failed — forward original body
        forwardBody = request.body ?? undefined;
      }
    }

    const doRequest = new Request(`https://do${subpath}`, {
      method: request.method,
      headers: request.headers,
      body: forwardBody,
    });

    return stub.fetch(doRequest);
  },
};
