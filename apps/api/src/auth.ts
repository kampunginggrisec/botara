import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@botara/shared";
import {
  createUser, createWorkspace, getUserByEmail, getUserById, getWorkspaceBySlug,
  getWorkspaceMember, insertAuditLog, listWorkspaceMembers, listWorkspacesForUser,
  removeWorkspaceMember, setUserPasswordHash, upsertWorkspaceMember,
  type Database,
} from "@botara/db";

/**
 * Real authentication (Fase 3) - replaces the Fase 1 X-Workspace-Id stand-in.
 *
 * Model:
 * - Users register/login with email + password (argon2id via Bun.password).
 * - A session is a compact HS256 JWT signed with SESSION_SECRET, delivered
 *   as an httpOnly cookie AND accepted as an Authorization Bearer token.
 * - The token proves WHO you are. WHICH workspace you act on is selected
 *   with the X-Workspace-Id header, and the server verifies membership
 *   (with role) on every request - the header alone grants nothing.
 * - Dev fallback: BOTARA_ALLOW_HEADER_WORKSPACE=1 re-enables header-only
 *   context for local development. Default off; never a production path.
 */

export const SESSION_COOKIE = "botara_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

export const ROLES = ["owner", "admin", "member", "agent"] as const;
export type Role = (typeof ROLES)[number];

/** Roles allowed to mutate workspace data (agents are read + reply only). */
export const MUTATOR_ROLES: Role[] = ["owner", "admin", "member"];
/** Roles allowed to administer a workspace (members, settings, domains). */
export const ADMIN_ROLES: Role[] = ["owner", "admin"];

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string | null;
}

export interface AuthWorkspaceView {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export interface AuthMemberView {
  userId: string;
  email: string;
  name: string | null;
  role: string;
}

/** Everything the auth + workspace handlers need from persistence. */
export interface AuthStore {
  findUserByEmail(email: string): Promise<AuthUser | null>;
  findUserById(id: string): Promise<AuthUser | null>;
  createUser(input: { email: string; name?: string; passwordHash?: string }): Promise<AuthUser>;
  setPasswordHash(userId: string, passwordHash: string): Promise<void>;
  createWorkspace(input: { name: string; slug: string }): Promise<{ id: string; name: string; slug: string }>;
  workspaceSlugExists(slug: string): Promise<boolean>;
  addMember(input: { workspaceId: string; userId: string; role: string }): Promise<void>;
  getMembership(workspaceId: string, userId: string): Promise<{ role: string } | null>;
  listWorkspaces(userId: string): Promise<AuthWorkspaceView[]>;
  listMembers(workspaceId: string): Promise<AuthMemberView[]>;
  removeMember(workspaceId: string, userId: string): Promise<boolean>;
  audit(entry: {
    workspaceId?: string;
    userId?: string;
    action: string;
    details?: Record<string, unknown>;
  }): Promise<void>;
}

/** Production AuthStore over the Drizzle repositories. */
export class DbAuthStore implements AuthStore {
  constructor(private readonly getDatabase: () => Database) {}

  async findUserByEmail(email: string) {
    const row = await getUserByEmail(this.getDatabase(), email);
    return row ? { id: row.id, email: row.email, name: row.name, passwordHash: row.passwordHash } : null;
  }

  async findUserById(id: string) {
    const row = await getUserById(this.getDatabase(), id);
    return row ? { id: row.id, email: row.email, name: row.name, passwordHash: row.passwordHash } : null;
  }

  async createUser(input: { email: string; name?: string; passwordHash?: string }) {
    const row = await createUser(this.getDatabase(), input);
    return { id: row.id, email: row.email, name: row.name, passwordHash: row.passwordHash };
  }

  async setPasswordHash(userId: string, passwordHash: string) {
    await setUserPasswordHash(this.getDatabase(), userId, passwordHash);
  }

  async createWorkspace(input: { name: string; slug: string }) {
    const row = await createWorkspace(this.getDatabase(), input);
    return { id: row.id, name: row.name, slug: row.slug };
  }

  async workspaceSlugExists(slug: string) {
    return (await getWorkspaceBySlug(this.getDatabase(), slug)) !== null;
  }

  async addMember(input: { workspaceId: string; userId: string; role: string }) {
    await upsertWorkspaceMember(this.getDatabase(), input);
  }

  async getMembership(workspaceId: string, userId: string) {
    const row = await getWorkspaceMember(this.getDatabase(), workspaceId, userId);
    return row ? { role: row.role } : null;
  }

  async listWorkspaces(userId: string) {
    const rows = await listWorkspacesForUser(this.getDatabase(), userId);
    return rows.map((r) => ({ id: r.workspaceId, name: r.workspaceName, slug: r.slug, role: r.role }));
  }

  async listMembers(workspaceId: string) {
    const rows = await listWorkspaceMembers(this.getDatabase(), workspaceId);
    return rows.map((r) => ({ userId: r.userId, email: r.email, name: r.name, role: r.role }));
  }

  async removeMember(workspaceId: string, userId: string) {
    return removeWorkspaceMember(this.getDatabase(), workspaceId, userId);
  }

