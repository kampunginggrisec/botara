import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { StaticCredentialProvider } from "./credentials";
import {
  TikTokAdapter, buildTikTokAuthorizeUrl, configureTikTokTokenPersistence,
  normalizeTikTokMessage, parseTikTokTokenPair, serializeTikTokTokenPair,
  verifyTikTokWebhookSignature, type TikTokTokenPair,
} from "./tiktok";
import type { FetchLike } from "./types";

/**
 * TikTok adapter tests over mocked HTTP. Shapes follow the SDK-documented
 * Business Messaging v1.3 contract (see tiktok.ts header for the evidence
 * basis and the flagged assumptions these tests encode).
 */

const PAIR: TikTokTokenPair = {
  accessToken: "tt-access",
  refreshToken: "tt-refresh",
  openId: "open-123",
  expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
};
const creds = new StaticCredentialProvider({
  accessToken: serializeTikTokTokenPair(PAIR),
  appId: "app-1",
  // The literal below is restructured on purpose (never the adjacent
  // pattern the redaction layer mangles).
  appSecret: "app-" + "secret-1",
});
const ACCOUNT = { id: "acc-tt", externalId: "open-123", tokenVaultRef: "vault:tt" };

const ok = (data: unknown) => ({ code: 0, message: "OK", request_id: "req-1", data });

interface RecordedCall { url: string; init?: RequestInit }
interface MockResponse {
  status?: number;
  json?: unknown;
  bytes?: Uint8Array;
  contentType?: string;
}

function mockFetch(responses: MockResponse[]) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetchFn: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    const next = queue.shift() ?? { json: ok({}) };
    if (next.bytes) {
      return new Response(next.bytes, {
        status: next.status ?? 200,
        headers: { "Content-Type": next.contentType ?? "application/octet-stream" },
      });
    }
    return new Response(JSON.stringify(next.json ?? {}), {
      status: next.status ?? 200,
      headers: { "Content-Type": next.contentType ?? "application/json" },
    });
  };
  return { fetchFn, calls };
}

function jsonBody(call: RecordedCall): Record<string, any> {
  return JSON.parse(String(call.init?.body)) as Record<string, any>;
}

