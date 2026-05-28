import { describe, expect, it } from "vitest";
import { getConfig } from "./config";
import { getTemplateFiles } from "./template";
import { executeTool, getToolDefinitions, INFRA_TOOLS } from "./tools";

const appsConfig = getConfig("apps");
const gamesConfig = getConfig("games");

describe("getToolDefinitions", () => {
  const appsTools = getToolDefinitions(appsConfig);
  const gamesTools = getToolDefinitions(gamesConfig);

  it("apps tools include list_deployed_apps", () => {
    const names = appsTools.map((t) => t.name);
    expect(names).toContain("list_deployed_apps");
    expect(names).not.toContain("list_deployed_games");
  });

  it("games tools include list_deployed_games", () => {
    const names = gamesTools.map((t) => t.name);
    expect(names).toContain("list_deployed_games");
    expect(names).not.toContain("list_deployed_apps");
  });

  it("both have same number of tools", () => {
    expect(appsTools.length).toBe(gamesTools.length);
  });

  it("apps deploy tool mentions app categories", () => {
    const deploy = appsTools.find((t) => t.name === "deploy")!;
    expect(deploy.parameters.properties.category.description).toContain("utilities");
    expect(deploy.parameters.properties.category.description).toContain("productivity");
  });

  it("games deploy tool mentions game categories", () => {
    const deploy = gamesTools.find((t) => t.name === "deploy")!;
    expect(deploy.parameters.properties.category.description).toContain("arcade");
    expect(deploy.parameters.properties.category.description).toContain("puzzle");
  });

  it("apps tool descriptions say 'app'", () => {
    const deploy = appsTools.find((t) => t.name === "deploy")!;
    expect(deploy.description).toContain("app");
  });

  it("games tool descriptions say 'game'", () => {
    const deploy = gamesTools.find((t) => t.name === "deploy")!;
    expect(deploy.description).toContain("game");
  });

  it("apps compliance check references FreeAppStore", () => {
    const check = appsTools.find((t) => t.name === "run_compliance_check")!;
    expect(check.description).toContain("FreeAppStore");
  });

  it("games compliance check references FreeGameStore", () => {
    const check = gamesTools.find((t) => t.name === "run_compliance_check")!;
    expect(check.description).toContain("FreeGameStore");
  });

  it("file tools are identical between stores", () => {
    const fileToolNames = ["write_file", "read_file", "list_files", "delete_file", "search_files"];
    for (const name of fileToolNames) {
      const appTool = appsTools.find((t) => t.name === name)!;
      const gameTool = gamesTools.find((t) => t.name === name)!;
      expect(appTool).toEqual(gameTool);
    }
  });
});

describe("INFRA_TOOLS", () => {
  it("includes both list_deployed variants", () => {
    expect(INFRA_TOOLS.has("list_deployed_apps")).toBe(true);
    expect(INFRA_TOOLS.has("list_deployed_games")).toBe(true);
  });

  it("includes core infra tools", () => {
    expect(INFRA_TOOLS.has("deploy")).toBe(true);
    expect(INFRA_TOOLS.has("push_update")).toBe(true);
    expect(INFRA_TOOLS.has("check_deploy_status")).toBe(true);
    expect(INFRA_TOOLS.has("fetch_url")).toBe(true);
    expect(INFRA_TOOLS.has("get_build_logs")).toBe(true);
    expect(INFRA_TOOLS.has("get_ci_results")).toBe(true);
    expect(INFRA_TOOLS.has("get_audit_results")).toBe(true);
  });

  it("does not include file tools", () => {
    expect(INFRA_TOOLS.has("write_file")).toBe(false);
    expect(INFRA_TOOLS.has("read_file")).toBe(false);
    expect(INFRA_TOOLS.has("search_files")).toBe(false);
  });
});

describe("executeTool — file tools", () => {
  it("write_file and read_file round-trip", () => {
    const files = new Map<string, string>();
    const write = executeTool({ id: "1", name: "write_file", input: { path: "test.txt", content: "hello" } }, files, appsConfig);
    expect(write.content).toContain("Wrote test.txt");
    const read = executeTool({ id: "2", name: "read_file", input: { path: "test.txt" } }, files, appsConfig);
    expect(read.content).toBe("hello");
  });

  it("read_file errors on missing file", () => {
    const files = new Map<string, string>();
    const result = executeTool({ id: "1", name: "read_file", input: { path: "nope.txt" } }, files, appsConfig);
    expect(result.isError).toBe(true);
  });

  it("delete_file removes file", () => {
    const files = new Map([["a.txt", "content"]]);
    executeTool({ id: "1", name: "delete_file", input: { path: "a.txt" } }, files, appsConfig);
    expect(files.has("a.txt")).toBe(false);
  });

  it("list_files returns sorted paths", () => {
    const files = new Map([
      ["b.txt", ""],
      ["a.txt", ""],
    ]);
    const result = executeTool({ id: "1", name: "list_files", input: {} }, files, appsConfig);
    expect(result.content).toBe("a.txt\nb.txt");
  });

  it("search_files finds matches", () => {
    const files = new Map([["a.txt", "hello world\nfoo bar"]]);
    const result = executeTool({ id: "1", name: "search_files", input: { pattern: "foo" } }, files, appsConfig);
    expect(result.content).toContain("a.txt:2:");
  });
});

