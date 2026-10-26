/**
 * Outbound webhooks for the Settings UI (adoption #10).
 *
 * The canonical event list lives in @botara/shared
 * (outbound-webhooks.ts); the web bundle keeps this local mirror - same
 * convention as api-tokens.ts - and the API re-validates every event
 * server-side, so drift here can only ever produce a 400.
 */
export const WEBHOOK_EVENTS = [
  "message.received",
  "message.status",
  "conversation.created",
] as const;

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

/** Per-event checkbox state in the create/edit form. */
export type WebhookEventPicks = Record<WebhookEventName, boolean>;

export function emptyWebhookEventPicks(): WebhookEventPicks {
  return { "message.received": false, "message.status": false, "conversation.created": false };
}

/** The events a form state subscribes to, in canonical order. */
export function pickedWebhookEvents(picks: WebhookEventPicks): string[] {
  return WEBHOOK_EVENTS.filter((event) => picks[event]);
}

/** Form state from an endpoint's stored subscription list. */
export function webhookPicksFromEvents(events: readonly string[]): WebhookEventPicks {
  const picks = emptyWebhookEventPicks();
  for (const event of WEBHOOK_EVENTS) picks[event] = events.includes(event);
  return picks;
}

/**
 * The create form's factory defaults: after a successful create the
 * form returns to EXACTLY this state (the #7 token-form lesson: a form
 * that keeps the previous entry's picks invites accidental duplicates).
 */
export function defaultWebhookForm(): { name: string; url: string; picks: WebhookEventPicks } {
  return { name: "", url: "", picks: emptyWebhookEventPicks() };
}

/** i18n key for an event's label; null for events this UI version doesn't know. */
export type WebhookEventLabelKey = `settings.webhookEvent.${WebhookEventName}`;

export function webhookEventLabelKey(event: string): WebhookEventLabelKey | null {
  return (WEBHOOK_EVENTS as readonly string[]).includes(event)
    ? `settings.webhookEvent.${event as WebhookEventName}`
    : null;
}

/** Health label for an endpoint row. */
export function webhookEndpointState(endpoint: {
  enabled: boolean;
  autoDisabled: boolean;
  consecutiveFailures: number;
}): "active" | "disabled" | "auto_disabled" | "failing" {
  if (!endpoint.enabled) return endpoint.autoDisabled ? "auto_disabled" : "disabled";
  return endpoint.consecutiveFailures > 0 ? "failing" : "active";
}

/**
 * Validate the create/edit form client-side (the API re-validates,
 * including the SSRF rules, server-side): name present, URL parses as
 * http(s), at least one event picked.
 */
export function validateWebhookForm(input: {
  name: string;
  url: string;
  picks: WebhookEventPicks;
}): "name_required" | "url_invalid" | "events_required" | null {
  if (!input.name.trim()) return "name_required";
  let parsed: URL;
  try {
    parsed = new URL(input.url.trim());
  } catch {
    return "url_invalid";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "url_invalid";
  if (pickedWebhookEvents(input.picks).length === 0) return "events_required";
  return null;
}
