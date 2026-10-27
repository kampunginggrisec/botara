import { describe, expect, test } from "bun:test";
import type { FetchLike } from "@botara/channels";
import {
  InMemoryVault, exchangeEmbeddedSignup, type WhatsAppOnboardingDeps,
} from "./whatsapp-onboarding";

const BUSINESS_TOKEN = ["EAA", "business", "token", "xyz"].join("-");

interface RecordedCall { url: string; init?: RequestInit }

function mockGraph() {
  const calls: RecordedCall[] = [];
  const fetchFn: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
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
      // Best-effort business-profile picture lookup per number.
      "/v26.0/pn-1/whatsapp_business_profile",
      "/v26.0/pn-2/whatsapp_business_profile",
      // The app is subscribed to the WABA once accounts persist (ES-1).
      "/v26.0/waba-1/subscribed_apps",
      // Coexistence session: contacts + history sync requested per number.
      "/v26.0/pn-1/smb_app_data",
      "/v26.0/pn-1/smb_app_data",
      "/v26.0/pn-2/smb_app_data",
      "/v26.0/pn-2/smb_app_data",
    ]);
    expect(result.syncRequests).toEqual([
      { phoneNumberId: "pn-1", smbAppStateSync: "requested", history: "requested" },
      { phoneNumberId: "pn-2", smbAppStateSync: "requested", history: "requested" },
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
    expect(await vault.get(ref)).toBe(BUSINESS_TOKEN);
  });

  test("captures the business profile picture url (envelope shape) into the persisted account", async () => {
    const base = mockGraph();
    const fetchFn: FetchLike = async (input, init) => {
      if (String(input).includes("/whatsapp_business_profile")) {
        return new Response(JSON.stringify({
          data: [{ profile_picture_url: "https://cdn.example.com/wa-profile.jpg", messaging_product: "whatsapp" }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return base.fetchFn(input, init);
    };
    const { deps, persisted } = fakeDeps({ fetchFn });
    const result = await exchangeEmbeddedSignup(deps, "ws-1", { code: "c" });
    expect(result.accounts).toHaveLength(2);
    expect(persisted[0]!.avatarUrl).toBe("https://cdn.example.com/wa-profile.jpg");
    expect(persisted[1]!.avatarUrl).toBe("https://cdn.example.com/wa-profile.jpg");
  });

  test("captures the business profile picture url (flat shape) too", async () => {
    const base = mockGraph();
    const fetchFn: FetchLike = async (input, init) => {
      if (String(input).includes("/whatsapp_business_profile")) {
        return new Response(JSON.stringify({ profile_picture_url: "https://cdn.example.com/flat.jpg" }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return base.fetchFn(input, init);
    };
    const { deps, persisted } = fakeDeps({ fetchFn });
    await exchangeEmbeddedSignup(deps, "ws-1", { code: "c" });
    expect(persisted[0]!.avatarUrl).toBe("https://cdn.example.com/flat.jpg");
  });

  test("a failing profile-picture lookup never fails the onboarding", async () => {
    const base = mockGraph();
    const fetchFn: FetchLike = async (input, init) => {
      if (String(input).includes("/whatsapp_business_profile")) {
        return new Response(JSON.stringify({ error: { message: "no profile" } }), { status: 400 });
      }
      return base.fetchFn(input, init);
    };
    const { deps, persisted } = fakeDeps({ fetchFn });
    const result = await exchangeEmbeddedSignup(deps, "ws-1", { code: "c" });
    expect(result.accounts).toHaveLength(2);
    expect(persisted[0]!.avatarUrl).toBeUndefined();
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

  test("a NON-coexistence signup requests no syncs", async () => {
    const { deps, calls } = fakeDeps();
    const result = await exchangeEmbeddedSignup(deps, "ws-1", { code: "c" });
    expect(result.isCoexistence).toBe(false);
    expect(result.syncRequests).toBeUndefined();
    expect(calls.some((c) => c.url.includes("smb_app_data"))).toBe(false);
  });

  test("coexistence sync: Meta 135000 (already requested) counts as done, not failure", async () => {
    const fetchFn: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes("/oauth/access_token")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      if (url.includes("/waba-1/phone_numbers")) {
        return new Response(JSON.stringify({ data: [{ id: "pn-1" }] }), { status: 200 });
      }
      if (url.includes("/smb_app_data")) {
        return new Response(
          JSON.stringify({ error: { code: 135000, message: "A sync was already requested" } }),
          { status: 400 },
        );
      }
      return new Response("{}", { status: 200 });
    };
    const { deps } = fakeDeps({ fetchFn });
    const result = await exchangeEmbeddedSignup(deps, "ws-1", {
      code: "c", sessionInfo: { wabaId: "waba-1", isCoexistence: true, phoneNumberId: "pn-1" },
    });
    expect(result.accounts).toHaveLength(1);
    expect(result.syncRequests).toEqual([
      { phoneNumberId: "pn-1", smbAppStateSync: "already-requested", history: "already-requested" },
    ]);
  });

  test("coexistence sync: a failing smb_app_data call never fails the onboarding", async () => {
    const fetchFn: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes("/oauth/access_token")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      if (url.includes("/waba-1/phone_numbers")) {
        return new Response(JSON.stringify({ data: [{ id: "pn-1" }] }), { status: 200 });
      }
      if (url.includes("/smb_app_data")) return new Response("boom", { status: 500 });
      return new Response("{}", { status: 200 });
    };
    const { deps, persisted } = fakeDeps({ fetchFn });
    const result = await exchangeEmbeddedSignup(deps, "ws-1", {
      code: "c", sessionInfo: { wabaId: "waba-1", isCoexistence: true, phoneNumberId: "pn-1" },
    });
    expect(persisted).toHaveLength(1);
    expect(result.syncRequests).toEqual([
      { phoneNumberId: "pn-1", smbAppStateSync: "failed", history: "failed" },
    ]);
  });

  test("subscribes the app to the WABA with the signup token after accounts persist (ES-1)", async () => {
    const { deps, calls } = fakeDeps();
    const result = await exchangeEmbeddedSignup(deps, "ws-1", { code: "c" });
    expect(result.appSubscription).toBe("subscribed");
    const sub = calls.find((c) => c.url.includes("/subscribed_apps"));
    expect(sub).toBeDefined();
    expect(new URL(sub!.url).pathname).toBe("/v26.0/waba-1/subscribed_apps");
    expect(sub!.init?.method).toBe("POST");
    expect((sub!.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${BUSINESS_TOKEN}`);
    // Exactly once per WABA, not once per phone number (2 numbers here).
    expect(calls.filter((c) => c.url.includes("/subscribed_apps"))).toHaveLength(1);
  });

  test("a failing subscribed_apps call never fails the signup; the outcome is reported (ES-1)", async () => {
    const base = mockGraph();
    const fetchFn: FetchLike = async (input, init) => {
      if (String(input).includes("/subscribed_apps")) {
        return new Response(JSON.stringify({ error: { message: "no permission", code: 200 } }), { status: 403 });
      }
      return base.fetchFn(input, init);
    };
    const { deps, persisted } = fakeDeps({ fetchFn });
    const result = await exchangeEmbeddedSignup(deps, "ws-1", { code: "c" });
    expect(result.appSubscription).toBe("failed");
    expect(result.accounts).toHaveLength(2);
    expect(persisted).toHaveLength(2);
  });

  test("a throwing subscribed_apps call never fails the signup either (ES-1)", async () => {
    const base = mockGraph();
    const fetchFn: FetchLike = async (input, init) => {
      if (String(input).includes("/subscribed_apps")) throw new Error("network down");
      return base.fetchFn(input, init);
    };
    const { deps, persisted } = fakeDeps({ fetchFn });
    const result = await exchangeEmbeddedSignup(deps, "ws-1", { code: "c" });
    expect(result.appSubscription).toBe("failed");
    expect(persisted).toHaveLength(2);
  });

  test("missing app credentials -> 503 CONFIGURATION before any HTTP call", async () => {
    const { deps, calls } = fakeDeps({ appId: undefined, appSecret: undefined });
    await expect(exchangeEmbeddedSignup(deps, "ws-1", { code: "c" }))
      .rejects.toMatchObject({ code: "CONFIGURATION", status: 503 });
    expect(calls).toHaveLength(0);
  });
});
