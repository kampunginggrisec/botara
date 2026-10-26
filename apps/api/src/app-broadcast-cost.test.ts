import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";

/**
 * Broadcast money wire types: estimated_cost_usd is a drizzle `numeric`
 * column, which postgres-js returns as a STRING ("0.100000") - the
 * serializers must normalize it to a JSON number (or null when the row
 * carries no estimate), like every other cost serializer in the
 * codebase. The seeds below store the string form on purpose: that is
 * the exact shape production rows arrive in.
 */

let fake: FakeDatabase;
const app = createApp(testDeps({ getDatabase: () => fake.db }));
let owner: Registered;

const T0 = new Date("2026-10-26T10:00:00.000Z");

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(app, "bc-cost@example.com");
  const ws = owner.workspaceId;
  fake.seed("workspaces", { id: ws, name: "Toko Biaya", slug: "toko-biaya" });
  fake.seed("channelAccounts", {
    id: "acc-wa", workspaceId: ws, channel: "whatsapp",
    externalId: "628000111", displayName: "WA Bisnis", status: "connected",
    tokenVaultRef: null, authMode: null,
  });
  fake.seed("broadcasts", {
    id: "b-est", workspaceId: ws, channelAccountId: "acc-wa", templateId: null,
    templateParams: null, name: "Ada Estimasi", tag: null, country: "ID",
    recipientCount: 10, status: "sent", sentCount: 10, failedCount: 0,
    estimatedCostUsd: "0.100000", ratesVersion: "sample-2026-q4", createdAt: T0,
  });
  fake.seed("broadcasts", {
    id: "b-null", workspaceId: ws, channelAccountId: "acc-wa", templateId: null,
    templateParams: null, name: "Tanpa Estimasi", tag: null, country: "ID",
    recipientCount: 5, status: "sent", sentCount: 5, failedCount: 0,
    estimatedCostUsd: null, ratesVersion: null, createdAt: T0,
  });
});

describe("broadcast money serialization", () => {
  test("GET /broadcasts emits estimatedCostUsd as a number, or null", async () => {
    const res = await app.request("/broadcasts", { headers: owner.headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      broadcasts: Array<{ id: string; estimatedCostUsd: unknown; totalCostUsd: unknown }>;
    };
    const est = body.broadcasts.find((b) => b.id === "b-est")!;
    expect(typeof est.estimatedCostUsd).toBe("number");
    expect(est.estimatedCostUsd).toBe(0.1);
    expect(typeof est.totalCostUsd).toBe("number");
    const none = body.broadcasts.find((b) => b.id === "b-null")!;
    expect(none.estimatedCostUsd).toBeNull();
  });

  test("GET /broadcasts/:id emits estimatedCostUsd as a number, or null", async () => {
    const res = await app.request("/broadcasts/b-est", { headers: owner.headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      broadcast: { estimatedCostUsd: unknown };
      totalCostUsd: unknown;
      costEntries: unknown;
      costUnits: unknown;
    };
    expect(typeof body.broadcast.estimatedCostUsd).toBe("number");
    expect(body.broadcast.estimatedCostUsd).toBe(0.1);
    expect(typeof body.totalCostUsd).toBe("number");
    expect(typeof body.costEntries).toBe("number");
    expect(typeof body.costUnits).toBe("number");

    const resNull = await app.request("/broadcasts/b-null", { headers: owner.headers });
    expect(resNull.status).toBe(200);
    const bodyNull = (await resNull.json()) as { broadcast: { estimatedCostUsd: unknown } };
    expect(bodyNull.broadcast.estimatedCostUsd).toBeNull();
  });

  test("POST /broadcasts 201 carries the estimate as a number too", async () => {
    const res = await app.request("/broadcasts", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ channelAccountId: "acc-wa", recipientCount: 5 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { broadcast: { estimatedCostUsd: unknown } };
    expect(typeof body.broadcast.estimatedCostUsd).toBe("number");
  });
});
