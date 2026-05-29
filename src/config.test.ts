import { describe, expect, it } from "vitest";
import { getConfig } from "./config";

describe("getConfig", () => {
  it("returns apps config for 'apps'", () => {
    const c = getConfig("apps");
    expect(c.store).toBe("apps");
    expect(c.org).toBe("freeappstore-online");
    expect(c.domain).toBe("freeappstore.online");
    expect(c.noun).toBe("app");
    expect(c.Noun).toBe("App");
    expect(c.nounPlural).toBe("apps");
    expect(c.storeRepo).toBe("freeappstore");
    expect(c.storeName).toBe("FreeAppStore");
    expect(c.agentName).toBe("freeappstore-agent");
    expect(c.accentColor).toBe("#2563eb");
    expect(c.auditParam).toBe("app");
  });

  it("returns games config for 'games'", () => {
    const c = getConfig("games");
    expect(c.store).toBe("games");
    expect(c.org).toBe("freegamestore-online");
    expect(c.domain).toBe("freegamestore.online");
    expect(c.noun).toBe("game");
    expect(c.Noun).toBe("Game");
    expect(c.nounPlural).toBe("games");
    expect(c.storeRepo).toBe("freegamestore");
    expect(c.storeName).toBe("FreeGameStore");
    expect(c.agentName).toBe("freegamestore-agent");
    expect(c.accentColor).toBe("#10b981");
    expect(c.auditParam).toBe("game");
  });

  it("falls back to apps for unknown store", () => {
    const c = getConfig("unknown");
    expect(c.store).toBe("apps");
  });

  it("falls back to apps for empty string", () => {
    const c = getConfig("");
    expect(c.store).toBe("apps");
  });

});
