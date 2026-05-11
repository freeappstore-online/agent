/** Worker entry — routes requests to the correct Durable Object session. */

import { getConfig } from "./config";

export { AgentSession } from "./session";

export interface Env {
  SESSION: DurableObjectNamespace;
  GITHUB_TOKEN: string;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_GLOBAL_KEY: string;
  CF_EMAIL: string;
  STORE: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
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
          hasSecrets: !!(env.GITHUB_TOKEN && env.CF_API_TOKEN),
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

    // Forward the request to the Durable Object (DO has env via constructor)
    const doRequest = new Request(`https://do${subpath}`, {
      method: request.method,
      headers: request.headers,
      body: request.method === "POST" ? request.body : undefined,
    });

    return stub.fetch(doRequest);
  },
};
