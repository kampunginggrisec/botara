import { describe, expect, test } from "bun:test";
import { StaticCredentialProvider } from "./credentials";
import {
  FACEBOOK_LOGIN_SCOPES, INSTAGRAM_LOGIN_SCOPES, InstagramAdapter, buildInstagramAuthorizeUrl,
} from "./instagram";
import type { FetchLike } from "./types";

const creds = new StaticCredentialProvider({ accessToken: "ig-token" });
const IG_ACCOUNT = { id: "a1", externalId: "ig-user-1", authMode: "instagram-login", tokenVaultRef: "vault:ig" };
const FB_ACCOUNT = { id: "a2", externalId: "ig-user-2", authMode: "facebook-login", tokenVaultRef: "vault:ig2" };

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

describe("instagram dual-mode hosts", () => {
  test("instagram-login DMs go to graph.instagram.com", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { message_id: "mid.1", recipient_id: "u1" } }]);
    const ig = new InstagramAdapter({ credentials: creds, fetchFn });
    const res = await ig.send({ account: IG_ACCOUNT, toExternalId: "u1", text: "halo", idempotencyKey: "k" });
    expect(res.externalMessageId).toBe("mid.1");
    expect(calls[0]!.url).toBe("https://graph.instagram.com/ig-user-1/messages");
  });

  test("facebook-login DMs go to graph.facebook.com with the pinned version", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { message_id: "mid.2" } }]);
    const ig = new InstagramAdapter({ credentials: creds, fetchFn });
    await ig.send({ account: FB_ACCOUNT, toExternalId: "u1", text: "halo", idempotencyKey: "k" });
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v26.0/ig-user-2/messages");
  });

  test("baseFor reflects the mode", () => {
    const ig = new InstagramAdapter({ credentials: creds, fetchFn: async () => new Response("{}") });
    expect(ig.baseFor(IG_ACCOUNT)).toBe("https://graph.instagram.com");
    expect(ig.baseFor(FB_ACCOUNT)).toBe("https://graph.facebook.com/v26.0");
  });
});

describe("instagram authorize URL scope trap", () => {
  test("ALWAYS sends the full instagram-login scope list, even when a subset is requested", () => {
    const url = new URL(buildInstagramAuthorizeUrl({
      mode: "instagram-login", appId: "app1", redirectUri: "https://app.example.com/cb",
      requestedScopes: ["instagram_business_basic"], // a subset - must be ignored
    }));
    const scope = url.searchParams.get("scope")!;
    for (const s of INSTAGRAM_LOGIN_SCOPES) expect(scope.split(",")).toContain(s);
    expect(scope.split(",")).toHaveLength(INSTAGRAM_LOGIN_SCOPES.length);
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
  });

  test("facebook-login URL uses the facebook dialog with the instagram_* list", () => {
    const url = new URL(buildInstagramAuthorizeUrl({
      mode: "facebook-login", appId: "app1", redirectUri: "https://app.example.com/cb",
    }));
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    const scope = url.searchParams.get("scope")!;
    for (const s of FACEBOOK_LOGIN_SCOPES) expect(scope.split(",")).toContain(s);
  });
});

describe("instagram publishing (two-step)", () => {
  test("creates a container BEFORE media_publish, in order", async () => {
    const { fetchFn, calls } = mockFetch([
      { body: { id: "creation-1" } },
      { body: { id: "post-1" } },
    ]);
    const ig = new InstagramAdapter({ credentials: creds, fetchFn });
    const res = await ig.publish({
      account: IG_ACCOUNT, text: "caption", mediaUrls: ["https://media.example.com/a.jpg"], idempotencyKey: "k",
    });
    expect(res.externalPostId).toBe("post-1");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://graph.instagram.com/ig-user-1/media");
    expect(JSON.parse(calls[0]!.init!.body as string)).toMatchObject({ image_url: "https://media.example.com/a.jpg", caption: "caption" });
    expect(calls[1]!.url).toBe("https://graph.instagram.com/ig-user-1/media_publish");
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({ creation_id: "creation-1" });
  });

  test("text-only publish is rejected (Instagram requires media)", async () => {
    const { fetchFn, calls } = mockFetch([]);
    const ig = new InstagramAdapter({ credentials: creds, fetchFn });
    await expect(ig.publish({ account: IG_ACCOUNT, text: "halo", idempotencyKey: "k" }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    expect(calls).toHaveLength(0);
  });
});

describe("instagram moderation + private reply", () => {
  test("hide/delete hit the comment id directly", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { success: true } }, { body: { success: true } }]);
    const ig = new InstagramAdapter({ credentials: creds, fetchFn });
    await ig.moderate({ account: IG_ACCOUNT, targetExternalId: "cmt-1", action: "hide" });
    await ig.moderate({ account: IG_ACCOUNT, targetExternalId: "cmt-1", action: "delete" });
    expect(calls[0]!.url).toBe("https://graph.instagram.com/cmt-1");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ hide: true });
    expect(calls[1]!.init!.method).toBe("DELETE");
  });

  test("public reply posts to /replies; private reply DMs by comment_id (1 per comment)", async () => {
    const { fetchFn, calls } = mockFetch([
      { body: { id: "reply-1" } },
      { body: { message_id: "dm-1" } },
    ]);
    const ig = new InstagramAdapter({ credentials: creds, fetchFn });
    await ig.moderate({ account: IG_ACCOUNT, targetExternalId: "cmt-9", action: "reply", text: "terima kasih" });
    expect(calls[0]!.url).toBe("https://graph.instagram.com/cmt-9/replies");
    const priv = await ig.privateReplyToComment(IG_ACCOUNT, "cmt-9", "cek DM ya");
    expect(priv.externalMessageId).toBe("dm-1");
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({
      recipient: { comment_id: "cmt-9" }, message: { text: "cek DM ya" },
    });
  });
});