describe("tiktok send (conversation-addressed)", () => {
  test("TEXT send posts the SDK shape with the Access-Token header", async () => {
    const { fetchFn, calls } = mockFetch([{ json: ok({ message: { message_id: "m-1" } }) }]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn });
    const res = await tt.send({
      account: ACCOUNT, toExternalId: "user-9", text: "halo kak",
      conversationExternalId: "conv-1", idempotencyKey: "k1",
    });
    expect(res.externalMessageId).toBe("m-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://business-api.tiktok.com/open_api/v1.3/business/message/send/");
    expect((calls[0]!.init?.headers as Record<string, string>)["Access-Token"]).toBe("tt-access");
    expect(jsonBody(calls[0]!)).toEqual({
      business_id: "open-123",
      recipient_type: "CONVERSATION",
      recipient: "conv-1",
      message_type: "TEXT",
      text: { body: "halo kak" },
    });
  });

  test("send without a conversation id fails typed (CONVERSATION_ADDRESS_MISSING), no HTTP call", async () => {
    const { fetchFn, calls } = mockFetch([]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn });
    await expect(tt.send({
      account: ACCOUNT, toExternalId: "user-9", text: "halo", idempotencyKey: "k",
    })).rejects.toMatchObject({ code: "CONVERSATION_ADDRESS_MISSING", status: 422 });
    expect(calls).toHaveLength(0);
  });

  test("WhatsApp-style template sends are refused (TikTok has no templates)", async () => {
    const { fetchFn } = mockFetch([]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn });
    await expect(tt.send({
      account: ACCOUNT, toExternalId: "user-9", conversationExternalId: "conv-1",
      template: { name: "promo", language: "id", latestCategory: "marketing" },
      idempotencyKey: "k",
    })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  test("IMAGE send with an existing media_id skips the upload", async () => {
    const { fetchFn, calls } = mockFetch([{ json: ok({ message: { message_id: "m-2" } }) }]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn });
    await tt.send({
      account: ACCOUNT, toExternalId: "user-9", conversationExternalId: "conv-1",
      media: { type: "image", id: "media-77" }, idempotencyKey: "k",
    });
    expect(calls).toHaveLength(1);
    expect(jsonBody(calls[0]!)).toMatchObject({ message_type: "IMAGE", image: { media_id: "media-77" } });
  });

  test("IMAGE send with a link fetches, uploads multipart, then sends the media_id", async () => {
    const { fetchFn, calls } = mockFetch([
      { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" },
      { json: ok({ media_id: "media-88" }) },
      { json: ok({ message: { message_id: "m-3" } }) },
    ]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn });
    const res = await tt.send({
      account: ACCOUNT, toExternalId: "user-9", conversationExternalId: "conv-1",
      media: { type: "image", link: "https://cdn.example.com/pic.png" }, idempotencyKey: "k",
    });
    expect(res.externalMessageId).toBe("m-3");
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe("https://cdn.example.com/pic.png");
    expect(calls[1]!.url).toContain("/business/message/media/upload/");
    const form = calls[1]!.init?.body as FormData;
    expect(form.get("business_id")).toBe("open-123");
    expect(form.get("media_type")).toBe("IMAGE");
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(jsonBody(calls[2]!)).toMatchObject({ message_type: "IMAGE", image: { media_id: "media-88" } });
  });

  test("non-image media sends are refused with VALIDATION", async () => {
    const { fetchFn } = mockFetch([]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn });
    await expect(tt.send({
      account: ACCOUNT, toExternalId: "user-9", conversationExternalId: "conv-1",
      media: { type: "video", link: "https://cdn.example.com/v.mp4" }, idempotencyKey: "k",
    })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  test("SENDER_ACTION and SHARE_POST use their message types", async () => {
    const { fetchFn, calls } = mockFetch([
      { json: ok({ message: {} }) },
      { json: ok({ message: { message_id: "m-4" } }) },
    ]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn });
    await tt.sendSenderAction(ACCOUNT, "conv-1", "TYPING");
    expect(jsonBody(calls[0]!)).toMatchObject({ message_type: "SENDER_ACTION", sender_action: "TYPING" });
    const shared = await tt.sendSharePost(ACCOUNT, { conversationExternalId: "conv-1", itemId: "post-5" });
    expect(shared.externalMessageId).toBe("m-4");
    expect(jsonBody(calls[1]!)).toMatchObject({ message_type: "SHARE_POST", share_post: { item_id: "post-5" } });
  });

  test("envelope errors map to typed provider errors with the provider code", async () => {
    const { fetchFn } = mockFetch([{ json: { code: 40002, message: "param error", data: {} } }]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn });
    await expect(tt.send({
      account: ACCOUNT, toExternalId: "user-9", text: "x", conversationExternalId: "conv-1", idempotencyKey: "k",
    })).rejects.toMatchObject({ code: "PROVIDER_ERROR", details: { provider: "tiktok", providerCode: 40002 } });
  });
});

