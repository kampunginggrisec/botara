import { describe, expect, test } from "bun:test";
import { StaticCredentialProvider } from "./credentials";
import { ThreadsAdapter, threadsRefreshDecision } from "./threads";
import type { FetchLike } from "./types";

const creds = new StaticCredentialProvider({ accessToken: "th-token" });
const ACCOUNT = { id: "a1", externalId: "th-user-1", tokenVaultRef: "vault:th" };
const DAY = 24 * 3600 * 1000;

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

describe("threads publishing (container flow)", () => {
  test("media post: creates the container BEFORE threads_publish, in order", async () => {
    const { fetchFn, calls } = mockFetch([
      { body: { id: "container-1" } },
      { body: { id: "post-1" } },
    ]);
    const th = new ThreadsAdapter({ credentials: creds, fetchFn });
    const res = await th.publish({
      account: ACCOUNT, text: "halo threads", mediaUrls: ["https://media.example.com/x.jpg"], idempotencyKey: "k",
    });
    expect(res.externalPostId).toBe("post-1");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://graph.threads.net/v1.0/th-user-1/threads");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      media_type: "IMAGE", image_url: "https://media.example.com/x.jpg", text: "halo threads",
    });
    expect(calls[1]!.url).toBe("https://graph.threads.net/v1.0/th-user-1/threads_publish");
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({ creation_id: "container-1" });
  });

  test("plain text post uses the one-step auto_publish_text path", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { id: "post-text-1" } }]);
    const th = new ThreadsAdapter({ credentials: creds, fetchFn });
    const res = await th.publish({ account: ACCOUNT, text: "teks saja", idempotencyKey: "k" });
    expect(res.externalPostId).toBe("post-text-1");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      media_type: "TEXT", text: "teks saja", auto_publish_text: true,
    });
  });

  test("reply flow: container carries reply_to_id, then publish", async () => {
    const { fetchFn, calls } = mockFetch([
      { body: { id: "container-r" } },
      { body: { id: "post-r" } },
    ]);
    const th = new ThreadsAdapter({ credentials: creds, fetchFn });
    const res = await th.publish({
      account: ACCOUNT, text: "balasan", replyToExternalId: "post-orig", idempotencyKey: "k",
    });
    expect(res.externalPostId).toBe("post-r");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      media_type: "TEXT", text: "balasan", reply_to_id: "post-orig",
    });
    expect(calls[1]!.url).toContain("threads_publish");
  });

  test("quote post: container carries quote_post_id", async () => {
    const { fetchFn, calls } = mockFetch([
      { body: { id: "container-q" } },
      { body: { id: "post-q" } },
    ]);
    const th = new ThreadsAdapter({ credentials: creds, fetchFn });
    await th.publish({ account: ACCOUNT, text: "setuju", quoteExternalId: "post-orig", idempotencyKey: "k" });
    expect(JSON.parse(calls[0]!.init!.body as string)).toMatchObject({ quote_post_id: "post-orig" });
  });
});

describe("threads moderation", () => {
  test("hide/unhide go through manage_reply; delete uses DELETE", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { success: true } }, { body: { success: true } }, { body: { success: true } }]);
    const th = new ThreadsAdapter({ credentials: creds, fetchFn });
    await th.moderate({ account: ACCOUNT, targetExternalId: "reply-1", action: "hide" });
    await th.moderate({ account: ACCOUNT, targetExternalId: "reply-1", action: "unhide" });
    await th.moderate({ account: ACCOUNT, targetExternalId: "post-1", action: "delete" });
    expect(calls[0]!.url).toBe("https://graph.threads.net/v1.0/reply-1/manage_reply");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ hide: true });
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({ hide: false });
    expect(calls[2]!.init!.method).toBe("DELETE");
    expect(calls[2]!.url).toBe("https://graph.threads.net/v1.0/post-1");
  });
});

