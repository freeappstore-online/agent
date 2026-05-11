/** Unified types across AI providers */

export type Provider = "anthropic" | "openai" | "google" | "github";

export interface AIConfig {
  provider: Provider;
  model: string;
  apiKey: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export interface StreamEvent {
  type: "text" | "tool_call" | "tool_result" | "done" | "error" | "usage";
  /** For text: the delta. For tool_call: JSON of ToolCall. For usage: JSON of TokenUsage. */
  data: string;
}

/** What the provider adapter must implement */
export interface ProviderAdapter {
  /** Run one turn of the agent loop. Yields StreamEvents. */
  run(
    systemPrompt: string,
    messages: Message[],
    tools: ToolDef[],
  ): AsyncGenerator<StreamEvent>;
}

export interface Message {
  role: "user" | "assistant" | "tool_result";
  content: string;
  /** Only for tool_result messages */
  toolResults?: ToolResult[];
  /** Only for assistant messages that include tool calls */
  toolCalls?: ToolCall[];
}
