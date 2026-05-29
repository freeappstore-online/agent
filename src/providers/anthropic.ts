import { readSSELines } from "./sse";
import type { Message, ProviderAdapter, StreamEvent, ToolCall, ToolDef } from "./types";

export class AnthropicAdapter implements ProviderAdapter {
  constructor(
    private apiKey: string,
    private model: string,
    private temperature: number = 0.7,
    private maxTokens: number = 16384,
  ) {}

  async *run(systemPrompt: string, messages: Message[], tools: ToolDef[]): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      system: systemPrompt,
      messages: toAnthropicMessages(messages),
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
      stream: true,
    };

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      yield { type: "error", data: `Anthropic API error ${res.status}: ${err.slice(0, 500)}` };
      return;
    }

    yield* parseAnthropicSSE(res.body!);
  }
}

function toAnthropicMessages(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const content: unknown[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
        }
      }
      out.push({ role: "assistant", content });
    } else if (m.role === "tool_result") {
      const content = (m.toolResults || []).map((tr) => ({
        type: "tool_result" as const,
        tool_use_id: tr.id,
        content: tr.content,
        is_error: tr.isError || false,
      }));
      out.push({ role: "user", content });
    }
  }
  return out;
}

async function* parseAnthropicSSE(body: ReadableStream): AsyncGenerator<StreamEvent> {
  const toolCalls: Map<number, { id: string; name: string; jsonBuf: string }> = new Map();

  for await (const raw of readSSELines(body)) {
    let evt: any;
    try {
      evt = JSON.parse(raw);
    } catch {
      continue;
    }

    if (evt.type === "content_block_start") {
      const block = evt.content_block;
      if (block.type === "tool_use") {
        toolCalls.set(evt.index, { id: block.id, name: block.name, jsonBuf: "" });
      }
    } else if (evt.type === "content_block_delta") {
      const delta = evt.delta;
      if (delta.type === "text_delta") {
        yield { type: "text", data: delta.text };
      } else if (delta.type === "input_json_delta") {
        const tc = toolCalls.get(evt.index);
        if (tc) tc.jsonBuf += delta.partial_json;
      }
    } else if (evt.type === "content_block_stop") {
      const tc = toolCalls.get(evt.index);
      if (tc) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.jsonBuf);
        } catch {
          /* partial JSON */
        }
        const call: ToolCall = { id: tc.id, name: tc.name, input };
        yield { type: "tool_call", data: JSON.stringify(call) };
        toolCalls.delete(evt.index);
      }
    } else if (evt.type === "message_start" && evt.message?.usage) {
      yield { type: "usage", data: JSON.stringify({ input: evt.message.usage.input_tokens || 0, output: 0 }) };
    } else if (evt.type === "message_delta" && evt.usage) {
      yield { type: "usage", data: JSON.stringify({ input: 0, output: evt.usage.output_tokens || 0 }) };
    }
  }

  yield { type: "done", data: "" };
}
