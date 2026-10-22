import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { registerUser, testDeps, type Registered } from "./test-helpers";

/**
 * Adopted-features API surface: personal API tokens (create/hash/revoke +
 * Bearer bta_ authentication), and the auth/validation guards of the new
 * routes (growth redirect 404, import cap, export auth).
 */

const app = createApp(testDeps());
let owner: Registered;
let rawToken = "";
let tokenId = "";

beforeAll(async () => {
  owner = await registerUser(app, "tokens@example.com");
});

describe("API tokens", () => {
  test("create returns the raw bta_ token ONCE; list shows metadata only", async () => {
    const res = await app.request("/auth/tokens", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "MCP laptop" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; tokenInfo: { id: string; prefix: string } };
    expect(body.token.startsWith("bta_")).toBe(true);
    expect(body.tokenInfo.prefix).toBe(body.token.slice(0, 12));
    rawToken = body.token;
    tokenId = body.tokenInfo.id;

    const list = await app.request("/auth/tokens", { headers: owner.headers });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { tokens: Array<{ id: string; name: string; prefix: string }> };
    expect(listBody.tokens).toHaveLength(1);
    expect(listBody.tokens[0]).toMatchObject({ id: tokenId, name: "MCP laptop" });
    // The raw token (and any hash) must never appear in the list payload.
    expect(JSON.stringify(listBody)).not.toContain(rawToken);
  });

  test("the raw token authenticates as its user (me + workspace-scoped route)", async () => {
    const me = await app.request("/auth/me", { headers: { authorization: `Bearer ${rawToken}` } });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { user: { email: string }; workspaces: unknown[] };
    expect(meBody.user.email).toBe("tokens@example.com");
    expect(meBody.workspaces).toHaveLength(1);

    // Workspace-scoped route with token + X-Workspace-Id (DB-less deps ->
    // the request must pass auth and reach the DB guard = 503, not 401).
    const scoped = await app.request("/growth-links", {
      headers: { authorization: `Bearer ${rawToken}`, "x-workspace-id": owner.workspaceId },
    });
    expect(scoped.status).toBe(503);
  });

  test("an unknown bta_ token is rejected with 401", async () => {
    const res = await app.request("/auth/me", {
      headers: { authorization: "Bearer bta_doesnotexistdoesnotexist" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("revoke kills the token; revoking twice is a 404", async () => {
    const del = await app.request(`/auth/tokens/${tokenId}`, { method: "DELETE", headers: owner.headers });
    expect(del.status).toBe(200);
    const after = await app.request("/auth/me", { headers: { authorization: `Bearer ${rawToken}` } });
    expect(after.status).toBe(401);
    const again = await app.request(`/auth/tokens/${tokenId}`, { method: "DELETE", headers: owner.headers });
    expect(again.status).toBe(404);
  });

  test("token routes require authentication", async () => {
    const res = await app.request("/auth/tokens");
    expect(res.status).toBe(401);
    const create = await app.request("/auth/tokens", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }),
    });
    expect(create.status).toBe(401);
  });
});

describe("adopted route guards", () => {
  test("GET /r/:slug for an unknown slug is a typed 404 (not a crash, not a 503)", async () => {
    const res = await app.request("/r/nonexistent");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("contacts export without auth is a 401", async () => {
    const res = await app.request("/contacts/export?format=csv");
    expect(res.status).toBe(401);
  });

  test("growth-links without auth is a 401; with auth but no DB is a 503", async () => {
    expect((await app.request("/growth-links")).status).toBe(401);
    expect((await app.request("/growth-links", { headers: owner.headers })).status).toBe(503);
  });

  test("import beyond the 5000-row cap is a typed 400 before any DB access", async () => {
    const lines = ["phone", ...Array.from({ length: 5001 }, (_, i) => `62812${i}`)];
    const res = await app.request("/contacts/import", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ format: "csv", content: lines.join("\n"), conflict: "skip" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });
});
