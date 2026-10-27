import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";

/**
 * Quoted replies (migration 0019): GET /conversations/:id/messages must
 * carry each message's replyToExternalId and resolve a quotedMessage
 * preview ONLY against rows in the SAME conversation - a reference to
 * an unknown provider id, or to a message in another thread, stays
 * unresolved (quotedMessage null) while the reference itself travels.
 * Runs the real route + serializer over the fake Database.
 */

let fake: FakeDatabase;
const app = createApp(testDeps({ getDatabase: () => fake.db }));
let owner: Registered;

const LONG_BODY = "x".repeat(200);

function seedThread(workspaceId: string) {
  fake.seed("channelAccounts", {
    id: "acc-wa", workspaceId, channel: "whatsapp",
    externalId: "10987", status: "connected", tokenVaultRef: null, authMode: null,
  });
  fake.seed("contacts", {
    id: "contact-1", workspaceId, channel: "whatsapp",
    externalId: "62812", displayName: "Rina", tags: [], customFields: {},
  });
  for (const id of ["conv-1", "conv-2"]) {
    fake.seed("conversations", {
      id, workspaceId, channelAccountId: "acc-wa",
      contactId: "contact-1", status: "open", assignedUserId: null,
      lastUserMessageAt: new Date(),
    });
  }
  const at = new Date();
  const msg = (row: Record<string, unknown>) => fake.seed("messages", {
    kind: "message", authorKind: "human", authorUserId: null, type: "text",
    status: "delivered", mediaUrls: [], mediaKeys: [], payload: null,
    idempotencyKey: null, createdAt: at, ...row,
  });
  msg({ id: "m-out", conversationId: "conv-1", direction: "out", body: "Siap. Terima kasih", externalId: "wamid.ORIG" });
  msg({ id: "m-long", conversationId: "conv-1", direction: "out", body: LONG_BODY, externalId: "wamid.LONG" });
  msg({ id: "m-media", conversationId: "conv-1", direction: "out", type: "media", body: null, externalId: "wamid.MEDIA" });
  msg({ id: "m-in-quote", conversationId: "conv-1", direction: "in", body: "Sama sami", externalId: "wamid.REPLY", replyToExternalId: "wamid.ORIG" });
  msg({ id: "m-in-quote-long", conversationId: "conv-1", direction: "in", body: "panjang juga", externalId: "wamid.REPLY-LONG", replyToExternalId: "wamid.LONG" });
  msg({ id: "m-in-quote-media", conversationId: "conv-1", direction: "in", body: "ini fotonya", externalId: "wamid.REPLY-MEDIA", replyToExternalId: "wamid.MEDIA" });
  msg({ id: "m-in-quote-missing", conversationId: "conv-1", direction: "in", body: "yang tadi mana?", externalId: "wamid.REPLY-GONE", replyToExternalId: "wamid.GONE" });
  msg({ id: "m-in-plain", conversationId: "conv-1", direction: "in", body: "halo", externalId: "wamid.PLAIN" });
  // The quoted original (wamid.ORIG) lives in conv-1 ONLY: a reply in
  // conv-2 pointing at the same provider id must NOT resolve.
  msg({ id: "m-other-quote", conversationId: "conv-2", direction: "in", body: "ikut nimbrung", externalId: "wamid.OTHER", replyToExternalId: "wamid.ORIG" });
}

interface WireMessage {
  id: string;
  replyToExternalId: string | null;
  quotedMessage: { externalId: string; direction: string; body: string | null } | null;
}

async function listThread(conversationId: string): Promise<WireMessage[]> {
  const res = await app.request(`/conversations/${conversationId}/messages`, { headers: owner.headers });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { messages: WireMessage[] };
  return body.messages;
}

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(app, "quoted-owner@example.com");
  seedThread(owner.workspaceId);
});

describe("GET /conversations/:id/messages quoted replies", () => {
  test("a quote of a stored message resolves to a preview", async () => {
    const messages = await listThread("conv-1");
    const reply = messages.find((m) => m.id === "m-in-quote")!;
    expect(reply.replyToExternalId).toBe("wamid.ORIG");
    expect(reply.quotedMessage).toEqual({
      externalId: "wamid.ORIG", direction: "out", body: "Siap. Terima kasih",
    });
  });

  test("a long quoted body is truncated to 120 chars", async () => {
    const messages = await listThread("conv-1");
    const reply = messages.find((m) => m.id === "m-in-quote-long")!;
    expect(reply.quotedMessage?.body).toBe(LONG_BODY.slice(0, 120));
    expect(reply.quotedMessage?.body).toHaveLength(120);
  });

  test("a media-only quoted original previews with a null body", async () => {
    const messages = await listThread("conv-1");
    const reply = messages.find((m) => m.id === "m-in-quote-media")!;
    expect(reply.quotedMessage).toEqual({
      externalId: "wamid.MEDIA", direction: "out", body: null,
    });
  });

  test("an unknown reference stays unresolved but the reference travels", async () => {
    const messages = await listThread("conv-1");
    const reply = messages.find((m) => m.id === "m-in-quote-missing")!;
    expect(reply.replyToExternalId).toBe("wamid.GONE");
    expect(reply.quotedMessage).toBeNull();
  });

  test("a plain message carries null reference and null preview", async () => {
    const messages = await listThread("conv-1");
    const plain = messages.find((m) => m.id === "m-in-plain")!;
    expect(plain.replyToExternalId).toBeNull();
    expect(plain.quotedMessage).toBeNull();
  });

  test("a reference into ANOTHER conversation never resolves", async () => {
    const messages = await listThread("conv-2");
    const reply = messages.find((m) => m.id === "m-other-quote")!;
    expect(reply.replyToExternalId).toBe("wamid.ORIG");
    expect(reply.quotedMessage).toBeNull();
  });
});
