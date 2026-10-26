import { beforeAll, describe, expect, test } from "bun:test";
import {
  createChannelAccount, createContact, createConversation, createMessage,
  getChannelAccount, getConversation, listChannelAccounts, listMessages,
} from "@botara/db";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";
import { InMemoryVault } from "./whatsapp-onboarding";

/**
 * Channels "disconnect" (DELETE /channels/accounts/{id}):
 * - no attached data -> hard delete, 200 { mode: "deleted" }, vault
 *   secret deleted;
 * - attached data (conversations, cost rows, ...) -> SOFT disconnect,
 *   200 { mode: "disconnected" }: row + history kept, status flipped,
 *   vault ref cleared + secret deleted;
 * - DELETE ?purge=true on a soft-disconnected account -> 200
 *   { mode: "purged" }: account + attached data deleted, cost ledger
 *   UNLINKED (channelAccountId null), never deleted;
 * - purge on a still-connected account -> 409 purge_requires_disconnected;
 * - another workspace's account is invisible (404, row kept), unknown
 *   id is 404, unauthenticated is 401, agent-role member is 403.
 */

let fake: FakeDatabase;

const vault = new InMemoryVault();
const vaultDeleteCalls: string[] = [];
const originalVaultDelete = vault.delete.bind(vault);
vault.delete = async (ref: string) => {
  vaultDeleteCalls.push(ref);
  await originalVaultDelete(ref);
};

const app = createApp(testDeps({
  getDatabase: () => fake.db,
  vault,
}));

let owner: Registered;
let second: Registered;
let agent: Registered;

function disconnect(id: string, headers?: Record<string, string>, purge = false) {
  return app.request(`/channels/accounts/${id}${purge ? "?purge=true" : ""}`, {
    method: "DELETE",
    ...(headers ? { headers } : {}),
  });
}

async function seedAccount(workspaceId: string, externalId: string, tokenVaultRef?: string) {
  return createChannelAccount(fake.db, {
    workspaceId,
    channel: "whatsapp",
    externalId,
    displayName: `Account ${externalId}`,
    ...(tokenVaultRef ? { tokenVaultRef } : {}),
  });
}

/** Seed one conversation (with one inbound + one outbound message) on an account. */
async function seedConversation(workspaceId: string, channelAccountId: string, suffix: string) {
  const contact = await createContact(fake.db, {
    workspaceId, channel: "whatsapp", externalId: `cust-${suffix}`,
  });
  const conversation = await createConversation(fake.db, {
    workspaceId, channelAccountId, contactId: contact.id,
  });
  await createMessage(fake.db, {
    conversationId: conversation.id, direction: "in", type: "text", body: "hello",
  });
  await createMessage(fake.db, {
    conversationId: conversation.id, direction: "out", type: "text", body: "hi there",
  });
  return conversation;
}

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(app, "disconnect-owner@example.com", "Olivia Owner");
  second = await registerUser(app, "disconnect-second@example.com", "Sam Second");

  // Invite an agent into the owner's workspace, then let them claim the
  // account by registering with that email (same pattern as
  // app-assignment.test.ts); their headers select the OWNER's workspace.
  const invite = await app.request(`/workspaces/${owner.workspaceId}/members`, {
    method: "POST",
    headers: { ...owner.headers, "content-type": "application/json" },
    body: JSON.stringify({ email: "disconnect-agent@example.com", role: "agent" }),
  });
  expect(invite.status).toBe(201);
  const claim = await registerUser(app, "disconnect-agent@example.com", "Andy Agent");
  agent = {
    ...claim,
    headers: { authorization: `Bearer ${claim.token}`, "x-workspace-id": owner.workspaceId },
  };
});

describe("DELETE /channels/accounts/{id} - hard delete (no attached data)", () => {
  test("owner deletes own account: 200 {mode:'deleted'}, row gone, vault secret deleted", async () => {
    const ref = await vault.store({
      channel: "whatsapp",
      workspaceId: owner.workspaceId,
      label: "disconnect-test",
      secret: "secret-to-delete",
    });
    const account = await seedAccount(owner.workspaceId, "15551111", ref);
    vaultDeleteCalls.length = 0;

    const res = await disconnect(account.id, owner.headers);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "deleted" });

    expect(await getChannelAccount(fake.db, owner.workspaceId, account.id)).toBeNull();
    expect(vaultDeleteCalls).toEqual([ref]);
    expect(await vault.get(ref)).toBeNull();
  });

  test("an account in another workspace is 404 and the row still exists", async () => {
    const account = await seedAccount(second.workspaceId, "15552222");

    const res = await disconnect(account.id, owner.headers);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");

    expect(await getChannelAccount(fake.db, second.workspaceId, account.id)).not.toBeNull();
  });

  test("an unknown id in the caller's own workspace is 404", async () => {
    const res = await disconnect(crypto.randomUUID(), owner.headers);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("no auth headers is 401", async () => {
    const account = await seedAccount(owner.workspaceId, "15553333");
    const res = await disconnect(account.id);
    expect(res.status).toBe(401);
    expect(await getChannelAccount(fake.db, owner.workspaceId, account.id)).not.toBeNull();
  });

  test("an agent-role member is 403 and the row still exists", async () => {
    const account = await seedAccount(owner.workspaceId, "15554444");

    const res = await disconnect(account.id, agent.headers);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");

    expect(await getChannelAccount(fake.db, owner.workspaceId, account.id)).not.toBeNull();
  });
});

