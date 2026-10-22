import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { AppError, evaluateReplyWindow, MessagingWindowClosedError } from "@botara/shared";
import {
  getDb, listContacts, createContact, updateContact, segmentCounts,
  listConversations, getConversation, listMessages, createMessage, updateMessageStatus,
  touchConversationLastUserMessage,
  listTemplates, createTemplate, updateTemplateLatestCategory,
  createBroadcast, getBroadcast, updateBroadcastStatus, sumCostLedgerByReference,
  getChannelAccount, getTemplate, listChannelAccounts, createChannelAccount,
  applyTemplateCategoryChange,
  findOrCreateWebchatAccount, createConversation as createConversationRow,
  createWebchatSession, getWebchatSessionByToken, touchWebchatSession,
  createScheduledPost, listScheduledPosts, getScheduledPost, updateScheduledPost, deleteScheduledPost,
  createSequence, listSequences, getSequence, updateSequence, createEnrollment,
  createTokenVault, insertAuditLog, pingDb,
  findWorkspaceDomain, findEmailAccountForWorkspace,
  createWorkspaceDomain, listWorkspaceDomains, deleteWorkspaceDomain,
  createDataDeletionRequest, getDataDeletionRequestByCode, completeDataDeletionRequest,
  purgeExternalUserData,
  createKbDocument, listKbDocuments, getKbDocument, deleteKbDocument, listKbChunksByWorkspace,
  type Database, type ScheduledPostTarget, type SequenceStep,
} from "@botara/db";
import {
  getAdapter, verifyWebhookChallenge, verifyWebhookSignature, verifyResendWebhookSignature,
  WebchatAdapter, CHANNEL_CAPABILITIES,
  type ChannelKey, type InboundEvent,
} from "@botara/channels";
import {
  ADMIN_ROLES, MUTATOR_ROLES, ROLES, SESSION_COOKIE, SESSION_TTL_SECONDS,
  DbAuthStore, hashPassword, requireRole, signSessionToken, slugify, verifyPassword,
  verifySessionToken,
  type AuthContext, type AuthStore, type AuthUser,
} from "./auth";
import { estimateBroadcastCost, type WhatsAppCategory } from "@botara/billing";
import {
  createAIProviderFromEnv, moderateText, DEFAULT_AI_MODEL, type AIProvider,
} from "@botara/ai";
import {
  InMemoryVault, exchangeEmbeddedSignup,
  type EmbeddedSignupInput, type EmbeddedSignupResult, type TokenVaultPort,
} from "./whatsapp-onboarding";
import { createDbWebchatStore } from "./webchat-store";

/**
 * Botara API - Fase 3.
 *
 * AUTHENTICATION (Fase 3, replaces the Fase 1 stand-in): users register and
 * log in with email + password; the session is a signed JWT (HS256,
 * SESSION_SECRET) delivered as an httpOnly cookie and accepted as a Bearer
 * token. The X-Workspace-Id header now only SELECTS the workspace - the
 * auth middleware verifies the caller's membership + role on every
 * request (see ./auth.ts). The old header-only mode survives solely as an
 * explicit dev fallback behind BOTARA_ALLOW_HEADER_WORKSPACE=1 (default
 * off). Public surfaces stay public by design: /webhooks/* (provider
 * signatures), /public/webchat/* (visitor session tokens), /health*,
 * /broadcasts/estimate and /moderation/check (pure calculators over the
 * request body - no workspace data), /data-deletion/status/* (Meta status
 * pages), and the /auth/* entry points themselves.
 *
 * Error contract: every error response is the shared AppError taxonomy
 * serialized as { error: { code, message, details? } }.
 */

// ------------------------------------------------------------ dependencies

/** Where parsed webhook events go. Fase 1 default: structured log sink. */
export interface WebhookEventSink {
  handle(events: InboundEvent[]): Promise<void>;
}

export const logEventSink: WebhookEventSink = {
  async handle(events) {
    for (const event of events) {
      console.log(`[api] webhook event: ${event.type} (${event.channel})`);
    }
  },
};

/** Enqueues a broadcast fan-out job for the worker. */
export interface BroadcastEnqueuer {
  enqueueBroadcast(broadcastId: string): Promise<void>;
}

/** Enqueues a publish job for one scheduled post. */
export interface PublishEnqueuer {
  enqueuePublish(postId: string): Promise<void>;
}

/**
 * Applies a WhatsApp template category-change event to the templates table
 * (latest_category + messaging account id). A port so webhook tests can use
 * a fake repository instead of a live Postgres.
 */
export interface TemplateCategoryUpdater {
  applyCategoryChange(event: Extract<InboundEvent, { type: "template.category_changed" }>): Promise<void>;
}

/** Enqueues an email-inbound job (worker "email" queue) for a routed Resend webhook. */
export interface EmailInboundEnqueuer {
  enqueueEmailInbound(input: { workspaceId: string; channelAccountId: string; emailId: string }): Promise<void>;
}

/** Resolves a recipient domain to its workspace + email channel account. */
export interface EmailRouter {
  resolveRecipientDomain(domain: string): Promise<{ workspaceId: string; channelAccountId: string } | null>;
}

/** Meta data-deletion persistence + user-data purge. */
export interface DataDeletionStore {
  create(input: { confirmationCode: string; providerUserId: string }): Promise<void>;
  getByCode(code: string): Promise<{ confirmationCode: string; status: string; createdAt: string } | null>;
  complete(code: string): Promise<void>;
  purge(providerUserId: string): Promise<{ contacts: number }>;
}

/** Enqueues a kb-ingest job (worker "kb" queue) for a new knowledge-base document. */
export interface KbEnqueuer {
  enqueueKbIngest(documentId: string): Promise<void>;
}

export interface DependencyStatus {
  ok: boolean;
  detail?: string;
}

/** Dependency probes behind GET /health/ready. */
export interface ReadinessChecker {
  checkDatabase(): Promise<DependencyStatus>;
  checkRedis(): Promise<DependencyStatus>;
}

export interface ApiDeps {
  /** Returns the DB or throws AppError CONFIGURATION (503) when unconfigured. */
  getDatabase: () => Database;
  eventSink: WebhookEventSink;
  broadcastEnqueuer: BroadcastEnqueuer;
  publishEnqueuer: PublishEnqueuer;
  templateCategoryUpdater: TemplateCategoryUpdater;
  /** Embedded Signup v4 code exchange (Graph calls + vault + persistence). */
  whatsappOnboarding: (workspaceId: string, input: EmbeddedSignupInput) => Promise<EmbeddedSignupResult>;
  /** The configured AI provider, or null - routes answer 503, never fake. */
  getAiProvider: () => AIProvider | null;
  /** Fase 3: users, workspaces, memberships, audit (auth persistence). */
  authStore: AuthStore;
  /** Fase 3: Resend inbound routing + enqueueing. */
  emailInboundEnqueuer: EmailInboundEnqueuer;
  emailRouter: EmailRouter;
  /** Fase 3: Meta data-deletion callback store. */
  dataDeletionStore: DataDeletionStore;
  /** Fase 3: knowledge-base ingestion enqueueing. */
  kbEnqueuer: KbEnqueuer;
  /** Fase 3: readiness probes for /health/ready. */
  readiness: ReadinessChecker;
  /** Fase 3: in-process rate-limit overrides (tests use tiny limits). */
  rateLimits?: { authPerMinute?: number; publicPerMinute?: number };
  env: Record<string, string | undefined>;
}

export function defaultGetDatabase(): Database {
  if (!process.env.DATABASE_URL) {
    throw new AppError(
      "CONFIGURATION",
      "DATABASE_URL is not configured on this server; database-backed routes are unavailable.",
      { status: 503 },
    );
  }
  return getDb(process.env.DATABASE_URL);
}

/** BullMQ job ids cannot contain ":" - the canonical key is sanitized for jobId use only. */
const jobIdFor = (idempotencyKey: string) => idempotencyKey.replace(/:/g, "_");

/**
 * Generic BullMQ enqueuer: fails fast and honestly - when Redis is
 * unreachable the caller gets a 503, never a fake success.
 */
export function createBullMqEnqueuer(
  redisUrl: string,
  queueName: string,
  jobName: string,
): { enqueue(data: Record<string, unknown>, jobId: string): Promise<void> } {
  return {
    async enqueue(data: Record<string, unknown>, jobId: string): Promise<void> {
      const connection = new IORedis(redisUrl, {
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      });
      connection.on("error", () => { /* surfaced via the raced add() below */ });
      const queue = new Queue(queueName, { connection });
      try {
        const add = queue.add(jobName, data, { jobId: jobIdFor(jobId) });
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("redis enqueue timed out")), 3000),
        );
        await Promise.race([add, timeout]);
      } catch (err) {
        throw new AppError(
          "CONFIGURATION",
          `${queueName} queue (Redis) is unavailable: ${err instanceof Error ? err.message : String(err)}`,
          { status: 503 },
        );
      } finally {
        await queue.close().catch(() => undefined);
        connection.disconnect();
      }
    },
  };
}

