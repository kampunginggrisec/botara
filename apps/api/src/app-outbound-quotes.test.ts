import { beforeAll, describe, expect, test } from "bun:test";
import {
  CHANNEL_CAPABILITIES, registerAdapter,
  type AdapterHealth, type ChannelAccountRef, type ChannelAdapter,
  type InboundEvent, type SendInput, type SendResult,
} from "@botara/channels";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";

/**
 * Outbound quoted replies at the API surface (follow-up to migration
 * 0019's inbound capture):
 *  - a valid same-thread quote target is resolved server-side, handed to
 *    the adapter as `replyToExternalId` (the WhatsApp adapter turns it
 *    into Meta's `context.message_id`), AND persisted on the outbound
 *    message row so our own thread renders the quote block;
 *  - a target from ANOTHER conversation is a typed 404 and nothing sends;
 *  - no target -> the send input and the row carry no reference.
 *
 * The WhatsApp adapter is replaced with a recording fake through the
 * channel registry - the same seam process wiring uses - so the test
 * observes the exact SendInput the route hands to the adapter.
 */

class RecordingWhatsAppAdapter implements ChannelAdapter {
  readonly key = "whatsapp" as const;
  readonly apiVersion = "v26.0";
  readonly capabilities = CHANNEL_CAPABILITIES.whatsapp;
  readonly sends: SendInput[] = [];

  async connect(): Promise<ChannelAccountRef> { throw new Error("not used by this test"); }
  async disconnect(): Promise<void> { /* no-op */ }
  async refreshTokenIfNeeded(): Promise<{ refreshed: boolean }> { return { refreshed: false }; }
  async send(input: SendInput): Promise<SendResult> {
    this.sends.push(input);
    return { externalMessageId: "wamid.OUT-1", status: "sent" };
  }
  async parseWebhook(): Promise<InboundEvent[]> { return []; }
  async health(): Promise<AdapterHealth> { return { ok: true, detail: "recording fake" }; }
}

const waAdapter = new RecordingWhatsAppAdapter();
registerAdapter(waAdapter);

let fake: FakeDatabase;
const app = createApp(testDeps({ getDatabase: () => fake.db }));
let owner: Registered;

const jsonHeaders = (r: Registered) => ({ ...r.headers, "content-type": "application/json" });

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(app, "outbound-quotes-owner@example.com");
  const ws = owner.workspaceId;
  fake.seed("workspaces", { id: ws, name: "Toko Quote", slug: "toko-quote" });
  fake.seed("channelAccounts", {
    id: "acc-wa", workspaceId: ws, channel: "whatsapp",
    externalId: "628111222333", displayName: "WA Bisnis", status: "connected",
    tokenVaultRef: null, authMode: null,
  });
  fake.seed("contacts", {
    id: "contact-1", workspaceId: ws, channel: "whatsapp",
    externalId: "628579990001", displayName: "Budi", tags: [], customFields: {},
  });
  fake.seed("conversations", {
    id: "conv-wa", workspaceId: ws, channelAccountId: "acc-wa",
    contactId: "contact-1", status: "open", assignedUserId: null,
    lastUserMessageAt: new Date(),
  });
  fake.seed("conversations", {
    id: "conv-wa-2", workspaceId: ws, channelAccountId: "acc-wa",
    contactId: "contact-1", status: "open", assignedUserId: null,
    lastUserMessageAt: new Date(),
  });
  fake.seed("messages", {
    id: "msg-in", workspaceId: ws, conversationId: "conv-wa", direction: "in",
    kind: "message", type: "text", body: "Stok masih ada?", status: "received",
    externalId: "wamid.IN-1", authorKind: "human", createdAt: new Date("2026-10-27T02:00:00Z"),
  });
  // Same shape in ANOTHER conversation: quoting must not cross threads.
  fake.seed("messages", {
    id: "msg-foreign", workspaceId: ws, conversationId: "conv-wa-2", direction: "in",
    kind: "message", type: "text", body: "Halo dari thread lain", status: "received",
    externalId: "wamid.FOREIGN", authorKind: "human", createdAt: new Date("2026-10-27T02:01:00Z"),
  });
});

describe("outbound quoted replies (WhatsApp)", () => {
  test("valid same-thread target: adapter receives replyToExternalId and the outbound row persists it", async () => {
    const res = await app.request("/conversations/conv-wa/reply", {
      method: "POST",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ kind: "free_form", text: "Masih ada kak", replyToMessageId: "msg-in" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { message: { replyToExternalId?: string | null } };
    expect(body.message.replyToExternalId).toBe("wamid.IN-1");

    // Pipeline: the send handed to the adapter carries the provider id.
    expect(waAdapter.sends).toHaveLength(1);
    expect(waAdapter.sends[0]!.replyToExternalId).toBe("wamid.IN-1");

    // Persistence: the stored outbound row carries the reference (and the
    // provider id the adapter returned), so a refetch renders the quote.
    const outRows = fake.rows.messages.filter((m) => m.conversationId === "conv-wa" && m.direction === "out");
    expect(outRows).toHaveLength(1);
    expect(outRows[0]!.replyToExternalId).toBe("wamid.IN-1");
    expect(outRows[0]!.externalId).toBe("wamid.OUT-1");
    expect(outRows[0]!.status).toBe("sent");

    // Read-back: the serializer resolves the quote preview on OUR bubble.
    const list = await app.request("/conversations/conv-wa/messages", { headers: owner.headers });
    expect(list.status).toBe(200);
    const data = await list.json() as {
      messages: Array<{ id: string; replyToExternalId: string | null; quotedMessage: { externalId: string; body: string | null } | null }>;
    };
    const sent = data.messages.find((m) => m.id === outRows[0]!.id);
    expect(sent?.replyToExternalId).toBe("wamid.IN-1");
    expect(sent?.quotedMessage?.externalId).toBe("wamid.IN-1");
    expect(sent?.quotedMessage?.body).toBe("Stok masih ada?");
  });

  test("foreign-conversation target: typed 404, nothing is sent or persisted", async () => {
    const sendsBefore = waAdapter.sends.length;
    const res = await app.request("/conversations/conv-wa/reply", {
      method: "POST",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ kind: "free_form", text: "halo", replyToMessageId: "msg-foreign" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(waAdapter.sends).toHaveLength(sendsBefore);
    const outRows = fake.rows.messages.filter((m) => m.conversationId === "conv-wa" && m.direction === "out");
    expect(outRows).toHaveLength(1); // still only the row from the first test
  });

  test("no quote target: send and row carry no reference (unchanged behavior)", async () => {
    const res = await app.request("/conversations/conv-wa/reply", {
      method: "POST",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ kind: "free_form", text: "tanpa kutipan" }),
    });
    expect(res.status).toBe(200);
    const last = waAdapter.sends[waAdapter.sends.length - 1]!;
    expect(last.replyToExternalId).toBeUndefined();
    const outRows = fake.rows.messages.filter((m) => m.conversationId === "conv-wa" && m.direction === "out");
    expect(outRows).toHaveLength(2);
    expect(outRows[1]!.replyToExternalId ?? null).toBeNull();
  });
});
