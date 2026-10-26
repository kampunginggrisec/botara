import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createApp, dataDeletionAppSecrets, parseMetaSignedRequest, type DataDeletionStore } from "./app";
import { testDeps } from "./test-helpers";

/**
 * Fase 3: Meta data-deletion callback - a hard App Review requirement.
 * Requests arrive as a signed_request; the same URL is registered in the
 * Meta, Instagram Login and Threads app consoles, so verification accepts
 * a signature from any of the three app secrets.
 */

const APP_SECRET = "meta-app-secret";
const INSTAGRAM_SECRET = "instagram-app-secret";
const THREADS_SECRET = "threads-app-secret";

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

/** App whose env is EXACTLY the given app-secret keys (no implicit META). */
function deletionAppWithEnv(env: Record<string, string>) {
  const fake = fakeStore();
  const app = createApp(testDeps({
    env: {
      SESSION_SECRET: "test-session-secret",
      APP_PUBLIC_URL: "https://botara.example.com",
      ...env,
    },
    dataDeletionStore: fake.store,
  }));
  return { app, fake };
}

async function postDeletion(app: ReturnType<typeof createApp>, signedReq: string) {
  return app.request("/webhooks/meta/data-deletion", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ signed_request: signedReq }).toString(),
  });
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

  test("a request signed with the Instagram app secret verifies", async () => {
    const { app, fake } = deletionApp({ INSTAGRAM_APP_SECRET: INSTAGRAM_SECRET });
    const res = await postDeletion(app, signedRequest(
      { user_id: "ig-user-99", algorithm: "HMAC-SHA256", issued_at: 1760000000 },
      INSTAGRAM_SECRET,
    ));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; confirmation_code: string };
    expect(body.confirmation_code).toBeTruthy();
    expect(body.url).toBe(`https://botara.example.com/data-deletion/status/${body.confirmation_code}`);
    expect(fake.purged).toEqual(["ig-user-99"]);
    expect(fake.records.get(body.confirmation_code)?.status).toBe("completed");
  });

  test("a request signed with the Threads app secret verifies", async () => {
    const { app, fake } = deletionApp({ THREADS_APP_SECRET: THREADS_SECRET });
    const res = await postDeletion(app, signedRequest(
      { user_id: "threads-user-5", algorithm: "HMAC-SHA256", issued_at: 1760000000 },
      THREADS_SECRET,
    ));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; confirmation_code: string };
    expect(body.confirmation_code).toBeTruthy();
    expect(body.url).toBe(`https://botara.example.com/data-deletion/status/${body.confirmation_code}`);
    expect(fake.purged).toEqual(["threads-user-5"]);
    expect(fake.records.get(body.confirmation_code)?.status).toBe("completed");
  });

  test("an Instagram-only deployment (no META_APP_SECRET) still verifies its app's requests", async () => {
    const { app, fake } = deletionAppWithEnv({ INSTAGRAM_APP_SECRET: INSTAGRAM_SECRET });
    const res = await postDeletion(app, signedRequest(
      { user_id: "ig-user-100", algorithm: "HMAC-SHA256" },
      INSTAGRAM_SECRET,
    ));
    expect(res.status).toBe(200);
    expect(fake.purged).toEqual(["ig-user-100"]);
  });

  test("a Threads-only deployment (no META_APP_SECRET) still verifies its app's requests", async () => {
    const { app, fake } = deletionAppWithEnv({ THREADS_APP_SECRET: THREADS_SECRET });
    const res = await postDeletion(app, signedRequest(
      { user_id: "threads-user-6", algorithm: "HMAC-SHA256" },
      THREADS_SECRET,
    ));
    expect(res.status).toBe(200);
    expect(fake.purged).toEqual(["threads-user-6"]);
  });

  test("a signature from an unknown secret fails even with all three app secrets configured", async () => {
    const { app, fake } = deletionApp({
      INSTAGRAM_APP_SECRET: INSTAGRAM_SECRET,
      THREADS_APP_SECRET: THREADS_SECRET,
    });
    const forged = signedRequest({ user_id: "fb-user-42", algorithm: "HMAC-SHA256" }, "unknown-secret");
    const res = await postDeletion(app, forged);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    // Same generic error as the single-secret failure - no hint which
    // secrets were tried.
    expect(body.error.message).toBe("Invalid signed_request signature.");
    expect(fake.records.size).toBe(0);
    expect(fake.purged).toHaveLength(0);
  });

  test("without any app secret the callback fails closed (503)", async () => {
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

describe("dataDeletionAppSecrets", () => {
  test("no secrets configured -> empty list (endpoint fails closed)", () => {
    expect(dataDeletionAppSecrets({})).toEqual([]);
    expect(dataDeletionAppSecrets({ SESSION_SECRET: "unrelated" })).toEqual([]);
  });

  test("only META_APP_SECRET -> just it (fallbacks resolve to it and dedupe)", () => {
    expect(dataDeletionAppSecrets({ META_APP_SECRET: APP_SECRET })).toEqual([APP_SECRET]);
  });

  test("three distinct secrets -> all three, Meta first", () => {
    expect(dataDeletionAppSecrets({
      META_APP_SECRET: APP_SECRET,
      INSTAGRAM_APP_SECRET: INSTAGRAM_SECRET,
      THREADS_APP_SECRET: THREADS_SECRET,
    })).toEqual([APP_SECRET, INSTAGRAM_SECRET, THREADS_SECRET]);
  });

  test("a per-app secret equal to the Meta secret dedupes", () => {
    expect(dataDeletionAppSecrets({
      META_APP_SECRET: APP_SECRET,
      INSTAGRAM_APP_SECRET: APP_SECRET,
      THREADS_APP_SECRET: THREADS_SECRET,
    })).toEqual([APP_SECRET, THREADS_SECRET]);
  });

  test("a single per-app secret works without META_APP_SECRET", () => {
    expect(dataDeletionAppSecrets({ INSTAGRAM_APP_SECRET: INSTAGRAM_SECRET })).toEqual([INSTAGRAM_SECRET]);
    expect(dataDeletionAppSecrets({ THREADS_APP_SECRET: THREADS_SECRET })).toEqual([THREADS_SECRET]);
  });

  test("empty-string values are filtered out (treated as unset)", () => {
    expect(dataDeletionAppSecrets({ META_APP_SECRET: "" })).toEqual([]);
    expect(dataDeletionAppSecrets({
      META_APP_SECRET: "",
      INSTAGRAM_APP_SECRET: INSTAGRAM_SECRET,
    })).toEqual([INSTAGRAM_SECRET]);
  });
});
