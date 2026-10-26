import { beforeAll, describe, expect, test } from "bun:test";
import {
  getWebhookEndpointById, registerWebhookEndpointFailure, unsealSettingValue,
} from "@botara/db";
import { verifyWebhookSignature, webhookSignatureHeader } from "@botara/shared/webhook-signing";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { TEST_VAULT_KEY, registerUser, testDeps, type Registered } from "./test-helpers";

/**
 * Outbound webhooks (adoption package #10) - HTTP contract:
 * CRUD + role guards (owner/admin only), one-time secret semantics,
 * write-time SSRF validation, rotation, auto-disable accounting with
 * manual re-enable, the test ping, cross-workspace isolation, scoped
 * token enforcement, and the invariant that internal notes never emit.
 */

let fake: FakeDatabase;
const enqueued: string[] = [];
const deps = testDeps({
  getDatabase: () => fake.db,
  rateLimits: { authPerMinute: 10000, publicPerMinute: 10000 },
  webhookEnqueuer: { async enqueueWebhookDelivery(id: string) { enqueued.push(id); } },
});
// Webhook secrets seal with the same vault key the platform settings
// service uses in tests, so assertions can unseal what the API stored.
deps.env.TOKEN_VAULT_KEY = TEST_VAULT_KEY.toString("base64");
const app = createApp(deps);

let owner: Registered;
let other: Registered;
let member: Registered;

const jsonHeaders = (r: Registered) => ({ ...r.headers, "content-type": "application/json" });
const memberInOwnerWs = () => ({
  authorization: `Bearer ${member.token}`, "x-workspace-id": owner.workspaceId,
  "content-type": "application/json",
});

const PUBLIC_URL = "https://93.184.216.34/hook"; // IP literal: no DNS in tests

async function createEndpoint(auth: Registered, over: Record<string, unknown> = {}): Promise<Response> {
  return app.request("/settings/webhooks", {
    method: "POST",
    headers: jsonHeaders(auth),
    body: JSON.stringify({ name: "CRM sync", url: PUBLIC_URL, events: ["message.received"], ...over }),
  });
}

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(app, "pkg10-owner@example.com");
  other = await registerUser(app, "pkg10-other@example.com");
  member = await registerUser(app, "pkg10-member@example.com");
  const add = await app.request(`/workspaces/${owner.workspaceId}/members`, {
    method: "POST",
    headers: jsonHeaders(owner),
    body: JSON.stringify({ email: "pkg10-member@example.com", role: "member" }),
  });
  expect(add.status).toBe(201);
});

