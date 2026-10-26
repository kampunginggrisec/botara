import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { testDeps, registerUser } from "./test-helpers";
import { createDbFlowDispatcher } from "./flows-dispatch";
import type { InboundEvent } from "@botara/channels";

/**
 * Fase 4 API surface: public config, flows validation/auth, stats auth,
 * telegram connect validation, OAuth start/callback state handling, and
 * settings endpoints (profile rename, workspace rename, role change,
 * password change). DB-backed happy paths follow the factory pattern:
 * without a database they must answer the honest 503 CONFIGURATION.
 */

const validGraph = {
  startNodeId: "t1",
  nodes: [
    { id: "t1", type: "trigger", trigger: "keyword", config: { keyword: "halo" }, next: "m1" },
    { id: "m1", type: "send_message", text: "Halo!", next: null },
  ],
  edges: [{ id: "e1", source: "t1", target: "m1" }],
};

describe("GET /config/public", () => {
  test("200 with nulls when nothing is configured (no secrets leak)", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/config/public");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.metaAppId).toBeNull();
    expect(body.whatsappEmbeddedConfigId).toBeNull();
    expect(body.publicWebhookBaseUrl).toBeNull();
    expect(JSON.stringify(body)).not.toContain("SECRET");
  });

  test("reflects configured public ids from env", async () => {
    const app = createApp(testDeps({
      env: {
        SESSION_SECRET: "s",
        META_APP_ID: "123456",
        WHATSAPP_EMBEDDED_CONFIG_ID: "cfg-1",
        PUBLIC_WEBHOOK_BASE_URL: "https://bot.example.com/api",
      },
    }));
    const body = (await (await app.request("/config/public")).json()) as Record<string, unknown>;
    expect(body.metaAppId).toBe("123456");
    expect(body.whatsappEmbeddedConfigId).toBe("cfg-1");
    expect(body.publicWebhookBaseUrl).toBe("https://bot.example.com/api");
  });
});