describe("DELETE /channels/accounts/{id} - soft disconnect (attached data)", () => {
  test("account with a conversation: mode 'disconnected', row + history kept, credential revoked", async () => {
    const ref = await vault.store({
      channel: "whatsapp",
      workspaceId: owner.workspaceId,
      label: "soft-disconnect-test",
      secret: "secret-to-revoke",
    });
    const account = await seedAccount(owner.workspaceId, "15555555", ref);
    const conversation = await seedConversation(owner.workspaceId, account.id, "soft");
    vaultDeleteCalls.length = 0;

    const res = await disconnect(account.id, owner.headers);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "disconnected" });

    const row = await getChannelAccount(fake.db, owner.workspaceId, account.id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("disconnected");
    expect(row!.tokenVaultRef).toBeNull();
    expect(vaultDeleteCalls).toEqual([ref]);
    expect(await vault.get(ref)).toBeNull();

    // History is untouched: conversation + both messages still there.
    expect(await getConversation(fake.db, owner.workspaceId, conversation.id)).not.toBeNull();
    expect(await listMessages(fake.db, conversation.id)).toHaveLength(2);
  });

  test("an account referenced ONLY by a cost-ledger row soft-disconnects (billing evidence is never hard-deleted)", async () => {
    const account = await seedAccount(owner.workspaceId, "15556666");
    fake.seed("costLedger", {
      workspaceId: owner.workspaceId, channelAccountId: account.id,
      channel: "whatsapp", category: "service", amount: "0.01", currency: "USD",
    });

    const res = await disconnect(account.id, owner.headers);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "disconnected" });
    const row = await getChannelAccount(fake.db, owner.workspaceId, account.id);
    expect(row!.status).toBe("disconnected");
  });
});

describe("DELETE /channels/accounts/{id}?purge=true", () => {
  test("purge after soft disconnect: account + conversation + messages gone, cost ledger unlinked not deleted", async () => {
    const account = await seedAccount(owner.workspaceId, "15557777");
    const conversation = await seedConversation(owner.workspaceId, account.id, "purge");
    const ledgerRow = fake.seed("costLedger", {
      workspaceId: owner.workspaceId, channelAccountId: account.id,
      channel: "whatsapp", category: "utility", amount: "0.02", currency: "USD",
    });
    fake.seed("workspaceDomains", {
      workspaceId: owner.workspaceId, domain: "mail.example.com", channelAccountId: account.id,
    });

    const soft = await disconnect(account.id, owner.headers);
    expect(soft.status).toBe(200);
    expect(await soft.json()).toEqual({ mode: "disconnected" });

    const res = await disconnect(account.id, owner.headers, true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "purged" });

    expect(await getChannelAccount(fake.db, owner.workspaceId, account.id)).toBeNull();
    expect(await getConversation(fake.db, owner.workspaceId, conversation.id)).toBeNull();
    expect(await listMessages(fake.db, conversation.id)).toHaveLength(0);
    expect(fake.rows.messages.some((m) => m.conversationId === conversation.id)).toBe(false);

    // Billing history survives as platform evidence, just unlinked.
    const ledger = fake.rows.costLedger.find((r) => r.id === ledgerRow.id);
    expect(ledger).toBeDefined();
    expect(ledger!.channelAccountId).toBeNull();
    // The domain registration survives too, unlinked.
    const domain = fake.rows.workspaceDomains.find((r) => r.domain === "mail.example.com");
    expect(domain).toBeDefined();
    expect(domain!.channelAccountId).toBeNull();
  });

  test("purge on a still-connected account is refused 409 and nothing is touched", async () => {
    const account = await seedAccount(owner.workspaceId, "15558888");
    const conversation = await seedConversation(owner.workspaceId, account.id, "refuse");

    const res = await disconnect(account.id, owner.headers, true);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.details?.reason).toBe("purge_requires_disconnected");

    const row = await getChannelAccount(fake.db, owner.workspaceId, account.id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("connected");
    expect(await getConversation(fake.db, owner.workspaceId, conversation.id)).not.toBeNull();
    expect(await listMessages(fake.db, conversation.id)).toHaveLength(2);
  });
});

describe("send guard: replies through a disconnected account", () => {
  test("POST /conversations/{id}/reply on a disconnected account: 409 CHANNEL_ACCOUNT_DISCONNECTED, nothing persisted", async () => {
    const account = await seedAccount(owner.workspaceId, "15559999");
    const conversation = await seedConversation(owner.workspaceId, account.id, "guard");
    const soft = await disconnect(account.id, owner.headers);
    expect(soft.status).toBe(200);

    const res = await app.request(`/conversations/${conversation.id}/reply`, {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ kind: "free_form", text: "are you still there?" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CHANNEL_ACCOUNT_DISCONNECTED");

    // The guard fires before persistence: still exactly the 2 seeded rows.
    expect(await listMessages(fake.db, conversation.id)).toHaveLength(2);
  });
});
