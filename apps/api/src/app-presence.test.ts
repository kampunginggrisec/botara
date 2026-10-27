import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";

/**
 * Presence + quoted replies at the API surface (WA-2 / WA-3).
 *
 * The webchat channel is the harness here on purpose: it has NO presence
 * surface, which is exactly the "unsupported_channel" branch every route
 * must answer honestly instead of faking a call. Quoted replies are
 * resolved server-side, so the validation rules (same conversation,
 * provider id present) are channel-independent and testable here.
 */

let fake: FakeDatabase;
const app = createApp(testDeps({ getDatabase: () => fake.db }));
let owner: Registered;
let other: Registered;

const jsonHeaders = (r: Registered) => ({ ...r.headers, "content-type": "application/json" });

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(app, "presence-owner@example.com");
  other = await registerUser(app, "presence-other@example.com");
  const ws = owner.workspaceId;
  fake.seed("workspaces", { id: ws, name: "Toko Presence", slug: "toko-presence" });
  fake.seed("workspaces", { id: other.workspaceId, name: "Toko Lain", slug: "toko-lain-2" });
  fake.seed("channelAccounts", {
    id: "acc-webchat", workspaceId: ws, channel: "webchat",
    externalId: `webchat:${ws}`, displayName: "Webchat Toko", status: "connected",
    tokenVaultRef: null, authMode: null,
  });
  fake.seed("contacts", {
    id: "contact-1", workspaceId: ws, channel: "webchat",
    externalId: "webchat-session:sess-1", displayName: "Sari", tags: [], customFields: {},
  });
  fake.seed("conversations", {
    id: "conv-1", workspaceId: ws, channelAccountId: "acc-webchat",
    contactId: "contact-1", status: "open", assignedUserId: null,
    lastUserMessageAt: new Date(),
  });
  fake.seed("conversations", {
    id: "conv-2", workspaceId: ws, channelAccountId: "acc-webchat",
    contactId: "contact-1", status: "open", assignedUserId: null,
    lastUserMessageAt: new Date(),
  });
  fake.seed("webchatSessions", {
    id: "sess-1", workspaceId: ws, token: "visitor-token-1",
    contactId: "contact-1", conversationId: "conv-1",
    visitorName: "Sari", lastSeenAt: new Date(),
  });
  // An inbound message WITH a provider id (quotable) and an outbound row
  // that never reached a provider (not quotable).
  fake.seed("messages", {
    id: "msg-in", workspaceId: ws, conversationId: "conv-1", direction: "in",
    kind: "message", type: "text", body: "Stok masih ada?", status: "received",
    externalId: "wamid.IN-1", authorKind: "human", createdAt: new Date("2026-10-27T01:00:00Z"),
  });
  fake.seed("messages", {
    id: "msg-failed", workspaceId: ws, conversationId: "conv-1", direction: "out",
    kind: "message", type: "text", body: "Gagal kirim", status: "failed",
    externalId: null, authorKind: "human", createdAt: new Date("2026-10-27T01:01:00Z"),
  });
  // Same message id in ANOTHER conversation: quoting must not cross threads.
  fake.seed("messages", {
    id: "msg-other-thread", workspaceId: ws, conversationId: "conv-2", direction: "in",
    kind: "message", type: "text", body: "Halo dari thread lain", status: "received",
    externalId: "wamid.OTHER", authorKind: "human", createdAt: new Date("2026-10-27T01:02:00Z"),
  });
});

describe("quoted replies (WA-2)", () => {
  test("quoting a message of the same thread is accepted", async () => {
    const res = await app.request("/conversations/conv-1/reply", {
      method: "POST",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ kind: "free_form", text: "Masih ada kak", replyToMessageId: "msg-in" }),
    });
    expect(res.status).toBe(200);
  });

  test("quoting a message from ANOTHER conversation is a typed 404", async () => {
    const res = await app.request("/conversations/conv-1/reply", {
      method: "POST",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ kind: "free_form", text: "halo", replyToMessageId: "msg-other-thread" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("quoting a message that never reached the provider is a typed 400", async () => {
    const res = await app.request("/conversations/conv-1/reply", {
      method: "POST",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ kind: "free_form", text: "halo", replyToMessageId: "msg-failed" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  test("a reply without a quote target still works (the field is optional)", async () => {
    const res = await app.request("/conversations/conv-1/reply", {
      method: "POST",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ kind: "free_form", text: "tanpa kutipan" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("presence routes (WA-3)", () => {
  test("webchat has no read surface: 200 with read=false, never a fake call", async () => {
    const res = await app.request("/conversations/conv-1/read", {
      method: "POST",
      headers: owner.headers,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ read: false, reason: "unsupported_channel" });
  });

  test("webchat has no typing surface: 200 with typing=false", async () => {
    const res = await app.request("/conversations/conv-1/typing", {
      method: "POST",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ on: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ typing: false, reason: "unsupported_channel" });
  });

  test("unknown conversations are 404 on both presence routes", async () => {
    const read = await app.request("/conversations/nope/read", { method: "POST", headers: owner.headers });
    expect(read.status).toBe(404);
    const typing = await app.request("/conversations/nope/typing", {
      method: "POST",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ on: true }),
    });
    expect(typing.status).toBe(404);
  });
});
