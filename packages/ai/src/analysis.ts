import { AppError } from "@botara/shared";
import type { ChatMessage } from "./index";

/**
 * Conversation analysis (AI copilot, package #7).
 *
 * One chat call turns a thread into a persisted triage record: a short
 * summary, ONE intent label from the closed set below, and a 0-100
 * confidence score. The contract is deliberately strict - the API route
 * persists exactly what parseConversationAnalysis returns, and ANY
 * deviation (unparseable text, missing fields, an intent outside the
 * closed set, a score outside 0-100) throws AI_RESPONSE_INVALID (502)
 * so the route stores nothing. A plausible-looking analysis is never
 * fabricated client-side.
 */

/** Closed intent label set - the ONLY values ai_intent may ever hold. */
export const AI_INTENT_LABELS = [
  "inquiry",
  "purchase_intent",
  "support",
  "complaint",
  "spam",
  "other",
] as const;

export type AiIntentLabel = (typeof AI_INTENT_LABELS)[number];

export interface ConversationAnalysis {
  summary: string;
  intent: AiIntentLabel;
  intentScore: number;
}

/**
 * How many of the most recent thread messages (internal notes already
 * excluded by the caller) go into the analysis prompt. 30 covers a full
 * support thread's arc without blowing the context on very long ones;
 * older messages still shaped the conversation but the summary is a
 * triage aid for the CURRENT state, so recency wins.
 */
export const CONVERSATION_ANALYSIS_HISTORY_CAP = 30;

/** Summary length ceiling - longer model output is truncated, not rejected. */
export const CONVERSATION_ANALYSIS_SUMMARY_MAX = 1000;

const ANALYSIS_SYSTEM_PROMPT = [
  "You analyze a customer conversation for a support agent.",
  "Read the transcript and answer with STRICT JSON only - no prose, no code fences:",
  '{"summary": string, "intent": string, "intentScore": number}',
  "- summary: 1-2 sentences describing what the customer wants and where things stand, in the conversation's language.",
  `- intent: exactly one of ${AI_INTENT_LABELS.join(" | ")}.`,
  "- intentScore: your confidence in that intent label, an integer 0-100.",
].join("\n");

/**
 * Build the analysis prompt: a fixed system instruction plus the thread
 * as a single transcript (Customer/Agent lines). A transcript - not
 * alternating chat turns - keeps the model in analyst mode instead of
 * continuing the conversation.
 */
export function buildConversationAnalysisMessages(
  history: Array<{ direction: "in" | "out"; body: string | null }>,
): ChatMessage[] {
  const lines = history.map(
    (m) => `${m.direction === "in" ? "Customer" : "Agent"}: ${m.body ?? ""}`,
  );
  return [
    { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
    {
      role: "user",
      content: lines.length > 0 ? lines.join("\n") : "(no messages in this conversation yet)",
    },
  ];
}

function invalid(reason: string): AppError {
  return new AppError(
    "AI_RESPONSE_INVALID",
    `AI analysis response was malformed: ${reason}. Nothing was stored.`,
    { status: 502 },
  );
}

/**
 * Parse + validate one raw model response into a ConversationAnalysis.
 * Throws AppError AI_RESPONSE_INVALID (502) on ANY malformation; callers
 * persist nothing in that case.
 */
export function parseConversationAnalysis(raw: string): ConversationAnalysis {
  let text = raw.trim();
  // Models often fence JSON despite instructions; a fence is transport
  // noise, not content - strip it, then validate the payload strictly.
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  if (fenced) text = fenced[1]!.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid("not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalid("top level is not an object");
  }
  const obj = parsed as Record<string, unknown>;

  const summaryRaw = obj.summary;
  if (typeof summaryRaw !== "string" || summaryRaw.trim().length === 0) {
    throw invalid("summary is missing or empty");
  }
  const summary = summaryRaw.trim().slice(0, CONVERSATION_ANALYSIS_SUMMARY_MAX);

  const intentRaw = obj.intent;
  if (typeof intentRaw !== "string") throw invalid("intent is missing");
  const intent = intentRaw.trim().toLowerCase();
  if (!(AI_INTENT_LABELS as readonly string[]).includes(intent)) {
    throw invalid(`intent "${intentRaw}" is not one of the known labels`);
  }

  const scoreRaw = obj.intentScore;
  if (typeof scoreRaw !== "number" || !Number.isFinite(scoreRaw)) {
    throw invalid("intentScore is not a number");
  }
  const intentScore = Math.round(scoreRaw);
  if (intentScore < 0 || intentScore > 100) {
    throw invalid("intentScore is outside 0-100");
  }

  return { summary, intent: intent as AiIntentLabel, intentScore };
}
