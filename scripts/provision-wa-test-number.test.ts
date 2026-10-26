import { describe, expect, test } from "bun:test";
import { CHANNEL_CAPABILITIES, VaultCredentialProvider, type FetchLike } from "../packages/channels/src/index";
import { InMemoryVaultStore, TokenVault } from "../packages/db/src/index";
import {
  provisionWaTestNumber,
  type ProvisionAccountsPort,
  type ProvisionWaTestNumberDeps,
} from "./provision-wa-test-number";

const TEMP_TOKEN = ["EAA", "temporary", "test", "token"].join("-");
const FRESH_TOKEN = ["EAA", "fresh", "rotated", "token"].join("-");
const VAULT_KEY = Buffer.alloc(32, 7);

type CreateInput = Parameters<ProvisionAccountsPort["create"]>[0];

function fakeAccounts() {
  const rows: Array<CreateInput & { id: string; tokenVaultRef: string | null }> = [];
  const port: ProvisionAccountsPort = {
    async findExisting(workspaceId, externalId) {
      const row = rows.find((r) => r.workspaceId === workspaceId && r.externalId === externalId);
      return row ? { id: row.id, tokenVaultRef: row.tokenVaultRef } : null;
    },
    async create(input) {
      const row = { ...input, id: `acc-${rows.length + 1}` };
      rows.push(row);
      return { id: row.id };
    },
    async setTokenRef(accountId, tokenVaultRef) {
      const row = rows.find((r) => r.id === accountId);
      if (row) row.tokenVaultRef = tokenVaultRef;
    },
  };
  return { port, rows };
}

function fakeDeps(overrides: Partial<ProvisionWaTestNumberDeps> = {}) {
  // The REAL TokenVault over the in-memory store, exactly like vault.test.ts.
  const vault = new TokenVault(new InMemoryVaultStore(), VAULT_KEY);
  const accounts = fakeAccounts();
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn: FetchLike = async (input, init) => {
    fetchCalls.push({ url: String(input), init });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  const deps: ProvisionWaTestNumberDeps = {
    vault: {
      store: (input) => vault.store(input),
      rotate: (ref, secret) => vault.rotate(ref, secret),
    },
    accounts: accounts.port,
    fetchFn,
    ...overrides,
  };
  return { deps, vault, accounts, fetchCalls };
}

const INPUT = {
  workspaceId: "ws-1",
  phoneNumberId: "1361611993704410",
  wabaId: "2227032434830165",
  displayName: "Nomor Uji Meta",
  accessToken: TEMP_TOKEN,
};

/** Resolve a token exactly the way the API/worker send paths do. */
async function sendPathToken(vault: TokenVault, account: { id: string; externalId: string; tokenVaultRef: string }) {
  const provider = new VaultCredentialProvider({ getSecret: (ref) => vault.get(ref) });
  const secrets = await provider.resolve(account);
  return secrets.accessToken;
}

describe("provision-wa-test-number (fake accounts + real TokenVault over in-memory store)", () => {
  test("creates the account with the onboarding field shape and a vault-backed token", async () => {
    const { deps, vault, accounts } = fakeDeps();
    const result = await provisionWaTestNumber(deps, INPUT);

    expect(result).toMatchObject({
      accountId: "acc-1", workspaceId: "ws-1", externalId: "1361611993704410",
      created: true, tokenStored: true, subscription: "subscribed",
    });
    expect(accounts.rows).toHaveLength(1);
    const row = accounts.rows[0]!;
    expect(row).toMatchObject({
      channel: "whatsapp",
      externalId: "1361611993704410",
      displayName: "Nomor Uji Meta",
      apiVersion: "v26.0",
      isCoexistence: false,
      status: "connected",
    });
    expect(row.capabilities).toEqual(
      CHANNEL_CAPABILITIES.whatsapp as unknown as Record<string, unknown>,
    );
    // Only the vault ref lands on the row; the token is inside the vault.
    expect(row.tokenVaultRef).toStartWith("vault:db:");
    expect(JSON.stringify(row)).not.toContain(TEMP_TOKEN);
    // ...and the send path finds it through that ref.
    const resolved = await sendPathToken(vault, {
      id: row.id, externalId: row.externalId, tokenVaultRef: row.tokenVaultRef!,
    });
    expect(resolved).toBe(TEMP_TOKEN);
  });

  test("attempts subscribed_apps against the WABA with the temp token as Bearer", async () => {
    const { deps, fetchCalls } = fakeDeps();
    await provisionWaTestNumber(deps, INPUT);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://graph.facebook.com/v26.0/2227032434830165/subscribed_apps");
    expect(fetchCalls[0]!.init?.method).toBe("POST");
    const headers = fetchCalls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TEMP_TOKEN}`);
  });

  test("a failing subscribed_apps call is reported, never fatal", async () => {
    const fetchFn: FetchLike = async () =>
      new Response(JSON.stringify({ error: { message: "nope", code: 190 } }), { status: 403 });
    const { deps, accounts } = fakeDeps({ fetchFn });
    const result = await provisionWaTestNumber(deps, INPUT);
    expect(result.subscription).toBe("failed");
    expect(result.created).toBe(true);
    expect(accounts.rows).toHaveLength(1);
  });

  test("re-running rotates the token under the same account instead of duplicating it", async () => {
    const { deps, vault, accounts } = fakeDeps();
    const first = await provisionWaTestNumber(deps, INPUT);
    const second = await provisionWaTestNumber(deps, { ...INPUT, accessToken: FRESH_TOKEN });

    expect(second.accountId).toBe(first.accountId);
    expect(second.created).toBe(false);
    expect(accounts.rows).toHaveLength(1);
    const row = accounts.rows[0]!;
    const resolved = await sendPathToken(vault, {
      id: row.id, externalId: row.externalId, tokenVaultRef: row.tokenVaultRef!,
    });
    expect(resolved).toBe(FRESH_TOKEN);
  });

  test("the result summary contains NO token material anywhere", async () => {
    const { deps } = fakeDeps();
    const result = await provisionWaTestNumber(deps, INPUT);
    expect(JSON.stringify(result)).not.toContain(TEMP_TOKEN);
    expect(JSON.stringify(result)).not.toContain("vault:");
  });
});
