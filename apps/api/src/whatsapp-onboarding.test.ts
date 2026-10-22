import { describe, expect, test } from "bun:test";
import type { FetchLike } from "@botara/channels";
import {
  InMemoryVault, exchangeEmbeddedSignup, type WhatsAppOnboardingDeps,
} from "./whatsapp-onboarding";

const BUSINESS_TOKEN = ["EAA", "business", "token", "xyz"].join("-");

interface RecordedCall { url: string }

function mockGraph() {
  const calls: RecordedCall[] = [];
  const fetchFn: FetchLike = async (input) => {
    const url = String(input);
    calls.push({ url });
    let body: unknown = {};
    if (url.includes("/oauth/access_token")) {
      body = { access_token: BUSINESS_TOKEN, token_type: "bearer" };
    } else if (url.includes("/debug_token")) {
      body = {
        data: {
          granular_scopes: [
            { scope: "whatsapp_business_management", target_ids: ["waba-1"] },
            { scope: "whatsapp_business_messaging", target_ids: ["waba-1"] },
          ],
        },
      };
    } else if (url.includes("/waba-1/phone_numbers")) {
      body = {
        data: [
          { id: "pn-1", display_phone_number: "+62 812-3456", verified_name: "Toko Berkah" },
          { id: "pn-2", display_phone_number: "+62 813-9999", verified_name: "Toko Berkah 2" },
        ],
      };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { fetchFn, calls };
}

function fakeDeps(overrides: Partial<WhatsAppOnboardingDeps> = {}) {
  const vault = new InMemoryVault();
  const persisted: Array<Parameters<WhatsAppOnboardingDeps["persistAccount"]>[0]> = [];
  const { fetchFn, calls } = mockGraph();
  const deps: WhatsAppOnboardingDeps = {
    fetchFn,
    appId: "app-1",
    appSecret: "app-secret",
    vault,
    async persistAccount(input) {
      persisted.push(input);
      return { id: `db-acc-${persisted.length}` };
    },
    ...overrides,
  };
  return { deps, vault, persisted, calls };
}

describe("embedded signup v4 exchange (mocked Graph)", () => {
  test("runs token -> debug_token -> phone_numbers in order and persists accounts with a vault ref", async () => {
    const { deps, vault, persisted, calls } = fakeDeps();
    const result = await exchangeEmbeddedSignup(deps, "ws-1", {
      code: "signup-code",
      sessionInfo: { isCoexistence: true },
    });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/v26.0/oauth/access_token",
      "/v26.0/debug_token",
      "/v26.0/waba-1/phone_numbers",
    ]);
    expect(result.wabaId).toBe("waba-1");
    expect(result.isCoexistence).toBe(true);
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[0]).toMatchObject({ phoneNumberId: "pn-1", verifiedName: "Toko Berkah", channelAccountId: "db-acc-1" });
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toMatchObject({ channel: "whatsapp", externalId: "pn-1", apiVersion: "v26.0", isCoexistence: true });
    // The persisted rows carry ONLY the vault ref; the vault holds the token.
    const ref = persisted[0]!.tokenVaultRef;
    expect(ref).toStartWith("vault:memory:");
    expect(vault.get(ref)).toBe(BUSINESS_TOKEN);
  });

  test("the returned summary contains NO token material anywhere", async () => {
    const { deps } = fakeDeps();
    const result = await exchangeEmbeddedSignup(deps, "ws-1", { code: "c" });
    expect(JSON.stringify(result)).not.toContain(BUSINESS_TOKEN);
    expect(JSON.stringify(result)).not.toContain("vault:");
  });

  test("session info phoneNumberId narrows persistence to that number", async () => {
    const { deps, persisted } = fakeDeps();
    const result = await exchangeEmbeddedSignup(deps, "ws-1", {
      code: "c", sessionInfo: { phoneNumberId: "pn-2" },
    });
    expect(result.accounts).toHaveLength(1);
    expect(persisted[0]!.externalId).toBe("pn-2");
  });

  test("missing app credentials -> 503 CONFIGURATION before any HTTP call", async () => {
    const { deps, calls } = fakeDeps({ appId: undefined, appSecret: undefined });
    await expect(exchangeEmbeddedSignup(deps, "ws-1", { code: "c" }))
      .rejects.toMatchObject({ code: "CONFIGURATION", status: 503 });
    expect(calls).toHaveLength(0);
  });
});
