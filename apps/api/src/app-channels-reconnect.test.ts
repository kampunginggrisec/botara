import { beforeAll, describe, expect, test } from "bun:test";
import { createChannelAccount, listChannelAccounts } from "@botara/db";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";
import { InMemoryVault } from "./whatsapp-onboarding";

/**
 * Reconnect after a soft disconnect must REACTIVATE the existing row:
 * same id, status back to "connected", fresh vault ref holding the new
 * token - never a duplicate account for the same (channel, externalId).
 * Exercised end-to-end through the Telegram bot-token connect route
 * (which persists via persistConnectedAccount, like the OAuth callbacks
 * and the Messenger page picker).
 */

let fake: FakeDatabase;
const vault = new InMemoryVault();

const telegramFetch = async (input: string | URL): Promise<Response> => {
  if (String(input).includes("/getMe")) {
    return new Response(JSON.stringify({
      ok: true,
      result: { id: 424242, is_bot: true, first_name: "Reconnect Bot", username: "reconnect_bot" },
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
  owner = await registerUser(app, "reconnect-owner@example.com", "Rita Reconnect");
});

describe("POST /channels/telegram/connect after a soft disconnect", () => {
  test("reactivates the disconnected row instead of inserting a duplicate", async () => {
    const seeded = await createChannelAccount(fake.db, {
      workspaceId: owner.workspaceId,
      channel: "telegram",
      externalId: "424242",
      displayName: "@reconnect_bot",
      authMode: "bot-token",
      status: "disconnected",
      // tokenVaultRef intentionally absent: a soft disconnect cleared it.
    });

    const res = await app.request("/channels/telegram/connect", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ botToken: "424242:fresh-token" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { account: { id: string; status: string } };
    expect(body.account.id).toBe(seeded.id);
    expect(body.account.status).toBe("connected");

    const accounts = (await listChannelAccounts(fake.db, owner.workspaceId))
      .filter((a) => a.channel === "telegram");
    expect(accounts).toHaveLength(1);
    const row = accounts[0]!;
    expect(row.id).toBe(seeded.id);
    expect(row.status).toBe("connected");
    expect(row.tokenVaultRef).toBeTruthy();
    expect(await vault.get(row.tokenVaultRef!)).toBe("424242:fresh-token");
  });
});
