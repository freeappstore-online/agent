/** GitHub Models adapter — OpenAI-compatible API at models.github.ai */

import { OpenAIAdapter } from "./openai";
import type { ProviderAdapter } from "./types";

export class GitHubModelsAdapter extends OpenAIAdapter implements ProviderAdapter {
  constructor(apiKey: string, model: string, temperature = 0.7, maxTokens = 16384) {
    super(apiKey, model, "https://models.github.ai/inference/chat/completions", temperature, maxTokens);
  }
}
