import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import {
  AppError, ChannelAccountDisconnectedError, ChannelInitiationError, ConsecutiveSendCapError,
  countConsecutiveOutbound, disconnectPurgeAt, evaluateReplyWindow, MessagingWindowClosedError,
} from "@botara/shared";
import {
  getDb, listContacts, getContact, createContact, updateContact, segmentCounts,
  listConversations, getConversation, listMessages, createMessage, updateMessageStatus,
  touchConversationLastUserMessage,
  listTemplates, createTemplate, updateTemplateLatestCategory,
  createBroadcast, listBroadcasts, getBroadcast, updateBroadcastStatus, sumCostLedgerByReference,
  getChannelAccount, getChannelAccountById, getTemplate, listChannelAccounts, createChannelAccount,
  deleteChannelAccount, channelAccountHasReferences, purgeChannelAccount, softDisconnectChannelAccount,
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
  createKbDocument, listKbDocuments, getKbDocument, deleteKbDocument,
  listKbChunks, listKbChunksByWorkspace,
  createFlow, listFlows, getFlow, updateFlow, deleteFlow,
  deleteSequence, countEnrollmentsBySequence, getWorkspaceStats,
  updateChannelAccountToken, updateChannelAccountAvatar,
  createGrowthLink, listGrowthLinks, getGrowthLink, deleteGrowthLink,
  getGrowthLinkBySlug, incrementGrowthLinkClicks, upsertContactByExternal,
  updateConversationAssignment, updateConversationStatus, CONVERSATION_STATUSES,
  upsertCatalogProduct, listCatalogProducts, listCatalogProductKeys, deleteCatalogProduct,
  PlatformSettingsService, DbPlatformSettingsStorage, tryParseVaultKey,
  type Database, type ScheduledPostTarget, type SequenceStep, type FlowRow,
  type GrowthLinkRow, type ConversationListItem, type EnvLike,
} from "@botara/db";
import { DbAdminStore, registerAdminRoutes, type AdminStore } from "./admin";
import {
  getAdapter, verifyWebhookChallenge, verifyWebhookSignature, verifyResendWebhookSignature,
  WebchatAdapter, CHANNEL_CAPABILITIES,
  TelegramAdapter, InstagramAdapter, ThreadsAdapter, MessengerAdapter, TikTokAdapter,
  StaticCredentialProvider, buildInstagramAuthorizeUrl, buildThreadsAuthorizeUrl,
  buildMessengerAuthorizeUrl, buildTikTokAuthorizeUrl, serializeTikTokTokenPair,
  verifyTikTokWebhookSignature,
  richBlockSchema, richBlockText, richToPlainText,
  VaultCredentialProvider, envWhatsAppCredentials,
  type ChannelKey, type InboundEvent, type FetchLike, type InstagramAuthMode,
} from "@botara/channels";
import { runFlow, storedGraphSchema, toRunnableFlow, type FlowAction } from "@botara/flow-engine";
import {
  createDbFlowDispatcher, noopFlowDispatcher,
  type CommentActionEnqueuer, type FlowRunEnqueuer, type InboundFlowDispatcher,
} from "./flows-dispatch";
import { createInboundMediaPort } from "./inbound-media";
import {
  ADMIN_ROLES, API_TOKEN_PREFIX, MUTATOR_ROLES, ROLES, SESSION_COOKIE, SESSION_TTL_SECONDS,
  DbAuthStore, hashPassword, requireRole, signSessionToken, slugify, verifyPassword,
  verifySessionToken,
  type AuthContext, type AuthStore, type AuthUser,
} from "./auth";
import { estimateBroadcastCost, type WhatsAppCategory } from "@botara/billing";
import {
  createAIProviderFromEnv, moderateText, rankChunks,
  DEFAULT_AI_MODEL, DEFAULT_EMBEDDING_MODEL, type AIProvider,
} from "@botara/ai";
import {
  InMemoryVault, createDbWhatsAppAccountPersister, exchangeEmbeddedSignup,
  type EmbeddedSignupInput, type EmbeddedSignupResult, type TokenVaultPort,
} from "./whatsapp-onboarding";
import { createDbWebchatStore } from "./webchat-store";
import {
  createRedisRealtimePublisher, type RealtimePublisher,
} from "./realtime-publish";
import {
  contactsToCsv, contactsToJson, dedupeImportRows, parseImport,
} from "./contacts-io";
import { buildGrowthTarget, generateGrowthSlug, growthShortUrl } from "./growth";
import { syncWhatsAppCatalog, type CatalogSyncResult } from "./catalog-sync";

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
  enqueueKbIngest(input: { workspaceId: string; documentId: string }): Promise<void>;
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
  /** Meta Catalog sync for a WhatsApp account (Graph discovery + paging + mirror). */
  catalogSync: (input: { workspaceId: string; accountId: string; catalogId?: string }) => Promise<CatalogSyncResult>;
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
  rateLimits?: { authPerMinute?: number; publicPerMinute?: number; utilityPerMinute?: number };
  /** Fase 4: flow-run enqueueing + inbound webhook dispatch (persist + match). */
  flowEnqueuer: FlowRunEnqueuer;
  flowDispatcher: InboundFlowDispatcher;
  /** Fase 4: token vault for channel connect flows (telegram/OAuth). Store-only. */
  vault: TokenVaultPort;
  /** Inbox live updates: fire-and-forget publisher onto the realtime bus. */
  realtimePublisher: RealtimePublisher;
  /** Fase 4: fetch used for provider OAuth/token calls (fakeable in tests). */
  providerFetch: FetchLike;
  /** Platform admin (operator panel): deployment-scoped read views. */
  adminStore: AdminStore;
  /** Platform admin: DB-managed settings with env fallback (see @botara/db). */
  platformSettings: PlatformSettingsService;
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

/** Production flow-run enqueuer: BullMQ "flow-run" queue, job "flow-run". */
export function createBullMqFlowEnqueuer(redisUrl: string): FlowRunEnqueuer {
  const inner = createBullMqEnqueuer(redisUrl, "flow-run", "flow-run");
  return {
    enqueueFlowRun: (job) => {
      const runId = crypto.randomUUID();
      return inner.enqueue({ ...job, runId }, `flowrun:${runId}`);
    },
  };
}

/**
 * Production comment-action enqueuer: BullMQ "comment-action" queue. The
 * job id is the (comment, flow) pair, so a redelivered webhook cannot
 * enqueue the same automation twice while the first job is pending.
 */
export function createBullMqCommentActionEnqueuer(redisUrl: string): CommentActionEnqueuer {
  const inner = createBullMqEnqueuer(redisUrl, "comment-action", "comment-action");
  return {
    enqueueCommentAction: (job) =>
      inner.enqueue({ ...job }, `comment:${job.commentExternalId}:${job.flowId}`),
  };
}

/** Production kb-ingest enqueuer: BullMQ "kb" queue, job "ingest". */
export function createBullMqKbEnqueuer(redisUrl: string): KbEnqueuer {
  const inner = createBullMqEnqueuer(redisUrl, "kb", "ingest");
  return {
    enqueueKbIngest: (input) => inner.enqueue(input, `kb-ingest:${input.documentId}`),
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
    lazyConnect: true,
    retryStrategy: () => null,
  });
  connection.on("error", () => { /* surfaced via the raced ping below */ });
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("redis ping timed out")), 2000),
    );
    // With lazyConnect + no offline queue, PING before connect rejects with
    // "Stream isn't writeable" - so await the connection itself first.
    const res = await Promise.race([
      (async () => {
        await connection.connect();
        return connection.ping();
      })(),
      timeout,
    ]);
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
  let real: { store: TokenVaultPort["store"]; get: TokenVaultPort["get"]; delete: TokenVaultPort["delete"] } | null | undefined;
  const resolveReal = () => {
    if (real !== undefined) return real;
    if (process.env.DATABASE_URL && process.env.TOKEN_VAULT_KEY) {
      const db = defaultGetDatabase();
      const vault = createTokenVault(db, process.env, {
        write: async (entry) => { await insertAuditLog(db, entry); },
      });
      real = {
        store: (input) => vault.store(input),
        get: (ref) => vault.get(ref),
        delete: (ref) => vault.delete(ref),
      };
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
    async get(ref) {
      const vault = resolveReal();
      // A stored ref lives in exactly one vault: the real vault returns
      // null for refs it does not own, so fall through to memory.
      if (vault) {
        const secret = await vault.get(ref);
        if (secret !== null) return secret;
      }
      return memory.get(ref);
    },
    async delete(ref) {
      const vault = resolveReal();
      // Each vault is a no-op for refs it does not own (the real vault only
      // parses vault:db:{id} refs, memory only holds its own refs), so both
      // are asked - a stored ref lives in exactly one of them.
      if (vault) await vault.delete(ref);
      await memory.delete(ref);
    },
  };
}

/**
 * Catalog-sync access-token resolution: the SAME mechanism the channel
 * adapters resolve with - VaultCredentialProvider over the encrypted
 * TokenVault (lazily built, mirroring createDefaultVault's guard), with
 * the WhatsApp env provider as the fallback. Returns null when the
 * account has no usable token (the sync service turns that into a typed
 * 503 CONFIGURATION).
 */
export function createCatalogTokenResolver(): (
  account: { id: string; externalId: string; tokenVaultRef?: string | null },
) => Promise<string | null> {
  let vault: ReturnType<typeof createTokenVault> | null | undefined;
  const resolveVault = () => {
    if (vault !== undefined) return vault;
    vault = process.env.DATABASE_URL && process.env.TOKEN_VAULT_KEY
      ? createTokenVault(defaultGetDatabase(), process.env)
      : null;
    return vault;
  };
  return async (account) => {
    const v = resolveVault();
    const provider = new VaultCredentialProvider(
      { getSecret: async (ref) => (v ? v.get(ref) : null) },
      envWhatsAppCredentials(),
    );
    const secrets = await provider.resolve({
      id: account.id,
      externalId: account.externalId,
      tokenVaultRef: account.tokenVaultRef ?? undefined,
    });
    return secrets.accessToken ?? null;
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

/**
 * Production deps. `baseEnv` is the PRISTINE env snapshot (pre-overlay)
 * the platform-settings service falls back to; index.ts captures it
 * before applying the DB overlay and passes it in. Defaults to a fresh
 * snapshot of the current process env.
 */
export function defaultDeps(baseEnv: EnvLike = { ...process.env }): ApiDeps {
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const vault = createDefaultVault();
  const realtimePublisher = createRedisRealtimePublisher(redisUrl);
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
    flowEnqueuer: createBullMqFlowEnqueuer(redisUrl),
    flowDispatcher: createDbFlowDispatcher({
      getDatabase: defaultGetDatabase,
      flowEnqueuer: createBullMqFlowEnqueuer(redisUrl),
      commentEnqueuer: createBullMqCommentActionEnqueuer(redisUrl),
      publisher: realtimePublisher,
      // Inbound media pipeline: copies channel media bytes into R2 at
      // ingest. Degrades silently to caption-only when R2 is not
      // configured - the port never throws (see inbound-media.ts).
      mediaPort: createInboundMediaPort(),
    }),
    vault,
    realtimePublisher,
    providerFetch: (url, init) => fetch(url, init as RequestInit),
    readiness: createReadinessChecker(defaultGetDatabase, redisUrl),
    whatsappOnboarding: (workspaceId, input) =>
      exchangeEmbeddedSignup(
        {
          fetchFn: (url, init) => fetch(url, init),
          graphVersion: process.env.META_GRAPH_VERSION ?? "v26.0",
          appId: process.env.META_APP_ID,
          appSecret: process.env.META_APP_SECRET,
          vault,
          persistAccount: createDbWhatsAppAccountPersister(defaultGetDatabase),
        },
        workspaceId,
        input,
      ),
    catalogSync: async (input) => {
      const account = await getChannelAccount(defaultGetDatabase(), input.workspaceId, input.accountId);
      if (!account) {
        throw new AppError("NOT_FOUND", "Channel account not found.", { status: 404 });
      }
      if (account.channel !== "whatsapp") {
        throw new AppError("VALIDATION", "Catalog sync is only available for WhatsApp accounts.", { status: 400 });
      }
      return syncWhatsAppCatalog(
        {
          fetchFn: (url, init) => fetch(url, init as RequestInit),
          graphVersion: process.env.META_GRAPH_VERSION ?? "v26.0",
          resolveAccessToken: createCatalogTokenResolver(),
          store: {
            upsertProduct: async (row) => { await upsertCatalogProduct(defaultGetDatabase(), row); },
            listKeys: (accountId, catalogId) => listCatalogProductKeys(defaultGetDatabase(), accountId, catalogId),
            deleteProduct: async (id) => { await deleteCatalogProduct(defaultGetDatabase(), id); },
          },
        },
        { workspaceId: input.workspaceId, account, catalogId: input.catalogId },
      );
    },
    getAiProvider: () => createAIProviderFromEnv(process.env),
    adminStore: new DbAdminStore(defaultGetDatabase),
    platformSettings: new PlatformSettingsService(
      new DbPlatformSettingsStorage(defaultGetDatabase),
      {
        // baseEnv is the pristine env snapshot (the fallback source);
        // liveEnv IS process.env (=== deps.env), so a panel write applies
        // to this process immediately - see apps/api/src/index.ts for the
        // startup overlay + cross-process refresh.
        baseEnv,
        liveEnv: process.env,
        vaultKey: tryParseVaultKey(baseEnv.TOKEN_VAULT_KEY),
      },
    ),
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

export type AppEnv = { Variables: { workspaceId?: string; auth?: AuthContext; requestId?: string } };
type Ctx = Context<AppEnv>;


function errorBody(err: AppError) {
  return { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } };
}

/**
 * Postgres FK-violation detection (SQLSTATE 23503), tolerant of the
 * wrapping drizzle/postgres-js apply (the code may sit on err.cause).
 */
function isFkViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 3 && current; depth++) {
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === "23503") return true;
    if (typeof candidate.message === "string" && candidate.message.includes("violates foreign key constraint")) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
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

const publicUser = (user: AuthUser) => ({
  id: user.id, email: user.email, name: user.name, isPlatformAdmin: user.isPlatformAdmin,
});

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

// ------------------------------------------------- Fase 4 helpers (flows/OAuth)

/** Serialize a flows row for the API (jsonb fields pass through). */
function serializeFlow(row: FlowRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    trigger: row.trigger,
    graph: row.graph,
    status: row.status,
    createdAt: iso(row.createdAt) ?? "",
    updatedAt: iso(row.updatedAt) ?? "",
  };
}

