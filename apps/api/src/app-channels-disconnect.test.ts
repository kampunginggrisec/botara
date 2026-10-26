import { beforeAll, describe, expect, test } from "bun:test";
import { createChannelAccount, getChannelAccount } from "@botara/db";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";
import { InMemoryVault } from "./whatsapp-onboarding";

/**
 * Channels "disconnect" (DELETE /channels/accounts/{id}):
 * owner deletes own account (row gone, vault secret deleted), another
 * workspace's account is invisible (404, row kept), unknown id is 404,
 * unauthenticated is 401, and an agent-role member is refused (403 -
 * MUTATOR_ROLES only) with the row kept.
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

function disconnect(id: string, headers?: Record<string, string>) {
  return app.request(`/channels/accounts/${id}`, {
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

describe("DELETE /channels/accounts/{id}", () => {
  test("owner deletes own account: 200 {deleted:true}, row gone, vault secret deleted", async () => {
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
    expect(await res.json()).toEqual({ deleted: true });

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
