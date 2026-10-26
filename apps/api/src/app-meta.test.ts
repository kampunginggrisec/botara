import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createApp, parseMetaSignedRequest, type DataDeletionStore } from "./app";
import { testDeps } from "./test-helpers";

/**
 * Fase 3: Meta data-deletion callback - a hard App Review requirement.
 * Requests arrive as a signed_request verified against META_APP_SECRET.
 */

const APP_SECRET = "meta-app-secret";

function signedRequest(payload: Record<string, unknown>, secret = APP_SECRET): string {
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadPart).digest("base64url");
  return `${signature}.${payloadPart}`;
}

function fakeStore() {
  const records = new Map<string, { confirmationCode: string; providerUserId: string; status: string; createdAt: string }>();
  const purged: string[] = [];
  const store: DataDeletionStore = {
    async create(input) {
      records.set(input.confirmationCode, {
        ...input, status: "received", createdAt: new Date().toISOString(),
      });
    },
    async getByCode(code) {
      const r = records.get(code);
      return r ? { confirmationCode: r.confirmationCode, status: r.status, createdAt: r.createdAt } : null;
    },
    async complete(code) {
      const r = records.get(code);
      if (r) r.status = "completed";
    },
    async purge(providerUserId) {
      purged.push(providerUserId);
      return { contacts: 1 };
    },
  };
  return { store, records, purged };
}

function deletionApp(extraEnv: Record<string, string> = {}) {
  const fake = fakeStore();
  const app = createApp(testDeps({
    env: {
      SESSION_SECRET: "test-session-secret",
      META_APP_SECRET: APP_SECRET,
      APP_PUBLIC_URL: "https://botara.example.com",
      ...extraEnv,
    },
    dataDeletionStore: fake.store,
  }));
  return { app, fake };
}

describe("Meta data-deletion callback", () => {
  test("a valid signed_request records the request, purges, and returns url + confirmation_code", async () => {
    const { app, fake } = deletionApp();
    const res = await app.request("/webhooks/meta/data-deletion", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        signed_request: signedRequest({ user_id: "fb-user-42", algorithm: "HMAC-SHA256", issued_at: 1760000000 }),
      }).toString(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; confirmation_code: string };
    expect(body.confirmation_code).toBeTruthy();
    expect(body.url).toBe(`https://botara.example.com/data-deletion/status/${body.confirmation_code}`);
    expect(fake.purged).toEqual(["fb-user-42"]);
    expect(fake.records.get(body.confirmation_code)?.status).toBe("completed");

    // The public status page reports the completed request.
    const status = await app.request(`/data-deletion/status/${body.confirmation_code}`);
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as { status: string; confirmation_code: string };
    expect(statusBody.status).toBe("completed");
    expect(statusBody.confirmation_code).toBe(body.confirmation_code);
  });

  test("the returned status url uses PUBLIC_WEBHOOK_BASE_URL (the /api mount) when set", async () => {
    const { app } = deletionApp({ PUBLIC_WEBHOOK_BASE_URL: "https://botara.example.com/api" });
    const res = await app.request("/webhooks/meta/data-deletion", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        signed_request: signedRequest({ user_id: "fb-user-43", algorithm: "HMAC-SHA256", issued_at: 1760000000 }),
      }).toString(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; confirmation_code: string };
    expect(body.url).toBe(`https://botara.example.com/api/data-deletion/status/${body.confirmation_code}`);
  });

  test("JSON posts are accepted too", async () => {
    const { app } = deletionApp();
    const res = await app.request("/webhooks/meta/data-deletion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        signed_request: signedRequest({ user_id: "ig-user-7", algorithm: "HMAC-SHA256" }),
      }),
    });
    expect(res.status).toBe(200);
  });

  test("a tampered signature is rejected and nothing is recorded", async () => {
    const { app, fake } = deletionApp();
    const forged = signedRequest({ user_id: "fb-user-42", algorithm: "HMAC-SHA256" }, "wrong-secret");
    const res = await app.request("/webhooks/meta/data-deletion", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ signed_request: forged }).toString(),
    });
    expect(res.status).toBe(401);
    expect(fake.records.size).toBe(0);
    expect(fake.purged).toHaveLength(0);
  });

  test("without META_APP_SECRET the callback fails closed (503)", async () => {
    const app = createApp(testDeps({
      env: { SESSION_SECRET: "test-session-secret" },
    }));
    const res = await app.request("/webhooks/meta/data-deletion", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ signed_request: "x.y" }).toString(),
    });
    expect(res.status).toBe(503);
  });

  test("unknown confirmation codes 404 on the status page", async () => {
    const { app } = deletionApp();
    const res = await app.request("/data-deletion/status/nope-not-real");
    expect(res.status).toBe(404);
  });

  test("parseMetaSignedRequest round-trips and rejects garbage", () => {
    const sr = signedRequest({ user_id: "u-1", algorithm: "HMAC-SHA256" });
    expect(parseMetaSignedRequest(sr, APP_SECRET)?.user_id).toBe("u-1");
    expect(parseMetaSignedRequest("not-a-signed-request", APP_SECRET)).toBeNull();
    expect(parseMetaSignedRequest(sr, "other-secret")).toBeNull();
  });
});
