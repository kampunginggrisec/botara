import { describe, expect, test } from "bun:test";
import { isWebhookLogItem, isWebhookLogResponse } from "./webhook-log";

/**
 * Admin → Webhook log payload guard: the page must turn a malformed
 * response into its load-error state, never a white screen - so the
 * guard accepts exactly the wire shape GET /admin/webhook-log returns
 * and rejects everything else.
 */
const item = {
  id: "r-1",
  createdAt: "2026-10-27T15:00:00.000Z",
  channel: "whatsapp",
  eventType: "message.received",
  outcome: "processed",
  httpStatus: 200,
  workspaceId: "ws-1",
  channelAccountId: "acc-1",
  payloadSummary: "{\"object\":\"whatsapp_business_account\"}",
  error: null,
};

describe("isWebhookLogResponse", () => {
  test("accepts a well-formed response, including an empty list", () => {
    expect(isWebhookLogResponse({ receipts: [item] })).toBe(true);
    expect(isWebhookLogResponse({ receipts: [] })).toBe(true);
  });

  test("accepts null event type / workspace / account / summary (error receipts)", () => {
    expect(isWebhookLogItem({
      ...item,
      eventType: null, workspaceId: null, channelAccountId: null,
      payloadSummary: null, outcome: "error", httpStatus: 401,
      error: "Invalid X-Hub-Signature-256.",
    })).toBe(true);
  });

  test("rejects non-objects and missing receipts arrays", () => {
    expect(isWebhookLogResponse(null)).toBe(false);
    expect(isWebhookLogResponse("nope")).toBe(false);
    expect(isWebhookLogResponse({})).toBe(false);
    expect(isWebhookLogResponse({ receipts: "nope" })).toBe(false);
  });

  test("rejects items with wrong field types or unknown outcomes", () => {
    expect(isWebhookLogResponse({ receipts: [{ ...item, httpStatus: "200" }] })).toBe(false);
    expect(isWebhookLogResponse({ receipts: [{ ...item, outcome: "exploded" }] })).toBe(false);
    expect(isWebhookLogResponse({ receipts: [{ ...item, payloadSummary: 42 }] })).toBe(false);
    expect(isWebhookLogResponse({ receipts: [{ ...item, createdAt: 123 }] })).toBe(false);
  });
});
