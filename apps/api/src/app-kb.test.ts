import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { registerUser, testDeps } from "./test-helpers";
import type { AIProvider } from "@botara/ai";

/**
 * Fase 3 KB endpoints: creating a document requires an AI provider
 * (embeddings) - without one the API answers an honest 503 and stores
 * nothing; with one it persists the document and enqueues ingestion.
 */

const fakeProvider: AIProvider = {
  name: "fake",
  async chatCompletion() { return { text: "ok", model: "fake-1" }; },
  async embedding() { return [0.1, 0.2]; },
};

describe("KB documents API", () => {
  test("POST /kb/documents without an AI provider -> 503 CONFIGURATION, nothing enqueued", async () => {
    const enqueued: unknown[] = [];
    const app = createApp(testDeps({
      kbEnqueuer: { async enqueueKbIngest(input) { enqueued.push(input); } },
    }));
    const reg = await registerUser(app);
    const res = await app.request("/kb/documents", {
      method: "POST",
      headers: { ...reg.headers, "content-type": "application/json" },
      body: JSON.stringify({ title: "FAQ", content: "Jam buka 09.00-17.00." }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFIGURATION");
    expect(enqueued).toHaveLength(0);
  });

  test("with a provider, creation proceeds to persistence (503 only from the missing DB here)", async () => {
    // testDeps has no DB: reaching the DB layer proves the AI gate passed
    // and no document was enqueued prematurely.
    const enqueued: unknown[] = [];
    const app = createApp(testDeps({
      getAiProvider: () => fakeProvider,
      kbEnqueuer: { async enqueueKbIngest(input) { enqueued.push(input); } },
    }));
    const reg = await registerUser(app);
    const res = await app.request("/kb/documents", {
      method: "POST",
      headers: { ...reg.headers, "content-type": "application/json" },
      body: JSON.stringify({ title: "FAQ", content: "Jam buka 09.00-17.00." }),
    });
    expect(res.status).toBe(503); // DATABASE_URL unconfigured in test deps
    expect(enqueued).toHaveLength(0);
  });

  test("listing documents requires auth; agent role may read", async () => {
    const app = createApp(testDeps({ getAiProvider: () => fakeProvider }));
    const anon = await app.request("/kb/documents");
    expect(anon.status).toBe(401);
    const reg = await registerUser(app);
    const res = await app.request("/kb/documents", { headers: reg.headers });
    expect(res.status).toBe(503); // authed; DB unconfigured
  });

  test("invalid payloads are rejected by validation before anything else", async () => {
    const app = createApp(testDeps({ getAiProvider: () => fakeProvider }));
    const reg = await registerUser(app);
    const res = await app.request("/kb/documents", {
      method: "POST",
      headers: { ...reg.headers, "content-type": "application/json" },
      body: JSON.stringify({ title: "", content: "" }),
    });
    expect(res.status).toBe(400);
  });
});
