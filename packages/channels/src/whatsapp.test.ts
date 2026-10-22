import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { StaticCredentialProvider } from "./credentials";
import {
  MarketingPausedError, ProviderAuthError, ProviderRateLimitError, TemplateCategoryMismatchError,
} from "./errors";
import type { FetchLike } from "./types";
import {
  WhatsAppAdapter, routeForTemplateCategory, verifyWebhookChallenge, verifyWebhookSignature,
} from "./whatsapp";

const ACCOUNT = { id: "acc-1", externalId: "1234567890", tokenVaultRef: "vault:wa-1" };
const creds = new StaticCredentialProvider({ accessToken: "test-token", appSecret: "test-secret" });

interface RecordedCall { url: string; init?: RequestInit }

/** Build a mock fetch that records calls and replays queued responses. */
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

const okSend = { body: { messaging_product: "whatsapp", contacts: [{ wa_id: "62812" }], messages: [{ id: "wamid.ABC" }] } };

describe("whatsapp routing (ADR-008)", () => {
  test("routeForTemplateCategory: marketing -> marketing_messages, others -> messages", () => {
    expect(routeForTemplateCategory("marketing")).toBe("marketing_messages");
    expect(routeForTemplateCategory("MARKETING")).toBe("marketing_messages");
    expect(routeForTemplateCategory("utility")).toBe("messages");
    expect(routeForTemplateCategory("authentication")).toBe("messages");
    expect(routeForTemplateCategory(undefined)).toBe("messages");
  });

  test("marketing template is POSTed to /marketing_messages on the pinned version", async () => {
    const { fetchFn, calls } = mockFetch([okSend]);
    const wa = new WhatsAppAdapter({ credentials: creds, fetchFn });
    const res = await wa.send({
      account: ACCOUNT, toExternalId: "62812", idempotencyKey: "k1",
      template: { name: "promo", language: "id", latestCategory: "marketing" },
    });
    expect(res.externalMessageId).toBe("wamid.ABC");
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v26.0/1234567890/marketing_messages");
    const sent = JSON.parse(calls[0]!.init!.body as string);
    expect(sent.type).toBe("template");
    expect(sent.template.name).toBe("promo");
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  test("utility template is POSTed to /messages", async () => {
    const { fetchFn, calls } = mockFetch([okSend]);
    const wa = new WhatsAppAdapter({ credentials: creds, fetchFn });
    await wa.send({
      account: ACCOUNT, toExternalId: "62812", idempotencyKey: "k2",
      template: { name: "order_update", language: "en", latestCategory: "utility" },
    });
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v26.0/1234567890/messages");
  });

  test("free-form text goes to /messages with a text body", async () => {
    const { fetchFn, calls } = mockFetch([okSend]);
    const wa = new WhatsAppAdapter({ credentials: creds, fetchFn });
    await wa.send({ account: ACCOUNT, toExternalId: "62812", text: "Halo!", idempotencyKey: "k3" });
    expect(calls[0]!.url).toEndWith("/messages");
    const sent = JSON.parse(calls[0]!.init!.body as string);
    expect(sent).toMatchObject({ type: "text", text: { body: "Halo!" } });
  });
});

describe("whatsapp error mapping", () => {
  const errBody = (code: number, subcode?: number) => ({
    body: { error: { message: `err ${code}`, type: "OAuthException", code, error_subcode: subcode, fbtrace_id: "trace-1" } },
    status: 400,
  });

  test("131063 -> TemplateCategoryMismatchError with refresh signal + fbtrace_id", async () => {
    const { fetchFn } = mockFetch([errBody(131063)]);
    const wa = new WhatsAppAdapter({ credentials: creds, fetchFn });
    const p = wa.send({
      account: ACCOUNT, toExternalId: "62812", idempotencyKey: "k",
      template: { name: "promo", language: "id", latestCategory: "marketing" },
    });
    await expect(p).rejects.toBeInstanceOf(TemplateCategoryMismatchError);
    try { await p; } catch (e) {
      const err = e as TemplateCategoryMismatchError;
      expect(err.needsCategoryRefresh).toBe(true);
      expect(err.attemptedRoute).toBe("marketing_messages");
      expect(err.fbtraceId).toBe("trace-1");
      expect(err.details.providerCode).toBe(131063);
    }
  });

  test("131049 -> MarketingPausedError (US marketing pause)", async () => {
    const { fetchFn } = mockFetch([errBody(131049)]);
    const wa = new WhatsAppAdapter({ credentials: creds, fetchFn });
    await expect(wa.send({ account: ACCOUNT, toExternalId: "1555", text: "x", idempotencyKey: "k" }))
      .rejects.toBeInstanceOf(MarketingPausedError);
  });

  test("130429 -> retryable ProviderRateLimitError", async () => {
    const { fetchFn } = mockFetch([errBody(130429)]);
    const wa = new WhatsAppAdapter({ credentials: creds, fetchFn });
    try {
      await wa.send({ account: ACCOUNT, toExternalId: "1", text: "x", idempotencyKey: "k" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderRateLimitError);
      expect((e as ProviderRateLimitError).retryable).toBe(true);
      expect((e as ProviderRateLimitError).code).toBe("RATE_LIMITED");
    }
  });

  test("190 -> ProviderAuthError, non-retryable, TOKEN_EXPIRED code", async () => {
    const { fetchFn } = mockFetch([errBody(190, 463)]);
    const wa = new WhatsAppAdapter({ credentials: creds, fetchFn });
    try {
      await wa.send({ account: ACCOUNT, toExternalId: "1", text: "x", idempotencyKey: "k" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderAuthError);
      expect((e as ProviderAuthError).retryable).toBe(false);
      expect((e as ProviderAuthError).code).toBe("TOKEN_EXPIRED");
    }
  });
});

describe("whatsapp webhook parsing", () => {
  const wa = new WhatsAppAdapter({ credentials: creds, fetchFn: async () => new Response("{}") });

  test("inbound text message -> message.received", async () => {
    const events = await wa.parseWebhook({
      object: "whatsapp_business_account",
      entry: [{
        id: "waba-1",
        changes: [{
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { phone_number_id: "1234567890" },
            messages: [{ from: "62812", id: "wamid.IN1", timestamp: "1760000000", type: "text", text: { body: "Halo Botara" } }],
          },
        }],
      }],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message.received", channel: "whatsapp", accountExternalId: "1234567890",
      contactExternalId: "62812", messageExternalId: "wamid.IN1", text: "Halo Botara",
    });
  });

  test("statuses -> message.status with errors", async () => {
    const events = await wa.parseWebhook({
      entry: [{
        id: "waba-1",
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: "1234567890" },
            statuses: [{
              id: "wamid.OUT1", status: "failed", timestamp: "1760000100",
              errors: [{ code: 131047, title: "Re-engagement message", message: "x", error_data: { details: "outside window" } }],
            }],
          },
        }],
      }],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "message.status", status: "failed", messageExternalId: "wamid.OUT1" });
    const ev = events[0]!;
    if (ev.type === "message.status") {
      expect(ev.errors?.[0]).toMatchObject({ code: 131047, message: "outside window" });
    }
  });

  test("message_template_category_update -> template.category_changed (lowercased)", async () => {
    const events = await wa.parseWebhook({
      entry: [{
        id: "waba-1",
        changes: [{
          field: "message_template_category_update",
          value: {
            message_template_id: 987, message_template_name: "order_update",
            message_template_language: "id", previous_category: "UTILITY", new_category: "MARKETING",
          },
        }],
      }],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "template.category_changed", templateExternalId: "987",
      templateName: "order_update", language: "id",
      previousCategory: "utility", newCategory: "marketing",
    });
  });

  test("coexistence smb_message_echoes -> message.echo", async () => {
    const events = await wa.parseWebhook({
      entry: [{
        id: "waba-1",
        changes: [{
          field: "smb_message_echoes",
          value: {
            metadata: { phone_number_id: "1234567890" },
            message_echoes: [{ id: "wamid.ECHO1", to: "62812", from: "1234567890", timestamp: "1760000200", type: "text", text: { body: "dibalas dari HP" } }],
          },
        }],
      }],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message.echo", contactExternalId: "62812", messageExternalId: "wamid.ECHO1", text: "dibalas dari HP",
    });
  });
});

