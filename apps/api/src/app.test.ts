import { describe, expect, test } from "bun:test";
import { AppError } from "@botara/shared";
import { createApp, type ApiDeps } from "./app";

function testDeps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  return {
    getDatabase: () => {
      throw new AppError("CONFIGURATION", "DATABASE_URL is not configured (test).", { status: 503 });
    },
    eventSink: { async handle() {} },
    broadcastEnqueuer: { async enqueueBroadcast() {} },
    publishEnqueuer: { async enqueuePublish() {} },
    templateCategoryUpdater: { async applyCategoryChange() {} },
    whatsappOnboarding: async () => {
      throw new AppError("CONFIGURATION", "onboarding not configured (test).", { status: 503 });
    },
    getAiProvider: () => null,
    env: { WHATSAPP_VERIFY_TOKEN: "verify-me" },
    ...overrides,
  };
}

describe("api app (no DB configured)", () => {
  test("GET /health", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "api" });
  });

  test("POST /broadcasts/estimate works WITHOUT a database (pure route)", async () => {
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

  test("GET /conversations without DATABASE_URL -> 503 CONFIGURATION (not a crash)", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/conversations", { headers: { "x-workspace-id": "ws-1" } });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFIGURATION");
  });

  test("GET /conversations without workspace header -> 400 VALIDATION", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/conversations");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
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

describe("api app - Fase 2 routes (no DB configured)", () => {
  test("POST /conversations/:id/ai-suggest without an AI provider -> 503 CONFIGURATION (never faked)", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/conversations/conv-1/ai-suggest", {
      method: "POST",
      headers: { "x-workspace-id": "ws-1", "content-type": "application/json" },
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

  test("POST /moderation/check flags list terms without a database", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/moderation/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
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
    // The WABA (messaging account) id rides along for persistence.
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
    const res = await app.request("/channels/whatsapp/embedded-signup/exchange", {
      method: "POST",
      headers: { "x-workspace-id": "ws-1", "content-type": "application/json" },
      body: JSON.stringify({ code: "the-code", sessionInfo: { isCoexistence: true } }),
    });
    expect(res.status).toBe(201);
    expect(seen).toEqual([{ workspaceId: "ws-1", code: "the-code" }]);
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

  test("GET /channels/accounts without DB -> 503 CONFIGURATION", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/channels/accounts", { headers: { "x-workspace-id": "ws-1" } });
    expect(res.status).toBe(503);
  });

  test("GET /posts without DB -> 503 CONFIGURATION", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/posts", { headers: { "x-workspace-id": "ws-1" } });
    expect(res.status).toBe(503);
  });
});