  async audit(entry: { workspaceId?: string; userId?: string; action: string; details?: Record<string, unknown> }) {
    await insertAuditLog(this.getDatabase(), entry);
  }
}

/** In-memory AuthStore for tests (and only tests). */
export class InMemoryAuthStore implements AuthStore {
  readonly users = new Map<string, AuthUser>();
  readonly workspaces = new Map<string, { id: string; name: string; slug: string }>();
  readonly members = new Map<string, { workspaceId: string; userId: string; role: string }>();
  readonly auditLog: Array<{ workspaceId?: string; userId?: string; action: string; details?: Record<string, unknown> }> = [];

  private memberKey(workspaceId: string, userId: string) {
    return `${workspaceId}:${userId}`;
  }

  async findUserByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email.toLowerCase()) ?? null;
  }

  async findUserById(id: string) {
    return this.users.get(id) ?? null;
  }

  async createUser(input: { email: string; name?: string; passwordHash?: string }) {
    const user: AuthUser = {
      id: crypto.randomUUID(),
      email: input.email.toLowerCase(),
      name: input.name ?? null,
      passwordHash: input.passwordHash ?? null,
    };
    this.users.set(user.id, user);
    return user;
  }

  async setPasswordHash(userId: string, passwordHash: string) {
    const user = this.users.get(userId);
    if (user) user.passwordHash = passwordHash;
  }

  async createWorkspace(input: { name: string; slug: string }) {
    const ws = { id: crypto.randomUUID(), name: input.name, slug: input.slug };
    this.workspaces.set(ws.id, ws);
    return ws;
  }

  async workspaceSlugExists(slug: string) {
    return [...this.workspaces.values()].some((w) => w.slug === slug);
  }

  async addMember(input: { workspaceId: string; userId: string; role: string }) {
    this.members.set(this.memberKey(input.workspaceId, input.userId), { ...input });
  }

  async getMembership(workspaceId: string, userId: string) {
    const m = this.members.get(this.memberKey(workspaceId, userId));
    return m ? { role: m.role } : null;
  }

  async listWorkspaces(userId: string) {
    return [...this.members.values()]
      .filter((m) => m.userId === userId)
      .map((m) => {
        const ws = this.workspaces.get(m.workspaceId)!;
        return { id: ws.id, name: ws.name, slug: ws.slug, role: m.role };
      });
  }

  async listMembers(workspaceId: string) {
    return [...this.members.values()]
      .filter((m) => m.workspaceId === workspaceId)
      .map((m) => {
        const user = this.users.get(m.userId)!;
        return { userId: user.id, email: user.email, name: user.name, role: m.role };
      });
  }

  async removeMember(workspaceId: string, userId: string) {
    return this.members.delete(this.memberKey(workspaceId, userId));
  }

  async audit(entry: { workspaceId?: string; userId?: string; action: string; details?: Record<string, unknown> }) {
    this.auditLog.push(entry);
  }
}

// ------------------------------------------------------------ password hashing

/** Argon2id via Bun.password (the runtime's vetted implementation). */
export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

// ------------------------------------------------------------------ sessions

export interface SessionClaims {
  userId: string;
  email: string;
}

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString("base64url");

/** Sign a session JWT (HS256). Stateless: user + expiry only, no secrets. */
export function signSessionToken(claims: SessionClaims, secret: string, now = new Date()): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const iat = Math.floor(now.getTime() / 1000);
  const payload = b64url(JSON.stringify({
    sub: claims.userId,
    email: claims.email,
    iat,
    exp: iat + SESSION_TTL_SECONDS,
  }));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/** Verify a session JWT: signature (timing-safe), alg pin, expiry. Null on any failure. */
export function verifySessionToken(token: string, secret: string, now = new Date()): SessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  let headerJson: { alg?: string };
  try {
    headerJson = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (headerJson.alg !== "HS256") return null;
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: { sub?: string; email?: string; exp?: number };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!claims.sub || !claims.email || !claims.exp) return null;
  if (claims.exp <= Math.floor(now.getTime() / 1000)) return null;
  return { userId: claims.sub, email: claims.email };
}

// -------------------------------------------------------------------- guards

/** What the auth middleware resolved for this request. */
export interface AuthContext {
  user: { id: string; email: string; name: string | null };
  /** Set when a workspace was selected AND membership verified. */
  workspaceId?: string;
  role?: string;
  /** True when context came from the BOTARA_ALLOW_HEADER_WORKSPACE dev fallback. */
  viaHeaderFallback?: boolean;
}

/** Role guard for handlers: throws FORBIDDEN unless the role is allowed. */
export function requireRole(auth: AuthContext | undefined, roles: readonly string[]): void {
  if (!auth?.role || !roles.includes(auth.role)) {
    throw new AppError(
      "FORBIDDEN",
      `This action requires one of these workspace roles: ${roles.join(", ")}.`,
      { status: 403, details: { requiredRoles: roles, actualRole: auth?.role ?? null } },
    );
  }
}

/** URL-safe slug from a display name ("Toko Kopi Pagi" -> "toko-kopi-pagi"). */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "workspace";
}
