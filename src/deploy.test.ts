import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "./config";
// We can't import deployApp/pushUpdate directly (they make real API calls)
// but we can test the makeGhApi pattern and the deploy flow logic by
// testing executeInfraTool which wraps them.
import { executeInfraTool } from "./infra-exec";

const appsConfig = getConfig("apps");
const gamesConfig = getConfig("games");

const mockEnv = {
  GITHUB_TOKEN: "ghp_test",
};

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("deploy uniqueness — apps", () => {
  it("rejects deploy when repo exists (HTTP 200)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 200, json: () => Promise.resolve({ id: 1 }) }) as any;

    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "taken-app", name: "Taken", category: "utilities", icon: "x", iconBg: "#fff", description: "test" },
      },
      { appId: null, files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).toContain("already taken");
  });

  it("allows deploy when repo does not exist (HTTP 404)", async () => {
    // First call: uniqueness check (404 = not taken)
    // Subsequent calls: deploy flow (will fail but that's fine — we just check it gets past uniqueness)
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 404, json: () => Promise.resolve({ message: "Not Found" }) }) // uniqueness check
      .mockResolvedValue({ status: 200, json: () => Promise.resolve({ id: null, message: "error" }) }); // deploy calls fail
    globalThis.fetch = mockFetch as any;

    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "new-app", name: "New", category: "utilities", icon: "x", iconBg: "#fff", description: "test" },
      },
      { appId: null, files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    // Should NOT contain "already taken" — it passed uniqueness check
    expect(result).not.toContain("already taken");
  });

  it("skips uniqueness check for re-deploy (appId matches)", async () => {
    // Mock: repo exists (200) — but since ctx.appId is set, uniqueness check is skipped
    // The deploy flow will still call the repo endpoint, but should NOT return "already taken"
    const mockFetch = vi.fn().mockResolvedValue({ status: 200, json: () => Promise.resolve({ id: 123 }) }) as any;
    globalThis.fetch = mockFetch as any;

    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "my-app", name: "My App", category: "utilities", icon: "x", iconBg: "#fff", description: "test" },
      },
      { appId: "my-app", files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    // Should NOT contain "already taken" — uniqueness check was skipped
    expect(result).not.toContain("already taken");
  });
});

describe("deploy uniqueness — games", () => {
  it("rejects deploy when repo exists", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 200, json: () => Promise.resolve({ id: 1 }) }) as any;

    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "taken-game", name: "Taken", category: "arcade", icon: "x", iconBg: "#fff", description: "test" },
      },
      { appId: null, files: new Map(), env: mockEnv, config: gamesConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).toContain("already taken");
    // Verify it checked the correct org
    expect((globalThis.fetch as any).mock.calls[0][0]).toContain("freegamestore-online");
  });
});

describe("deploy ID validation edge cases", () => {
  it("rejects ID with spaces", async () => {
    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "my app", name: "My App", category: "utilities", icon: "x", iconBg: "#fff", description: "test" },
      },
      { appId: null, files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).toContain("invalid");
  });

  it("rejects ID with uppercase", async () => {
    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "MyApp", name: "My App", category: "utilities", icon: "x", iconBg: "#fff", description: "test" },
      },
      { appId: null, files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).toContain("invalid");
  });

  it("rejects ID starting with hyphen", async () => {
    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "-my-app", name: "My App", category: "utilities", icon: "x", iconBg: "#fff", description: "test" },
      },
      { appId: null, files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).toContain("invalid");
  });

  it("rejects ID ending with hyphen", async () => {
    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "my-app-", name: "My App", category: "utilities", icon: "x", iconBg: "#fff", description: "test" },
      },
      { appId: null, files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).toContain("invalid");
  });

  it("rejects ID over 58 chars", async () => {
    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "a".repeat(59), name: "Long", category: "utilities", icon: "x", iconBg: "#fff", description: "test" },
      },
      { appId: null, files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).toContain("invalid");
  });

  it("allows valid ID with hyphens and numbers", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 404 })
      .mockResolvedValue({ status: 200, json: () => Promise.resolve({ id: null }) }) as any;

    const result = await executeInfraTool(
      {
        id: "1",
        name: "deploy",
        input: { id: "my-cool-app-2", name: "Cool", category: "utilities", icon: "x", iconBg: "#fff", description: "test" },
      },
      { appId: null, files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).not.toContain("invalid");
  });

  it("allows single character ID", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 404 })
      .mockResolvedValue({ status: 200, json: () => Promise.resolve({ id: null }) }) as any;

    const result = await executeInfraTool(
      { id: "1", name: "deploy", input: { id: "x", name: "X", category: "utilities", icon: "x", iconBg: "#fff", description: "test" } },
      { appId: null, files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).not.toContain("invalid");
  });
});

describe("infra tool authorization", () => {
  it("rejects get_build_logs for different app", async () => {
    const result = await executeInfraTool(
      { id: "1", name: "get_build_logs", input: { id: "other-app" } },
      { appId: "my-app", files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).toContain("you can only");
    expect(result).toContain("my-app");
  });

  it("rejects check_deploy_status for different app", async () => {
    const result = await executeInfraTool(
      { id: "1", name: "check_deploy_status", input: { id: "other-app" } },
      { appId: "my-app", files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).toContain("you can only");
  });

  it("rejects get_ci_results with no deployed app", async () => {
    const result = await executeInfraTool(
      { id: "1", name: "get_ci_results", input: { id: "some-app" } },
      { appId: null, files: new Map(), env: mockEnv, config: appsConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).toContain("no app deployed yet");
  });

  it("uses game noun in error messages for games config", async () => {
    const result = await executeInfraTool(
      { id: "1", name: "push_update", input: { id: "some-game" } },
      { appId: null, files: new Map(), env: mockEnv, config: gamesConfig, onDeployStatus: vi.fn(), onAppDeployed: vi.fn() },
    );
    expect(result).toContain("no game deployed yet");
  });
});