/** Signed payload: base64url(JSON) + "." + base64url(HMAC-SHA256). */
export function signPayload(secret: string, payload: unknown): string {
  const part = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(part).digest("base64url");
  return `${part}.${sig}`;
}

export function verifyPayload<T extends { exp?: number }>(secret: string, signed: string): T | null {
  const parts = signed.split(".");
  if (parts.length !== 2) return null;
  const [part, sig] = parts as [string, string];
  const expected = createHmac("sha256", secret).update(part).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Signed OAuth state: { w: workspaceId, u: userId, ch: channel, m?: mode, exp }. */
export interface OAuthStatePayload { w: string; u: string; ch: string; m?: string; exp: number }

export function signOAuthState(secret: string, payload: OAuthStatePayload): string {
  return signPayload(secret, payload);
}

export function verifyOAuthState(secret: string, state: string): OAuthStatePayload | null {
  const payload = verifyPayload<OAuthStatePayload>(secret, state);
  if (!payload || !payload.w || !payload.u || !payload.ch) return null;
  return payload;
}

/** Public base URL of THIS API as registered with providers (no trailing /). */
function publicApiBase(deps: ApiDeps, c: Ctx): string {
  const fromEnv = deps.env.PUBLIC_WEBHOOK_BASE_URL ?? deps.env.APP_PUBLIC_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return new URL(c.req.url).origin;
}

function oauthRedirectUri(deps: ApiDeps, c: Ctx, channel: string): string {
  return `${publicApiBase(deps, c)}/channels/${channel}/oauth/callback`;
}

/** Where OAuth callbacks send the browser back to (the SPA channels page). */
function spaChannelsUrl(deps: ApiDeps, c: Ctx, params: Record<string, string>): string {
  const base = (deps.env.APP_PUBLIC_URL ?? publicApiBase(deps, c)).replace(/\/$/, "");
  const query = new URLSearchParams(params).toString();
  return `${base}/#/channels?${query}`;
}

/** SESSION_SECRET or an honest 503 - OAuth state cannot be signed without it. */
function oauthSecret(deps: ApiDeps): string {
  const secret = deps.env.SESSION_SECRET;
  if (!secret) {
    throw new AppError(
      "CONFIGURATION",
      "SESSION_SECRET is not configured on this server; OAuth connect flows are unavailable.",
      { status: 503 },
    );
  }
  return secret;
}

const flowTriggerInputSchema = z.object({
  type: z.enum(["keyword", "postback", "manual", "comment_keyword"]),
  config: z.record(z.unknown()).default({}),
}).openapi("FlowTriggerInput");

const flowBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  trigger: flowTriggerInputSchema.optional(),
  graph: storedGraphSchema.optional(),
}).openapi("FlowBody");

const flowResponseSchema = z.object({
  id: z.string(), workspaceId: z.string(), name: z.string(),
  trigger: z.unknown(), graph: z.unknown(), status: z.string(),
  createdAt: z.string(), updatedAt: z.string(),
}).openapi("Flow");

const flowTestRunBodySchema = z.object({
  text: z.string().max(4000).optional(),
  contactFields: z.record(z.string()).optional(),
}).openapi("FlowTestRunBody");

const telegramConnectBodySchema = z.object({
  botToken: z.string().min(10).max(200),
  label: z.string().min(1).max(120).optional(),
}).openapi("TelegramConnectBody");

const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
}).openapi("ChangePasswordBody");

const patchMeBodySchema = z.object({ name: z.string().min(1).max(120) }).openapi("PatchMeBody");
const renameWorkspaceBodySchema = z.object({ name: z.string().min(1).max(120) }).openapi("RenameWorkspaceBody");
const memberRoleBodySchema = z.object({ role: z.enum(ROLES) }).openapi("MemberRoleBody");
const messengerSelectPageBodySchema = z.object({ pageId: z.string().min(1) }).openapi("MessengerSelectPageBody");

const MESSENGER_PENDING_COOKIE = "botara_msgr_pending";

