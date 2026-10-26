import { describe, expect, test } from "bun:test";
import {
  WEBHOOK_EVENTS, defaultWebhookForm, emptyWebhookEventPicks, pickedWebhookEvents,
  validateWebhookForm, webhookEndpointState, webhookPicksFromEvents,
} from "./outbound-webhooks";

describe("outbound webhook form helpers (#10)", () => {
  test("the event mirror matches the shared closed set", () => {
    expect([...WEBHOOK_EVENTS]).toEqual(["message.received", "message.status", "conversation.created"]);
  });

  test("picks round-trip in canonical order regardless of click order", () => {
    const picks = emptyWebhookEventPicks();
    picks["conversation.created"] = true;
    picks["message.received"] = true;
    expect(pickedWebhookEvents(picks)).toEqual(["message.received", "conversation.created"]);
    expect(webhookPicksFromEvents(["conversation.created"])).toEqual({
      "message.received": false, "message.status": false, "conversation.created": true,
    });
    // Unknown stored events are ignored, never rendered as picks.
    expect(webhookPicksFromEvents(["bogus.event"])).toEqual(emptyWebhookEventPicks());
  });

  test("the default form is fully blank", () => {
    expect(defaultWebhookForm()).toEqual({ name: "", url: "", picks: emptyWebhookEventPicks() });
  });

  test("validation rejects blank name, bad URL, non-http(s) URL, and no events", () => {
    const picks = emptyWebhookEventPicks();
    expect(validateWebhookForm({ name: " ", url: "https://example.com/hook", picks })).toBe("name_required");
    expect(validateWebhookForm({ name: "Hook", url: "not a url", picks })).toBe("url_invalid");
    expect(validateWebhookForm({ name: "Hook", url: "ftp://example.com/hook", picks })).toBe("url_invalid");
    expect(validateWebhookForm({ name: "Hook", url: "https://example.com/hook", picks })).toBe("events_required");
    picks["message.status"] = true;
    expect(validateWebhookForm({ name: "Hook", url: "https://example.com/hook", picks })).toBeNull();
  });

  test("endpoint state: auto-disabled beats disabled; failures show while enabled", () => {
    expect(webhookEndpointState({ enabled: true, autoDisabled: false, consecutiveFailures: 0 })).toBe("active");
    expect(webhookEndpointState({ enabled: true, autoDisabled: false, consecutiveFailures: 3 })).toBe("failing");
    expect(webhookEndpointState({ enabled: false, autoDisabled: false, consecutiveFailures: 0 })).toBe("disabled");
    expect(webhookEndpointState({ enabled: false, autoDisabled: true, consecutiveFailures: 10 })).toBe("auto_disabled");
  });
});
