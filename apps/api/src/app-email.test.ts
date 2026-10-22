import { describe, expect, test } from "bun:test";
import { AppError } from "@botara/shared";
import { createApp } from "./app";
import { registerUser, testDeps } from "./test-helpers";

/**
 * Fase 3 email inbound producer: the Resend webhook resolves the owning
 * workspace by recipient domain and enqueues an email-inbound job - tested
 * with a fake router + a fake (recording / failing) queue.
 */

const receivedPayload = (to: string[], emailId = "em_123") => ({
  type: "email.received",
  created_at: "2026-10-22T00:00:00Z",
  data: {
    email_id: emailId,
    from: "customer@gmail.com",
    to,
    subject: "Halo",
    attachments: [],
  },
});

function postWebhook(app: ReturnType<typeof createApp>, payload: unknown) {
  return app.request("/webhooks/resend", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("resend inbound producer (fake queue)", () => {
  test("email.received at a registered domain enqueues one inbound job for the resolved workspace", async () => {
    const enqueued: Array<{ workspaceId: string; channelAccountId: string; emailId: string }> = [];
    const askedDomains: string[] = [];
    const app = createApp(testDeps({
      emailRouter: {
        async resolveRecipientDomain(domain) {
          askedDomains.push(domain);
          return domain === "mail.toko.id"
            ? { workspaceId: "ws-toko", channelAccountId: "acc-email-1" }
            : null;
        },
      },
      emailInboundEnqueuer: {
        async enqueueEmailInbound(input) { enqueued.push(input); },
      },
    }));
    const res = await postWebhook(app, receivedPayload(["support@mail.toko.id"]));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean; enqueued: number };
    expect(body.enqueued).toBe(1);
    expect(askedDomains).toEqual(["mail.toko.id"]);
    expect(enqueued).toEqual([{
      workspaceId: "ws-toko",
      channelAccountId: "acc-email-1",
      emailId: "em_123",
    }]);
  });

  test("multiple recipients on the same account are deduplicated to one job", async () => {
    const enqueued: unknown[] = [];
    const app = createApp(testDeps({
      emailRouter: {
        async resolveRecipientDomain() {
          return { workspaceId: "ws-1", channelAccountId: "acc-1" };
        },
      },
      emailInboundEnqueuer: {
        async enqueueEmailInbound(input) { enqueued.push(input); },
      },
    }));
    const res = await postWebhook(app, receivedPayload(["a@mail.toko.id", "b@mail.toko.id"]));
    expect(res.status).toBe(200);
    expect(enqueued).toHaveLength(1);
  });

  test("an unregistered domain is acknowledged but NOT routed (no fake success)", async () => {
    const enqueued: unknown[] = [];
    const app = createApp(testDeps({
      emailRouter: { async resolveRecipientDomain() { return null; } },
      emailInboundEnqueuer: {
        async enqueueEmailInbound(input) { enqueued.push(input); },
      },
    }));
    const res = await postWebhook(app, receivedPayload(["x@unknown.example"]));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enqueued: number };
    expect(body.enqueued).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  test("when Redis is down the webhook answers 503 (Resend retries) - never a fake success", async () => {
    const app = createApp(testDeps({
      emailRouter: {
        async resolveRecipientDomain() {
          return { workspaceId: "ws-1", channelAccountId: "acc-1" };
        },
      },
      emailInboundEnqueuer: {
        async enqueueEmailInbound() {
          throw new AppError("CONFIGURATION", "email queue (Redis) is unavailable: down", { status: 503 });
        },
      },
    }));
    const res = await postWebhook(app, receivedPayload(["support@mail.toko.id"]));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFIGURATION");
  });

  test("non-inbound Resend events (delivered) never enqueue", async () => {
    const enqueued: unknown[] = [];
    const app = createApp(testDeps({
      emailRouter: {
        async resolveRecipientDomain() {
          throw new Error("router must not be consulted for status events");
        },
      },
      emailInboundEnqueuer: {
        async enqueueEmailInbound(input) { enqueued.push(input); },
      },
    }));
    const res = await postWebhook(app, {
      type: "email.delivered",
      created_at: "2026-10-22T00:00:00Z",
      data: { email_id: "em_9" },
    });
    expect(res.status).toBe(200);
    expect(enqueued).toHaveLength(0);
  });
});

describe("email domain admin endpoints", () => {
  test("registering an invalid domain is a 400 before any DB access", async () => {
    const app = createApp(testDeps());
    const reg = await registerUser(app);
    const res = await app.request("/channels/email/domains", {
      method: "POST",
      headers: { ...reg.headers, "content-type": "application/json" },
      body: JSON.stringify({ domain: "not a domain" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  test("a valid domain reaches the DB layer (503 while unconfigured)", async () => {
    const app = createApp(testDeps());
    const reg = await registerUser(app);
    const res = await app.request("/channels/email/domains", {
      method: "POST",
      headers: { ...reg.headers, "content-type": "application/json" },
      body: JSON.stringify({ domain: "mail.toko.id" }),
    });
    expect(res.status).toBe(503);
  });

  test("listing domains requires auth", async () => {
    const app = createApp(testDeps());
    const res = await app.request("/channels/email/domains");
    expect(res.status).toBe(401);
  });
});
