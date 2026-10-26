import { beforeAll, describe, expect, test } from "bun:test";
import { sumCostLedgerByReference } from "@botara/db";
import { createApp } from "./app";
import { InMemoryAuthStore } from "./auth";
import { createDbWebchatStore } from "./webchat-store";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";
import type { RealtimePublisher } from "./realtime-publish";

/**
 * Package #7 (AI copilot) at the API surface:
 *  - ai-analyze: persists {summary, intent, intentScore} from a mocked
 *    provider's strict JSON; notes never enter the prompt; malformed
 *    output -> 502 AI_RESPONSE_INVALID with NOTHING persisted; no
 *    provider -> 503 (fail-closed, never faked);
 *  - usage: every AI call writes a cost_ledger row (category "ai",
 *    amount 0): total tokens when the provider reports usage, NULL
 *    units when it does not - never an invented number;
 *  - takeover: ai-pause/ai-resume stamp + clear ai_paused_at
 *    (idempotent), and a HUMAN inbox reply auto-pauses while its own
 *    message row keeps author_kind "human";
 *  - all three routes 404 cross-workspace.
 */

let fake: FakeDatabase;

interface ChatCall { messages: Array<{ role: string; content: string }> }
const chatCalls: ChatCall[] = [];
let chatReply: { text: string; usage?: { inputTokens: number; outputTokens: number } } = {
  text: JSON.stringify({
    summary: "Customer asks about red stock and seems ready to buy.",
    intent: "purchase_intent",
    intentScore: 87,
  }),
  usage: { inputTokens: 120, outputTokens: 30 },
};
const fakeProvider = {
  name: "fake-ai",
  async chatCompletion(input: ChatCall) {
    chatCalls.push(input);
    return { text: chatReply.text, model: "fake-model-1", usage: chatReply.usage };
  },
  async embedding() {
    return [0.1, 0.2, 0.3];
  },
};

const updates: Array<{ workspaceId: string; conversationId: string }> = [];
const recordingPublisher: RealtimePublisher = {
  async publishInboxMessage() {},
  async publishInboxUpdate(event) {
    updates.push(event);
  },
};

// Both apps share ONE auth store so the registered owner's session
// validates against the no-AI app too.
const sharedAuthStore = new InMemoryAuthStore();
const app = createApp(testDeps({
  getDatabase: () => fake.db,
  getAiProvider: () => fakeProvider,
  realtimePublisher: recordingPublisher,
  authStore: sharedAuthStore,
}));
const appNoAi = createApp(testDeps({
  getDatabase: () => fake.db,
  authStore: sharedAuthStore,
}));

let owner: Registered;
let other: Registered;

function seedConversation(id: string, ws: string, contactId: string) {
  fake.seed("conversations", {
    id, workspaceId: ws, channelAccountId: "acc-webchat",
    contactId, status: "open", assignedUserId: null,
    lastUserMessageAt: new Date(),
  });
}

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(app, "pkg7-owner@example.com");
  other = await registerUser(app, "pkg7-other@example.com");
  const ws = owner.workspaceId;
  fake.seed("workspaces", { id: ws, name: "Toko Uji", slug: "toko-uji" });
  fake.seed("workspaces", { id: other.workspaceId, name: "Toko Lain", slug: "toko-lain" });
  fake.seed("channelAccounts", {
    id: "acc-webchat", workspaceId: ws, channel: "webchat",
    externalId: `webchat:${ws}`, displayName: "Webchat Toko", status: "connected",
    tokenVaultRef: null, authMode: null,
  });
  fake.seed("contacts", {
    id: "contact-1", workspaceId: ws, channel: "webchat",
    externalId: "webchat-session:sess-1", displayName: "Sari Wulandari",
    tags: [], customFields: {},
  });
  seedConversation("conv-1", ws, "contact-1");
  seedConversation("conv-2", ws, "contact-1");
  seedConversation("conv-3", ws, "contact-1");
  fake.seed("webchatSessions", {
    id: "sess-1", workspaceId: ws, token: "visitor-token-1",
    contactId: "contact-1", conversationId: "conv-1",
    visitorName: "Sari", lastSeenAt: new Date(),
  });
  fake.seed("messages", {
    id: "msg-in-1", conversationId: "conv-1", direction: "in", kind: "message",
    type: "text", body: "apakah stok warna merah masih ada? saya mau beli dua",
    status: "received", createdAt: new Date(),
  });
  fake.seed("messages", {
    id: "msg-note-1", conversationId: "conv-1", direction: "out", kind: "note",
    type: "text", body: "CATATAN INTERNAL: pelanggan ini prioritas VIP",
    status: "sent", createdAt: new Date(),
  });
  // A conversation in the OTHER workspace (cross-workspace target).
  seedConversation("conv-other", other.workspaceId, "contact-1");
});

