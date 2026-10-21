import { NotImplementedError } from "@botara/shared";

/**
 * Single provider interface for all LLM use (ADR: provider is still an open
 * decision). Product code depends only on this interface; concrete providers
 * (OpenAI, Claude, Gemini, local, ...) plug in behind it.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ChatCompletionInput {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
}

export interface ChatCompletionResult {
  text: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface AIProvider {
  readonly name: string;
  chatCompletion(input: ChatCompletionInput): Promise<ChatCompletionResult>;
  embedding(input: { model: string; text: string }): Promise<number[]>;
}

/** Honest stub: no provider is configured in Fase 0. */
export class StubAIProvider implements AIProvider {
  readonly name = "stub";
  async chatCompletion(): Promise<ChatCompletionResult> {
    throw new NotImplementedError("ai.chatCompletion (no LLM provider configured)");
  }
  async embedding(): Promise<number[]> {
    throw new NotImplementedError("ai.embedding (no LLM provider configured)");
  }
}
