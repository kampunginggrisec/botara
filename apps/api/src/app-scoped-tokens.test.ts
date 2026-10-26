import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { registerUser, testDeps, type Registered } from "./test-helpers";
import { InMemoryAuthStore } from "./auth";

/**
 * Scoped API tokens (adoption #5) - HTTP-level behavior.
 *
 * Signal convention of this harness (DB-less deps): a request that
 * PASSES auth + scope enforcement reaches the handler and dies on the
 * DB guard with 503 CONFIGURATION. So "allowed" below means 503 (or a
 * real 200 on auth-store-only routes like /auth/me), while enforcement
 * failures are the typed 401/403s under test.
 */

// Generous auth rate limit: this file exercises /auth/* (register,
// tokens, me) far beyond the production 20/min budget.
const deps = testDeps({ rateLimits: { authPerMinute: 10000 } });
const app = createApp(deps);
const store = deps.authStore as InMemoryAuthStore;

let owner: Registered;
let otherWorkspaceId = "";

async function createToken(
  auth: Registered,
  body: Record<string, unknown>,
): Promise<{ raw: string; info: { id: string; workspaceId: string | null; scopes: string[] | null; expiresAt: string | null } }> {
  const res = await app.request("/auth/tokens", {
    method: "POST",
    headers: { ...auth.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  const parsed = (await res.json()) as { token: string; tokenInfo: never };
  return { raw: parsed.token, info: parsed.tokenInfo };
}

const bearer = (raw: string, workspaceId?: string): Record<string, string> => ({
  authorization: `Bearer ${raw}`,
  ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
});

beforeAll(async () => {
  owner = await registerUser(app, "scoped@example.com");
  // A second workspace the same user owns - for binding-mismatch tests.
  const res = await app.request("/workspaces", {
    method: "POST",
    headers: { ...owner.headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "Second Shop" }),
  });
  expect(res.status).toBe(201);
  otherWorkspaceId = ((await res.json()) as { workspace: { id: string } }).workspace.id;
});

describe("scoped token creation", () => {
  test("create with workspace + scopes + expiry echoes them in tokenInfo and list", async () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const { info } = await createToken(owner, {
      name: "Scoped reader",
      workspaceId: owner.workspaceId,
      scopes: ["contacts:read"],
      expiresAt,
    });
    expect(info.workspaceId).toBe(owner.workspaceId);
    expect(info.scopes).toEqual(["contacts:read"]);
    expect(info.expiresAt).toBe(expiresAt);

    const list = await app.request("/auth/tokens", { headers: owner.headers });
    const tokens = ((await list.json()) as { tokens: Array<{ id: string; workspaceId: string | null; scopes: string[] | null }> }).tokens;
    const found = tokens.find((t) => t.id === info.id);
    expect(found?.workspaceId).toBe(owner.workspaceId);
    expect(found?.scopes).toEqual(["contacts:read"]);
  });

  test("invalid scope strings are a 400; a past expiry is a 400", async () => {
    const badScope = await app.request("/auth/tokens", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Bad", scopes: ["contacts:delete"] }),
    });
    expect(badScope.status).toBe(400);
    expect(((await badScope.json()) as { error: { code: string } }).error.code).toBe("VALIDATION");

    const past = await app.request("/auth/tokens", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Past", expiresAt: new Date(Date.now() - 1000).toISOString() }),
    });
    expect(past.status).toBe(400);
  });

  test("binding to a workspace the user does not belong to is a 403", async () => {
    const res = await app.request("/auth/tokens", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Foreign", workspaceId: crypto.randomUUID(), scopes: ["*"] }),
    });
    expect(res.status).toBe(403);
  });
});

