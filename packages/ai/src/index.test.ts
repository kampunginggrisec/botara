import { describe, expect, test } from "bun:test";
import {
  OpenAICompatibleProvider, createAIProviderFromEnv, moderateText, type FetchLike,
} from "./index";

interface RecordedCall { url: string; init?: RequestInit }

function mockFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetchFn: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    const next = queue.shift() ?? { body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchFn, calls };
}

const API_KEY = ["sk", "test", "key"].join("-");

describe("openai-compatible provider", () => {
  test("chatCompletion posts to /chat/completions and parses text + usage", async () => {
    const { fetchFn, calls } = mockFetch([{
      body: {
        model: "gpt-4o-mini",
        choices: [{ message: { role: "assistant", content: "Siap, kak!" } }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      },
    }]);
    const provider = new OpenAICompatibleProvider({ baseUrl: "https://llm.example.com/v1", apiKey: API_KEY, fetchFn });
    const res = await provider.chatCompletion({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "halo" }],
    });
    expect(res.text).toBe("Siap, kak!");
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 4 });
    expect(calls[0]!.url).toBe("https://llm.example.com/v1/chat/completions");
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });

  test("embedding posts to /embeddings and returns the vector", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { data: [{ embedding: [0.1, 0.2, 0.3] }] } }]);
    const provider = new OpenAICompatibleProvider({ baseUrl: "https://llm.example.com/v1/", apiKey: API_KEY, fetchFn });
    const vector = await provider.embedding({ model: "text-embedding-3-small", text: "halo" });
    expect(vector).toEqual([0.1, 0.2, 0.3]);
    expect(calls[0]!.url).toBe("https://llm.example.com/v1/embeddings");
  });

  test("provider errors map into the AppError taxonomy", async () => {
    const { fetchFn } = mockFetch([{ status: 401, body: { error: { message: "bad key" } } }]);
    const provider = new OpenAICompatibleProvider({ baseUrl: "https://llm.example.com/v1", apiKey: API_KEY, fetchFn });
    await expect(provider.chatCompletion({ model: "m", messages: [] }))
      .rejects.toMatchObject({ code: "PROVIDER_ERROR", status: 401, message: "bad key" });
  });

  test("createAIProviderFromEnv returns null without a key (callers must 503, never fake)", () => {
    expect(createAIProviderFromEnv({})).toBeNull();
    expect(createAIProviderFromEnv({ AI_API_KEY: API_KEY })).not.toBeNull();
  });
});

describe("keyword moderation", () => {
  test("flags list terms case-insensitively with positions", () => {
    const res = moderateText("Tolong kirim KODE OTP kamu sekarang", ["kode otp"]);
    expect(res.flagged).toBe(true);
    expect(res.matches).toEqual([{ term: "kode otp", index: 13 }]);
  });

  test("clean text is not flagged; word boundaries avoid false positives", () => {
    expect(moderateText("halo, ada yang bisa kami bantu?").flagged).toBe(false);
    // "password" inside a longer word should not match the word-boundary rule
    expect(moderateText("passwordless login is great", ["password"]).flagged).toBe(false);
    expect(moderateText("never share your password", ["password"]).flagged).toBe(true);
  });

  test("default list catches common scam tripwires", () => {
    expect(moderateText("Selamat! giveaway palsu untukmu").flagged).toBe(true);
  });
});
