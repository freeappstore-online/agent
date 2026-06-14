import { describe, expect, it } from "vitest";
import { corsHeaders, json } from "./cors";

function req(origin?: string): Request {
  const headers = new Headers();
  if (origin) headers.set("Origin", origin);
  return new Request("https://agent.freeappstore.online/session/x/chat", { headers });
}

describe("corsHeaders", () => {
  it("allows matching subdomain", () => {
    const h = corsHeaders(req("https://console.freeappstore.online"), "freeappstore.online");
    expect(h["Access-Control-Allow-Origin"]).toBe("https://console.freeappstore.online");
  });

  it("allows apex domain", () => {
    const h = corsHeaders(req("https://freeappstore.online"), "freeappstore.online");
    expect(h["Access-Control-Allow-Origin"]).toBe("https://freeappstore.online");
  });

  it("allows localhost", () => {
    const h = corsHeaders(req("http://localhost:5173"), "freeappstore.online");
    expect(h["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
  });

  it("rejects unknown origin", () => {
    const h = corsHeaders(req("https://evil.com"), "freeappstore.online");
    expect(h["Access-Control-Allow-Origin"]).toBe("https://freeappstore.online");
  });

  it("rejects pages.dev", () => {
    const h = corsHeaders(req("https://free-app.pages.dev"), "freeappstore.online");
    expect(h["Access-Control-Allow-Origin"]).toBe("https://freeappstore.online");
  });

  it("includes security headers", () => {
    const h = corsHeaders(req(), "freeappstore.online");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });
});

describe("json helper", () => {
  it("returns JSON response with CORS headers", () => {
    const response = json({ ok: true }, 200, req("https://freeappstore.online"), "freeappstore.online");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://freeappstore.online");
  });
});
