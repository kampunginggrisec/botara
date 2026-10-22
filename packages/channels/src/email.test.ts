import { describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { StaticCredentialProvider } from "./credentials";
import { EmailAdapter, verifyResendWebhookSignature } from "./email";
import type { FetchLike } from "./types";

const RESEND_KEY = "re_test_key";
const creds = new StaticCredentialProvider({ accessToken: RESEND_KEY });
const ACCOUNT = { id: "a1", externalId: "halo@example.com", tokenVaultRef: "env:RESEND_API_KEY" };

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

describe("resend email sending", () => {
  test("POSTs to /emails and ALWAYS sends the Idempotency-Key header", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { id: "email-1" } }]);
    const email = new EmailAdapter({ credentials: creds, fetchFn });
    const res = await email.send({
      account: ACCOUNT, toExternalId: "user@mail.com", text: "Halo!\nBaris kedua",
      subject: "Sapaan", idempotencyKey: "send:abc",
    });
    expect(res.externalMessageId).toBe("email-1");
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("send:abc");
    expect(headers.Authorization).toBe(`Bearer ${RESEND_KEY}`);
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body).toMatchObject({ from: "halo@example.com", to: ["user@mail.com"], subject: "Sapaan" });
    expect(body.text).toContain("Baris kedua");
  });

  test("missing From configuration is a CONFIGURATION error, not a silent send", async () => {
    const { fetchFn, calls } = mockFetch([]);
    const email = new EmailAdapter({ credentials: creds, fetchFn });
    await expect(email.send({
      account: { id: "a", externalId: "not-an-email" }, toExternalId: "u@m.com", text: "x", idempotencyKey: "k",
    })).rejects.toMatchObject({ code: "CONFIGURATION" });
    expect(calls).toHaveLength(0);
  });
});

describe("resend inbound", () => {
  test("email.received webhook parses to message.received with attachment descriptors (metadata only)", async () => {
    const email = new EmailAdapter({ credentials: creds, fetchFn: async () => new Response("{}") });
    const events = await email.parseWebhook({
      type: "email.received",
      created_at: "2026-10-22T00:00:00Z",
      data: {
        email_id: "in-1", from: "pelanggan@mail.com", to: ["halo@example.com"],
        subject: "Tanya harga",
        attachments: [{ id: "att-1", filename: "brosur.pdf", content_type: "application/pdf", size: 1234 }],
      },
    });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe("message.received");
    if (ev.type === "message.received") {
      expect(ev.contactExternalId).toBe("pelanggan@mail.com");
      expect(ev.messageExternalId).toBe("in-1");
      expect(ev.subject).toBe("Tanya harga");
      expect(ev.attachments).toEqual([{ id: "att-1", filename: "brosur.pdf", contentType: "application/pdf", size: 1234 }]);
      // Metadata only in the webhook: no body text is (or can be) present.
      expect(ev.text).toBeUndefined();
    }
  });

  test("fetchInboundEmail fetches body from the Receiving API and attachments with download URLs", async () => {
    const { fetchFn, calls } = mockFetch([
      { body: { id: "in-1", from: "a@b.c", to: ["halo@example.com"], subject: "Hai", text: "isi email", html: "<p>isi</p>", headers: { "x-a": "1" } } },
      { body: { data: [{ id: "att-1", filename: "f.pdf", content_type: "application/pdf", size: 10, download_url: "https://download.example.com/f.pdf" }] } },
    ]);
    const email = new EmailAdapter({ credentials: creds, fetchFn });
    const full = await email.fetchInboundEmail(ACCOUNT, "in-1");
    expect(calls[0]!.url).toBe("https://api.resend.com/emails/receiving/in-1");
    expect(calls[1]!.url).toBe("https://api.resend.com/emails/receiving/in-1/attachments");
    expect(full.text).toBe("isi email");
    expect(full.attachments).toEqual([{
      id: "att-1", filename: "f.pdf", contentType: "application/pdf", size: 10,
      downloadUrl: "https://download.example.com/f.pdf",
    }]);
  });

  test("delivery webhooks map to message.status", async () => {
    const email = new EmailAdapter({ credentials: creds, fetchFn: async () => new Response("{}") });
    const delivered = await email.parseWebhook({ type: "email.delivered", data: { email_id: "e-1" } });
    const bounced = await email.parseWebhook({ type: "email.bounced", data: { email_id: "e-2" } });
    expect(delivered[0]).toMatchObject({ type: "message.status", status: "delivered", messageExternalId: "e-1" });
    expect(bounced[0]).toMatchObject({ type: "message.status", status: "failed", messageExternalId: "e-2" });
  });
});

describe("resend (svix) webhook signature", () => {
  const keyBytes = randomBytes(32);
  const secret = `whsec_${keyBytes.toString("base64")}`;
  const now = new Date("2026-10-22T00:00:00Z");
  const ts = String(Math.floor(now.getTime() / 1000));

  function sign(id: string, timestamp: string, body: string): string {
    const sig = createHmac("sha256", keyBytes).update(`${id}.${timestamp}.${body}`).digest("base64");
    return `v1,${sig}`;
  }

  test("accepts a correctly signed payload", () => {
    const body = JSON.stringify({ type: "email.received", data: {} });
    expect(verifyResendWebhookSignature({
      rawBody: body, svixId: "msg_1", svixTimestamp: ts, svixSignature: sign("msg_1", ts, body),
      secret, now,
    })).toBe(true);
  });

  test("rejects a tampered body, a stale timestamp, and missing headers", () => {
    const body = JSON.stringify({ type: "email.received", data: {} });
    const sig = sign("msg_1", ts, body);
    expect(verifyResendWebhookSignature({
      rawBody: body + " ", svixId: "msg_1", svixTimestamp: ts, svixSignature: sig, secret, now,
    })).toBe(false);
    const stale = String(Math.floor(now.getTime() / 1000) - 3600);
    expect(verifyResendWebhookSignature({
      rawBody: body, svixId: "msg_1", svixTimestamp: stale, svixSignature: sign("msg_1", stale, body),
      secret, now,
    })).toBe(false);
    expect(verifyResendWebhookSignature({
      rawBody: body, svixId: null, svixTimestamp: ts, svixSignature: sig, secret, now,
    })).toBe(false);
  });
});