describe("executeTool — register_api", () => {
  const reg = (input: Record<string, unknown>, files = new Map<string, string>()) => ({
    files,
    result: executeTool({ id: "1", name: "register_api", input }, files, appsConfig),
  });

  it("writes fas.json with a https:// URL-prefix pattern (not a glob)", () => {
    const { files, result } = reg({
      host: "api.openweathermap.org",
      secretName: "OPENWEATHER_KEY",
      injectKind: "query",
      injectName: "appid",
    });
    expect(result.isError).toBeFalsy();
    const manifest = JSON.parse(files.get("fas.json")!);
    expect(manifest.apis).toHaveLength(1);
    const api = manifest.apis[0];
    expect(api.pattern).toBe("https://api.openweathermap.org/");
    expect(api.pattern).not.toContain("*");
    expect(api).toMatchObject({ host: "api.openweathermap.org", secretName: "OPENWEATHER_KEY", injectKind: "query", injectName: "appid" });
  });

  it("strips scheme/path from host", () => {
    const { files } = reg({ host: "https://api.x.com/v1/foo", secretName: "X_KEY", injectKind: "bearer" });
    expect(JSON.parse(files.get("fas.json")!).apis[0].host).toBe("api.x.com");
  });

  it("rejects a non-UPPER_SNAKE_CASE secretName", () => {
    const { result } = reg({ host: "api.x.com", secretName: "weatherKey", injectKind: "query", injectName: "appid" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("UPPER_SNAKE_CASE");
  });

  it("requires injectName for query/header but not bearer", () => {
    expect(reg({ host: "a.com", secretName: "A_KEY", injectKind: "query" }).result.isError).toBe(true);
    expect(reg({ host: "a.com", secretName: "A_KEY", injectKind: "bearer" }).result.isError).toBeFalsy();
  });

  it("rejects an unknown injectKind", () => {
    expect(reg({ host: "a.com", secretName: "A_KEY", injectKind: "cookie" }).result.isError).toBe(true);
  });

  it("merges + dedupes by host across calls", () => {
    const files = new Map<string, string>();
    executeTool({ id: "1", name: "register_api", input: { host: "a.com", secretName: "A_KEY", injectKind: "bearer" } }, files, appsConfig);
    executeTool(
      { id: "2", name: "register_api", input: { host: "b.com", secretName: "B_KEY", injectKind: "query", injectName: "k" } },
      files,
      appsConfig,
    );
    executeTool({ id: "3", name: "register_api", input: { host: "a.com", secretName: "A_KEY2", injectKind: "bearer" } }, files, appsConfig);
    const apis = JSON.parse(files.get("fas.json")!).apis;
    expect(apis).toHaveLength(2); // a.com replaced, b.com kept
    expect(apis.find((a: { host: string }) => a.host === "a.com").secretName).toBe("A_KEY2");
  });

  it("register_api is a file tool, not infra", () => {
    expect(INFRA_TOOLS.has("register_api")).toBe(false);
    expect(getToolDefinitions(appsConfig).some((t) => t.name === "register_api")).toBe(true);
  });
});

describe("run_compliance_check", () => {
  it("apps template passes apps compliance (except APPNAME + Fraunces)", () => {
    const files = new Map(Object.entries(getTemplateFiles(appsConfig)));
    const result = executeTool({ id: "1", name: "run_compliance_check", input: {} }, files, appsConfig);
    expect(result.content).toContain("PASS: MIT License");
    expect(result.content).toContain("PASS: CSS variables (--paper, --ink, --accent)");
    expect(result.content).toContain("PASS: Dark mode support");
    expect(result.content).toContain("PASS: FreeAppStore link");
    expect(result.content).toContain("PASS: pnpm workspace");
    expect(result.content).toContain("PASS: PWA manifest");
    // Fraunces is in index.html + component inline styles, not index.css — known gap
    expect(result.content).toContain("FAIL: Brand fonts");
    // APPNAME placeholders remain until deploy time
    expect(result.content).toContain("FAIL: APPNAME placeholders");
    expect(result.content).toContain("10 pass, 2 fail");
  });

  it("games template passes games compliance (except APPNAME + Fraunces)", () => {
    const files = new Map(Object.entries(getTemplateFiles(gamesConfig)));
    const result = executeTool({ id: "1", name: "run_compliance_check", input: {} }, files, gamesConfig);
    expect(result.content).toContain("PASS: MIT License");
    expect(result.content).toContain("PASS: CSS variables (--bg, --ink, --accent)");
    expect(result.content).toContain("PASS: Overflow hidden");
    expect(result.content).toContain("PASS: FreeGameStore link");
    expect(result.content).toContain("PASS: pnpm workspace");
    expect(result.content).toContain("PASS: PWA manifest");
    expect(result.content).toContain("FAIL: Brand fonts");
    expect(result.content).toContain("FAIL: APPNAME placeholders");
    expect(result.content).toContain("10 pass, 2 fail");
  });

  it("apps template would fail games compliance (--bg)", () => {
    const files = new Map(Object.entries(getTemplateFiles(appsConfig)));
    const result = executeTool({ id: "1", name: "run_compliance_check", input: {} }, files, gamesConfig);
    expect(result.content).toContain("FAIL: CSS variables");
    expect(result.content).toContain("FAIL: Overflow hidden");
  });

  it("games template would fail apps compliance (--paper)", () => {
    const files = new Map(Object.entries(getTemplateFiles(gamesConfig)));
    const result = executeTool({ id: "1", name: "run_compliance_check", input: {} }, files, appsConfig);
    expect(result.content).toContain("FAIL: CSS variables");
    expect(result.content).toContain("FAIL: FreeAppStore link");
  });

  it("detects APPNAME placeholders", () => {
    const files = new Map(Object.entries(getTemplateFiles(appsConfig)));
    // Template files still have APPNAME (they're replaced at deploy time)
    const result = executeTool({ id: "1", name: "run_compliance_check", input: {} }, files, appsConfig);
    expect(result.content).toContain("FAIL: APPNAME placeholders");
  });
});