describe("webhook endpoint CRUD + secret hygiene", () => {
  test("create returns the raw secret ONCE; the stored row is sealed; list shows no secret material", async () => {
    const res = await createEndpoint(owner);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; secret: string; secretSealed?: string; events: string[] };
    expect(body.secret.startsWith("whsec_")).toBe(true);
    expect(body.events).toEqual(["message.received"]);
    expect(body.secretSealed).toBeUndefined();

    const row = fake.rows.webhookEndpoints.find((r) => r.id === body.id)!;
    expect(row.secretSealed).not.toContain(body.secret);
    expect(unsealSettingValue(TEST_VAULT_KEY, row.secretSealed as string)).toBe(body.secret);

    const list = await app.request("/settings/webhooks", { headers: owner.headers });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { webhooks: Array<Record<string, unknown>> };
    const mine = listBody.webhooks.find((w) => w.id === body.id)!;
    expect(mine).toBeDefined();
    expect("secret" in mine).toBe(false);
    expect("secretSealed" in mine).toBe(false);
    expect(JSON.stringify(listBody)).not.toContain(body.secret);
  });

  test("create validation: empty/unknown events and blank name are 400s", async () => {
    expect((await createEndpoint(owner, { events: [] })).status).toBe(400);
    expect((await createEndpoint(owner, { events: ["message.deleted"] })).status).toBe(400);
    expect((await createEndpoint(owner, { events: ["webhook.test"] })).status).toBe(400); // test event is not subscribable
    expect((await createEndpoint(owner, { name: "   " })).status).toBe(400);
    // Duplicates collapse instead of erroring.
    const ok = await createEndpoint(owner, { events: ["message.status", "message.status"] });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { events: string[] }).events).toEqual(["message.status"]);
  });

  test("patch updates fields; delete removes the endpoint and its deliveries", async () => {
    const created = (await (await createEndpoint(owner)).json()) as { id: string };
    const patch = await app.request(`/settings/webhooks/${created.id}`, {
      method: "PATCH",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ name: "Renamed", events: ["conversation.created", "message.status"], enabled: false }),
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { name: string; events: string[]; enabled: boolean };
    expect(patched.name).toBe("Renamed");
    expect(patched.events).toEqual(["conversation.created", "message.status"]); // input order, deduped
    expect(patched.enabled).toBe(false);

    const del = await app.request(`/settings/webhooks/${created.id}`, { method: "DELETE", headers: owner.headers });
    expect(del.status).toBe(200);
    const list = (await (await app.request("/settings/webhooks", { headers: owner.headers })).json()) as { webhooks: Array<{ id: string }> };
    expect(list.webhooks.some((w) => w.id === created.id)).toBe(false);
    const again = await app.request(`/settings/webhooks/${created.id}`, { method: "DELETE", headers: owner.headers });
    expect(again.status).toBe(404);
  });
});

