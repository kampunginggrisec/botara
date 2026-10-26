import { beforeAll, describe, expect, test } from "bun:test";
import {
  createBroadcast, createChannelAccount, createContact, createConversation,
} from "@botara/db";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";

/**
 * Parity-fix routes (API↔UI audit 2026-10-26):
 * - GET /contacts/{id} completes the contacts resource (F1/R4) and the
 *   conversation payload now carries contactId + contactTags (B4);
 * - GET /broadcasts lists a workspace's broadcasts with delivery counts
 *   and realized cost (F5/B3) — none existed before;
 * - GET /admin/connection-info serves the callback-URL reference (F11),
 *   platform-admin only, token KEY NAMES only (never values);
 * - POST /moderation/check sits behind session auth now (B2): 401
 *   unauthenticated, 200 for a signed-in operator.
 */

let fake: FakeDatabase;

const app = createApp(testDeps({
  getDatabase: () => fake.db,
  env: {
    WHATSAPP_VERIFY_TOKEN: "verify-me",
    SESSION_SECRET: "test-session-secret",
    PUBLIC_WEBHOOK_BASE_URL: "https://hooks.example.test/api",
  },
}));

let admin: Registered;
let other: Registered;
let contactId: string;
let conversationId: string;
let whatsappAccountId: string;
let telegramAccountId: string;

beforeAll(async () => {
  fake = createFakeDatabase();
  // First registered user is the platform admin (bootstrap rule).
  admin = await registerUser(app, "parity-admin@example.com", "Pat Admin");
  other = await registerUser(app, "parity-other@example.com", "Pat Other");

  const created = await app.request("/contacts", {
    method: "POST",
    headers: { ...admin.headers, "content-type": "application/json" },
    body: JSON.stringify({
      channel: "whatsapp",
      externalId: "6281234567890",
      displayName: "Sari",
      tags: ["vip", "jakarta"],
      customFields: { city: "Jakarta" },
    }),
  });
  expect(created.status).toBe(201);
  contactId = ((await created.json()) as { contact: { id: string } }).contact.id;

  const account = await createChannelAccount(fake.db, {
    workspaceId: admin.workspaceId, channel: "whatsapp", externalId: "628999000111",
  });
  whatsappAccountId = account.id;
  const telegramAccount = await createChannelAccount(fake.db, {
    workspaceId: admin.workspaceId, channel: "telegram", externalId: "8808425227",
    displayName: "@botaramyid_bot",
  });
  telegramAccountId = telegramAccount.id;
  const conversation = await createConversation(fake.db, {
    workspaceId: admin.workspaceId, channelAccountId: account.id, contactId,
  });
  conversationId = conversation.id;

  // Two broadcasts for the admin workspace (newest last), one foreign.
  const first = await createBroadcast(fake.db, {
    workspaceId: admin.workspaceId, channelAccountId: account.id,
    name: "First", recipientCount: 10, status: "sent",
  });
  const second = await createBroadcast(fake.db, {
    workspaceId: admin.workspaceId, channelAccountId: account.id,
    name: "Second", recipientCount: 5, status: "queued",
  });
  // Fake insert stamps both rows within the same millisecond: pin the
  // timestamps (and the counters the fake leaves unset) explicitly so
  // the newest-first ordering is deterministic.
  const firstRow = fake.rows.broadcasts.find((r) => r.id === first.id)!;
  firstRow.createdAt = new Date("2026-10-20T00:00:00.000Z");
  const row = fake.rows.broadcasts.find((r) => r.id === second.id)!;
  row.createdAt = new Date("2026-10-21T00:00:00.000Z");
  row.sentCount = 4;
  row.failedCount = 1;
  const foreignAccount = await createChannelAccount(fake.db, {
    workspaceId: other.workspaceId, channel: "whatsapp", externalId: "1555000111",
  });
  await createBroadcast(fake.db, {
    workspaceId: other.workspaceId, channelAccountId: foreignAccount.id,
    name: "Foreign", recipientCount: 3, status: "sent",
  });
});