interface MessengerPendingPayload {
  w: string;
  pages: Array<{ id: string; name: string; t: string }>;
  exp: number;
}

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

  // ------------------------------------- observability + security (Fase 3)
  // Registered FIRST so they wrap every route below. Single-process,
  // dependency-light implementations on purpose (see docs/runbook.md for
  // the multi-instance caveats).

  /**
   * Structured JSON request log: one line per request with a request id
   * (also returned as x-request-id). NEVER logs bodies, headers, or tokens.
   */
  const requestLogger = async (c: Ctx, next: Next) => {
    const requestId = crypto.randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    const started = performance.now();
    let status = 500;
    try {
      await next();
      status = c.res.status;
    } catch (err) {
      status = err instanceof AppError ? err.status : 500;
      throw err;
    } finally {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        service: "api",
        requestId,
        method: c.req.method,
        path: c.req.path,
        status,
        ms: Math.round(performance.now() - started),
      }));
    }
  };
  app.use("*", requestLogger);

  /** Baseline hardening headers on every response; HSTS only behind https. */
  const securityHeaders = async (c: Ctx, next: Next) => {
    c.header("x-content-type-options", "nosniff");
    c.header("x-frame-options", "DENY");
    c.header("referrer-policy", "no-referrer");
    const proto = c.req.header("x-forwarded-proto")
      ?? new URL(c.req.url).protocol.replace(":", "");
    if (proto === "https") {
      c.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    await next();
  };
  app.use("*", securityHeaders);

  /**
   * CORS: default DENY cross-origin. Dashboard origins opt in via
   * CORS_ORIGINS (comma-separated, exact match, credentials allowed). The
   * public webchat endpoints are the one permissive exception - the widget
   * is embedded on arbitrary customer sites and authenticates with its own
   * session-token header, never cookies.
   */
  const corsMiddleware = async (c: Ctx, next: Next) => {
    const origin = c.req.header("origin");
    let granted = false;
    if (origin) {
      if (c.req.path.startsWith("/public/webchat/")) {
        c.header("access-control-allow-origin", "*");
        c.header("access-control-allow-headers", "content-type, x-webchat-session");
        granted = true;
      } else {
        const allowed = (deps.env.CORS_ORIGINS ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (allowed.includes(origin)) {
          c.header("access-control-allow-origin", origin);
          c.header("access-control-allow-credentials", "true");
          c.header("access-control-allow-headers", "content-type, authorization, x-workspace-id");
          c.header("vary", "Origin");
          granted = true;
        }
      }
    }
    if (c.req.method === "OPTIONS" && granted) {
      c.header("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
      c.header("access-control-max-age", "600");
      return c.body(null, 204);
    }
    await next();
  };
  app.use("*", corsMiddleware);

  /**
   * In-process fixed-window rate limiter for the abuse-prone surfaces
   * (/auth/* credential guessing, /public/* widget spam). SINGLE-INSTANCE
   * assumption: buckets live in this process's memory - behind multiple
   * API replicas the effective limit multiplies by the replica count;
   * move to Redis before scaling out (docs/runbook.md).
   */
  const rateBuckets = new Map<string, { count: number; resetAt: number }>();
  const createRateLimiter = (scope: string, limit: number) => async (c: Ctx, next: Next) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      ?? c.req.header("x-real-ip")
      ?? "unknown";
    const key = `${scope}:${ip}`;
    const now = Date.now();
    if (rateBuckets.size > 10_000) {
      for (const [k, b] of rateBuckets) if (b.resetAt <= now) rateBuckets.delete(k);
    }
    let bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + 60_000 };
      rateBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > limit) {
      c.header("retry-after", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      throw new AppError(
        "RATE_LIMITED",
        "Too many requests - please slow down and retry shortly.",
        { status: 429, details: { scope, limitPerMinute: limit } },
      );
    }
    await next();
  };
  app.use("/auth/*", createRateLimiter("auth", deps.rateLimits?.authPerMinute ?? 20));
  app.use("/public/*", createRateLimiter("public", deps.rateLimits?.publicPerMinute ?? 120));
  // Stateless operator utilities (moderation check) are metered too:
  // authenticated does not mean unmetered (parity audit B2/R9).
  app.use("/moderation", createRateLimiter("utility", deps.rateLimits?.utilityPerMinute ?? 60));
  app.use("/moderation/*", createRateLimiter("utility", deps.rateLimits?.utilityPerMinute ?? 60));

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
    // Personal API tokens (adopted features): a Bearer `bta_...` token
    // resolves through the token store (SHA-256 hash lookup, revocation
    // honored) and authenticates as its user - workspace membership checks
    // then apply identically to the JWT path. No SESSION_SECRET involved.
    if (token.startsWith(API_TOKEN_PREFIX)) {
      const user = await deps.authStore.findUserByApiToken(token);
      if (!user) {
        throw new AppError("UNAUTHORIZED", "API token is invalid or revoked.", { status: 401 });
      }
      return user;
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
    // Browser top-level flows (the OAuth connect links) cannot send headers,
    // so GET requests may select the workspace via ?workspace_id= instead.
    // The membership verification below applies identically either way.
    // Mutating methods stay header-only, so the selector cannot be ridden
    // in cross-site on a victim's cookie session.
    const selectedWorkspace =
      c.req.header("x-workspace-id") ??
      (c.req.method === "GET" ? c.req.query("workspace_id") : undefined);
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

  /**
   * Readiness (Fase 3): /health says the process is up; /health/ready says
   * it can actually serve - it pings Postgres (SELECT 1) and Redis (PING)
   * through the injected probes and answers 503 with a per-dependency
   * breakdown when either is down.
   */
  app.get("/health/ready", async (c) => {
    const [database, redis] = await Promise.all([
      deps.readiness.checkDatabase(),
      deps.readiness.checkRedis(),
    ]);
    const ready = database.ok && redis.ok;
    return c.json(
      { status: ready ? "ready" : "not-ready", service: "api", dependencies: { database, redis } },
      ready ? 200 : 503,
    );
  });

  app.get("/", (c) => c.json({ name: "botara-api" }));

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
      // Platform-admin bootstrap (product rule): the FIRST registered
      // user of a fresh deployment becomes its operator. The store
      // re-checks the empty-table condition atomically at insert time,
      // so two concurrent first registrations cannot both win the flag.
      const isFirstUser = (await deps.authStore.countUsers()) === 0;
      user = await deps.authStore.createUser({
        email, name: body.name, passwordHash, isPlatformAdmin: isFirstUser,
      });
    }
    // Every new user starts with a personal workspace they own.
    const displayName = body.name ?? user.name ?? email.split("@")[0]!;
    const workspace = await createWorkspaceWithUniqueSlug(`${displayName}'s Workspace`);
    await deps.authStore.addMember({ workspaceId: workspace.id, userId: user.id, role: "owner" });
    await deps.authStore.audit({
      workspaceId: workspace.id, userId: user.id, action: "auth.register",
      details: { email, platformAdmin: user.isPlatformAdmin },
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
    // Stamp the login - the admin panel's "active users" counts read this.
    await deps.authStore.touchLastLogin(user.id);
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

  // ------------------------------------------------- profile & password (Fase 4)
  const patchMeRoute = createRoute({
    method: "patch", path: "/auth/me",
    request: { body: { content: { "application/json": { schema: patchMeBodySchema } }, required: true } },
    responses: { 200: { description: "Updated user" } },
  });
  app.openapi(patchMeRoute, async (c) => {
    const user = await authenticateRequest(c);
    const body = c.req.valid("json");
    await deps.authStore.updateUserName(user.id, body.name.trim());
    const updated = await deps.authStore.findUserById(user.id);
    return c.json({ user: publicUser(updated ?? user) });
  });

  const changePasswordRoute = createRoute({
    method: "post", path: "/auth/change-password",
    request: { body: { content: { "application/json": { schema: changePasswordBodySchema } }, required: true } },
    responses: { 200: { description: "Password changed" } },
  });
  app.openapi(changePasswordRoute, async (c) => {
    const user = await authenticateRequest(c);
    const body = c.req.valid("json");
    const ok = user.passwordHash
      ? await verifyPassword(body.currentPassword, user.passwordHash)
      : false;
    if (!ok) {
      throw new AppError("VALIDATION", "Current password is incorrect.", { status: 400 });
    }
    const passwordHash = await hashPassword(body.newPassword);
    await deps.authStore.setPasswordHash(user.id, passwordHash);
    await deps.authStore.audit({ userId: user.id, action: "auth.change_password", details: {} });
    return c.json({ ok: true as const });
  });

  // ------------------------------------------- API tokens (adopted features)
  // Personal API tokens power the MCP server and third-party API access.
  // The raw token (bta_...) is returned ONCE at creation; only its SHA-256
  // hash is stored. Bearer bta_ tokens authenticate anywhere a session JWT
  // does (see authenticateRequest), with identical workspace membership
  // checks - a token is exactly as powerful as its user, so Settings is
  // where they are created and revoked.

  const createApiTokenRoute = createRoute({
    method: "post", path: "/auth/tokens",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ name: z.string().min(1).max(120) }),
          },
        },
      },
    },
    responses: { 201: { description: "API token created; raw token returned ONCE" } },
  });
  app.openapi(createApiTokenRoute, async (c) => {
    const user = await authenticateRequest(c);
    const { raw, token } = await deps.authStore.createApiToken(user.id, c.req.valid("json").name.trim());
    await deps.authStore.audit({ userId: user.id, action: "auth.token.create", details: { tokenId: token.id, name: token.name } });
    return c.json({ token: raw, tokenInfo: token }, 201);
  });

  const listApiTokensRoute = createRoute({
    method: "get", path: "/auth/tokens",
    responses: { 200: { description: "API token metadata (never raw tokens)" } },
  });
  app.openapi(listApiTokensRoute, async (c) => {
    const user = await authenticateRequest(c);
    return c.json({ tokens: await deps.authStore.listApiTokens(user.id) });
  });

  const revokeApiTokenRoute = createRoute({
    method: "delete", path: "/auth/tokens/{id}",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "API token revoked" } },
  });
  app.openapi(revokeApiTokenRoute, async (c) => {
    const user = await authenticateRequest(c);
    const revoked = await deps.authStore.revokeApiToken(user.id, c.req.valid("param").id);
    if (!revoked) throw new AppError("NOT_FOUND", "API token not found (or already revoked).", { status: 404 });
    await deps.authStore.audit({ userId: user.id, action: "auth.token.revoke", details: { tokenId: c.req.valid("param").id } });
    return c.json({ revoked: true });
  });

  // --------------------------------------------------- public config (Fase 4)
  // Non-secret client configuration for the web app (Embedded Signup ids and
  // the public base URL). NEVER includes secrets - only public app ids.
  app.get("/config/public", (c) => c.json({
    metaAppId: deps.env.META_APP_ID ?? null,
    whatsappEmbeddedConfigId: deps.env.WHATSAPP_EMBEDDED_CONFIG_ID ?? null,
    instagramAppId: deps.env.INSTAGRAM_APP_ID ?? null,
    threadsAppId: deps.env.THREADS_APP_ID ?? null,
    tiktokAppId: deps.env.TIKTOK_APP_ID ?? null,
    publicWebhookBaseUrl: deps.env.PUBLIC_WEBHOOK_BASE_URL ?? deps.env.APP_PUBLIC_URL ?? null,
  }));

  // ------------------------------------------------ platform admin (operator panel)
  // Deployment-scoped operator surface (NOT workspace-scoped): overview,
  // users, workspaces, billing visibility, platform settings (DB-managed
  // with env fallback), audit trail, platform-admin grants. Guard +
  // handlers live in ./admin.ts; they authenticate via the same session
  // machinery and require users.is_platform_admin.
  registerAdminRoutes(app, {
    authenticate: authenticateRequest,
    authStore: deps.authStore,
    adminStore: deps.adminStore,
    platformSettings: deps.platformSettings,
    publicApiBase: (c) => publicApiBase(deps, c),
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
    // Fase 4: persist inbound messages + match flow triggers. The
    // dispatcher never throws - the provider still gets its 200.
    await deps.flowDispatcher.dispatch(events);
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
    await deps.flowDispatcher.dispatch(events);
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
      await deps.flowDispatcher.dispatch(events);
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
    await deps.flowDispatcher.dispatch(events);
    return c.json({ received: true, events: events.length });
  });

  app.post("/webhooks/tiktok", async (c) => {
    const raw = await c.req.text();
    // Signature verification is a PLACEHOLDER (HMAC-SHA256 of the raw
    // body with the app secret): TikTok's real Business Messaging scheme
    // is in partner-gated docs and could not be sourced - see
    // verifyTikTokWebhookSignature in @botara/channels and
    // docs/tiktok.md. Enforced only when TIKTOK_APP_SECRET is set, the
    // same pattern as the Meta webhooks above.
    const appSecret = deps.env.TIKTOK_APP_SECRET;
    if (appSecret && !verifyTikTokWebhookSignature(
      raw,
      c.req.header("x-tiktok-signature") ?? c.req.header("x-signature"),
      appSecret,
    )) {
      throw new AppError("UNAUTHORIZED", "Invalid TikTok webhook signature (placeholder scheme).", { status: 401 });
    }
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch {
      throw new AppError("VALIDATION", "Webhook body is not valid JSON.", { status: 400 });
    }
    const events = await getAdapter("tiktok").parseWebhook(payload);
    await deps.eventSink.handle(events);
    await deps.flowDispatcher.dispatch(events);
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
    const base = publicApiBase(deps, c);
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

  // ------------------------------------- channel OAuth callbacks (Fase 4)
  // Registered BEFORE the auth middleware: the provider's redirect carries
  // no session header - authorization comes from the signed `state`
  // (workspace + user ids, HMAC with SESSION_SECRET, expiring).

  /** Persist (or re-connect) a channel account whose token lives in the vault. */
  async function persistConnectedAccount(input: {
    workspaceId: string; channel: string; externalId: string; displayName?: string;
    avatarUrl?: string;
    authMode?: string; tokenVaultRef: string; tokenExpiresAt?: Date;
    capabilities?: Record<string, unknown>; isCoexistence?: boolean;
  }): Promise<{ id: string; created: boolean }> {
    const db = deps.getDatabase();
    const existing = (await listChannelAccounts(db, input.workspaceId))
      .find((a) => a.channel === input.channel && a.externalId === input.externalId);
    if (existing) {
      await updateChannelAccountToken(db, existing.id, {
        tokenVaultRef: input.tokenVaultRef,
        tokenExpiresAt: input.tokenExpiresAt ?? null,
        status: "connected",
        // Item G: reconnecting cancels the retention countdown.
        disconnectedAt: null,
      });
      // Re-connect refreshes the picture when the provider gave one; a
      // missing picture keeps the previously captured URL.
      if (input.avatarUrl) {
        await updateChannelAccountAvatar(db, existing.id, input.avatarUrl);
      }
      return { id: existing.id, created: false };
    }
    const row = await createChannelAccount(db, input);
    return { id: row.id, created: true };
  }

  const oauthFail = (c: Ctx, channel: string, reason: string) =>
    c.redirect(spaChannelsUrl(deps, c, { error: reason, channel }), 302);

  app.get("/channels/threads/oauth/callback", async (c) => {
    const code = c.req.query("code");
    const stateParam = c.req.query("state");
    const appId = deps.env.THREADS_APP_ID;
    const appSecret = deps.env.THREADS_APP_SECRET;
    if (!code || !stateParam || !appId || !appSecret) return oauthFail(c, "threads", "oauth_config");
    let state: OAuthStatePayload | null = null;
    try { state = verifyOAuthState(oauthSecret(deps), stateParam); } catch { state = null; }
    if (!state || state.ch !== "threads") return oauthFail(c, "threads", "invalid_state");
    try {
      const adapter = new ThreadsAdapter({
        credentials: new StaticCredentialProvider({}),
        fetchFn: deps.providerFetch,
      });
      const redirectUri = oauthRedirectUri(deps, c, "threads");
      const short = await adapter.exchangeCode({ appId, appSecret, code, redirectUri });
      const long = await adapter.exchangeShortLivedToken({ shortLivedToken: short.accessToken, appSecret });
      // Canonical identity comes from /me (string id + username); the
      // exchange's user id is only a fallback if the profile call fails.
      let externalId = short.userId;
      let username: string | undefined;
      let avatarUrl: string | undefined;
      try {
        const profile = await adapter.getProfile({ accessToken: long.accessToken });
        if (profile.userId) externalId = profile.userId;
        username = profile.username;
        avatarUrl = profile.avatarUrl;
      } catch { /* identity/display name/avatar are best-effort only */ }
      const ref = await deps.vault.store({
        channel: "threads", workspaceId: state.w,
        label: username ? `@${username}` : externalId, secret: long.accessToken,
      });
      await persistConnectedAccount({
        workspaceId: state.w, channel: "threads", externalId,
        displayName: username ? `@${username}` : externalId, avatarUrl, authMode: "threads-oauth",
        tokenVaultRef: ref, tokenExpiresAt: new Date(long.expiresAt),
      });
      await deps.authStore.audit({ workspaceId: state.w, userId: state.u, action: "channel.connected", details: { channel: "threads" } })
        .catch(() => undefined);
      return c.redirect(spaChannelsUrl(deps, c, { connected: "threads" }), 302);
    } catch (err) {
      console.error(`[api] threads oauth callback failed: ${err instanceof Error ? err.message : String(err)}`);
      return oauthFail(c, "threads", "oauth_failed");
    }
  });

  app.get("/channels/instagram/oauth/callback", async (c) => {
    const code = c.req.query("code");
    const stateParam = c.req.query("state");
    if (!code || !stateParam) return oauthFail(c, "instagram", "oauth_config");
    let state: OAuthStatePayload | null = null;
    try { state = verifyOAuthState(oauthSecret(deps), stateParam); } catch { state = null; }
    if (!state || state.ch !== "instagram") return oauthFail(c, "instagram", "invalid_state");
    const mode: InstagramAuthMode = state.m === "facebook-login" ? "facebook-login" : "instagram-login";
    const appId = mode === "instagram-login"
      ? (deps.env.INSTAGRAM_APP_ID ?? deps.env.META_APP_ID)
      : deps.env.META_APP_ID;
    const appSecret = mode === "instagram-login"
      ? (deps.env.INSTAGRAM_APP_SECRET ?? deps.env.META_APP_SECRET)
      : deps.env.META_APP_SECRET;
    if (!appId || !appSecret) return oauthFail(c, "instagram", "oauth_config");
    try {
      const adapter = new InstagramAdapter({
        credentials: new StaticCredentialProvider({}), fetchFn: deps.providerFetch,
      });
      const redirectUri = oauthRedirectUri(deps, c, "instagram");
      const exchanged = await adapter.exchangeCode({ mode, appId, appSecret, code, redirectUri });
      if (mode === "instagram-login") {
        if (!exchanged.externalUserId) return oauthFail(c, "instagram", "oauth_failed");
        let username: string | undefined;
        let avatarUrl: string | undefined;
        try {
          const res = await deps.providerFetch(
            `https://graph.instagram.com/${adapter.apiVersion}/me?fields=username,profile_picture_url&access_token=${encodeURIComponent(exchanged.accessToken)}`,
          );
          const json = (await res.json().catch(() => ({}))) as { username?: string; profile_picture_url?: string };
          username = json.username;
          avatarUrl = json.profile_picture_url;
        } catch { /* best-effort */ }
        const ref = await deps.vault.store({
          channel: "instagram", workspaceId: state.w,
          label: username ? `@${username}` : exchanged.externalUserId, secret: exchanged.accessToken,
        });
        await persistConnectedAccount({
          workspaceId: state.w, channel: "instagram", externalId: exchanged.externalUserId,
          displayName: username ? `@${username}` : exchanged.externalUserId,
          avatarUrl,
          authMode: "instagram-login", tokenVaultRef: ref,
          tokenExpiresAt: exchanged.expiresAt ? new Date(exchanged.expiresAt) : undefined,
        });
      } else {
        // Facebook Login: the user token must reach a Page that has an
        // Instagram business account linked; the PAGE token is what sends.
        const pagesRes = await deps.providerFetch(
          `https://graph.facebook.com/${adapter.apiVersion}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,profile_picture_url}&access_token=${encodeURIComponent(exchanged.accessToken)}`,
        );
        const pagesJson = (await pagesRes.json().catch(() => ({}))) as {
          data?: Array<{
            id: string; name: string; access_token: string;
            instagram_business_account?: { id: string; username?: string; profile_picture_url?: string };
          }>;
          error?: unknown;
        };
        if (!pagesRes.ok || pagesJson.error) return oauthFail(c, "instagram", "oauth_failed");
        const page = (pagesJson.data ?? []).find((p) => p.instagram_business_account?.id);
        if (!page?.instagram_business_account) return oauthFail(c, "instagram", "no_instagram_account");
        const ig = page.instagram_business_account;
        const ref = await deps.vault.store({
          channel: "instagram", workspaceId: state.w,
          label: ig.username ? `@${ig.username}` : ig.id, secret: page.access_token,
        });
        await persistConnectedAccount({
          workspaceId: state.w, channel: "instagram", externalId: ig.id,
          displayName: ig.username ? `@${ig.username}` : page.name,
          avatarUrl: ig.profile_picture_url,
          authMode: "facebook-login", tokenVaultRef: ref,
        });
      }
      await deps.authStore.audit({ workspaceId: state.w, userId: state.u, action: "channel.connected", details: { channel: "instagram", mode } })
        .catch(() => undefined);
      return c.redirect(spaChannelsUrl(deps, c, { connected: "instagram" }), 302);
    } catch (err) {
      console.error(`[api] instagram oauth callback failed: ${err instanceof Error ? err.message : String(err)}`);
      return oauthFail(c, "instagram", "oauth_failed");
    }
  });

  app.get("/channels/messenger/oauth/callback", async (c) => {
    const code = c.req.query("code");
    const stateParam = c.req.query("state");
    const appId = deps.env.META_APP_ID;
    const appSecret = deps.env.META_APP_SECRET;
    if (!code || !stateParam || !appId || !appSecret) return oauthFail(c, "messenger", "oauth_config");
    let state: OAuthStatePayload | null = null;
    try { state = verifyOAuthState(oauthSecret(deps), stateParam); } catch { state = null; }
    if (!state || state.ch !== "messenger") return oauthFail(c, "messenger", "invalid_state");
    try {
      const adapter = new MessengerAdapter({
        credentials: new StaticCredentialProvider({}), fetchFn: deps.providerFetch,
      });
      const redirectUri = oauthRedirectUri(deps, c, "messenger");
      const { userAccessToken } = await adapter.exchangeCode({ appId, appSecret, code, redirectUri });
      const pages = await adapter.listPages(userAccessToken);
      if (pages.length === 0) return oauthFail(c, "messenger", "no_page");
      if (pages.length === 1) {
        const page = pages[0]!;
        const ref = await deps.vault.store({
          channel: "messenger", workspaceId: state.w, label: page.name, secret: page.accessToken,
        });
        const avatarUrl = await adapter.fetchPagePictureUrl({ pageId: page.id, pageAccessToken: page.accessToken }) ?? undefined;
        await persistConnectedAccount({
          workspaceId: state.w, channel: "messenger", externalId: page.id,
          displayName: page.name, avatarUrl, authMode: "facebook-login", tokenVaultRef: ref,
        });
        await deps.authStore.audit({ workspaceId: state.w, userId: state.u, action: "channel.connected", details: { channel: "messenger" } })
          .catch(() => undefined);
        return c.redirect(spaChannelsUrl(deps, c, { connected: "messenger" }), 302);
      }
      // Multiple Pages: stash the selection (page ids + tokens) in a
      // short-lived SIGNED httpOnly cookie; the SPA picker posts the choice
      // to /channels/messenger/select-page, which vaults the picked token.
      const secret = oauthSecret(deps);
      const pending: MessengerPendingPayload = {
        w: state.w,
        pages: pages.map((p) => ({ id: p.id, name: p.name, t: p.accessToken })),
        exp: Math.floor(Date.now() / 1000) + 600,
      };
      setCookie(c, MESSENGER_PENDING_COOKIE, signPayload(secret, pending), {
        httpOnly: true, path: "/", sameSite: "Lax", maxAge: 600,
        secure: c.req.header("x-forwarded-proto") === "https",
      });
      return c.redirect(spaChannelsUrl(deps, c, { messenger: "select" }), 302);
    } catch (err) {
      console.error(`[api] messenger oauth callback failed: ${err instanceof Error ? err.message : String(err)}`);
      return oauthFail(c, "messenger", "oauth_failed");
    }
  });

  app.get("/channels/tiktok/oauth/callback", async (c) => {
    // TikTok denial arrives as ?error=... (no code): surface it honestly.
    if (c.req.query("error")) return oauthFail(c, "tiktok", "oauth_failed");
    const code = c.req.query("code");
    const stateParam = c.req.query("state");
    const appId = deps.env.TIKTOK_APP_ID;
    const appSecret = deps.env.TIKTOK_APP_SECRET;
    if (!code || !stateParam || !appId || !appSecret) return oauthFail(c, "tiktok", "oauth_config");
    let state: OAuthStatePayload | null = null;
    try { state = verifyOAuthState(oauthSecret(deps), stateParam); } catch { state = null; }
    if (!state || state.ch !== "tiktok") return oauthFail(c, "tiktok", "invalid_state");
    try {
      const adapter = new TikTokAdapter({
        credentials: new StaticCredentialProvider({}),
        fetchFn: deps.providerFetch,
      });
      const redirectUri = oauthRedirectUri(deps, c, "tiktok");
      const pair = await adapter.exchangeCode({ appId, appSecret, code, redirectUri });
      if (!pair.openId) return oauthFail(c, "tiktok", "oauth_failed");
      let displayName: string | undefined;
      try {
        displayName = (await adapter.fetchUserProfile(pair.accessToken)).displayName;
      } catch { /* display name is best-effort only */ }
      // The vault secret is the whole token pair as one JSON string: the
      // access token alone is useless in 24h without its refresh token.
      const ref = await deps.vault.store({
        channel: "tiktok", workspaceId: state.w,
        label: displayName ?? pair.openId, secret: serializeTikTokTokenPair(pair),
      });
      await persistConnectedAccount({
        workspaceId: state.w, channel: "tiktok", externalId: pair.openId,
        displayName: displayName ?? pair.openId, authMode: "oauth",
        tokenVaultRef: ref,
        tokenExpiresAt: pair.expiresAt ? new Date(pair.expiresAt) : undefined,
      });
      await deps.authStore.audit({ workspaceId: state.w, userId: state.u, action: "channel.connected", details: { channel: "tiktok" } })
        .catch(() => undefined);
      return c.redirect(spaChannelsUrl(deps, c, { connected: "tiktok" }), 302);
    } catch (err) {
      console.error(`[api] tiktok oauth callback failed: ${err instanceof Error ? err.message : String(err)}`);
      return oauthFail(c, "tiktok", "oauth_failed");
    }
  });

  // ------------------------------------------- auth context middleware
  // Fase 3: every workspace-scoped route runs behind session auth +
  // verified workspace membership (see resolveAuthContext). Registered
  // BEFORE the routes it protects (Hono applies use() in order). The one
  // documented bypass is POST /broadcasts/estimate - a pure calculator over
  // the request body that touches no workspace data. POST /moderation/check
  // was a second, undocumented public surface until the parity audit (B2);
  // it now sits behind this middleware like every other operator utility.
  const authMiddleware = async (c: Ctx, next: Next) => {
    if (c.req.path === "/broadcasts/estimate") return next();
    const auth = await resolveAuthContext(c);
    c.set("auth", auth);
    if (auth.workspaceId) c.set("workspaceId", auth.workspaceId);
    await next();
  };
  for (const prefix of ["/conversations", "/contacts", "/segments", "/templates", "/broadcasts", "/channels", "/posts", "/sequences", "/workspaces", "/kb", "/flows", "/stats", "/growth-links", "/catalog-products", "/moderation"]) {
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

  // ----------------------------------------------------- settings (Fase 4)
  const renameWorkspaceRoute = createRoute({
    method: "patch", path: "/workspaces/{id}",
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { "application/json": { schema: renameWorkspaceBodySchema } }, required: true },
    },
    responses: { 200: { description: "Workspace renamed" } },
  });
  app.openapi(renameWorkspaceRoute, async (c) => {
    const { id } = c.req.valid("param");
    const auth = await requirePathWorkspaceRole(c, id, ADMIN_ROLES);
    await deps.authStore.renameWorkspace(id, c.req.valid("json").name.trim());
    await deps.authStore.audit({
      workspaceId: id, userId: auth.user.id,
      action: "workspace.rename", details: { name: c.req.valid("json").name },
    });
    const workspaces = await deps.authStore.listWorkspaces(auth.user.id);
    return c.json({ workspace: workspaces.find((w) => w.id === id) ?? null });
  });

  const memberRoleRoute = createRoute({
    method: "patch", path: "/workspaces/{id}/members/{userId}",
    request: {
      params: z.object({ id: z.string(), userId: z.string() }),
      body: { content: { "application/json": { schema: memberRoleBodySchema } }, required: true },
    },
    responses: { 200: { description: "Member role updated" } },
  });
  app.openapi(memberRoleRoute, async (c) => {
    const { id, userId } = c.req.valid("param");
    const auth = await requirePathWorkspaceRole(c, id, ADMIN_ROLES);
    const members = await deps.authStore.listMembers(id);
    const target = members.find((m) => m.userId === userId);
    if (!target) throw new AppError("NOT_FOUND", "Workspace member not found.", { status: 404 });
    const role = c.req.valid("json").role;
    if (target.role === "owner" && role !== "owner" && members.filter((m) => m.role === "owner").length <= 1) {
      throw new AppError("CONFLICT", "Cannot demote the workspace's only owner.", { status: 409 });
    }
    await deps.authStore.addMember({ workspaceId: id, userId, role });
    await deps.authStore.audit({
      workspaceId: id, userId: auth.user.id,
      action: "workspace.member.role", details: { memberUserId: userId, from: target.role, to: role },
    });
    return c.json({ member: { ...target, role } });
  });

  // ------------------------------------------------------------- flows (Fase 4)
  // CRUD + activation + test-run for automation flows. Graphs are validated
  // against the flow-engine node schemas (storedGraphSchema) on write; a
  // test-run executes the graph with recording fake ports and NEVER sends.

  const listFlowsRoute = createRoute({
    method: "get", path: "/flows",
    responses: { 200: { description: "Flows in the workspace" } },
  });
  app.openapi(listFlowsRoute, async (c) => {
    const wsId = workspaceId(c);
    const rows = await listFlows(deps.getDatabase(), wsId);
    return c.json({ flows: rows.map(serializeFlow) });
  });

  const createFlowRoute = createRoute({
    method: "post", path: "/flows",
    request: { body: { content: { "application/json": { schema: flowBodySchema } }, required: true } },
    responses: { 201: { description: "Flow created (draft)" } },
  });
  app.openapi(createFlowRoute, async (c) => {
    guardMutator(c);
    const wsId = workspaceId(c);
    const body = c.req.valid("json");
    if (!body.name || !body.graph) {
      throw new AppError("VALIDATION", "A flow needs a name and a graph.", { status: 400 });
    }
    const row = await createFlow(deps.getDatabase(), {
      workspaceId: wsId,
      name: body.name,
      trigger: body.trigger ?? { type: "manual", config: {} },
      graph: body.graph,
    });
    return c.json({ flow: serializeFlow(row) }, 201);
  });

  const getFlowRoute = createRoute({
    method: "get", path: "/flows/{id}",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "One flow" } },
  });
  app.openapi(getFlowRoute, async (c) => {
    const wsId = workspaceId(c);
    const row = await getFlow(deps.getDatabase(), wsId, c.req.valid("param").id);
    if (!row) throw new AppError("NOT_FOUND", "Flow not found.", { status: 404 });
    return c.json({ flow: serializeFlow(row) });
  });

  const patchFlowRoute = createRoute({
    method: "patch", path: "/flows/{id}",
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { "application/json": { schema: flowBodySchema } }, required: true },
    },
    responses: { 200: { description: "Flow updated" } },
  });
  app.openapi(patchFlowRoute, async (c) => {
    guardMutator(c);
    const wsId = workspaceId(c);
    const body = c.req.valid("json");
    const row = await updateFlow(deps.getDatabase(), wsId, c.req.valid("param").id, {
      name: body.name,
      trigger: body.trigger,
      graph: body.graph,
    });
    if (!row) throw new AppError("NOT_FOUND", "Flow not found.", { status: 404 });
    return c.json({ flow: serializeFlow(row) });
  });

  const deleteFlowRoute = createRoute({
    method: "delete", path: "/flows/{id}",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Flow deleted" } },
  });
  app.openapi(deleteFlowRoute, async (c) => {
    guardMutator(c);
    const wsId = workspaceId(c);
    const removed = await deleteFlow(deps.getDatabase(), wsId, c.req.valid("param").id);
    if (!removed) throw new AppError("NOT_FOUND", "Flow not found.", { status: 404 });
    return c.json({ deleted: true });
  });

  for (const action of ["activate", "deactivate"] as const) {
    const route = createRoute({
      method: "post", path: `/flows/{id}/${action}`,
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: { description: `Flow ${action}d` } },
    });
    app.openapi(route, async (c) => {
      guardMutator(c);
      const wsId = workspaceId(c);
      const row = await updateFlow(deps.getDatabase(), wsId, c.req.valid("param").id, {
        status: action === "activate" ? "active" : "draft",
      });
      if (!row) throw new AppError("NOT_FOUND", "Flow not found.", { status: 404 });
      return c.json({ flow: serializeFlow(row) });
    });
  }

  const flowTestRunRoute = createRoute({
    method: "post", path: "/flows/{id}/test-run",
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { "application/json": { schema: flowTestRunBodySchema } }, required: true },
    },
    responses: { 200: { description: "Recorded actions from a dry run (nothing sent)" } },
  });
  app.openapi(flowTestRunRoute, async (c) => {
    guardMutator(c);
    const wsId = workspaceId(c);
    const row = await getFlow(deps.getDatabase(), wsId, c.req.valid("param").id);
    if (!row) throw new AppError("NOT_FOUND", "Flow not found.", { status: 404 });
    const parsed = storedGraphSchema.safeParse(row.graph);
    if (!parsed.success) {
      throw new AppError("VALIDATION", "The stored flow graph is invalid and cannot run.", {
        status: 400, details: parsed.error.issues,
      });
    }
    const body = c.req.valid("json");
    const variables: Record<string, string> = { ...(body.contactFields ?? {}) };
    // Recording fake ports: the run's observable effects ARE the response.
    const ports = {
      async sendMessage() { /* recorded via the returned action list */ },
      async scheduleDelay() { /* recorded */ },
      async httpWebhook() { /* recorded */ },
      async setContactField() { /* recorded */ },
      async aiReply(input: { prompt: string }) {
        return `[test-run AI reply] ${input.prompt}`.trim();
      },
    };
    const flow = toRunnableFlow(row.id, parsed.data);
    const result = await runFlow(ports, flow, undefined, {
      type: "message.received",
      text: body.text ?? "",
      variables,
    });
    const actions: FlowAction[] = result.executed;
    return c.json({
      status: result.state.status,
      paused: result.paused,
      actions,
      variables: result.state.variables,
    });
  });

  // ------------------------------------------------------------- stats (Fase 4)
  const statsOverviewRoute = createRoute({
    method: "get", path: "/stats/overview",
    responses: { 200: { description: "Dashboard overview aggregations" } },
  });
  app.openapi(statsOverviewRoute, async (c) => {
    const wsId = workspaceId(c);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    const stats = await getWorkspaceStats(deps.getDatabase(), wsId, monthStart, thirtyDaysAgo);
    const conversations = await listConversations(deps.getDatabase(), wsId);
    return c.json({
      contacts: { total: stats.contactsTotal },
      conversations: { open: stats.conversationsOpen, total: stats.conversationsTotal },
      messagesLast30d: stats.messagesLast30d,
      broadcastsThisMonth: stats.broadcastsThisMonth,
      costThisMonth: stats.costThisMonth,
      scheduledPostsPending: stats.scheduledPostsPending,
      activeFlows: stats.activeFlows,
      recentConversations: conversations.slice(0, 5).map((row) => ({
        id: row.id,
        channel: row.channel,
        status: row.status,
        contactDisplayName: row.contactDisplayName,
        contactExternalId: row.contactExternalId,
        updatedAt: iso(row.lastUserMessageAt) ?? iso(row.createdAt) ?? "",
      })),
    });
  });

  // --------------------------------------------------------- conversations
  /**
   * Shared conversation serializer: ISO dates, the 24h window flag, and
   * the assignee's display identity resolved from the workspace member
   * list (name/email are null when the assignee is no longer a member -
   * the id alone survives honestly).
   */
  const serializeConversation = (
    r: ConversationListItem,
    memberById: Map<string, { name: string | null; email: string }>,
  ) => ({
    ...r,
    createdAt: iso(r.createdAt),
    lastUserMessageAt: iso(r.lastUserMessageAt),
    windowOpen: evaluateReplyWindow({
      channel: r.channel, kind: "free_form", lastUserMessageAt: r.lastUserMessageAt, now: new Date(),
    }).windowOpen,
    assignee: r.assignedUserId
      ? {
          userId: r.assignedUserId,
          name: memberById.get(r.assignedUserId)?.name ?? null,
          email: memberById.get(r.assignedUserId)?.email ?? null,
        }
      : null,
  });
  const memberMapOf = async (ws: string) => {
    const members = await deps.authStore.listMembers(ws);
    return new Map(members.map((m) => [m.userId, { name: m.name, email: m.email }]));
  };

  const listConversationsRoute = createRoute({
    method: "get", path: "/conversations",
    request: {
      query: z.object({
        channel: z.string().optional(),
        /** Invalid values fail validation (400), like any bad enum. */
        status: z.enum(CONVERSATION_STATUSES).optional(),
        /** "me" = the caller, "unassigned", or a member user id; absent = all. */
        assignee: z.string().optional(),
      }),
    },
    responses: { 200: { description: "Conversations" } },
  });
  app.openapi(listConversationsRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { channel, status, assignee } = c.req.valid("query");
    const assignedTo = assignee === undefined
      ? undefined
      : assignee === "me"
        ? authContext(c).user.id
        : assignee === "unassigned"
          ? null
          : assignee;
    const rows = await listConversations(db, ws, { channel, status, assignedTo });
    const memberById = await memberMapOf(ws);
    return c.json({ conversations: rows.map((r) => serializeConversation(r, memberById)) });
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
              /** Rich block (buttons/list/carousel/product/catalog) for free-form replies. */
              rich: richBlockSchema.optional(),
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

    // A soft-disconnected account keeps its history but may not send:
    // fail BEFORE any message row is persisted or the adapter is called.
    if (account.status !== "connected") throw new ChannelAccountDisconnectedError(account.channel);

    // Window enforcement (fail closed): free-form replies outside the
    // window are rejected; template replies stay allowed. The window
    // length is per-channel (Meta 24h, TikTok 48h - see @botara/shared).
    const decision = evaluateReplyWindow({
      channel: conversation.channel,
      kind: body.kind,
      lastUserMessageAt: conversation.lastUserMessageAt,
      now: new Date(),
    });
    if (!decision.allowed) throw new MessagingWindowClosedError(conversation.channel);

    // Consecutive-outbound cap (TikTok: max 10 business messages since
    // the customer's last message). Counted from the persisted rows -
    // the same counter the worker's send processor uses, so the rule
    // cannot drift between the inbox and automation sends.
    const caps = CHANNEL_CAPABILITIES[conversation.channel as ChannelKey];
    if (caps?.maxConsecutiveOutbound) {
      const rows = await listMessages(db, conversation.id);
      const consecutive = countConsecutiveOutbound(rows);
      if (consecutive >= caps.maxConsecutiveOutbound) {
        throw new ConsecutiveSendCapError(conversation.channel, caps.maxConsecutiveOutbound, consecutive);
      }
    }

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
    } else if (!body.text && !body.rich) {
      throw new AppError("VALIDATION", "text (or a rich block) is required for free-form replies.", { status: 400 });
    }

    const idempotencyKey = `reply:${id}:${crypto.randomUUID()}`;
    const message = await createMessage(db, {
      conversationId: id,
      direction: "out",
      type: body.kind === "template" ? "template" : body.rich ? "rich" : "text",
      // Rich messages persist as their formatted plain-text rendering so
      // the thread stays readable on every surface; the block itself
      // rides in `payload` (the webchat widget renders clickable
      // buttons/lists from it, the inbox thread shows read-only chips).
      body: body.kind === "template"
        ? templateInput!.name
        : body.rich ? richToPlainText(body.rich) : body.text,
      payload: body.kind === "free_form" && body.rich ? body.rich : undefined,
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
        text: body.kind === "free_form" ? (body.text ?? (body.rich ? richBlockText(body.rich) : undefined)) : undefined,
        rich: body.kind === "free_form" ? body.rich : undefined,
        template: templateInput,
        // Conversation-addressed channels (TikTok) send to the provider
        // conversation id learned from inbound events; the adapter
        // refuses typed when it is missing rather than guessing.
        conversationExternalId: conversation.externalId ?? undefined,
        idempotencyKey,
      });
      await updateMessageStatus(db, message.id, "sent", result.externalMessageId);
      // Live inbox: dashboards on this workspace refetch the thread.
      await deps.realtimePublisher.publishInboxMessage({
        workspaceId: ws, conversationId: id, direction: "out", messageId: message.id,
      }).catch(() => undefined);
      return c.json({
        message: { ...message, status: "sent", externalId: result.externalMessageId, createdAt: iso(message.createdAt) },
        window: decision,
        ...(result.warnings ? { warnings: result.warnings } : {}),
      });
    } catch (err) {
      await updateMessageStatus(db, message.id, "failed").catch(() => undefined);
      if (err instanceof AppError) throw err;
      throw new AppError("PROVIDER_ERROR", `Provider send failed: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
    }
  });

  const assignConversationRoute = createRoute({
    method: "patch", path: "/conversations/{id}/assign",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({ userId: z.string().min(1).nullable() }),
          },
        },
        required: true,
      },
    },
    responses: { 200: { description: "Conversation assignment updated" } },
  });
  app.openapi(assignConversationRoute, async (c) => {
    // Same role set that may reply in the inbox.
    requireRole(c.get("auth"), ROLES);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const { userId } = c.req.valid("json");

    const conversation = await getConversation(db, ws, id);
    if (!conversation) throw new AppError("NOT_FOUND", "Conversation not found.", { status: 404 });
    if (userId !== null) {
      // Only workspace members can own a conversation - anything else is
      // a client bug, answered with a typed 400 rather than a silent write.
      const membership = await deps.authStore.getMembership(ws, userId);
      if (!membership) {
        throw new AppError("VALIDATION", "Assignee must be a member of this workspace.", { status: 400 });
      }
    }
    const updated = await updateConversationAssignment(db, ws, id, userId);
    if (!updated) throw new AppError("NOT_FOUND", "Conversation not found.", { status: 404 });

    // Other open inboxes refresh their list + thread header (NATS-style
    // hint; the payload carries ids only, clients refetch over REST).
    await deps.realtimePublisher
      .publishInboxUpdate({ workspaceId: ws, conversationId: id })
      .catch(() => undefined);

    const memberById = await memberMapOf(ws);
    return c.json({
      conversation: serializeConversation({ ...conversation, assignedUserId: updated.assignedUserId }, memberById),
    });
  });

  const conversationStatusRoute = createRoute({
    method: "patch", path: "/conversations/{id}/status",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            // Enum at the schema edge: anything outside the three
            // statuses fails validation -> 400 VALIDATION (defaultHook),
            // never a silent write.
            schema: z.object({ status: z.enum(CONVERSATION_STATUSES) }),
          },
        },
        required: true,
      },
    },
    responses: { 200: { description: "Conversation status updated" } },
  });
  app.openapi(conversationStatusRoute, async (c) => {
    // Same role set that may reply in the inbox / assign conversations.
    requireRole(c.get("auth"), ROLES);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const { status } = c.req.valid("json");

    const conversation = await getConversation(db, ws, id);
    if (!conversation) throw new AppError("NOT_FOUND", "Conversation not found.", { status: 404 });
    // Any transition is allowed (open/pending/resolved in any order -
    // resolved -> open is how a thread gets reopened).
    const updated = await updateConversationStatus(db, ws, id, status);
    if (!updated) throw new AppError("NOT_FOUND", "Conversation not found.", { status: 404 });

    // Other open inboxes refresh their list + thread header; the new
    // status rides along as a hint (clients still refetch for truth).
    await deps.realtimePublisher
      .publishInboxUpdate({ workspaceId: ws, conversationId: id, status })
      .catch(() => undefined);

    const memberById = await memberMapOf(ws);
    return c.json({
      conversation: serializeConversation({ ...conversation, status: updated.status }, memberById),
    });
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

  const getContactRoute = createRoute({
    method: "get", path: "/contacts/{id}",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "One contact" } },
  });
  app.openapi(getContactRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const row = await getContact(db, ws, c.req.valid("param").id);
    if (!row) throw new AppError("NOT_FOUND", "Contact not found.", { status: 404 });
    return c.json({ contact: { ...row, createdAt: iso(row.createdAt) } });
  });

  // ------------------------------------- contact import / export (adopted)
  // Import: CSV (header-mapped) or JSON array, deduped within the file and
  // against the DB by (channel, externalId); per-row errors are reported,
  // never fatal to the batch. Export: the full workspace set in the same
  // column shape, as a download.

  const importContactsRoute = createRoute({
    method: "post", path: "/contacts/import",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              format: z.enum(["csv", "json"]),
              content: z.string().min(1).max(10_000_000),
              conflict: z.enum(["skip", "update"]).default("skip"),
            }),
          },
        },
      },
    },
    responses: { 200: { description: "Import summary: inserted / updated / skipped / per-row errors" } },
  });
  app.openapi(importContactsRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const body = c.req.valid("json");
    const parsed = parseImport(body.format, body.content); // throws past the 5000-row cap
    const db = deps.getDatabase();
    const deduped = dedupeImportRows(parsed.rows, body.conflict);
    let inserted = 0;
    let updated = 0;
    for (const row of deduped.rows) {
      const { created } = await upsertContactByExternal(db, {
        workspaceId: ws,
        channel: row.channel,
        externalId: row.externalId,
        displayName: row.displayName,
        tags: row.tags,
        customFields: row.customFields,
      }, body.conflict);
      if (created) inserted++;
      else if (body.conflict === "update") updated++;
    }
    // Skipped = in-file duplicates + rows that already existed in "skip"
    // mode (in "update" mode those same rows count as updated instead).
    const skipped = deduped.duplicates
      + (body.conflict === "skip" ? deduped.rows.length - inserted : 0);
    return c.json({
      inserted,
      updated,
      skipped,
      errors: parsed.errors,
    });
  });

  const exportContactsRoute = createRoute({
    method: "get", path: "/contacts/export",
    request: { query: z.object({ format: z.enum(["csv", "json"]).default("csv") }) },
    responses: { 200: { description: "Workspace contacts as a downloadable file" } },
  });
  app.openapi(exportContactsRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const format = c.req.valid("query").format;
    const rows = await listContacts(db, ws);
    const contacts = rows.map((r) => ({
      channel: r.channel,
      externalId: r.externalId,
      displayName: r.displayName,
      tags: (r.tags as string[]) ?? [],
      customFields: (r.customFields as Record<string, unknown>) ?? {},
    }));
    if (format === "json") {
      return c.body(contactsToJson(contacts), 200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": 'attachment; filename="contacts.json"',
      });
    }
    return c.body(contactsToCsv(contacts), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="contacts.csv"',
    });
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

  // ------------------------------------------------ growth links (adopted)
  // Short tracked links per channel account: /r/:slug counts the click and
  // 302s to the channel target; referral capture in the dispatcher counts
  // conversions and can run a bound flow. QR codes render server-side as
  // SVG (qrcode package, no native deps).

  const serializeGrowthLink = (row: GrowthLinkRow, c: Ctx) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    channelAccountId: row.channelAccountId,
    kind: row.kind,
    slug: row.slug,
    label: row.label,
    prefilledText: row.prefilledText,
    boundFlowId: row.boundFlowId,
    targetRef: row.targetRef,
    targetUrl: row.targetUrl,
    clicks: row.clicks,
    conversions: row.conversions,
    shortUrl: growthShortUrl(publicApiBase(deps, c), row.slug),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });

  const createGrowthLinkRoute = createRoute({
    method: "post", path: "/growth-links",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              channelAccountId: z.string().min(1),
              label: z.string().min(1).max(200),
              prefilledText: z.string().max(1000).optional(),
              boundFlowId: z.string().optional(),
              targetRef: z.string().max(200).optional(),
              targetUrl: z.string().url().max(2000).optional(),
            }),
          },
        },
      },
    },
    responses: { 201: { description: "Growth link created" } },
  });
  app.openapi(createGrowthLinkRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const body = c.req.valid("json");
    const account = await getChannelAccount(db, ws, body.channelAccountId);
    if (!account) throw new AppError("NOT_FOUND", "Channel account not found.", { status: 404 });
    if (body.boundFlowId) {
      const flow = await getFlow(db, ws, body.boundFlowId);
      if (!flow) throw new AppError("NOT_FOUND", "Bound flow not found in this workspace.", { status: 404 });
    }
    const slug = generateGrowthSlug();
    // Validate the destination NOW (throws a typed VALIDATION error when
    // e.g. a WhatsApp number or webchat URL is missing) - a link that
    // redirects nowhere must fail at creation, not at click time.
    buildGrowthTarget({
      kind: account.channel, slug,
      prefilledText: body.prefilledText, targetRef: body.targetRef, targetUrl: body.targetUrl,
      account: { externalId: account.externalId, displayName: account.displayName },
    });
    const row = await createGrowthLink(db, {
      workspaceId: ws,
      channelAccountId: account.id,
      kind: account.channel,
      slug,
      label: body.label,
      prefilledText: body.prefilledText,
      boundFlowId: body.boundFlowId,
      targetRef: body.targetRef,
      targetUrl: body.targetUrl,
    });
    return c.json({ link: serializeGrowthLink(row, c) }, 201);
  });

  const listGrowthLinksRoute = createRoute({
    method: "get", path: "/growth-links",
    responses: { 200: { description: "Growth links of the workspace" } },
  });
  app.openapi(listGrowthLinksRoute, async (c) => {
    const ws = workspaceId(c);
    const rows = await listGrowthLinks(deps.getDatabase(), ws);
    return c.json({ links: rows.map((row) => serializeGrowthLink(row, c)) });
  });

  const getGrowthLinkRoute = createRoute({
    method: "get", path: "/growth-links/{id}",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "One growth link" } },
  });
  app.openapi(getGrowthLinkRoute, async (c) => {
    const ws = workspaceId(c);
    const row = await getGrowthLink(deps.getDatabase(), ws, c.req.valid("param").id);
    if (!row) throw new AppError("NOT_FOUND", "Growth link not found.", { status: 404 });
    return c.json({ link: serializeGrowthLink(row, c) });
  });

  const deleteGrowthLinkRoute = createRoute({
    method: "delete", path: "/growth-links/{id}",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Growth link deleted" } },
  });
  app.openapi(deleteGrowthLinkRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const removed = await deleteGrowthLink(deps.getDatabase(), ws, c.req.valid("param").id);
    if (!removed) throw new AppError("NOT_FOUND", "Growth link not found.", { status: 404 });
    return c.json({ deleted: true });
  });

  const growthQrRoute = createRoute({
    method: "get", path: "/growth-links/{id}/qr.svg",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "QR code (SVG) of the link's short URL" } },
  });
  app.openapi(growthQrRoute, async (c) => {
    const ws = workspaceId(c);
    const row = await getGrowthLink(deps.getDatabase(), ws, c.req.valid("param").id);
    if (!row) throw new AppError("NOT_FOUND", "Growth link not found.", { status: 404 });
    const { toString: qrToString } = await import("qrcode");
    const svg = await qrToString(growthShortUrl(publicApiBase(deps, c), row.slug), {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
    });
    return c.body(svg, 200, { "content-type": "image/svg+xml; charset=utf-8" });
  });

  /**
   * Public growth redirect: counts the click, then 302s to the channel
   * target. No auth (it is the shareable link). An unknown slug is a typed
   * 404 - including on a deployment without a database, where no growth
   * link can exist by definition.
   */
  app.get("/r/:slug", async (c) => {
    const slug = c.req.param("slug");
    let link: GrowthLinkRow | null = null;
    try {
      link = await getGrowthLinkBySlug(deps.getDatabase(), slug);
    } catch (err) {
      if (err instanceof AppError && err.code === "CONFIGURATION") {
        throw new AppError("NOT_FOUND", "Growth link not found.", { status: 404 });
      }
      throw err;
    }
    if (!link) throw new AppError("NOT_FOUND", "Growth link not found.", { status: 404 });
    const db = deps.getDatabase();
    const account = await getChannelAccountById(db, link.channelAccountId);
    if (!account) throw new AppError("NOT_FOUND", "Growth link target account no longer exists.", { status: 404 });
    const target = buildGrowthTarget({
      kind: link.kind, slug: link.slug,
      prefilledText: link.prefilledText, targetRef: link.targetRef, targetUrl: link.targetUrl,
      account: { externalId: account.externalId, displayName: account.displayName },
    });
    await incrementGrowthLinkClicks(db, link.id).catch(() => undefined);
    return c.redirect(target, 302);
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

    // Reactive-only channels (TikTok) can never broadcast: the provider
    // forbids business-initiated messages entirely. Capability-driven -
    // the worker fan-out enforces the same rule as a backstop.
    const broadcastCaps = CHANNEL_CAPABILITIES[account.channel as ChannelKey];
    if (broadcastCaps && !broadcastCaps.canBroadcast) {
      throw new ChannelInitiationError(account.channel, "Broadcasts");
    }

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

  const listBroadcastsRoute = createRoute({
    method: "get", path: "/broadcasts",
    responses: { 200: { description: "Broadcasts of the workspace, newest first" } },
  });
  app.openapi(listBroadcastsRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const rows = await listBroadcasts(db, ws);
    // Delivery counts + estimate ride on the row; the realized cost is
    // aggregated per broadcast so the history list shows spend without a
    // detail fetch per row (ledger volume per broadcast is small).
    const broadcasts = [];
    for (const row of rows) {
      const cost = await sumCostLedgerByReference(db, row.id);
      broadcasts.push({
        ...row,
        createdAt: iso(row.createdAt),
        totalCostUsd: cost.totalUsd,
      });
    }
    return c.json({ broadcasts });
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
    // Fase 3: ground the suggestion in the workspace KB when it exists -
    // embed the latest customer message, cosine-rank the stored chunk
    // embeddings in code, and hand the top-3 to the model as reference
    // material. Retrieval is best-effort: any failure simply yields an
    // ungrounded suggestion (the 503 above still guards "no AI at all").
    let kbContext = "";
    let kbChunksUsed = 0;
    const lastInbound = [...history].reverse().find((m) => m.direction === "in")?.body;
    if (lastInbound) {
      try {
        const stored = await listKbChunksByWorkspace(db, ws);
        if (stored.length > 0) {
          const queryEmbedding = await provider.embedding({
            model: deps.env.AI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
            text: lastInbound,
          });
          const top = rankChunks(
            stored.map((row) => ({ text: row.text, embedding: row.embedding as number[] | null })),
            queryEmbedding,
            3,
          );
          if (top.length > 0) {
            kbChunksUsed = top.length;
            kbContext = "\n\nReference material from the workspace knowledge base (prefer it when relevant):\n"
              + top.map((r) => r.item.text).join("\n---\n");
          }
        }
      } catch (err) {
        console.warn(
          `[api] ai-suggest KB retrieval skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const result = await provider.chatCompletion({
      model: deps.env.AI_MODEL ?? DEFAULT_AI_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You help a customer-support agent. Draft a helpful, concise reply to the customer, " +
            "in the same language as the conversation. Return only the reply text." + kbContext,
        },
        ...(history.length > 0
          ? history.map((m) => ({
              role: (m.direction === "in" ? "user" : "assistant") as "user" | "assistant",
              content: m.body ?? "",
            }))
          : [{ role: "user" as const, content: "(no prior messages)" }]),
      ],
    });
    return c.json({ suggestion: result.text, model: result.model, kbChunksUsed });
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
          // Public profile-picture URL (Meta channels); null when absent -
          // telegram never stores one (token-bearing URLs), its avatar is
          // served by the /channels/accounts/{id}/avatar proxy instead.
          avatarUrl: r.avatarUrl ?? null,
          hasCredential: Boolean(r.tokenVaultRef),
          createdAt: iso(r.createdAt),
          tokenExpiresAt: iso(r.tokenExpiresAt),
          // Item G: when the account was soft-disconnected, and the
          // instant the retention sweeper will permanently purge it
          // (disconnectedAt + DISCONNECT_RETENTION_DAYS) unless it is
          // reconnected first. Null while connected.
          disconnectedAt: iso(r.disconnectedAt),
          purgeAt: r.status === "disconnected" ? iso(disconnectPurgeAt(r.disconnectedAt)) : null,
        };
      }),
    });
  });

  const deleteAccountRoute = createRoute({
    method: "delete", path: "/channels/accounts/{id}",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Channel account hard-deleted, soft-disconnected, or purged" } },
  });
  app.openapi(deleteAccountRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const purge = c.req.query("purge") === "true";
    const account = await getChannelAccount(db, ws, id);
    if (!account) throw new AppError("NOT_FOUND", "Channel account not found.", { status: 404 });
    const userId = authContext(c).user.id;
    // Captured up front: the soft disconnect nulls the ref on the row,
    // and the vault entry behind the OLD ref must still be deleted.
    const previousTokenVaultRef = account.tokenVaultRef;

    if (purge) {
      // Permanent deletion is two-step on purpose: the account must
      // already be soft-disconnected (credential revoked, history kept),
      // so a purge can never be a one-click accident on a live account.
      if (account.status !== "disconnected") {
        throw new AppError(
          "CONFLICT",
          "Only a disconnected account can be deleted permanently. Disconnect it first, then delete it permanently.",
          { status: 409, details: { reason: "purge_requires_disconnected" } },
        );
      }
      await purgeChannelAccount(db, ws, id);
      await deps.authStore.audit({
        workspaceId: ws, userId,
        action: "channel.purged",
        details: { channel: account.channel, externalId: account.externalId, reason: "manual" },
      }).catch(() => undefined);
      return c.json({ mode: "purged" });
    }

    // Disconnect ALWAYS works: an account with no attached data is
    // hard-deleted; an account carrying history is soft-disconnected
    // (row + data kept, credential revoked, sends blocked) and can be
    // reconnected later or purged explicitly.
    let mode: "deleted" | "disconnected";
    if (await channelAccountHasReferences(db, id)) {
      await softDisconnectChannelAccount(db, ws, id);
      mode = "disconnected";
    } else {
      try {
        await deleteChannelAccount(db, ws, id);
        mode = "deleted";
      } catch (err) {
        // Race backstop: data landed between the reference probe and the
        // delete (child FKs are NO ACTION, so this is Postgres 23503,
        // possibly wrapped by drizzle as err.cause) - fall back to a
        // soft disconnect instead of failing, so disconnect never
        // dead-ends.
        if (!isFkViolation(err)) throw err;
        await softDisconnectChannelAccount(db, ws, id);
        mode = "disconnected";
      }
    }
    if (previousTokenVaultRef) {
      await deps.vault.delete(previousTokenVaultRef).catch(() => undefined);
    }
    await deps.authStore.audit({
      workspaceId: ws, userId,
      action: "channel.disconnected",
      details: { channel: account.channel, externalId: account.externalId, mode },
    }).catch(() => undefined);
    return c.json({ mode });
  });

  // Telegram account avatar, proxied: Telegram file URLs embed the bot
  // token, so they are never stored on the account row or handed to a
  // client. This endpoint resolves the vault token server-side and
  // streams the bot's profile photo bytes instead. Meta/webchat accounts
  // carry a public avatarUrl (rendered directly by the SPA) - anything
  // that is not a telegram account with a resolvable photo is a 404 and
  // the SPA falls back to its initial chip.
  app.get("/channels/accounts/:id/avatar", async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const account = await getChannelAccount(db, ws, c.req.param("id"));
    if (!account || account.channel !== "telegram" || !account.tokenVaultRef) {
      throw new AppError("NOT_FOUND", "No avatar available for this account.", { status: 404 });
    }
    const botToken = await deps.vault.get(account.tokenVaultRef).catch(() => null);
    if (!botToken) {
      throw new AppError("NOT_FOUND", "No avatar available for this account.", { status: 404 });
    }
    const adapter = new TelegramAdapter({
      credentials: new StaticCredentialProvider({ botToken }),
      fetchFn: deps.providerFetch,
    });
    const avatar = await adapter.fetchOwnAvatar({ botToken, botId: account.externalId });
    if (!avatar) {
      throw new AppError("NOT_FOUND", "No avatar available for this account.", { status: 404 });
    }
    return new Response(avatar.bytes, {
      status: 200,
      headers: {
        "Content-Type": avatar.contentType,
        "Cache-Control": "private, max-age=3600",
      },
    });
  });

  // ------------------------------------------------- Meta catalog sync
  // Sync mirrors a WhatsApp account's catalogs into catalog_products;
  // reads serve the Channels summary card and the product pickers.
  const catalogSyncRoute = createRoute({
    method: "post", path: "/channels/{id}/catalog/sync",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({ catalogId: z.string().min(1).optional() }),
          },
        },
        required: false,
      },
    },
    responses: { 200: { description: "Catalog sync result" } },
  });
  app.openapi(catalogSyncRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json") as { catalogId?: string } | undefined;
    const result = await deps.catalogSync({ workspaceId: ws, accountId: id, catalogId: body?.catalogId });
    return c.json(result);
  });

  const catalogSummaryRoute = createRoute({
    method: "get", path: "/channels/{id}/catalog",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Synced catalog summary for the account" } },
  });
  app.openapi(catalogSummaryRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const account = await getChannelAccount(db, ws, id);
    if (!account) throw new AppError("NOT_FOUND", "Channel account not found.", { status: 404 });
    const products = await listCatalogProducts(db, ws, { accountId: id });
    const lastSyncedAt = products.reduce<Date | null>(
      (max, p) => (max === null || p.syncedAt > max ? p.syncedAt : max),
      null,
    );
    return c.json({
      accountId: id,
      productCount: products.length,
      catalogs: [...new Set(products.map((p) => p.catalogId))],
      lastSyncedAt: iso(lastSyncedAt),
    });
  });

  const listCatalogProductsRoute = createRoute({
    method: "get", path: "/catalog-products",
    request: {
      query: z.object({
        accountId: z.string().optional(),
        q: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
    },
    responses: { 200: { description: "Synced catalog products" } },
  });
  app.openapi(listCatalogProductsRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { accountId, q, limit } = c.req.valid("query");
    const rows = await listCatalogProducts(db, ws, { accountId, q, limit: limit ?? 200 });
    return c.json({
      products: rows.map((r) => ({
        ...r,
        syncedAt: iso(r.syncedAt),
        createdAt: iso(r.createdAt),
        updatedAt: iso(r.updatedAt),
      })),
    });
  });

  // ------------------------------------- channel connect flows (Fase 4)
  // Real onboarding: Telegram bot-token connect, and OAuth start endpoints
  // for instagram / threads / messenger (callbacks live above the auth
  // middleware). Tokens ONLY ever pass through the vault port.

  const telegramConnectRoute = createRoute({
    method: "post", path: "/channels/telegram/connect",
    request: { body: { content: { "application/json": { schema: telegramConnectBodySchema } }, required: true } },
    responses: { 201: { description: "Telegram bot connected" } },
  });
  app.openapi(telegramConnectRoute, async (c) => {
    guardMutator(c);
    const wsId = workspaceId(c);
    const { botToken, label } = c.req.valid("json");
    const adapter = new TelegramAdapter({
      credentials: new StaticCredentialProvider({ botToken }),
      fetchFn: deps.providerFetch,
    });
    let bot: { id: number; username?: string; firstName?: string };
    try {
      bot = await adapter.describeBot();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 404) {
        throw new AppError("VALIDATION", "Telegram rejected this bot token (getMe failed). Check the token and try again.", { status: 400 });
      }
      throw new AppError("PROVIDER_ERROR", `Telegram validation failed: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
    }
    const displayName = bot.username ? `@${bot.username}` : (label ?? `Telegram bot ${bot.id}`);
    const ref = await deps.vault.store({
      channel: "telegram", workspaceId: wsId,
      label: label ?? displayName, secret: botToken,
    });
    const persisted = await persistConnectedAccount({
      workspaceId: wsId, channel: "telegram", externalId: String(bot.id),
      displayName, authMode: "bot-token", tokenVaultRef: ref,
    });
    // Point Telegram at our webhook when a public base is configured.
    let webhookSet = false;
    const publicBase = deps.env.PUBLIC_WEBHOOK_BASE_URL ?? deps.env.APP_PUBLIC_URL;
    if (publicBase) {
      try {
        await adapter.setWebhookWithToken({
          url: `${publicBase.replace(/\/$/, "")}/webhooks/telegram`,
          ...(deps.env.TELEGRAM_WEBHOOK_SECRET ? { secretToken: deps.env.TELEGRAM_WEBHOOK_SECRET } : {}),
        });
        webhookSet = true;
      } catch (err) {
        console.error(`[api] telegram setWebhook failed for bot ${bot.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await deps.authStore.audit({
      workspaceId: wsId, userId: authContext(c).user.id,
      action: "channel.connected", details: { channel: "telegram", botId: bot.id, webhookSet },
    }).catch(() => undefined);
    return c.json({
      account: {
        id: persisted.id, channel: "telegram", externalId: String(bot.id),
        displayName, status: "connected", hasCredential: true, webhookSet,
      },
    }, 201);
  });

  // OAuth start: 302 to the provider authorize URL with a signed state.
  const oauthStart = (channel: "instagram" | "threads" | "messenger" | "tiktok") =>
    async (c: Ctx) => {
      const auth = authContext(c);
      const wsId = workspaceId(c);
      const secret = oauthSecret(deps);
      const redirectUri = oauthRedirectUri(deps, c, channel);
      const exp = Math.floor(Date.now() / 1000) + 600;
      if (channel === "tiktok") {
        const appId = deps.env.TIKTOK_APP_ID;
        if (!appId) {
          throw new AppError("CONFIGURATION", "TIKTOK_APP_ID is not configured on this server; TikTok connect is unavailable.", { status: 503 });
        }
        const state = signOAuthState(secret, { w: wsId, u: auth.user.id, ch: "tiktok", exp });
        return c.redirect(buildTikTokAuthorizeUrl({ appId, redirectUri, state }), 302);
      }
      if (channel === "threads") {
        const appId = deps.env.THREADS_APP_ID;
        if (!appId) {
          throw new AppError("CONFIGURATION", "THREADS_APP_ID is not configured on this server; Threads connect is unavailable.", { status: 503 });
        }
        const state = signOAuthState(secret, { w: wsId, u: auth.user.id, ch: "threads", exp });
        return c.redirect(buildThreadsAuthorizeUrl({ appId, redirectUri, state }), 302);
      }
      if (channel === "instagram") {
        const mode: InstagramAuthMode = c.req.query("mode") === "facebook-login" ? "facebook-login" : "instagram-login";
        const appId = mode === "instagram-login"
          ? (deps.env.INSTAGRAM_APP_ID ?? deps.env.META_APP_ID)
          : deps.env.META_APP_ID;
        if (!appId) {
          throw new AppError("CONFIGURATION", "No Instagram/Meta app id is configured on this server; Instagram connect is unavailable.", { status: 503 });
        }
        const state = signOAuthState(secret, { w: wsId, u: auth.user.id, ch: "instagram", m: mode, exp });
        return c.redirect(buildInstagramAuthorizeUrl({ mode, appId, redirectUri, state }), 302);
      }
      const appId = deps.env.META_APP_ID;
      if (!appId) {
        throw new AppError("CONFIGURATION", "META_APP_ID is not configured on this server; Messenger connect is unavailable.", { status: 503 });
      }
      const state = signOAuthState(secret, { w: wsId, u: auth.user.id, ch: "messenger", exp });
      return c.redirect(buildMessengerAuthorizeUrl({ appId, redirectUri, state }), 302);
    };
  app.get("/channels/instagram/oauth/start", oauthStart("instagram"));
  app.get("/channels/threads/oauth/start", oauthStart("threads"));
  app.get("/channels/messenger/oauth/start", oauthStart("messenger"));
  app.get("/channels/tiktok/oauth/start", oauthStart("tiktok"));

  // Messenger multi-Page picker: list (from the signed pending cookie) and
  // confirm. Tokens never leave the server except into the vault.
  app.get("/channels/messenger/pending-pages", (c) => {
    const wsId = workspaceId(c);
    const raw = getCookie(c, MESSENGER_PENDING_COOKIE);
    if (!raw) return c.json({ pages: [] });
    const pending = verifyPayload<MessengerPendingPayload>(oauthSecret(deps), raw);
    if (!pending || pending.w !== wsId) return c.json({ pages: [] });
    return c.json({ pages: pending.pages.map((p) => ({ id: p.id, name: p.name })) });
  });

  const messengerSelectPageRoute = createRoute({
    method: "post", path: "/channels/messenger/select-page",
    request: { body: { content: { "application/json": { schema: messengerSelectPageBodySchema } }, required: true } },
    responses: { 201: { description: "Messenger Page connected" } },
  });
  app.openapi(messengerSelectPageRoute, async (c) => {
    guardMutator(c);
    const wsId = workspaceId(c);
    const raw = getCookie(c, MESSENGER_PENDING_COOKIE);
    const pending = raw ? verifyPayload<MessengerPendingPayload>(oauthSecret(deps), raw) : null;
    if (!pending || pending.w !== wsId) {
      throw new AppError("VALIDATION", "No pending Messenger Page selection (it expires after 10 minutes - restart the connect flow).", { status: 400 });
    }
    const page = pending.pages.find((p) => p.id === c.req.valid("json").pageId);
    if (!page) throw new AppError("NOT_FOUND", "That Page is not part of the pending selection.", { status: 404 });
    const ref = await deps.vault.store({
      channel: "messenger", workspaceId: wsId, label: page.name, secret: page.t,
    });
    const adapter = new MessengerAdapter({
      credentials: new StaticCredentialProvider({}), fetchFn: deps.providerFetch,
    });
    const avatarUrl = await adapter.fetchPagePictureUrl({ pageId: page.id, pageAccessToken: page.t }) ?? undefined;
    const persisted = await persistConnectedAccount({
      workspaceId: wsId, channel: "messenger", externalId: page.id,
      displayName: page.name, avatarUrl, authMode: "facebook-login", tokenVaultRef: ref,
    });
    deleteCookie(c, MESSENGER_PENDING_COOKIE, { path: "/" });
    await deps.authStore.audit({
      workspaceId: wsId, userId: authContext(c).user.id,
      action: "channel.connected", details: { channel: "messenger", pageId: page.id },
    }).catch(() => undefined);
    return c.json({
      account: {
        id: persisted.id, channel: "messenger", externalId: page.id,
        displayName: page.name, status: "connected", hasCredential: true,
      },
    }, 201);
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

  // ------------------------------------------------ knowledge base (Fase 3)

  const serializeKbDocument = (d: Awaited<ReturnType<typeof listKbDocuments>>[number]) => ({
    id: d.id,
    title: d.title,
    status: d.status,
    chunkCount: d.chunkCount,
    error: d.error ?? undefined,
    createdAt: iso(d.createdAt),
  });

  const createKbDocumentRoute = createRoute({
    method: "post", path: "/kb/documents",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              title: z.string().min(1).max(300),
              content: z.string().min(1).max(1_000_000),
            }),
          },
        },
      },
    },
    responses: { 201: { description: "KB document accepted for ingestion" } },
  });
  app.openapi(createKbDocumentRoute, async (c) => {
    guardMutator(c);
    // Ingestion EMBEDS the chunks - without an AI provider there is
    // nothing honest to do with the document, so fail fast with 503
    // before storing anything.
    if (!deps.getAiProvider()) {
      throw new AppError(
        "CONFIGURATION",
        "No AI provider is configured (AI_API_KEY); KB ingestion needs embeddings and is never faked.",
        { status: 503 },
      );
    }
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const body = c.req.valid("json");
    const doc = await createKbDocument(db, { workspaceId: ws, title: body.title, sourceText: body.content });
    // Enqueue the kb-ingest job (chunk + embed in the worker). A queue
    // failure surfaces as 503; the document stays "pending" and visible.
    await deps.kbEnqueuer.enqueueKbIngest({ workspaceId: ws, documentId: doc.id });
    return c.json({ document: serializeKbDocument(doc) }, 201);
  });

  const listKbDocumentsRoute = createRoute({
    method: "get", path: "/kb/documents",
    responses: { 200: { description: "KB documents of the workspace" } },
  });
  app.openapi(listKbDocumentsRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const rows = await listKbDocuments(db, ws);
    return c.json({ documents: rows.map(serializeKbDocument) });
  });

  const getKbDocumentRoute = createRoute({
    method: "get", path: "/kb/documents/{id}",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "KB document with its chunks (embeddings omitted)" } },
  });
  app.openapi(getKbDocumentRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const doc = await getKbDocument(db, ws, id);
    if (!doc) throw new AppError("NOT_FOUND", "KB document not found.", { status: 404 });
    const chunks = await listKbChunks(db, ws, id);
    return c.json({
      document: {
        ...serializeKbDocument(doc),
        content: doc.sourceText,
        chunks: chunks.map((ch) => ({ chunkIndex: ch.chunkIndex, text: ch.text })),
      },
    });
  });

  const deleteKbDocumentRoute = createRoute({
    method: "delete", path: "/kb/documents/{id}",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "KB document deleted (chunks cascade)" } },
  });
  app.openapi(deleteKbDocumentRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const deleted = await deleteKbDocument(db, ws, c.req.valid("param").id);
    if (!deleted) throw new AppError("NOT_FOUND", "KB document not found.", { status: 404 });
    return c.json({ deleted: true });
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
    // A button click posts the button's title as `text` plus its payload
    // code as `buttonPayload`; the click is stored on the row's payload
    // so the round-trip stays auditable in the thread.
    const buttonPayload = typeof body.buttonPayload === "string" ? body.buttonPayload.trim() : "";
    if (body.buttonPayload !== undefined && (buttonPayload.length < 1 || buttonPayload.length > 256)) {
      throw new AppError("VALIDATION", "buttonPayload must be 1-256 characters.", { status: 400 });
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
      payload: buttonPayload ? { buttonPayload } : undefined,
      status: "delivered",
    });
    await touchConversationLastUserMessage(db, session.conversationId, now);
    await touchWebchatSession(db, session.id, now);
    // Visitor messages bypass the webhook dispatcher (the widget posts
    // here directly), so this route is their one publish point.
    await deps.realtimePublisher.publishInboxMessage({
      workspaceId: session.workspaceId, conversationId: session.conversationId,
      direction: "in", messageId: message.id,
    }).catch(() => undefined);
    // Flow triggers: the message is already persisted (above), so the
    // dispatcher only evaluates triggers - keyword on the text, postback
    // on the button payload - and enqueues matching flow runs. It never
    // throws; the extra catch is belt-and-braces for the visitor's 201.
    const conversation = await getConversation(db, session.workspaceId, session.conversationId);
    if (conversation) {
      await deps.flowDispatcher.dispatchPersistedWebchat({
        workspaceId: session.workspaceId,
        channelAccountId: conversation.channelAccountId,
        contactId: session.contactId,
        conversationId: session.conversationId,
        text,
        ...(buttonPayload ? { buttonPayload } : {}),
      }).catch(() => undefined);
    }
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

  const postTargetSchema = z.object({
    channelAccountId: z.string().min(1),
    targetExternalId: z.string().min(1).optional(),
  });

  /**
   * Resolve post targets against the workspace's accounts (item H).
   * Telegram targets REQUIRE targetExternalId: the account is a bot and
   * a bot cannot post to itself — the target names the channel chat
   * (chat ID or @username, bot must be an admin there). The stored
   * target denormalizes the account's channel for the worker snapshot.
   */
  async function resolvePostTargets(
    db: Database,
    ws: string,
    raw: Array<{ channelAccountId: string; targetExternalId?: string }>,
  ): Promise<ScheduledPostTarget[]> {
    const targets: ScheduledPostTarget[] = [];
    for (const t of raw) {
      const account = await getChannelAccount(db, ws, t.channelAccountId);
      if (!account) {
        throw new AppError("NOT_FOUND", `Channel account ${t.channelAccountId} not found.`, { status: 404 });
      }
      if (account.channel === "telegram" && !t.targetExternalId) {
        throw new AppError(
          "VALIDATION",
          "Telegram publish targets require targetExternalId: the channel chat ID or @username the bot should post to (a bot cannot post to itself).",
          { status: 400 },
        );
      }
      targets.push({
        channelAccountId: account.id,
        channel: account.channel,
        ...(t.targetExternalId ? { targetExternalId: t.targetExternalId } : {}),
      });
    }
    return targets;
  }

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
    const targets = await resolvePostTargets(db, ws, body.targets);
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
              targets: z.array(postTargetSchema).min(1).optional(),
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
      targets: body.targets === undefined ? undefined : await resolvePostTargets(db, ws, body.targets),
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
    // A sequence initiates contact on a schedule - impossible on
    // reactive-only channels (TikTok). The worker advance processor
    // enforces the same capability rule for pre-existing rows.
    const sequenceCaps = CHANNEL_CAPABILITIES[account.channel as ChannelKey];
    if (sequenceCaps && sequenceCaps.canInitiate === false) {
      throw new ChannelInitiationError(account.channel, "Sequences");
    }
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
    const enrollmentCounts = await countEnrollmentsBySequence(db, ws);
    return c.json({
      sequences: rows.map((r) => ({
        ...r,
        createdAt: iso(r.createdAt),
        stepCount: Array.isArray(r.steps) ? r.steps.length : 0,
        enrollmentCount: enrollmentCounts.get(r.id) ?? 0,
      })),
    });
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

  const deleteSequenceRoute = createRoute({
    method: "delete", path: "/sequences/{id}",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Sequence deleted (with its enrollments)" } },
  });
  app.openapi(deleteSequenceRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const removed = await deleteSequence(deps.getDatabase(), ws, c.req.valid("param").id);
    if (!removed) throw new AppError("NOT_FOUND", "Sequence not found.", { status: 404 });
    return c.json({ deleted: true });
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
