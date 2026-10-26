import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";
import type { RealtimePublisher } from "./realtime-publish";

/**
 * Package #2 at the API surface:
 *  - saved replies: workspace-scoped CRUD, title ordering, canonical
 *    "/"-prefixed shortcuts unique per workspace (409 CONFLICT), and a
 *    saved body with {{variables}} rendering through the reply path;
 *  - internal notes: persisted as kind "note" rows with an author,
 *    returned in the thread, published on the realtime bus - and NEVER
 *    sent (no second/delivery row, no idempotency key) nor leaked to
 *    the customer-facing webchat listing.
 */

let fake: FakeDatabase;
const published: Array<{ workspaceId: string; conversationId: string; direction: string; messageId?: string }> = [];
const recordingPublisher: RealtimePublisher = {
  async publishInboxMessage(event) {
    published.push(event);
  },
  async publishInboxUpdate() {},
};
const app = createApp(testDeps({
  getDatabase: () => fake.db,
  realtimePublisher: recordingPublisher,
}));
let owner: Registered;
let other: Registered;

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(app, "pkg2-owner@example.com");
  other = await registerUser(app, "pkg2-other@example.com");
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
  fake.seed("conversations", {
    id: "conv-1", workspaceId: ws, channelAccountId: "acc-webchat",
    contactId: "contact-1", status: "open", assignedUserId: null,
    lastUserMessageAt: new Date(),
  });
  fake.seed("webchatSessions", {
    id: "sess-1", workspaceId: ws, token: "visitor-token-1",
    contactId: "contact-1", conversationId: "conv-1",
    visitorName: "Sari", lastSeenAt: new Date(),
  });
  // A conversation in the OTHER workspace (cross-workspace note target).
  fake.seed("conversations", {
    id: "conv-other", workspaceId: other.workspaceId, channelAccountId: "acc-webchat",
    contactId: "contact-1", status: "open", assignedUserId: null,
    lastUserMessageAt: new Date(),
  });
});

const jsonHeaders = (r: Registered) => ({ ...r.headers, "content-type": "application/json" });

interface SavedReplyBody {
  savedReply: {
    id: string; title: string; body: string; shortcut: string | null;
    createdBy: string; createdAt: string; updatedAt: string;
  };
}

async function createSavedReply(
  r: Registered,
  input: { title: string; body: string; shortcut?: string | null },
): Promise<Response> {
  return app.request("/saved-replies", {
    method: "POST",
    headers: jsonHeaders(r),
    body: JSON.stringify(input),
  });
}