/** Production broadcast enqueuer: BullMQ on Redis. */
export function createBullMqBroadcastEnqueuer(redisUrl: string): BroadcastEnqueuer {
  const inner = createBullMqEnqueuer(redisUrl, "broadcast", "broadcast");
  return {
    enqueueBroadcast: (broadcastId) => inner.enqueue({ broadcastId }, `broadcast:${broadcastId}`),
  };
}

export function createBullMqPublishEnqueuer(redisUrl: string): PublishEnqueuer {
  const inner = createBullMqEnqueuer(redisUrl, "publish", "publish");
  return {
    enqueuePublish: (postId) => inner.enqueue({ postId }, `publish:${postId}`),
  };
}

/** Production email-inbound enqueuer: BullMQ "email" queue, job "inbound". */
export function createBullMqEmailEnqueuer(redisUrl: string): EmailInboundEnqueuer {
  const inner = createBullMqEnqueuer(redisUrl, "email", "inbound");
  return {
    enqueueEmailInbound: (input) => inner.enqueue({ ...input }, `email-inbound:${input.emailId}`),
  };
}

/** Production kb-ingest enqueuer: BullMQ "kb" queue, job "ingest". */
export function createBullMqKbEnqueuer(redisUrl: string): KbEnqueuer {
  const inner = createBullMqEnqueuer(redisUrl, "kb", "ingest");
  return {
    enqueueKbIngest: (documentId) => inner.enqueue({ documentId }, `kb-ingest:${documentId}`),
  };
}

/** DB-backed recipient-domain router for Resend inbound webhooks. */
export function createDbEmailRouter(getDatabase: () => Database): EmailRouter {
  return {
    async resolveRecipientDomain(domain) {
      const db = getDatabase();
      const row = await findWorkspaceDomain(db, domain);
      if (!row) return null;
      const accountId = row.channelAccountId
        ?? (await findEmailAccountForWorkspace(db, row.workspaceId))?.id;
      if (!accountId) return null;
      return { workspaceId: row.workspaceId, channelAccountId: accountId };
    },
  };
}

/** DB-backed Meta data-deletion store. */
export function createDbDataDeletionStore(getDatabase: () => Database): DataDeletionStore {
  return {
    async create(input) {
      await createDataDeletionRequest(getDatabase(), input);
    },
    async getByCode(code) {
      const row = await getDataDeletionRequestByCode(getDatabase(), code);
      return row
        ? { confirmationCode: row.confirmationCode, status: row.status, createdAt: row.createdAt.toISOString() }
        : null;
    },
    async complete(code) {
      await completeDataDeletionRequest(getDatabase(), code);
    },
    async purge(providerUserId) {
      return purgeExternalUserData(getDatabase(), providerUserId);
    },
  };
}

