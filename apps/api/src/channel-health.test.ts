import { beforeAll, describe, expect, test } from "bun:test";
import type { ChannelAdapter, FetchLike } from "@botara/channels";
import { createChannelHealthPort, readSubscribedAppIds } from "./channel-health";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";

/**
 * Per-account channel health (P2-2).
 *
 * The point of this suite is the TRI-STATE subscription answer. "Could not
 * be determined" (`subscribed: null`) must never be reported as "not
 * subscribed": a false alarm on a healthy account trains operators to
 * ignore the one signal that matters - the app silently unsubscribed from
 * the WABA while sends keep working.
 */

const GRAPH = "https://graph.facebook.com/v26.0";

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchLike {
  return async (input, init) => handler(String(input), init);
}

/** A Graph double: the phone number resolves to a WABA, subscribed_apps lists `appIds`. */
function graphDouble(input: { wabaId?: string; appIds?: string[]; subscribedError?: string }): FetchLike {
  return fakeFetch((url) => {
    if (url.includes("fields=whatsapp_business_account")) {
      return new Response(JSON.stringify({ whatsapp_business_account: { id: input.wabaId ?? "waba-1" } }), { status: 200 });
    }
    if (url.includes("/subscribed_apps")) {
      if (input.subscribedError) {
        return new Response(JSON.stringify({ error: { message: input.subscribedError } }), { status: 400 });
      }
      // Meta's REAL shape (official Postman collection): the app id is
      // nested under whatsapp_business_api_data - a flat app_id key made
      // every live account report "not subscribed" until 2026-10-28.
      return new Response(JSON.stringify({
        data: (input.appIds ?? []).map((appId) => ({
          whatsapp_business_api_data: { id: appId, name: "Test App", link: `https://www.facebook.com/games/?app_id=${appId}` },
        })),
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: `unexpected ${url}` } }), { status: 404 });
  });
}

const adapter = (health: { ok: boolean; detail: string } = { ok: true, detail: "whatsapp adapter ready" }) => ({
  key: "whatsapp",
  apiVersion: "v26.0",
  capabilities: {},
  async health() { return health; },
  async send() { throw new Error("not used"); },
  async parseWebhook() { return []; },
}) as unknown as ChannelAdapter;

const account = { id: "acc-1", externalId: "phone-1", tokenVaultRef: "vault-1" };

