/** Agent loop: send messages to AI, handle tool calls, repeat until done. */

import type { AIConfig, Message, ToolCall, ToolResult, StreamEvent, ProviderAdapter } from "./providers/types";
import type { StoreConfig } from "./config";
import { AnthropicAdapter } from "./providers/anthropic";
import { OpenAIAdapter } from "./providers/openai";
import { GoogleAdapter } from "./providers/google";
import { GitHubModelsAdapter } from "./providers/github";
import { getToolDefinitions, INFRA_TOOLS, executeTool } from "./tools";
import { getSystemPrompt } from "./template";

function createAdapter(config: AIConfig): ProviderAdapter {
  const temp = config.temperature ?? 0.7;
  const maxTok = config.maxTokens ?? 16384;
  switch (config.provider) {
    case "anthropic":
      return new AnthropicAdapter(config.apiKey, config.model, temp, maxTok);
    case "openai":
      return new OpenAIAdapter(config.apiKey, config.model, undefined, temp, maxTok);
    case "google":
      return new GoogleAdapter(config.apiKey, config.model, temp, maxTok);
    case "github":
      return new GitHubModelsAdapter(config.apiKey, config.model, temp, maxTok);
  }
}

export interface InfraRequest {
  toolCall: ToolCall;
}

export interface AgentTurnResult {
  newMessages: Message[];
  /** Infra tool calls that need server-side execution by the session */
  infraRequests: InfraRequest[];
}

export interface SessionContext {
  appId: string | null;
  appName: string | null;
  fileCount: number;
  fileList: string;
}

/**
 * Run one user turn through the agent loop.
 * Streams events via the writer, handles file tool calls internally.
 * Infra tools (deploy, push_update, etc.) are collected and returned
 * for the session to execute with env access.
 */
