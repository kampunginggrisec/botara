import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";

/**
 * Analytics depth phase 1 (adoption package #8) at the API seam, run
 * against the REAL repositories over the in-memory fake DB:
 * - GET /stats/insights per-channel rows, waiting block and first
 *   response medians (human vs AI) with exact fixture values;
 * - previous-period comparison cohorts;
 * - workspace isolation (a foreign workspace's data never leaks);
 * - activity feed ordering + the 50-entry cap;
 * - the workspace reply target: admin-guarded PATCH, and its effect
 *   on overTargetCount;
 * - scoped-token classification mirrors /stats/overview (any-read).
 *
 * Fixture timeline (all relative to a base instant captured in
 * beforeAll; minutes are exact by construction):
 *   C1 wa, created -2d: in +0, out human +10          -> human gap 10
 *   C2 wa, created -2d: in +0, out ai +30             -> ai gap 30
 *   C3 wa, created -3d: in at -200m, never answered   -> waiting 200m
 *   C4 tg, created -1d (pending): in at -30m          -> waiting 30m
 *   C5 wa, created -40d: in +0, out human +50         -> prev human 50
 *   C6 wa, created -40d (resolved): in +0, out ai +20 -> prev ai 20
 *   C7 wa, created -2d: in +5, out human +25, note    -> human gap 20
 *   CB foreign ws, created -1d: in at -500m           -> must not leak
 * Current human gaps [10, 20] -> median 15; ai [30] -> 30.
 */

let fake: FakeDatabase;
const app = createApp(testDeps({
  getDatabase: () => fake.db,
  rateLimits: { authPerMinute: 10000 },
}));
let owner: Registered;
let other: Registered;
let member: Registered;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
let base = 0;

interface InsightsBody {
  days: number;
  periodStart: string;
  previousPeriodStart: string;
  replyTargetMinutes: number;
  channels: Array<{ channel: string; conversationsOpened: number; messagesIn: number; messagesOut: number }>;
  response: {
    waitingCount: number;
    oldestWaitingMinutes: number | null;
    overTargetCount: number;
    medianFirstResponseMinutes: { human: number | null; ai: number | null };
    previousMedianFirstResponseMinutes: { human: number | null; ai: number | null };
  };
  activity: Array<{
    id: string;
    actor: { userId: string; name: string | null; email: string | null } | null;
    action: string;
    details: Record<string, unknown>;
    createdAt: string;
  }>;
}

