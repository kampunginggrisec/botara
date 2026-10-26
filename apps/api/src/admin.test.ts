import { describe, expect, test } from "bun:test";
import { InMemoryPlatformSettingsStorage, PlatformSettingsService } from "@botara/db";
import { createApp, type ApiDeps } from "./app";
import { InMemoryAdminStore } from "./admin";
import { InMemoryAuthStore } from "./auth";
import { testDeps, registerUser } from "./test-helpers";

/**
 * Platform admin panel - route-level tests over in-memory stores.
 * The first registered user is the platform admin (bootstrap rule), so
 * registerUser #1 is the operator and #2 is a plain user in every test.
 */
function setup() {
  const authStore = new InMemoryAuthStore();
  const adminStore = new InMemoryAdminStore();
  const env: Record<string, string | undefined> = {
    WHATSAPP_VERIFY_TOKEN: "verify-me",
    SESSION_SECRET: "test-session-secret",
    META_APP_ID: "env-app-id",
  };
  const storage = new InMemoryPlatformSettingsStorage();
  const platformSettings = new PlatformSettingsService(storage, {
    baseEnv: env,
    liveEnv: env,
    vaultKey: Buffer.alloc(32, 7),
  });
  const deps: ApiDeps = testDeps({ authStore, adminStore, platformSettings, env });
  return { app: createApp(deps), authStore, adminStore, platformSettings, storage, env, deps };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

describe("platform-admin bootstrap (first registered user)", () => {
  test("first user gets the flag, second does not; /auth/me exposes it", async () => {
    const { app } = setup();
    const first = await registerUser(app, "first@example.com");
    const second = await registerUser(app, "second@example.com");

    const meFirst = await app.request("/auth/me", { headers: auth(first.token) });
    expect(((await meFirst.json()) as { user: { isPlatformAdmin: boolean } }).user.isPlatformAdmin).toBe(true);
    const meSecond = await app.request("/auth/me", { headers: auth(second.token) });
    expect(((await meSecond.json()) as { user: { isPlatformAdmin: boolean } }).user.isPlatformAdmin).toBe(false);
  });

  test("login stamps last_login_at", async () => {
    const { app, authStore } = setup();
    const first = await registerUser(app, "first@example.com");
    expect(authStore.lastLogins.has(first.userId)).toBe(false);
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "first@example.com", password: "password-123" }),
    });
    expect(res.status).toBe(200);
    expect(authStore.lastLogins.get(first.userId)).toBeInstanceOf(Date);
  });
});

describe("/admin guard", () => {
  test("unauthenticated -> 401, non-admin -> 403, admin -> 200", async () => {
    const { app } = setup();
    const admin = await registerUser(app, "admin@example.com");
    const plain = await registerUser(app, "plain@example.com");

    const anon = await app.request("/admin/overview");
    expect(anon.status).toBe(401);

    const forbidden = await app.request("/admin/overview", { headers: auth(plain.token) });
    expect(forbidden.status).toBe(403);

    const ok = await app.request("/admin/overview", { headers: auth(admin.token) });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { totals: { users: number }; activeUsers: { last7d: number } };
    expect(body.totals.users).toBe(0); // InMemoryAdminStore is an independent read model
    expect(body.activeUsers.last7d).toBe(0);
  });
});

