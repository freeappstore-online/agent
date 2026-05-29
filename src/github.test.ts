import { afterEach, describe, expect, it, vi } from "vitest";
import { makeGhApi } from "./github";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("makeGhApi", () => {
  it("sends GET with correct headers", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok: true }) }) as any;
    const ghApi = makeGhApi("ghp_test123", "test-agent");
    await ghApi("/repos/org/repo");

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [url, opts] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/org/repo");
    expect(opts.method).toBe("GET");
    expect(opts.headers.Authorization).toBe("Bearer ghp_test123");
    expect(opts.headers["User-Agent"]).toBe("test-agent");
    expect(opts.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(opts.body).toBeUndefined();
  });

  it("sends POST with JSON body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ json: () => Promise.resolve({ id: 1 }) }) as any;
    const ghApi = makeGhApi("ghp_test", "agent");
    const result = await ghApi("/orgs/org/repos", "POST", { name: "my-app" });

    const [, opts] = (globalThis.fetch as any).mock.calls[0];
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ name: "my-app" });
    expect(result).toEqual({ id: 1 });
  });

  it("defaults method to GET", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ json: () => Promise.resolve({}) }) as any;
    const ghApi = makeGhApi("t", "a");
    await ghApi("/path");
    expect((globalThis.fetch as any).mock.calls[0][1].method).toBe("GET");
  });
});
