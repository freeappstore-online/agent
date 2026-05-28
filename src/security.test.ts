import { describe, expect, it, vi } from "vitest";
import { getConfig } from "./config";
import type { DeployStatus } from "./deploy";
import { executeInfraTool } from "./infra-exec";
import { executeTool } from "./tools";

const appsConfig = getConfig("apps");

function makeCtx(overrides: Partial<{ appId: string | null }> = {}) {
  return {
    appId: overrides.appId ?? null,
    files: new Map<string, string>(),
    env: {
      GITHUB_TOKEN: "test-token",
      CF_API_TOKEN: "test-cf",
      CF_ACCOUNT_ID: "test-account",
      CF_GLOBAL_KEY: "test-key",
      CF_EMAIL: "test@test.com",
    },
    config: appsConfig,
    onDeployStatus: vi.fn() as (status: DeployStatus) => void,
    onAppDeployed: vi.fn() as (id: string, name: string) => void,
  };
}

// ── write_file path traversal (H-2) ──

describe("Security: write_file path validation", () => {
  const files = new Map<string, string>();

  it("blocks path traversal with ..", () => {
    const r = executeTool({ id: "1", name: "write_file", input: { path: "../etc/passwd", content: "x" } }, files, appsConfig);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not allowed");
  });

  it("blocks nested path traversal", () => {
    const r = executeTool({ id: "1", name: "write_file", input: { path: "web/../../.env", content: "x" } }, files, appsConfig);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not allowed");
  });

  it("blocks .github/workflows injection", () => {
    const r = executeTool(
      { id: "1", name: "write_file", input: { path: ".github/workflows/evil.yml", content: "on: push" } },
      files,
      appsConfig,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not allowed");
  });

  it("blocks .github/ directory entirely", () => {
    const r = executeTool(
      { id: "1", name: "write_file", input: { path: ".github/CODEOWNERS", content: "* @attacker" } },
      files,
      appsConfig,
    );
    expect(r.isError).toBe(true);
  });

  it("blocks absolute paths", () => {
    const r = executeTool({ id: "1", name: "write_file", input: { path: "/etc/passwd", content: "x" } }, files, appsConfig);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not allowed");
  });

  it("allows normal web/ paths", () => {
    const r = executeTool(
      { id: "1", name: "write_file", input: { path: "web/src/App.tsx", content: "export default () => <div/>" } },
      files,
      appsConfig,
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("Wrote");
  });

  it("blocks package.json (locked infrastructure file)", () => {
    const r = executeTool({ id: "1", name: "write_file", input: { path: "package.json", content: "{}" } }, files, appsConfig);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("locked infrastructure file");
  });
});

// ── fetch_url SSRF blocking ──

describe("Security: fetch_url SSRF prevention", () => {
  it("blocks HTTP (non-HTTPS)", async () => {
    const ctx = makeCtx();
    const r = await executeInfraTool({ id: "1", name: "fetch_url", input: { url: "http://example.com" } }, ctx);
    expect(r).toContain("Error");
    expect(r).toContain("HTTPS");
  });

  it("blocks localhost", async () => {
    const ctx = makeCtx();
    const r = await executeInfraTool({ id: "1", name: "fetch_url", input: { url: "https://localhost/admin" } }, ctx);
    expect(r).toContain("Error");
  });

  it("blocks 127.0.0.1", async () => {
    const ctx = makeCtx();
    const r = await executeInfraTool({ id: "1", name: "fetch_url", input: { url: "https://127.0.0.1/" } }, ctx);
    expect(r).toContain("Error");
  });

  it("blocks 192.168.x.x", async () => {
    const ctx = makeCtx();
    const r = await executeInfraTool({ id: "1", name: "fetch_url", input: { url: "https://192.168.1.1/" } }, ctx);
    expect(r).toContain("Error");
  });

  it("blocks 10.x.x.x", async () => {
    const ctx = makeCtx();
    const r = await executeInfraTool({ id: "1", name: "fetch_url", input: { url: "https://10.0.0.1/" } }, ctx);
    expect(r).toContain("Error");
  });

  it("blocks 169.254.x.x (link-local)", async () => {
    const ctx = makeCtx();
    const r = await executeInfraTool({ id: "1", name: "fetch_url", input: { url: "https://169.254.169.254/metadata" } }, ctx);
    expect(r).toContain("Error");
  });

  it("blocks [::1] IPv6 loopback", async () => {
    const ctx = makeCtx();
    const r = await executeInfraTool({ id: "1", name: "fetch_url", input: { url: "https://[::1]/" } }, ctx);
    expect(r).toContain("Error");
  });

  it("blocks admin.freeappstore.online", async () => {
    const ctx = makeCtx();
    const r = await executeInfraTool({ id: "1", name: "fetch_url", input: { url: "https://admin.freeappstore.online/api/stats" } }, ctx);
    expect(r).toContain("Error");
  });

  it("blocks publish.freeappstore.online", async () => {
    const ctx = makeCtx();
    const r = await executeInfraTool({ id: "1", name: "fetch_url", input: { url: "https://publish.freeappstore.online/api/me" } }, ctx);
    expect(r).toContain("Error");
  });

  it("blocks agent.freeappstore.online", async () => {
    const ctx = makeCtx();
    const r = await executeInfraTool({ id: "1", name: "fetch_url", input: { url: "https://agent.freeappstore.online/health" } }, ctx);
    expect(r).toContain("Error");
  });

  it("blocks auth exchange endpoint", async () => {
    const ctx = makeCtx();
    const r = await executeInfraTool(
      { id: "1", name: "fetch_url", input: { url: "https://api.freeappstore.online/v1/auth/exchange" } },
      ctx,
    );
    expect(r).toContain("Error");
  });

  it("blocks auth/me endpoint (token probing)", async () => {
    const ctx = makeCtx();
    const r = await executeInfraTool({ id: "1", name: "fetch_url", input: { url: "https://api.freeappstore.online/v1/auth/me" } }, ctx);
    expect(r).toContain("Error");
  });

  it("blocks freegamestore admin", async () => {
    const ctx = makeCtx();
    const r = await executeInfraTool({ id: "1", name: "fetch_url", input: { url: "https://admin.freegamestore.online/api/stats" } }, ctx);
    expect(r).toContain("Error");
  });

  it("blocks freegamestore API", async () => {
    const ctx = makeCtx();
    const r = await executeInfraTool({ id: "1", name: "fetch_url", input: { url: "https://api.freegamestore.online/v1/auth/me" } }, ctx);
    expect(r).toContain("Error");
  });
});

// ── Infra tool authorization (H-3) ──

describe("Security: infra tool authorization", () => {
  it("blocks push_update to different app", async () => {
    const ctx = makeCtx({ appId: "my-app" });
    const r = await executeInfraTool({ id: "1", name: "push_update", input: { id: "other-app", message: "pwn" } }, ctx);
    expect(r).toContain("Error");
    expect(r).toContain("your own");
  });

  it("blocks get_build_logs for different app", async () => {
    const ctx = makeCtx({ appId: "my-app" });
    const r = await executeInfraTool({ id: "1", name: "get_build_logs", input: { id: "other-app" } }, ctx);
    expect(r).toContain("Error");
  });

  it("blocks get_ci_results for different app", async () => {
    const ctx = makeCtx({ appId: "my-app" });
    const r = await executeInfraTool({ id: "1", name: "get_ci_results", input: { id: "other-app" } }, ctx);
    expect(r).toContain("Error");
  });

  it("blocks check_deploy_status for different app", async () => {
    const ctx = makeCtx({ appId: "my-app" });
    const r = await executeInfraTool({ id: "1", name: "check_deploy_status", input: { id: "other-app" } }, ctx);
    expect(r).toContain("Error");
  });

  it("blocks get_audit_results for different app", async () => {
    const ctx = makeCtx({ appId: "my-app" });
    const r = await executeInfraTool({ id: "1", name: "get_audit_results", input: { id: "other-app" } }, ctx);
    expect(r).toContain("Error");
  });

  it("blocks push_update with no prior deploy", async () => {
    const ctx = makeCtx();
    const r = await executeInfraTool({ id: "1", name: "push_update", input: { id: "any-app", message: "test" } }, ctx);
    expect(r).toContain("no app deployed");
  });

  it("allows push_update to own app", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }) as any;
    try {
      const ctx = makeCtx({ appId: "my-app" });
      ctx.files.set("web/src/App.tsx", "export default () => <div/>");
      const r = await executeInfraTool({ id: "1", name: "push_update", input: { id: "my-app", message: "update" } }, ctx);
      // Should not contain auth error — may fail at network level but passes auth
      expect(r).not.toContain("your own");
      expect(r).not.toContain("no app deployed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── Deploy ID validation ──

describe("Security: deploy ID validation", () => {
  const badIds = [
    { id: "UPPER", reason: "uppercase" },
    { id: "free-app", reason: "starts with free" },
    { id: "pro-app", reason: "starts with pro" },
    { id: "-dash-start", reason: "starts with dash" },
    { id: "dash-end-", reason: "ends with dash" },
    { id: "has spaces", reason: "contains spaces" },
    { id: "has.dots", reason: "contains dots" },
    { id: "a".repeat(59), reason: "too long (59 chars)" },
    { id: "admin", reason: "reserved name" },
    { id: "platform", reason: "reserved name" },
    { id: "api", reason: "reserved name" },
    { id: "agent", reason: "reserved name" },
    { id: "create", reason: "reserved name" },
    { id: "freeappstore", reason: "reserved name (starts with free)" },
    { id: "www", reason: "reserved name" },
  ];

  for (const { id, reason } of badIds) {
    it(`rejects ID: ${reason}`, async () => {
      const ctx = makeCtx();
      const r = await executeInfraTool(
        { id: "1", name: "deploy", input: { id, name: "Test", category: "utilities", icon: "📱", iconBg: "#fff", description: "test" } },
        ctx,
      );
      expect(r).toContain("invalid");
    });
  }

  it("accepts valid ID", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 200, json: () => Promise.resolve({ id: 123 }) }) as any;
    try {
      const ctx = makeCtx();
      const r = await executeInfraTool(
        {
          id: "1",
          name: "deploy",
          input: { id: "my-cool-app", name: "Cool", category: "utilities", icon: "📱", iconBg: "#fff", description: "test" },
        },
        ctx,
      );
      // Passes ID validation, hits uniqueness check (mocked to "exists")
      expect(r).not.toContain("invalid");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── fetch_url redirect prevention ──

describe("Security: fetch_url redirect handling", () => {
  it("does not follow redirects (prevents SSRF bypass)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 302,
      statusText: "Found",
      headers: new Headers({ Location: "http://169.254.169.254/metadata" }),
      text: () => Promise.resolve(""),
    }) as any;
    try {
      const ctx = makeCtx();
      const r = await executeInfraTool({ id: "1", name: "fetch_url", input: { url: "https://example.com/redirect" } }, ctx);
      expect(r).toContain("302");
      expect(r).toContain("Redirect");
      expect(r).toContain("not followed");
      // Should NOT contain the metadata content (redirect was not followed)
      expect(r).not.toContain("ami-id");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
