/**
 * Outbound event webhooks (adoption package #10): workspace operators
 * register HTTPS endpoints and Botara POSTs signed event envelopes to
 * them. This module is the shared contract: the closed event set, the
 * delivery lifecycle constants, and the payload preview cap.
 * Everything here is pure - the signature scheme (node:crypto) lives
 * in ./webhook-signing.ts and the SSRF guard (DNS) in ./ssrf.ts, both
 * server-only subpath modules, so this root module stays bundle-safe
 * for the web app.
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

