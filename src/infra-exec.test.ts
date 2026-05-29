import { describe, expect, it, vi } from "vitest";
import { getConfig } from "./config";
import type { DeployStatus } from "./deploy";
import { applyPlaceholders, executeInfraTool } from "./infra-exec";

describe("applyPlaceholders", () => {
  it("APPID -> the slug everywhere (so the SDK proxy path matches the deployed id)", () => {
    const files = new Map([["web/src/App.tsx", 'initApp({ appId: "APPID" })']]);
    applyPlaceholders(files, "weather-app", "Weather App");
    expect(files.get("web/src/App.tsx")).toBe('initApp({ appId: "weather-app" })');
  });

  it("APPNAME -> display name in code, but the slug in package.json", () => {
    const files = new Map([
      ["web/index.html", "<title>APPNAME</title>"],
      ["package.json", '{ "name": "@APPNAME/root" }'],
    ]);
    applyPlaceholders(files, "weather-app", "Weather App");
    expect(files.get("web/index.html")).toBe("<title>Weather App</title>");
    expect(files.get("package.json")).toBe('{ "name": "@weather-app/root" }');
  });

  it("leaves files without placeholders untouched", () => {
    const files = new Map([["a.ts", "const x = 1;"]]);
    applyPlaceholders(files, "id", "Name");
    expect(files.get("a.ts")).toBe("const x = 1;");
  });
});

const appsConfig = getConfig("apps");

function makeCtx(
  overrides: Partial<{
    appId: string | null;
  }> = {},
) {
  return {
    appId: overrides.appId ?? null,
    files: new Map<string, string>(),
    env: {
      GITHUB_TOKEN: "test-token",
    },
    config: appsConfig,
    onDeployStatus: vi.fn() as (status: DeployStatus) => void,
    onAppDeployed: vi.fn() as (id: string, name: string) => void,
  };
}

describe("executeInfraTool — ID validation", () => {
  it("rejects invalid ID format", async () => {
    const ctx = makeCtx();
    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "UPPERCASE", name: "Test", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" },
      },
      ctx,
    );
    expect(result).toContain("invalid app ID");
  });

  it("rejects ID starting with 'free'", async () => {
    const ctx = makeCtx();
    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "freeapp", name: "Test", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" },
      },
      ctx,
    );
    expect(result).toContain("invalid app ID");
  });

  it("rejects ID starting with 'pro'", async () => {
    const ctx = makeCtx();
    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "proapp", name: "Test", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" },
      },
      ctx,
    );
    expect(result).toContain("invalid app ID");
  });

  it("rejects deploying a different app after first deploy", async () => {
    const ctx = makeCtx({ appId: "my-app" });
    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "other-app", name: "Other", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" },
      },
      ctx,
    );
    expect(result).toContain("this session already deployed");
  });

  it("rejects push_update with no prior deploy", async () => {
    const ctx = makeCtx();
    const result = await executeInfraTool({ id: "1", name: "push_update", input: { id: "some-app", message: "update" } }, ctx);
    expect(result).toContain("no app deployed yet");
  });

  it("rejects push_update to a different app", async () => {
    const ctx = makeCtx({ appId: "my-app" });
    const result = await executeInfraTool({ id: "1", name: "push_update", input: { id: "other-app", message: "update" } }, ctx);
    expect(result).toContain("you can only push_update on your own app");
  });
});

describe("executeInfraTool — uniqueness check", () => {
  it("rejects deploy if repo already exists", async () => {
    // Mock fetch to simulate existing repo
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 200, json: () => Promise.resolve({ id: 123 }) }) as any;

    try {
      const ctx = makeCtx();
      const result = await executeInfraTool(
        {
          id: "1",
          name: "deploy",
          input: { id: "taken-app", name: "Taken", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" },
        },
        ctx,
      );
      expect(result).toContain('app ID "taken-app" is already taken');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("allows re-deploy of same session app (skips uniqueness check)", async () => {
    // Mock fetch — should NOT be called for uniqueness since ctx.appId is set
    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn().mockResolvedValue({ status: 200, json: () => Promise.resolve({ id: 123 }) }) as any;
    globalThis.fetch = mockFetch;

    try {
      const ctx = makeCtx({ appId: "my-app" });
      // This will fail at the deploy step (network), but should NOT fail at uniqueness
      const result = await executeInfraTool(
        {
          id: "1",
          name: "deploy",
          input: { id: "my-app", name: "My App", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" },
        },
        ctx,
      );
      // Should not contain "already taken" — it passed uniqueness and failed at actual deploy
      expect(result).not.toContain("already taken");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