const post = (appInstance: typeof app, r: Registered, path: string) =>
  appInstance.request(path, { method: "POST", headers: { ...r.headers, "content-type": "application/json" }, body: "{}" });

const convRow = (id: string) => fake.rows.conversations.find((r) => r.id === id)!;
const aiLedgerRows = () => fake.rows.costLedger.filter((r) => r.category === "ai");

describe("ai-analyze", () => {
  test("persists summary/intent/score from valid JSON and records token usage", async () => {
    chatCalls.length = 0;
    const ledgerBefore = fake.rows.costLedger.length;
    const res = await post(app, owner, "/conversations/conv-1/ai-analyze");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      aiSummary: string; aiSummaryAt: string; aiIntent: string; aiIntentScore: number; model: string;
    };
    expect(body.aiSummary).toBe("Customer asks about red stock and seems ready to buy.");
    expect(body.aiIntent).toBe("purchase_intent");
    expect(body.aiIntentScore).toBe(87);
    expect(body.aiSummaryAt).toBeTruthy();
    expect(body.model).toBe("fake-model-1");

    const row = convRow("conv-1");
    expect(row.aiSummary).toBe(body.aiSummary);
    expect(row.aiIntent).toBe("purchase_intent");
    expect(row.aiIntentScore).toBe(87);
    expect(row.aiSummaryAt).toBeInstanceOf(Date);

    // The prompt carried the customer message but NEVER the internal note.
    expect(chatCalls).toHaveLength(1);
    const promptText = chatCalls[0]!.messages.map((m) => m.content).join("\n");
    expect(promptText).toContain("stok warna merah");
    expect(promptText).not.toContain("CATATAN INTERNAL");

    // Usage: exactly one ai row, tokens = 120 + 30, amount 0, model set.
    const rows = aiLedgerRows();
    expect(fake.rows.costLedger.length).toBe(ledgerBefore + 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.units).toBe(150);
    expect(rows[0]!.amount).toBe("0.000000");
    expect(rows[0]!.model).toBe("fake-model-1");
    expect(rows[0]!.referenceId).toBe("conv-1");
    expect(rows[0]!.workspaceId).toBe(owner.workspaceId);

    // The list serializer exposes the persisted analysis.
    const list = await app.request("/conversations", { headers: owner.headers });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      conversations: Array<{ id: string; aiIntent: string; aiIntentScore: number; aiSummary: string }>;
    };
    const listed = listBody.conversations.find((c) => c.id === "conv-1")!;
    expect(listed.aiIntent).toBe("purchase_intent");
    expect(listed.aiIntentScore).toBe(87);
    expect(listed.aiSummary).toBe(body.aiSummary);
  });

  test("usage row records NULL tokens when the provider reports no usage", async () => {
    chatReply = {
      text: JSON.stringify({ summary: "Just a greeting.", intent: "inquiry", intentScore: 40 }),
      usage: undefined,
    };
    const res = await post(app, owner, "/conversations/conv-2/ai-analyze");
    expect(res.status).toBe(200);
    const row = aiLedgerRows().find((r) => r.referenceId === "conv-2");
    expect(row).toBeDefined();
    expect(row!.units).toBeNull();
    expect(row!.amount).toBe("0.000000");
    expect(row!.model).toBe("fake-model-1");
  });

  test("malformed model output -> 502 AI_RESPONSE_INVALID and nothing persisted", async () => {
    chatReply = { text: "the customer seems happy, trust me", usage: { inputTokens: 10, outputTokens: 5 } };
    const res = await post(app, owner, "/conversations/conv-2/ai-analyze");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AI_RESPONSE_INVALID");
    // conv-2 still holds the analysis from the previous test - the
    // malformed call overwrote nothing.
    const row = convRow("conv-2");
    expect(row.aiSummary).toBe("Just a greeting.");
    expect(row.aiIntent).toBe("inquiry");
  });

  test("no AI provider configured -> 503 on analyze AND suggest (fail-closed)", async () => {
    const analyze = await post(appNoAi, owner, "/conversations/conv-1/ai-analyze");
    expect(analyze.status).toBe(503);
    const suggest = await post(appNoAi, owner, "/conversations/conv-1/ai-suggest");
    expect(suggest.status).toBe(503);
  });

  test("cross-workspace analyze -> 404", async () => {
    const res = await post(app, other, "/conversations/conv-1/ai-analyze");
    expect(res.status).toBe(404);
    const res2 = await post(app, owner, "/conversations/conv-other/ai-analyze");
    expect(res2.status).toBe(404);
  });
});

