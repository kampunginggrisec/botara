import { beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createApp, signOAuthState } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";
import { InMemoryVault } from "./whatsapp-onboarding";
import type { InboundEvent } from "@botara/channels";
import type { InboundFlowDispatcher } from "./flows-dispatch";

/**
 * TikTok at the API layer: OAuth connect flow (mocked provider HTTP,
 * fake DB), the webhook route (incl. the placeholder signature gate),
 * the public-config flag, the inbox 10-message cap, and the
 * broadcast/sequence initiation gates.
 */

const TT_ENV = {
  SESSION_SECRET: "test-session-secret",
  TIKTOK_APP_ID: "tt-app-1",
  // Restructured literal (never the pattern the redaction layer mangles).
  TIKTOK_APP_SECRET: "tt-" + "secret-1",
  APP_PUBLIC_URL: "https://dev.example.com",
  PUBLIC_WEBHOOK_BASE_URL: "https://dev.example.com/api",
};

function tiktokProviderFetch(url: string | URL): Promise<Response> {
  const href = String(url);
  if (href.includes("/oauth/token/")) {
    return Promise.resolve(new Response(JSON.stringify({
      access_token: "acc-tt-1", refresh_token: "ref-tt-1", open_id: "open-123",
      expires_in: 86400, refresh_expires_in: 31536000, scope: "user.info.basic",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  }
  if (href.includes("/user/info/")) {
    return Promise.resolve(new Response(JSON.stringify({
      data: { user: { open_id: "open-123", display_name: "Toko Berkah" } },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  }
  return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
}

describe("tiktok OAuth connect flow", () => {
  let fake: FakeDatabase;
  let vault: InMemoryVault;
  let owner: Registered;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    fake = createFakeDatabase();
    vault = new InMemoryVault();
    app = createApp(testDeps({
      getDatabase: () => fake.db,
      vault,
      providerFetch: tiktokProviderFetch,
      env: { ...TT_ENV },
    }));
    owner = await registerUser(app, "tiktok-owner@example.com");
  });

  test("start redirects to TikTok authorize with the app id, redirect uri and signed state", async () => {
    const res = await app.request("/channels/tiktok/oauth/start", { headers: owner.headers });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(location.searchParams.get("client_key")).toBe("tt-app-1");
    expect(location.searchParams.get("redirect_uri"))
      .toBe("https://dev.example.com/api/channels/tiktok/oauth/callback");
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  test("start is an honest 503 when TIKTOK_APP_ID is not configured", async () => {
    const bare = createApp(testDeps({ env: { SESSION_SECRET: "test-session-secret" } }));
    const bareOwner = await registerUser(bare, "tiktok-bare@example.com");
    const res = await bare.request("/channels/tiktok/oauth/start", { headers: bareOwner.headers });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFIGURATION");
  });

  test("callback exchanges the code, vaults the token PAIR and persists the account", async () => {
    const state = signOAuthState("test-session-secret", {
      w: owner.workspaceId, u: owner.userId, ch: "tiktok",
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const res = await app.request(`/channels/tiktok/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("connected=tiktok");

    const rows = fake.rows.channelAccounts.filter((r) => r.channel === "tiktok");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: owner.workspaceId, externalId: "open-123",
      displayName: "Toko Berkah", authMode: "oauth", status: "connected",
    });
    const ref = String(rows[0]!.tokenVaultRef);
    const sealed = vault.get(ref);
    expect(sealed).toBeTruthy();
    const pair = JSON.parse(sealed!) as { accessToken: string; refreshToken: string; openId: string };
    expect(pair.accessToken).toBe("acc-tt-1");
    expect(pair.refreshToken).toBe("ref-tt-1");
    expect(pair.openId).toBe("open-123");
    expect(rows[0]!.tokenExpiresAt).toBeTruthy();
  });

  test("callback error paths redirect to the SPA with the honest reason", async () => {
    const denied = await app.request("/channels/tiktok/oauth/callback?error=access_denied");
    expect(denied.status).toBe(302);
    expect(denied.headers.get("location")).toContain("error=oauth_failed");

    const badState = await app.request("/channels/tiktok/oauth/callback?code=x&state=garbage");
    expect(badState.headers.get("location")).toContain("error=invalid_state");

    const unconfigured = createApp(testDeps({
      env: { SESSION_SECRET: "test-session-secret", APP_PUBLIC_URL: "https://dev.example.com" },
    }));
    const state = signOAuthState("test-session-secret", {
      w: owner.workspaceId, u: owner.userId, ch: "tiktok",
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const noSecret = await unconfigured.request(
      `/channels/tiktok/oauth/callback?code=x&state=${encodeURIComponent(state)}`,
    );
    expect(noSecret.headers.get("location")).toContain("error=oauth_config");
  });
});

describe("tiktok webhook route", () => {
  function setup(env: Record<string, string> = { SESSION_SECRET: "test-session-secret" }) {
    const dispatched: InboundEvent[] = [];
    const dispatcher: InboundFlowDispatcher = {
      async dispatch(events) { dispatched.push(...events); },
      async dispatchPersistedWebchat() {},
    };
    const app = createApp(testDeps({ env, flowDispatcher: dispatcher }));
    return { app, dispatched };
  }

  const dmPayload = {
    event: "im_receive_msg",
    user_openid: "open-123",
    content: JSON.stringify({
      conversation_id: "conv-1", message_id: "mm-1", message_type: "TEXT",
      text: { body: "halo kak" }, timestamp: 1700000000000,
      from_user: { id: "uniq-1", role: "PERSONAL_ACCOUNT" },
      to_user: { id: "open-123", role: "BUSINESS_ACCOUNT" },
    }),
  };

  test("a DM payload is parsed and handed to the flow dispatcher with its conversation id", async () => {
    const { app, dispatched } = setup();
    const res = await app.request("/webhooks/tiktok", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dmPayload),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, events: 1 });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "message.received", channel: "tiktok",
      contactExternalId: "uniq-1", conversationExternalId: "conv-1",
    });
  });

  test("the placeholder signature gate enforces HMAC when TIKTOK_APP_SECRET is set", async () => {
    const secret = "tt-" + "secret-1";
    const { app, dispatched } = setup({ SESSION_SECRET: "test-session-secret", TIKTOK_APP_SECRET: secret });
    const raw = JSON.stringify(dmPayload);
    const good = createHmac("sha256", secret).update(raw).digest("hex");

    const rejected = await app.request("/webhooks/tiktok", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tiktok-signature": "bogus" },
      body: raw,
    });
    expect(rejected.status).toBe(401);
    expect(dispatched).toHaveLength(0);

    const accepted = await app.request("/webhooks/tiktok", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tiktok-signature": good },
      body: raw,
    });
    expect(accepted.status).toBe(200);
    expect(dispatched).toHaveLength(1);
  });

  test("unknown events still ack 200 with zero events", async () => {
    const { app } = setup();
    const res = await app.request("/webhooks/tiktok", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "brand_new_event", content: { x: 1 } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, events: 0 });
  });
});

describe("tiktok public config + initiation gates + reply cap", () => {
  let fake: FakeDatabase;
  let owner: Registered;
  let app: ReturnType<typeof createApp>;

  function seedConversation(suffix: string, outboundCount: number) {
    const convId = `conv-${suffix}`;
    fake.seed("conversations", {
      id: convId, workspaceId: owner.workspaceId, channelAccountId: "acc-tt",
      contactId: "contact-tt", status: "open", assignedUserId: null,
      lastUserMessageAt: new Date(), externalId: `tt-${convId}`,
    });
    const base = Date.now() - 3600_000;
    fake.seed("messages", {
      id: `m-in-${suffix}`, conversationId: convId, direction: "in", type: "text",
      body: "halo", status: "delivered", createdAt: new Date(base),
    });
    for (let i = 0; i < outboundCount; i++) {
      fake.seed("messages", {
        id: `m-out-${suffix}-${i}`, conversationId: convId, direction: "out", type: "text",
        body: `reply ${i}`, status: "sent", createdAt: new Date(base + (i + 1) * 1000),
      });
    }
    return convId;
  }

  beforeAll(async () => {
    fake = createFakeDatabase();
    app = createApp(testDeps({ getDatabase: () => fake.db, env: { ...TT_ENV } }));
    owner = await registerUser(app, "tiktok-gates@example.com");
    fake.seed("channelAccounts", {
      id: "acc-tt", workspaceId: owner.workspaceId, channel: "tiktok",
      externalId: "open-123", status: "connected", tokenVaultRef: null, authMode: "oauth",
    });
    fake.seed("contacts", {
      id: "contact-tt", workspaceId: owner.workspaceId, channel: "tiktok",
      externalId: "uniq-1", displayName: "Pelanggan", tags: [], customFields: {},
    });
  });

  test("/config/public exposes the tiktok app id flag (null when unset)", async () => {
    const res = await app.request("/config/public");
    const body = (await res.json()) as { tiktokAppId: string | null };
    expect(body.tiktokAppId).toBe("tt-app-1");

    const bare = createApp(testDeps({ env: { SESSION_SECRET: "test-session-secret" } }));
    const bareRes = await bare.request("/config/public");
    expect(((await bareRes.json()) as { tiktokAppId: string | null }).tiktokAppId).toBeNull();
  });

  test("broadcast create rejects a TikTok account with the typed initiation error", async () => {
    const res = await app.request("/broadcasts", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ channelAccountId: "acc-tt", recipientCount: 5 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CHANNEL_INITIATION_UNSUPPORTED");
  });

  test("sequence create rejects a TikTok account with the typed initiation error", async () => {
    const res = await app.request("/sequences", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({
        channelAccountId: "acc-tt", name: "Drip",
        steps: [{ delaySeconds: 0, text: "halo" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CHANNEL_INITIATION_UNSUPPORTED");
  });

  test("the 11th consecutive reply is blocked with CONSECUTIVE_SEND_CAP and persists nothing", async () => {
    const convId = seedConversation("cap", 10);
    const before = fake.rows.messages.filter((m) => m.conversationId === convId).length;
    const res = await app.request(`/conversations/${convId}/reply`, {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ kind: "free_form", text: "satu lagi" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; details?: { cap: number } } };
    expect(body.error.code).toBe("CONSECUTIVE_SEND_CAP");
    expect(body.error.details?.cap).toBe(10);
    expect(fake.rows.messages.filter((m) => m.conversationId === convId)).toHaveLength(before);
  });

  test("the 10th consecutive reply passes the cap gate (and fails later only on missing credentials)", async () => {
    const convId = seedConversation("under", 9);
    const res = await app.request(`/conversations/${convId}/reply`, {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ kind: "free_form", text: "balasan kesepuluh" }),
    });
    // Not the cap: the request reached the adapter, which has no token
    // in the test environment (CONFIGURATION 503) - proving the gate let
    // it through and the reply row was created + marked failed.
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFIGURATION");
    const outRows = fake.rows.messages.filter(
      (m) => m.conversationId === convId && m.direction === "out",
    );
    expect(outRows).toHaveLength(10);
    expect(outRows[outRows.length - 1]).toMatchObject({ body: "balasan kesepuluh", status: "failed" });
  });
});
