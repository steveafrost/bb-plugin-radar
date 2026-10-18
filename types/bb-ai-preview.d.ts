// Local preview generated from BB source backend-contract.ts; remove when the installed SDK includes experimental_ai.
import "@get-bb/plugin-sdk";

declare module "@get-bb/plugin-sdk" {
export interface ExperimentalPluginAiCompleteInput {
  prompt: string;
  system?: string;
  providerId?: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExperimentalPluginAiCompleteResult {
  text: string;
  providerId: string;
  model: string;
}

export interface ExperimentalPluginAi {
  complete(
    input: ExperimentalPluginAiCompleteInput,
  ): Promise<ExperimentalPluginAiCompleteResult>;
}

interface BbPluginApi {
  readonly experimental_ai: ExperimentalPluginAi;
}
}
