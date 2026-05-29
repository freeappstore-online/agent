/** Shared SSE line reader — deduplicates the read→decode→split loop
 *  that all three provider adapters use identically. */
export async function* readSSELines(body: ReadableStream): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

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
        if (raw && raw !== "[DONE]") yield raw;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
