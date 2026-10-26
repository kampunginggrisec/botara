import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError, parseApiTokenScopes } from "@botara/shared";
import {
  countPlatformAdmins, countUsers, sql,
  acceptWorkspaceInvite, createApiToken as createApiTokenRow, createUser, createWorkspace,
  createWorkspaceInvite, findApiTokenByHash, getUserByEmail, getUserById, getWorkspaceById, getWorkspaceBySlug,
  getWorkspaceInviteByHash, getWorkspaceMember, insertAuditLog, listApiTokensByUser, listWorkspaceInvites,
  listWorkspaceMembers,
  listWorkspacesForUser, removeWorkspaceMember, revokeApiToken as revokeApiTokenRow, revokeWorkspaceInvite,
  setUserPasswordHash, setUserPlatformAdmin, touchApiToken, touchUserLastLogin,
  transferWorkspaceOwnership,
  updateUserName, updateWorkspaceDefaultCurrency, updateWorkspaceName, updateWorkspaceReplyTarget,
  upsertWorkspaceMember,
  type AcceptWorkspaceInviteOutcome, type Database, type WorkspaceInviteRow,
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
  /** Platform operator flag (admin panel) - NOT a workspace role. */
  isPlatformAdmin: boolean;
}

export interface AuthWorkspaceView {
  id: string;
  name: string;
  slug: string;
  /** Workspace default currency (package #6) - the deal form's preset. */
  defaultCurrency: string;
  /** Workspace reply target in minutes (package #8) - the insights service goal. */
  replyTargetMinutes: number;
  role: string;
}

export interface AuthMemberView {
  userId: string;
  email: string;
  name: string | null;
  role: string;
}

/**
 * One invite-by-link record (#9), dates as Date so the state classifier
 * in invites.ts can work on it directly; the HTTP layer serializes.
 * Carries the token HASH internally - the raw token never persists.
 */
export interface WorkspaceInviteRecord {
  id: string;
  workspaceId: string;
  tokenHash: string;
  prefix: string;
  role: string;
  createdByUserId: string;
  expiresAt: Date | null;
  maxUses: number | null;
  usesCount: number;
  revokedAt: Date | null;
  createdAt: Date;
}

/** Result of an invite accept attempt - the repository's outcome union, re-exported for handlers. */
export type AcceptInviteOutcome = AcceptWorkspaceInviteOutcome;

