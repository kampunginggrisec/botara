import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";
import type { RealtimePublisher } from "./realtime-publish";

/**
 * Conversation status management:
 * PATCH /conversations/{id}/status + the `status` list filter, run
 * against the real routes/repositories over the fake DB.
 *
 * Covers: every legal transition (open -> pending -> resolved and the
 * resolved -> open reopen), an invalid status (400 VALIDATION, nothing
 * written, nothing published), an unknown conversation (404), the agent
 * role allowed, a non-member caller refused by the auth middleware, one
 * inbox.update publish per change carrying the new status, and the
 * status list filter alone and combined with the assignee filter.
 */

let fake: FakeDatabase;
const updates: Array<{ workspaceId: string; conversationId: string; status?: string }> = [];
const recordingPublisher: RealtimePublisher = {
  async publishInboxMessage() {},
  async publishInboxUpdate(event) { updates.push(event); },
};

const app = createApp(testDeps({
  getDatabase: () => fake.db,
  realtimePublisher: recordingPublisher,
}));

let owner: Registered;
let agent: Registered;
let agentId: string;
let outsider: Registered;

function setStatus(id: string, status: unknown, headers: Record<string, string>) {
  return app.request(`/conversations/${id}/status`, {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

function assign(id: string, userId: string | null, headers: Record<string, string>) {
  return app.request(`/conversations/${id}/assign`, {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
}

async function listIds(headers: Record<string, string>, query = "") {
  const res = await app.request(`/conversations${query}`, { headers });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { conversations: Array<{ id: string; status: string }> };
  return body.conversations.map((c) => c.id).sort();
}

const rowStatus = (id: string) => fake.rows.conversations.find((c) => c.id === id)?.status;

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(app, "status-owner@example.com", "Olivia Owner");

  const invite = await app.request(`/workspaces/${owner.workspaceId}/members`, {
    method: "POST",
    headers: { ...owner.headers, "content-type": "application/json" },
    body: JSON.stringify({ email: "status-agent@example.com", role: "agent" }),
  });
  expect(invite.status).toBe(201);
  const inviteBody = (await invite.json()) as { member: { userId: string } };
  agentId = inviteBody.member.userId;

  const claim = await registerUser(app, "status-agent@example.com", "Andy Agent");
  agent = {
    ...claim,
    userId: agentId,
    headers: { authorization: `Bearer ${claim.token}`, "x-workspace-id": owner.workspaceId },
  };
  outsider = await registerUser(app, "status-outsider@example.com", "Oscar Outsider");

  fake.seed("channelAccounts", {
    id: "acc-wa", workspaceId: owner.workspaceId, channel: "whatsapp",
    externalId: "15550001", status: "connected", tokenVaultRef: null, authMode: null,
  });
  fake.seed("contacts", {
    id: "contact-1", workspaceId: owner.workspaceId, channel: "whatsapp",
    externalId: "628111", displayName: "Customer One", tags: [], customFields: {},
  });
  for (const id of ["conv-1", "conv-2", "conv-3"]) {
    fake.seed("conversations", {
      id, workspaceId: owner.workspaceId, channelAccountId: "acc-wa",
      contactId: "contact-1", status: "open", assignedUserId: null, lastUserMessageAt: new Date(),
    });
  }
});

describe("PATCH /conversations/{id}/status", () => {
  test("open -> pending succeeds, serializes the new status, publishes once", async () => {
    updates.length = 0;
    const res = await setStatus("conv-1", "pending", owner.headers);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversation: { id: string; status: string } };
    expect(body.conversation.id).toBe("conv-1");
    expect(body.conversation.status).toBe("pending");
    expect(rowStatus("conv-1")).toBe("pending");
    expect(updates).toEqual([
      { workspaceId: owner.workspaceId, conversationId: "conv-1", status: "pending" },
    ]);
  });

  test("pending -> resolved succeeds", async () => {
    updates.length = 0;
    const res = await setStatus("conv-1", "resolved", owner.headers);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversation: { status: string } };
    expect(body.conversation.status).toBe("resolved");
    expect(rowStatus("conv-1")).toBe("resolved");
    expect(updates).toEqual([
      { workspaceId: owner.workspaceId, conversationId: "conv-1", status: "resolved" },
    ]);
  });

  test("resolved -> open reopens the conversation", async () => {
    const res = await setStatus("conv-1", "open", owner.headers);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversation: { status: string } };
    expect(body.conversation.status).toBe("open");
    expect(rowStatus("conv-1")).toBe("open");
  });

  test("an invalid status is a typed 400 VALIDATION and writes/publishes nothing", async () => {
    updates.length = 0;
    const res = await setStatus("conv-2", "closed", owner.headers);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
    expect(rowStatus("conv-2")).toBe("open");
    expect(updates).toHaveLength(0);
  });

  test("a missing status is a typed 400 VALIDATION", async () => {
    const res = await app.request("/conversations/conv-2/status", {
      method: "PATCH",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
    expect(rowStatus("conv-2")).toBe("open");
  });

  test("an agent (inbox role set) may change the status", async () => {
    const res = await setStatus("conv-2", "pending", agent.headers);
    expect(res.status).toBe(200);
    expect(rowStatus("conv-2")).toBe("pending");
  });

  test("a caller who is not a workspace member cannot change status (middleware 403)", async () => {
    const res = await setStatus("conv-2", "resolved", {
      authorization: `Bearer ${outsider.token}`,
      "x-workspace-id": owner.workspaceId,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(rowStatus("conv-2")).toBe("pending");
  });

  test("changing the status of an unknown conversation is 404", async () => {
    const res = await setStatus("conv-nope", "resolved", owner.headers);
    expect(res.status).toBe(404);
  });
});

describe("GET /conversations status filter", () => {
  test("status filter alone and combined with the assignee filter", async () => {
    // Fixture: conv-1 pending + assigned to the agent, conv-2 resolved,
    // conv-3 open + unassigned.
    expect((await setStatus("conv-1", "pending", owner.headers)).status).toBe(200);
    expect((await assign("conv-1", agentId, owner.headers)).status).toBe(200);
    expect((await setStatus("conv-2", "resolved", owner.headers)).status).toBe(200);
    expect((await setStatus("conv-3", "open", owner.headers)).status).toBe(200);

    expect(await listIds(owner.headers)).toEqual(["conv-1", "conv-2", "conv-3"]);
    expect(await listIds(owner.headers, "?status=pending")).toEqual(["conv-1"]);
    expect(await listIds(owner.headers, "?status=resolved")).toEqual(["conv-2"]);
    expect(await listIds(owner.headers, "?status=open")).toEqual(["conv-3"]);

    // Combined: status AND assignee must both match.
    expect(await listIds(agent.headers, "?status=pending&assignee=me")).toEqual(["conv-1"]);
    expect(await listIds(owner.headers, "?status=pending&assignee=me")).toEqual([]);
    expect(await listIds(owner.headers, "?status=open&assignee=unassigned")).toEqual(["conv-3"]);
    expect(await listIds(owner.headers, "?status=pending&assignee=unassigned")).toEqual([]);
  });

  test("an invalid status filter value is a typed 400 VALIDATION", async () => {
    const res = await app.request("/conversations?status=closed", { headers: owner.headers });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });
});
