import { readSSELines } from "./sse";
import type { Message, ProviderAdapter, StreamEvent, ToolCall, ToolDef } from "./types";

export class GoogleAdapter implements ProviderAdapter {
  constructor(
    private apiKey: string,
    private model: string,
    private temperature: number = 0.7,
    private maxTokens: number = 16384,
  ) {}

  async *run(systemPrompt: string, messages: Message[], tools: ToolDef[]): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: toGoogleContents(messages),
      generationConfig: { maxOutputTokens: this.maxTokens, temperature: this.temperature },
    };

    if (tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      yield { type: "error", data: `Google AI API error ${res.status}: ${err}` };
      return;
    }

    yield* parseGoogleSSE(res.body!);
  }
}

function toGoogleContents(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", parts: [{ text: m.content }] });
    } else if (m.role === "assistant") {
      const parts: unknown[] = [];
      if (m.content) parts.push({ text: m.content });
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          parts.push({ functionCall: { name: tc.name, args: tc.input } });
        }
      }
      out.push({ role: "model", parts });
    } else if (m.role === "tool_result") {
      // Extract function name from our ID format: gfc_{name}_{random}
      const parts = (m.toolResults || []).map((tr) => {
        const match = tr.id.match(/^gfc_(.+?)_[a-z0-9]+$/);
        const name = match ? match[1] : tr.id;
        return { functionResponse: { name, response: { result: tr.content } } };
      });
      out.push({ role: "user", parts });
    }
  }
  return out;
}

async function* parseGoogleSSE(body: ReadableStream): AsyncGenerator<StreamEvent> {
  for await (const raw of readSSELines(body)) {
    let chunk: any;
    try {
      chunk = JSON.parse(raw);
    } catch {
      continue;
    }

    if (chunk.usageMetadata) {
      yield {
        type: "usage",
        data: JSON.stringify({ input: chunk.usageMetadata.promptTokenCount || 0, output: chunk.usageMetadata.candidatesTokenCount || 0 }),
      };
    }

    const parts = chunk.candidates?.[0]?.content?.parts;
    if (!parts) continue;

    for (const part of parts) {
      if (part.text) {
        yield { type: "text", data: part.text };
      }
      if (part.functionCall) {
        const call: ToolCall = {
          id: `gfc_${part.functionCall.name}_${Math.random().toString(36).slice(2, 8)}`,
          name: part.functionCall.name,
          input: part.functionCall.args || {},
        };
        yield { type: "tool_call", data: JSON.stringify(call) };
      }
    }
  }

  yield { type: "done", data: "" };
}
