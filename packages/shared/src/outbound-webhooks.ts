import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Outbound event webhooks (adoption package #10): workspace operators
 * register HTTPS endpoints and Botara POSTs signed event envelopes to
 * them. This module is the shared contract: the closed event set, the
 * delivery lifecycle constants, and the Stripe-style signature scheme.
 * The SSRF guard lives in ./ssrf.ts (it needs DNS, so it stays
 * server-side); everything here is pure.
 */

/** Events an endpoint may subscribe to. Closed set - validated on write. */
export const OUTBOUND_WEBHOOK_EVENTS = [
  "message.received",
  "message.status",
  "conversation.created",
] as const;

export type OutboundWebhookEvent = (typeof OUTBOUND_WEBHOOK_EVENTS)[number];

/**
 * The synthetic ping created by POST /settings/webhooks/:id/test. It
 * travels the same delivery pipeline (signing, SSRF guard, retries) but
 * is NOT subscribable - it is minted only by the test action.
 */
export const WEBHOOK_TEST_EVENT = "webhook.test";

/** Every event name that may appear on a delivery row. */
export type WebhookDeliveryEvent = OutboundWebhookEvent | typeof WEBHOOK_TEST_EVENT;

export function isOutboundWebhookEvent(value: unknown): value is OutboundWebhookEvent {
  return typeof value === "string" && (OUTBOUND_WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/** Validate an endpoint's subscription list: non-empty, all known, deduped. */
export function parseWebhookEvents(value: unknown): OutboundWebhookEvent[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const seen = new Set<OutboundWebhookEvent>();
  for (const item of value) {
    if (!isOutboundWebhookEvent(item)) return null;
    seen.add(item);
  }
  return [...seen];
}

/** Total send attempts per delivery (BullMQ attempts AND the worker's own counter agree on this). */
export const WEBHOOK_DELIVERY_MAX_ATTEMPTS = 5;

/** Consecutive failed DELIVERIES (not attempts) that auto-disable an endpoint. */
export const WEBHOOK_AUTO_DISABLE_FAILURES = 10;

/** Per-send HTTP timeout. */
export const WEBHOOK_HTTP_TIMEOUT_MS = 10_000;

/**
 * Preview cap for message.received payloads: receivers get enough text
 * to triage/route, never the full body - the inbox remains the system
 * of record for message content.
 */
export const WEBHOOK_MESSAGE_PREVIEW_CHARS = 200;

/** Truncate a message body for a webhook payload preview. */
export function webhookMessagePreview(body: string | undefined | null): string | undefined {
  if (body === undefined || body === null) return undefined;
  return body.length > WEBHOOK_MESSAGE_PREVIEW_CHARS
    ? body.slice(0, WEBHOOK_MESSAGE_PREVIEW_CHARS)
    : body;
}

// ------------------------------------------------------------- signatures

/**
 * Signature scheme (Stripe-style): the receiver verifies
 *   v1 = hex(HMAC-SHA256(secret, `${t}.${rawBody}`))
 * where `t` is the unix-seconds timestamp carried in the same header:
 *   X-Botara-Signature: t=<unixSeconds>,v1=<hex>
 * The timestamp binds the signature to a moment so captured deliveries
 * cannot be replayed forever; verifiers should reject stale `t`.
 */
export function computeWebhookSignature(secret: string, timestampSeconds: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`, "utf8").digest("hex");
}

/** The full X-Botara-Signature header value for one send. */
export function webhookSignatureHeader(secret: string, timestampSeconds: number, rawBody: string): string {
  return `t=${timestampSeconds},v1=${computeWebhookSignature(secret, timestampSeconds, rawBody)}`;
}

/** Default freshness window for signature verification (5 minutes). */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verify an X-Botara-Signature header against a raw body. Constant-time
 * comparison; rejects malformed headers, wrong signatures, and (when
 * `nowSeconds` is given) timestamps outside the tolerance window.
 */
export function verifyWebhookSignature(
  secret: string,
  header: string | null | undefined,
  rawBody: string,
  options: { nowSeconds?: number; toleranceSeconds?: number } = {},
): boolean {
  if (!header) return false;
  let t: string | undefined;
  let v1: string | undefined;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") t = value;
    if (key === "v1") v1 = value;
  }
  if (!t || !v1 || !/^\d+$/.test(t) || !/^[0-9a-f]{64}$/i.test(v1)) return false;
  const timestamp = Number(t);
  if (options.nowSeconds !== undefined) {
    const tolerance = options.toleranceSeconds ?? WEBHOOK_SIGNATURE_TOLERANCE_SECONDS;
    if (Math.abs(options.nowSeconds - timestamp) > tolerance) return false;
  }
  const expected = Buffer.from(computeWebhookSignature(secret, timestamp, rawBody), "hex");
  const given = Buffer.from(v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
