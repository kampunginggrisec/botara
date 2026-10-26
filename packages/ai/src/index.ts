import { AppError, NotImplementedError } from "@botara/shared";

/**
 * Single provider interface for all LLM use. Product code depends only on
 * this interface; concrete providers plug in behind it.
 *
 * Fase 2 ships ONE real provider: an OpenAI-compatible HTTP client. Any
 * endpoint that speaks the OpenAI chat/embedding wire format works - the
 * hosted OpenAI API, Azure OpenAI, OpenRouter, or a self-hosted
 * vLLM/Ollama server - by changing base URL + key + model only. Which one
 * Botara standardises on is still an open product decision; this provider
 * keeps that decision reversible.
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

/** Honest stub kept for tests/wiring: no provider configured. */
export class StubAIProvider implements AIProvider {
  readonly name = "stub";
  async chatCompletion(): Promise<ChatCompletionResult> {
    throw new NotImplementedError("ai.chatCompletion (no LLM provider configured)");
  }
  async embedding(): Promise<number[]> {
    throw new NotImplementedError("ai.embedding (no LLM provider configured)");
  }
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface OpenAICompatibleOptions {
  /** e.g. https://api.openai.com/v1 - any OpenAI-wire-compatible endpoint. */
  baseUrl: string;
  apiKey: string;
  fetchFn?: FetchLike;
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly name = "openai-compatible";
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: FetchLike;

  constructor(options: OpenAICompatibleOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  }

  private async post(path: string, body: Record<string, unknown>): Promise<Record<string, any>> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new AppError("PROVIDER_ERROR", `AI provider unreachable: ${err instanceof Error ? err.message : String(err)}`, {
        status: 502,
        details: { provider: this.name, retryable: true },
      });
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      const message = (json.error as { message?: string } | undefined)?.message
        ?? `AI provider error (HTTP ${res.status})`;
      throw new AppError("PROVIDER_ERROR", message, {
        status: res.status === 401 || res.status === 403 ? 401 : 502,
        details: { provider: this.name, httpStatus: res.status, retryable: res.status >= 500 || res.status === 429 },
      });
    }
    return json;
  }

  async chatCompletion(input: ChatCompletionInput): Promise<ChatCompletionResult> {
    const json = await this.post("/chat/completions", {
      model: input.model,
      messages: input.messages,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    });
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new AppError("PROVIDER_ERROR", "AI provider returned no chat completion text", {
        status: 502,
        details: { provider: this.name, retryable: false },
      });
    }
    return {
      text,
      model: typeof json.model === "string" ? json.model : input.model,
      usage: json.usage
        ? { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 }
        : undefined,
    };
  }

  async embedding(input: { model: string; text: string }): Promise<number[]> {
    const json = await this.post("/embeddings", { model: input.model, input: input.text });
    const vector = json.data?.[0]?.embedding;
    if (!Array.isArray(vector)) {
      throw new AppError("PROVIDER_ERROR", "AI provider returned no embedding vector", {
        status: 502,
        details: { provider: this.name, retryable: false },
      });
    }
    return vector as number[];
  }
}

/**
 * Build the configured provider from env, or null when no AI key exists.
 * Callers (API routes) turn null into a 503 CONFIGURATION - a suggestion is
 * never faked.
 */
export function createAIProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): OpenAICompatibleProvider | null {
  const apiKey = env.AI_API_KEY;
  if (!apiKey) return null;
  return new OpenAICompatibleProvider({
    baseUrl: env.AI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey,
  });
}

export const DEFAULT_AI_MODEL = "gpt-4o-mini";

// ---------------------------------------------------------------- moderation

/**
 * Deliberately simple keyword moderation (Fase 2): a case-insensitive,
 * word-boundary scan against a flag list. This is a triage aid for agents,
 * NOT a safety system - a real classifier/RAG moderation layer is a later
 * phase. The default list is short and generic (scam/profanity tripwires in
 * EN + ID); workspaces extend it per call.
 */
export const DEFAULT_FLAG_LIST = [
  "password", "kode otp", "otp code", "pin atm", "credit card number",
  "nomor kartu kredit", "transfer ke rekening", "giveaway palsu",
  "damn", "sialan",
] as const;

export interface ModerationMatch {
  term: string;
  index: number;
}

export interface ModerationResult {
  flagged: boolean;
  matches: ModerationMatch[];
}

export function moderateText(
  text: string,
  flagList: readonly string[] = DEFAULT_FLAG_LIST,
): ModerationResult {
  const matches: ModerationMatch[] = [];
  const haystack = text.toLowerCase();
  for (const raw of flagList) {
    const term = raw.toLowerCase().trim();
    if (!term) continue;
    // Word-boundary match for single words; substring match for phrases.
    const pattern = term.includes(" ")
      ? term
      : `\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`;
    const re = new RegExp(pattern, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(haystack)) !== null) {
      matches.push({ term, index: m.index });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  matches.sort((a, b) => a.index - b.index);
  return { flagged: matches.length > 0, matches };
}

export {
  DEFAULT_EMBEDDING_MODEL, chunkText, cosineSimilarity, rankChunks,
  type RankedChunk, type TextChunk,
} from "./kb";

export {
  AI_INTENT_LABELS, CONVERSATION_ANALYSIS_HISTORY_CAP,
  buildConversationAnalysisMessages, parseConversationAnalysis,
  type AiIntentLabel, type ConversationAnalysis,
} from "./analysis";
