import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";
import { createDbWebchatStore } from "./webchat-store";
import {
  InMemoryDispatchStore, createFlowDispatcher, type FlowRunJobPayload,
} from "./flows-dispatch";
import type { RealtimePublisher } from "./realtime-publish";
import type { RichBlock } from "@botara/channels";

/**
 * Clickable webchat buttons, end to end over the fake DB:
 *
 *  - A rich reply persists the block on the message row (payload column)
 *    and BOTH serializers (inbox thread, public widget GET) expose it.
 *  - The DB webchat store seam persists payloads with the same
 *    idempotency contract as before (retry -> same row, payload intact).
 *  - Public widget messages flow into the trigger dispatcher WITHOUT
 *    double persistence: typed text matches keyword flows; a button
 *    click matches postback flows by payload AND keyword flows by the
 *    button title; realtime is published exactly once (by the route).
 */

const BUTTONS: RichBlock = {
  kind: "buttons",
  text: "Halo! Mau lihat apa dulu?",
  buttons: [
    { type: "reply", title: "Lihat Harga", payload: "HARGA" },
    { type: "reply", title: "Cek Jadwal", payload: "JADWAL" },
    { type: "url", title: "Kunjungi Website", url: "https://example.com" },
  ],
};

let fake: FakeDatabase;
let app: ReturnType<typeof createApp>;
let owner: Registered;
const published: Array<{ workspaceId: string; conversationId: string; direction: "in" | "out"; messageId?: string }> = [];
const recordingPublisher: RealtimePublisher = {
  async publishInboxMessage(event) { published.push(event); },
  async publishInboxUpdate() {},
};
const flowRuns: FlowRunJobPayload[] = [];

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
  // A REAL dispatcher over the in-memory dispatch store, so the public
  // route tests exercise the actual trigger-matching code path.
  const dispatchStore = new InMemoryDispatchStore();
  const flowDispatcher = createFlowDispatcher({
    store: dispatchStore,
    flowEnqueuer: { async enqueueFlowRun(job) { flowRuns.push(job); } },
  });
  app = createApp(testDeps({
    getDatabase: () => fake.db,
    realtimePublisher: recordingPublisher,
    flowDispatcher,
  }));
  owner = await registerUser(app, "webchat-buttons@example.com");
  seedWebchat(owner.workspaceId);
  dispatchStore.flows.push(
    { id: "f-kw-harga", workspaceId: owner.workspaceId, trigger: { type: "keyword", config: { keyword: "harga" } } },
    { id: "f-pb-harga", workspaceId: owner.workspaceId, trigger: { type: "postback", config: { payload: "HARGA" } } },
  );
});

describe("rich reply on a webchat conversation", () => {
  test("persists the block as payload, delivers natively (no warning), serializers expose it", async () => {
    const res = await app.request("/conversations/conv-1/reply", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ kind: "free_form", text: BUTTONS.text, rich: BUTTONS }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { id: string; payload?: unknown }; warnings?: string[] };
    // Webchat renders buttons natively now - no degradation warning.
    expect(body.warnings).toBeUndefined();
    expect(body.message.payload).toEqual(BUTTONS);

    const outRows = fake.rows.messages.filter(
      (m) => m.conversationId === "conv-1" && m.direction === "out",
    );
    expect(outRows).toHaveLength(1);
    expect(outRows[0]).toMatchObject({ type: "rich", status: "sent" });
    expect(outRows[0]!.payload).toEqual(BUTTONS);

    // Inbox thread serializer includes the payload.
    const thread = await app.request("/conversations/conv-1/messages", { headers: owner.headers });
    expect(thread.status).toBe(200);
    const threadBody = (await thread.json()) as { messages: Array<{ id: string; payload?: unknown }> };
    const threadMsg = threadBody.messages.find((m) => m.id === String(outRows[0]!.id));
    expect(threadMsg?.payload).toEqual(BUTTONS);

    // Public widget serializer includes the payload (the widget renders
    // its clickable buttons from exactly this field).
    const pub = await app.request(`/public/webchat/${owner.workspaceId}/messages`, {
      headers: { "x-webchat-session": "visitor-token-1" },
    });
    expect(pub.status).toBe(200);
    const pubBody = (await pub.json()) as { messages: Array<{ id: string; payload?: unknown }> };
    const pubMsg = pubBody.messages.find((m) => m.id === String(outRows[0]!.id));
    expect(pubMsg?.payload).toEqual(BUTTONS);
  });
});