describe("scope enforcement (negative controls)", () => {
  test("in-scope read passes; out-of-scope read is 403 with the required scope", async () => {
    const { raw } = await createToken(owner, {
      name: "Contacts reader",
      workspaceId: owner.workspaceId,
      scopes: ["contacts:read"],
    });
    const ok = await app.request("/contacts", { headers: bearer(raw) });
    expect(ok.status).toBe(503); // passed auth+scope, died on the DB guard

    const denied = await app.request("/conversations", { headers: bearer(raw) });
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as { error: { code: string; details: { requiredScope: string } } };
    expect(deniedBody.error.code).toBe("FORBIDDEN");
    expect(deniedBody.error.details.requiredScope).toBe("conversations:read");
  });

  test("read does not imply write (both directions across two resources)", async () => {
    const { raw } = await createToken(owner, {
      name: "Contacts reader 2",
      workspaceId: owner.workspaceId,
      scopes: ["contacts:read"],
    });
    const write = await app.request("/contacts", {
      method: "POST",
      headers: { ...bearer(raw), "content-type": "application/json" },
      body: JSON.stringify({ channel: "whatsapp", externalId: "123" }),
    });
    expect(write.status).toBe(403);
    expect(((await write.json()) as { error: { details: { requiredScope: string } } }).error.details.requiredScope).toBe("contacts:write");

    const kb = await app.request("/kb/documents", { headers: bearer(raw) });
    expect(kb.status).toBe(403);
  });

  test("write implies read; * covers any resource route", async () => {
    const writer = await createToken(owner, {
      name: "Broadcast writer",
      workspaceId: owner.workspaceId,
      scopes: ["broadcasts:write"],
    });
    const read = await app.request("/broadcasts", { headers: bearer(writer.raw) });
    expect(read.status).toBe(503);
    const write = await app.request("/contacts", {
      method: "POST",
      headers: { ...bearer(writer.raw), "content-type": "application/json" },
      body: JSON.stringify({ channel: "whatsapp", externalId: "123" }),
    });
    expect(write.status).toBe(403); // broadcasts:write does not leak into contacts

    const full = await createToken(owner, {
      name: "Full bound",
      workspaceId: owner.workspaceId,
      scopes: ["*"],
    });
    expect((await app.request("/kb/documents", { headers: bearer(full.raw) })).status).toBe(503);
    expect((await app.request("/flows", { headers: bearer(full.raw) })).status).toBe(503);
  });

  test("restricted tokens cannot call non-resource routes (me, token management, workspaces)", async () => {
    const { raw } = await createToken(owner, {
      name: "Star bound",
      workspaceId: owner.workspaceId,
      scopes: ["*"],
    });
    expect((await app.request("/auth/me", { headers: bearer(raw) })).status).toBe(403);
    expect((await app.request("/auth/tokens", { headers: bearer(raw) })).status).toBe(403);
    expect((await app.request("/workspaces", { headers: bearer(raw) })).status).toBe(403);
    const mint = await app.request("/auth/tokens", {
      method: "POST",
      headers: { ...bearer(raw), "content-type": "application/json" },
      body: JSON.stringify({ name: "Nested" }),
    });
    expect(mint.status).toBe(403);
  });

  test("a workspace-bound token without scopes has full resource access but stays confined", async () => {
    const { raw } = await createToken(owner, { name: "Bound only", workspaceId: owner.workspaceId });
    expect((await app.request("/posts", { headers: bearer(raw) })).status).toBe(503);
    expect((await app.request("/stats/overview", { headers: bearer(raw) })).status).toBe(503);
    expect((await app.request("/auth/me", { headers: bearer(raw) })).status).toBe(403);
  });

  test("an empty scope list authenticates but grants nothing", async () => {
    const { raw } = await createToken(owner, { name: "Empty", scopes: [] });
    expect((await app.request("/contacts", { headers: bearer(raw, owner.workspaceId) })).status).toBe(403);
    expect((await app.request("/stats/overview", { headers: bearer(raw, owner.workspaceId) })).status).toBe(403);
  });
});