describe("instagram insights (Views family only)", () => {
  test("media insights request views-family metrics, never reach/impressions", async () => {
    const { fetchFn, calls } = mockFetch([{
      body: { data: [{ name: "views", values: [{ value: 42 }] }, { name: "likes", values: [{ value: 7 }] }] },
    }]);
    const ig = new InstagramAdapter({ credentials: creds, fetchFn });
    const out = await ig.fetchInsights({ account: IG_ACCOUNT, targetExternalId: "media-1" });
    expect(out).toEqual({ views: 42, likes: 7 });
    expect(calls[0]!.url).toContain("metric=views,likes,comments,shares,saved");
    expect(calls[0]!.url).not.toContain("impressions");
    expect(calls[0]!.url).not.toContain("reach");
  });
});

describe("instagram token lifecycle", () => {
  test("refresh is skipped when the token is too young (<24h old)", async () => {
    const { fetchFn, calls } = mockFetch([]);
    const ig = new InstagramAdapter({ credentials: creds, fetchFn });
    const expiresAt = new Date(Date.now() + 59.9 * 24 * 3600 * 1000).toISOString(); // issued ~2.4h ago
    const res = await ig.refreshTokenIfNeeded({ ...IG_ACCOUNT, tokenExpiresAt: expiresAt });
    expect(res.refreshed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("refresh runs inside the window and returns the new expiry", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { access_token: "new-token", expires_in: 5184000 } }]);
    const ig = new InstagramAdapter({ credentials: creds, fetchFn });
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(); // 30 days left of 60
    const res = await ig.refreshTokenIfNeeded({ ...IG_ACCOUNT, tokenExpiresAt: expiresAt });
    expect(res.refreshed).toBe(true);
    expect(res.expiresAt).toBeTruthy();
    expect(calls[0]!.url).toContain("https://graph.instagram.com/refresh_access_token");
    expect(calls[0]!.url).toContain("grant_type=ig_refresh_token");
  });

  test("facebook-login mode never attempts an API refresh", async () => {
    const { fetchFn, calls } = mockFetch([]);
    const ig = new InstagramAdapter({ credentials: creds, fetchFn });
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const res = await ig.refreshTokenIfNeeded({ ...FB_ACCOUNT, tokenExpiresAt: expiresAt });
    expect(res.refreshed).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("instagram webhooks", () => {
  test("parses messages, comments and mentions into standardized events", async () => {
    const ig = new InstagramAdapter({ credentials: creds, fetchFn: async () => new Response("{}") });
    const events = await ig.parseWebhook({
      object: "instagram",
      entry: [{
        id: "ig-user-1",
        messaging: [{
          sender: { id: "u-9" }, recipient: { id: "ig-user-1" }, timestamp: 1700000000,
          message: { mid: "mid-1", text: "halo kak" },
        }],
        changes: [
          { field: "comments", value: { id: "cmt-1", text: "bagus!", from: { id: "u-2" }, media: { id: "post-1" } } },
          { field: "mentions", value: { media_id: "post-2", comment_id: "cmt-2" } },
        ],
      }],
    });
    expect(events.map((e) => e.type)).toEqual(["message.received", "comment.received", "mention.received"]);
    const msg = events[0]!;
    expect(msg.type).toBe("message.received");
    if (msg.type === "message.received") {
      expect(msg.contactExternalId).toBe("u-9");
      expect(msg.text).toBe("halo kak");
    }
    const cmt = events[1]!;
    if (cmt.type === "comment.received") {
      expect(cmt.postExternalId).toBe("post-1");
      expect(cmt.authorExternalId).toBe("u-2");
    }
  });

  test("a message attachment normalizes to media with its CDN url", async () => {
    const ig = new InstagramAdapter({ credentials: creds, fetchFn: async () => new Response("{}") });
    const events = await ig.parseWebhook({
      object: "instagram",
      entry: [{
        id: "ig-user-1",
        messaging: [{
          sender: { id: "u-9" }, recipient: { id: "ig-user-1" }, timestamp: 1700000000,
          message: {
            mid: "mid-att",
            attachments: [{ type: "file", payload: { url: "https://cdn.example.com/brosur.pdf" } }],
          },
        }],
      }],
    });
    expect(events).toHaveLength(1);
    const msg = events[0]!;
    if (msg.type === "message.received") {
      expect(msg.media).toEqual({ type: "document", url: "https://cdn.example.com/brosur.pdf" });
    }
  });
});

describe("instagram video containers (Fase 3 polling)", () => {
  const noSleep = async () => {};

  test("video publish polls container status until FINISHED, then media_publish", async () => {
    const { fetchFn, calls } = mockFetch([
      { body: { id: "creation-v1" } },               // create container
      { body: { status_code: "IN_PROGRESS" } },      // poll 1
      { body: { status_code: "FINISHED" } },         // poll 2
      { body: { id: "post-v1" } },                   // media_publish
    ]);
    const ig = new InstagramAdapter({ credentials: creds, fetchFn, containerPoll: { attempts: 5, delayMs: 1, sleep: noSleep } });
    const res = await ig.publish({
      account: IG_ACCOUNT, mediaUrls: ["https://media.example.com/clip.mp4"], idempotencyKey: "k",
    });
    expect(res.externalPostId).toBe("post-v1");
    expect(calls.map((c) => c.url)).toEqual([
      "https://graph.instagram.com/ig-user-1/media",
      "https://graph.instagram.com/creation-v1?fields=status_code",
      "https://graph.instagram.com/creation-v1?fields=status_code",
      "https://graph.instagram.com/ig-user-1/media_publish",
    ]);
    expect(JSON.parse(calls[0]!.init!.body as string)).toMatchObject({ media_type: "REELS", video_url: "https://media.example.com/clip.mp4" });
  });

  test("image publish does NOT poll the container status", async () => {
    const { fetchFn, calls } = mockFetch([
      { body: { id: "creation-i1" } },
      { body: { id: "post-i1" } },
    ]);
    const ig = new InstagramAdapter({ credentials: creds, fetchFn, containerPoll: { attempts: 5, delayMs: 1, sleep: noSleep } });
    await ig.publish({ account: IG_ACCOUNT, mediaUrls: ["https://media.example.com/a.jpg"], idempotencyKey: "k" });
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.includes("status_code"))).toBe(false);
  });

  test("container ERROR fails the publish (non-retryable)", async () => {
    const { fetchFn } = mockFetch([
      { body: { id: "creation-e1" } },
      { body: { status_code: "ERROR" } },
    ]);
    const ig = new InstagramAdapter({ credentials: creds, fetchFn, containerPoll: { attempts: 3, delayMs: 1, sleep: noSleep } });
    await expect(ig.publish({ account: IG_ACCOUNT, mediaUrls: ["https://media.example.com/bad.mp4"], idempotencyKey: "k" }))
      .rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  test("polling is bounded: never-FINISHED containers fail retryably after the attempts run out", async () => {
    const { fetchFn, calls } = mockFetch([
      { body: { id: "creation-s1" } },
      { body: { status_code: "IN_PROGRESS" } },
      { body: { status_code: "IN_PROGRESS" } },
    ]);
    const ig = new InstagramAdapter({ credentials: creds, fetchFn, containerPoll: { attempts: 2, delayMs: 1, sleep: noSleep } });
    await expect(ig.publish({ account: IG_ACCOUNT, mediaUrls: ["https://media.example.com/slow.mov"], idempotencyKey: "k" }))
      .rejects.toThrow(/not FINISHED after 2 status checks/);
    // 1 create + exactly 2 status polls, and media_publish was never attempted.
    expect(calls).toHaveLength(3);
    expect(calls.some((c) => c.url.includes("media_publish"))).toBe(false);
  });

  test("getMediaContainerStatus reads status_code", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { status_code: "FINISHED" } }]);
    const ig = new InstagramAdapter({ credentials: creds, fetchFn });
    expect(await ig.getMediaContainerStatus(IG_ACCOUNT, "creation-9")).toBe("FINISHED");
    expect(calls[0]!.url).toBe("https://graph.instagram.com/creation-9?fields=status_code");
  });
});