describe("whatsapp webhook security helpers", () => {
  test("signature verify accepts a valid HMAC and rejects tampering", () => {
    const raw = JSON.stringify({ entry: [] });
    const sig = "sha256=" + createHmac("sha256", "test-secret").update(raw).digest("hex");
    expect(verifyWebhookSignature(raw, sig, "test-secret")).toBe(true);
    expect(verifyWebhookSignature(raw + " ", sig, "test-secret")).toBe(false);
    expect(verifyWebhookSignature(raw, "sha256=deadbeef", "test-secret")).toBe(false);
    expect(verifyWebhookSignature(raw, null, "test-secret")).toBe(false);
    expect(verifyWebhookSignature(raw, sig, "")).toBe(false);
  });

  test("GET challenge echoes only on mode+token match", () => {
    expect(verifyWebhookChallenge({ mode: "subscribe", token: "vtok", challenge: "42" }, "vtok")).toBe("42");
    expect(verifyWebhookChallenge({ mode: "subscribe", token: "wrong", challenge: "42" }, "vtok")).toBeNull();
    expect(verifyWebhookChallenge({ mode: "subscribe", token: "vtok", challenge: "42" }, undefined)).toBeNull();
  });

  test("media upload posts multipart and returns the id", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { id: "media-77" } }]);
    const wa = new WhatsAppAdapter({ credentials: creds, fetchFn });
    const res = await wa.uploadMedia(ACCOUNT, { data: new Uint8Array([1, 2, 3]), mimeType: "image/png", filename: "a.png" });
    expect(res.mediaId).toBe("media-77");
    expect(calls[0]!.url).toEndWith("/v26.0/1234567890/media");
    expect(calls[0]!.init!.body).toBeInstanceOf(FormData);
  });
});