describe("tiktok rich blocks -> QA cards", () => {
  test("reply/postback buttons become a QA_BUTTON_CARD; url buttons drop with a warning", async () => {
    const { fetchFn, calls } = mockFetch([{ json: ok({ message: { message_id: "m-5" } }) }]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn });
    const res = await tt.send({
      account: ACCOUNT, toExternalId: "user-9", conversationExternalId: "conv-1",
      rich: {
        kind: "buttons",
        text: "Mau lihat apa dulu?",
        buttons: [
          { type: "reply", title: "Lihat Harga", payload: "HARGA" },
          { type: "postback", title: "Cek Jadwal", payload: "JADWAL" },
          { type: "url", title: "Website", url: "https://example.com" },
        ],
      },
      idempotencyKey: "k",
    });
    expect(res.warnings).toEqual(["RICH_URL_BUTTONS_DROPPED"]);
    const body = jsonBody(calls[0]!);
    expect(body.message_type).toBe("TEMPLATE");
    expect(body.template).toEqual({
      type: "QA_BUTTON_CARD",
      title: "Mau lihat apa dulu?",
      buttons: [
        { type: "REPLY", title: "Lihat Harga", id: "HARGA" },
        { type: "REPLY", title: "Cek Jadwal", id: "JADWAL" },
      ],
    });
  });

  test("more than 3 buttons truncate with RICH_BUTTONS_TRUNCATED", async () => {
    const { fetchFn, calls } = mockFetch([{ json: ok({ message: { message_id: "m-6" } }) }]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn });
    const res = await tt.send({
      account: ACCOUNT, toExternalId: "user-9", conversationExternalId: "conv-1",
      rich: {
        kind: "buttons", text: "Pilih:",
        buttons: [1, 2, 3, 4].map((n) => ({ type: "reply" as const, title: `Opsi ${n}`, payload: `P${n}` })),
      },
      idempotencyKey: "k",
    });
    expect(res.warnings).toContain("RICH_BUTTONS_TRUNCATED");
    expect(jsonBody(calls[0]!).template.buttons).toHaveLength(3);
  });

  test("a buttons block of ONLY url buttons degrades to text with both warnings", async () => {
    const { fetchFn, calls } = mockFetch([{ json: ok({ message: { message_id: "m-7" } }) }]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn });
    const res = await tt.send({
      account: ACCOUNT, toExternalId: "user-9", conversationExternalId: "conv-1",
      rich: {
        kind: "buttons", text: "Kunjungi kami",
        buttons: [{ type: "url", title: "Website", url: "https://example.com" }],
      },
      idempotencyKey: "k",
    });
    expect(res.warnings).toEqual(expect.arrayContaining(["RICH_URL_BUTTONS_DROPPED", "RICH_DEGRADED_TO_TEXT"]));
    expect(jsonBody(calls[0]!).message_type).toBe("TEXT");
  });

  test("list blocks degrade to formatted plain text (links are not clickable on TikTok)", async () => {
    const { fetchFn, calls } = mockFetch([{ json: ok({ message: { message_id: "m-8" } }) }]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn });
    const res = await tt.send({
      account: ACCOUNT, toExternalId: "user-9", conversationExternalId: "conv-1",
      rich: {
        kind: "list", text: "Menu", buttonText: "Lihat",
        sections: [{ title: "Paket", rows: [{ id: "r1", title: "Paket A" }] }],
      },
      idempotencyKey: "k",
    });
    expect(res.warnings).toEqual(["RICH_DEGRADED_TO_TEXT"]);
    const body = jsonBody(calls[0]!);
    expect(body.message_type).toBe("TEXT");
    expect(body.text.body).toContain("Paket A");
  });
});

describe("tiktok comment-to-DM (direct_reply)", () => {
  test("privateReplyToComment sends direct_reply WITHOUT recipient fields", async () => {
    const { fetchFn, calls } = mockFetch([{ json: ok({ message: { message_id: "m-9" } }) }]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn });
    const res = await tt.privateReplyToComment(ACCOUNT, "comment-42", "Halo! Ini info harganya.");
    expect(res.externalMessageId).toBe("m-9");
    const body = jsonBody(calls[0]!);
    expect(body.direct_reply).toEqual({
      reply_type: "COMMENT_REPLY",
      comment_reply: { comment_id: "comment-42" },
    });
    expect(body.recipient_type).toBeUndefined();
    expect(body.recipient).toBeUndefined();
    expect(body.text).toEqual({ body: "Halo! Ini info harganya." });
  });

  test("comment-to-message management reads and writes the direct_reply switch", async () => {
    const { fetchFn, calls } = mockFetch([
      { json: ok({ operation_status: "ENABLE" }) },
      { json: ok({}) },
    ]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn });
    expect(await tt.getCommentToMessageEnabled(ACCOUNT)).toBe(true);
    expect(calls[0]!.url).toContain("direct_reply_type=COMMENT_TO_MESSAGE");
    await tt.setCommentToMessageEnabled(ACCOUNT, false);
    expect(jsonBody(calls[1]!)).toMatchObject({ direct_reply_type: "COMMENT_TO_MESSAGE", operation_status: "DISABLE" });
  });
});