describe("createDbWebchatStore payload seam", () => {
  function localStore() {
    const local = createFakeDatabase();
    local.seed("webchatSessions", {
      id: "sess-9", workspaceId: "ws-9", token: "tok-9",
      contactId: "c-9", conversationId: "conv-9", visitorName: null, lastSeenAt: new Date(),
    });
    return { local, store: createDbWebchatStore(local.db) };
  }

  test("a payload send inserts ONE rich row; a retry reuses it with the payload intact", async () => {
    const { local, store } = localStore();
    const first = await store.deliverOutbound({
      toExternalId: "webchat-session:sess-9", text: "Halo! ...", idempotencyKey: "flow:f-1:c-9:0", payload: BUTTONS,
    });
    const retry = await store.deliverOutbound({
      toExternalId: "webchat-session:sess-9", text: "Halo! ...", idempotencyKey: "flow:f-1:c-9:0", payload: BUTTONS,
    });
    expect(retry.messageId).toBe(first.messageId);
    expect(local.rows.messages).toHaveLength(1);
    expect(local.rows.messages[0]).toMatchObject({ type: "rich", status: "sent" });
    expect(local.rows.messages[0]!.payload).toEqual(BUTTONS);
  });

  test("a plain send stays type text with a null payload", async () => {
    const { local, store } = localStore();
    await store.deliverOutbound({
      toExternalId: "webchat-session:sess-9", text: "plain hello", idempotencyKey: "flow:f-1:c-9:1",
    });
    expect(local.rows.messages[0]).toMatchObject({ type: "text", body: "plain hello" });
    expect(local.rows.messages[0]!.payload ?? null).toBeNull();
  });
});

describe("public webchat messages -> flow dispatch", () => {
  const post = (payload: Record<string, unknown>) => app.request(`/public/webchat/${owner.workspaceId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-webchat-session": "visitor-token-1" },
    body: JSON.stringify(payload),
  });
  const inRows = () => fake.rows.messages.filter(
    (m) => m.conversationId === "conv-1" && m.direction === "in",
  );

  test("a typed message enqueues the keyword flow, persists once, publishes once", async () => {
    flowRuns.length = 0;
    published.length = 0;
    const before = inRows().length;
    const res = await post({ text: "minta harga dong" });
    expect(res.status).toBe(201);
    expect(inRows()).toHaveLength(before + 1);
    expect(flowRuns.map((r) => r.flowId)).toEqual(["f-kw-harga"]);
    expect(flowRuns[0]).toMatchObject({
      workspaceId: owner.workspaceId, contactId: "contact-1",
      conversationId: "conv-1", channelAccountId: "acc-webchat",
      triggerText: "minta harga dong",
    });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ direction: "in", conversationId: "conv-1" });
  });

  test("a button click enqueues the postback flow by payload AND the keyword flow by title", async () => {
    flowRuns.length = 0;
    published.length = 0;
    const before = inRows().length;
    const res = await post({ text: "Lihat Harga", buttonPayload: "HARGA" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { message: { body: string; payload?: unknown } };
    expect(body.message.body).toBe("Lihat Harga");
    expect(body.message.payload).toEqual({ buttonPayload: "HARGA" });

    // Persisted exactly once, click payload on the row.
    expect(inRows()).toHaveLength(before + 1);
    const row = inRows()[inRows().length - 1]!;
    expect(row).toMatchObject({ body: "Lihat Harga" });
    expect(row.payload).toEqual({ buttonPayload: "HARGA" });

    // Postback by payload (triggerText = payload), keyword by title.
    const byFlow = new Map(flowRuns.map((r) => [r.flowId, r]));
    expect(byFlow.get("f-pb-harga")?.triggerText).toBe("HARGA");
    expect(byFlow.get("f-kw-harga")?.triggerText).toBe("Lihat Harga");
    expect(flowRuns).toHaveLength(2);
    expect(published).toHaveLength(1);
  });

  test("a click with an unknown payload and non-matching title enqueues nothing", async () => {
    flowRuns.length = 0;
    const res = await post({ text: "Menu Lain", buttonPayload: "ZZZ" });
    expect(res.status).toBe(201);
    expect(flowRuns).toHaveLength(0);
  });

  test("buttonPayload is validated (empty or >256 chars -> 400, nothing persisted)", async () => {
    const before = inRows().length;
    expect((await post({ text: "x", buttonPayload: "" })).status).toBe(400);
    expect((await post({ text: "x", buttonPayload: "y".repeat(257) })).status).toBe(400);
    expect(inRows()).toHaveLength(before);
  });
});