describe("write-time SSRF validation", () => {
  const rejected: Array<[string, string]> = [
    ["loopback IP", "https://127.0.0.1/hook"],
    ["private IP", "https://10.0.0.7/hook"],
    ["link-local metadata IP", "https://169.254.169.254/latest/meta-data"],
    ["private hostname (resolves via hosts file)", "https://localhost/hook"],
    ["http for a public host", "http://93.184.216.34/hook"],
    ["embedded credentials", "https://user:pass@93.184.216.34/hook"],
    ["non-http scheme", "ftp://93.184.216.34/hook"],
  ];
  for (const [label, url] of rejected) {
    test(`create rejects ${label} with a typed 400 + reason`, async () => {
      const res = await createEndpoint(owner, { url });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
      expect(body.error.code).toBe("VALIDATION");
      expect(typeof body.error.details?.reason).toBe("string");
    });
  }

  test("http is allowed ONLY for loopback (local development)", async () => {
    const res = await createEndpoint(owner, { url: "http://127.0.0.1:8787/hook" });
    expect(res.status).toBe(201);
  });

  test("patch re-validates the URL", async () => {
    const created = (await (await createEndpoint(owner)).json()) as { id: string };
    const res = await app.request(`/settings/webhooks/${created.id}`, {
      method: "PATCH",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ url: "https://192.168.1.10/hook" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("role guards + cross-workspace isolation", () => {
  test("a plain member gets 403 on read AND write", async () => {
    const list = await app.request("/settings/webhooks", { headers: memberInOwnerWs() });
    expect(list.status).toBe(403);
    const create = await app.request("/settings/webhooks", {
      method: "POST",
      headers: memberInOwnerWs(),
      body: JSON.stringify({ name: "Nope", url: PUBLIC_URL, events: ["message.received"] }),
    });
    expect(create.status).toBe(403);
  });

  test("another workspace's owner cannot see, patch, rotate, or delete the endpoint", async () => {
    const created = (await (await createEndpoint(owner)).json()) as { id: string };
    const list = (await (await app.request("/settings/webhooks", { headers: other.headers })).json()) as { webhooks: Array<{ id: string }> };
    expect(list.webhooks.some((w) => w.id === created.id)).toBe(false);
    for (const [method, path] of [
      ["PATCH", `/settings/webhooks/${created.id}`],
      ["DELETE", `/settings/webhooks/${created.id}`],
      ["POST", `/settings/webhooks/${created.id}/rotate-secret`],
      ["POST", `/settings/webhooks/${created.id}/test`],
      ["GET", `/settings/webhooks/${created.id}/deliveries`],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: jsonHeaders(other),
        body: method === "PATCH" ? JSON.stringify({ name: "Hijack" }) : undefined,
      });
      expect(res.status).toBe(404);
    }
  });

  test("a scoped API token needs settings:read to list and settings:write to create", async () => {
    const mint = async (scopes: string[]) => {
      const res = await app.request("/auth/tokens", {
        method: "POST",
        headers: jsonHeaders(owner),
        body: JSON.stringify({ name: "scoped", workspaceId: owner.workspaceId, scopes }),
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { token: string }).token;
    };
    const readToken = await mint(["settings:read"]);
    const readHeaders = { authorization: `Bearer ${readToken}`, "x-workspace-id": owner.workspaceId };
    expect((await app.request("/settings/webhooks", { headers: readHeaders })).status).toBe(200);
    const writeDenied = await app.request("/settings/webhooks", {
      method: "POST",
      headers: { ...readHeaders, "content-type": "application/json" },
      body: JSON.stringify({ name: "Nope", url: PUBLIC_URL, events: ["message.received"] }),
    });
    expect(writeDenied.status).toBe(403);
    const noSettings = await mint(["contacts:read"]);
    const denied = await app.request("/settings/webhooks", {
      headers: { authorization: `Bearer ${noSettings}`, "x-workspace-id": owner.workspaceId },
    });
    expect(denied.status).toBe(403);
  });
});

describe("rotation, test ping, deliveries", () => {
  test("rotate-secret: the new secret unseals + signs; the old one is dead", async () => {
    const created = (await (await createEndpoint(owner)).json()) as { id: string; secret: string };
    const rotated = await app.request(`/settings/webhooks/${created.id}/rotate-secret`, {
      method: "POST", headers: jsonHeaders(owner), body: "{}",
    });
    expect(rotated.status).toBe(200);
    const body = (await rotated.json()) as { secret: string };
    expect(body.secret.startsWith("whsec_")).toBe(true);
    expect(body.secret).not.toBe(created.secret);
    const row = await getWebhookEndpointById(fake.db, created.id);
    expect(unsealSettingValue(TEST_VAULT_KEY, row!.secretSealed)).toBe(body.secret);
    // Signature proof: old secret no longer verifies, new one does.
    const payload = JSON.stringify({ id: "d-1", type: "message.received" });
    const t = 1_793_000_000;
    expect(verifyWebhookSignature(body.secret, webhookSignatureHeader(body.secret, t, payload), payload)).toBe(true);
    expect(verifyWebhookSignature(created.secret, webhookSignatureHeader(body.secret, t, payload), payload)).toBe(false);
  });

  test("test ping enqueues a webhook.test delivery through the pipeline", async () => {
    const created = (await (await createEndpoint(owner)).json()) as { id: string };
    enqueued.length = 0;
    const res = await app.request(`/settings/webhooks/${created.id}/test`, {
      method: "POST", headers: jsonHeaders(owner), body: "{}",
    });
    expect(res.status).toBe(201);
    const delivery = (await res.json()) as { id: string; event: string; status: string };
    expect(delivery.event).toBe("webhook.test");
    expect(delivery.status).toBe("pending");
    expect(enqueued).toEqual([delivery.id]);
    const row = fake.rows.webhookDeliveries.find((r) => r.id === delivery.id)!;
    expect((row.payload as { type: string }).type).toBe("webhook.test");

    const list = await app.request(`/settings/webhooks/${created.id}/deliveries`, { headers: owner.headers });
    expect(list.status).toBe(200);
    const deliveries = ((await list.json()) as { deliveries: Array<{ id: string }> }).deliveries;
    expect(deliveries.map((d) => d.id)).toContain(delivery.id);
  });
});

describe("auto-disable + manual re-enable", () => {
  test("10 consecutive failed deliveries auto-disable (audited); PATCH enable resets the streak", async () => {
    const created = (await (await createEndpoint(owner)).json()) as { id: string };
    for (let i = 0; i < 10; i += 1) {
      const row = await getWebhookEndpointById(fake.db, created.id);
      await registerWebhookEndpointFailure(fake.db, row!, { threshold: 10, at: new Date() });
    }
    const after = await getWebhookEndpointById(fake.db, created.id);
    expect(after!.consecutiveFailures).toBe(10);
    expect(after!.enabled).toBe(false);
    expect(after!.disabledBySystem).toBe(true);
    expect(after!.disabledAt).not.toBeNull();
    expect(fake.rows.auditLog.some(
      (r) => r.action === "webhook_endpoint.auto_disabled" && (r.details as { endpointId?: string })?.endpointId === created.id,
    )).toBe(true);

    const list = (await (await app.request("/settings/webhooks", { headers: owner.headers })).json()) as {
      webhooks: Array<{ id: string; autoDisabled: boolean; consecutiveFailures: number }>;
    };
    const view = list.webhooks.find((w) => w.id === created.id)!;
    expect(view.autoDisabled).toBe(true);
    expect(view.consecutiveFailures).toBe(10);

    const patch = await app.request(`/settings/webhooks/${created.id}`, {
      method: "PATCH", headers: jsonHeaders(owner), body: JSON.stringify({ enabled: true }),
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { enabled: boolean; consecutiveFailures: number; autoDisabled: boolean; disabledAt: string | null };
    expect(patched.enabled).toBe(true);
    expect(patched.consecutiveFailures).toBe(0);
    expect(patched.autoDisabled).toBe(false);
    expect(patched.disabledAt).toBeNull();
  });

  test("9 failures do NOT auto-disable", async () => {
    const created = (await (await createEndpoint(owner)).json()) as { id: string };
    for (let i = 0; i < 9; i += 1) {
      const row = await getWebhookEndpointById(fake.db, created.id);
      await registerWebhookEndpointFailure(fake.db, row!, { threshold: 10, at: new Date() });
    }
    const after = await getWebhookEndpointById(fake.db, created.id);
    expect(after!.enabled).toBe(true);
    expect(after!.consecutiveFailures).toBe(9);
  });
});

describe("internal notes never emit webhooks", () => {
  test("posting a note creates no delivery and enqueues nothing", async () => {
    const ws = owner.workspaceId;
    fake.seed("workspaces", { id: ws, name: "Toko Webhook", slug: "toko-webhook" });
    fake.seed("channelAccounts", {
      id: "acc-webchat-10", workspaceId: ws, channel: "webchat",
      externalId: `webchat:${ws}`, displayName: "Webchat", status: "connected",
      tokenVaultRef: null, authMode: null,
    });
    fake.seed("contacts", {
      id: "contact-10", workspaceId: ws, channel: "webchat",
      externalId: "webchat-session:sess-10", displayName: "Sari", tags: [], customFields: {},
    });
    fake.seed("conversations", {
      id: "conv-10", workspaceId: ws, channelAccountId: "acc-webchat-10",
      contactId: "contact-10", status: "open", assignedUserId: null, lastUserMessageAt: new Date(),
    });
    await createEndpoint(owner, { events: ["message.received", "message.status", "conversation.created"] });
    const deliveriesBefore = fake.rows.webhookDeliveries.length;
    enqueued.length = 0;
    const res = await app.request("/conversations/conv-10/notes", {
      method: "POST",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ body: "Catatan internal - jangan bocor ke webhook." }),
    });
    expect(res.status).toBe(201);
    expect(fake.rows.webhookDeliveries.length).toBe(deliveriesBefore);
    expect(enqueued).toEqual([]);
  });
});
