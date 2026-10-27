import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createApp } from "./app";
import { InMemoryAdminStore, type AdminWebhookLogItem } from "./admin";
import { InMemoryAuthStore } from "./auth";
import { testDeps, registerUser } from "./test-helpers";
import {
  InMemoryWebhookReceiptRecorder,
  type WebhookReceiptRecorder,
} from "./webhook-receipts";

/**
 * Admin → Webhook log: the admin route (guard + filters) and the
 * best-effort recording hook on the provider webhook routes.
 *
 * The recording contract under test:
 * - a verified webhook still answers 200 AND leaves a receipt;
 * - a forged signature answers 401 and the receipt carries NO payload
 *   summary (unverified bodies are never stored);
 * - a storage failure changes NOTHING about the webhook response.
 */

const APP_SECRET = "test-meta-app-secret";
const sign = (raw: string, secret = APP_SECRET) =>
  "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");

const TEMPLATE_CATEGORY_PAYLOAD = {
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

const auth = (bearer: string) => ({ authorization: `Bearer ${bearer}` });

function receiptItem(overrides: Partial<AdminWebhookLogItem>): AdminWebhookLogItem {
  return {
    id: "r-1",
    createdAt: "2026-10-27T15:00:00.000Z",
    channel: "whatsapp",
    eventType: "message.received",
    outcome: "processed",
    httpStatus: 200,
    workspaceId: null,
    channelAccountId: null,
    payloadSummary: "{}",
    error: null,
    ...overrides,
  };
}

describe("GET /admin/webhook-log", () => {
  function setup() {
    const adminStore = new InMemoryAdminStore();
    adminStore.webhookReceipts = [
      receiptItem({ id: "r-3", channel: "whatsapp", outcome: "processed", eventType: "message.received" }),
      receiptItem({ id: "r-2", channel: "telegram", outcome: "error", eventType: null, httpStatus: 401, payloadSummary: null, error: "Invalid Telegram webhook secret token." }),
      receiptItem({ id: "r-1", channel: "whatsapp", outcome: "error", eventType: null, httpStatus: 401, payloadSummary: null, error: "Invalid X-Hub-Signature-256." }),
    ];
    const deps = testDeps({ authStore: new InMemoryAuthStore(), adminStore });
    return { app: createApp(deps), adminStore };
  }

  test("unauthenticated -> 401, non-admin -> 403, admin -> 200 newest-first", async () => {
    const { app } = setup();
    const admin = await registerUser(app, "admin@example.com");
    const plain = await registerUser(app, "plain@example.com");

    expect((await app.request("/admin/webhook-log")).status).toBe(401);
    expect((await app.request("/admin/webhook-log", { headers: auth(plain.token) })).status).toBe(403);

    const ok = await app.request("/admin/webhook-log", { headers: auth(admin.token) });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { receipts: AdminWebhookLogItem[] };
    expect(body.receipts.map((r) => r.id)).toEqual(["r-3", "r-2", "r-1"]);
    expect(body.receipts[0]?.payloadSummary).toBe("{}");
  });

  test("channel and outcome filters apply; limit clamps the page", async () => {
    const { app } = setup();
    const admin = await registerUser(app, "admin@example.com");

    const byChannel = await app.request("/admin/webhook-log?channel=whatsapp", { headers: auth(admin.token) });
    expect(((await byChannel.json()) as { receipts: AdminWebhookLogItem[] }).receipts.map((r) => r.id))
      .toEqual(["r-3", "r-1"]);

    const byOutcome = await app.request("/admin/webhook-log?outcome=error", { headers: auth(admin.token) });
    expect(((await byOutcome.json()) as { receipts: AdminWebhookLogItem[] }).receipts.map((r) => r.id))
      .toEqual(["r-2", "r-1"]);

    const both = await app.request("/admin/webhook-log?channel=whatsapp&outcome=error", { headers: auth(admin.token) });
    expect(((await both.json()) as { receipts: AdminWebhookLogItem[] }).receipts.map((r) => r.id))
      .toEqual(["r-1"]);

    const limited = await app.request("/admin/webhook-log?limit=2", { headers: auth(admin.token) });
    expect(((await limited.json()) as { receipts: AdminWebhookLogItem[] }).receipts).toHaveLength(2);
  });
});

describe("webhook receipt recording", () => {
  const signedEnv = { SESSION_SECRET: "test-session-secret", META_APP_SECRET: APP_SECRET };

  test("a signed WhatsApp webhook answers 200 and records a processed receipt", async () => {
    const recorder = new InMemoryWebhookReceiptRecorder();
    const app = createApp(testDeps({ env: signedEnv, webhookReceiptStore: recorder }));
    const raw = JSON.stringify(TEMPLATE_CATEGORY_PAYLOAD);
    const res = await app.request("/webhooks/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) },
      body: raw,
    });
    expect(res.status).toBe(200);
    expect(recorder.receipts).toHaveLength(1);
    const receipt = recorder.receipts[0]!;
    expect(receipt.channel).toBe("whatsapp");
    expect(receipt.outcome).toBe("processed");
    expect(receipt.eventType).toBe("template.category_changed");
    expect(receipt.httpStatus).toBe(200);
    expect(receipt.payloadSummary).toBe(raw);
    expect(receipt.error).toBeNull();
  });

  test("a forged signature answers 401 and the receipt stores NO payload summary", async () => {
    const recorder = new InMemoryWebhookReceiptRecorder();
    const app = createApp(testDeps({ env: signedEnv, webhookReceiptStore: recorder }));
    const raw = JSON.stringify(TEMPLATE_CATEGORY_PAYLOAD);
    const res = await app.request("/webhooks/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw, "the-wrong-secret") },
      body: raw,
    });
    expect(res.status).toBe(401);
    expect(recorder.receipts).toHaveLength(1);
    const receipt = recorder.receipts[0]!;
    expect(receipt.outcome).toBe("error");
    expect(receipt.httpStatus).toBe(401);
    expect(receipt.payloadSummary).toBeNull();
    expect(receipt.error).toContain("Signature");
  });

  test("a verified payload with nothing actionable records outcome=ignored", async () => {
    const recorder = new InMemoryWebhookReceiptRecorder();
    const app = createApp(testDeps({ webhookReceiptStore: recorder }));
    const res = await app.request("/webhooks/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ object: "whatsapp_business_account", entry: [] }),
    });
    expect(res.status).toBe(200);
    expect(recorder.receipts).toHaveLength(1);
    expect(recorder.receipts[0]?.outcome).toBe("ignored");
    expect(recorder.receipts[0]?.eventType).toBeNull();
  });

  test("a Telegram secret mismatch records an error receipt without a summary", async () => {
    const recorder = new InMemoryWebhookReceiptRecorder();
    const app = createApp(testDeps({
      env: { TELEGRAM_WEBHOOK_SECRET: "expected-secret" },
      webhookReceiptStore: recorder,
    }));
    const res = await app.request("/webhooks/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(res.status).toBe(401);
    expect(recorder.receipts).toHaveLength(1);
    expect(recorder.receipts[0]?.channel).toBe("telegram");
    expect(recorder.receipts[0]?.outcome).toBe("error");
    expect(recorder.receipts[0]?.payloadSummary).toBeNull();
  });

  test("a storage failure NEVER changes the webhook response (still 200, no receipt)", async () => {
    const failing: WebhookReceiptRecorder = {
      async record() { throw new Error("database is down"); },
    };
    const app = createApp(testDeps({ webhookReceiptStore: failing }));
    const res = await app.request("/webhooks/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(TEMPLATE_CATEGORY_PAYLOAD),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean; events: number };
    expect(body.received).toBe(true);
    expect(body.events).toBe(1);
  });
});
