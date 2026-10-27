import { describe, expect, test } from "bun:test";
import { StaticCredentialProvider } from "./credentials";
import { MessengerAdapter } from "./messenger";
import type { FetchLike } from "./types";

const PAGE_TOKEN = "page-token";
const creds = new StaticCredentialProvider({ accessToken: PAGE_TOKEN });
const PAGE = { id: "a1", externalId: "page-1", tokenVaultRef: "vault:page" };

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

describe("messenger send api", () => {
  test("sends text via me/messages on the pinned Graph version", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { recipient_id: "psid-1", message_id: "mid.1" } }]);
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn });
    const res = await msgr.send({ account: PAGE, toExternalId: "psid-1", text: "halo", idempotencyKey: "k" });
    expect(res.externalMessageId).toBe("mid.1");
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v26.0/me/messages");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      recipient: { id: "psid-1" }, messaging_type: "RESPONSE", message: { text: "halo" },
    });
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${PAGE_TOKEN}`);
  });

  test("Graph 190 maps to a non-retryable auth error", async () => {
    const { fetchFn } = mockFetch([{
      status: 401,
      body: { error: { message: "Invalid OAuth access token", code: 190, fbtrace_id: "trace-1" } },
    }]);
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn });
    await expect(msgr.send({ account: PAGE, toExternalId: "x", text: "hi", idempotencyKey: "k" }))
      .rejects.toMatchObject({ code: "TOKEN_EXPIRED", retryable: false, fbtraceId: "trace-1" });
  });
});

describe("messenger handover + profile setup", () => {
  test("pass/take thread control hit the handover endpoints", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { success: true } }, { body: { success: true } }]);
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn });
    await msgr.passThreadControl(PAGE, "psid-1", { targetAppId: 263902037430900, metadata: "human please" });
    await msgr.takeThreadControl(PAGE, "psid-1");
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v26.0/me/pass_thread_control");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      recipient: { id: "psid-1" }, target_app_id: 263902037430900, metadata: "human please",
    });
    expect(calls[1]!.url).toBe("https://graph.facebook.com/v26.0/me/take_thread_control");
  });

  test("get started + persistent menu post to messenger_profile", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { result: "success" } }, { body: { result: "success" } }]);
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn });
    await msgr.setGetStarted(PAGE, "GET_STARTED");
    await msgr.setPersistentMenu(PAGE, [{ type: "postback", title: "Mulai", payload: "START" }]);
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ get_started: { payload: "GET_STARTED" } });
    const menu = JSON.parse(calls[1]!.init!.body as string);
    expect(menu.persistent_menu[0].call_to_actions[0]).toMatchObject({ title: "Mulai", payload: "START" });
  });

  test("publish posts to the page feed", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { id: "page-1_post-9" } }]);
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn });
    const res = await msgr.publish({ account: PAGE, text: "promo", idempotencyKey: "k" });
    expect(res.externalPostId).toBe("page-1_post-9");
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v26.0/page-1/feed");
  });
});

describe("messenger webhooks", () => {
  test("parses messages, postbacks and referrals", async () => {
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn: async () => new Response("{}") });
    const events = await msgr.parseWebhook({
      object: "page",
      entry: [{
        id: "page-1",
        messaging: [
          { sender: { id: "psid-1" }, timestamp: 1700000000000, message: { mid: "mid-1", text: "hai" } },
          { sender: { id: "psid-1" }, timestamp: 1700000001000, postback: { title: "Mulai", payload: "GET_STARTED" } },
          { sender: { id: "psid-2" }, timestamp: 1700000002000, referral: { ref: "promo-ads", source: "ADS" } },
        ],
      }],
    });
    expect(events.map((e) => e.type)).toEqual(["message.received", "postback.received", "referral.received"]);
    const pb = events[1]!;
    if (pb.type === "postback.received") {
      expect(pb.payload).toBe("GET_STARTED");
      expect(pb.contactExternalId).toBe("psid-1");
    }
    const ref = events[2]!;
    if (ref.type === "referral.received") expect(ref.ref).toBe("promo-ads");
  });

  test("a message attachment normalizes to media with its CDN url", async () => {
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn: async () => new Response("{}") });
    const events = await msgr.parseWebhook({
      object: "page",
      entry: [{
        id: "page-1",
        messaging: [
          {
            sender: { id: "psid-1" }, timestamp: 1700000000000,
            message: {
              mid: "mid-att", text: "lihat foto ini",
              attachments: [{ type: "image", payload: { url: "https://cdn.example.com/photo.jpg" } }],
            },
          },
          {
            sender: { id: "psid-1" }, timestamp: 1700000001000,
            message: {
              mid: "mid-loc",
              attachments: [{ type: "location", payload: { coordinates: { lat: 1, long: 2 } } }],
            },
          },
        ],
      }],
    });
    expect(events).toHaveLength(2);
    const withMedia = events[0]!;
    if (withMedia.type === "message.received") {
      expect(withMedia.media).toEqual({ type: "image", url: "https://cdn.example.com/photo.jpg" });
      expect(withMedia.text).toBe("lihat foto ini");
    }
    const location = events[1]!;
    if (location.type === "message.received") {
      expect(location.media).toBeUndefined();
    }
  });
});

describe("messenger page picture (onboarding avatar)", () => {
  test("fetchPagePictureUrl returns picture.data.url", async () => {
    const { fetchFn, calls } = mockFetch([{
      body: { picture: { data: { url: "https://cdn.example.com/page-pic.jpg", width: 200, height: 200 } } },
    }]);
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn });
    const url = await msgr.fetchPagePictureUrl({ pageId: "page-1", pageAccessToken: PAGE_TOKEN });
    expect(url).toBe("https://cdn.example.com/page-pic.jpg");
    expect(calls[0]!.url).toContain("/page-1?");
    expect(calls[0]!.url).toContain("fields=picture");
  });

  test("fetchPagePictureUrl returns null when the Page has no picture", async () => {
    const { fetchFn } = mockFetch([{ body: { id: "page-1" } }]);
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn });
    expect(await msgr.fetchPagePictureUrl({ pageId: "page-1", pageAccessToken: PAGE_TOKEN })).toBeNull();
  });

  test("fetchPagePictureUrl returns null on an API error (best-effort)", async () => {
    const { fetchFn } = mockFetch([{ status: 400, body: { error: { message: "nope" } } }]);
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn });
    expect(await msgr.fetchPagePictureUrl({ pageId: "page-1", pageAccessToken: PAGE_TOKEN })).toBeNull();
  });
});

describe("messenger reply context + presence", () => {
  test("a reply carries reply_to.mid inside the message object", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { message_id: "mid.2" } }]);
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn });
    await msgr.send({
      account: PAGE, toExternalId: "psid-1", text: "baik", idempotencyKey: "k",
      replyToExternalId: "mid.IN",
    });
    expect(JSON.parse(calls[0]!.init!.body as string).message).toEqual({
      text: "baik", reply_to: { mid: "mid.IN" },
    });
  });

  test("markRead sends mark_seen for the PSID (thread-level receipt)", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { recipient_id: "psid-1" } }]);
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn });
    await msgr.markRead({ account: PAGE, contactExternalId: "psid-1", messageExternalId: "mid.IN" });
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v26.0/me/messages");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      recipient: { id: "psid-1" }, sender_action: "mark_seen",
    });
  });

  test("markRead without a PSID fails validation", async () => {
    const { fetchFn, calls } = mockFetch([{ body: {} }]);
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn });
    await expect(msgr.markRead({ account: PAGE, contactExternalId: "" })).rejects.toThrow(/PSID/i);
    expect(calls).toHaveLength(0);
  });

  test("typing toggles typing_on / typing_off as separate sender actions", async () => {
    const { fetchFn, calls } = mockFetch([{ body: {} }, { body: {} }]);
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn });
    await msgr.typing({ account: PAGE, toExternalId: "psid-1", on: true });
    await msgr.typing({ account: PAGE, toExternalId: "psid-1", on: false });
    expect(JSON.parse(calls[0]!.init!.body as string).sender_action).toBe("typing_on");
    expect(JSON.parse(calls[1]!.init!.body as string).sender_action).toBe("typing_off");
  });

  test("insights asks for page_post_engagements, never the retired metric names", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { data: [] } }]);
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn });
    await msgr.fetchInsights({ account: PAGE });
    expect(calls[0]!.url).toContain("metric=page_views_total,page_post_engagements");
    expect(calls[0]!.url).not.toContain("page_post_views");
  });
});

describe("messenger messaging profile (IG-2 parity)", () => {
  test("set writes the menu on me/messenger_profile without an instagram tag", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { result: "success" } }]);
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn });
    await msgr.messengerProfile.set({
      account: PAGE,
      profile: { persistentMenu: { items: [{ type: "web_url", title: "Toko", url: "https://toko.test" }] } },
    });
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v26.0/me/messenger_profile");
    const sent = JSON.parse(calls[0]!.init!.body as string);
    expect(sent.platform).toBeUndefined();
    expect(sent.persistent_menu[0].call_to_actions[0]).toEqual({
      type: "web_url", title: "Toko", url: "https://toko.test",
    });
  });

  test("get and remove address the profile by field", async () => {
    const { fetchFn, calls } = mockFetch([
      { body: { data: [{ ice_breakers: [] }] } },
      { body: { success: true } },
    ]);
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn });
    await msgr.messengerProfile.get({ account: PAGE, fields: ["ice_breakers"] });
    await msgr.messengerProfile.remove({ account: PAGE, fields: ["ice_breakers"] });
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v26.0/me/messenger_profile?fields=ice_breakers");
    expect(calls[1]!.init!.method).toBe("DELETE");
    expect(decodeURIComponent(calls[1]!.url)).toContain('fields=["ice_breakers"]');
  });
});

describe("messenger media: reusable attachment upload (M-1)", () => {
  test("uploads bytes as multipart and returns the reusable attachment id", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { attachment_id: "att-42" } }]);
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn });
    const res = await msgr.uploadAttachment(PAGE, {
      data: new Uint8Array([1, 2, 3]), type: "image", filename: "photo.png", mimeType: "image/png",
    });
    expect(res.attachmentId).toBe("att-42");
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v26.0/page-1/message_attachments");
    expect(calls[0]!.init!.method).toBe("POST");
    // Multipart: the runtime must set the boundary, so no manual content-type.
    expect((calls[0]!.init!.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    const body = calls[0]!.init!.body as FormData;
    expect(JSON.parse(String(body.get("message")))).toEqual({
      attachment: { type: "image", payload: { is_reusable: true } },
    });
    expect(body.get("filedata")).toBeInstanceOf(Blob);
  });

  test("an upload without an id is a typed provider error", async () => {
    const { fetchFn } = mockFetch([{ body: {} }]);
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn });
    await expect(msgr.uploadAttachment(PAGE, { data: new Uint8Array([1]) }))
      .rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  test("send with an attachment id needs no public URL", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { message_id: "mid.9" } }]);
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn });
    const res = await msgr.send({
      account: PAGE, toExternalId: "psid-1", idempotencyKey: "k",
      media: { type: "image", id: "att-42" },
    });
    expect(res.externalMessageId).toBe("mid.9");
    expect(JSON.parse(calls[0]!.init!.body as string).message).toEqual({
      attachment: { type: "image", payload: { attachment_id: "att-42" } },
    });
  });

  test("a caption is sent as its own text message first, then the attachment", async () => {
    const { fetchFn, calls } = mockFetch([
      { body: { message_id: "mid.text" } },
      { body: { message_id: "mid.media" } },
    ]);
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn });
    const res = await msgr.send({
      account: PAGE, toExternalId: "psid-1", idempotencyKey: "k",
      media: { type: "image", id: "att-42", caption: "Struk ya kak" },
    });
    expect(res.externalMessageId).toBe("mid.media");
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]!.init!.body as string).message).toEqual({ text: "Struk ya kak" });
    expect(JSON.parse(calls[1]!.init!.body as string).message.attachment.payload)
      .toEqual({ attachment_id: "att-42" });
  });

  test("a public URL still works (payload.url, is_reusable)", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { message_id: "mid.url" } }]);
    const msgr = new MessengerAdapter({ credentials: creds, fetchFn });
    await msgr.send({
      account: PAGE, toExternalId: "psid-1", idempotencyKey: "k",
      media: { type: "video", link: "https://cdn.test/v.mp4" },
    });
    expect(JSON.parse(calls[0]!.init!.body as string).message).toEqual({
      attachment: { type: "video", payload: { url: "https://cdn.test/v.mp4", is_reusable: true } },
    });
  });
});
