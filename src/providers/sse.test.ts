import { describe, expect, it } from "vitest";
import { readSSELines } from "./sse";

function makeStream(chunks: string[]): ReadableStream {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("readSSELines", () => {
  it("yields data lines from a clean SSE stream", async () => {
    const stream = makeStream(["data: hello\n\ndata: world\n\n"]);
    const lines: string[] = [];
    for await (const line of readSSELines(stream)) lines.push(line);
    expect(lines).toEqual(["hello", "world"]);
  });

  it("skips [DONE] sentinel", async () => {
    const stream = makeStream(["data: hello\ndata: [DONE]\n"]);
    const lines: string[] = [];
    for await (const line of readSSELines(stream)) lines.push(line);
    expect(lines).toEqual(["hello"]);
  });

  it("skips non-data lines (comments, empty, event names)", async () => {
    const stream = makeStream([": comment\nevent: msg\nid: 1\ndata: payload\n\n"]);
    const lines: string[] = [];
    for await (const line of readSSELines(stream)) lines.push(line);
    expect(lines).toEqual(["payload"]);
  });

  it("handles chunks split mid-line", async () => {
    const stream = makeStream(["data: hel", "lo\ndata: wor", "ld\n"]);
    const lines: string[] = [];
    for await (const line of readSSELines(stream)) lines.push(line);
    expect(lines).toEqual(["hello", "world"]);
  });

  it("skips empty data values", async () => {
    const stream = makeStream(["data: \ndata: real\n"]);
    const lines: string[] = [];
    for await (const line of readSSELines(stream)) lines.push(line);
    expect(lines).toEqual(["real"]);
  });

  it("handles JSON payloads", async () => {
    const stream = makeStream(['data: {"type":"text","data":"hi"}\n']);
    const lines: string[] = [];
    for await (const line of readSSELines(stream)) lines.push(line);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ type: "text", data: "hi" });
  });
});