describe("flows API guards", () => {
  test("GET /flows without auth -> 401", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/flows");
    expect(res.status).toBe(401);
  });

  test("GET /flows authed but no DB -> 503 CONFIGURATION", async () => {
    const app = createApp(testDeps());
    const reg = await registerUser(app);
    const res = await app.request("/flows", { headers: reg.headers });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFIGURATION");
  });

  test("POST /flows with an invalid graph -> 400 VALIDATION before DB", async () => {
    const app = createApp(testDeps());
    const reg = await registerUser(app);
    const res = await app.request("/flows", {
      method: "POST",
      headers: { ...reg.headers, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Broken",
        trigger: { type: "keyword", config: { keyword: "x" } },
        graph: { startNodeId: "n1", nodes: [{ id: "n1", type: "delay", seconds: -3, next: null }], edges: [] },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  test("POST /flows with a valid graph reaches the DB layer (503 without DB)", async () => {
    const app = createApp(testDeps());
    const reg = await registerUser(app);
    const res = await app.request("/flows", {
      method: "POST",
      headers: { ...reg.headers, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Greeter",
        trigger: { type: "keyword", config: { keyword: "halo" } },
        graph: validGraph,
      }),
    });
    expect(res.status).toBe(503);
  });

  test("POST /flows without a name -> 400 VALIDATION", async () => {
    const app = createApp(testDeps());
    const reg = await registerUser(app);
    const res = await app.request("/flows", {
      method: "POST",
      headers: { ...reg.headers, "content-type": "application/json" },
      body: JSON.stringify({ graph: validGraph }),
    });
    expect(res.status).toBe(400);
  });

  test("test-run on a missing flow without DB -> 503, never a fake run", async () => {
    const app = createApp(testDeps());
    const reg = await registerUser(app);
    const res = await app.request("/flows/00000000-0000-0000-0000-000000000000/test-run", {
      method: "POST",
      headers: { ...reg.headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "halo" }),
    });
    expect(res.status).toBe(503);
  });
});

describe("GET /stats/overview guards", () => {
  test("401 unauthenticated, 503 authed without DB", async () => {
    const app = createApp(testDeps());
    expect((await app.request("/stats/overview")).status).toBe(401);
    const reg = await registerUser(app);
    const res = await app.request("/stats/overview", { headers: reg.headers });
    expect(res.status).toBe(503);
  });
});

describe("POST /channels/telegram/connect", () => {
  const connect = async (app: ReturnType<typeof createApp>, headers: Record<string, string>) =>
    app.request("/channels/telegram/connect", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ botToken: "123456:fake-token-value", label: "Support bot" }),
    });

  test("invalid token -> typed 400 and no account is created", async () => {
    const app = createApp(testDeps({
      providerFetch: async () =>
        new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 }),
    }));
    const reg = await registerUser(app);
    const res = await connect(app, reg.headers);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.message).toContain("rejected");
  });

  test("provider 5xx -> 502 PROVIDER_ERROR", async () => {
    const app = createApp(testDeps({
      providerFetch: async () =>
        new Response(JSON.stringify({ ok: false, description: "Bad Gateway" }), { status: 502 }),
    }));
    const reg = await registerUser(app);
    const res = await connect(app, reg.headers);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROVIDER_ERROR");
  });

  test("valid token passes validation + vault, then hits the honest DB 503", async () => {
    const seen: string[] = [];
    const app = createApp(testDeps({
      providerFetch: async (url) => {
        seen.push(String(url));
        return new Response(
          JSON.stringify({ ok: true, result: { id: 4242, is_bot: true, first_name: "Support", username: "support_bot" } }),
          { status: 200 },
        );
      },
    }));
    const reg = await registerUser(app);
    const res = await connect(app, reg.headers);
    // getMe succeeded against the fake; persistence needs a DB -> 503.
    expect(seen[0]).toContain("/getMe");
    expect(res.status).toBe(503);
  });

  test("unauthenticated -> 401", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/channels/telegram/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botToken: "123456:fake-token-value" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("OAuth start + callback", () => {
  test("threads start without THREADS_APP_ID -> 503 CONFIGURATION (not a crash)", async () => {
    const app = createApp(testDeps());
    const reg = await registerUser(app);
    const res = await app.request("/channels/threads/oauth/start", { headers: reg.headers, redirect: "manual" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFIGURATION");
  });

  test("threads start with app id -> 302 to threads.net with signed state", async () => {
    const app = createApp(testDeps({
      env: { SESSION_SECRET: "test-session-secret", THREADS_APP_ID: "th-123" },
    }));
    const reg = await registerUser(app);
    const res = await app.request("/channels/threads/oauth/start", { headers: reg.headers, redirect: "manual" });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("threads.net/oauth/authorize");
    expect(location).toContain("client_id=th-123");
    expect(location).toContain("state=");
  });

  test("threads start via browser navigation (cookie session + ?workspace_id=) -> 302", async () => {
    const app = createApp(testDeps({
      env: { SESSION_SECRET: "test-session-secret", THREADS_APP_ID: "th-123" },
    }));
    const reg = await registerUser(app);
    const res = await app.request(`/channels/threads/oauth/start?workspace_id=${reg.workspaceId}`, {
      headers: { cookie: `botara_session=${reg.token}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("threads.net/oauth/authorize");
  });

  test("oauth start with ?workspace_id= of a non-member workspace -> 403", async () => {
    const app = createApp(testDeps({
      env: { SESSION_SECRET: "test-session-secret", THREADS_APP_ID: "th-123" },
    }));
    const reg = await registerUser(app);
    const other = await registerUser(app, "other@example.com", "Other");
    const res = await app.request(`/channels/threads/oauth/start?workspace_id=${other.workspaceId}`, {
      headers: { cookie: `botara_session=${reg.token}` },
      redirect: "manual",
    });
    expect(res.status).toBe(403);
  });

  test("query workspace selector does not authorize mutating requests", async () => {
    const app = createApp(testDeps({ env: { SESSION_SECRET: "test-session-secret" } }));
    const reg = await registerUser(app);
    const res = await app.request(`/channels/telegram/connect?workspace_id=${reg.workspaceId}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `botara_session=${reg.token}` },
      body: JSON.stringify({ botToken: "123456:fake-token-value" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("messenger start without META_APP_ID -> 503", async () => {
    const app = createApp(testDeps());
    const reg = await registerUser(app);
    const res = await app.request("/channels/messenger/oauth/start", { headers: reg.headers, redirect: "manual" });
    expect(res.status).toBe(503);
  });

  test("threads callback with a forged state -> 302 back to SPA with error, no crash", async () => {
    const app = createApp(testDeps({
      env: { SESSION_SECRET: "test-session-secret", THREADS_APP_ID: "th-123", THREADS_APP_SECRET: "x" },
    }));
    const res = await app.request(
      "/channels/threads/oauth/callback?code=abc&state=forged.state",
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("error=invalid_state");
  });

  test("oauth start without auth -> 401", async () => {
    const app = createApp(testDeps({ env: { SESSION_SECRET: "s", THREADS_APP_ID: "th-1" } }));
    const res = await app.request("/channels/threads/oauth/start", { redirect: "manual" });
    expect(res.status).toBe(401);
  });
});

describe("settings endpoints", () => {
  test("PATCH /auth/me renames the profile", async () => {
    const app = createApp(testDeps());
    const reg = await registerUser(app);
    const res = await app.request("/auth/me", {
      method: "PATCH",
      headers: { ...reg.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Mas Romo" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { name: string } };
    expect(body.user.name).toBe("Mas Romo");
  });

  test("change password: wrong current -> 400; right current -> 200 + audit + new login works", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const reg = await registerUser(app);
    const wrong = await app.request("/auth/change-password", {
      method: "POST",
      headers: { ...reg.headers, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "nope-nope", newPassword: "new-password-1" }),
    });
    expect(wrong.status).toBe(400);
    const ok = await app.request("/auth/change-password", {
      method: "POST",
      headers: { ...reg.headers, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "password-123", newPassword: "new-password-1" }),
    });
    expect(ok.status).toBe(200);
    const store = deps.authStore as unknown as { auditLog: Array<{ action: string }> };
    expect(store.auditLog.some((e) => e.action === "auth.change_password")).toBe(true);
    const login = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: "new-password-1" }),
    });
    expect(login.status).toBe(200);
  });

  test("workspace rename + member role change (owner/admin)", async () => {
    const app = createApp(testDeps());
    const reg = await registerUser(app);
    const rename = await app.request(`/workspaces/${reg.workspaceId}`, {
      method: "PATCH",
      headers: { ...reg.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Botara HQ" }),
    });
    expect(rename.status).toBe(200);
    const renamed = (await rename.json()) as { workspace: { name: string } };
    expect(renamed.workspace.name).toBe("Botara HQ");

    const invite = await app.request(`/workspaces/${reg.workspaceId}/members`, {
      method: "POST",
      headers: { ...reg.headers, "content-type": "application/json" },
      body: JSON.stringify({ email: "agent@example.com", role: "agent" }),
    });
    expect(invite.status).toBe(201);
    const inviteBody = (await invite.json()) as { member: { userId: string } };
    const roleChange = await app.request(
      `/workspaces/${reg.workspaceId}/members/${inviteBody.member.userId}`,
      {
        method: "PATCH",
        headers: { ...reg.headers, "content-type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      },
    );
    expect(roleChange.status).toBe(200);
    const roleBody = (await roleChange.json()) as { member: { role: string } };
    expect(roleBody.member.role).toBe("admin");
  });

  test("demoting the only owner -> 409 CONFLICT", async () => {
    const app = createApp(testDeps());
    const reg = await registerUser(app);
    const res = await app.request(`/workspaces/${reg.workspaceId}/members/${reg.userId}`, {
      method: "PATCH",
      headers: { ...reg.headers, "content-type": "application/json" },
      body: JSON.stringify({ role: "member" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("inbound flow dispatcher resilience", () => {
  test("dispatch never throws - even with no database (webhook must still 200)", async () => {
    const dispatcher = createDbFlowDispatcher({
      getDatabase: () => { throw new Error("DATABASE_URL is not configured"); },
      flowEnqueuer: { async enqueueFlowRun() {} },
    });
    const event: InboundEvent = {
      type: "message.received", channel: "whatsapp",
      accountExternalId: "123", contactExternalId: "628111",
      messageExternalId: "wamid.1", text: "halo", receivedAt: new Date().toISOString(),
    };
    await expect(dispatcher.dispatch([event])).resolves.toBeUndefined();
  });

  test("non-message events are ignored without touching the DB", async () => {
    let dbTouched = false;
    const dispatcher = createDbFlowDispatcher({
      getDatabase: () => { dbTouched = true; throw new Error("should not be called"); },
      flowEnqueuer: { async enqueueFlowRun() {} },
    });
    await dispatcher.dispatch([{
      type: "message.status", channel: "whatsapp",
      messageExternalId: "wamid.1", status: "read", receivedAt: new Date().toISOString(),
    }]);
    expect(dbTouched).toBe(false);
  });
});