async function pingRedis(redisUrl: string): Promise<DependencyStatus> {
  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: 1500,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  connection.on("error", () => { /* surfaced via the raced ping below */ });
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("redis ping timed out")), 2000),
    );
    const res = await Promise.race([connection.ping(), timeout]);
    return res === "PONG"
      ? { ok: true }
      : { ok: false, detail: `unexpected PING response: ${String(res)}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    connection.disconnect();
  }
}

/** Production readiness probes: a real SELECT 1 + a real Redis PING. */
export function createReadinessChecker(
  getDatabase: () => Database,
  redisUrl: string,
): ReadinessChecker {
  return {
    async checkDatabase() {
      try {
        await pingDb(getDatabase());
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
    checkRedis: () => pingRedis(redisUrl),
  };
}

/**
 * Default onboarding vault (Fase 3): the REAL encrypted TokenVault when
 * both DATABASE_URL and TOKEN_VAULT_KEY are configured - resolution is lazy
 * so a malformed key surfaces as a CONFIGURATION error on first use, not a
 * boot crash. The in-memory vault remains only as the no-DB dev fallback.
 */
export function createDefaultVault(): TokenVaultPort {
  const memory = new InMemoryVault();
  let real: { store: TokenVaultPort["store"] } | null | undefined;
  const resolveReal = () => {
    if (real !== undefined) return real;
    if (process.env.DATABASE_URL && process.env.TOKEN_VAULT_KEY) {
      const db = defaultGetDatabase();
      const vault = createTokenVault(db, process.env, {
        write: async (entry) => { await insertAuditLog(db, entry); },
      });
      real = { store: (input) => vault.store(input) };
    } else {
      real = null;
    }
    return real;
  };
  return {
    async store(input) {
      const vault = resolveReal();
      return vault ? vault.store(input) : memory.store(input);
    },
  };
}

/** Default template-category updater: the Drizzle repository behind the DB getter. */
export function createDbTemplateCategoryUpdater(getDatabase: () => Database): TemplateCategoryUpdater {
  return {
    async applyCategoryChange(event) {
      const db = getDatabase();
      await applyTemplateCategoryChange(db, {
        templateExternalId: event.templateExternalId,
        templateName: event.templateName,
        newCategory: event.newCategory,
        messagingAccountId: event.accountExternalId,
      });
    },
  };
}

export function defaultDeps(): ApiDeps {
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const vault = createDefaultVault();
  return {
    getDatabase: defaultGetDatabase,
    eventSink: logEventSink,
    broadcastEnqueuer: createBullMqBroadcastEnqueuer(redisUrl),
    publishEnqueuer: createBullMqPublishEnqueuer(redisUrl),
    templateCategoryUpdater: createDbTemplateCategoryUpdater(defaultGetDatabase),
    authStore: new DbAuthStore(defaultGetDatabase),
    emailInboundEnqueuer: createBullMqEmailEnqueuer(redisUrl),
    emailRouter: createDbEmailRouter(defaultGetDatabase),
    dataDeletionStore: createDbDataDeletionStore(defaultGetDatabase),
    kbEnqueuer: createBullMqKbEnqueuer(redisUrl),
    readiness: createReadinessChecker(defaultGetDatabase, redisUrl),
    whatsappOnboarding: (workspaceId, input) =>
      exchangeEmbeddedSignup(
        {
          fetchFn: (url, init) => fetch(url, init),
          graphVersion: process.env.META_GRAPH_VERSION ?? "v26.0",
          appId: process.env.META_APP_ID,
          appSecret: process.env.META_APP_SECRET,
          vault,
          async persistAccount(persistInput) {
            const row = await createChannelAccount(defaultGetDatabase(), persistInput);
            return { id: row.id };
          },
        },
        workspaceId,
        input,
      ),
    getAiProvider: () => createAIProviderFromEnv(process.env),
    env: process.env,
  };
}

/**
 * Parse + verify a Meta `signed_request` (data-deletion callbacks and
 * other app-level posts). Format: base64url(HMAC-SHA256) "." base64url(JSON)
 * where the HMAC is computed over the payload PART STRING with the app
 * secret. Returns the payload, or null on any verification failure.
 */
export function parseMetaSignedRequest(
  signedRequest: string,
  appSecret: string,
): { user_id?: string; algorithm?: string; issued_at?: number } | null {
  const parts = signedRequest.split(".");
  if (parts.length !== 2) return null;
  const [signature, payloadPart] = parts as [string, string];
  const expected = createHmac("sha256", appSecret).update(payloadPart).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as {
      user_id?: string; algorithm?: string; issued_at?: number;
    };
    if (payload.algorithm && payload.algorithm !== "HMAC-SHA256") return null;
    return payload;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- types

type AppEnv = { Variables: { workspaceId?: string; auth?: AuthContext; requestId?: string } };
type Ctx = Context<AppEnv>;


function errorBody(err: AppError) {
  return { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } };
}

/**
 * Workspace id from the auth context; DB handlers must have one. The auth
 * middleware has already verified membership - reaching here without a
 * selected workspace means the client sent a session token but no
 * X-Workspace-Id selector.
 */
function workspaceId(c: Ctx): string {
  const id = c.get("auth")?.workspaceId ?? c.get("workspaceId");
  if (!id) {
    throw new AppError(
      "VALIDATION",
      "No workspace selected: send X-Workspace-Id together with your session token.",
      { status: 400 },
    );
  }
  return id;
}

/** Auth context from the middleware; protected handlers must have one. */
function authContext(c: Ctx): AuthContext {
  const auth = c.get("auth");
  if (!auth) {
    throw new AppError("UNAUTHORIZED", "Authentication required.", { status: 401 });
  }
  return auth;
}

/** Mutating workspace routes: owner/admin/member (agents are read + reply). */
function guardMutator(c: Ctx): void {
  requireRole(c.get("auth"), MUTATOR_ROLES);
}

const publicUser = (user: AuthUser) => ({ id: user.id, email: user.email, name: user.name });

async function readJsonBody(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (typeof body !== "object" || body === null) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new AppError("VALIDATION", "Request body must be a JSON object.", { status: 400 });
  }
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

// --------------------------------------------------------------------- app

export function createApp(deps: ApiDeps = defaultDeps()) {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const err = new AppError("VALIDATION", "Request validation failed.", {
          status: 400,
          details: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
        return c.json(errorBody(err), 400);
      }
      return undefined;
    },
  });

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(errorBody(err), err.status as 400);
    console.error("[api] unhandled error:", err);
    const wrapped = new AppError("INTERNAL", "Internal server error.", { status: 500 });
    return c.json(errorBody(wrapped), 500);
  });

  // ------------------------------------------------------------ auth helpers
  // Session token: Authorization Bearer wins, the httpOnly cookie is the
  // browser path. SESSION_SECRET missing => auth is unconfigured (503,
  // fail closed) - tokens are never accepted unsigned.

  function extractSessionToken(c: Ctx): string | undefined {
    const header = c.req.header("authorization");
    if (header?.startsWith("Bearer ")) {
      const token = header.slice("Bearer ".length).trim();
      if (token) return token;
    }
    return getCookie(c, SESSION_COOKIE);
  }

  function sessionSecret(): string {
    const secret = deps.env.SESSION_SECRET;
    if (!secret) {
      throw new AppError(
        "CONFIGURATION",
        "SESSION_SECRET is not configured on this server; authentication is unavailable.",
        { status: 503 },
      );
    }
    return secret;
  }

  /** Verify the presented token and load its user. Throws 401/503. */
  async function authenticateRequest(c: Ctx): Promise<AuthUser> {
    const token = extractSessionToken(c);
    if (!token) {
      throw new AppError(
        "UNAUTHORIZED",
        "Authentication required: send a session token (Authorization: Bearer or the botara_session cookie).",
        { status: 401 },
      );
    }
    const claims = verifySessionToken(token, sessionSecret());
    if (!claims) {
      throw new AppError("UNAUTHORIZED", "Session token is invalid or expired.", { status: 401 });
    }
    const user = await deps.authStore.findUserById(claims.userId);
    if (!user) {
      throw new AppError("UNAUTHORIZED", "Session user no longer exists.", { status: 401 });
    }
    return user;
  }

  /**
   * Full request context for workspace-scoped routes: the authenticated
   * user plus - when X-Workspace-Id selects one - verified membership and
   * role in that workspace. The dev fallback (BOTARA_ALLOW_HEADER_WORKSPACE=1)
   * is the ONLY path that trusts the header alone.
   */
  async function resolveAuthContext(c: Ctx): Promise<AuthContext> {
    const selectedWorkspace = c.req.header("x-workspace-id");
    if (!extractSessionToken(c)) {
      if (deps.env.BOTARA_ALLOW_HEADER_WORKSPACE === "1" && selectedWorkspace) {
        return {
          user: { id: "dev-header-user", email: "dev@localhost", name: "Dev (header fallback)" },
          workspaceId: selectedWorkspace,
          role: "owner",
          viaHeaderFallback: true,
        };
      }
      throw new AppError(
        "UNAUTHORIZED",
        "Authentication required: send a session token (Authorization: Bearer or the botara_session cookie).",
        { status: 401 },
      );
    }
    const user = await authenticateRequest(c);
    const base: AuthContext = { user: { id: user.id, email: user.email, name: user.name } };
    if (!selectedWorkspace) return base;
    const membership = await deps.authStore.getMembership(selectedWorkspace, user.id);
    if (!membership) {
      throw new AppError("FORBIDDEN", "You are not a member of the selected workspace.", { status: 403 });
    }
    return { ...base, workspaceId: selectedWorkspace, role: membership.role };
  }

  /** Membership check against a workspace from the PATH (member admin routes). */
  async function requirePathWorkspaceRole(
    c: Ctx,
    workspaceIdParam: string,
    roles: readonly string[],
  ): Promise<AuthContext> {
    const auth = authContext(c);
    if (auth.viaHeaderFallback) return { ...auth, workspaceId: workspaceIdParam, role: "owner" };
    const membership = await deps.authStore.getMembership(workspaceIdParam, auth.user.id);
    if (!membership || !roles.includes(membership.role)) {
      throw new AppError(
        "FORBIDDEN",
        `This action requires one of these workspace roles: ${roles.join(", ")}.`,
        { status: 403 },
      );
    }
    return { ...auth, workspaceId: workspaceIdParam, role: membership.role };
  }

  function setSessionCookie(c: Ctx, token: string): void {
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      path: "/",
      sameSite: "Lax",
      maxAge: SESSION_TTL_SECONDS,
      secure: c.req.header("x-forwarded-proto") === "https",
    });
  }

  async function createWorkspaceWithUniqueSlug(name: string) {
    const base = slugify(name);
    let slug = base;
    for (let i = 2; await deps.authStore.workspaceSlugExists(slug); i++) {
      slug = `${base}-${i}`;
    }
    return deps.authStore.createWorkspace({ name, slug });
  }

  // ------------------------------------------------------------- health
  const healthRoute = createRoute({
    method: "get", path: "/health",
    responses: { 200: { description: "Service health", content: { "application/json": { schema: z.object({ status: z.literal("ok"), service: z.literal("api") }) } } } },
  });
  app.openapi(healthRoute, (c) => c.json({ status: "ok" as const, service: "api" as const }));
  app.get("/", (c) => c.json({ name: "botara-api", phase: "Fase 3" }));

  // ---------------------------------------------------------------- auth
  const credentialsSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
  });

  const registerRoute = createRoute({
    method: "post", path: "/auth/register",
    request: {
      body: {
        content: {
          "application/json": {
            schema: credentialsSchema.extend({ name: z.string().min(1).optional() }),
          },
        },
      },
    },
    responses: { 201: { description: "Registered; session issued" } },
  });
  app.openapi(registerRoute, async (c) => {
    const secret = sessionSecret();
    const body = c.req.valid("json");
    const email = body.email.toLowerCase();
    const passwordHash = await hashPassword(body.password);
    let user = await deps.authStore.findUserByEmail(email);
    if (user?.passwordHash) {
      throw new AppError("CONFLICT", "This email is already registered. Log in instead.", { status: 409 });
    }
    if (user) {
      // An invited row (created by a workspace invite) is claimed by
      // setting its first password.
      await deps.authStore.setPasswordHash(user.id, passwordHash);
      user = { ...user, passwordHash, name: user.name ?? body.name ?? null };
    } else {
      user = await deps.authStore.createUser({ email, name: body.name, passwordHash });
    }
    // Every new user starts with a personal workspace they own.
    const displayName = body.name ?? user.name ?? email.split("@")[0]!;
    const workspace = await createWorkspaceWithUniqueSlug(`${displayName}'s Workspace`);
    await deps.authStore.addMember({ workspaceId: workspace.id, userId: user.id, role: "owner" });
    await deps.authStore.audit({
      workspaceId: workspace.id, userId: user.id, action: "auth.register", details: { email },
    });
    const token = signSessionToken({ userId: user.id, email: user.email }, secret);
    setSessionCookie(c, token);
    return c.json({
      user: publicUser(user),
      workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug, role: "owner" },
      token,
    }, 201);
  });

  const loginRoute = createRoute({
    method: "post", path: "/auth/login",
    request: { body: { content: { "application/json": { schema: credentialsSchema } } } },
    responses: { 200: { description: "Logged in; session issued" } },
  });
  app.openapi(loginRoute, async (c) => {
    const secret = sessionSecret();
    const body = c.req.valid("json");
    const user = await deps.authStore.findUserByEmail(body.email.toLowerCase());
    // One generic message for every failure mode - no account enumeration.
    if (!user?.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) {
      throw new AppError("UNAUTHORIZED", "Invalid email or password.", { status: 401 });
    }
    await deps.authStore.audit({ userId: user.id, action: "auth.login", details: { email: user.email } });
    const token = signSessionToken({ userId: user.id, email: user.email }, secret);
    setSessionCookie(c, token);
    return c.json({
      user: publicUser(user),
      workspaces: await deps.authStore.listWorkspaces(user.id),
      token,
    });
  });

  app.post("/auth/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  const meRoute = createRoute({
    method: "get", path: "/auth/me",
    responses: { 200: { description: "Current user + their workspaces" } },
  });
  app.openapi(meRoute, async (c) => {
    const user = await authenticateRequest(c);
    return c.json({
      user: publicUser(user),
      workspaces: await deps.authStore.listWorkspaces(user.id),
    });
  });


  // ------------------------------------------------------------ webhooks
  // Webhooks are provider-facing: no workspace header, no DB. Auth is the
  // provider's own scheme (Meta signature / Telegram secret token).

  app.get("/webhooks/whatsapp", (c) => {
    const challenge = verifyWebhookChallenge(
      {
        mode: c.req.query("hub.mode"),
        token: c.req.query("hub.verify_token"),
        challenge: c.req.query("hub.challenge"),
      },
      deps.env.WHATSAPP_VERIFY_TOKEN,
    );
    if (!challenge) {
      throw new AppError("FORBIDDEN", "WhatsApp webhook verification failed.", { status: 403 });
    }
    return c.text(challenge);
  });

  app.post("/webhooks/whatsapp", async (c) => {
    const raw = await c.req.text();
    const appSecret = deps.env.META_APP_SECRET;
    if (appSecret) {
      const ok = verifyWebhookSignature(raw, c.req.header("x-hub-signature-256"), appSecret);
      if (!ok) throw new AppError("UNAUTHORIZED", "Invalid X-Hub-Signature-256.", { status: 401 });
    }
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch {
      throw new AppError("VALIDATION", "Webhook body is not valid JSON.", { status: 400 });
    }
    const events = await getAdapter("whatsapp").parseWebhook(payload);
    // Fase 2 wiring: template category changes are APPLIED, not just logged -
    // templates.latest_category (+ the WABA/messaging account id) is patched
    // so subsequent sends route by the newest category. Failures are logged
    // for ops but never fail the webhook (the PATCH is idempotent; Meta
    // redelivery would simply re-apply it).
    for (const event of events) {
      if (event.type === "template.category_changed") {
        try {
          await deps.templateCategoryUpdater.applyCategoryChange(event);
        } catch (err) {
          console.error(
            `[api] template category update failed for ${event.templateExternalId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    await deps.eventSink.handle(events);
    return c.json({ received: true, events: events.length });
  });

  app.post("/webhooks/telegram", async (c) => {
    const secret = deps.env.TELEGRAM_WEBHOOK_SECRET;
    if (secret && c.req.header("x-telegram-bot-api-secret-token") !== secret) {
      throw new AppError("UNAUTHORIZED", "Invalid Telegram webhook secret token.", { status: 401 });
    }
    const payload = await readJsonBody(c);
    const events = await getAdapter("telegram").parseWebhook(payload);
    await deps.eventSink.handle(events);
    return c.json({ received: true, events: events.length });
  });

  // ------------------------------------------------- Fase 2 channel webhooks
  // Instagram / Messenger share the Meta hub verification + HMAC scheme;
  // Threads uses its own app secret; Resend uses Svix signatures.

  const metaVerifyToken = () => deps.env.META_VERIFY_TOKEN ?? deps.env.WHATSAPP_VERIFY_TOKEN;

  for (const channel of ["instagram", "messenger"] as const) {
    app.get(`/webhooks/${channel}`, (c) => {
      const challenge = verifyWebhookChallenge(
        {
          mode: c.req.query("hub.mode"),
          token: c.req.query("hub.verify_token"),
          challenge: c.req.query("hub.challenge"),
        },
        metaVerifyToken(),
      );
      if (!challenge) throw new AppError("FORBIDDEN", `${channel} webhook verification failed.`, { status: 403 });
      return c.text(challenge);
    });
    app.post(`/webhooks/${channel}`, async (c) => {
      const raw = await c.req.text();
      const appSecret = deps.env.META_APP_SECRET;
      if (appSecret && !verifyWebhookSignature(raw, c.req.header("x-hub-signature-256"), appSecret)) {
        throw new AppError("UNAUTHORIZED", `Invalid X-Hub-Signature-256 (${channel}).`, { status: 401 });
      }
      let payload: unknown;
      try { payload = JSON.parse(raw); } catch {
        throw new AppError("VALIDATION", "Webhook body is not valid JSON.", { status: 400 });
      }
      const events = await getAdapter(channel).parseWebhook(payload);
      await deps.eventSink.handle(events);
      return c.json({ received: true, events: events.length });
    });
  }

  app.get("/webhooks/threads", (c) => {
    const challenge = verifyWebhookChallenge(
      {
        mode: c.req.query("hub.mode"),
        token: c.req.query("hub.verify_token"),
        challenge: c.req.query("hub.challenge"),
      },
      deps.env.THREADS_VERIFY_TOKEN ?? metaVerifyToken(),
    );
    if (!challenge) throw new AppError("FORBIDDEN", "threads webhook verification failed.", { status: 403 });
    return c.text(challenge);
  });

  app.post("/webhooks/threads", async (c) => {
    const raw = await c.req.text();
    const appSecret = deps.env.THREADS_APP_SECRET ?? deps.env.META_APP_SECRET;
    if (appSecret && !verifyWebhookSignature(raw, c.req.header("x-hub-signature-256"), appSecret)) {
      throw new AppError("UNAUTHORIZED", "Invalid X-Hub-Signature-256 (threads).", { status: 401 });
    }
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch {
      throw new AppError("VALIDATION", "Webhook body is not valid JSON.", { status: 400 });
    }
    const events = await getAdapter("threads").parseWebhook(payload);
    await deps.eventSink.handle(events);
    return c.json({ received: true, events: events.length });
  });

  app.post("/webhooks/resend", async (c) => {
    const raw = await c.req.text();
    const secret = deps.env.RESEND_WEBHOOK_SECRET;
    if (secret) {
      const ok = verifyResendWebhookSignature({
        rawBody: raw,
        svixId: c.req.header("svix-id"),
        svixTimestamp: c.req.header("svix-timestamp"),
        svixSignature: c.req.header("svix-signature"),
        secret,
      });
      if (!ok) throw new AppError("UNAUTHORIZED", "Invalid Resend (Svix) webhook signature.", { status: 401 });
    }
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch {
      throw new AppError("VALIDATION", "Webhook body is not valid JSON.", { status: 400 });
    }
    const events = await getAdapter("email").parseWebhook(payload);
    await deps.eventSink.handle(events);
    // Fase 3 producer: an email.received event is routed by RECIPIENT
    // DOMAIN (workspace_domains) and enqueued as an email-inbound job; the
    // worker fetches the full content and files it into the inbox. When a
    // domain matches but Redis is down, the enqueue throws 503 - Resend
    // retries the webhook and nothing is silently dropped or faked.
    let enqueued = 0;
    for (const event of events) {
      if (event.type !== "message.received" || event.channel !== "email") continue;
      const domains = new Set(
        (event.recipients ?? [])
          .map((r) => r.split("@")[1]?.toLowerCase())
          .filter((d): d is string => Boolean(d)),
      );
      const routedAccounts = new Set<string>();
      for (const domain of domains) {
        const route = await deps.emailRouter.resolveRecipientDomain(domain);
        if (!route) {
          console.warn(
            `[api] resend inbound: no workspace domain registered for "${domain}" - email ${event.messageExternalId} is not routed`,
          );
          continue;
        }
        if (routedAccounts.has(route.channelAccountId)) continue;
        routedAccounts.add(route.channelAccountId);
        await deps.emailInboundEnqueuer.enqueueEmailInbound({
          workspaceId: route.workspaceId,
          channelAccountId: route.channelAccountId,
          emailId: event.messageExternalId,
        });
        enqueued++;
      }
    }
    return c.json({ received: true, events: events.length, enqueued });
  });

  // --------------------------------- Meta data deletion (Fase 3, App Review)
  // Meta REQUIRES this callback for app approval: a user asking Meta to
  // delete their data triggers a POST with a signed_request; we answer
  // with a public status URL + confirmation code, record the request, and
  // purge the provider user's contact data best-effort.

  app.post("/webhooks/meta/data-deletion", async (c) => {
    const appSecret = deps.env.META_APP_SECRET;
    if (!appSecret) {
      throw new AppError(
        "CONFIGURATION",
        "META_APP_SECRET is not configured; data-deletion requests cannot be verified.",
        { status: 503 },
      );
    }
    let signedRequest: string | undefined;
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = (await readJsonBody(c).catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.signed_request === "string") signedRequest = body.signed_request;
    } else {
      const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
      if (typeof form.signed_request === "string") signedRequest = form.signed_request;
    }
    if (!signedRequest) {
      throw new AppError("VALIDATION", "Missing signed_request in data-deletion callback.", { status: 400 });
    }
    const payload = parseMetaSignedRequest(signedRequest, appSecret);
    if (!payload?.user_id) {
      throw new AppError("UNAUTHORIZED", "Invalid signed_request signature.", { status: 401 });
    }
    const confirmationCode = randomBytes(16).toString("hex");
    await deps.dataDeletionStore.create({ confirmationCode, providerUserId: payload.user_id });
    try {
      await deps.dataDeletionStore.purge(payload.user_id);
      await deps.dataDeletionStore.complete(confirmationCode);
    } catch (err) {
      // Recorded but not yet completed - the status page keeps saying
      // "received" and ops can re-run the purge; Meta still gets its
      // required URL + code response.
      console.error(
        `[api] data-deletion purge failed for request ${confirmationCode}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const base = (deps.env.APP_PUBLIC_URL ?? new URL(c.req.url).origin).replace(/\/$/, "");
    return c.json({
      url: `${base}/data-deletion/status/${confirmationCode}`,
      confirmation_code: confirmationCode,
    });
  });

  // Public status page for a data-deletion request (Meta links users here).
  app.get("/data-deletion/status/:code", async (c) => {
    const record = await deps.dataDeletionStore.getByCode(c.req.param("code"));
    if (!record) {
      throw new AppError("NOT_FOUND", "Unknown data-deletion confirmation code.", { status: 404 });
    }
    return c.json({
      confirmation_code: record.confirmationCode,
      status: record.status,
      requested_at: record.createdAt,
    });
  });

  // ------------------------------------------- broadcasts: estimate (pure)
  // Registered BEFORE the workspace middleware on purpose: the estimate is a
  // pure billing calculation and must work without a database (smoke-tested).

  const estimateRoute = createRoute({
    method: "post", path: "/broadcasts/estimate",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              category: z.enum(["marketing", "utility", "authentication", "service"]),
              countryMix: z.array(z.object({ country: z.string().min(2), recipients: z.number().int().min(0) })).min(1),
              serviceMessagesAlreadySentThisMonth: z.number().int().min(0).optional(),
            }),
          },
        },
      },
    },
    responses: { 200: { description: "Broadcast cost estimate" } },
  });
  app.openapi(estimateRoute, (c) => {
    const body = c.req.valid("json");
    const estimate = estimateBroadcastCost({
      category: body.category,
      countryMix: body.countryMix,
      serviceMessagesAlreadySentThisMonth: body.serviceMessagesAlreadySentThisMonth,
    });
    return c.json({ ...estimate });
  });

  // ------------------------------------------- auth context middleware
  // Fase 3: every workspace-scoped route runs behind session auth +
  // verified workspace membership (see resolveAuthContext). Registered
  // BEFORE the routes it protects (Hono applies use() in order). The one
  // documented bypass is POST /broadcasts/estimate - a pure calculator over
  // the request body that touches no workspace data.
  const authMiddleware = async (c: Ctx, next: Next) => {
    if (c.req.path === "/broadcasts/estimate") return next();
    const auth = await resolveAuthContext(c);
    c.set("auth", auth);
    if (auth.workspaceId) c.set("workspaceId", auth.workspaceId);
    await next();
  };
  for (const prefix of ["/conversations", "/contacts", "/segments", "/templates", "/broadcasts", "/channels", "/posts", "/sequences", "/workspaces", "/kb"]) {
    app.use(prefix, authMiddleware);
    app.use(`${prefix}/*`, authMiddleware);
  }

  // ------------------------------------------------------------- workspaces
  const createWorkspaceRoute = createRoute({
    method: "post", path: "/workspaces",
    request: {
      body: { content: { "application/json": { schema: z.object({ name: z.string().min(1).max(200) }) } } },
    },
    responses: { 201: { description: "Workspace created; caller is owner" } },
  });
  app.openapi(createWorkspaceRoute, async (c) => {
    const auth = authContext(c);
    const workspace = await createWorkspaceWithUniqueSlug(c.req.valid("json").name);
    await deps.authStore.addMember({ workspaceId: workspace.id, userId: auth.user.id, role: "owner" });
    return c.json({
      workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug, role: "owner" },
    }, 201);
  });

  const listWorkspacesRoute = createRoute({
    method: "get", path: "/workspaces",
    responses: { 200: { description: "Workspaces of the current user" } },
  });
  app.openapi(listWorkspacesRoute, async (c) => {
    const auth = authContext(c);
    return c.json({ workspaces: await deps.authStore.listWorkspaces(auth.user.id) });
  });

  const listMembersRoute = createRoute({
    method: "get", path: "/workspaces/{id}/members",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Workspace members" } },
  });
  app.openapi(listMembersRoute, async (c) => {
    const { id } = c.req.valid("param");
    await requirePathWorkspaceRole(c, id, ROLES);
    return c.json({ members: await deps.authStore.listMembers(id) });
  });

  const addMemberRoute = createRoute({
    method: "post", path: "/workspaces/{id}/members",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              email: z.string().email(),
              role: z.enum(ROLES).default("member"),
            }),
          },
        },
      },
    },
    responses: { 201: { description: "Member added (user invited by email when new)" } },
  });
  app.openapi(addMemberRoute, async (c) => {
    const { id } = c.req.valid("param");
    const auth = await requirePathWorkspaceRole(c, id, ADMIN_ROLES);
    const body = c.req.valid("json");
    const email = body.email.toLowerCase();
    // Invite by email: an unknown email gets a passwordless user row; its
    // owner claims it at registration (see /auth/register).
    const invitee = await deps.authStore.findUserByEmail(email)
      ?? await deps.authStore.createUser({ email });
    await deps.authStore.addMember({ workspaceId: id, userId: invitee.id, role: body.role });
    await deps.authStore.audit({
      workspaceId: id,
      userId: auth.user.id,
      action: "workspace.member.add",
      details: { memberUserId: invitee.id, email, role: body.role },
    });
    return c.json({
      member: { userId: invitee.id, email: invitee.email, name: invitee.name, role: body.role },
    }, 201);
  });

  const removeMemberRoute = createRoute({
    method: "delete", path: "/workspaces/{id}/members/{userId}",
    request: { params: z.object({ id: z.string(), userId: z.string() }) },
    responses: { 200: { description: "Member removed" } },
  });
  app.openapi(removeMemberRoute, async (c) => {
    const { id, userId } = c.req.valid("param");
    const auth = await requirePathWorkspaceRole(c, id, ADMIN_ROLES);
    const members = await deps.authStore.listMembers(id);
    const target = members.find((m) => m.userId === userId);
    if (!target) throw new AppError("NOT_FOUND", "Workspace member not found.", { status: 404 });
    if (target.role === "owner" && members.filter((m) => m.role === "owner").length <= 1) {
      throw new AppError("CONFLICT", "Cannot remove the workspace's only owner.", { status: 409 });
    }
    await deps.authStore.removeMember(id, userId);
    await deps.authStore.audit({
      workspaceId: id,
      userId: auth.user.id,
      action: "workspace.member.remove",
      details: { memberUserId: userId, email: target.email, role: target.role },
    });
    return c.json({ removed: true });
  });
  // --------------------------------------------------------- conversations
  const listConversationsRoute = createRoute({
    method: "get", path: "/conversations",
    request: { query: z.object({ channel: z.string().optional(), status: z.string().optional() }) },
    responses: { 200: { description: "Conversations" } },
  });
  app.openapi(listConversationsRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { channel, status } = c.req.valid("query");
    const rows = await listConversations(db, ws, { channel, status });
    const now = new Date();
    return c.json({
      conversations: rows.map((r) => ({
        ...r,
        createdAt: iso(r.createdAt),
        lastUserMessageAt: iso(r.lastUserMessageAt),
        windowOpen: evaluateReplyWindow({
          channel: r.channel, kind: "free_form", lastUserMessageAt: r.lastUserMessageAt, now,
        }).windowOpen,
      })),
    });
  });

  const listMessagesRoute = createRoute({
    method: "get", path: "/conversations/{id}/messages",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Messages" } },
  });
  app.openapi(listMessagesRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const conversation = await getConversation(db, ws, id);
    if (!conversation) throw new AppError("NOT_FOUND", "Conversation not found.", { status: 404 });
    const rows = await listMessages(db, id);
    return c.json({
      messages: rows.map((m) => ({ ...m, createdAt: iso(m.createdAt) })),
    });
  });

  const replyRoute = createRoute({
    method: "post", path: "/conversations/{id}/reply",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              kind: z.enum(["free_form", "template"]).default("free_form"),
              text: z.string().min(1).optional(),
              templateId: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: { 200: { description: "Reply sent" } },
  });
  app.openapi(replyRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const conversation = await getConversation(db, ws, id);
    if (!conversation) throw new AppError("NOT_FOUND", "Conversation not found.", { status: 404 });
    const account = await getChannelAccount(db, ws, conversation.channelAccountId);
    if (!account) throw new AppError("NOT_FOUND", "Channel account not found.", { status: 404 });

    // 24h window enforcement (fail closed): free-form replies outside the
    // window are rejected; template replies stay allowed.
    const decision = evaluateReplyWindow({
      channel: conversation.channel,
      kind: body.kind,
      lastUserMessageAt: conversation.lastUserMessageAt,
      now: new Date(),
    });
    if (!decision.allowed) throw new MessagingWindowClosedError(conversation.channel);

    let templateInput: { name: string; language: string; latestCategory: string } | undefined;
    if (body.kind === "template") {
      if (!body.templateId) {
        throw new AppError("VALIDATION", "templateId is required for template replies.", { status: 400 });
      }
      const template = await getTemplate(db, ws, body.templateId);
      if (!template) throw new AppError("NOT_FOUND", "Template not found.", { status: 404 });
      templateInput = {
        name: template.name,
        language: template.language,
        latestCategory: template.latestCategory ?? template.category ?? "utility",
      };
    } else if (!body.text) {
      throw new AppError("VALIDATION", "text is required for free-form replies.", { status: 400 });
    }

    const idempotencyKey = `reply:${id}:${crypto.randomUUID()}`;
    const message = await createMessage(db, {
      conversationId: id,
      direction: "out",
      type: body.kind === "template" ? "template" : "text",
      body: body.kind === "template" ? templateInput!.name : body.text,
      status: "queued",
      idempotencyKey,
    });

    // Webchat replies persist through the DB-backed store (the registry's
    // webchat adapter has no store on purpose - it is wired here, where the
    // request's DB lives).
    const adapter = conversation.channel === "webchat"
      ? new WebchatAdapter({ store: createDbWebchatStore(db) })
      : getAdapter(conversation.channel as ChannelKey);
    try {
      const result = await adapter.send({
        account: {
          id: account.id,
          externalId: account.externalId,
          tokenVaultRef: account.tokenVaultRef ?? undefined,
        },
        toExternalId: conversation.contactExternalId,
        text: body.kind === "free_form" ? body.text : undefined,
        template: templateInput,
        idempotencyKey,
      });
      await updateMessageStatus(db, message.id, "sent", result.externalMessageId);
      return c.json({
        message: { ...message, status: "sent", externalId: result.externalMessageId, createdAt: iso(message.createdAt) },
        window: decision,
      });
    } catch (err) {
      await updateMessageStatus(db, message.id, "failed").catch(() => undefined);
      if (err instanceof AppError) throw err;
      throw new AppError("PROVIDER_ERROR", `Provider send failed: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
    }
  });

  // -------------------------------------------------------------- contacts
  const listContactsRoute = createRoute({
    method: "get", path: "/contacts",
    request: { query: z.object({ tag: z.string().optional(), channel: z.string().optional() }) },
    responses: { 200: { description: "Contacts" } },
  });
  app.openapi(listContactsRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { tag, channel } = c.req.valid("query");
    const rows = await listContacts(db, ws, { tag, channel });
    return c.json({ contacts: rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })) });
  });

  const createContactRoute = createRoute({
    method: "post", path: "/contacts",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              channel: z.string().min(1),
              externalId: z.string().min(1),
              displayName: z.string().optional(),
              tags: z.array(z.string()).optional(),
              customFields: z.record(z.string(), z.unknown()).optional(),
            }),
          },
        },
      },
    },
    responses: { 201: { description: "Contact created" } },
  });
  app.openapi(createContactRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const body = c.req.valid("json");
    const row = await createContact(db, { workspaceId: ws, ...body });
    return c.json({ contact: { ...row, createdAt: iso(row.createdAt) } }, 201);
  });

  const patchContactRoute = createRoute({
    method: "patch", path: "/contacts/{id}",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              displayName: z.string().optional(),
              tags: z.array(z.string()).optional(),
              customFields: z.record(z.string(), z.unknown()).optional(),
            }),
          },
        },
      },
    },
    responses: { 200: { description: "Contact updated" } },
  });
  app.openapi(patchContactRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const row = await updateContact(db, ws, id, c.req.valid("json"));
    if (!row) throw new AppError("NOT_FOUND", "Contact not found.", { status: 404 });
    return c.json({ contact: { ...row, createdAt: iso(row.createdAt) } });
  });

  const segmentsRoute = createRoute({
    method: "get", path: "/segments",
    responses: { 200: { description: "Per-tag segment counts" } },
  });
  app.openapi(segmentsRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    return c.json({ segments: await segmentCounts(db, ws) });
  });

  // ------------------------------------------------------------- templates
  const listTemplatesRoute = createRoute({
    method: "get", path: "/templates",
    responses: { 200: { description: "Templates" } },
  });
  app.openapi(listTemplatesRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const rows = await listTemplates(db, ws);
    return c.json({ templates: rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })) });
  });

  const createTemplateRoute = createRoute({
    method: "post", path: "/templates",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              channelAccountId: z.string().min(1),
              name: z.string().min(1),
              language: z.string().optional(),
              category: z.string().optional(),
              externalId: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: { 201: { description: "Template created" } },
  });
  app.openapi(createTemplateRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const row = await createTemplate(db, { workspaceId: ws, ...c.req.valid("json") });
    return c.json({ template: { ...row, createdAt: iso(row.createdAt) } }, 201);
  });

  const patchTemplateCategoryRoute = createRoute({
    method: "patch", path: "/templates/{id}/category",
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { "application/json": { schema: z.object({ latestCategory: z.string().min(1) }) } } },
    },
    responses: { 200: { description: "Template latest category updated" } },
  });
  app.openapi(patchTemplateCategoryRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const row = await updateTemplateLatestCategory(db, ws, id, c.req.valid("json").latestCategory);
    if (!row) throw new AppError("NOT_FOUND", "Template not found.", { status: 404 });
    return c.json({ template: { ...row, createdAt: iso(row.createdAt) } });
  });

  // ------------------------------------------------------------ broadcasts
  const createBroadcastRoute = createRoute({
    method: "post", path: "/broadcasts",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              channelAccountId: z.string().min(1),
              templateId: z.string().optional(),
              name: z.string().optional(),
              tag: z.string().optional(),
              country: z.string().min(2).optional(),
              recipientCount: z.number().int().min(1).optional(),
            }),
          },
        },
      },
    },
    responses: { 201: { description: "Broadcast created and queued" } },
  });
  app.openapi(createBroadcastRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const body = c.req.valid("json");

    const account = await getChannelAccount(db, ws, body.channelAccountId);
    if (!account) throw new AppError("NOT_FOUND", "Channel account not found.", { status: 404 });

    let category: WhatsAppCategory = "utility";
    if (body.templateId) {
      const template = await getTemplate(db, ws, body.templateId);
      if (!template) throw new AppError("NOT_FOUND", "Template not found.", { status: 404 });
      const cat = (template.latestCategory ?? template.category ?? "utility").toLowerCase();
      if (cat === "marketing" || cat === "utility" || cat === "authentication" || cat === "service") {
        category = cat;
      }
    }

    let recipientCount = body.recipientCount;
    if (body.tag) {
      const targets = await listContacts(db, ws, { tag: body.tag });
      recipientCount = targets.length;
    }
    if (!recipientCount || recipientCount < 1) {
      throw new AppError("VALIDATION", "No recipients: pass recipientCount or a tag with contacts.", { status: 400 });
    }

    const country = (body.country ?? "ID").toUpperCase();
    const estimate = estimateBroadcastCost({ category, countryMix: [{ country, recipients: recipientCount }] });

    const broadcast = await createBroadcast(db, {
      workspaceId: ws,
      channelAccountId: body.channelAccountId,
      templateId: body.templateId,
      name: body.name,
      tag: body.tag,
      country,
      recipientCount,
      status: "queued",
      estimatedCostUsd: estimate.totalUsd.toFixed(6),
      ratesVersion: estimate.ratesVersion,
    });

    try {
      await deps.broadcastEnqueuer.enqueueBroadcast(broadcast.id);
    } catch (err) {
      await updateBroadcastStatus(db, broadcast.id, "failed").catch(() => undefined);
      throw err;
    }

    return c.json({
      broadcast: { ...broadcast, status: "queued", createdAt: iso(broadcast.createdAt) },
      estimate,
    }, 201);
  });

  const getBroadcastRoute = createRoute({
    method: "get", path: "/broadcasts/{id}",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Broadcast with cost report" } },
  });
  app.openapi(getBroadcastRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const broadcast = await getBroadcast(db, ws, id);
    if (!broadcast) throw new AppError("NOT_FOUND", "Broadcast not found.", { status: 404 });
    const cost = await sumCostLedgerByReference(db, id);
    return c.json({
      broadcast: { ...broadcast, createdAt: iso(broadcast.createdAt) },
      sentCount: broadcast.sentCount,
      failedCount: broadcast.failedCount,
      totalCostUsd: cost.totalUsd,
      costEntries: cost.entries,
      costUnits: cost.units,
    });
  });

  // ------------------------------------------------------- AI (Fase 2)
  const aiSuggestRoute = createRoute({
    method: "post", path: "/conversations/{id}/ai-suggest",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "AI-suggested reply" } },
  });
  app.openapi(aiSuggestRoute, async (c) => {
    const provider = deps.getAiProvider();
    if (!provider) {
      throw new AppError(
        "CONFIGURATION",
        "No AI provider is configured (AI_API_KEY); suggestions are unavailable and are never faked.",
        { status: 503 },
      );
    }
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const conversation = await getConversation(db, ws, id);
    if (!conversation) throw new AppError("NOT_FOUND", "Conversation not found.", { status: 404 });
    const history = (await listMessages(db, id)).slice(-20);
    const result = await provider.chatCompletion({
      model: deps.env.AI_MODEL ?? DEFAULT_AI_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You help a customer-support agent. Draft a helpful, concise reply to the customer, " +
            "in the same language as the conversation. Return only the reply text.",
        },
        ...(history.length > 0
          ? history.map((m) => ({
              role: (m.direction === "in" ? "user" : "assistant") as "user" | "assistant",
              content: m.body ?? "",
            }))
          : [{ role: "user" as const, content: "(no prior messages)" }]),
      ],
    });
    return c.json({ suggestion: result.text, model: result.model });
  });

  const moderationRoute = createRoute({
    method: "post", path: "/moderation/check",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              text: z.string().min(1),
              flagList: z.array(z.string()).optional(),
            }),
          },
        },
      },
    },
    responses: { 200: { description: "Keyword moderation result" } },
  });
  app.openapi(moderationRoute, (c) => {
    const body = c.req.valid("json");
    const result = moderateText(body.text, body.flagList);
    return c.json({ ...result });
  });

  // ---------------------------------------------------- channels (Fase 2)
  const listAccountsRoute = createRoute({
    method: "get", path: "/channels/accounts",
    responses: { 200: { description: "Channel accounts of the workspace" } },
  });
  app.openapi(listAccountsRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const rows = await listChannelAccounts(db, ws);
    return c.json({
      accounts: rows.map((r) => {
        const { tokenVaultRef: _vaultRef, ...safe } = r;
        return {
          ...safe,
          hasCredential: Boolean(r.tokenVaultRef),
          createdAt: iso(r.createdAt),
          tokenExpiresAt: iso(r.tokenExpiresAt),
        };
      }),
    });
  });

  // ------------------------------------------- email domains (Fase 3)
  const serializeDomain = (d: Awaited<ReturnType<typeof listWorkspaceDomains>>[number]) => ({
    ...d,
    createdAt: iso(d.createdAt),
  });

  const createEmailDomainRoute = createRoute({
    method: "post", path: "/channels/email/domains",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              domain: z.string().min(3).max(255),
              channelAccountId: z.string().optional(),
              resendDomainId: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: { 201: { description: "Workspace email domain registered" } },
  });
  app.openapi(createEmailDomainRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const body = c.req.valid("json");
    const domain = body.domain.toLowerCase().trim();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
      throw new AppError("VALIDATION", `"${body.domain}" is not a valid domain name.`, { status: 400 });
    }
    const db = deps.getDatabase();
    if (body.channelAccountId) {
      const account = await getChannelAccount(db, ws, body.channelAccountId);
      if (!account) throw new AppError("NOT_FOUND", "Channel account not found.", { status: 404 });
      if (account.channel !== "email") {
        throw new AppError("VALIDATION", "channelAccountId must reference an email channel account.", { status: 400 });
      }
    }
    if (await findWorkspaceDomain(db, domain)) {
      throw new AppError("CONFLICT", `Domain ${domain} is already registered to a workspace.`, { status: 409 });
    }
    const row = await createWorkspaceDomain(db, {
      workspaceId: ws,
      domain,
      channelAccountId: body.channelAccountId,
      resendDomainId: body.resendDomainId,
    });
    return c.json({ domain: serializeDomain(row) }, 201);
  });

  const listEmailDomainsRoute = createRoute({
    method: "get", path: "/channels/email/domains",
    responses: { 200: { description: "Workspace email domains" } },
  });
  app.openapi(listEmailDomainsRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const rows = await listWorkspaceDomains(db, ws);
    return c.json({ domains: rows.map(serializeDomain) });
  });

  const deleteEmailDomainRoute = createRoute({
    method: "delete", path: "/channels/email/domains/{id}",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Workspace email domain removed" } },
  });
  app.openapi(deleteEmailDomainRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const deleted = await deleteWorkspaceDomain(db, ws, c.req.valid("param").id);
    if (!deleted) throw new AppError("NOT_FOUND", "Email domain not found.", { status: 404 });
    return c.json({ deleted: true });
  });

  const embeddedSignupRoute = createRoute({
    method: "post", path: "/channels/whatsapp/embedded-signup/exchange",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              code: z.string().min(1),
              sessionInfo: z.object({
                wabaId: z.string().optional(),
                phoneNumberId: z.string().optional(),
                isCoexistence: z.boolean().optional(),
              }).optional(),
            }),
          },
        },
      },
    },
    responses: { 201: { description: "WhatsApp account(s) onboarded" } },
  });
  app.openapi(embeddedSignupRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const result = await deps.whatsappOnboarding(ws, c.req.valid("json"));
    // The result summary carries no token material by construction.
    return c.json({ result }, 201);
  });

  // ------------------------------------------------------ webchat (Fase 2)
  // Public widget endpoints: the workspace comes from the PATH and the
  // visitor authenticates with the session token - no X-Workspace-Id here.

  const webchatHits = new Map<string, number[]>();
  const WEBCHAT_MAX_MSGS_PER_MIN = 30;
  function webchatRateOk(sessionId: string, now: Date): boolean {
    const hits = (webchatHits.get(sessionId) ?? []).filter((t) => now.getTime() - t < 60_000);
    if (hits.length >= WEBCHAT_MAX_MSGS_PER_MIN) return false;
    hits.push(now.getTime());
    webchatHits.set(sessionId, hits);
    return true;
  }

  async function requireWebchatSession(c: Ctx, workspaceIdParam: string) {
    const token = c.req.header("x-webchat-session");
    if (!token) {
      throw new AppError("UNAUTHORIZED", "Missing webchat session token (x-webchat-session header).", { status: 401 });
    }
    const db = deps.getDatabase();
    const session = await getWebchatSessionByToken(db, token);
    if (!session || session.workspaceId !== workspaceIdParam) {
      throw new AppError("UNAUTHORIZED", "Invalid webchat session token.", { status: 401 });
    }
    return { db, session };
  }

  app.post("/public/webchat/:workspaceId/session", async (c) => {
    const workspaceIdParam = c.req.param("workspaceId");
    let visitorName: string | undefined;
    try {
      const body = (await c.req.json()) as { visitorName?: unknown };
      if (typeof body?.visitorName === "string") visitorName = body.visitorName;
    } catch { /* an empty body is fine */ }
    const db = deps.getDatabase();
    const account = await findOrCreateWebchatAccount(db, workspaceIdParam);
    const sessionId = crypto.randomUUID();
    const contact = await createContact(db, {
      workspaceId: workspaceIdParam,
      channel: "webchat",
      externalId: `webchat-session:${sessionId}`,
      displayName: visitorName,
    });
    const conversation = await createConversationRow(db, {
      workspaceId: workspaceIdParam,
      channelAccountId: account.id,
      contactId: contact.id,
    });
    const token = randomBytes(32).toString("hex");
    const session = await createWebchatSession(db, {
      id: sessionId,
      workspaceId: workspaceIdParam,
      token,
      contactId: contact.id,
      conversationId: conversation.id,
      visitorName,
    });
    return c.json({
      sessionToken: session.token,
      sessionId: session.id,
      conversationId: session.conversationId,
    }, 201);
  });

  app.post("/public/webchat/:workspaceId/messages", async (c) => {
    const { db, session } = await requireWebchatSession(c, c.req.param("workspaceId"));
    const body = await readJsonBody(c);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length < 1 || text.length > 2000) {
      throw new AppError("VALIDATION", "Message text must be 1-2000 characters.", { status: 400 });
    }
    if (!webchatRateOk(session.id, new Date())) {
      throw new AppError("RATE_LIMITED", "Too many messages - please slow down.", { status: 429 });
    }
    const now = new Date();
    const message = await createMessage(db, {
      conversationId: session.conversationId,
      direction: "in",
      type: "text",
      body: text,
      status: "delivered",
    });
    await touchConversationLastUserMessage(db, session.conversationId, now);
    await touchWebchatSession(db, session.id, now);
    return c.json({ message: { ...message, createdAt: iso(message.createdAt) } }, 201);
  });

  app.get("/public/webchat/:workspaceId/messages", async (c) => {
    const { db, session } = await requireWebchatSession(c, c.req.param("workspaceId"));
    const after = c.req.query("after");
    const rows = await listMessages(db, session.conversationId);
    const filtered = after
      ? rows.filter((m) => m.createdAt.toISOString() > after)
      : rows;
    return c.json({
      messages: filtered.map((m) => ({ ...m, createdAt: iso(m.createdAt) })),
    });
  });

  // --------------------------------------------------- publishing (Fase 2)
  const serializePost = (p: Awaited<ReturnType<typeof listScheduledPosts>>[number]) => ({
    ...p,
    createdAt: iso(p.createdAt),
    scheduledAt: iso(p.scheduledAt),
  });

  const postTargetSchema = z.object({ channelAccountId: z.string().min(1) });

  const createPostRoute = createRoute({
    method: "post", path: "/posts",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              text: z.string().optional(),
              mediaUrls: z.array(z.string().url()).optional(),
              mediaKeys: z.array(z.string()).optional(),
              targets: z.array(postTargetSchema).min(1),
              scheduledAt: z.string().datetime().optional(),
            }),
          },
        },
      },
    },
    responses: { 201: { description: "Scheduled post created" } },
  });
  app.openapi(createPostRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const body = c.req.valid("json");
    if (!body.text && (!body.mediaUrls || body.mediaUrls.length === 0)) {
      throw new AppError("VALIDATION", "A post needs text or at least one media URL.", { status: 400 });
    }
    const targets: ScheduledPostTarget[] = [];
    for (const t of body.targets) {
      const account = await getChannelAccount(db, ws, t.channelAccountId);
      if (!account) {
        throw new AppError("NOT_FOUND", `Channel account ${t.channelAccountId} not found.`, { status: 404 });
      }
      targets.push({ channelAccountId: account.id, channel: account.channel });
    }
    const post = await createScheduledPost(db, {
      workspaceId: ws,
      text: body.text,
      mediaUrls: body.mediaUrls,
      mediaKeys: body.mediaKeys,
      targets,
      scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
      status: body.scheduledAt ? "scheduled" : "draft",
    });
    return c.json({ post: serializePost(post) }, 201);
  });

  const listPostsRoute = createRoute({
    method: "get", path: "/posts",
    request: { query: z.object({ status: z.string().optional() }) },
    responses: { 200: { description: "Scheduled posts" } },
  });
  app.openapi(listPostsRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const rows = await listScheduledPosts(db, ws, { status: c.req.valid("query").status });
    return c.json({ posts: rows.map(serializePost) });
  });

  const getPostRoute = createRoute({
    method: "get", path: "/posts/{id}",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "One scheduled post with per-target results" } },
  });
  app.openapi(getPostRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const post = await getScheduledPost(db, ws, c.req.valid("param").id);
    if (!post) throw new AppError("NOT_FOUND", "Post not found.", { status: 404 });
    return c.json({ post: serializePost(post) });
  });

  const patchPostRoute = createRoute({
    method: "patch", path: "/posts/{id}",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              text: z.string().optional(),
              mediaUrls: z.array(z.string().url()).optional(),
              scheduledAt: z.string().datetime().nullable().optional(),
              status: z.enum(["draft", "scheduled", "cancelled"]).optional(),
            }),
          },
        },
      },
    },
    responses: { 200: { description: "Scheduled post updated" } },
  });
  app.openapi(patchPostRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const existing = await getScheduledPost(db, ws, id);
    if (!existing) throw new AppError("NOT_FOUND", "Post not found.", { status: 404 });
    if (!["draft", "scheduled"].includes(existing.status)) {
      throw new AppError("CONFLICT", `Post is ${existing.status} and can no longer be edited.`, { status: 409 });
    }
    await updateScheduledPost(db, id, {
      text: body.text,
      mediaUrls: body.mediaUrls,
      scheduledAt: body.scheduledAt === undefined ? undefined : body.scheduledAt === null ? null : new Date(body.scheduledAt),
      status: body.status,
    });
    const updated = await getScheduledPost(db, ws, id);
    return c.json({ post: serializePost(updated!) });
  });

  const deletePostRoute = createRoute({
    method: "delete", path: "/posts/{id}",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Scheduled post deleted" } },
  });
  app.openapi(deletePostRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const deleted = await deleteScheduledPost(db, ws, c.req.valid("param").id);
    if (!deleted) throw new AppError("NOT_FOUND", "Post not found.", { status: 404 });
    return c.json({ deleted: true });
  });

  const publishNowRoute = createRoute({
    method: "post", path: "/posts/{id}/publish-now",
    request: { params: z.object({ id: z.string() }) },
    responses: { 202: { description: "Publish job enqueued" } },
  });
  app.openapi(publishNowRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const post = await getScheduledPost(db, ws, id);
    if (!post) throw new AppError("NOT_FOUND", "Post not found.", { status: 404 });
    if (post.status === "published") {
      throw new AppError("CONFLICT", "Post is already published.", { status: 409 });
    }
    // Throws 503 when Redis is unavailable - the post keeps its old status.
    await deps.publishEnqueuer.enqueuePublish(id);
    await updateScheduledPost(db, id, { status: "publishing" });
    return c.json({ post: serializePost({ ...post, status: "publishing" }) }, 202);
  });

  // ---------------------------------------------------- sequences (Fase 2)
  const sequenceStepSchema = z.object({
    delaySeconds: z.number().int().min(0),
    text: z.string().optional(),
    template: z.object({
      name: z.string().min(1),
      language: z.string().min(1),
      latestCategory: z.string().min(1),
    }).optional(),
  });

  const createSequenceRoute = createRoute({
    method: "post", path: "/sequences",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              channelAccountId: z.string().min(1),
              name: z.string().min(1),
              steps: z.array(sequenceStepSchema).min(1),
            }),
          },
        },
      },
    },
    responses: { 201: { description: "Sequence created" } },
  });
  app.openapi(createSequenceRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const body = c.req.valid("json");
    const account = await getChannelAccount(db, ws, body.channelAccountId);
    if (!account) throw new AppError("NOT_FOUND", "Channel account not found.", { status: 404 });
    const row = await createSequence(db, {
      workspaceId: ws,
      channelAccountId: body.channelAccountId,
      name: body.name,
      steps: body.steps as SequenceStep[],
    });
    return c.json({ sequence: { ...row, createdAt: iso(row.createdAt) } }, 201);
  });

  const listSequencesRoute = createRoute({
    method: "get", path: "/sequences",
    responses: { 200: { description: "Sequences" } },
  });
  app.openapi(listSequencesRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const rows = await listSequences(db, ws);
    return c.json({ sequences: rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })) });
  });

  const getSequenceRoute = createRoute({
    method: "get", path: "/sequences/{id}",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "One sequence" } },
  });
  app.openapi(getSequenceRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const row = await getSequence(db, ws, c.req.valid("param").id);
    if (!row) throw new AppError("NOT_FOUND", "Sequence not found.", { status: 404 });
    return c.json({ sequence: { ...row, createdAt: iso(row.createdAt) } });
  });

  const patchSequenceRoute = createRoute({
    method: "patch", path: "/sequences/{id}",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1).optional(),
              steps: z.array(sequenceStepSchema).min(1).optional(),
              status: z.enum(["active", "paused", "archived"]).optional(),
            }),
          },
        },
      },
    },
    responses: { 200: { description: "Sequence updated" } },
  });
  app.openapi(patchSequenceRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await updateSequence(db, ws, id, {
      name: body.name,
      steps: body.steps as SequenceStep[] | undefined,
      status: body.status,
    });
    if (!row) throw new AppError("NOT_FOUND", "Sequence not found.", { status: 404 });
    return c.json({ sequence: { ...row, createdAt: iso(row.createdAt) } });
  });

  const enrollRoute = createRoute({
    method: "post", path: "/sequences/{id}/enroll",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({ tag: z.string().min(1) }),
          },
        },
      },
    },
    responses: { 201: { description: "Contacts enrolled by tag" } },
  });
  app.openapi(enrollRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const { tag } = c.req.valid("json");
    const sequence = await getSequence(db, ws, id);
    if (!sequence) throw new AppError("NOT_FOUND", "Sequence not found.", { status: 404 });
    const steps = (sequence.steps as SequenceStep[]) ?? [];
    if (steps.length === 0) {
      throw new AppError("VALIDATION", "Sequence has no steps to enroll into.", { status: 400 });
    }
    const targets = await listContacts(db, ws, { tag });
    const nextStepAt = new Date(Date.now() + (steps[0]!.delaySeconds ?? 0) * 1000);
    let enrolled = 0;
    for (const contact of targets) {
      const row = await createEnrollment(db, {
        workspaceId: ws, sequenceId: id, contactId: contact.id, nextStepAt,
      });
      if (row) enrolled++;
    }
    return c.json({ enrolled, skipped: targets.length - enrolled, total: targets.length }, 201);
  });

  app.doc("/doc", {
    openapi: "3.0.0",
    info: {
      title: "Botara API", version: "0.2.0",
      description: "Omnichannel chatbot platform API (Fase 2). DB routes use the X-Workspace-Id header as the Fase 1 workspace-context stand-in.",
    },
  });

  return app;
}
