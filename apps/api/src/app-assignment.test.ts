import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";
import type { RealtimePublisher } from "./realtime-publish";

/**
 * Conversation assignment (parity: inbox assignment API):
 * PATCH /conversations/{id}/assign + the `assignee` list filter, run
 * against the real routes/repositories over the fake DB.
 *
 * Covers: assign a member (200, assignee serialized with name/email),
 * non-member assignee (400 VALIDATION), unassign with null, agent role
 * allowed, non-member caller refused by the auth middleware, an
 * inbox.update realtime publish per change, and the me/unassigned/<id>
 * list filters.
 */

let fake: FakeDatabase;
const updates: Array<{ workspaceId: string; conversationId: string }> = [];
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

function assign(id: string, userId: string | null, headers: Record<string, string>) {
  return app.request(`/conversations/${id}/assign`, {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
}

async function listIds(headers: Record<string, string>, assignee?: string) {
  const suffix = assignee ? `?assignee=${encodeURIComponent(assignee)}` : "";
  const res = await app.request(`/conversations${suffix}`, { headers });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    conversations: Array<{ id: string; assignedUserId: string | null; assignee: { userId: string; name: string | null; email: string | null } | null }>;
  };
  return body.conversations;
}

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(app, "assign-owner@example.com", "Olivia Owner");

  // Invite an agent into the owner's workspace, then let them claim the
  // account by registering (invited users start passwordless) and set a
  // display name through the profile endpoint, like a real invitee.
  const invite = await app.request(`/workspaces/${owner.workspaceId}/members`, {
    method: "POST",
    headers: { ...owner.headers, "content-type": "application/json" },
    body: JSON.stringify({ email: "agent@example.com", role: "agent" }),
  });
  expect(invite.status).toBe(201);
  const inviteBody = (await invite.json()) as { member: { userId: string } };
  agentId = inviteBody.member.userId;

  const claim = await registerUser(app, "agent@example.com", "Andy Agent");
  const profile = await app.request("/auth/me", {
    method: "PATCH",
    headers: { authorization: `Bearer ${claim.token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Andy Agent" }),
  });
  expect(profile.status).toBe(200);
  agent = {
    ...claim,
    userId: agentId,
    headers: { authorization: `Bearer ${claim.token}`, "x-workspace-id": owner.workspaceId },
  };
  outsider = await registerUser(app, "outsider@example.com", "Oscar Outsider");

  fake.seed("channelAccounts", {
    id: "acc-wa", workspaceId: owner.workspaceId, channel: "whatsapp",
    externalId: "15550001", status: "connected", tokenVaultRef: null, authMode: null,
  });
  fake.seed("contacts", {
    id: "contact-1", workspaceId: owner.workspaceId, channel: "whatsapp",
    externalId: "628111", displayName: "Customer One", tags: [], customFields: {},
  });
  fake.seed("conversations", {
    id: "conv-1", workspaceId: owner.workspaceId, channelAccountId: "acc-wa",
    contactId: "contact-1", status: "open", assignedUserId: null, lastUserMessageAt: new Date(),
  });
  fake.seed("conversations", {
    id: "conv-2", workspaceId: owner.workspaceId, channelAccountId: "acc-wa",
    contactId: "contact-1", status: "open", assignedUserId: null, lastUserMessageAt: new Date(),
  });
});

describe("PATCH /conversations/{id}/assign", () => {
  test("assigning a workspace member succeeds and serializes the assignee", async () => {
    updates.length = 0;
    const res = await assign("conv-1", agentId, owner.headers);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversation: { id: string; assignedUserId: string | null; assignee: { userId: string; name: string | null; email: string | null } | null };
    };
    expect(body.conversation.assignedUserId).toBe(agentId);
    expect(body.conversation.assignee).toEqual({
      userId: agentId, name: "Andy Agent", email: "agent@example.com",
    });
    expect(fake.rows.conversations.find((c) => c.id === "conv-1")?.assignedUserId).toBe(agentId);
    // Other open inboxes learn about the change.
    expect(updates).toEqual([{ workspaceId: owner.workspaceId, conversationId: "conv-1" }]);
  });

  test("assigning a non-member is a typed 400 VALIDATION and writes nothing", async () => {
    updates.length = 0;
    const res = await assign("conv-2", outsider.userId, owner.headers);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
    expect(fake.rows.conversations.find((c) => c.id === "conv-2")?.assignedUserId).toBeNull();
    expect(updates).toHaveLength(0);
  });

  test("an agent (inbox role set) may assign; unassigning with null clears", async () => {
    const res = await assign("conv-1", null, agent.headers);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversation: { assignedUserId: string | null; assignee: unknown } };
    expect(body.conversation.assignedUserId).toBeNull();
    expect(body.conversation.assignee).toBeNull();
    expect(fake.rows.conversations.find((c) => c.id === "conv-1")?.assignedUserId).toBeNull();
  });

  test("a caller who is not a workspace member cannot assign (middleware 403)", async () => {
    const res = await assign("conv-1", agentId, {
      authorization: `Bearer ${outsider.token}`,
      "x-workspace-id": owner.workspaceId,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(fake.rows.conversations.find((c) => c.id === "conv-1")?.assignedUserId).toBeNull();
  });

  test("assigning an unknown conversation is 404", async () => {
    const res = await assign("conv-nope", agentId, owner.headers);
    expect(res.status).toBe(404);
  });
});

describe("GET /conversations assignee filter", () => {
  test("me / unassigned / member-id filters partition the list", async () => {
    // conv-1 -> agent, conv-2 stays unassigned.
    const setup = await assign("conv-1", agentId, owner.headers);
    expect(setup.status).toBe(200);

    const all = await listIds(owner.headers);
    expect(all.map((c) => c.id).sort()).toEqual(["conv-1", "conv-2"]);
    const conv1 = all.find((c) => c.id === "conv-1")!;
    expect(conv1.assignee).toEqual({ userId: agentId, name: "Andy Agent", email: "agent@example.com" });

    const mineAsAgent = await listIds(agent.headers, "me");
    expect(mineAsAgent.map((c) => c.id)).toEqual(["conv-1"]);

    const mineAsOwner = await listIds(owner.headers, "me");
    expect(mineAsOwner).toHaveLength(0);

    const unassigned = await listIds(owner.headers, "unassigned");
    expect(unassigned.map((c) => c.id)).toEqual(["conv-2"]);
    expect(unassigned[0]!.assignee).toBeNull();

    const byId = await listIds(owner.headers, agentId);
    expect(byId.map((c) => c.id)).toEqual(["conv-1"]);

    const byOwnerId = await listIds(owner.headers, owner.userId);
    expect(byOwnerId).toHaveLength(0);
  });
});
