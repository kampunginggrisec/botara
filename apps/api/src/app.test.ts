import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { InMemoryAuthStore } from "./auth";
import { registerUser, testDeps } from "./test-helpers";

describe("api app (no DB configured)", () => {
  test("GET /health", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "api" });
  });

  test("POST /broadcasts/estimate works WITHOUT a database and WITHOUT auth (pure public calculator)", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/broadcasts/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        category: "marketing",
        countryMix: [{ country: "ID", recipients: 100 }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalUsd: number; ratesVersion: string; lines: unknown[] };
    expect(body.totalUsd).toBeCloseTo(4.16, 6);
    expect(body.ratesVersion).toBe("sample-2026-q4");
    expect(body.lines).toHaveLength(1);
  });

  test("GET /conversations without a session token -> 401 UNAUTHORIZED", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/conversations", { headers: { "x-workspace-id": "ws-1" } });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("GET /conversations with a token but no workspace selected -> 400 VALIDATION", async () => {
    const app = createApp(testDeps());
    const reg = await registerUser(app);
    const res = await app.request("/conversations", {
      headers: { authorization: `Bearer ${reg.token}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  test("GET /conversations for a workspace the user does not belong to -> 403 FORBIDDEN", async () => {
    const app = createApp(testDeps());
    const reg = await registerUser(app);
    const res = await app.request("/conversations", {
      headers: { authorization: `Bearer ${reg.token}`, "x-workspace-id": "someone-elses-ws" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("GET /conversations authenticated + member, DB unconfigured -> 503 CONFIGURATION (not a crash)", async () => {
    const app = createApp(testDeps());
    const reg = await registerUser(app);
    const res = await app.request("/conversations", { headers: reg.headers });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFIGURATION");
  });

  test("dev header fallback stays OFF by default and works only when explicitly enabled", async () => {
    const off = createApp(testDeps());
    const resOff = await off.request("/conversations", { headers: { "x-workspace-id": "ws-1" } });
    expect(resOff.status).toBe(401);

    const on = createApp(testDeps({
      env: { SESSION_SECRET: "test-session-secret", BOTARA_ALLOW_HEADER_WORKSPACE: "1" },
    }));
    const resOn = await on.request("/conversations", { headers: { "x-workspace-id": "ws-1" } });
    // Past auth (fallback) -> the request reaches the handler -> 503 from the missing DB.
    expect(resOn.status).toBe(503);
  });

  test("WhatsApp webhook GET verification returns the challenge", async () => {
    const app = createApp(testDeps());
    const res = await app.request(
      "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc123");
  });

  test("WhatsApp webhook GET verification rejects a wrong token", async () => {
    const app = createApp(testDeps());
    const res = await app.request(
      "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123",
    );
    expect(res.status).toBe(403);
  });

  test("WhatsApp webhook refuses unsigned payloads in production", async () => {
    const app = createApp(testDeps({ env: {
      NODE_ENV: "production",
      WHATSAPP_VERIFY_TOKEN: "verify-me",
      SESSION_SECRET: "test-session-secret",
    } }));
    const res = await app.request("/webhooks/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ object: "whatsapp_business_account", entry: [] }),
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("CONFIGURATION");
  });

  test("Telegram webhook enforces the secret token when configured", async () => {
    const app = createApp(testDeps({ env: { TELEGRAM_WEBHOOK_SECRET: "s3cret" } }));
    const res = await app.request("/webhooks/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(res.status).toBe(401);
  });
});

describe("api app - Fase 2 routes under Fase 3 auth", () => {
  test("POST /conversations/:id/ai-suggest without an AI provider -> 503 CONFIGURATION (never faked)", async () => {
    const app = createApp(testDeps());
    const reg = await registerUser(app);
    const res = await app.request("/conversations/conv-1/ai-suggest", {
      method: "POST",
      headers: { ...reg.headers, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFIGURATION");
  });

  test("webchat session endpoint without DB -> 503 CONFIGURATION (not a crash)", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/public/webchat/ws-1/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visitorName: "Budi" }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFIGURATION");
  });

  test("webchat message send without a session token -> 401", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/public/webchat/ws-1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "halo" }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /moderation/check flags list terms without a database (authenticated since B2)", async () => {
    const app = createApp(testDeps());
    const owner = await registerUser(app, "moderation@example.com");
    const res = await app.request("/moderation/check", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "jangan bagikan kode otp kamu" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flagged: boolean; matches: unknown[] };
    expect(body.flagged).toBe(true);
    expect(body.matches.length).toBeGreaterThan(0);
  });

  test("WhatsApp template category change webhook is APPLIED through the updater port", async () => {
    const applied: unknown[] = [];
    const app = createApp(testDeps({
      templateCategoryUpdater: {
        async applyCategoryChange(event) { applied.push(event); },
      },
    }));
    const payload = {
      object: "whatsapp_business_account",
      entry: [{
        id: "waba-99",
        changes: [{
          field: "message_template_category_update",
          value: {
            message_template_id: 12345,
            message_template_name: "promo_diskon",
            message_template_language: "id",
            previous_category: "UTILITY",
            new_category: "MARKETING",
          },
        }],
      }],
    };
    const res = await app.request("/webhooks/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    expect(applied).toHaveLength(1);
    const event = applied[0] as {
      type: string; templateExternalId: string; newCategory: string; previousCategory?: string; accountExternalId?: string;
    };
    expect(event.type).toBe("template.category_changed");
    expect(event.templateExternalId).toBe("12345");
    expect(event.newCategory).toBe("marketing");
    expect(event.previousCategory).toBe("utility");
    expect(event.accountExternalId).toBe("waba-99");
  });

  test("embedded-signup exchange is delegated to the onboarding port; result carries no secrets", async () => {
    const seen: Array<{ workspaceId: string; code: string }> = [];
    const app = createApp(testDeps({
      whatsappOnboarding: async (workspaceId, input) => {
        seen.push({ workspaceId, code: input.code });
        return {
          wabaId: "waba-1",
          isCoexistence: true,
          accounts: [{ phoneNumberId: "pn-1", channelAccountId: "db-1" }],
        };
      },
    }));
    const reg = await registerUser(app);
    const res = await app.request("/channels/whatsapp/embedded-signup/exchange", {
      method: "POST",
      headers: { ...reg.headers, "content-type": "application/json" },
      body: JSON.stringify({ code: "the-code", sessionInfo: { isCoexistence: true } }),
    });
    expect(res.status).toBe(201);
    expect(seen).toEqual([{ workspaceId: reg.workspaceId, code: "the-code" }]);
    const body = (await res.json()) as { result: { wabaId: string; accounts: unknown[] } };
    expect(body.result.wabaId).toBe("waba-1");
    expect(JSON.stringify(body)).not.toContain("token");
  });

  test("Instagram webhook parses events through the real adapter", async () => {
    const handled: unknown[] = [];
    const app = createApp(testDeps({
      eventSink: { async handle(events) { handled.push(...events); } },
    }));
    const payload = {
      object: "instagram",
      entry: [{
        id: "ig-1",
        changes: [{ field: "comments", value: { id: "c-1", text: "keren", from: { id: "u-1" }, media: { id: "p-1" } } }],
      }],
    };
    const res = await app.request("/webhooks/instagram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({ type: "comment.received", channel: "instagram", commentExternalId: "c-1" });
  });

  test("Resend webhook verifies Svix signatures when a secret is configured", async () => {
    const app = createApp(testDeps({ env: { RESEND_WEBHOOK_SECRET: "whsec_dGVzdA==" } }));
    const res = await app.request("/webhooks/resend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "email.delivered", data: { email_id: "e-1" } }),
    });
    expect(res.status).toBe(401); // no svix headers -> rejected
  });

  test("GET /channels/accounts authenticated, DB unconfigured -> 503 CONFIGURATION", async () => {
    const app = createApp(testDeps());
    const reg = await registerUser(app);
    const res = await app.request("/channels/accounts", { headers: reg.headers });
    expect(res.status).toBe(503);
  });

  test("GET /posts authenticated, DB unconfigured -> 503 CONFIGURATION", async () => {
    const app = createApp(testDeps());
    const reg = await registerUser(app);
    const res = await app.request("/posts", { headers: reg.headers });
    expect(res.status).toBe(503);
  });
});

describe("auth flow (Fase 3)", () => {
  test("register -> login -> me happy path, with cookie + audit trail", async () => {
    const authStore = new InMemoryAuthStore();
    const app = createApp(testDeps({ authStore }));

    const regRes = await app.request("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "rina@example.com", password: "password-123", name: "Rina" }),
    });
    expect(regRes.status).toBe(201);
    const cookie = regRes.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("botara_session=");
    expect(cookie).toContain("HttpOnly");
    const reg = (await regRes.json()) as {
      token: string; user: { id: string; email: string }; workspace: { id: string; role: string };
    };
    expect(reg.user.email).toBe("rina@example.com");
    expect(reg.workspace.role).toBe("owner");

    const loginRes = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "rina@example.com", password: "password-123" }),
    });
    expect(loginRes.status).toBe(200);
    const login = (await loginRes.json()) as { token: string; workspaces: Array<{ id: string; role: string }> };
    expect(login.workspaces).toHaveLength(1);
    expect(login.workspaces[0]!.id).toBe(reg.workspace.id);

    // /auth/me accepts the Bearer token...
    const meRes = await app.request("/auth/me", {
      headers: { authorization: `Bearer ${login.token}` },
    });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { user: { email: string }; workspaces: unknown[] };
    expect(me.user.email).toBe("rina@example.com");
    expect(me.workspaces).toHaveLength(1);

    // ...and the cookie.
    const meCookie = await app.request("/auth/me", {
      headers: { cookie: `botara_session=${login.token}` },
    });
    expect(meCookie.status).toBe(200);

    expect(authStore.auditLog.map((a) => a.action)).toEqual(["auth.register", "auth.login"]);
  });

  test("login failures are a generic 401; duplicate registration is a 409", async () => {
    const app = createApp(testDeps());
    await registerUser(app, "dup@example.com");

    const wrongPassword = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dup@example.com", password: "wrong-password" }),
    });
    expect(wrongPassword.status).toBe(401);

    const unknownEmail = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ghost@example.com", password: "password-123" }),
    });
    expect(unknownEmail.status).toBe(401);
    const wrongBody = (await wrongPassword.json()) as { error: { message: string } };
    const unknownBody = (await unknownEmail.json()) as { error: { message: string } };
    expect(wrongBody.error.message).toBe(unknownBody.error.message);

    const duplicate = await app.request("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dup@example.com", password: "password-456" }),
    });
    expect(duplicate.status).toBe(409);
  });

  test("/auth/me without a token -> 401; with a tampered token -> 401", async () => {
    const app = createApp(testDeps());
    const noToken = await app.request("/auth/me");
    expect(noToken.status).toBe(401);

    const reg = await registerUser(app);
    const tampered = `${reg.token.slice(0, -2)}xx`;
    const bad = await app.request("/auth/me", { headers: { authorization: `Bearer ${tampered}` } });
    expect(bad.status).toBe(401);
  });

  test("workspaces: create + list; members: invite by email, role guard, remove", async () => {
    const authStore = new InMemoryAuthStore();
    const app = createApp(testDeps({ authStore }));
    const owner = await registerUser(app, "boss@example.com");

    const created = await app.request("/workspaces", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Toko Kopi" }),
    });
    expect(created.status).toBe(201);
    const shop = (await created.json()) as { workspace: { id: string; slug: string } };
    expect(shop.workspace.slug).toBe("toko-kopi");

    const list = await app.request("/workspaces", { headers: owner.headers });
    const listBody = (await list.json()) as { workspaces: unknown[] };
    expect(listBody.workspaces).toHaveLength(2); // personal + Toko Kopi

    // Invite an agent by email (creates a passwordless user row).
    const invite = await app.request(`/workspaces/${shop.workspace.id}/members`, {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ email: "agent@example.com", role: "agent" }),
    });
    expect(invite.status).toBe(201);
    const inviteBody = (await invite.json()) as { member: { userId: string; role: string } };
    expect(inviteBody.member.role).toBe("agent");

    // The invited agent claims the account by registering, then logs in.
    const claim = await app.request("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "agent@example.com", password: "password-123", name: "Agent" }),
    });
    expect(claim.status).toBe(201);
    const agentLogin = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "agent@example.com", password: "password-123" }),
    });
    const agentBody = (await agentLogin.json()) as { token: string };
    const agentHeaders = {
      authorization: `Bearer ${agentBody.token}`,
      "x-workspace-id": shop.workspace.id,
    };

    // Agent CAN read (reaches the handler -> 503 from the unconfigured DB)...
    const read = await app.request("/conversations", { headers: agentHeaders });
    expect(read.status).toBe(503);
    // ...but CANNOT mutate: the role guard fires before any DB access.
    const mutate = await app.request("/contacts", {
      method: "POST",
      headers: { ...agentHeaders, "content-type": "application/json" },
      body: JSON.stringify({ channel: "whatsapp", externalId: "6281" }),
    });
    expect(mutate.status).toBe(403);
    const mutateBody = (await mutate.json()) as { error: { code: string } };
    expect(mutateBody.error.code).toBe("FORBIDDEN");

    // A plain member CAN mutate (guard passes; the 503 is the missing DB).
    const inviteMember = await app.request(`/workspaces/${shop.workspace.id}/members`, {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com", role: "member" }),
    });
    expect(inviteMember.status).toBe(201);

    // The agent cannot administer members (owner/admin only).
    const agentAdmin = await app.request(`/workspaces/${shop.workspace.id}/members`, {
      method: "POST",
      headers: { ...agentHeaders, "content-type": "application/json" },
      body: JSON.stringify({ email: "sneaky@example.com", role: "member" }),
    });
    expect(agentAdmin.status).toBe(403);

    // Owner removes the agent; audit recorded both member events.
    const removed = await app.request(
      `/workspaces/${shop.workspace.id}/members/${inviteBody.member.userId}`,
      { method: "DELETE", headers: owner.headers },
    );
    expect(removed.status).toBe(200);
    const memberActions = authStore.auditLog
      .filter((a) => a.action.startsWith("workspace.member."))
      .map((a) => a.action);
    expect(memberActions).toEqual(["workspace.member.add", "workspace.member.add", "workspace.member.remove"]);

    // The workspace's only owner cannot be removed.
    const removeOwner = await app.request(
      `/workspaces/${shop.workspace.id}/members/${owner.userId}`,
      { method: "DELETE", headers: owner.headers },
    );
    expect(removeOwner.status).toBe(409);
  });
});