describe("GET /contacts/{id} (F1/R4)", () => {
  test("returns the contact with tags + custom fields", async () => {
    const res = await app.request(`/contacts/${contactId}`, { headers: admin.headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      contact: { id: string; displayName: string; tags: string[]; customFields: Record<string, unknown> };
    };
    expect(body.contact.id).toBe(contactId);
    expect(body.contact.displayName).toBe("Sari");
    expect(body.contact.tags).toEqual(["vip", "jakarta"]);
    expect(body.contact.customFields).toEqual({ city: "Jakarta" });
  });

  test("another workspace's contact is a 404, unknown id is a 404", async () => {
    const cross = await app.request(`/contacts/${contactId}`, { headers: other.headers });
    expect(cross.status).toBe(404);
    const missing = await app.request("/contacts/00000000-0000-0000-0000-000000000000", { headers: admin.headers });
    expect(missing.status).toBe(404);
  });
});

describe("conversation payload carries contact identity (B4)", () => {
  test("list rows include contactId + contactTags", async () => {
    const res = await app.request("/conversations", { headers: admin.headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ id: string; contactId: string; contactTags: string[] }>;
    };
    const row = body.conversations.find((c) => c.id === conversationId);
    expect(row).toBeDefined();
    expect(row!.contactId).toBe(contactId);
    expect(row!.contactTags).toEqual(["vip", "jakarta"]);
  });
});

describe("GET /broadcasts (F5/B3)", () => {
  test("lists only the caller's workspace, newest first, with counts + cost", async () => {
    const res = await app.request("/broadcasts", { headers: admin.headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      broadcasts: Array<{
        name: string; status: string; recipientCount: number;
        sentCount: number; failedCount: number; totalCostUsd: number; createdAt: string;
      }>;
    };
    expect(body.broadcasts.map((b) => b.name)).toEqual(["Second", "First"]);
    const second = body.broadcasts[0]!;
    expect(second.status).toBe("queued");
    expect(second.recipientCount).toBe(5);
    expect(second.sentCount).toBe(4);
    expect(second.failedCount).toBe(1);
    expect(second.totalCostUsd).toBe(0);
    expect(typeof second.createdAt).toBe("string");
  });

  test("the other workspace sees only its own broadcast", async () => {
    const res = await app.request("/broadcasts", { headers: other.headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { broadcasts: Array<{ name: string }> };
    expect(body.broadcasts.map((b) => b.name)).toEqual(["Foreign"]);
  });
});

describe("GET /admin/connection-info (F11)", () => {
  test("admin gets absolute URLs computed from the public base + token key names only", async () => {
    const res = await app.request("/admin/connection-info", {
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      base: string;
      webhooks: Array<{ id: string; url: string; verifyTokenKey: string | null; autoConfigured: boolean }>;
      oauthRedirects: Array<{ id: string; url: string }>;
    };
    expect(body.base).toBe("https://hooks.example.test/api");
    const byId = new Map(body.webhooks.map((w) => [w.id, w]));
    expect(byId.get("whatsapp")).toEqual({
      id: "whatsapp",
      url: "https://hooks.example.test/api/webhooks/whatsapp",
      verifyTokenKey: "WHATSAPP_VERIFY_TOKEN",
      autoConfigured: false,
    });
    expect(byId.get("messenger")?.verifyTokenKey).toBe("META_VERIFY_TOKEN");
    expect(byId.get("instagram")?.verifyTokenKey).toBe("META_VERIFY_TOKEN");
    expect(byId.get("threads")?.verifyTokenKey).toBe("THREADS_VERIFY_TOKEN");
    expect(byId.get("telegram")?.autoConfigured).toBe(true);
    expect(byId.get("telegram")?.url).toBe("https://hooks.example.test/api/webhooks/telegram");
    expect(byId.get("meta-data-deletion")?.url).toBe("https://hooks.example.test/api/webhooks/meta/data-deletion");
    expect(body.oauthRedirects).toContainEqual({
      id: "threads",
      url: "https://hooks.example.test/api/channels/threads/oauth/callback",
    });
    // No secret material anywhere in the payload.
    expect(JSON.stringify(body)).not.toContain("verify-me");
  });

  test("non-admin is 403, unauthenticated is 401", async () => {
    const forbidden = await app.request("/admin/connection-info", {
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(forbidden.status).toBe(403);
    const anon = await app.request("/admin/connection-info");
    expect(anon.status).toBe(401);
  });
});

describe("post targets: telegram destination (item H)", () => {
  const postJson = (targets: unknown, text = "Pengumuman") => ({
    method: "POST",
    headers: { ...admin.headers, "content-type": "application/json" },
    body: JSON.stringify({ text, targets }),
  });

  test("telegram target without targetExternalId is a 400 with a clear message", async () => {
    const res = await app.request("/posts", postJson([{ channelAccountId: telegramAccountId }]));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string; error?: { message?: string } };
    const message = body.message ?? body.error?.message ?? "";
    expect(message).toContain("targetExternalId");
  });

  test("telegram target with targetExternalId persists it; whatsapp target needs none", async () => {
    const res = await app.request("/posts", postJson([
      { channelAccountId: telegramAccountId, targetExternalId: "@kampungchannel" },
      { channelAccountId: whatsappAccountId },
    ]));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      post: { id: string; targets: Array<{ channel: string; targetExternalId?: string }> };
    };
    const telegram = body.post.targets.find((t) => t.channel === "telegram");
    expect(telegram?.targetExternalId).toBe("@kampungchannel");
    const whatsapp = body.post.targets.find((t) => t.channel === "whatsapp");
    expect(whatsapp?.targetExternalId).toBeUndefined();

    // PATCH round-trips a changed destination…
    const patched = await app.request(`/posts/${body.post.id}`, {
      method: "PATCH",
      headers: { ...admin.headers, "content-type": "application/json" },
      body: JSON.stringify({
        targets: [{ channelAccountId: telegramAccountId, targetExternalId: "-1001234567890" }],
      }),
    });
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as {
      post: { targets: Array<{ channelAccountId: string; channel: string; targetExternalId?: string }> };
    };
    expect(patchedBody.post.targets).toEqual([
      { channelAccountId: telegramAccountId, channel: "telegram", targetExternalId: "-1001234567890" },
    ]);

    // …and PATCH dropping the destination off a telegram target is a 400.
    const dropped = await app.request(`/posts/${body.post.id}`, {
      method: "PATCH",
      headers: { ...admin.headers, "content-type": "application/json" },
      body: JSON.stringify({ targets: [{ channelAccountId: telegramAccountId }] }),
    });
    expect(dropped.status).toBe(400);
  });
});

describe("POST /moderation/check auth (B2)", () => {
  test("unauthenticated is 401; a signed-in operator gets the verdict", async () => {
    const anon = await app.request("/moderation/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello there" }),
    });
    expect(anon.status).toBe(401);

    const ok = await app.request("/moderation/check", {
      method: "POST",
      headers: { ...admin.headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "please share the otp code", flagList: ["otp"] }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { flagged: boolean; matches: Array<{ term: string }> };
    expect(body.flagged).toBe(true);
    expect(body.matches[0]?.term).toBe("otp");
  });
});