describe("/admin/settings", () => {
  test("resolution order db > env > unset, live env updated immediately, clear restores env", async () => {
    const { app, env } = setup();
    const admin = await registerUser(app, "admin@example.com");

    const before = await app.request("/admin/settings", { headers: auth(admin.token) });
    const beforeBody = (await before.json()) as { settings: Array<{ key: string; source: string | null; isSet: boolean }> };
    const metaBefore = beforeBody.settings.find((s) => s.key === "META_APP_ID");
    expect(metaBefore).toMatchObject({ source: "env", isSet: true });
    expect(beforeBody.settings.find((s) => s.key === "TIKTOK_APP_ID")).toMatchObject({ source: null, isSet: false });

    const put = await app.request("/admin/settings", {
      method: "PUT",
      headers: auth(admin.token),
      body: JSON.stringify({ updates: [{ key: "META_APP_ID", value: "db-app-id" }] }),
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { settings: Array<{ key: string; source: string | null; value: string | null }> };
    expect(putBody.settings.find((s) => s.key === "META_APP_ID")?.source).toBe("db");
    // Non-secret settings expose their resolved value (panel prefills inputs).
    expect(putBody.settings.find((s) => s.key === "META_APP_ID")?.value).toBe("db-app-id");
    // The writing process applies the change to its live env immediately.
    expect(env.META_APP_ID).toBe("db-app-id");
    const pub = await app.request("/config/public");
    expect(((await pub.json()) as { metaAppId: string }).metaAppId).toBe("db-app-id");

    const cleared = await app.request("/admin/settings", {
      method: "PUT",
      headers: auth(admin.token),
      body: JSON.stringify({ updates: [{ key: "META_APP_ID", clear: true }] }),
    });
    const clearedBody = (await cleared.json()) as { settings: Array<{ key: string; source: string | null }> };
    expect(clearedBody.settings.find((s) => s.key === "META_APP_ID")?.source).toBe("env");
    expect(env.META_APP_ID).toBe("env-app-id");
  });

  test("secrets are encrypted at rest and never returned by the API", async () => {
    const { app, storage, authStore } = setup();
    const admin = await registerUser(app, "admin@example.com");
    const SECRET = "EAA-super-secret-value";

    const put = await app.request("/admin/settings", {
      method: "PUT",
      headers: auth(admin.token),
      body: JSON.stringify({ updates: [{ key: "META_APP_SECRET", value: SECRET }] }),
    });
    expect(put.status).toBe(200);
    expect(await put.text()).not.toContain(SECRET);

    const get = await app.request("/admin/settings", { headers: auth(admin.token) });
    const getText = await get.text();
    expect(getText).not.toContain(SECRET);
    const body = JSON.parse(getText) as { settings: Array<{ key: string; source: string | null; secret: boolean; value: string | null }> };
    expect(body.settings.find((s) => s.key === "META_APP_SECRET")).toMatchObject({ source: "db", secret: true });
    // Even though the value is set, the view never carries it.
    expect(body.settings.find((s) => s.key === "META_APP_SECRET")?.value).toBeNull();

    // At rest: ciphertext only.
    const row = storage.rows.get("META_APP_SECRET");
    expect(row?.value).toBeNull();
    expect(row?.secretCiphertext).toBeTruthy();
    expect(row?.secretCiphertext).not.toContain(SECRET);

    // Audit trail records the key name, never the value.
    const auditJson = JSON.stringify(authStore.auditLog);
    expect(auditJson).toContain("admin.settings.update");
    expect(auditJson).toContain("META_APP_SECRET");
    expect(auditJson).not.toContain(SECRET);
  });

  test("unmanaged keys are rejected with 400", async () => {
    const { app } = setup();
    const admin = await registerUser(app, "admin@example.com");
    const res = await app.request("/admin/settings", {
      method: "PUT",
      headers: auth(admin.token),
      body: JSON.stringify({ updates: [{ key: "SESSION_SECRET", value: "nope" }] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("platform-admin grant/revoke", () => {
  test("the last platform admin cannot be revoked (409); with two admins revoke works", async () => {
    const { app } = setup();
    const admin = await registerUser(app, "admin@example.com");
    const other = await registerUser(app, "other@example.com");

    const revokeLast = await app.request(`/admin/users/${admin.userId}/platform-admin`, {
      method: "POST",
      headers: auth(admin.token),
      body: JSON.stringify({ grant: false }),
    });
    expect(revokeLast.status).toBe(409);

    const grant = await app.request(`/admin/users/${other.userId}/platform-admin`, {
      method: "POST",
      headers: auth(admin.token),
      body: JSON.stringify({ grant: true }),
    });
    expect(grant.status).toBe(200);
    expect(((await grant.json()) as { user: { isPlatformAdmin: boolean } }).user.isPlatformAdmin).toBe(true);

    const revokeNow = await app.request(`/admin/users/${admin.userId}/platform-admin`, {
      method: "POST",
      headers: auth(other.token),
      body: JSON.stringify({ grant: false }),
    });
    expect(revokeNow.status).toBe(200);
    // The revoked admin loses access immediately.
    const after = await app.request("/admin/overview", { headers: auth(admin.token) });
    expect(after.status).toBe(403);
  });

  test("grant on a missing user -> 404", async () => {
    const { app } = setup();
    const admin = await registerUser(app, "admin@example.com");
    const res = await app.request(`/admin/users/${crypto.randomUUID()}/platform-admin`, {
      method: "POST",
      headers: auth(admin.token),
      body: JSON.stringify({ grant: true }),
    });
    expect(res.status).toBe(404);
  });
});

describe("/admin read views", () => {
  test("overview counts active users by login window", async () => {
    const { app, adminStore } = setup();
    const admin = await registerUser(app, "admin@example.com");
    const now = Date.now();
    adminStore.users = [
      { id: "u1", email: "a@x.id", name: "A", createdAt: new Date(now - 40 * 86400e3), lastLoginAt: new Date(now - 2 * 86400e3), isPlatformAdmin: true, workspaces: [] },
      { id: "u2", email: "b@x.id", name: "B", createdAt: new Date(now - 20 * 86400e3), lastLoginAt: new Date(now - 15 * 86400e3), isPlatformAdmin: false, workspaces: [] },
      { id: "u3", email: "c@x.id", name: "C", createdAt: new Date(now - 90 * 86400e3), lastLoginAt: null, isPlatformAdmin: false, workspaces: [] },
    ];
    adminStore.channelAccountsByChannel = [{ channel: "whatsapp", count: 3 }, { channel: "telegram", count: 1 }];
    adminStore.messagesTotal = 120;
    adminStore.messagesLast30d = 45;
    const res = await app.request("/admin/overview", { headers: auth(admin.token) });
    const body = (await res.json()) as {
      totals: { users: number; channelAccounts: number; messagesLast30d: number };
      activeUsers: { last7d: number; last30d: number };
      recentRegistrations: Array<{ email: string }>;
    };
    expect(body.totals.users).toBe(3);
    expect(body.totals.channelAccounts).toBe(4);
    expect(body.totals.messagesLast30d).toBe(45);
    expect(body.activeUsers).toEqual({ last7d: 1, last30d: 2 });
    expect(body.recentRegistrations[0]?.email).toBe("b@x.id");
  });

  test("billing aggregates the ledger per workspace + category with period filtering", async () => {
    const { app, adminStore } = setup();
    const admin = await registerUser(app, "admin@example.com");
    const now = Date.now();
    adminStore.ledger = [
      { workspaceId: "ws-a", workspaceName: "Toko A", category: "marketing", currency: "USD", units: 10, amount: 0.416, createdAt: new Date(now - 1 * 86400e3) },
      { workspaceId: "ws-a", workspaceName: "Toko A", category: "marketing", currency: "USD", units: 5, amount: 0.208, createdAt: new Date(now - 2 * 86400e3) },
      { workspaceId: "ws-a", workspaceName: "Toko A", category: "utility", currency: "USD", units: 8, amount: 0.1, createdAt: new Date(now - 3 * 86400e3) },
      { workspaceId: "ws-b", workspaceName: "Toko B", category: "service", currency: "USD", units: 100, amount: 0, createdAt: new Date(now - 1 * 86400e3) },
      { workspaceId: "ws-a", workspaceName: "Toko A", category: "marketing", currency: "USD", units: 999, amount: 41.5, createdAt: new Date(now - 60 * 86400e3) },
    ];
    const res = await app.request("/admin/billing?days=30", { headers: auth(admin.token) });
    const body = (await res.json()) as {
      days: number;
      workspaces: Array<{ workspaceId: string; units: number; amount: number; byCategory: Array<{ category: string; units: number; entries: number; amount: number }> }>;
      totals: Array<{ currency: string; units: number; entries: number; amount: number }>;
    };
    expect(body.days).toBe(30);
    const wsA = body.workspaces.find((w) => w.workspaceId === "ws-a");
    expect(wsA?.units).toBe(23);
    expect(wsA?.amount).toBeCloseTo(0.724, 6);
    expect(wsA?.byCategory.find((c) => c.category === "marketing")).toMatchObject({ units: 15, entries: 2 });
    expect(wsA?.byCategory.find((c) => c.category === "utility")).toMatchObject({ units: 8, entries: 1 });
    expect(body.totals).toEqual([{ currency: "USD", units: 123, entries: 4, amount: 0.724 }]);

    const res90 = await app.request("/admin/billing?days=90", { headers: auth(admin.token) });
    const body90 = (await res90.json()) as { totals: Array<{ units: number }> };
    expect(body90.totals[0]?.units).toBe(1122);
  });

  test("users + workspaces + audit views serialize", async () => {
    const { app, adminStore } = setup();
    const admin = await registerUser(app, "admin@example.com");
    adminStore.users = [
      { id: "u1", email: "op@x.id", name: "Op", createdAt: new Date("2026-10-01T00:00:00Z"), lastLoginAt: new Date("2026-10-25T00:00:00Z"), isPlatformAdmin: true, workspaces: [{ id: "ws1", name: "Main", role: "owner" }] },
    ];
    adminStore.workspaces = [
      { id: "ws1", name: "Main", slug: "main", ownerEmail: "op@x.id", memberCount: 2, channelAccountCount: 1, messageCount: 42, createdAt: new Date("2026-10-01T00:00:00Z") },
    ];
    adminStore.auditRows = [
      { id: "a1", action: "auth.login", actorEmail: "op@x.id", userId: "u1", workspaceId: null, details: {}, createdAt: new Date("2026-10-25T01:00:00Z") },
    ];
    const users = await app.request("/admin/users", { headers: auth(admin.token) });
    const usersBody = (await users.json()) as { users: Array<{ email: string; lastLoginAt: string | null; workspaces: Array<{ name: string }> }> };
    expect(usersBody.users[0]?.email).toBe("op@x.id");
    expect(usersBody.users[0]?.lastLoginAt).toBe("2026-10-25T00:00:00.000Z");
    expect(usersBody.users[0]?.workspaces[0]?.name).toBe("Main");

    const workspaces = await app.request("/admin/workspaces", { headers: auth(admin.token) });
    const wsBody = (await workspaces.json()) as { workspaces: Array<{ messageCount: number; ownerEmail: string | null }> };
    expect(wsBody.workspaces[0]).toMatchObject({ messageCount: 42, ownerEmail: "op@x.id" });

    const audit = await app.request("/admin/audit?limit=10", { headers: auth(admin.token) });
    const auditBody = (await audit.json()) as { entries: Array<{ action: string; actorEmail: string | null }> };
    expect(auditBody.entries[0]).toMatchObject({ action: "auth.login", actorEmail: "op@x.id" });
  });
});
