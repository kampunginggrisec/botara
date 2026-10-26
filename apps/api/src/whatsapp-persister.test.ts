import { describe, expect, test } from "bun:test";
import { createChannelAccount, listChannelAccounts } from "@botara/db";
import { createFakeDatabase } from "./fake-db";
import { createDbWhatsAppAccountPersister } from "./whatsapp-onboarding";

/**
 * The production Embedded Signup persister is an upsert: re-running the
 * signup for a number whose row exists - above all a soft-disconnected
 * row - must reactivate THAT row (status "connected", new vault ref,
 * refreshed avatar), not insert a duplicate account for the number.
 */

const WS = "ws-persister";

function persistInput(externalId: string, tokenVaultRef: string, avatarUrl?: string) {
  return {
    workspaceId: WS,
    channel: "whatsapp" as const,
    externalId,
    displayName: "Shop Number",
    ...(avatarUrl ? { avatarUrl } : {}),
    apiVersion: "v26.0",
    capabilities: {},
    isCoexistence: false,
    tokenVaultRef,
    status: "connected",
  };
}

describe("createDbWhatsAppAccountPersister", () => {
  test("reactivates a soft-disconnected row for the same number", async () => {
    const fake = createFakeDatabase();
    const seeded = await createChannelAccount(fake.db, {
      workspaceId: WS,
      channel: "whatsapp",
      externalId: "15550001",
      displayName: "Shop Number",
      tokenVaultRef: "vault:memory:old",
      status: "disconnected",
    });
    const persist = createDbWhatsAppAccountPersister(() => fake.db);

    const result = await persist(persistInput("15550001", "vault:memory:new", "https://example.com/pic.jpg"));
    expect(result.id).toBe(seeded.id);

    const rows = (await listChannelAccounts(fake.db, WS)).filter((a) => a.channel === "whatsapp");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("connected");
    expect(rows[0]!.tokenVaultRef).toBe("vault:memory:new");
    expect(rows[0]!.avatarUrl).toBe("https://example.com/pic.jpg");
  });

  test("creates a fresh row for a number that has none", async () => {
    const fake = createFakeDatabase();
    const persist = createDbWhatsAppAccountPersister(() => fake.db);

    const result = await persist(persistInput("15550002", "vault:memory:fresh"));
    const rows = await listChannelAccounts(fake.db, WS);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(result.id);
    expect(rows[0]!.status).toBe("connected");
    expect(rows[0]!.tokenVaultRef).toBe("vault:memory:fresh");
  });
});
