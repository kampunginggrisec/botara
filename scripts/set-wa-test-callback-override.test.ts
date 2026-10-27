import { describe, expect, test } from "bun:test";
import { VaultCredentialProvider, type FetchLike } from "../packages/channels/src/index";
import { InMemoryVaultStore, TokenVault } from "../packages/db/src/index";
import {
  setWaTestCallbackOverride,
  type SetWaTestCallbackOverrideDeps,
  type WaTestOverrideAccount,
} from "./set-wa-test-callback-override";

const TEMP_TOKEN = "<redacted>";
const VERIFY_TOKEN = "meta-dev-verify-token";
const VAULT_KEY = Buffer.alloc(32, 7);

const INPUT = {
  workspaceId: "ws-1",
  phoneNumberId: "1361611993704410",
  wabaId: "2227032434830165",
  overrideCallbackUri: "https://dev.botara.my.id/api/webhooks/whatsapp",
  verifyToken: VERIFY_TOKEN,
};

async function fakeDeps(overrides: Partial<SetWaTestCallbackOverrideDeps> = {}) {
  // The REAL TokenVault over the in-memory store, seeded exactly like the
  // provisioning script seeds it (label waba:{wabaId}) — the core must
  // reach the token through the vault ONLY.
  const vault = new TokenVault(new InMemoryVaultStore(), VAULT_KEY);
  const ref = await vault.store({
    channel: "whatsapp", workspaceId: "ws-1", label: "waba:2227032434830165", secret: TEMP_TOKEN,
  });
  const account: WaTestOverrideAccount = { id: "acc-1", externalId: "1361611993704410", tokenVaultRef: ref };
  // The production credential path: VaultCredentialProvider over the ref.
  const provider = new VaultCredentialProvider({ getSecret: (r) => vault.get(r) });
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn: FetchLike = async (input, init) => {
    fetchCalls.push({ url: String(input), init });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  const deps: SetWaTestCallbackOverrideDeps = {
    accounts: {
      async findExisting(workspaceId, externalId) {
        return workspaceId === "ws-1" && externalId === account.externalId ? account : null;
      },
    },
    credentials: {
      async resolveAccessToken(acc) {
        const secrets = await provider.resolve({
          id: acc.id,
          externalId: acc.externalId,
          tokenVaultRef: acc.tokenVaultRef ?? undefined,
        });
        return secrets.accessToken ?? null;
      },
    },
    fetchFn,
    ...overrides,
  };
  return { deps, vault, account, fetchCalls };
}

describe("set-wa-test-callback-override (fake accounts + real TokenVault + VaultCredentialProvider)", () => {
  test("POSTs the override body to subscribed_apps with the vault-resolved token as Bearer", async () => {
    const { deps, fetchCalls } = await fakeDeps();
    const result = await setWaTestCallbackOverride(deps, INPUT);

    expect(result).toMatchObject({
      accountId: "acc-1",
      workspaceId: "ws-1",
      externalId: "1361611993704410",
      wabaId: "2227032434830165",
      overrideCallbackUri: "https://dev.botara.my.id/api/webhooks/whatsapp",
      verifyTokenSet: true,
      subscribed: "subscribed",
    });
    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0]!;
    expect(call.url).toBe("https://graph.facebook.com/v26.0/2227032434830165/subscribed_apps");
    expect(call.init?.method).toBe("POST");
    const headers = call.init?.headers as Record<string, string>;
    // The Bearer token is the one sealed in the vault — the core input
    // never carried it.
    expect(headers.Authorization).toBe(`Bearer ${TEMP_TOKEN}`);
    expect(JSON.parse(String(call.init?.body))).toEqual({
      override_callback_uri: "https://dev.botara.my.id/api/webhooks/whatsapp",
      verify_token: VERIFY_TOKEN,
    });
    // No credential material in the summary: neither the access token,
    // the verify token, nor any vault ref.
    const summary = JSON.stringify(result);
    expect(summary).not.toContain(TEMP_TOKEN);
    expect(summary).not.toContain(VERIFY_TOKEN);
    expect(summary).not.toContain("vault:");
  });

  test("a Meta error is surfaced in the result, not swallowed", async () => {
    const fetchFn: FetchLike = async () =>
      new Response(JSON.stringify({ error: { message: "no permission", code: 200 } }), { status: 403 });
    const { deps } = await fakeDeps({ fetchFn });
    const result = await setWaTestCallbackOverride(deps, INPUT);
    expect(result.subscribed).toBe("failed");
    expect(result.error).toBe("no permission");
  });

  test("a missing account fails honestly and never calls Meta", async () => {
    const { deps, fetchCalls } = await fakeDeps({
      accounts: { async findExisting() { return null; } },
    });
    await expect(setWaTestCallbackOverride(deps, INPUT)).rejects.toThrow(/provision-wa-test-number/);
    expect(fetchCalls).toHaveLength(0);
  });

  test("a missing verify token fails honestly and never calls Meta", async () => {
    const { deps, fetchCalls } = await fakeDeps();
    await expect(
      setWaTestCallbackOverride(deps, { ...INPUT, verifyToken: undefined }),
    ).rejects.toThrow(/WHATSAPP_VERIFY_TOKEN/);
    expect(fetchCalls).toHaveLength(0);
  });

  test("an unresolvable vault token fails honestly and never calls Meta", async () => {
    const { deps, fetchCalls } = await fakeDeps({
      accounts: {
        async findExisting() {
          return { id: "acc-1", externalId: "1361611993704410", tokenVaultRef: "vault:db:missing" };
        },
      },
    });
    await expect(setWaTestCallbackOverride(deps, INPUT)).rejects.toThrow(/Could not resolve an access token/);
    expect(fetchCalls).toHaveLength(0);
  });
});
