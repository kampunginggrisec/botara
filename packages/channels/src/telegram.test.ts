import { describe, expect, test } from "bun:test";
import { StaticCredentialProvider } from "./credentials";
import { TelegramAdapter } from "./telegram";
import type { FetchLike } from "./types";

const ACCOUNT = { id: "acc-tg", externalId: "555000111", tokenVaultRef: "vault:tg-1" };
const creds = new StaticCredentialProvider({ botToken: "123456:TEST-TOKEN" });

function mockFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const queue = [...responses];
  const fetchFn: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    const next = queue.shift() ?? { body: { ok: true, result: true } };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchFn, calls };
}

describe("telegram adapter", () => {
  test("sendMessage posts text and returns the message id", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { ok: true, result: { message_id: 42 } } }]);
    const tg = new TelegramAdapter({ credentials: creds, fetchFn });
    const res = await tg.send({ account: ACCOUNT, toExternalId: "777", text: "Hai!", idempotencyKey: "k1" });
    expect(res).toEqual({ externalMessageId: "42", status: "sent" });
    expect(calls[0]!.url).toBe("https://api.telegram.org/bot123456:TEST-TOKEN/sendMessage");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ chat_id: "777", text: "Hai!" });
  });

  test("sendPhoto uses sendPhoto with the media link", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { ok: true, result: { message_id: 43 } } }]);
    const tg = new TelegramAdapter({ credentials: creds, fetchFn });
    await tg.send({
      account: ACCOUNT, toExternalId: "777", idempotencyKey: "k2",
      media: { type: "photo", link: "https://example.com/a.jpg", caption: "foto" },
    });
    expect(calls[0]!.url).toEndWith("/sendPhoto");
    expect(JSON.parse(calls[0]!.init!.body as string)).toMatchObject({ chat_id: "777", photo: "https://example.com/a.jpg", caption: "foto" });
  });

  test("telegram API error maps to a provider error", async () => {
    const { fetchFn } = mockFetch([{ status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } }]);
    const tg = new TelegramAdapter({ credentials: creds, fetchFn });
    await expect(tg.send({ account: ACCOUNT, toExternalId: "777", text: "x", idempotencyKey: "k" }))
      .rejects.toThrow("bot was blocked");
  });

  test("429 maps to a retryable rate limit error", async () => {
    const { fetchFn } = mockFetch([{ status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 5 } } }]);
    const tg = new TelegramAdapter({ credentials: creds, fetchFn });
    try {
      await tg.send({ account: ACCOUNT, toExternalId: "777", text: "x", idempotencyKey: "k" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("RATE_LIMITED");
      expect((e as { retryable?: boolean }).retryable).toBe(true);
    }
  });

  test("setWebhook registers the url + secret token", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { ok: true, result: true } }]);
    const tg = new TelegramAdapter({ credentials: creds, fetchFn });
    await tg.setWebhook(ACCOUNT, { url: "https://example.com/webhooks/telegram", secretToken: "s3cret" });
    expect(calls[0]!.url).toEndWith("/setWebhook");
    expect(JSON.parse(calls[0]!.init!.body as string)).toMatchObject({
      url: "https://example.com/webhooks/telegram", secret_token: "s3cret",
    });
  });

  test("parseWebhook: update.message -> message.received (chat id as contact)", async () => {
    const tg = new TelegramAdapter({ credentials: creds, fetchFn: async () => new Response("{}") });
    const events = await tg.parseWebhook({
      update_id: 9001,
      message: {
        message_id: 12, date: 1760000000, text: "halo dari telegram",
        chat: { id: 777, type: "private" }, from: { id: 777, first_name: "Romo" },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message.received", channel: "telegram", contactExternalId: "777",
      messageExternalId: "12", text: "halo dari telegram",
    });
  });

  test("parseWebhook: photo message carries the largest file_id", async () => {
    const tg = new TelegramAdapter({ credentials: creds, fetchFn: async () => new Response("{}") });
    const events = await tg.parseWebhook({
      update_id: 9002,
      message: {
        message_id: 13, date: 1760000000, caption: "lihat ini",
        chat: { id: 777, type: "private" },
        photo: [
          { file_id: "small", width: 90, height: 90 },
          { file_id: "large", width: 800, height: 800 },
        ],
      },
    });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    if (ev.type === "message.received") {
      expect(ev.media).toMatchObject({ type: "photo", id: "large" });
      expect(ev.text).toBe("lihat ini");
    }
  });

  test("parseWebhook: document message carries file_id, filename and mime type", async () => {
    const tg = new TelegramAdapter({ credentials: creds, fetchFn: async () => new Response("{}") });
    const events = await tg.parseWebhook({
      update_id: 9003,
      message: {
        message_id: 14, date: 1760000000, caption: "ini invoice-nya",
        chat: { id: 777, type: "private" },
        document: { file_id: "doc-1", file_name: "invoice.pdf", mime_type: "application/pdf" },
      },
    });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    if (ev.type === "message.received") {
      expect(ev.media).toMatchObject({ type: "document", id: "doc-1", filename: "invoice.pdf", mimeType: "application/pdf" });
      expect(ev.text).toBe("ini invoice-nya");
    }
  });

  test("parseWebhook: voice note normalizes to audio media", async () => {
    const tg = new TelegramAdapter({ credentials: creds, fetchFn: async () => new Response("{}") });
    const events = await tg.parseWebhook({
      update_id: 9004,
      message: {
        message_id: 15, date: 1760000000,
        chat: { id: 777, type: "private" },
        voice: { file_id: "voice-1", mime_type: "audio/ogg" },
      },
    });
    const ev = events[0]!;
    if (ev.type === "message.received") {
      expect(ev.media).toMatchObject({ type: "audio", id: "voice-1", mimeType: "audio/ogg" });
    }
  });

  test("downloadFile resolves getFile then downloads the file bytes", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn: FetchLike = async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/getFile")) {
        return new Response(JSON.stringify({
          ok: true, result: { file_id: "doc-1", file_path: "documents/file_1.pdf", file_size: 4 },
        }), { headers: { "Content-Type": "application/json" } });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    };
    const tg = new TelegramAdapter({ credentials: creds, fetchFn });
    const res = await tg.downloadFile(ACCOUNT, "doc-1");
    expect(res.fileSize).toBe(4);
    expect(new Uint8Array(res.data)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(calls[0]!.url).toBe("https://api.telegram.org/bot123456:TEST-TOKEN/getFile");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ file_id: "doc-1" });
    expect(calls[1]!.url).toBe("https://api.telegram.org/file/bot123456:TEST-TOKEN/documents/file_1.pdf");
  });

  test("downloadFile throws when getFile yields no file_path", async () => {
    const { fetchFn } = mockFetch([{ body: { ok: true, result: { file_id: "gone" } } }]);
    const tg = new TelegramAdapter({ credentials: creds, fetchFn });
    await expect(tg.downloadFile(ACCOUNT, "gone")).rejects.toThrow("no file_path");
  });

  test("parseWebhook ignores non-message updates", async () => {
    const tg = new TelegramAdapter({ credentials: creds, fetchFn: async () => new Response("{}") });
    expect(await tg.parseWebhook({ update_id: 1, callback_query: { id: "x" } })).toEqual([]);
  });
});
