import { describe, expect, it } from "vitest";
import { BaseAdapter } from "./base";
import type { Message, StreamEvent, ToolDef } from "./types";

class TestAdapter extends BaseAdapter {
  async *run(_systemPrompt: string, _messages: Message[], _tools: ToolDef[]): AsyncGenerator<StreamEvent> {
    yield { type: "text", data: `model=${this.model} temp=${this.temperature} max=${this.maxTokens}` };
    yield { type: "done", data: "" };
  }
}

describe("BaseAdapter", () => {
  it("stores constructor params as protected fields", async () => {
    const adapter = new TestAdapter("key123", "gpt-4", 0.5, 8192);
    const events: StreamEvent[] = [];
    for await (const evt of adapter.run("sys", [], [])) events.push(evt);
    expect(events[0].data).toBe("model=gpt-4 temp=0.5 max=8192");
  });

  it("uses default temperature and maxTokens", async () => {
    const adapter = new TestAdapter("key", "model");
    const events: StreamEvent[] = [];
    for await (const evt of adapter.run("", [], [])) events.push(evt);
    expect(events[0].data).toContain("temp=0.7");
    expect(events[0].data).toContain("max=16384");
  });
});