describe("threads token refresh window (24h-60d)", () => {
  const now = new Date("2026-10-22T00:00:00Z");
  test("too-early: token younger than 24h cannot refresh", () => {
    const expiresAt = new Date(now.getTime() + 59.5 * DAY).toISOString(); // ~12h old
    expect(threadsRefreshDecision({ expiresAt, now })).toEqual({ action: "skip", reason: "too-early" });
  });
  test("in-window: a 30-day-old token refreshes", () => {
    const expiresAt = new Date(now.getTime() + 30 * DAY).toISOString();
    expect(threadsRefreshDecision({ expiresAt, now })).toEqual({ action: "refresh" });
  });
  test("expired: an expired token can NOT refresh (re-auth required)", () => {
    const expiresAt = new Date(now.getTime() - DAY).toISOString();
    expect(threadsRefreshDecision({ expiresAt, now })).toEqual({ action: "skip", reason: "expired" });
  });
  test("unknown expiry skips", () => {
    expect(threadsRefreshDecision({ expiresAt: undefined, now })).toEqual({ action: "skip", reason: "unknown-expiry" });
  });

  test("adapter refresh calls refresh_access_token only inside the window", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { access_token: "new-th-token", expires_in: 5184000 } }]);
    const th = new ThreadsAdapter({ credentials: creds, fetchFn });
    const expiresAt = new Date(Date.now() + 10 * DAY).toISOString();
    const res = await th.refreshTokenIfNeeded({ ...ACCOUNT, tokenExpiresAt: expiresAt });
    expect(res.refreshed).toBe(true);
    expect(calls[0]!.url).toContain("https://graph.threads.net/refresh_access_token");
    expect(calls[0]!.url).toContain("grant_type=th_refresh_token");
  });

  test("adapter refresh is a no-op for a too-young token (no HTTP call)", async () => {
    const { fetchFn, calls } = mockFetch([]);
    const th = new ThreadsAdapter({ credentials: creds, fetchFn });
    const expiresAt = new Date(Date.now() + 59.9 * DAY).toISOString();
    const res = await th.refreshTokenIfNeeded({ ...ACCOUNT, tokenExpiresAt: expiresAt });
    expect(res.refreshed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("short->long exchange hits /access_token with th_exchange_token", async () => {
    const { fetchFn, calls } = mockFetch([{ body: { access_token: "long-token", user_id: 123, expires_in: 5184000 } }]);
    const th = new ThreadsAdapter({ credentials: creds, fetchFn });
    const res = await th.exchangeShortLivedToken({ shortLivedToken: "short", appSecret: "sec" });
    expect(res.accessToken).toBe("long-token");
    expect(res.userId).toBe("123");
    expect(calls[0]!.url).toContain("grant_type=th_exchange_token");
  });
});

describe("threads webhooks", () => {
  test("parses replies and mentions", async () => {
    const th = new ThreadsAdapter({ credentials: creds, fetchFn: async () => new Response("{}") });
    const events = await th.parseWebhook({
      object: "threads",
      entry: [{
        id: "th-user-1",
        changes: [
          { field: "replies", value: { id: "reply-1", text: "setuju!", username: "budi", replied_to_id: "post-1", timestamp: 1700000000 } },
          { field: "mentions", value: { id: "post-2" } },
        ],
      }],
    });
    expect(events.map((e) => e.type)).toEqual(["comment.received", "mention.received"]);
    const reply = events[0]!;
    if (reply.type === "comment.received") {
      expect(reply.commentExternalId).toBe("reply-1");
      expect(reply.postExternalId).toBe("post-1");
      expect(reply.authorExternalId).toBe("budi");
    }
  });

  test("capabilities stay honest: no DM, no like", () => {
    const th = new ThreadsAdapter({ credentials: creds, fetchFn: async () => new Response("{}") });
    expect(th.capabilities.canDM).toBe(false);
    expect(th.capabilities.canLike).toBe(false);
  });
});