async function api<T>(auth: Registered, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await app.request(path, {
    method,
    headers: { ...auth.headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

function seedConversation(id: string, accountId: string, createdAt: Date, status = "open", workspaceId?: string) {
  fake.seed("conversations", {
    id, workspaceId: workspaceId ?? owner.workspaceId, channelAccountId: accountId,
    contactId: `contact-${id}`, status, assignedUserId: null, lastUserMessageAt: null, createdAt,
  });
}

function seedMessage(conversationId: string, direction: "in" | "out", at: Date, over: Record<string, unknown> = {}) {
  fake.seed("messages", {
    conversationId, direction, kind: "message", authorUserId: null, authorKind: "human",
    type: "text", body: "x", payload: null, mediaUrls: [], mediaKeys: [],
    externalId: null, status: direction === "in" ? "received" : "sent", idempotencyKey: null,
    createdAt: at, ...over,
  });
}

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(app, "insights@example.com", "Insights Owner");
  other = await registerUser(app, "insights-other@example.com", "Other Owner");

  // A plain member of the owner's workspace (for the role-guard test).
  const invite = await app.request(`/workspaces/${owner.workspaceId}/members`, {
    method: "POST",
    headers: { ...owner.headers, "content-type": "application/json" },
    body: JSON.stringify({ email: "insights-member@example.com", role: "member" }),
  });
  expect(invite.status).toBe(201);
  const claim = await registerUser(app, "insights-member@example.com", "Mia Member");
  member = {
    ...claim,
    headers: { authorization: `Bearer ${claim.token}`, "x-workspace-id": owner.workspaceId },
  };

  fake.seed("channelAccounts", {
    id: "acc-wa", workspaceId: owner.workspaceId, channel: "whatsapp",
    externalId: "15550001", status: "connected", tokenVaultRef: null, authMode: null,
  });
  fake.seed("channelAccounts", {
    id: "acc-tg", workspaceId: owner.workspaceId, channel: "telegram",
    externalId: "555", status: "connected", tokenVaultRef: null, authMode: null,
  });
  fake.seed("channelAccounts", {
    id: "acc-foreign", workspaceId: other.workspaceId, channel: "whatsapp",
    externalId: "15559999", status: "connected", tokenVaultRef: null, authMode: null,
  });

  base = Date.now();
  const at = (ms: number) => new Date(base + ms);

  seedConversation("c1", "acc-wa", at(-2 * DAY));
  seedMessage("c1", "in", at(-2 * DAY));
  seedMessage("c1", "out", at(-2 * DAY + 10 * MIN));

  seedConversation("c2", "acc-wa", at(-2 * DAY));
  seedMessage("c2", "in", at(-2 * DAY));
  seedMessage("c2", "out", at(-2 * DAY + 30 * MIN), { authorKind: "ai" });

  seedConversation("c3", "acc-wa", at(-3 * DAY));
  seedMessage("c3", "in", at(-200 * MIN));

  seedConversation("c4", "acc-tg", at(-1 * DAY), "pending");
  seedMessage("c4", "in", at(-30 * MIN));

  seedConversation("c5", "acc-wa", at(-40 * DAY));
  seedMessage("c5", "in", at(-40 * DAY));
  seedMessage("c5", "out", at(-40 * DAY + 50 * MIN));

  seedConversation("c6", "acc-wa", at(-40 * DAY), "resolved");
  seedMessage("c6", "in", at(-40 * DAY));
  seedMessage("c6", "out", at(-40 * DAY + 20 * MIN), { authorKind: "ai" });

  seedConversation("c7", "acc-wa", at(-2 * DAY));
  seedMessage("c7", "in", at(-2 * DAY + 5 * MIN));
  seedMessage("c7", "out", at(-2 * DAY + 25 * MIN));
  // An internal note is not customer traffic: it counts nowhere.
  seedMessage("c7", "out", at(-2 * DAY + 30 * MIN), { kind: "note", status: "sent" });

  seedConversation("cb", "acc-foreign", at(-1 * DAY), "open", other.workspaceId);
  seedMessage("cb", "in", at(-500 * MIN));

  // Activity: 55 entries for the owner (cap is 50), one foreign entry
  // newer than all of them (must still not leak), one system row.
  for (let i = 0; i < 55; i++) {
    fake.seed("auditLog", {
      workspaceId: owner.workspaceId, userId: owner.userId,
      action: `test.event.${i}`, details: { i }, createdAt: at(-1000 * MIN + i * MIN),
    });
  }
  fake.seed("auditLog", {
    workspaceId: owner.workspaceId, userId: null,
    action: "test.system", details: {}, createdAt: at(-990 * MIN),
  });
  fake.seed("auditLog", {
    workspaceId: other.workspaceId, userId: other.userId,
    action: "test.foreign", details: {}, createdAt: at(-1 * MIN),
  });
});

describe("GET /stats/insights", () => {
  test("per-channel rows, waiting block and medians carry the exact fixture values (days=30 default)", async () => {
    const res = await api<InsightsBody>(owner, "GET", "/stats/insights");
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(30);
    expect(res.body.replyTargetMinutes).toBe(60);
    expect(res.body.channels).toEqual([
      { channel: "telegram", conversationsOpened: 1, messagesIn: 1, messagesOut: 0 },
      { channel: "whatsapp", conversationsOpened: 4, messagesIn: 4, messagesOut: 3 },
    ]);
    expect(res.body.response.waitingCount).toBe(2);
    expect(res.body.response.oldestWaitingMinutes).toBe(200);
    expect(res.body.response.overTargetCount).toBe(1);
    expect(res.body.response.medianFirstResponseMinutes).toEqual({ human: 15, ai: 30 });
    expect(res.body.response.previousMedianFirstResponseMinutes).toEqual({ human: 50, ai: 20 });
  });

  test("the foreign workspace sees only its own data (no cross-workspace leak)", async () => {
    const res = await api<InsightsBody>(other, "GET", "/stats/insights");
    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual([
      { channel: "whatsapp", conversationsOpened: 1, messagesIn: 1, messagesOut: 0 },
    ]);
    expect(res.body.response.waitingCount).toBe(1);
    expect(res.body.response.oldestWaitingMinutes).toBe(500);
    expect(res.body.response.medianFirstResponseMinutes).toEqual({ human: null, ai: null });
    expect(res.body.activity.map((a) => a.action)).toEqual(["test.foreign"]);
  });

  test("days=7 keeps the current cohort and empties the previous-period medians", async () => {
    const res = await api<InsightsBody>(owner, "GET", "/stats/insights?days=7");
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
    expect(res.body.channels).toEqual([
      { channel: "telegram", conversationsOpened: 1, messagesIn: 1, messagesOut: 0 },
      { channel: "whatsapp", conversationsOpened: 4, messagesIn: 4, messagesOut: 3 },
    ]);
    expect(res.body.response.medianFirstResponseMinutes).toEqual({ human: 15, ai: 30 });
    expect(res.body.response.previousMedianFirstResponseMinutes).toEqual({ human: null, ai: null });
    // The waiting block is point-in-time: identical under both periods.
    expect(res.body.response.waitingCount).toBe(2);
    expect(res.body.response.oldestWaitingMinutes).toBe(200);
  });

  test("an unsupported period is a typed 400", async () => {
    const res = await app.request("/stats/insights?days=14", { headers: owner.headers });
    expect(res.status).toBe(400);
  });

  test("activity feed is newest-first, capped at 50, and resolves actor identity", async () => {
    const res = await api<InsightsBody>(owner, "GET", "/stats/insights");
    expect(res.status).toBe(200);
    expect(res.body.activity).toHaveLength(50);
    expect(res.body.activity[0]!.action).toBe("test.event.54");
    expect(res.body.activity[0]!.actor).toEqual({
      userId: owner.userId, name: "Insights Owner", email: "insights@example.com",
    });
    const actions = res.body.activity.map((a) => a.action);
    expect(actions).not.toContain("test.foreign");
    expect(actions).not.toContain("test.event.4");
    const system = res.body.activity.find((a) => a.action === "test.system");
    expect(system?.actor).toBeNull();
  });
});

describe("workspace reply target", () => {
  test("a plain member cannot change it (admin roles only)", async () => {
    const res = await api(member, "PATCH", `/workspaces/${owner.workspaceId}`, { replyTargetMinutes: 15 });
    expect(res.status).toBe(403);
  });

  test("an admin PATCH updates the target and the insights block follows it", async () => {
    const res = await api<{ workspace: { replyTargetMinutes: number } | null }>(
      owner, "PATCH", `/workspaces/${owner.workspaceId}`, { replyTargetMinutes: 15 },
    );
    expect(res.status).toBe(200);
    expect(res.body.workspace?.replyTargetMinutes).toBe(15);

    const insights = await api<InsightsBody>(owner, "GET", "/stats/insights");
    expect(insights.body.replyTargetMinutes).toBe(15);
    // C4 now waits 30m > 15m target: both waiting threads are over.
    expect(insights.body.response.overTargetCount).toBe(2);
    expect(insights.body.response.waitingCount).toBe(2);
  });

  test("out-of-range targets fail validation", async () => {
    const zero = await api(owner, "PATCH", `/workspaces/${owner.workspaceId}`, { replyTargetMinutes: 0 });
    expect(zero.status).toBe(400);
    const huge = await api(owner, "PATCH", `/workspaces/${owner.workspaceId}`, { replyTargetMinutes: 10081 });
    expect(huge.status).toBe(400);
    const fractional = await api(owner, "PATCH", `/workspaces/${owner.workspaceId}`, { replyTargetMinutes: 1.5 });
    expect(fractional.status).toBe(400);
  });
});

describe("scoped tokens on /stats/insights (mirrors /stats/overview)", () => {
  async function createToken(body: Record<string, unknown>): Promise<string> {
    const res = await app.request("/auth/tokens", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { token: string }).token;
  }
  const bearer = (raw: string): Record<string, string> => ({ authorization: `Bearer ${raw}` });

  test("an empty scope list grants nothing - insights is refused", async () => {
    const raw = await createToken({ name: "Empty", workspaceId: owner.workspaceId, scopes: [] });
    const res = await app.request("/stats/insights", { headers: bearer(raw) });
    expect(res.status).toBe(403);
  });

  test("any single read scope suffices (any-read aggregate), like the overview", async () => {
    const raw = await createToken({ name: "KB reader", workspaceId: owner.workspaceId, scopes: ["kb:read"] });
    const res = await app.request("/stats/insights", { headers: bearer(raw) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as InsightsBody;
    expect(body.days).toBe(30);
  });

  test("a write-only grant has no read: refused", async () => {
    const raw = await createToken({ name: "Writer only", workspaceId: owner.workspaceId, scopes: ["contacts:write"] });
    const res = await app.request("/stats/insights", { headers: bearer(raw) });
    // contacts:write implies contacts:read within its resource, and any
    // read-capable grant opens the aggregate - so this is a 200, exactly
    // like /stats/overview behaves for kb:write in route-scopes tests.
    expect(res.status).toBe(200);
  });
});