describe("workspace binding", () => {
  test("absent header uses the bound workspace; matching header works; foreign header is 403", async () => {
    const { raw } = await createToken(owner, {
      name: "Bound",
      workspaceId: owner.workspaceId,
      scopes: ["contacts:read"],
    });
    expect((await app.request("/contacts", { headers: bearer(raw) })).status).toBe(503);
    expect((await app.request("/contacts", { headers: bearer(raw, owner.workspaceId) })).status).toBe(503);

    const foreign = await app.request("/contacts", { headers: bearer(raw, otherWorkspaceId) });
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as { error: { details: { boundWorkspaceId: string } } }).error.details.boundWorkspaceId).toBe(owner.workspaceId);

    // Same via the GET query selector.
    const viaQuery = await app.request(`/contacts?workspace_id=${otherWorkspaceId}`, { headers: bearer(raw) });
    expect(viaQuery.status).toBe(403);
  });

  test("path-selected workspace (members admin) obeys the binding", async () => {
    const { raw } = await createToken(owner, {
      name: "Bound settings",
      workspaceId: owner.workspaceId,
      scopes: ["settings:read"],
    });
    const own = await app.request(`/workspaces/${owner.workspaceId}/members`, { headers: bearer(raw) });
    expect(own.status).toBe(200);
    const foreign = await app.request(`/workspaces/${otherWorkspaceId}/members`, { headers: bearer(raw) });
    expect(foreign.status).toBe(403);
  });

  test("removing the owner from the bound workspace kills the token (403)", async () => {
    const member = await registerUser(app, "bound-member@example.com");
    // Add the member to the owner's workspace, mint a bound token as them.
    const add = await app.request(`/workspaces/${owner.workspaceId}/members`, {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ email: "bound-member@example.com", role: "member" }),
    });
    expect(add.status).toBe(201);
    const { raw } = await createToken(member, {
      name: "Member bound",
      workspaceId: owner.workspaceId,
      scopes: ["contacts:read"],
    });
    expect((await app.request("/contacts", { headers: bearer(raw) })).status).toBe(503);

    for (const [key, m] of store.members) {
      if (m.workspaceId === owner.workspaceId && m.userId === member.userId) store.members.delete(key);
    }
    const after = await app.request("/contacts", { headers: bearer(raw) });
    expect(after.status).toBe(403);
  });

  test("an unbound scoped token still needs membership in the header-selected workspace", async () => {
    const { raw } = await createToken(owner, { name: "Unbound scoped", scopes: ["contacts:read"] });
    expect((await app.request("/contacts", { headers: bearer(raw, owner.workspaceId) })).status).toBe(503);
    expect((await app.request("/contacts", { headers: bearer(raw, crypto.randomUUID()) })).status).toBe(403);
  });
});

describe("expiry", () => {
  test("an expired token answers 401 TOKEN_EXPIRED, distinct from invalid", async () => {
    const { raw, info } = await createToken(owner, {
      name: "Short lived",
      workspaceId: owner.workspaceId,
      scopes: ["contacts:read"],
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect((await app.request("/contacts", { headers: bearer(raw) })).status).toBe(503);

    const record = store.apiTokens.get(info.id);
    expect(record).toBeDefined();
    record!.expiresAt = new Date(Date.now() - 1000).toISOString();

    const res = await app.request("/contacts", { headers: bearer(raw) });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("TOKEN_EXPIRED");
  });

  test("expiry alone does not restrict routes (legacy-with-expiry still reaches /auth/me until it lapses)", async () => {
    const { raw } = await createToken(owner, {
      name: "Expiring legacy",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const me = await app.request("/auth/me", { headers: bearer(raw) });
    expect(me.status).toBe(200);
  });
});

describe("legacy tokens + sessions are untouched", () => {
  test("a plain token keeps full user behavior, including non-resource routes", async () => {
    const { raw, info } = await createToken(owner, { name: "Legacy" });
    expect(info.workspaceId).toBeNull();
    expect(info.scopes).toBeNull();
    expect(info.expiresAt).toBeNull();
    expect((await app.request("/auth/me", { headers: bearer(raw) })).status).toBe(200);
    expect((await app.request("/workspaces", { headers: bearer(raw) })).status).toBe(200);
    expect((await app.request("/contacts", { headers: bearer(raw, owner.workspaceId) })).status).toBe(503);
  });

  test("session JWTs are never scope-limited", async () => {
    expect((await app.request("/auth/me", { headers: owner.headers })).status).toBe(200);
    expect((await app.request("/contacts", { headers: owner.headers })).status).toBe(503);
    expect((await app.request("/workspaces", { headers: owner.headers })).status).toBe(200);
  });
});
