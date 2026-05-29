import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "./config";
import { checkDeployStatus, fetchUrl, getAuditResults, getBuildLogs } from "./infra";

const config = getConfig("apps");
const env = { GITHUB_TOKEN: "ghp_test" };
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("checkDeployStatus", () => {
  it("returns workflow run info", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          workflow_runs: [{ status: "completed", conclusion: "success", created_at: "2026-01-01T00:00:00Z", name: "Deploy" }],
        }),
    }) as any;
    const result = await checkDeployStatus("timer", env, config);
    expect(result).toContain("success");
    expect(result).toContain("timer.freeappstore.online");
    expect(result).toContain("Deploy");
  });

  it("handles no runs", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ workflow_runs: [] }),
    }) as any;
    const result = await checkDeployStatus("timer", env, config);
    expect(result).toContain("No workflow runs");
  });
});

describe("getBuildLogs", () => {
  it("returns job and step details", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          json: () => Promise.resolve({ workflow_runs: [{ id: 123, status: "completed", conclusion: "success", name: "Deploy" }] }),
        });
      }
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            jobs: [
              {
                name: "build",
                status: "completed",
                conclusion: "success",
                steps: [{ name: "Checkout", status: "completed", conclusion: "success" }],
              },
            ],
          }),
      });
    }) as any;
    const result = await getBuildLogs("timer", env, config);
    expect(result).toContain("Job: build");
    expect(result).toContain("Checkout");
  });
});

describe("fetchUrl", () => {
  it("returns status and body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve("<html>hello</html>"),
      headers: new Headers(),
    }) as any;
    const result = await fetchUrl("https://example.com", "GET", "test");
    expect(result).toContain("200 OK");
    expect(result).toContain("hello");
  });

  it("reports redirects without following", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 301, headers: new Headers({ Location: "https://other.com" }) }) as any;
    const result = await fetchUrl("https://example.com", "GET", "test");
    expect(result).toContain("301 Redirect");
    expect(result).toContain("https://other.com");
  });

  it("handles fetch errors", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("DNS failed")) as any;
    const result = await fetchUrl("https://bad.invalid", "GET", "test");
    expect(result).toContain("Fetch error");
    expect(result).toContain("DNS failed");
  });
});

describe("getAuditResults", () => {
  it("formats audit summary", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ summary: { pass: 5, warn: 1, fail: 0 }, checks: [{ name: "License", status: "pass" }] }),
    }) as any;
    const result = await getAuditResults("timer", config);
    expect(result).toContain("5 pass");
    expect(result).toContain("PASS: License");
  });

  it("handles API errors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as any;
    const result = await getAuditResults("timer", config);
    expect(result).toContain("500");
  });
});
