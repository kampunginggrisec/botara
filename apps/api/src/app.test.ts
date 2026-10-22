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
