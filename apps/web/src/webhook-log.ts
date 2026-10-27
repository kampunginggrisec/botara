import type { AdminWebhookLogItem } from "./api";

/**
 * Presentation helpers for Admin → Webhook log, kept out of App.tsx so
 * the validation rules are unit-testable.
 *
 * The page validates the payload before it trusts it (the package #6
 * lesson): a malformed response becomes the page's load-error state,
 * never a white screen.
 */

/** Channels the webhook-log filter offers ("" = all). */
export const WEBHOOK_LOG_CHANNELS = [
  "whatsapp",
  "messenger",
  "instagram",
  "threads",
  "telegram",
  "tiktok",
] as const;

/** Outcomes the webhook-log filter offers ("" = all). */
export const WEBHOOK_LOG_OUTCOMES = ["processed", "ignored", "error"] as const;

const OUTCOME_SET: ReadonlySet<string> = new Set(WEBHOOK_LOG_OUTCOMES);

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function isWebhookLogItem(value: unknown): value is AdminWebhookLogItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.createdAt !== "string") return false;
  if (typeof v.channel !== "string") return false;
  if (!isNullableString(v.eventType)) return false;
  if (typeof v.outcome !== "string" || !OUTCOME_SET.has(v.outcome)) return false;
  if (typeof v.httpStatus !== "number") return false;
  if (!isNullableString(v.workspaceId) || !isNullableString(v.channelAccountId)) return false;
  if (!isNullableString(v.payloadSummary) || !isNullableString(v.error)) return false;
  return true;
}

/** Runtime shape check for GET /admin/webhook-log responses. */
export function isWebhookLogResponse(value: unknown): value is { receipts: AdminWebhookLogItem[] } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.receipts)) return false;
  return v.receipts.every(isWebhookLogItem);
}