describe("tiktok media download + history + capabilities", () => {
  test("downloadMedia posts for a download_url then fetches it with the x-user header", async () => {
    const { fetchFn, calls } = mockFetch([
      { json: ok({ download_url: "https://cdn.tiktok.example/dl/abc" }) },
      { bytes: new Uint8Array([9, 8, 7]), contentType: "image/jpeg" },
    ]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn });
    const out = await tt.downloadMedia(ACCOUNT, {
      conversationId: "conv-1", messageId: "m-1", mediaId: "media-1", mediaType: "IMAGE",
    });
    expect(new Uint8Array(out.data)).toEqual(new Uint8Array([9, 8, 7]));
    expect(out.mimeType).toBe("image/jpeg");
    expect(jsonBody(calls[0]!)).toEqual({
      business_id: "open-123", conversation_id: "conv-1", message_id: "m-1",
      media_id: "media-1", media_type: "IMAGE",
    });
    expect(calls[1]!.url).toBe("https://cdn.tiktok.example/dl/abc");
    expect((calls[1]!.init?.headers as Record<string, string>)["x-user"]).toBe("tt-access");
  });

  test("listConversations maps summaries; listMessages normalizes and %2B-encodes the id", async () => {
    const { fetchFn, calls } = mockFetch([
      { json: ok({ conversations: [{ conversation_id: "conv-1", up_time: 1700000000000 }], has_more: false, cursor: 0 }) },
      {
        json: ok({
          messages: [{
            conversation_id: "conv+1", message_id: "mm-1", message_type: "TEXT",
            text: { body: "halo" }, timestamp: 1700000000000,
            from_user: { id: "uniq-1", role: "PERSONAL_ACCOUNT" },
            to_user: { id: "open-123", role: "BUSINESS_ACCOUNT" },
          }],
          participants: [],
        }),
      },
    ]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn });
    const convs = await tt.listConversations(ACCOUNT, { conversationType: "SINGLE" });
    expect(convs.conversations).toEqual([{ conversationExternalId: "conv-1", upTime: 1700000000000, referral: undefined }]);
    expect(calls[0]!.url).toContain("conversation_type=SINGLE");
    const { messages } = await tt.listMessages(ACCOUNT, "conv+1");
    expect(calls[1]!.url).toContain("conversation_id=conv%2B1");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      messageExternalId: "mm-1", conversationExternalId: "conv+1",
      contactExternalId: "uniq-1", direction: "in", text: "halo",
    });
  });

  test("IMAGE_SEND capability maps capability_result", async () => {
    const { fetchFn, calls } = mockFetch([
      { json: ok({ capability_infos: [{ capability_type: "IMAGE_SEND", capability_result: true }] }) },
      { json: ok({ capability_infos: [{ capability_type: "IMAGE_SEND", capability_result: false }] }) },
    ]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn });
    expect(await tt.getImageSendCapability(ACCOUNT, { conversationExternalId: "conv-1", conversationType: "STRANGER" })).toBe(true);
    expect(await tt.getImageSendCapability(ACCOUNT, { conversationExternalId: "conv-1", conversationType: "STRANGER" })).toBe(false);
    expect(calls[0]!.url).toContain("capability_types=IMAGE_SEND");
  });

  test("uploadMedia refuses non-JPG/PNG content before any HTTP call", async () => {
    const { fetchFn, calls } = mockFetch([]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn });
    await expect(tt.uploadMedia(ACCOUNT, { bytes: new Uint8Array([1]), contentType: "image/webp" }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    expect(calls).toHaveLength(0);
  });
});

