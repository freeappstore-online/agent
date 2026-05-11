import type { Message, ProviderAdapter, StreamEvent, ToolCall, ToolDef } from "./types";

export class OpenAIAdapter implements ProviderAdapter {
  constructor(
    private apiKey: string,
    private model: string,
    private baseUrl: string = "https://api.openai.com/v1/chat/completions",
    private temperature: number = 0.7,
    private maxTokens: number = 16384,
  ) {}

  async *run(systemPrompt: string, messages: Message[], tools: ToolDef[]): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      messages: [{ role: "system", content: systemPrompt }, ...toOpenAIMessages(messages)],
      stream: true,
      stream_options: { include_usage: true },
    };

    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      if (res.status === 429) {
        yield {
          type: "error",
          data: `Rate limited (429). You've hit the usage limit for this model. Wait a moment and try again, or switch to a different model/provider.\n\nDetails: ${err.slice(0, 300)}`,
        };
      } else {
        yield { type: "error", data: `API error ${res.status}: ${err.slice(0, 500)}` };
      }
      return;
    }

    yield* parseOpenAISSE(res.body!);
  }
}

function toOpenAIMessages(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const msg: any = { role: "assistant" };
      if (m.content) msg.content = m.content;
      if (m.toolCalls) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        }));
      }
      out.push(msg);
    } else if (m.role === "tool_result") {
      for (const tr of m.toolResults || []) {
        out.push({ role: "tool", tool_call_id: tr.id, content: tr.content });
      }
    }
  }
  return out;
}

async function* parseOpenAISSE(body: ReadableStream): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const toolAccum: Map<number, { id: string; name: string; argsBuf: string }> = new Map();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split("\n");
      buf = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") continue;
        if (!raw) continue;

        let chunk: any;
        try {
          chunk = JSON.parse(raw);
        } catch {
          continue;
        }

        // Usage (final chunk)
        if (chunk.usage) {
          yield {
            type: "usage",
            data: JSON.stringify({
              input: chunk.usage.prompt_tokens || 0,
              output: chunk.usage.completion_tokens || 0,
            }),
          };
        }

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          yield { type: "text", data: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (tc.id) {
              toolAccum.set(idx, { id: tc.id, name: tc.function?.name || "", argsBuf: "" });
            }
            const acc = toolAccum.get(idx);
            if (acc && tc.function?.arguments) {
              acc.argsBuf += tc.function.arguments;
              if (tc.function.name) acc.name = tc.function.name;
            }
          }
        }

        // Emit accumulated tool calls on any finish_reason (tool_calls, stop, etc.)
        if (chunk.choices?.[0]?.finish_reason && toolAccum.size > 0) {
          for (const [, acc] of toolAccum) {
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(acc.argsBuf);
            } catch {
              /* empty */
            }
            const call: ToolCall = { id: acc.id, name: acc.name, input };
            yield { type: "tool_call", data: JSON.stringify(call) };
          }
          toolAccum.clear();
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { type: "done", data: "" };
}
