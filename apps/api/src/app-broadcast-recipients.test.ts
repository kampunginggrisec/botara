import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";

/**
 * Broadcast recipient records (package #4): the per-recipient list with
 * whole-broadcast counts, status filtering, pagination, workspace
 * scoping, and resend-failed semantics (reset -> enqueue restricted to
 * the failed contacts; enqueue failure rolls the rows back to failed).
 */

let fake: FakeDatabase;
const enqueued: Array<{ broadcastId: string; contactIds?: string[]; resendToken?: string }> = [];
let enqueueShouldFail = false;
const enqueuer = {
  async enqueueBroadcast(broadcastId: string, opts?: { contactIds: string[]; resendToken: string }) {
    if (enqueueShouldFail) throw new Error("redis down");
    enqueued.push({ broadcastId, contactIds: opts?.contactIds, resendToken: opts?.resendToken });
  },
};
const app = createApp(testDeps({ getDatabase: () => fake.db, broadcastEnqueuer: enqueuer }));
let owner: Registered;
let other: Registered;

const T0 = new Date("2026-10-26T10:00:00.000Z");

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(app, "bc-owner@example.com");
  other = await registerUser(app, "bc-other@example.com");
  const ws = owner.workspaceId;
  const wsOther = other.workspaceId;
  fake.seed("workspaces", { id: ws, name: "Toko Satu", slug: "toko-satu" });
  fake.seed("workspaces", { id: wsOther, name: "Toko Dua", slug: "toko-dua" });
  fake.seed("channelAccounts", {
    id: "acc-wa", workspaceId: ws, channel: "whatsapp",
    externalId: "628000111", displayName: "WA Bisnis", status: "connected",
    tokenVaultRef: null, authMode: null,
  });
  for (const [id, externalId, displayName] of [
    ["ct-andi", "628111", "Andi"],
    ["ct-rina", "628222", "Rina"],
    ["ct-bima", "628333", "Bima"],
  ] as const) {
    fake.seed("contacts", {
      id, workspaceId: ws, channel: "whatsapp", externalId, displayName,
      tags: [], customFields: {},
    });
  }
  fake.seed("broadcasts", {
    id: "b1", workspaceId: ws, channelAccountId: "acc-wa", templateId: null,
    templateParams: ["Halo {{contact.name}}"], name: "Promo", tag: "vip", country: "ID",
    recipientCount: 3, status: "sent", sentCount: 2, failedCount: 1,
    estimatedCostUsd: 0.1, ratesVersion: "sample-2026-q4", createdAt: T0,
  });
  fake.seed("broadcasts", {
    id: "b-other", workspaceId: wsOther, channelAccountId: "acc-other", templateId: null,
    templateParams: null, name: "Punya Tetangga", tag: null, country: "ID",
    recipientCount: 0, status: "sent", sentCount: 0, failedCount: 0,
    estimatedCostUsd: 0, ratesVersion: "sample-2026-q4", createdAt: T0,
  });
  const recipient = (over: Record<string, unknown>) => fake.seed("broadcastRecipients", {
    broadcastId: "b1", workspaceId: ws, providerMessageId: null, messageId: null,
    error: null, sentAt: null, deliveredAt: null, readAt: null, repliedAt: null,
    createdAt: T0, updatedAt: T0, ...over,
  });
  recipient({ id: "r-sent", contactId: "ct-andi", status: "delivered", providerMessageId: "wamid.1", sentAt: T0, deliveredAt: T0 });
  recipient({ id: "r-failed", contactId: "ct-rina", status: "failed", error: "provider down" });
  recipient({ id: "r-read", contactId: "ct-bima", status: "read", providerMessageId: "wamid.3", sentAt: T0, deliveredAt: T0, readAt: T0 });
});