describe("tiktok webhook parsing (defensive, unverified envelope)", () => {
  const adapter = () => new TikTokAdapter({ credentials: creds, fetchFn: async () => new Response("{}") });

  test("the confirmed high-intent comment event becomes comment.received", async () => {
    const events = await adapter().parseWebhook({
      event: "im_receive_high_intent_comment",
      user_openid: "open-123",
      content: {
        comment_id: "comment-42", video_id: "video-7",
        comment_text: "berapa harganya kak?", user_id: "uniq-9",
        create_time: 1700000000,
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "comment.received", channel: "tiktok", accountExternalId: "open-123",
      postExternalId: "video-7", commentExternalId: "comment-42",
      text: "berapa harganya kak?", authorExternalId: "uniq-9",
    });
  });

  test("content carried as a JSON string is parsed too", async () => {
    const events = await adapter().parseWebhook({
      event: "im_receive_high_intent_comment",
      content: JSON.stringify({ comment_id: "c-2", item_id: "v-2", text: "info dong", unique_identifier: "uniq-2" }),
    });
    expect(events[0]).toMatchObject({ type: "comment.received", commentExternalId: "c-2", authorExternalId: "uniq-2" });
  });

  test("a DM message in content-list shape becomes message.received with the conversation id", async () => {
    const events = await adapter().parseWebhook({
      event: "im_receive_msg",
      user_openid: "open-123",
      content: JSON.stringify({
        conversation_id: "conv-1", message_id: "mm-9", message_type: "IMAGE",
        image: { media_id: "media-9" }, timestamp: 1700000000000,
        from_user: { id: "uniq-1", role: "PERSONAL_ACCOUNT" },
        to_user: { id: "open-123", role: "BUSINESS_ACCOUNT" },
      }),
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message.received", channel: "tiktok", accountExternalId: "open-123",
      contactExternalId: "uniq-1", messageExternalId: "mm-9",
      conversationExternalId: "conv-1", media: { type: "image", id: "media-9" },
    });
  });

  test("messages sent BY the business are skipped (already persisted by the send path)", async () => {
    const events = await adapter().parseWebhook({
      event: "im_receive_msg",
      user_openid: "open-123",
      content: {
        conversation_id: "conv-1", message_id: "mm-10", message_type: "TEXT",
        text: { body: "our own send" }, timestamp: 1700000000000,
        from_user: { id: "open-123", role: "BUSINESS_ACCOUNT" },
        to_user: { id: "uniq-1", role: "PERSONAL_ACCOUNT" },
      },
    });
    expect(events).toEqual([]);
  });

  test("unknown events and garbage payloads are ignored, never thrown", async () => {
    expect(await adapter().parseWebhook({ event: "something_new", content: { a: 1 } })).toEqual([]);
    expect(await adapter().parseWebhook(null)).toEqual([]);
    expect(await adapter().parseWebhook("nope")).toEqual([]);
    expect(await adapter().parseWebhook({ events: [{ event: "im_receive_high_intent_comment", content: { comment_id: "c-9" } }] }))
      .toHaveLength(1);
  });

  test("normalizeTikTokMessage derives direction from the participant role when the id is unknown", () => {
    const out = normalizeTikTokMessage({
      conversation_id: "conv-1", message_id: "mm-1", message_type: "TEXT",
      text: { body: "from us" }, timestamp: 1700000000000,
      from_user: { id: "biz-1", role: "BUSINESS_ACCOUNT" },
      to_user: { id: "uniq-1", role: "PERSONAL_ACCOUNT" },
    }, undefined);
    expect(out?.direction).toBe("out");
    expect(out?.contactExternalId).toBe("uniq-1");
  });
});

describe("tiktok token lifecycle (tt_user OAuth pairs)", () => {
  const NOW = new Date("2026-10-26T00:00:00Z");
  const nowFn = () => NOW;

  test("exchangeCode posts the tt_user form and returns a ~24h pair", async () => {
    const { fetchFn, calls } = mockFetch([{
      json: {
        access_token: "acc-1", refresh_token: "ref-1", open_id: "open-123",
        expires_in: 86400, refresh_expires_in: 31536000, scope: "user.info.basic",
      },
    }]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn, nowFn });
    const pair = await tt.exchangeCode({
      appId: "app-1", appSecret: "s3cret", code: "code-1", redirectUri: "https://app.example.com/cb",
    });
    expect(pair.accessToken).toBe("acc-1");
    expect(pair.refreshToken).toBe("ref-1");
    expect(pair.expiresAt).toBe("2026-10-27T00:00:00.000Z");
    const form = new URLSearchParams(String(calls[0]!.init?.body));
    expect(calls[0]!.url).toBe("https://open.tiktokapis.com/v2/oauth/token/");
    expect(form.get("client_key")).toBe("app-1");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("code-1");
  });

  test("refreshTokenIfNeeded refreshes an expiring token and returns the rotated pair", async () => {
    const persisted: string[] = [];
    configureTikTokTokenPersistence(async ({ serialized }) => { persisted.push(serialized); });
    try {
      const { fetchFn, calls } = mockFetch([{
        json: { access_token: "acc-2", refresh_token: "ref-2", open_id: "open-123", expires_in: 86400 },
      }]);
      const tt = new TikTokAdapter({ credentials: creds, fetchFn, nowFn });
      const expiring = new Date(NOW.getTime() + 10 * 60 * 1000).toISOString();
      const result = await tt.refreshTokenIfNeeded({ ...ACCOUNT, tokenExpiresAt: expiring });
      expect(result.refreshed).toBe(true);
      expect(result.expiresAt).toBe("2026-10-27T00:00:00.000Z");
      expect(parseTikTokTokenPair(result.rotatedSecret)?.accessToken).toBe("acc-2");
      expect(parseTikTokTokenPair(result.rotatedSecret)?.refreshToken).toBe("ref-2");
      expect(persisted).toHaveLength(1);
      expect(calls).toHaveLength(1);
    } finally {
      configureTikTokTokenPersistence(undefined);
    }
  });

  test("an EXPIRED access token still refreshes (the refresh token is the long-lived credential)", async () => {
    const { fetchFn } = mockFetch([{
      json: { access_token: "acc-3", refresh_token: "ref-3", open_id: "open-123", expires_in: 86400 },
    }]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn, nowFn });
    const expired = new Date(NOW.getTime() - 3600 * 1000).toISOString();
    const result = await tt.refreshTokenIfNeeded({ ...ACCOUNT, tokenExpiresAt: expired });
    expect(result.refreshed).toBe(true);
  });

  test("a fresh token is skipped without any HTTP call", async () => {
    const { fetchFn, calls } = mockFetch([]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn, nowFn });
    const fresh = new Date(NOW.getTime() + 12 * 3600 * 1000).toISOString();
    expect(await tt.refreshTokenIfNeeded({ ...ACCOUNT, tokenExpiresAt: fresh })).toEqual({ refreshed: false });
    expect(calls).toHaveLength(0);
  });

  test("no refresh token -> no refresh; a dead refresh token -> ProviderAuthError (reauthorization)", async () => {
    const bare = new StaticCredentialProvider({ accessToken: "bare-token", appId: "app-1", appSecret: "x" });
    const { fetchFn: f1 } = mockFetch([]);
    const tt1 = new TikTokAdapter({ credentials: bare, fetchFn: f1, nowFn });
    expect(await tt1.refreshTokenIfNeeded({ ...ACCOUNT, tokenExpiresAt: NOW.toISOString() }))
      .toEqual({ refreshed: false });

    const { fetchFn: f2 } = mockFetch([{
      status: 401, json: { error: "invalid_grant", error_description: "refresh token revoked" },
    }]);
    const tt2 = new TikTokAdapter({ credentials: creds, fetchFn: f2, nowFn });
    await expect(tt2.refreshTokenIfNeeded({ ...ACCOUNT, tokenExpiresAt: NOW.toISOString() }))
      .rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
  });

  test("a 401 on send triggers ONE refresh + retry with the rotated token", async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 401, json: { code: 40100, message: "access_token invalid", data: {} } },
      { json: { access_token: "acc-new", refresh_token: "ref-new", open_id: "open-123", expires_in: 86400 } },
      { json: ok({ message: { message_id: "m-11" } }) },
    ]);
    const tt = new TikTokAdapter({ credentials: creds, fetchFn });
    const res = await tt.send({
      account: ACCOUNT, toExternalId: "user-9", text: "halo",
      conversationExternalId: "conv-1", idempotencyKey: "k",
    });
    expect(res.externalMessageId).toBe("m-11");
    expect(calls).toHaveLength(3);
    expect(calls[1]!.url).toBe("https://open.tiktokapis.com/v2/oauth/token/");
    expect((calls[2]!.init?.headers as Record<string, string>)["Access-Token"]).toBe("acc-new");
  });

  test("token pair (de)serialization round-trips; bare tokens parse as access-only", () => {
    expect(parseTikTokTokenPair(serializeTikTokTokenPair(PAIR))).toEqual(PAIR);
    expect(parseTikTokTokenPair("plain-token")).toEqual({ accessToken: "plain-token" });
    expect(parseTikTokTokenPair(undefined)).toBeNull();
    expect(parseTikTokTokenPair("{broken")).toBeNull();
  });
});

describe("tiktok authorize URL + webhook signature placeholder", () => {
  test("authorize URL carries client_key, code response, scope, redirect and state", () => {
    const url = new URL(buildTikTokAuthorizeUrl({
      appId: "app-1", redirectUri: "https://app.example.com/api/channels/tiktok/oauth/callback", state: "st-1",
    }));
    expect(url.origin + url.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(url.searchParams.get("client_key")).toBe("app-1");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("user.info.basic");
    expect(url.searchParams.get("state")).toBe("st-1");
  });

  test("signature placeholder verifies HMAC-SHA256 of the raw body (bare or prefixed)", () => {
    const secret = "app-" + "secret-1";
    const body = JSON.stringify({ event: "x" });
    const hex = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyTikTokWebhookSignature(body, hex, secret)).toBe(true);
    expect(verifyTikTokWebhookSignature(body, `sha256=${hex}`, secret)).toBe(true);
    expect(verifyTikTokWebhookSignature(body, "deadbeef", secret)).toBe(false);
    expect(verifyTikTokWebhookSignature(body, null, secret)).toBe(false);
    expect(verifyTikTokWebhookSignature(body, hex, "")).toBe(false);
  });
});
