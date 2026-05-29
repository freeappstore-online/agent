import type { Message, ProviderAdapter, StreamEvent, ToolDef } from "./types";

/** Shared base for all provider adapters — holds the common constructor fields. */
export abstract class BaseAdapter implements ProviderAdapter {
  constructor(
    protected apiKey: string,
    protected model: string,
    protected temperature: number = 0.7,
    protected maxTokens: number = 16384,
  ) {}

  abstract run(systemPrompt: string, messages: Message[], tools: ToolDef[]): AsyncGenerator<StreamEvent>;
}
