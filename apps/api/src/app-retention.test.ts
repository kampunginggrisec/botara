import { beforeAll, describe, expect, test } from "bun:test";
import {
  createChannelAccount, createContact, createConversation, createWorkspaceDomain,
  getChannelAccount, insertCostLedger, listChannelAccounts,
  purgeExpiredDisconnectedAccounts, softDisconnectChannelAccount,
} from "@botara/db";
import { disconnectRetentionCutoff, DISCONNECT_RETENTION_DAYS } from "@botara/shared";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";
import { InMemoryVault } from "./whatsapp-onboarding";

/**
 * Item G: retention for soft-disconnected channel accounts.
 * - soft disconnect stamps disconnected_at; the accounts serializer
 *   exposes disconnectedAt + purgeAt (stamp + DISCONNECT_RETENTION_DAYS);
 * - the repository sweeper purges accounts past the cutoff with the
 *   manual purge's FK-safe semantics (children deleted, cost ledger +
 *   workspace domains UNLINKED) and writes channel.purged audit rows
 *   with reason "retention_expired"; fresh disconnects survive;
 * - reconnecting (Telegram connect -> persistConnectedAccount) clears
 *   the stamp and the purge instant.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

let fake: FakeDatabase;
const vault = new InMemoryVault();

const telegramFetch = async (input: string | URL): Promise<Response> => {
  if (String(input).includes("/getMe")) {
    return new Response(JSON.stringify({
      ok: true,
      result: { id: 515151, is_bot: true, first_name: "Retention Bot", username: "retention_bot" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ ok: true, result: true }), {
    status: 200, headers: { "content-type": "application/json" },
  });
};

const app = createApp(testDeps({
  getDatabase: () => fake.db,
  vault,
  providerFetch: telegramFetch,
}));

let owner: Registered;

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(app, "retention-owner@example.com", "Rudi Retention");
});

async function seedWithConversation(externalId: string) {
  const account = await createChannelAccount(fake.db, {
    workspaceId: owner.workspaceId, channel: "whatsapp", externalId,
  });
  const contact = await createContact(fake.db, {
    workspaceId: owner.workspaceId, channel: "whatsapp", externalId: `cust-${externalId}`,
  });
  await createConversation(fake.db, {
    workspaceId: owner.workspaceId, channelAccountId: account.id, contactId: contact.id,
  });
  return account;
}

function backdateDisconnect(accountId: string, daysAgo: number) {
  const row = fake.rows.channelAccounts.find((r) => r.id === accountId)!;
  row.disconnectedAt = new Date(Date.now() - daysAgo * DAY_MS);
}

describe("soft disconnect stamps + serializer (item G)", () => {
  test("DELETE soft-disconnect stamps disconnected_at; payload gains disconnectedAt + purgeAt (+30d)", async () => {
    const account = await seedWithConversation("628111000222");
    const res = await app.request(`/channels/accounts/${account.id}`, {
      method: "DELETE", headers: owner.headers,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { mode: string }).mode).toBe("disconnected");

    const row = fake.rows.channelAccounts.find((r) => r.id === account.id)!;
    expect(row.disconnectedAt).toBeInstanceOf(Date);
    expect(Math.abs((row.disconnectedAt as Date).getTime() - Date.now())).toBeLessThan(60_000);

    const list = await app.request("/channels/accounts", { headers: owner.headers });
    const body = (await list.json()) as {
      accounts: Array<{
        id: string; status: string;
        disconnectedAt: string | null; purgeAt: string | null;
      }>;
    };
    const listed = body.accounts.find((a) => a.id === account.id)!;
    expect(listed.status).toBe("disconnected");
    expect(listed.disconnectedAt).toBe((row.disconnectedAt as Date).toISOString());
    expect(Date.parse(listed.purgeAt!) - Date.parse(listed.disconnectedAt!))
      .toBe(DISCONNECT_RETENTION_DAYS * DAY_MS);
  });
});

describe("retention sweeper cutoff (item G)", () => {
  test("31 days purged (ledger + domain unlinked, audit written), 29 days and unstamped survive", async () => {
    const fresh = await seedWithConversation("628222000333");
    await softDisconnectChannelAccount(fake.db, owner.workspaceId, fresh.id);
    backdateDisconnect(fresh.id, 29);

    const expired = await seedWithConversation("628333000444");
    await softDisconnectChannelAccount(fake.db, owner.workspaceId, expired.id);
    backdateDisconnect(expired.id, 31);
    await insertCostLedger(fake.db, {
      workspaceId: owner.workspaceId, channelAccountId: expired.id,
      channel: "whatsapp", category: "utility", units: 2, amountUsd: 0.01,
      referenceId: "retention-test",
    });
    const domain = await createWorkspaceDomain(fake.db, {
      workspaceId: owner.workspaceId, domain: "mail.example.test",
      channelAccountId: expired.id,
    });

    const unstamped = await seedWithConversation("628444000555");
    await softDisconnectChannelAccount(fake.db, owner.workspaceId, unstamped.id);
    fake.rows.channelAccounts.find((r) => r.id === unstamped.id)!.disconnectedAt = null;

    const purged = await purgeExpiredDisconnectedAccounts(
      fake.db, disconnectRetentionCutoff(new Date()),
    );
    expect(purged.map((p) => p.id)).toEqual([expired.id]);

    // Expired: account + its conversation gone…
    expect(await getChannelAccount(fake.db, owner.workspaceId, expired.id)).toBeNull();
    expect(fake.rows.conversations.some((c) => c.channelAccountId === expired.id)).toBe(false);
    // …but billing evidence and the domain registration survive, unlinked.
    const ledger = fake.rows.costLedger.find((r) => r.referenceId === "retention-test")!;
    expect(ledger).toBeDefined();
    expect(ledger.channelAccountId).toBeNull();
    const domainRow = fake.rows.workspaceDomains.find((r) => r.id === domain.id)!;
    expect(domainRow.channelAccountId).toBeNull();

    // Fresh + unstamped + the earlier test's account states are sane.
    const remaining = await listChannelAccounts(fake.db, owner.workspaceId);
    expect(remaining.some((a) => a.id === fresh.id)).toBe(true);
    expect(remaining.some((a) => a.id === unstamped.id)).toBe(true);

    // Exactly one retention audit entry, for the expired account.
    const audits = fake.rows.auditLog.filter((r) => r.action === "channel.purged");
    expect(audits).toHaveLength(1);
    const details = audits[0]!.details as { externalId: string; reason: string };
    expect(details.externalId).toBe("628333000444");
    expect(details.reason).toBe("retention_expired");
  });
});

describe("reconnect clears the stamp (item G)", () => {
  test("telegram connect reactivates the row with disconnectedAt null and purgeAt null", async () => {
    const seeded = await createChannelAccount(fake.db, {
      workspaceId: owner.workspaceId,
      channel: "telegram",
      externalId: "515151",
      displayName: "@retention_bot",
      authMode: "bot-token",
      status: "disconnected",
    });
    fake.rows.channelAccounts.find((r) => r.id === seeded.id)!.disconnectedAt =
      new Date(Date.now() - 10 * DAY_MS);

    const res = await app.request("/channels/telegram/connect", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ botToken: "515151:fresh-token" }),
    });
    expect(res.status).toBe(201);

    const row = fake.rows.channelAccounts.find((r) => r.id === seeded.id)!;
    expect(row.status).toBe("connected");
    expect(row.disconnectedAt).toBeNull();

    const list = await app.request("/channels/accounts", { headers: owner.headers });
    const body = (await list.json()) as {
      accounts: Array<{ id: string; disconnectedAt: string | null; purgeAt: string | null }>;
    };
    const listed = body.accounts.find((a) => a.id === seeded.id)!;
    expect(listed.disconnectedAt).toBeNull();
    expect(listed.purgeAt).toBeNull();
  });
});