/** Metadata view of a personal API token - never carries the raw token. */
export interface ApiTokenView {
  id: string;
  name: string;
  /** Non-secret display fragment, e.g. "bta_AbCd1234". */
  prefix: string;
  /** Scoped tokens (#5): bound workspace id; null = any of the user's workspaces. */
  workspaceId: string | null;
  /** Scoped tokens (#5): granted scopes; null = unrestricted (legacy). */
  scopes: string[] | null;
  /** Scoped tokens (#5): ISO expiry; null = never expires. */
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Optional restrictions for a newly minted token (#5). All default to legacy NULLs. */
export interface CreateApiTokenOptions {
  workspaceId?: string | null;
  scopes?: string[] | null;
  expiresAt?: Date | null;
}

/**
 * What a presented token grants, resolved at authentication time (#5).
 * `scopes: null` means the legacy unrestricted grant; a non-null list is
 * enforced against the route's required scope. `workspaceId` binds the
 * token to one workspace. Expiry is NOT part of enforcement here - an
 * expired token never resolves to "ok" (see ApiTokenResolution).
 */
export interface ApiTokenGrant {
  tokenId: string;
  workspaceId: string | null;
  scopes: string[] | null;
  expiresAt: string | null;
}

/** Discriminated result of resolving a presented `bta_...` token. */
export type ApiTokenResolution =
  | { status: "ok"; user: AuthUser; grant: ApiTokenGrant }
  | { status: "expired"; grant: ApiTokenGrant }
  | { status: "invalid" };

export const API_TOKEN_PREFIX = "bta_";

/** Mint a raw API token: `bta_` + 256 bits of base64url randomness. */
export function generateApiToken(): string {
  return API_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** The only persisted form of a token: its SHA-256 hex digest. */
export function hashApiToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Display fragment stored alongside the hash (not a secret). */
export function apiTokenDisplayPrefix(raw: string): string {
  return raw.slice(0, API_TOKEN_PREFIX.length + 8);
}

/** Everything the auth + workspace handlers need from persistence. */
export interface AuthStore {
  findUserByEmail(email: string): Promise<AuthUser | null>;
  findUserById(id: string): Promise<AuthUser | null>;
  createUser(input: { email: string; name?: string; passwordHash?: string; isPlatformAdmin?: boolean }): Promise<AuthUser>;
  setPasswordHash(userId: string, passwordHash: string): Promise<void>;
  /** Platform admin (operator panel): bootstrap counting + flag management. */
  countUsers(): Promise<number>;
  countPlatformAdmins(): Promise<number>;
  /** Grant/revoke the platform-admin flag; false when the user does not exist. */
  setPlatformAdmin(userId: string, grant: boolean): Promise<boolean>;
  /** Stamp a successful login (drives "active users" in the admin panel). */
  touchLastLogin(userId: string): Promise<void>;
  createWorkspace(input: { name: string; slug: string }): Promise<{ id: string; name: string; slug: string }>;
  workspaceSlugExists(slug: string): Promise<boolean>;
  addMember(input: { workspaceId: string; userId: string; role: string }): Promise<void>;
  getMembership(workspaceId: string, userId: string): Promise<{ role: string } | null>;
  listWorkspaces(userId: string): Promise<AuthWorkspaceView[]>;
  listMembers(workspaceId: string): Promise<AuthMemberView[]>;
  removeMember(workspaceId: string, userId: string): Promise<boolean>;
  /** Settings (Fase 4): profile display name + workspace rename. */
  updateUserName(userId: string, name: string): Promise<void>;
  renameWorkspace(workspaceId: string, name: string): Promise<void>;
  /** Workspace default currency (package #6). */
  updateWorkspaceCurrency(workspaceId: string, currency: string): Promise<void>;
  /** Workspace reply target in minutes (package #8). */
  updateWorkspaceReplyTarget(workspaceId: string, minutes: number): Promise<void>;
  /** API tokens (adopted features): create returns the raw token ONCE. */
  createApiToken(userId: string, name: string, options?: CreateApiTokenOptions): Promise<{ raw: string; token: ApiTokenView }>;
  listApiTokens(userId: string): Promise<ApiTokenView[]>;
  revokeApiToken(userId: string, id: string): Promise<boolean>;
  /** Resolve a presented `bta_...` token to its user (null when unknown/revoked). */
  findUserByApiToken(rawToken: string): Promise<AuthUser | null>;
  /**
   * Full token resolution (#5): user + grant for a valid token, a
   * distinct "expired" for a past-expiry token, "invalid" otherwise
   * (unknown hash, revoked, or the owning user no longer exists).
   */
  resolveApiToken(rawToken: string): Promise<ApiTokenResolution>;
  /** Invite-by-link (#9): mint a link for a workspace (hash stored, raw never persisted here). */
  createInvite(input: {
    workspaceId: string;
    tokenHash: string;
    prefix: string;
    role: string;
    createdByUserId: string;
    expiresAt?: Date | null;
    maxUses?: number | null;
  }): Promise<WorkspaceInviteRecord>;
  listInvites(workspaceId: string): Promise<WorkspaceInviteRecord[]>;
  revokeInvite(workspaceId: string, inviteId: string): Promise<"revoked" | "already" | "missing">;
  /** Preview + accept lookup by token hash; carries the workspace's public name/slug. */
  findInviteByHash(tokenHash: string): Promise<(WorkspaceInviteRecord & { workspaceName: string; workspaceSlug: string }) | null>;
  /**
   * Atomically consume one use and add the member. An already-member
   * outcome never consumes a use; the last use cannot be double-spent.
   */
  acceptInvite(invite: WorkspaceInviteRecord, userId: string): Promise<AcceptInviteOutcome>;
  /**
   * Ownership transfer (#9): atomically make `toUserId` the owner and
   * demote every other owner (incl. the caller) to admin. False when
   * the caller is not the owner or the target is not a member.
   */
  transferOwnership(workspaceId: string, fromUserId: string, toUserId: string): Promise<boolean>;
  audit(entry: {
    workspaceId?: string;
    userId?: string;
    action: string;
    details?: Record<string, unknown>;
  }): Promise<void>;
}

const toAuthUser = (row: {
  id: string; email: string; name: string | null; passwordHash: string | null; isPlatformAdmin: boolean;
}): AuthUser => ({
  id: row.id, email: row.email, name: row.name, passwordHash: row.passwordHash,
  isPlatformAdmin: row.isPlatformAdmin,
});

/** Shape of an api_tokens row as the stores consume it (Db + in-memory share the mapping). */
interface ApiTokenRowLike {
  id: string;
  name: string;
  prefix: string;
  workspaceId: string | null;
  scopes: string[] | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

const toApiTokenView = (row: ApiTokenRowLike): ApiTokenView => ({
  id: row.id, name: row.name, prefix: row.prefix,
  workspaceId: row.workspaceId ?? null,
  scopes: row.scopes ?? null,
  expiresAt: row.expiresAt?.toISOString() ?? null,
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/** workspace_invites row -> the store-level record (dates stay Dates). */
const toInviteRecord = (row: WorkspaceInviteRow): WorkspaceInviteRecord => ({
  id: row.id,
  workspaceId: row.workspaceId,
  tokenHash: row.tokenHash,
  prefix: row.prefix,
  role: row.role,
  createdByUserId: row.createdByUserId,
  expiresAt: row.expiresAt ?? null,
  maxUses: row.maxUses ?? null,
  usesCount: row.usesCount,
  revokedAt: row.revokedAt ?? null,
  createdAt: row.createdAt,
});

/** Inverse of toInviteRecord for the repository accept call. */
const toInviteRow = (record: WorkspaceInviteRecord): WorkspaceInviteRow => ({
  ...record,
});

/**
 * Row -> grant. Stored scopes are validated against the taxonomy; a
 * corrupt stored list fails CLOSED (restricted, grants nothing) instead
 * of silently widening to the legacy unrestricted grant.
 */
const toApiTokenGrant = (row: ApiTokenRowLike): ApiTokenGrant => ({
  tokenId: row.id,
  workspaceId: row.workspaceId ?? null,
  scopes: row.scopes == null ? null : (parseApiTokenScopes(row.scopes) ?? []),
  expiresAt: row.expiresAt?.toISOString() ?? null,
});

/** Production AuthStore over the Drizzle repositories. */
export class DbAuthStore implements AuthStore {
  constructor(private readonly getDatabase: () => Database) {}

  async findUserByEmail(email: string) {
    const row = await getUserByEmail(this.getDatabase(), email);
    return row ? toAuthUser(row) : null;
  }

  async findUserById(id: string) {
    const row = await getUserById(this.getDatabase(), id);
    return row ? toAuthUser(row) : null;
  }

  async createUser(input: { email: string; name?: string; passwordHash?: string; isPlatformAdmin?: boolean }) {
    const db = this.getDatabase();
    if (!input.isPlatformAdmin) {
      return toAuthUser(await createUser(db, input));
    }
    /**
     * Platform-admin bootstrap must be ATOMIC: two concurrent first
     * registrations must not both observe an empty users table. The
     * insert runs in a transaction behind a fixed advisory lock, and the
     * empty-table check is repeated inside the lock - the flag is only
     * granted when the table is still empty at insert time.
     */
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(727271)`);
      const txDb = tx as unknown as Database;
      const total = await countUsers(txDb);
      const row = await createUser(txDb, { ...input, isPlatformAdmin: total === 0 });
      return toAuthUser(row);
    });
  }

  async countUsers() {
    return countUsers(this.getDatabase());
  }

  async countPlatformAdmins() {
    return countPlatformAdmins(this.getDatabase());
  }

  async setPlatformAdmin(userId: string, grant: boolean) {
    const row = await setUserPlatformAdmin(this.getDatabase(), userId, grant);
    return row !== null;
  }

  async touchLastLogin(userId: string) {
    await touchUserLastLogin(this.getDatabase(), userId, new Date());
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
    return rows.map((r) => ({
      id: r.workspaceId, name: r.workspaceName, slug: r.slug,
      defaultCurrency: r.defaultCurrency, replyTargetMinutes: r.replyTargetMinutes ?? 60, role: r.role,
    }));
  }

  async listMembers(workspaceId: string) {
    const rows = await listWorkspaceMembers(this.getDatabase(), workspaceId);
    return rows.map((r) => ({ userId: r.userId, email: r.email, name: r.name, role: r.role }));
  }

  async removeMember(workspaceId: string, userId: string) {
    return removeWorkspaceMember(this.getDatabase(), workspaceId, userId);
  }

  async updateUserName(userId: string, name: string) {
    await updateUserName(this.getDatabase(), userId, name);
  }

  async renameWorkspace(workspaceId: string, name: string) {
    await updateWorkspaceName(this.getDatabase(), workspaceId, name);
  }

  async updateWorkspaceCurrency(workspaceId: string, currency: string) {
    await updateWorkspaceDefaultCurrency(this.getDatabase(), workspaceId, currency);
  }

  async updateWorkspaceReplyTarget(workspaceId: string, minutes: number) {
    await updateWorkspaceReplyTarget(this.getDatabase(), workspaceId, minutes);
  }

  async createApiToken(userId: string, name: string, options: CreateApiTokenOptions = {}) {
    const raw = generateApiToken();
    const row = await createApiTokenRow(this.getDatabase(), {
      userId,
      name,
      tokenHash: hashApiToken(raw),
      prefix: apiTokenDisplayPrefix(raw),
      workspaceId: options.workspaceId ?? null,
      scopes: options.scopes ?? null,
      expiresAt: options.expiresAt ?? null,
    });
    return { raw, token: toApiTokenView(row) };
  }

  async listApiTokens(userId: string) {
    const rows = await listApiTokensByUser(this.getDatabase(), userId);
    return rows.map(toApiTokenView);
  }

  async revokeApiToken(userId: string, id: string) {
    return revokeApiTokenRow(this.getDatabase(), userId, id);
  }

  async resolveApiToken(rawToken: string): Promise<ApiTokenResolution> {
    const db = this.getDatabase();
    const row = await findApiTokenByHash(db, hashApiToken(rawToken));
    if (!row) return { status: "invalid" };
    const grant = toApiTokenGrant(row);
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      return { status: "expired", grant };
    }
    const user = await getUserById(db, row.userId);
    if (!user) return { status: "invalid" };
    // Best-effort usage stamp - a failed stamp must never fail auth.
    await touchApiToken(db, row.id, new Date()).catch(() => undefined);
    return { status: "ok", user: toAuthUser(user), grant };
  }

  async findUserByApiToken(rawToken: string) {
    const resolution = await this.resolveApiToken(rawToken);
    return resolution.status === "ok" ? resolution.user : null;
  }

  async createInvite(input: {
    workspaceId: string;
    tokenHash: string;
    prefix: string;
    role: string;
    createdByUserId: string;
    expiresAt?: Date | null;
    maxUses?: number | null;
  }) {
    const row = await createWorkspaceInvite(this.getDatabase(), input);
    return toInviteRecord(row);
  }

  async listInvites(workspaceId: string) {
    const rows = await listWorkspaceInvites(this.getDatabase(), workspaceId);
    return rows.map(toInviteRecord);
  }

  async revokeInvite(workspaceId: string, inviteId: string) {
    return revokeWorkspaceInvite(this.getDatabase(), workspaceId, inviteId);
  }

  async findInviteByHash(tokenHash: string) {
    const db = this.getDatabase();
    const row = await getWorkspaceInviteByHash(db, tokenHash);
    if (!row) return null;
    const workspace = await getWorkspaceById(db, row.workspaceId);
    if (!workspace) return null;
    return { ...toInviteRecord(row), workspaceName: workspace.name, workspaceSlug: workspace.slug };
  }

  async acceptInvite(invite: WorkspaceInviteRecord, userId: string) {
    return acceptWorkspaceInvite(this.getDatabase(), toInviteRow(invite), userId);
  }

  async transferOwnership(workspaceId: string, fromUserId: string, toUserId: string) {
    return transferWorkspaceOwnership(this.getDatabase(), workspaceId, fromUserId, toUserId);
  }

  async audit(entry: { workspaceId?: string; userId?: string; action: string; details?: Record<string, unknown> }) {
    await insertAuditLog(this.getDatabase(), entry);
  }
}

/** In-memory AuthStore for tests (and only tests). */
export class InMemoryAuthStore implements AuthStore {
  readonly users = new Map<string, AuthUser>();
  readonly workspaces = new Map<string, { id: string; name: string; slug: string; defaultCurrency: string; replyTargetMinutes: number }>();
  readonly members = new Map<string, { workspaceId: string; userId: string; role: string }>();
  readonly auditLog: Array<{ workspaceId?: string; userId?: string; action: string; details?: Record<string, unknown> }> = [];
  readonly apiTokens = new Map<string, ApiTokenView & { userId: string; tokenHash: string }>();
  readonly invites = new Map<string, WorkspaceInviteRecord>();
  readonly lastLogins = new Map<string, Date>();

  private memberKey(workspaceId: string, userId: string) {
    return `${workspaceId}:${userId}`;
  }

  async findUserByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email.toLowerCase()) ?? null;
  }

  async findUserById(id: string) {
    return this.users.get(id) ?? null;
  }

  async createUser(input: { email: string; name?: string; passwordHash?: string; isPlatformAdmin?: boolean }) {
    const user: AuthUser = {
      id: crypto.randomUUID(),
      email: input.email.toLowerCase(),
      name: input.name ?? null,
      passwordHash: input.passwordHash ?? null,
      // Mirror the DB store: the bootstrap flag only lands on an empty table.
      isPlatformAdmin: (input.isPlatformAdmin ?? false) && this.users.size === 0,
    };
    this.users.set(user.id, user);
    return user;
  }

  async countUsers() {
    return this.users.size;
  }

  async countPlatformAdmins() {
    return [...this.users.values()].filter((u) => u.isPlatformAdmin).length;
  }

  async setPlatformAdmin(userId: string, grant: boolean) {
    const user = this.users.get(userId);
    if (!user) return false;
    user.isPlatformAdmin = grant;
    return true;
  }

  async touchLastLogin(userId: string) {
    this.lastLogins.set(userId, new Date());
  }

  async setPasswordHash(userId: string, passwordHash: string) {
    const user = this.users.get(userId);
    if (user) user.passwordHash = passwordHash;
  }

  async createWorkspace(input: { name: string; slug: string }) {
    const ws = { id: crypto.randomUUID(), name: input.name, slug: input.slug, defaultCurrency: "IDR", replyTargetMinutes: 60 };
    this.workspaces.set(ws.id, ws);
    return { id: ws.id, name: ws.name, slug: ws.slug };
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
        return { id: ws.id, name: ws.name, slug: ws.slug, defaultCurrency: ws.defaultCurrency, replyTargetMinutes: ws.replyTargetMinutes ?? 60, role: m.role };
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

  async updateUserName(userId: string, name: string) {
    const user = this.users.get(userId);
    if (user) user.name = name;
  }

  async renameWorkspace(workspaceId: string, name: string) {
    const ws = this.workspaces.get(workspaceId);
    if (ws) ws.name = name;
  }

  async updateWorkspaceCurrency(workspaceId: string, currency: string) {
    const ws = this.workspaces.get(workspaceId);
    if (ws) ws.defaultCurrency = currency;
  }

  async updateWorkspaceReplyTarget(workspaceId: string, minutes: number) {
    const ws = this.workspaces.get(workspaceId);
    if (ws) ws.replyTargetMinutes = minutes;
  }

  async audit(entry: { workspaceId?: string; userId?: string; action: string; details?: Record<string, unknown> }) {
    this.auditLog.push(entry);
  }

  async createApiToken(userId: string, name: string, options: CreateApiTokenOptions = {}) {
    const raw = generateApiToken();
    const token: ApiTokenView & { userId: string; tokenHash: string } = {
      id: crypto.randomUUID(),
      userId,
      name,
      prefix: apiTokenDisplayPrefix(raw),
      tokenHash: hashApiToken(raw),
      workspaceId: options.workspaceId ?? null,
      scopes: options.scopes ? [...options.scopes] : null,
      expiresAt: options.expiresAt?.toISOString() ?? null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.apiTokens.set(token.id, token);
    const { userId: _userId, tokenHash: _hash, ...view } = token;
    return { raw, token: view };
  }

  async listApiTokens(userId: string) {
    return [...this.apiTokens.values()]
      .filter((tk) => tk.userId === userId)
      .map(({ userId: _userId, tokenHash: _hash, ...view }) => view);
  }

  async revokeApiToken(userId: string, id: string) {
    const token = this.apiTokens.get(id);
    if (!token || token.userId !== userId || token.revokedAt) return false;
    token.revokedAt = new Date().toISOString();
    return true;
  }

  async resolveApiToken(rawToken: string): Promise<ApiTokenResolution> {
    const hash = hashApiToken(rawToken);
    const token = [...this.apiTokens.values()].find((tk) => tk.tokenHash === hash && !tk.revokedAt);
    if (!token) return { status: "invalid" };
    const grant: ApiTokenGrant = {
      tokenId: token.id,
      workspaceId: token.workspaceId,
      scopes: token.scopes ? [...token.scopes] : null,
      expiresAt: token.expiresAt,
    };
    if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) {
      return { status: "expired", grant };
    }
    const user = this.users.get(token.userId);
    if (!user) return { status: "invalid" };
    token.lastUsedAt = new Date().toISOString();
    return { status: "ok", user, grant };
  }

  async findUserByApiToken(rawToken: string) {
    const resolution = await this.resolveApiToken(rawToken);
    return resolution.status === "ok" ? resolution.user : null;
  }

  async createInvite(input: {
    workspaceId: string;
    tokenHash: string;
    prefix: string;
    role: string;
    createdByUserId: string;
    expiresAt?: Date | null;
    maxUses?: number | null;
  }) {
    const invite: WorkspaceInviteRecord = {
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      tokenHash: input.tokenHash,
      prefix: input.prefix,
      role: input.role,
      createdByUserId: input.createdByUserId,
      expiresAt: input.expiresAt ?? null,
      maxUses: input.maxUses ?? null,
      usesCount: 0,
      revokedAt: null,
      createdAt: new Date(),
    };
    this.invites.set(invite.id, invite);
    return invite;
  }

  async listInvites(workspaceId: string) {
    return [...this.invites.values()]
      .filter((i) => i.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async revokeInvite(workspaceId: string, inviteId: string) {
    const invite = this.invites.get(inviteId);
    if (!invite || invite.workspaceId !== workspaceId) return "missing" as const;
    if (invite.revokedAt) return "already" as const;
    invite.revokedAt = new Date();
    return "revoked" as const;
  }

  async findInviteByHash(tokenHash: string) {
    const invite = [...this.invites.values()].find((i) => i.tokenHash === tokenHash);
    if (!invite) return null;
    const workspace = this.workspaces.get(invite.workspaceId);
    if (!workspace) return null;
    return { ...invite, workspaceName: workspace.name, workspaceSlug: workspace.slug };
  }

  async acceptInvite(invite: WorkspaceInviteRecord, userId: string) {
    // Mirror of the repository's transactional accept. This body is
    // deliberately await-free: the membership check, the use
    // consumption and the member insert all happen in one synchronous
    // run, so two raced accepts cannot both spend the last use.
    const live = this.invites.get(invite.id);
    if (!live) return { status: "missing" as const };
    if (this.members.has(this.memberKey(live.workspaceId, userId))) {
      return { status: "already_member" as const };
    }
    const now = new Date();
    if (live.revokedAt) return { status: "revoked" as const };
    if (live.expiresAt && live.expiresAt.getTime() <= now.getTime()) return { status: "expired" as const };
    if (live.maxUses !== null && live.usesCount >= live.maxUses) return { status: "exhausted" as const };
    live.usesCount += 1;
    this.members.set(this.memberKey(live.workspaceId, userId), {
      workspaceId: live.workspaceId, userId, role: live.role,
    });
    return { status: "accepted" as const, role: live.role };
  }

  async transferOwnership(workspaceId: string, fromUserId: string, toUserId: string) {
    const from = this.members.get(this.memberKey(workspaceId, fromUserId));
    const to = this.members.get(this.memberKey(workspaceId, toUserId));
    if (!from || from.role !== "owner" || !to) return false;
    for (const m of this.members.values()) {
      if (m.workspaceId === workspaceId && m.role === "owner") m.role = "admin";
    }
    to.role = "owner";
    return true;
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
  /**
   * Set when the request authenticated with an API token (#5): the
   * token's grant. Absent for session JWTs - sessions are never
   * scope-limited. Enforcement lives in app.ts (route scope map).
   */
  apiToken?: ApiTokenGrant;
}

/**
 * Platform-operator guard for /admin handlers: throws FORBIDDEN unless
 * the authenticated user carries the platform-admin flag. Unauthenticated
 * callers never reach this - authenticateRequest throws 401 first.
 */
export function requirePlatformAdmin(user: AuthUser | undefined): void {
  if (!user?.isPlatformAdmin) {
    throw new AppError(
      "FORBIDDEN",
      "This area is restricted to platform administrators.",
      { status: 403 },
    );
  }
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