describe("ai-suggest usage", () => {
  test("a successful suggestion writes an ai usage row with its tokens", async () => {
    chatReply = { text: "Stok merah masih ada, kak.", usage: { inputTokens: 50, outputTokens: 10 } };
    const before = aiLedgerRows().filter((r) => r.referenceId === "conv-1").length;
    const res = await post(app, owner, "/conversations/conv-1/ai-suggest");
    expect(res.status).toBe(200);
    const rows = aiLedgerRows().filter((r) => r.referenceId === "conv-1");
    expect(rows.length).toBe(before + 1);
    expect(rows[rows.length - 1]!.units).toBe(60);
  });
});

describe("takeover: pause / resume / auto-pause", () => {
  test("pause stamps ai_paused_at, is idempotent, resume clears it", async () => {
    const paused = await post(app, owner, "/conversations/conv-2/ai-pause");
    expect(paused.status).toBe(200);
    const pausedBody = (await paused.json()) as { conversation: { aiPausedAt: string | null } };
    expect(pausedBody.conversation.aiPausedAt).toBeTruthy();
    const stamp = convRow("conv-2").aiPausedAt as Date;
    expect(stamp).toBeInstanceOf(Date);

    const again = await post(app, owner, "/conversations/conv-2/ai-pause");
    expect(again.status).toBe(200);
    expect((convRow("conv-2").aiPausedAt as Date).getTime()).toBe(stamp.getTime());

    const resumed = await post(app, owner, "/conversations/conv-2/ai-resume");
    expect(resumed.status).toBe(200);
    const resumedBody = (await resumed.json()) as { conversation: { aiPausedAt: string | null } };
    expect(resumedBody.conversation.aiPausedAt).toBeNull();
    expect(convRow("conv-2").aiPausedAt).toBeNull();
  });

  test("cross-workspace pause/resume -> 404", async () => {
    expect((await post(app, other, "/conversations/conv-1/ai-pause")).status).toBe(404);
    expect((await post(app, other, "/conversations/conv-1/ai-resume")).status).toBe(404);
    expect((await post(app, owner, "/conversations/conv-other/ai-pause")).status).toBe(404);
  });

  test("a human inbox reply auto-pauses and its row stays author_kind human", async () => {
    expect(convRow("conv-3").aiPausedAt ?? null).toBeNull();
    const res = await app.request("/conversations/conv-3/reply", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ kind: "free_form", text: "Siap kak, saya bantu cek stoknya." }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { authorKind: string } };
    expect(body.message.authorKind).toBe("human");
    expect(convRow("conv-3").aiPausedAt).toBeInstanceOf(Date);
    // A realtime inbox update carried the takeover to other open inboxes.
    expect(updates.some((u) => u.conversationId === "conv-3")).toBe(true);
  });
});

describe("webchat store badge persistence", () => {
  test("an ai-badged delivery persists author_kind=ai; an unbadged one persists human", async () => {
    const store = createDbWebchatStore(fake.db);
    const ai = await store.deliverOutbound({
      toExternalId: "webchat-session:sess-1", text: "Jawaban dari AI.",
      idempotencyKey: "flow:support-ai:contact-1:0", authorKind: "ai",
    });
    const human = await store.deliverOutbound({
      toExternalId: "webchat-session:sess-1", text: "Balasan dari agen.",
      idempotencyKey: "flow:welcome:contact-1:0",
    });
    const aiRow = fake.rows.messages.find((m) => m.id === ai.messageId)!;
    const humanRow = fake.rows.messages.find((m) => m.id === human.messageId)!;
    expect(aiRow.authorKind).toBe("ai");
    expect(humanRow.authorKind).toBe("human");
  });
});

describe("billing aggregation with ai rows", () => {
  test("sumCostLedgerByReference stays sane across message + ai rows (incl. NULL units)", async () => {
    fake.seed("costLedger", {
      id: "led-msg", workspaceId: owner.workspaceId, channelAccountId: "acc-webchat",
      channel: "whatsapp", category: "message", country: "ID", units: 2,
      amount: "0.050000", currency: "USD", referenceId: "conv-1", createdAt: new Date(),
    });
    fake.seed("costLedger", {
      id: "led-ai-null", workspaceId: owner.workspaceId, channelAccountId: "acc-webchat",
      channel: "webchat", category: "ai", country: null, units: null,
      amount: "0.000000", currency: "USD", referenceId: "conv-1", model: "fake-model-1", createdAt: new Date(),
    });
    const totals = await sumCostLedgerByReference(fake.db, "conv-1");
    // message seed (2 units / $0.05) + analyze (150) + suggest (60) +
    // the NULL-units ai seed: NULL contributes 0 - no NaN, no crash.
    expect(totals.entries).toBe(4);
    expect(totals.units).toBe(212);
    expect(totals.totalUsd).toBe(0.05);
    expect(Number.isNaN(totals.units)).toBe(false);
    expect(Number.isNaN(totals.totalUsd)).toBe(false);
  });
});
