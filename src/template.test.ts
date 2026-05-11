import { describe, it, expect } from "vitest";
import { getConfig } from "./config";
import { getTemplateFiles, getSystemPrompt } from "./template";

const appsConfig = getConfig("apps");
const gamesConfig = getConfig("games");

describe("getTemplateFiles", () => {
  const appsFiles = getTemplateFiles(appsConfig);
  const gamesFiles = getTemplateFiles(gamesConfig);

  it("apps template has Shell.tsx, not GameShell.tsx", () => {
    expect(appsFiles).toHaveProperty("web/src/components/Shell.tsx");
    expect(appsFiles).not.toHaveProperty("web/src/components/GameShell.tsx");
  });

  it("games template has GameShell.tsx, not Shell.tsx", () => {
    expect(gamesFiles).toHaveProperty("web/src/components/GameShell.tsx");
    expect(gamesFiles).not.toHaveProperty("web/src/components/Shell.tsx");
  });

  it("apps template uses --paper CSS variable", () => {
    expect(appsFiles["web/src/index.css"]).toContain("--paper");
  });

  it("games template uses --bg CSS variable", () => {
    expect(gamesFiles["web/src/index.css"]).toContain("--bg");
  });

  it("apps template has light/dark theme", () => {
    expect(appsFiles["web/src/index.css"]).toContain("prefers-color-scheme: dark");
  });

  it("games template has overflow: hidden", () => {
    expect(gamesFiles["web/src/index.css"]).toContain("overflow: hidden");
  });

  it("apps theme color is blue", () => {
    expect(appsFiles["web/index.html"]).toContain("#2563eb");
    expect(appsFiles["web/public/manifest.json"]).toContain("#2563eb");
  });

  it("games theme color is green", () => {
    expect(gamesFiles["web/index.html"]).toContain("#10b981");
    expect(gamesFiles["web/public/manifest.json"]).toContain("#10b981");
  });

  it("apps title references FreeAppStore", () => {
    expect(appsFiles["web/index.html"]).toContain("FreeAppStore");
  });

  it("games title references FreeGameStore", () => {
    expect(gamesFiles["web/index.html"]).toContain("FreeGameStore");
  });

  it("apps Shell links to freeappstore.online", () => {
    expect(appsFiles["web/src/components/Shell.tsx"]).toContain("freeappstore.online");
  });

  it("games GameShell links to freegamestore.online", () => {
    expect(gamesFiles["web/src/components/GameShell.tsx"]).toContain("freegamestore.online");
  });

  it("apps LICENSE says FreeAppStore", () => {
    expect(appsFiles["LICENSE"]).toContain("FreeAppStore");
  });

  it("games LICENSE says FreeGameStore", () => {
    expect(gamesFiles["LICENSE"]).toContain("FreeGameStore");
  });

  it("shared files are identical between stores", () => {
    const sharedPaths = [
      "pnpm-workspace.yaml",
      "package.json",
      "web/package.json",
      "web/vite.config.ts",
      "web/tsconfig.json",
      "web/tsconfig.app.json",
      "web/tsconfig.node.json",
      "web/src/main.tsx",
      ".gitignore",
    ];
    for (const p of sharedPaths) {
      expect(appsFiles[p]).toBe(gamesFiles[p]);
    }
  });

  it("both templates have the same number of files", () => {
    expect(Object.keys(appsFiles).length).toBe(Object.keys(gamesFiles).length);
  });
});

describe("getSystemPrompt", () => {
  it("apps prompt mentions FreeAppStore", () => {
    const prompt = getSystemPrompt(appsConfig);
    expect(prompt).toContain("FreeAppStore");
    expect(prompt).not.toContain("FreeGameStore");
  });

  it("games prompt mentions FreeGameStore", () => {
    const prompt = getSystemPrompt(gamesConfig);
    expect(prompt).toContain("FreeGameStore");
    expect(prompt).not.toContain("FreeAppStore");
  });

  it("apps prompt references Shell component", () => {
    expect(getSystemPrompt(appsConfig)).toContain("Shell");
  });

  it("games prompt references GameShell component", () => {
    expect(getSystemPrompt(gamesConfig)).toContain("GameShell");
  });

  it("apps prompt references list_deployed_apps", () => {
    expect(getSystemPrompt(appsConfig)).toContain("list_deployed_apps");
  });

  it("games prompt references list_deployed_games", () => {
    expect(getSystemPrompt(gamesConfig)).toContain("list_deployed_games");
  });

  it("games prompt has game-specific rules", () => {
    const prompt = getSystemPrompt(gamesConfig);
    expect(prompt).toContain("requestAnimationFrame");
    expect(prompt).toContain("overflow: hidden");
    expect(prompt).toContain("Canvas");
  });

  it("apps prompt has app-specific rules", () => {
    const prompt = getSystemPrompt(appsConfig);
    expect(prompt).toContain("localStorage");
    expect(prompt).toContain("Dark mode");
    expect(prompt).toContain("sidebar");
  });
});