describe("readSubscribedAppIds", () => {
  test("keeps only the app ids Meta reports", async () => {
    const ids = await readSubscribedAppIds(
      { fetchFn: graphDouble({ appIds: ["app-1", "app-2"] }) },
      { token: "t", wabaId: "waba-1" },
    );
    expect(ids).toEqual(["app-1", "app-2"]);
  });

  test("an empty subscription list is an empty array, not an error", async () => {
    const ids = await readSubscribedAppIds({ fetchFn: graphDouble({ appIds: [] }) }, { token: "t", wabaId: "waba-1" });
    expect(ids).toEqual([]);
  });

  test("a Graph error throws with Meta's own message", async () => {
    await expect(readSubscribedAppIds(
      { fetchFn: graphDouble({ subscribedError: "Invalid WABA" }) },
      { token: "t", wabaId: "waba-1" },
    )).rejects.toThrow("Invalid WABA");
  });

  test("calls the documented path with a bearer token", async () => {
    let seen = "";
    let auth = "";
    const fetchFn = fakeFetch((url, init) => {
      seen = url;
      auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    await readSubscribedAppIds({ fetchFn }, { token: "tok-1", wabaId: "waba-9" });
    expect(seen).toBe(`${GRAPH}/waba-9/subscribed_apps`);
    expect(auth).toBe("Bearer tok-1");
  });
});

describe("channel health port", () => {
  const port = (input: {
    appId?: string | null;
    token?: string | null;
    fetchFn?: FetchLike;
    health?: { ok: boolean; detail: string };
    channel?: string;
  } = {}) => createChannelHealthPort({
    fetchFn: input.fetchFn ?? graphDouble({ appIds: ["app-1"] }),
    graphVersion: "v26.0",
    appId: input.appId === undefined ? "app-1" : input.appId,
    resolveAccessToken: async () => (input.token === undefined ? "token-1" : input.token),
    getAdapter: () => adapter(input.health),
  });

  test("a non-WhatsApp account reports the credential check only", async () => {
    const report = await port({ channel: "messenger" }).check({ account, channel: "messenger" });
    expect(report.ok).toBe(true);
    expect(report.appSubscription).toBeUndefined();
    expect(report.channel).toBe("messenger");
  });

  test("our app in subscribed_apps means healthy", async () => {
    const report = await port().check({ account, channel: "whatsapp" });
    expect(report.ok).toBe(true);
    expect(report.appSubscription).toEqual({
      wabaId: "waba-1", subscribed: true, appIds: ["app-1"],
    });
  });

  test("uses the WABA stored on the account instead of the discovery lookup", async () => {
    // Discovery is dead on Graph v26 ((#100) nonexisting field); a stored
    // wabaId must carry the check without ever attempting it.
    const fetchFn = fakeFetch((url) => {
      if (url.includes("fields=whatsapp_business_account")) {
        return new Response(JSON.stringify({ error: { message: "(#100) Tried accessing nonexisting field (whatsapp_business_account)" } }), { status: 400 });
      }
      if (url.includes("/waba-stored/subscribed_apps")) {
        return new Response(JSON.stringify({ data: [{ waba_id: "waba-stored", app_id: "app-1" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: `unexpected ${url}` } }), { status: 404 });
    });
    const report = await port({ fetchFn }).check({
      account: { ...account, capabilities: { wabaId: "waba-stored" } },
      channel: "whatsapp",
    });
    expect(report.ok).toBe(true);
    expect(report.appSubscription).toEqual({ wabaId: "waba-stored", subscribed: true, appIds: ["app-1"] });
  });

  test("a token Meta rejects (190) is a problem, not 'healthy'", async () => {
    // The 2026-10-28 live shape: the subscription answer stays "unknown"
    // (tri-state honesty), but a credential Meta itself rejected must
    // flip the headline verdict - the test-number account reported
    // "healthy" with a dead token before this.
    const fetchFn = fakeFetch((url) => {
      if (url.includes("/subscribed_apps")) {
        return new Response(JSON.stringify({
          error: { message: "Error validating access token: Session has expired", code: 190, type: "OAuthException" },
        }), { status: 401 });
      }
      return new Response(JSON.stringify({ error: { message: `unexpected ${url}` } }), { status: 404 });
    });
    const report = await port({ fetchFn }).check({
      account: { ...account, capabilities: { wabaId: "waba-1" } },
      channel: "whatsapp",
    });
    expect(report.ok).toBe(false);
    expect(report.appSubscription?.subscribed).toBeNull();
    expect(report.appSubscription?.tokenRejected).toBe(true);
    expect(report.detail).toContain("rejected the access token");
  });

  test("a missing subscription is the failure this check exists for", async () => {
    const report = await port({ fetchFn: graphDouble({ appIds: ["some-other-app"] }) })
      .check({ account, channel: "whatsapp" });
    expect(report.ok).toBe(false);
    expect(report.appSubscription?.subscribed).toBe(false);
    expect(report.detail).toContain("NOT subscribed");
    expect(report.detail).toContain("inbound messages will not arrive");
  });

  test("without META_APP_ID the answer is 'unknown', not a false alarm", async () => {
    const report = await port({ appId: null }).check({ account, channel: "whatsapp" });
    expect(report.ok).toBe(true);
    expect(report.appSubscription?.subscribed).toBeNull();
    expect(report.appSubscription?.detail).toContain("META_APP_ID");
    // The app ids are still reported - the operator can compare by hand.
    expect(report.appSubscription?.appIds).toEqual(["app-1"]);
  });

  test("no resolvable token: unknown subscription, credential failure reported", async () => {
    const report = await port({ token: null, health: { ok: false, detail: "no token" } })
      .check({ account, channel: "whatsapp" });
    expect(report.ok).toBe(false);
    expect(report.appSubscription?.subscribed).toBeNull();
    expect(report.appSubscription?.detail).toContain("No access token");
  });

  test("a failing subscribed_apps call is 'unknown' with Meta's reason", async () => {
    const report = await port({ fetchFn: graphDouble({ subscribedError: "boom" }) })
      .check({ account, channel: "whatsapp" });
    expect(report.appSubscription?.subscribed).toBeNull();
    expect(report.appSubscription?.detail).toBe("boom");
    expect(report.appSubscription?.wabaId).toBe("waba-1");
  });

  test("a WABA discovery failure never throws out of the health check", async () => {
    const fetchFn = fakeFetch(() => new Response(JSON.stringify({ error: { message: "no such number" } }), { status: 400 }));
    const report = await port({ fetchFn }).check({ account, channel: "whatsapp" });
    expect(report.appSubscription?.subscribed).toBeNull();
    expect(report.appSubscription?.wabaId).toBeNull();
    expect(report.appSubscription?.detail).toContain("no such number");
  });

  test("a throwing adapter.health is a report, not an exception", async () => {
    const throwing = {
      async health() { throw new Error("vault exploded"); },
      async send() { throw new Error("not used"); },
      async parseWebhook() { return []; },
    } as unknown as ChannelAdapter;
    const report = await createChannelHealthPort({
      fetchFn: graphDouble({ appIds: [] }),
      appId: "app-1",
      resolveAccessToken: async () => "token-1",
      getAdapter: () => throwing,
    }).check({ account: { id: "acc-9", externalId: "phone-9" }, channel: "messenger" });
    expect(report.ok).toBe(false);
    expect(report.detail).toContain("vault exploded");
  });
});

// ---------------------------------------------------------------- route

let fake: FakeDatabase;
let owner: Registered;
let other: Registered;
let checked: string[];

const app = createApp(testDeps({
  getDatabase: () => fake.db,
  channelHealth: {
    async check(input) {
      checked.push(input.account.id);
      return {
        accountId: input.account.id,
        channel: input.channel,
        ok: false,
        detail: "app is NOT subscribed",
        checkedAt: "2026-10-27T12:00:00.000Z",
        appSubscription: { wabaId: "waba-1", subscribed: false, appIds: ["other-app"] },
      };
    },
  },
}));

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(app, "health-owner@example.com");
  other = await registerUser(app, "health-other@example.com");
  const ws = owner.workspaceId;
  fake.seed("workspaces", { id: ws, name: "Toko Health", slug: "toko-health" });
  fake.seed("workspaces", { id: other.workspaceId, name: "Toko Lain", slug: "toko-lain-health" });
  fake.seed("channelAccounts", {
    id: "acc-wa", workspaceId: ws, channel: "whatsapp",
    externalId: "phone-1", displayName: "WA Toko", status: "connected",
    tokenVaultRef: "vault-1", authMode: null,
  });
});

describe("GET /channels/{id}/health", () => {
  test("returns the report verbatim (a problem is a 200 with ok:false)", async () => {
    checked = [];
    const res = await app.request("/channels/acc-wa/health", { headers: owner.headers });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean; detail: string; appSubscription: { subscribed: boolean };
    };
    expect(body.ok).toBe(false);
    expect(body.detail).toContain("NOT subscribed");
    expect(body.appSubscription.subscribed).toBe(false);
    expect(checked).toEqual(["acc-wa"]);
  });

  test("an unknown account is a 404", async () => {
    const res = await app.request("/channels/nope/health", { headers: owner.headers });
    expect(res.status).toBe(404);
  });

  test("another workspace's account is a 404 (the port is never reached)", async () => {
    checked = [];
    const res = await app.request("/channels/acc-wa/health", { headers: other.headers });
    expect(res.status).toBe(404);
    expect(checked).toHaveLength(0);
  });
});
