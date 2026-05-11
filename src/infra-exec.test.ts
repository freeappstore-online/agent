import { describe, it, expect, vi } from "vitest";
import { getConfig } from "./config";
import { executeInfraTool } from "./infra-exec";
import type { DeployStatus } from "./deploy";

const appsConfig = getConfig("apps");

function makeCtx(overrides: Partial<{
  appId: string | null;
}> = {}) {
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

describe("executeInfraTool — ID validation", () => {
  it("rejects invalid ID format", async () => {
    const ctx = makeCtx();
    const result = await executeInfraTool(
      { id: "1", name: "deploy", input: { id: "UPPERCASE", name: "Test", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" } },
      ctx,
    );
    expect(result).toContain("invalid app ID");
  });

  it("rejects ID starting with 'free'", async () => {
    const ctx = makeCtx();
    const result = await executeInfraTool(
      { id: "1", name: "deploy", input: { id: "freeapp", name: "Test", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" } },
      ctx,
    );
    expect(result).toContain("invalid app ID");
  });

  it("rejects ID starting with 'pro'", async () => {
    const ctx = makeCtx();
    const result = await executeInfraTool(
      { id: "1", name: "deploy", input: { id: "proapp", name: "Test", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" } },
      ctx,
    );
    expect(result).toContain("invalid app ID");
  });

  it("rejects deploying a different app after first deploy", async () => {
    const ctx = makeCtx({ appId: "my-app" });
    const result = await executeInfraTool(
      { id: "1", name: "deploy", input: { id: "other-app", name: "Other", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" } },
      ctx,
    );
    expect(result).toContain("this session already deployed");
  });

  it("rejects push_update with no prior deploy", async () => {
    const ctx = makeCtx();
    const result = await executeInfraTool(
      { id: "1", name: "push_update", input: { id: "some-app", message: "update" } },
      ctx,
    );
    expect(result).toContain("no app deployed yet");
  });

  it("rejects push_update to a different app", async () => {
    const ctx = makeCtx({ appId: "my-app" });
    const result = await executeInfraTool(
      { id: "1", name: "push_update", input: { id: "other-app", message: "update" } },
      ctx,
    );
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
        { id: "1", name: "deploy", input: { id: "taken-app", name: "Taken", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" } },
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
        { id: "1", name: "deploy", input: { id: "my-app", name: "My App", category: "utilities", icon: "&#128992;", iconBg: "#fff", description: "test" } },
        ctx,
      );
      // Should not contain "already taken" — it passed uniqueness and failed at actual deploy
      expect(result).not.toContain("already taken");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