export async function runAgentTurn(
  config: AIConfig,
  conversationHistory: Message[],
  userMessage: string,
  files: Map<string, string>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  storeConfig: StoreConfig,
  ctx?: SessionContext,
): Promise<AgentTurnResult> {
  const encoder = new TextEncoder();
  const adapter = createAdapter(config);
  const MAX_LOOPS = 25;
  const toolDefinitions = getToolDefinitions(storeConfig);

  // Build dynamic system prompt with session context
  let systemPrompt = getSystemPrompt(storeConfig);
  if (ctx) {
    const noun = storeConfig.noun;
    const Noun = storeConfig.Noun;
    const parts: string[] = [`\n\n## Current Session State`];
    parts.push(`- Files in project: ${ctx.fileCount} (${ctx.fileList.slice(0, 300)})`);
    if (ctx.appId) {
      parts.push(`- Deployed ${noun} ID: ${ctx.appId}`);
      parts.push(`- ${Noun} name: ${ctx.appName}`);
      parts.push(`- ${Noun} ID: ${ctx.appId} (deployed)`);
      parts.push(`- Use push_update (not deploy) for changes to this ${noun}.`);
    } else {
      parts.push(`- ${Noun} not yet deployed. Use deploy tool when ready.`);
    }
    systemPrompt += parts.join("\n");
  }

  // Trim conversation history to fit model context limits.
  // GitHub Models free tier limits vary by model:
  //   gpt-4.1: 8K tokens, gpt-4o/4o-mini: 16K+, others: varies
  // System prompt + 14 tools ≈ 2600 tokens.
  const isSmallContext = config.provider === "github" && config.model.includes("gpt-4.1");
  const MAX_HISTORY_CHARS = isSmallContext ? 6000 : config.provider === "github" ? 30000 : 80000;

  function msgSize(m: Message): number {
    let size = m.content?.length || 0;
    if (m.toolCalls) size += JSON.stringify(m.toolCalls).length;
    if (m.toolResults) size += JSON.stringify(m.toolResults).length;
    return size;
  }

  const trimmedHistory = [...conversationHistory];
  let historyChars = trimmedHistory.reduce((sum, m) => sum + msgSize(m), 0);

  // Drop messages from the front until under limit
  while (historyChars > MAX_HISTORY_CHARS && trimmedHistory.length > 2) {
    historyChars -= msgSize(trimmedHistory.shift()!);
  }

  // Fix orphaned messages: first message must be role=user.
  while (trimmedHistory.length > 1 && trimmedHistory[0].role !== "user") {
    trimmedHistory.shift();
  }

  // Fix orphaned tool_use/tool_result pairs:
  // Every assistant message with toolCalls must be followed by a tool_result.
  // Every tool_result must follow an assistant with toolCalls.
  // Drop any that don't have their pair.
  const cleaned: Message[] = [];
  for (let i = 0; i < trimmedHistory.length; i++) {
    const m = trimmedHistory[i];
    if (m.role === "assistant" && m.toolCalls?.length) {
      // Check if next message is tool_result
      const next = trimmedHistory[i + 1];
      if (next?.role === "tool_result") {
        cleaned.push(m, next);
        i++; // skip the tool_result
      }
      // else: orphaned tool_use — drop both
    } else if (m.role === "tool_result") {
      // Orphaned tool_result without preceding tool_use — drop it
    } else {
      cleaned.push(m);
    }
  }

  const messages: Message[] = [
    ...cleaned,
    { role: "user", content: userMessage },
  ];
  const newMessages: Message[] = [{ role: "user", content: userMessage }];
  const infraRequests: InfraRequest[] = [];

  async function send(event: StreamEvent) {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    await writer.write(encoder.encode(line));
  }

  let retries = 0;
  const MAX_RETRIES = 3;

  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    // Stagger API calls — wait between rounds to avoid rate limits
    if (loop > 0) {
      const delay = config.provider === "github" ? 2000 : 500;
      await new Promise((r) => setTimeout(r, delay));
    }

    let assistantText = "";
    const toolCalls: ToolCall[] = [];
    let rateLimited = false;

    try {
      for await (const event of adapter.run(systemPrompt, messages, toolDefinitions)) {
        if (event.type === "done") continue;
        // Catch rate limit errors and retry after delay
        if (event.type === "error" && (event.data.includes("429") || event.data.includes("Rate limited"))) {
          rateLimited = true;
          break;
        }
        await send(event);
        if (event.type === "text") {
          assistantText += event.data;
        } else if (event.type === "tool_call") {
          toolCalls.push(JSON.parse(event.data));
        } else if (event.type === "error") {
          const errMsg: Message = { role: "assistant", content: event.data };
          newMessages.push(errMsg);
          return { newMessages, infraRequests };
        }
      }
    } catch (err) {
      await send({ type: "error", data: String(err) });
      break;
    }

    // Auto-retry on rate limit with exponential backoff
    if (rateLimited) {
      retries++;
      if (retries > MAX_RETRIES) {
        await send({ type: "error", data: "Rate limited after 3 retries. Wait a minute or switch to a BYOK provider (gear icon)." });
        break;
      }
      const retryDelay = 5000 * retries; // 5s, 10s, 15s
      await send({ type: "text", data: `\n_Rate limited — retrying in ${retryDelay / 1000}s (attempt ${retries}/${MAX_RETRIES})..._\n` });
      await new Promise((r) => setTimeout(r, retryDelay));
      loop--; // retry same iteration
      continue;
    }
    retries = 0; // reset on success

    const assistantMsg: Message = {
      role: "assistant",
      content: assistantText,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
    messages.push(assistantMsg);
    newMessages.push(assistantMsg);

    if (toolCalls.length === 0) break;

    // Separate file tools (execute now) from infra tools (execute in session)
    const fileToolCalls = toolCalls.filter(tc => !INFRA_TOOLS.has(tc.name));
    const infraToolCalls = toolCalls.filter(tc => INFRA_TOOLS.has(tc.name));

    // Execute file tools
    const results: ToolResult[] = [];
    for (const tc of fileToolCalls) {
      const result = executeTool(tc, files, storeConfig);
      // Truncate large results in conversation history (e.g. read_file returning full file)
      const truncated = { ...result, content: result.content.slice(0, 1500) };
      results.push(truncated);
      await send({ type: "tool_result", data: JSON.stringify({ id: tc.id, tool: tc.name, result: result.content.slice(0, 400) }) });
    }

    // Collect infra tools — session will execute them and build the
    // complete tool_result message (with real results, not acks)
    for (const tc of infraToolCalls) {
      infraRequests.push({ toolCall: tc });
    }

    if (infraToolCalls.length > 0) {
      // Don't add a tool_result to conversation yet — session will
      // build it with real results and add it to messages
      if (fileToolCalls.length > 0) {
        // Add file tool results only (infra results come from session)
        const fileResultMsg: Message = {
          role: "tool_result",
          content: "",
          toolResults: results,
        };
        messages.push(fileResultMsg);
        newMessages.push(fileResultMsg);
      }
      break;
    }

    // All tools were file tools — add results and continue the loop
    const toolResultMsg: Message = {
      role: "tool_result",
      content: "",
      toolResults: results,
    };
    messages.push(toolResultMsg);
    newMessages.push(toolResultMsg);
  }

  if (infraRequests.length === 0) {
    await send({ type: "done", data: "" });
  }
  return { newMessages, infraRequests };
}