describe("saved replies CRUD", () => {
  test("create normalizes the shortcut to a /-prefixed token and stamps the author", async () => {
    const res = await createSavedReply(owner, {
      title: "Salam pembuka", body: "Halo {{contact.name}}, terima kasih sudah menghubungi kami!", shortcut: "halo",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as SavedReplyBody;
    expect(body.savedReply.shortcut).toBe("/halo");
    expect(body.savedReply.createdBy).toBe(owner.userId);
    expect(fake.rows.savedReplies).toHaveLength(1);
    expect(fake.rows.savedReplies[0]!.workspaceId).toBe(owner.workspaceId);
  });

  test("list is ordered by title and scoped to the caller's workspace", async () => {
    await createSavedReply(owner, { title: "Zebra closing", body: "Sampai jumpa!" });
    await createSavedReply(owner, { title: "Alpha info", body: "Info produk..." });
    const res = await app.request("/saved-replies", { headers: owner.headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { savedReplies: Array<{ title: string }> };
    expect(body.savedReplies.map((r) => r.title)).toEqual(["Alpha info", "Salam pembuka", "Zebra closing"]);

    const otherRes = await app.request("/saved-replies", { headers: other.headers });
    const otherBody = (await otherRes.json()) as { savedReplies: unknown[] };
    expect(otherBody.savedReplies).toEqual([]);
  });

  test("duplicate shortcut in the same workspace is a typed 409 CONFLICT", async () => {
    const res = await createSavedReply(owner, { title: "Duplikat", body: "Isi lain", shortcut: "/halo" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFLICT");
    // The same shortcut in ANOTHER workspace is fine.
    const ok = await createSavedReply(other, { title: "Milik sebelah", body: "Halo!", shortcut: "/halo" });
    expect(ok.status).toBe(201);
  });

  test("rows without a shortcut never clash; blank title/body are 400 VALIDATION", async () => {
    expect((await createSavedReply(owner, { title: "Tanpa shortcut 1", body: "A" })).status).toBe(201);
    expect((await createSavedReply(owner, { title: "Tanpa shortcut 2", body: "B", shortcut: "  " })).status).toBe(201);
    const blank = await createSavedReply(owner, { title: "   ", body: "isi" });
    expect(blank.status).toBe(400);
    expect(((await blank.json()) as { error: { code: string } }).error.code).toBe("VALIDATION");
  });

  test("patch updates fields, rejects a clashing shortcut, and null clears it", async () => {
    const created = (await (await createSavedReply(owner, {
      title: "Patch me", body: "Versi 1", shortcut: "/patch",
    })).json()) as SavedReplyBody;
    const id = created.savedReply.id;

    const clash = await app.request(`/saved-replies/${id}`, {
      method: "PATCH", headers: jsonHeaders(owner),
      body: JSON.stringify({ shortcut: "/halo" }),
    });
    expect(clash.status).toBe(409);

    const res = await app.request(`/saved-replies/${id}`, {
      method: "PATCH", headers: jsonHeaders(owner),
      body: JSON.stringify({ body: "Versi 2", shortcut: null }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SavedReplyBody;
    expect(body.savedReply.body).toBe("Versi 2");
    expect(body.savedReply.shortcut).toBeNull();
    expect(body.savedReply.title).toBe("Patch me");
  });

  test("cross-workspace patch/delete are 404 and delete is final", async () => {
    const mine = fake.rows.savedReplies.find((r) => r.title === "Salam pembuka")!;
    const patch = await app.request(`/saved-replies/${mine.id}`, {
      method: "PATCH", headers: jsonHeaders(other),
      body: JSON.stringify({ title: "Dibajak" }),
    });
    expect(patch.status).toBe(404);
    const del = await app.request(`/saved-replies/${mine.id}`, {
      method: "DELETE", headers: other.headers,
    });
    expect(del.status).toBe(404);
    expect(fake.rows.savedReplies.some((r) => r.id === mine.id)).toBe(true);

    const own = await app.request(`/saved-replies/${mine.id}`, {
      method: "DELETE", headers: owner.headers,
    });
    expect(own.status).toBe(200);
    expect(((await own.json()) as { deleted: boolean }).deleted).toBe(true);
    const again = await app.request(`/saved-replies/${mine.id}`, {
      method: "DELETE", headers: owner.headers,
    });
    expect(again.status).toBe(404);
  });

  test("a saved reply with {{variables}} renders through the reply path", async () => {
    const created = (await (await createSavedReply(owner, {
      title: "Sapaan variabel", body: "Halo {{contact.name}} dari {{workspace.name}}!",
    })).json()) as SavedReplyBody;
    const res = await app.request("/conversations/conv-1/reply", {
      method: "POST",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ kind: "free_form", text: created.savedReply.body }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { body: string } };
    expect(body.message.body).toBe("Halo Sari Wulandari dari Toko Uji!");
  });
});

describe("internal notes", () => {
  test("a note persists as kind=note with its author, publishes realtime, and is never sent", async () => {
    const before = fake.rows.messages.length;
    const eventsBefore = published.length;
    const res = await app.request("/conversations/conv-1/notes", {
      method: "POST",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ body: "Pelanggan ini menunggu invoice revisi." }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      message: {
        id: string; kind: string; direction: string; status: string; body: string;
        authorUserId: string; author: { userId: string; name: string | null } | null;
      };
    };
    expect(body.message.kind).toBe("note");
    expect(body.message.direction).toBe("out");
    expect(body.message.authorUserId).toBe(owner.userId);
    expect(body.message.author?.userId).toBe(owner.userId);
    expect(body.message.author?.name).toBe("Owner");

    // Exactly ONE row was added - the note itself. A real send through
    // the reply path would carry an idempotency key and (for webchat)
    // a delivery row; the note has neither and touches no adapter.
    const added = fake.rows.messages.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]!.kind).toBe("note");
    expect(added[0]!.idempotencyKey).toBeUndefined();
    expect(added[0]!.status).toBe("sent");

    // Same realtime event shape as a message (open threads refetch).
    expect(published.length).toBe(eventsBefore + 1);
    expect(published[published.length - 1]).toEqual({
      workspaceId: owner.workspaceId, conversationId: "conv-1",
      direction: "out", messageId: body.message.id,
    });
  });

  test("the thread returns the note with kind and author identity", async () => {
    const res = await app.request("/conversations/conv-1/messages", { headers: owner.headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ kind?: string; body: string | null; author: { name: string | null } | null }>;
    };
    const note = body.messages.find((m) => m.kind === "note");
    expect(note?.body).toBe("Pelanggan ini menunggu invoice revisi.");
    expect(note?.author?.name).toBe("Owner");
  });

  test("the customer-facing webchat listing never contains the note", async () => {
    const res = await app.request(`/public/webchat/${owner.workspaceId}/messages`, {
      headers: { "x-webchat-session": "visitor-token-1" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ body: string | null; kind?: string }> };
    expect(body.messages.some((m) => m.body?.includes("invoice revisi"))).toBe(false);
    expect(body.messages.every((m) => m.kind !== "note")).toBe(true);
    // The rendered agent reply from the saved-reply test IS visible.
    expect(body.messages.some((m) => m.body === "Halo Sari Wulandari dari Toko Uji!")).toBe(true);
  });

  test("a note on another workspace's conversation is a 404; blank notes are 400", async () => {
    const cross = await app.request("/conversations/conv-other/notes", {
      method: "POST",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ body: "Tidak boleh masuk." }),
    });
    expect(cross.status).toBe(404);
    const blank = await app.request("/conversations/conv-1/notes", {
      method: "POST",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ body: "   " }),
    });
    expect(blank.status).toBe(400);
    expect(((await blank.json()) as { error: { code: string } }).error.code).toBe("VALIDATION");
  });
});
