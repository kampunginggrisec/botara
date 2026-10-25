import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";
import { createDbWebchatStore } from "./webchat-store";
import type { RealtimePublisher } from "./realtime-publish";

/**
 * Regression suite for the webchat double-reply bug + the realtime
 * publish points, run against the REAL route/repository code over an
 * in-memory fake Database (see fake-db.ts):
 *
 *  - POST /conversations/:id/reply on a webchat conversation must persist
 *    EXACTLY ONE outbound row (the route pre-creates it; the webchat
 *    store must reuse it via the idempotency key, not insert a second).
 *  - The store seam itself: existing key -> reuse + mark sent; new key ->
 *    insert once; a retried delivery with the same key -> still one row.
 *  - A visitor message through the public webchat route persists once and
 *    publishes exactly one "in" realtime event; a reply publishes one
 *    "out" event.
 */

let fake: FakeDatabase;
const published: Array<{ workspaceId: string; conversationId: string; direction: "in" | "out"; messageId?: string }> = [];
const recordingPublisher: RealtimePublisher = {
  async publishInboxMessage(event) { published.push(event); },
  async publishInboxUpdate() {},
};

const app = createApp(testDeps({
  getDatabase: () => fake.db,
  realtimePublisher: recordingPublisher,
}));

let owner: Registered;

function seedWebchat(workspaceId: string) {
  fake.seed("channelAccounts", {
    id: "acc-webchat", workspaceId, channel: "webchat",
    externalId: `webchat:${workspaceId}`, status: "connected",
    tokenVaultRef: null, authMode: null,
  });
  fake.seed("contacts", {
    id: "contact-1", workspaceId, channel: "webchat",
    externalId: "webchat-session:sess-1", displayName: "Visitor",
    tags: [], customFields: {},
  });
  fake.seed("conversations", {
    id: "conv-1", workspaceId, channelAccountId: "acc-webchat",
    contactId: "contact-1", status: "open", assignedUserId: null,
    lastUserMessageAt: new Date(),
  });
  fake.seed("webchatSessions", {
    id: "sess-1", workspaceId, token: "visitor-token-1",
    contactId: "contact-1", conversationId: "conv-1",
    visitorName: "Visitor", lastSeenAt: new Date(),
  });
}

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(app, "webchat-owner@example.com");
  seedWebchat(owner.workspaceId);
});

describe("POST /conversations/:id/reply (webchat)", () => {
  test("persists exactly ONE outbound message and publishes one out event", async () => {
    published.length = 0;
    const res = await app.request("/conversations/conv-1/reply", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ kind: "free_form", text: "Hello visitor" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { id: string; status: string } };
    expect(body.message.status).toBe("sent");

    const outRows = fake.rows.messages.filter(
      (m) => m.conversationId === "conv-1" && m.direction === "out",
    );
    expect(outRows).toHaveLength(1);
    expect(outRows[0]).toMatchObject({ body: "Hello visitor", status: "sent" });
    expect(body.message.id).toBe(String(outRows[0]!.id));

    // The inbox thread shows the reply exactly once.
    const thread = await app.request("/conversations/conv-1/messages", { headers: owner.headers });
    expect(thread.status).toBe(200);
    const threadBody = (await thread.json()) as { messages: Array<{ direction: string; body?: string }> };
    expect(threadBody.messages.filter((m) => m.direction === "out")).toHaveLength(1);

    expect(published).toEqual([
      { workspaceId: owner.workspaceId, conversationId: "conv-1", direction: "out", messageId: String(outRows[0]!.id) },
    ]);
  });
});

describe("createDbWebchatStore idempotency seam", () => {
  test("a pre-created route row is reused and marked sent, never duplicated", async () => {
    const local = createFakeDatabase();
    local.seed("webchatSessions", {
      id: "sess-9", workspaceId: "ws-9", token: "tok-9",
      contactId: "c-9", conversationId: "conv-9", visitorName: null, lastSeenAt: new Date(),
    });
    local.seed("messages", {
      id: "msg-route", conversationId: "conv-9", direction: "out", type: "text",
      body: "Hi there", externalId: undefined, status: "queued",
      idempotencyKey: "reply:conv-9:abc",
    });
    const store = createDbWebchatStore(local.db);
    const result = await store.deliverOutbound({
      toExternalId: "webchat-session:sess-9", text: "Hi there", idempotencyKey: "reply:conv-9:abc",
    });
    expect(result.messageId).toBe("msg-route");
    expect(local.rows.messages).toHaveLength(1);
    expect(local.rows.messages[0]).toMatchObject({ id: "msg-route", status: "sent" });
  });

  test("a new key inserts once; a retry with the same key reuses the row", async () => {
    const local = createFakeDatabase();
    local.seed("webchatSessions", {
      id: "sess-9", workspaceId: "ws-9", token: "tok-9",
      contactId: "c-9", conversationId: "conv-9", visitorName: null, lastSeenAt: new Date(),
    });
    const store = createDbWebchatStore(local.db);
    const first = await store.deliverOutbound({
      toExternalId: "webchat-session:sess-9", text: "Flow hello", idempotencyKey: "flow:f-1:contact:0",
    });
    const retry = await store.deliverOutbound({
      toExternalId: "webchat-session:sess-9", text: "Flow hello", idempotencyKey: "flow:f-1:contact:0",
    });
    expect(retry.messageId).toBe(first.messageId);
    expect(local.rows.messages).toHaveLength(1);
    expect(local.rows.messages[0]).toMatchObject({ status: "sent", body: "Flow hello" });
  });
});

describe("POST /public/webchat/:workspaceId/messages", () => {
  test("a visitor message persists once and publishes exactly one in event", async () => {
    published.length = 0;
    const res = await app.request(`/public/webchat/${owner.workspaceId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webchat-session": "visitor-token-1" },
      body: JSON.stringify({ text: "hello from the visitor" }),
    });
    expect(res.status).toBe(201);
    const inRows = fake.rows.messages.filter(
      (m) => m.conversationId === "conv-1" && m.direction === "in",
    );
    expect(inRows).toHaveLength(1);
    expect(inRows[0]).toMatchObject({ body: "hello from the visitor", status: "delivered" });
    expect(published).toEqual([
      { workspaceId: owner.workspaceId, conversationId: "conv-1", direction: "in", messageId: String(inRows[0]!.id) },
    ]);
  });
});
