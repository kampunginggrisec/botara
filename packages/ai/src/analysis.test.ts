import { describe, expect, test } from "bun:test";
import {
  AI_INTENT_LABELS,
  buildConversationAnalysisMessages,
  parseConversationAnalysis,
} from "./analysis";

/**
 * The analysis contract (package #7): strict JSON in, a validated
 * {summary, intent, intentScore} out - anything else is a typed
 * AI_RESPONSE_INVALID 502 and the API route persists nothing.
 */
describe("parseConversationAnalysis", () => {
  const valid = JSON.stringify({
    summary: "Customer asks about bulk pricing for 50 units and waits for a quote.",
    intent: "purchase_intent",
    intentScore: 87,
  });

  test("parses a strict JSON result", () => {
    expect(parseConversationAnalysis(valid)).toEqual({
      summary: "Customer asks about bulk pricing for 50 units and waits for a quote.",
      intent: "purchase_intent",
      intentScore: 87,
    });
  });

  test("accepts a fenced JSON block and normalizes label case + score rounding", () => {
    const parsed = parseConversationAnalysis(
      "```json\n" + JSON.stringify({ summary: "S", intent: "Support", intentScore: 55.6 }) + "\n```",
    );
    expect(parsed).toEqual({ summary: "S", intent: "support", intentScore: 56 });
  });

  test("every label in the closed set is accepted", () => {
    for (const intent of AI_INTENT_LABELS) {
      const parsed = parseConversationAnalysis(
        JSON.stringify({ summary: "x", intent, intentScore: 0 }),
      );
      expect(parsed.intent).toBe(intent);
    }
  });

  test("rejects non-JSON output", () => {
    expect(() => parseConversationAnalysis("The customer seems interested.")).toThrowError(
      expect.objectContaining({ code: "AI_RESPONSE_INVALID", status: 502 }),
    );
  });

  test("rejects an intent outside the closed set", () => {
    expect(() => parseConversationAnalysis(
      JSON.stringify({ summary: "x", intent: "billing", intentScore: 50 }),
    )).toThrowError(expect.objectContaining({ code: "AI_RESPONSE_INVALID" }));
  });

  test("rejects missing/empty summary, non-numeric score, and out-of-range score", () => {
    const bad: unknown[] = [
      { intent: "inquiry", intentScore: 10 },
      { summary: "  ", intent: "inquiry", intentScore: 10 },
      { summary: "x", intent: "inquiry", intentScore: "80" },
      { summary: "x", intent: "inquiry", intentScore: 140 },
      { summary: "x", intent: "inquiry", intentScore: -1 },
      ["not", "an", "object"],
      null,
    ];
    for (const candidate of bad) {
      expect(() => parseConversationAnalysis(JSON.stringify(candidate))).toThrowError(
        expect.objectContaining({ code: "AI_RESPONSE_INVALID" }),
      );
    }
  });

  test("a long summary is truncated to the ceiling, not rejected", () => {
    const parsed = parseConversationAnalysis(
      JSON.stringify({ summary: "a".repeat(5000), intent: "other", intentScore: 1 }),
    );
    expect(parsed.summary.length).toBe(1000);
  });
});

describe("buildConversationAnalysisMessages", () => {
  test("renders a Customer/Agent transcript under a strict-JSON system prompt", () => {
    const messages = buildConversationAnalysisMessages([
      { direction: "in", body: "Berapa harga untuk 50 pcs?" },
      { direction: "out", body: "Sebentar saya cek." },
      { direction: "in", body: null },
    ]);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("STRICT JSON");
    expect(messages[1]).toEqual({
      role: "user",
      content: "Customer: Berapa harga untuk 50 pcs?\nAgent: Sebentar saya cek.\nCustomer: ",
    });
  });
});