async function getJson(reg: Registered, path: string) {
  const res = await app.request(path, { headers: reg.headers });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /broadcasts/:id/recipients", () => {
  test("rows carry contact display info; counts describe the whole broadcast", async () => {
    const { res, body } = await getJson(owner, "/broadcasts/b1/recipients");
    expect(res.status).toBe(200);
    expect(body.counts).toEqual({
      pending: 0, sent: 0, delivered: 1, read: 1, replied: 0, failed: 1, total: 3,
    });
    expect(body.total).toBe(3);
    const rows = body.recipients as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    const failed = rows.find((r) => r.id === "r-failed")!;
    expect(failed).toMatchObject({
      status: "failed", error: "provider down", contactDisplayName: "Rina", contactExternalId: "628222",
    });
    const delivered = rows.find((r) => r.id === "r-sent")!;
    expect(delivered.providerMessageId).toBe("wamid.1");
    expect(delivered.sentAt).toBe(T0.toISOString());
  });

  test("status filter narrows rows but not the counts", async () => {
    const { res, body } = await getJson(owner, "/broadcasts/b1/recipients?status=failed");
    expect(res.status).toBe(200);
    expect(body.total).toBe(1);
    expect((body.recipients as Array<{ id: string }>).map((r) => r.id)).toEqual(["r-failed"]);
    expect((body.counts as { total: number }).total).toBe(3);
  });

  test("limit/offset paginate the (filtered) rows", async () => {
    const page1 = await getJson(owner, "/broadcasts/b1/recipients?limit=2");
    expect((page1.body.recipients as unknown[]).length).toBe(2);
    const page2 = await getJson(owner, "/broadcasts/b1/recipients?limit=2&offset=2");
    expect((page2.body.recipients as unknown[]).length).toBe(1);
    expect(page2.body.total).toBe(3);
  });

  test("a cross-workspace broadcast is a 404, indistinguishable from missing", async () => {
    const { res } = await getJson(owner, "/broadcasts/b-other/recipients");
    expect(res.status).toBe(404);
    const missing = await getJson(owner, "/broadcasts/nope/recipients");
    expect(missing.res.status).toBe(404);
  });
});

describe("POST /broadcasts/:id/resend-failed", () => {
  test("resets and re-queues ONLY the failed recipients", async () => {
    const res = await app.request("/broadcasts/b1/resend-failed", {
      method: "POST", headers: owner.headers,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resent: 1 });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.broadcastId).toBe("b1");
    expect(enqueued[0]!.contactIds).toEqual(["ct-rina"]);
    expect(typeof enqueued[0]!.resendToken).toBe("string");
    const row = fake.rows.broadcastRecipients.find((r) => r.id === "r-failed")!;
    expect(row.status).toBe("pending");
    expect(row.error).toBeNull();
    // Untouched rows stay exactly as they were.
    expect(fake.rows.broadcastRecipients.find((r) => r.id === "r-sent")!.status).toBe("delivered");
    expect(fake.rows.broadcastRecipients.find((r) => r.id === "r-read")!.status).toBe("read");
  });

  test("zero failed recipients is { resent: 0 }, not an error, and enqueues nothing", async () => {
    const res = await app.request("/broadcasts/b1/resend-failed", {
      method: "POST", headers: owner.headers,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resent: 0 });
    expect(enqueued).toHaveLength(1); // unchanged
  });

  test("cross-workspace resend is a 404", async () => {
    const res = await app.request("/broadcasts/b-other/resend-failed", {
      method: "POST", headers: owner.headers,
    });
    expect(res.status).toBe(404);
  });

  test("an enqueue failure rolls the rows back to failed with the reason", async () => {
    fake.seed("broadcastRecipients", {
      id: "r-failed-2", broadcastId: "b1", workspaceId: owner.workspaceId,
      contactId: "ct-andi", status: "failed", error: "boom",
      providerMessageId: null, messageId: null,
      sentAt: null, deliveredAt: null, readAt: null, repliedAt: null,
      createdAt: T0, updatedAt: T0,
    });
    enqueueShouldFail = true;
    try {
      const res = await app.request("/broadcasts/b1/resend-failed", {
        method: "POST", headers: owner.headers,
      });
      expect(res.status).toBe(500);
    } finally {
      enqueueShouldFail = false;
    }
    const row = fake.rows.broadcastRecipients.find((r) => r.id === "r-failed-2")!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("Resend could not be queued - try again.");
  });
});
