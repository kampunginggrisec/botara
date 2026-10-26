import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { registerUser, testDeps, type Registered } from "./test-helpers";
import { InMemoryAuthStore } from "./auth";

/**
 * Invite-by-link + member presence + ownership transfer (adoption #9).
 *
 * Everything runs on the in-memory auth store, so these tests pin the
 * HTTP contract end to end: minting (owner/admin only, raw token once),
 * the public preview (no member data), accept semantics (typed errors,
 * uses spent exactly once - including two raced accepts for the last
 * use), presence on the members list, and the one-owner invariant
 * across transfers.
 */

// Generous rate budgets: this file exercises /auth/* and /invites/*
// far beyond the production per-minute limits.
const deps = testDeps({ rateLimits: { authPerMinute: 10000, publicPerMinute: 10000 } });
const app = createApp(deps);
const store = deps.authStore as InMemoryAuthStore;

const OWNER_EMAIL = "owner9@example.com";
const ADMIN_EMAIL = "admin9@example.com";
const MEMBER_EMAIL = "member9@example.com";
const AGENT_EMAIL = "agent9@example.com";

let owner: Registered;
let admin: Registered;
let member: Registered;
let agent: Registered;

const errCode = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: { code: string } }).error.code;

async function addMemberByEmail(workspaceId: string, auth: Registered, email: string, role: string): Promise<void> {
  const res = await app.request(`/workspaces/${workspaceId}/members`, {
    method: "POST",
    headers: { ...auth.headers, "content-type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  expect(res.status).toBe(201);
}

async function createInvite(
  auth: Registered,
  body: Record<string, unknown>,
  workspaceId = owner.workspaceId,
): Promise<{ raw: string; invitePath: string; invite: { id: string; prefix: string; role: string } }> {
  const res = await app.request(`/workspaces/${workspaceId}/invites`, {
    method: "POST",
    headers: { ...auth.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  const parsed = (await res.json()) as { token: string; invitePath: string; invite: { id: string; prefix: string; role: string } };
  return { raw: parsed.token, invitePath: parsed.invitePath, invite: parsed.invite };
}

async function acceptAs(auth: Registered, raw: string): Promise<Response> {
  return app.request(`/invites/${raw}/accept`, {
    method: "POST",
    headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
    body: "{}",
  });
}

interface MemberRow { userId: string; email: string; role: string; online: boolean }

async function membersOf(auth: Registered, workspaceId = owner.workspaceId): Promise<MemberRow[]> {
  const res = await app.request(`/workspaces/${workspaceId}/members`, { headers: auth.headers });
  expect(res.status).toBe(200);
  return ((await res.json()) as { members: MemberRow[] }).members;
}

beforeAll(async () => {
  owner = await registerUser(app, OWNER_EMAIL, "Olivia Owner");
  admin = await registerUser(app, ADMIN_EMAIL, "Adam Admin");
  member = await registerUser(app, MEMBER_EMAIL, "Mia Member");
  agent = await registerUser(app, AGENT_EMAIL, "Andy Agent");
  await addMemberByEmail(owner.workspaceId, owner, ADMIN_EMAIL, "admin");
  await addMemberByEmail(owner.workspaceId, owner, MEMBER_EMAIL, "member");
  await addMemberByEmail(owner.workspaceId, owner, AGENT_EMAIL, "agent");
});

describe("invite creation + listing", () => {
  test("owner mints a link: raw token once, list shows only the fragment", async () => {
    const { raw, invitePath, invite } = await createInvite(owner, { role: "agent", maxUses: 5 });
    expect(raw.startsWith("bti_")).toBe(true);
    expect(invitePath).toBe(`/invite/${raw}`);
    expect(invite.role).toBe("agent");

    const listRes = await app.request(`/workspaces/${owner.workspaceId}/invites`, { headers: owner.headers });
    expect(listRes.status).toBe(200);
    const listText = await listRes.text();
    const invites = (JSON.parse(listText) as { invites: Array<{ id: string; prefix: string; maxUses: number | null; usesCount: number }> }).invites;
    const found = invites.find((i) => i.id === invite.id);
    expect(found?.prefix).toBe(invite.prefix);
    expect(found?.maxUses).toBe(5);
    expect(found?.usesCount).toBe(0);
    // Neither the raw token nor its hash may ever appear in a list.
    expect(listText).not.toContain(raw);
    expect(listText).not.toContain("tokenHash");
  });

  test("an invite can never grant owner (400 VALIDATION)", async () => {
    const res = await app.request(`/workspaces/${owner.workspaceId}/invites`, {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ role: "owner" }),
    });
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe("VALIDATION");
  });

  test("members and agents cannot create, list or revoke invites (403); admins can mint", async () => {
    for (const actor of [member, agent]) {
      const create = await app.request(`/workspaces/${owner.workspaceId}/invites`, {
        method: "POST",
        headers: { ...actor.headers, "content-type": "application/json" },
        body: JSON.stringify({ role: "member" }),
      });
      expect(create.status).toBe(403);
      const list = await app.request(`/workspaces/${owner.workspaceId}/invites`, { headers: actor.headers });
      expect(list.status).toBe(403);
      const revoke = await app.request(`/workspaces/${owner.workspaceId}/invites/some-id`, {
        method: "DELETE",
        headers: actor.headers,
      });
      expect(revoke.status).toBe(403);
    }
    const { invite } = await createInvite(admin, { role: "member" });
    expect(invite.role).toBe("member");
  });

  test("revoke is idempotent; unknown invite is a 404", async () => {
    const { invite } = await createInvite(owner, { role: "member" });
    const first = await app.request(`/workspaces/${owner.workspaceId}/invites/${invite.id}`, {
      method: "DELETE", headers: owner.headers,
    });
    expect(first.status).toBe(200);
    const second = await app.request(`/workspaces/${owner.workspaceId}/invites/${invite.id}`, {
      method: "DELETE", headers: owner.headers,
    });
    expect(second.status).toBe(200);
    const missing = await app.request(`/workspaces/${owner.workspaceId}/invites/${crypto.randomUUID()}`, {
      method: "DELETE", headers: owner.headers,
    });
    expect(missing.status).toBe(404);
  });
});

describe("public preview", () => {
  test("a valid link previews workspace name + role and NO member data", async () => {
    const { raw } = await createInvite(owner, { role: "admin" });
    const res = await app.request(`/invites/${raw}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.valid).toBe(true);
    expect(body.reason).toBeNull();
    expect(body.workspaceName).toBe("Olivia Owner's Workspace");
    expect(body.role).toBe("admin");
    // Exactly the preview fields - no emails, no member list, no ids.
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "reason", "role", "valid", "workspaceName"]);
    expect(JSON.stringify(body)).not.toContain("@example.com");
  });

  test("an unknown token previews as invalid without leaking anything", async () => {
    const res = await app.request(`/invites/bti_doesnotexist`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean; reason: string; workspaceName: unknown };
    expect(body.valid).toBe(false);
    expect(body.reason).toBe("invalid");
    expect(body.workspaceName).toBeNull();
  });
});

describe("accept", () => {
  test("happy path: role granted, exactly one use spent, audit written", async () => {
    const { raw, invite } = await createInvite(owner, { role: "agent" });
    const joiner = await registerUser(app, "joiner1@example.com", "Jay Joiner");
    const res = await acceptAs(joiner, raw);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace: { id: string; role: string }; member: { role: string } };
    expect(body.workspace.id).toBe(owner.workspaceId);
    expect(body.member.role).toBe("agent");

    const members = await membersOf(owner);
    expect(members.find((m) => m.userId === joiner.userId)?.role).toBe("agent");

    expect(store.invites.get(invite.id)?.usesCount).toBe(1);
    expect(store.auditLog.some((a) => a.action === "workspace.invite.accept" && a.userId === joiner.userId)).toBe(true);
    expect(store.auditLog.some((a) => a.action === "workspace.invite.create")).toBe(true);
  });

  test("accept requires a session (401)", async () => {
    const { raw } = await createInvite(owner, { role: "member" });
    const res = await app.request(`/invites/${raw}/accept`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  test("already a member: 409 ALREADY_MEMBER, NO use consumed, role untouched", async () => {
    const { raw, invite } = await createInvite(owner, { role: "admin" });
    const res = await acceptAs(member, raw);
    expect(res.status).toBe(409);
    expect(await errCode(res)).toBe("ALREADY_MEMBER");
    expect(store.invites.get(invite.id)?.usesCount).toBe(0);
    const members = await membersOf(owner);
    expect(members.find((m) => m.userId === member.userId)?.role).toBe("member");
  });

  test("revoked link: accept 410 INVITE_REVOKED, preview reports revoked", async () => {
    const { raw, invite } = await createInvite(owner, { role: "member" });
    await app.request(`/workspaces/${owner.workspaceId}/invites/${invite.id}`, {
      method: "DELETE", headers: owner.headers,
    });
    const joiner = await registerUser(app, "joiner2@example.com");
    const res = await acceptAs(joiner, raw);
    expect(res.status).toBe(410);
    expect(await errCode(res)).toBe("INVITE_REVOKED");
    const preview = (await (await app.request(`/invites/${raw}`)).json()) as { valid: boolean; reason: string };
    expect(preview.valid).toBe(false);
    expect(preview.reason).toBe("revoked");
  });

  test("expired link: accept 410 INVITE_EXPIRED, preview reports expired", async () => {
    const { raw, invite } = await createInvite(owner, { role: "member", expiresInDays: 7 });
    // Time-travel: pull the stored expiry into the past.
    store.invites.get(invite.id)!.expiresAt = new Date(Date.now() - 1000);
    const joiner = await registerUser(app, "joiner3@example.com");
    const res = await acceptAs(joiner, raw);
    expect(res.status).toBe(410);
    expect(await errCode(res)).toBe("INVITE_EXPIRED");
    const preview = (await (await app.request(`/invites/${raw}`)).json()) as { valid: boolean; reason: string };
    expect(preview.reason).toBe("expired");
  });

  test("exhausted link: second accept gets 410 INVITE_EXHAUSTED", async () => {
    const { raw } = await createInvite(owner, { role: "member", maxUses: 1 });
    const first = await registerUser(app, "joiner4@example.com");
    expect((await acceptAs(first, raw)).status).toBe(200);
    const second = await registerUser(app, "joiner5@example.com");
    const res = await acceptAs(second, raw);
    expect(res.status).toBe(410);
    expect(await errCode(res)).toBe("INVITE_EXHAUSTED");
    const preview = (await (await app.request(`/invites/${raw}`)).json()) as { valid: boolean; reason: string };
    expect(preview.reason).toBe("exhausted");
  });

  test("two raced accepts for the last use: exactly one joins, uses_count is 1", async () => {
    const { raw, invite } = await createInvite(owner, { role: "member", maxUses: 1 });
    const racerA = await registerUser(app, "racer-a@example.com");
    const racerB = await registerUser(app, "racer-b@example.com");
    const [resA, resB] = await Promise.all([acceptAs(racerA, raw), acceptAs(racerB, raw)]);
    expect([resA.status, resB.status].sort()).toEqual([200, 410]);
    expect(store.invites.get(invite.id)?.usesCount).toBe(1);
    const members = await membersOf(owner);
    const joined = [racerA, racerB].filter((r) => members.some((m) => m.userId === r.userId));
    expect(joined).toHaveLength(1);
  });

  test("unknown token: accept 404 INVITE_INVALID", async () => {
    const res = await acceptAs(member, "bti_nope");
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe("INVITE_INVALID");
  });
});

describe("member presence", () => {
  test("without a presence reader everyone reads offline (field present)", async () => {
    const members = await membersOf(owner);
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((m) => m.online === false)).toBe(true);
  });

  test("a live presence key flips exactly that member online", async () => {
    const online = new Set<string>();
    const deps2 = testDeps({
      rateLimits: { authPerMinute: 10000, publicPerMinute: 10000 },
      presenceReader: {
        async onlineUserIds(_workspaceId: string, userIds: string[]) {
          return new Set(userIds.filter((id) => online.has(id)));
        },
      },
    });
    const app2 = createApp(deps2);
    const o2 = await registerUser(app2, "pres-owner@example.com");
    const m2 = await registerUser(app2, "pres-member@example.com");
    const add = await app2.request(`/workspaces/${o2.workspaceId}/members`, {
      method: "POST",
      headers: { ...o2.headers, "content-type": "application/json" },
      body: JSON.stringify({ email: "pres-member@example.com", role: "member" }),
    });
    expect(add.status).toBe(201);
    online.add(m2.userId);
    const res = await app2.request(`/workspaces/${o2.workspaceId}/members`, { headers: o2.headers });
    expect(res.status).toBe(200);
    const members = ((await res.json()) as { members: MemberRow[] }).members;
    expect(members.find((m) => m.userId === m2.userId)?.online).toBe(true);
    expect(members.find((m) => m.userId === o2.userId)?.online).toBe(false);
  });

  test("a throwing presence reader still returns the members list, all offline", async () => {
    const deps3 = testDeps({
      rateLimits: { authPerMinute: 10000 },
      presenceReader: {
        async onlineUserIds(): Promise<Set<string>> {
          throw new Error("redis is down");
        },
      },
    });
    const app3 = createApp(deps3);
    const o3 = await registerUser(app3, "down-owner@example.com");
    const res = await app3.request(`/workspaces/${o3.workspaceId}/members`, { headers: o3.headers });
    expect(res.status).toBe(200);
    const members = ((await res.json()) as { members: MemberRow[] }).members;
    expect(members).toHaveLength(1);
    expect(members[0]?.online).toBe(false);
  });
});

describe("ownership transfer", () => {
  test("owner -> member: roles swap, exactly one owner, audit written; new owner can transfer back", async () => {
    // A dedicated workspace so the swap cannot disturb the other tests.
    const boss = await registerUser(app, "boss@example.com", "Boss");
    const heir = await registerUser(app, "heir@example.com", "Heir");
    await addMemberByEmail(boss.workspaceId, boss, "heir@example.com", "member");
    const auditsBefore = store.auditLog.length;
    const res = await app.request(`/workspaces/${boss.workspaceId}/transfer-ownership`, {
      method: "POST",
      headers: { ...boss.headers, "content-type": "application/json" },
      body: JSON.stringify({ userId: heir.userId }),
    });
    expect(res.status).toBe(200);
    const members = await membersOf(heir, boss.workspaceId);
    expect(members.filter((m) => m.role === "owner")).toHaveLength(1);
    expect(members.find((m) => m.userId === heir.userId)?.role).toBe("owner");
    expect(members.find((m) => m.userId === boss.userId)?.role).toBe("admin");
    const audit = store.auditLog.slice(auditsBefore).find((a) => a.action === "workspace.ownership_transferred");
    expect(audit?.details).toMatchObject({ fromUserId: boss.userId, toUserId: heir.userId });
    const back = await app.request(`/workspaces/${boss.workspaceId}/transfer-ownership`, {
      method: "POST",
      headers: { ...heir.headers, "content-type": "application/json" },
      body: JSON.stringify({ userId: boss.userId }),
    });
    expect(back.status).toBe(200);
    const again = await app.request(`/workspaces/${boss.workspaceId}/transfer-ownership`, {
      method: "POST",
      headers: { ...heir.headers, "content-type": "application/json" },
      body: JSON.stringify({ userId: boss.userId }),
    });
    expect(again.status).toBe(403);
  });

  test("an admin who is not the owner gets 403", async () => {
    const res = await app.request(`/workspaces/${owner.workspaceId}/transfer-ownership`, {
      method: "POST",
      headers: { ...admin.headers, "content-type": "application/json" },
      body: JSON.stringify({ userId: member.userId }),
    });
    expect(res.status).toBe(403);
  });

  test("target must be a member (404) and cannot be the owner themself (400)", async () => {
    const outsider = await registerUser(app, "outsider@example.com");
    const notMember = await app.request(`/workspaces/${owner.workspaceId}/transfer-ownership`, {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ userId: outsider.userId }),
    });
    expect(notMember.status).toBe(404);
    const self = await app.request(`/workspaces/${owner.workspaceId}/transfer-ownership`, {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ userId: owner.userId }),
    });
    expect(self.status).toBe(400);
  });
});

describe("scoped tokens vs the new routes (#5 consistency)", () => {
  async function mintToken(auth: Registered, body: Record<string, unknown>): Promise<string> {
    const res = await app.request("/auth/tokens", {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { token: string }).token;
  }

  test("settings:read token reads members but cannot create invites or transfer (settings:write)", async () => {
    const raw = await mintToken(owner, { name: "reader", workspaceId: owner.workspaceId, scopes: ["settings:read"] });
    const headers = { authorization: `Bearer ${raw}` };
    const membersRes = await app.request(`/workspaces/${owner.workspaceId}/members`, { headers });
    expect(membersRes.status).toBe(200);
    const create = await app.request(`/workspaces/${owner.workspaceId}/invites`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ role: "member" }),
    });
    expect(create.status).toBe(403);
    const transfer = await app.request(`/workspaces/${owner.workspaceId}/transfer-ownership`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ userId: member.userId }),
    });
    expect(transfer.status).toBe(403);
  });

  test("a restricted token cannot accept an invite (session/public route)", async () => {
    const { raw: link } = await createInvite(owner, { role: "member" });
    const scoped = await mintToken(owner, { name: "scoped", scopes: ["contacts:read"] });
    const res = await app.request(`/invites/${link}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${scoped}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  test("a token bound to another workspace cannot list this workspace's invites", async () => {
    const bound = await mintToken(member, { name: "bound", workspaceId: member.workspaceId, scopes: ["*"] });
    const res = await app.request(`/workspaces/${owner.workspaceId}/invites`, {
      headers: { authorization: `Bearer ${bound}` },
    });
    expect(res.status).toBe(403);
  });
});
