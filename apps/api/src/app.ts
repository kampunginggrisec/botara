import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import {
  AppError, ChannelAccountDisconnectedError, ChannelInitiationError, ConsecutiveSendCapError,
  buildVariableContext, checkOutboundWebhookUrl, countConsecutiveOutbound, disconnectPurgeAt, evaluateReplyWindow, interpolate,
  MessagingWindowClosedError, WEBHOOK_DELIVERY_MAX_ATTEMPTS, WEBHOOK_TEST_EVENT, parseApiTokenScopes, parseWebhookEvents,
} from "@botara/shared";
import {
  getDb, getWorkspaceById, listContacts, getContact, createContact, updateContact, segmentCounts,
  listConversations, getConversation, listMessages, createMessage, updateMessageStatus,
  touchConversationLastUserMessage,
  listSavedReplies, getSavedReply, getSavedReplyByShortcut, createSavedReply,
  updateSavedReply, deleteSavedReply, isUniqueViolation,
  type SavedReplyRow, type MessageRow,
  listTemplates, createTemplate, updateTemplateLatestCategory,
  createBroadcast, listBroadcasts, getBroadcast, updateBroadcastStatus, sumCostLedgerByReference,
  listBroadcastRecipients, listFailedBroadcastRecipientContactIds, resetBroadcastRecipients,
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
  insertAiUsageLedger, updateConversationAiAnalysis, setConversationAiPaused,
  createFlow, listFlows, getFlow, updateFlow, deleteFlow, deleteFlowWaitsForConversation,
  deleteSequence, countEnrollmentsBySequence, getWorkspaceStats, getWorkspaceInsights, listWorkspaceActivity,
  updateChannelAccountToken, updateChannelAccountAvatar,
  createGrowthLink, listGrowthLinks, getGrowthLink, deleteGrowthLink,
  getGrowthLinkBySlug, incrementGrowthLinkClicks, upsertContactByExternal,
  listPipelines, getPipeline, getDefaultPipeline, createPipeline, updatePipeline, deletePipelineCascade,
  countPipelineDeals, listPipelineStages, getPipelineStage, createPipelineStage, updatePipelineStage,
  deletePipelineStage, reorderPipelineStages, countStageDeals,
  listDeals, getDeal, createDeal, updateDeal, deleteDeal, getPipelineSummary,
  DEFAULT_PIPELINE_STAGE_NAMES,
  type PipelineRow, type PipelineStageRow, type DealRow, type DealWithContact, type DealStatus,
  updateConversationAssignment, updateConversationStatus, CONVERSATION_STATUSES,
  upsertCatalogProduct, listCatalogProducts, listCatalogProductKeys, deleteCatalogProduct,
  PlatformSettingsService, DbPlatformSettingsStorage, tryParseVaultKey, sealSettingValue,
  createWebhookEndpoint, listWebhookEndpoints, getWebhookEndpoint, updateWebhookEndpoint,
  deleteWebhookEndpoint, createWebhookDelivery, listWebhookDeliveries,
  type WebhookEndpointRow, type WebhookDeliveryRow,
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
  interpolateRichBlock, richBlockSchema, richBlockText, richToPlainText,
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
  type ApiTokenGrant, type AuthContext, type AuthStore, type AuthUser, type WorkspaceInviteRecord,
} from "./auth";
import {
  INVITABLE_ROLES, generateInviteToken, hashInviteToken, inviteDisplayPrefix, invitePath, inviteState,
} from "./invites";
import { createRedisPresenceReader, offlinePresenceReader, type PresenceReader } from "./presence";
import {
  createOutboundWebhookEmitter, generateWebhookSecret, webhookEnvelope, webhookTestData,
  type WebhookDeliveryEnqueuer,
} from "./outbound-webhooks";
import { WORKSPACE_ROUTE_PREFIXES, assertApiTokenRouteAccess } from "./route-scopes";
import { estimateBroadcastCost, type WhatsAppCategory } from "@botara/billing";
import {
  createAIProviderFromEnv, moderateText, rankChunks,
  buildConversationAnalysisMessages, parseConversationAnalysis,
  CONVERSATION_ANALYSIS_HISTORY_CAP,
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
import {
  DEFAULT_KB_UPLOAD_LIMITS, extractKbFileText, sanitizeUploadFilename, titleFromFilename,
} from "./kb-upload";
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
  /**
   * Without opts: the full-audience fan-out. With opts (resend-failed,
   * package #4): a restricted re-send to exactly `contactIds`, made a
   * distinct BullMQ job by the per-request `resendToken`.
   */
  enqueueBroadcast(
    broadcastId: string,
    opts?: { contactIds: string[]; resendToken: string },
  ): Promise<void>;
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
  /**
   * Member presence (#9): who currently holds a realtime socket.
   * Optional - when absent (or when Redis is down) every member reads
   * offline and the members list is unaffected.
   */
  presenceReader?: PresenceReader;
  /** Fase 3: Resend inbound routing + enqueueing. */
  emailInboundEnqueuer: EmailInboundEnqueuer;
  emailRouter: EmailRouter;
  /** Fase 3: Meta data-deletion callback store. */
  dataDeletionStore: DataDeletionStore;
  /** Fase 3: knowledge-base ingestion enqueueing. */
  kbEnqueuer: KbEnqueuer;
  /** KB file-upload limits (defaults in kb-upload.ts; tests inject tiny limits). */
  kbUploadLimits?: { maxFileBytes?: number; maxTextChars?: number };
  /** Fase 3: readiness probes for /health/ready. */
  readiness: ReadinessChecker;
  /** Fase 3: in-process rate-limit overrides (tests use tiny limits). */
  rateLimits?: { authPerMinute?: number; publicPerMinute?: number; utilityPerMinute?: number };
  /** Fase 4: flow-run enqueueing + inbound webhook dispatch (persist + match). */
  flowEnqueuer: FlowRunEnqueuer;
  flowDispatcher: InboundFlowDispatcher;
  /** Outbound event webhooks (#10): delivery-job enqueueing for the worker's outbound-webhooks queue. */
  webhookEnqueuer: WebhookDeliveryEnqueuer;
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
    enqueueBroadcast: (broadcastId, opts) => (opts
      ? inner.enqueue(
          { broadcastId, contactIds: opts.contactIds, resendToken: opts.resendToken },
          `broadcast:${broadcastId}:resend:${opts.resendToken}`,
        )
      : inner.enqueue({ broadcastId }, `broadcast:${broadcastId}`)),
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

/**
 * Production outbound-webhook enqueuer: BullMQ "outbound-webhooks"
 * queue, job "deliver". Unlike the generic helper, the job carries the
 * delivery retry policy (5 attempts, exponential backoff from 5s) - the
 * worker's own per-delivery attempt counter agrees with it, and the
 * final attempt marks the delivery failed instead of throwing.
 */
export function createBullMqWebhookEnqueuer(redisUrl: string): WebhookDeliveryEnqueuer {
  return {
    async enqueueWebhookDelivery(deliveryId: string): Promise<void> {
      const connection = new IORedis(redisUrl, {
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      });
      connection.on("error", () => { /* surfaced via the raced add() below */ });
      const queue = new Queue("outbound-webhooks", { connection });
      try {
        const add = queue.add("deliver", { deliveryId }, {
          jobId: jobIdFor(`webhook-delivery:${deliveryId}`),
          attempts: WEBHOOK_DELIVERY_MAX_ATTEMPTS,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: 100,
          removeOnFail: 100,
        });
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("redis enqueue timed out")), 3000),
        );
        await Promise.race([add, timeout]);
      } catch (err) {
        throw new AppError(
          "CONFIGURATION",
          `outbound-webhooks queue (Redis) is unavailable: ${err instanceof Error ? err.message : String(err)}`,
          { status: 503 },
        );
      } finally {
        await queue.close().catch(() => undefined);
        connection.disconnect();
      }
    },
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
    webhookEnqueuer: createBullMqWebhookEnqueuer(redisUrl),
    flowDispatcher: createDbFlowDispatcher({
      getDatabase: defaultGetDatabase,
      flowEnqueuer: createBullMqFlowEnqueuer(redisUrl),
      commentEnqueuer: createBullMqCommentActionEnqueuer(redisUrl),
      publisher: realtimePublisher,
      // Outbound event webhooks (#10): lifecycle events fan out to the
      // workspace's subscribed endpoints; fire-and-forget by contract.
      webhookEmitter: createOutboundWebhookEmitter({
        getDatabase: defaultGetDatabase,
        enqueuer: createBullMqWebhookEnqueuer(redisUrl),
      }),
      // Inbound media pipeline: copies channel media bytes into R2 at
      // ingest. Degrades silently to caption-only when R2 is not
      // configured - the port never throws (see inbound-media.ts).
      mediaPort: createInboundMediaPort(),
    }),
    presenceReader: createRedisPresenceReader(redisUrl),
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

/**
 * App secrets that may have signed a Meta-platform `signed_request` to
 * the data-deletion callback. Instagram Login and Threads are SEPARATE
 * Meta apps with their own secrets, yet Meta sends their deletion
 * requests to the same registered URL - signed with THAT app's secret.
 * The per-app resolution mirrors the OAuth/webhook handlers:
 * INSTAGRAM_APP_SECRET and THREADS_APP_SECRET each fall back to
 * META_APP_SECRET. Returns the deduped, non-empty candidates (an empty
 * list means no app secret is configured at all).
 */
export function dataDeletionAppSecrets(
  env: Record<string, string | undefined>,
): string[] {
  const candidates = [
    env.META_APP_SECRET,
    env.INSTAGRAM_APP_SECRET ?? env.META_APP_SECRET,
    env.THREADS_APP_SECRET ?? env.META_APP_SECRET,
  ];
  return [
    ...new Set(
      candidates.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      ),
    ),
  ];
}

/**
 * The WhatsApp Embedded Signup config id as the FB SDK needs it: the bare
 * config_id. Operators sometimes paste the whole onboarding URL from the
 * WhatsApp product settings into the panel instead of just the id (this
 * happened on the trial deployment, 2026-10-26); when the stored value is
 * a URL carrying a config_id parameter, extract it. Anything else passes
 * through trimmed; unset/empty stays null.
 */
export function normalizeEmbeddedConfigId(
  raw: string | undefined,
): string | null {
  if (raw === undefined) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  if (value.includes("config_id=")) {
    try {
      const fromUrl = new URL(value).searchParams.get("config_id");
      if (fromUrl) return fromUrl;
    } catch {
      // Not a parseable URL - try the parameter pattern directly.
      const match = /[?&]config_id=([^&#]+)/.exec(value);
      if (match?.[1]) {
        try {
          return decodeURIComponent(match[1]);
        } catch {
          return match[1];
        }
      }
    }
  }
  return value;
}

// ------------------------------------------------------------------- types

export type AppEnv = { Variables: { workspaceId?: string; auth?: AuthContext; requestId?: string; apiToken?: ApiTokenGrant } };
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
const renameWorkspaceBodySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  /** Workspace default currency (package #6): ISO 4217, case-insensitive on input. */
  defaultCurrency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  /** Workspace reply target in minutes (package #8): the insights service goal. */
  replyTargetMinutes: z.number().int().min(1).max(10080).optional(),
}).refine((b) => b.name !== undefined || b.defaultCurrency !== undefined || b.replyTargetMinutes !== undefined, {
  message: "Provide at least one of: name, defaultCurrency, replyTargetMinutes.",
}).openapi("RenameWorkspaceBody");
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
  // Invite links (#9): the preview endpoint is public and token-bearing
  // URLs invite guessing - metered on the public budget. Token entropy
  // (256 bits) does the real work; this just caps probing.
  app.use("/invites", createRateLimiter("public", deps.rateLimits?.publicPerMinute ?? 120));
  app.use("/invites/*", createRateLimiter("public", deps.rateLimits?.publicPerMinute ?? 120));

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
    //
    // Scoped tokens (#5): resolution also yields the token's GRANT.
    // Expiry is enforced here (401 TOKEN_EXPIRED - distinct from an
    // unknown/revoked token), and a RESTRICTED grant (workspace binding
    // and/or scope list) is checked against the route's required scope
    // right here, so every caller of authenticateRequest - workspace
    // middleware, auth routes, admin routes - enforces it identically.
    // Legacy grants pass through untouched. Session JWTs never reach
    // this branch and are never scope-limited.
    if (token.startsWith(API_TOKEN_PREFIX)) {
      const resolution = await deps.authStore.resolveApiToken(token);
      if (resolution.status === "invalid") {
        throw new AppError("UNAUTHORIZED", "API token is invalid or revoked.", { status: 401 });
      }
      if (resolution.status === "expired") {
        throw new AppError("TOKEN_EXPIRED", "API token has expired.", { status: 401 });
      }
      c.set("apiToken", resolution.grant);
      assertApiTokenRouteAccess(resolution.grant, c.req.method, c.req.path);
      return resolution.user;
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
    const grant = c.get("apiToken");
    const base: AuthContext = {
      user: { id: user.id, email: user.email, name: user.name },
      ...(grant ? { apiToken: grant } : {}),
    };
    // Workspace-bound API token (#5): the token's workspace IS the
    // effective workspace. A disagreeing selector (header or, for GET,
    // ?workspace_id=) is a 403 - never a silent override - and the
    // owner's membership is re-verified on every request, so removing
    // the owner from the workspace kills the token with it.
    if (grant?.workspaceId) {
      if (selectedWorkspace && selectedWorkspace !== grant.workspaceId) {
        throw new AppError(
          "FORBIDDEN",
          "This API token is bound to a different workspace.",
          { status: 403, details: { boundWorkspaceId: grant.workspaceId } },
        );
      }
      const membership = await deps.authStore.getMembership(grant.workspaceId, user.id);
      if (!membership) {
        throw new AppError(
          "FORBIDDEN",
          "The API token's owner is no longer a member of the workspace this token is bound to.",
          { status: 403 },
        );
      }
      return { ...base, workspaceId: grant.workspaceId, role: membership.role };
    }
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
    // Workspace-bound API token (#5): path-selected workspaces obey the
    // binding too - membership of the OWNER in another workspace must
    // not let a bound token act there.
    if (auth.apiToken?.workspaceId && auth.apiToken.workspaceId !== workspaceIdParam) {
      throw new AppError(
        "FORBIDDEN",
        "This API token is bound to a different workspace.",
        { status: 403, details: { boundWorkspaceId: auth.apiToken.workspaceId } },
      );
    }
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
  //
  // Scoped tokens (#5): creation optionally binds the token to one
  // workspace (workspaceId), restricts it to a scope list (scopes, the
  // taxonomy in @botara/shared - docs/api-tokens.md), and/or gives it an
  // expiry (expiresAt). Omitting all three mints a legacy token whose
  // behavior is unchanged. Restricted tokens cannot call these routes
  // at all (enforced in authenticateRequest) - token management always
  // requires a session or a legacy token.

  const createApiTokenRoute = createRoute({
    method: "post", path: "/auth/tokens",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1).max(120),
              workspaceId: z.string().uuid().optional(),
              scopes: z.array(z.string().min(1).max(40)).max(64).optional(),
              expiresAt: z.string().datetime().optional(),
            }),
          },
        },
      },
    },
    responses: { 201: { description: "API token created; raw token returned ONCE" } },
  });
  app.openapi(createApiTokenRoute, async (c) => {
    const user = await authenticateRequest(c);
    const body = c.req.valid("json");
    let scopes: string[] | null = null;
    if (body.scopes !== undefined) {
      const parsed = parseApiTokenScopes(body.scopes);
      if (!parsed) {
        throw new AppError(
          "VALIDATION",
          "scopes must be valid API token scopes (docs/api-tokens.md).",
          { status: 400, details: { scopes: body.scopes } },
        );
      }
      scopes = parsed;
    }
    let expiresAt: Date | null = null;
    if (body.expiresAt !== undefined) {
      expiresAt = new Date(body.expiresAt);
      if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
        throw new AppError("VALIDATION", "expiresAt must be a future ISO 8601 timestamp.", { status: 400 });
      }
    }
    if (body.workspaceId !== undefined) {
      const membership = await deps.authStore.getMembership(body.workspaceId, user.id);
      if (!membership) {
        throw new AppError("FORBIDDEN", "You are not a member of the selected workspace.", { status: 403 });
      }
    }
    const { raw, token } = await deps.authStore.createApiToken(user.id, body.name.trim(), {
      workspaceId: body.workspaceId ?? null,
      scopes,
      expiresAt,
    });
    await deps.authStore.audit({
      userId: user.id,
      action: "auth.token.create",
      details: { tokenId: token.id, name: token.name, workspaceId: token.workspaceId, scopes: token.scopes },
    });
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
    whatsappEmbeddedConfigId: normalizeEmbeddedConfigId(deps.env.WHATSAPP_EMBEDDED_CONFIG_ID),
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
    // Development fixtures may intentionally omit Meta credentials, but a
    // production endpoint must never accept an unsigned provider payload.
    if (!appSecret && deps.env.NODE_ENV === "production") {
      throw new AppError(
        "CONFIGURATION",
        "META_APP_SECRET is required to authenticate WhatsApp webhooks in production.",
        { status: 503 },
      );
    }
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
  // purge the provider user's contact data best-effort. The SAME URL is
  // registered in the Meta, Instagram Login and Threads app consoles, so
  // verification accepts a signature from any of the three app secrets
  // (see dataDeletionAppSecrets).

  app.post("/webhooks/meta/data-deletion", async (c) => {
    const appSecrets = dataDeletionAppSecrets(deps.env);
    if (appSecrets.length === 0) {
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
    // A request verifies when ANY configured app secret validates its
    // signature (the signing app is whichever console the user acted in).
    // The failure stays the same generic 401 - it never reveals which
    // secrets were tried.
    let payload: ReturnType<typeof parseMetaSignedRequest> = null;
    for (const secret of appSecrets) {
      payload = parseMetaSignedRequest(signedRequest, secret);
      if (payload) break;
    }
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
  for (const prefix of WORKSPACE_ROUTE_PREFIXES) {
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
    const members = await deps.authStore.listMembers(id);
    // Presence (#9): a live realtime socket recently = online. The
    // reader contracts to all-offline on any Redis trouble, and the
    // extra catch keeps even a broken custom reader from failing the
    // members list.
    const reader = deps.presenceReader ?? offlinePresenceReader;
    const online = await reader
      .onlineUserIds(id, members.map((m) => m.userId))
      .catch(() => new Set<string>());
    return c.json({ members: members.map((m) => ({ ...m, online: online.has(m.userId) })) });
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
    const body = c.req.valid("json");
    if (body.name !== undefined) {
      await deps.authStore.renameWorkspace(id, body.name.trim());
      await deps.authStore.audit({
        workspaceId: id, userId: auth.user.id,
        action: "workspace.rename", details: { name: body.name },
      });
    }
    if (body.defaultCurrency !== undefined) {
      const currency = body.defaultCurrency.toUpperCase();
      await deps.authStore.updateWorkspaceCurrency(id, currency);
      await deps.authStore.audit({
        workspaceId: id, userId: auth.user.id,
        action: "workspace.default_currency", details: { currency },
      });
    }
    if (body.replyTargetMinutes !== undefined) {
      await deps.authStore.updateWorkspaceReplyTarget(id, body.replyTargetMinutes);
      await deps.authStore.audit({
        workspaceId: id, userId: auth.user.id,
        action: "workspace.reply_target", details: { minutes: body.replyTargetMinutes },
      });
    }
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

  // ------------------------------------------- invite-by-link (#9)
  // Shareable join links: an owner/admin mints one (the raw token is
  // returned ONCE; only its SHA-256 is stored), anyone signed in can
  // accept it from /invite/<token>. Revocation is a state stamp, never
  // a delete, so the audit trail survives.

  /** Public wire shape of an invite - fragment + state, never the hash. */
  const serializeInvite = (invite: WorkspaceInviteRecord) => ({
    id: invite.id,
    prefix: invite.prefix,
    role: invite.role,
    expiresAt: iso(invite.expiresAt),
    maxUses: invite.maxUses,
    usesCount: invite.usesCount,
    revokedAt: iso(invite.revokedAt),
    createdAt: invite.createdAt.toISOString(),
    createdByUserId: invite.createdByUserId,
  });

  const createInviteRoute = createRoute({
    method: "post", path: "/workspaces/{id}/invites",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              // Ownership is never granted by a link - transfer only.
              role: z.enum(INVITABLE_ROLES).default("member"),
              expiresInDays: z.number().int().min(1).max(365).optional(),
              maxUses: z.number().int().min(1).max(10_000).nullable().optional(),
            }),
          },
        },
      },
    },
    responses: { 201: { description: "Invite created; raw token returned once" } },
  });
  app.openapi(createInviteRoute, async (c) => {
    const { id } = c.req.valid("param");
    const auth = await requirePathWorkspaceRole(c, id, ADMIN_ROLES);
    const body = c.req.valid("json");
    const raw = generateInviteToken();
    const expiresAt = body.expiresInDays
      ? new Date(Date.now() + body.expiresInDays * 24 * 3600 * 1000)
      : null;
    const invite = await deps.authStore.createInvite({
      workspaceId: id,
      tokenHash: hashInviteToken(raw),
      prefix: inviteDisplayPrefix(raw),
      role: body.role,
      createdByUserId: auth.user.id,
      expiresAt,
      maxUses: body.maxUses ?? null,
    });
    await deps.authStore.audit({
      workspaceId: id, userId: auth.user.id,
      action: "workspace.invite.create",
      details: { inviteId: invite.id, prefix: invite.prefix, role: invite.role, expiresAt: iso(expiresAt), maxUses: invite.maxUses },
    });
    return c.json({ invite: serializeInvite(invite), token: raw, invitePath: invitePath(raw) }, 201);
  });

  const listInvitesRoute = createRoute({
    method: "get", path: "/workspaces/{id}/invites",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Workspace invite links" } },
  });
  app.openapi(listInvitesRoute, async (c) => {
    const { id } = c.req.valid("param");
    await requirePathWorkspaceRole(c, id, ADMIN_ROLES);
    const invites = await deps.authStore.listInvites(id);
    return c.json({ invites: invites.map(serializeInvite) });
  });

  const revokeInviteRoute = createRoute({
    method: "delete", path: "/workspaces/{id}/invites/{inviteId}",
    request: { params: z.object({ id: z.string(), inviteId: z.string() }) },
    responses: { 200: { description: "Invite revoked" } },
  });
  app.openapi(revokeInviteRoute, async (c) => {
    const { id, inviteId } = c.req.valid("param");
    const auth = await requirePathWorkspaceRole(c, id, ADMIN_ROLES);
    const outcome = await deps.authStore.revokeInvite(id, inviteId);
    if (outcome === "missing") {
      throw new AppError("NOT_FOUND", "Invite not found in this workspace.", { status: 404 });
    }
    // Revoking an already-revoked invite is an idempotent success.
    if (outcome === "revoked") {
      await deps.authStore.audit({
        workspaceId: id, userId: auth.user.id,
        action: "workspace.invite.revoke", details: { inviteId },
      });
    }
    return c.json({ revoked: true });
  });

  // ---------------------------------------- ownership transfer (#9)
  const transferOwnershipRoute = createRoute({
    method: "post", path: "/workspaces/{id}/transfer-ownership",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": { schema: z.object({ userId: z.string().min(1) }) },
        },
        required: true,
      },
    },
    responses: { 200: { description: "Ownership transferred; caller is now admin" } },
  });
  app.openapi(transferOwnershipRoute, async (c) => {
    const { id } = c.req.valid("param");
    // ONLY the current owner - admins cannot take or give ownership.
    const auth = await requirePathWorkspaceRole(c, id, ["owner"]);
    const { userId } = c.req.valid("json");
    if (userId === auth.user.id) {
      throw new AppError("VALIDATION", "You already own this workspace.", { status: 400 });
    }
    const members = await deps.authStore.listMembers(id);
    const target = members.find((m) => m.userId === userId);
    if (!target) {
      throw new AppError("NOT_FOUND", "Target user is not a member of this workspace.", { status: 404 });
    }
    const done = await deps.authStore.transferOwnership(id, auth.user.id, userId);
    if (!done) {
      // Lost a race with another ownership change between the checks
      // and the transaction - the one-owner invariant still holds.
      throw new AppError("CONFLICT", "Ownership changed concurrently; reload and retry.", { status: 409 });
    }
    await deps.authStore.audit({
      workspaceId: id, userId: auth.user.id,
      action: "workspace.ownership_transferred",
      details: { fromUserId: auth.user.id, toUserId: userId, toEmail: target.email },
    });
    const fresh = await deps.authStore.listMembers(id);
    return c.json({
      members: fresh,
      workspace: { id, role: "admin" },
    });
  });

  // --------------------------------- public invite preview + accept
  // NOT workspace-header routes: the token in the path IS the
  // capability. Preview is unauthenticated and returns only the
  // workspace's name + the role on offer - never member data. Accept
  // requires a session (any authenticated user) and is an explicit
  // call - nothing joins on preview.

  const invitePreviewRoute = createRoute({
    method: "get", path: "/invites/{token}",
    request: { params: z.object({ token: z.string() }) },
    responses: { 200: { description: "Invite preview (public)" } },
  });
  app.openapi(invitePreviewRoute, async (c) => {
    const found = await deps.authStore.findInviteByHash(hashInviteToken(c.req.valid("param").token));
    if (!found) {
      return c.json({
        valid: false, reason: "invalid",
        workspaceName: null, role: null, expiresAt: null,
      });
    }
    const state = inviteState(found);
    return c.json({
      valid: state === "valid",
      reason: state === "valid" ? null : state,
      workspaceName: found.workspaceName,
      role: found.role,
      expiresAt: iso(found.expiresAt),
    });
  });

  const inviteAcceptRoute = createRoute({
    method: "post", path: "/invites/{token}/accept",
    request: { params: z.object({ token: z.string() }) },
    responses: { 200: { description: "Joined the workspace" } },
  });
  app.openapi(inviteAcceptRoute, async (c) => {
    const user = await authenticateRequest(c);
    const found = await deps.authStore.findInviteByHash(hashInviteToken(c.req.valid("param").token));
    if (!found) {
      throw new AppError("INVITE_INVALID", "This invite link is not valid.", { status: 404 });
    }
    const outcome = await deps.authStore.acceptInvite(found, user.id);
    switch (outcome.status) {
      case "accepted": {
        await deps.authStore.audit({
          workspaceId: found.workspaceId, userId: user.id,
          action: "workspace.invite.accept",
          details: { inviteId: found.id, prefix: found.prefix, role: outcome.role },
        });
        return c.json({
          workspace: { id: found.workspaceId, name: found.workspaceName, slug: found.workspaceSlug, role: outcome.role },
          member: { userId: user.id, email: user.email, name: user.name, role: outcome.role },
        });
      }
      case "already_member":
        throw new AppError("ALREADY_MEMBER", "You are already a member of this workspace.", {
          status: 409, details: { workspaceId: found.workspaceId },
        });
      case "revoked":
        throw new AppError("INVITE_REVOKED", "This invite link has been revoked.", { status: 410 });
      case "expired":
        throw new AppError("INVITE_EXPIRED", "This invite link has expired.", { status: 410 });
      case "exhausted":
        throw new AppError("INVITE_EXHAUSTED", "This invite link has no uses left.", { status: 410 });
      default:
        throw new AppError("INVITE_INVALID", "This invite link is not valid.", { status: 404 });
    }
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
      // Action steps (package #3): record-only like everything above -
      // a test run never tags, assigns, enrolls, or waits for input;
      // the intended actions appear in the returned action list.
      async addTag() { /* recorded */ },
      async removeTag() { /* recorded */ },
      async assignConversation() { return true; },
      async setConversationStatus() { /* recorded */ },
      async subscribeSequence() { return true; },
      async unsubscribeSequence() { /* recorded */ },
      async createDeal() { return true; },
      async awaitInput() { /* recorded: the run reports paused */ },
      async aiReply(input: { prompt: string }) {
        return `[test-run AI reply] ${input.prompt}`.trim();
      },
    };
    const flow = toRunnableFlow(row.id, parsed.data);
    // Test-runs interpolate against a synthetic contact built from the
    // caller's contactFields (variables package #1), so the preview shows
    // exactly what a real run would send for those fields.
    const workspace = await getWorkspaceById(deps.getDatabase(), wsId).catch(() => null);
    const interpolation = buildVariableContext({
      contact: {
        displayName: typeof variables.name === "string" ? variables.name : "Test Contact",
        externalId: "test-contact",
        channel: "test",
        customFields: variables,
      },
      workspaceName: workspace?.name,
    });
    const result = await runFlow(ports, flow, undefined, {
      type: "message.received",
      text: body.text ?? "",
      variables,
    }, { interpolation });
    const actions: FlowAction[] = result.executed;
    return c.json({
      status: result.state.status,
      paused: result.paused,
      actions,
      variables: result.state.variables,
      warnings: result.warnings,
      actionWarnings: result.actionWarnings,
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

  /**
   * Analytics depth, phase 1 (package #8): per-channel volume, the
   * response-time block (waiting now / oldest waiting / over the
   * workspace reply target / median first response split human vs AI,
   * with previous-period medians), and the workspace activity feed.
   * All query-time aggregation - see docs/analytics.md for the exact
   * definitions. `days` is a closed set: 7 or 30.
   */
  const statsInsightsRoute = createRoute({
    method: "get", path: "/stats/insights",
    request: { query: z.object({ days: z.enum(["7", "30"]).optional() }) },
    responses: { 200: { description: "Workspace insights (analytics phase 1)" } },
  });
  app.openapi(statsInsightsRoute, async (c) => {
    const wsId = workspaceId(c);
    const auth = authContext(c);
    const days = Number(c.req.valid("query").days ?? "30");
    const db = deps.getDatabase();
    const workspaces = await deps.authStore.listWorkspaces(auth.user.id);
    const replyTargetMinutes = workspaces.find((w) => w.id === wsId)?.replyTargetMinutes ?? 60;
    const insights = await getWorkspaceInsights(db, wsId, { days, now: new Date(), replyTargetMinutes });
    const activityRows = await listWorkspaceActivity(db, wsId, 50);
    const members = await deps.authStore.listMembers(wsId);
    const memberById = new Map(members.map((m) => [m.userId, m]));
    return c.json({
      ...insights,
      activity: activityRows.map((row) => ({
        id: row.id,
        actor: row.userId
          ? {
              userId: row.userId,
              name: memberById.get(row.userId)?.name ?? null,
              email: memberById.get(row.userId)?.email ?? null,
            }
          : null,
        action: row.action,
        details: row.details,
        createdAt: iso(row.createdAt) ?? "",
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
    // AI copilot (package #7): analysis + takeover stamps travel as ISO
    // (null until the first analyze / pause). Rows from before migration
    // 0013 simply lack the fields - normalize the absence to null.
    aiSummary: r.aiSummary ?? null,
    aiSummaryAt: iso(r.aiSummaryAt),
    aiIntent: r.aiIntent ?? null,
    aiIntentScore: r.aiIntentScore ?? null,
    aiPausedAt: iso(r.aiPausedAt),
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
  /**
   * Shared message serializer: ISO dates, an explicit `kind` (rows from
   * before migration 0008 read as "message"), and the author's display
   * identity for human-written rows (internal notes) resolved from the
   * member list - null once the author has left the workspace.
   */
  const serializeMessage = (
    m: MessageRow,
    memberById: Map<string, { name: string | null; email: string }>,
  ) => ({
    ...m,
    kind: m.kind ?? "message",
    // Producer badge (package #7): rows written before migration 0013
    // read as "human" - none of them came from a badged AI path.
    authorKind: m.authorKind ?? "human",
    createdAt: iso(m.createdAt),
    author: m.authorUserId
      ? {
          userId: m.authorUserId,
          name: memberById.get(m.authorUserId)?.name ?? null,
          email: memberById.get(m.authorUserId)?.email ?? null,
        }
      : null,
  });

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
    const memberById = await memberMapOf(ws);
    return c.json({
      messages: rows.map((m) => serializeMessage(m, memberById)),
    });
  });

  /**
   * Internal notes (package #2): a team-only timeline entry on the
   * conversation. A note is created through THIS route only - it never
   * calls an adapter, never enqueues a send, bypasses the messaging
   * window and the account-connected gate on purpose (agents coordinate
   * precisely when they cannot write to the customer), and persists as
   * a messages row with kind "note" so the thread is one timeline.
   * Customer-facing surfaces filter kind "note" out (webchat widget,
   * AI suggest); the consecutive-outbound counter steps over notes.
   */
  const createNoteRoute = createRoute({
    method: "post", path: "/conversations/{id}/notes",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({ body: z.string().min(1).max(4000) }),
          },
        },
      },
    },
    responses: { 201: { description: "Internal note added" } },
  });
  app.openapi(createNoteRoute, async (c) => {
    const auth = authContext(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const text = c.req.valid("json").body.trim();
    if (!text) throw new AppError("VALIDATION", "Note body must not be empty.", { status: 400 });

    const conversation = await getConversation(db, ws, id);
    if (!conversation) throw new AppError("NOT_FOUND", "Conversation not found.", { status: 404 });

    const note = await createMessage(db, {
      conversationId: id,
      direction: "out",
      kind: "note",
      authorUserId: auth.user.id,
      type: "text",
      body: text,
      // "sent" = fully recorded; a note has no delivery lifecycle.
      status: "sent",
    });
    // Same inbox event shape as a message: other agents' open threads
    // refetch and the note appears live.
    await deps.realtimePublisher.publishInboxMessage({
      workspaceId: ws, conversationId: id, direction: "out", messageId: note.id,
    }).catch(() => undefined);
    const memberById = await memberMapOf(ws);
    return c.json({ message: serializeMessage(note, memberById) }, 201);
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

    // Variable interpolation (variables package #1): free-form agent text
    // and rich blocks render against THIS conversation's contact at send
    // time, and the RENDERED content is what gets persisted and sent, so
    // the thread always shows exactly what the customer received. Unknown
    // variables render empty and come back as `interpolationWarnings`
    // for the composer to surface. Template replies are NOT interpolated
    // (their parameters are positional provider-side values).
    let replyText = body.text;
    let replyRich = body.rich;
    let interpolationWarnings: string[] = [];
    if (body.kind === "free_form" && (body.text || body.rich)) {
      // Enrichment lookups are best-effort: a failed fetch degrades to
      // fewer resolvable variables, never to a blocked reply.
      const [contact, workspace] = await Promise.all([
        getContact(db, ws, conversation.contactId).catch(() => null),
        getWorkspaceById(db, ws).catch(() => null),
      ]);
      const varCtx = buildVariableContext({
        contact: contact
          ? {
              displayName: contact.displayName,
              externalId: contact.externalId,
              channel: contact.channel,
              tags: (contact.tags as string[]) ?? [],
              customFields: (contact.customFields as Record<string, unknown>) ?? {},
            }
          : { externalId: conversation.contactExternalId, channel: conversation.channel },
        workspaceName: workspace?.name,
        channelAccount: account,
      });
      if (replyText) {
        const rendered = interpolate(replyText, varCtx);
        replyText = rendered.text;
        interpolationWarnings.push(...rendered.warnings.map((w) => w.path));
      }
      if (replyRich) {
        const rendered = interpolateRichBlock(replyRich, varCtx);
        replyRich = rendered.block;
        interpolationWarnings.push(...rendered.warnings.map((w) => w.path));
      }
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
        : replyRich ? richToPlainText(replyRich) : replyText,
      payload: body.kind === "free_form" && replyRich ? replyRich : undefined,
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
        text: body.kind === "free_form" ? (replyText ?? (replyRich ? richBlockText(replyRich) : undefined)) : undefined,
        rich: body.kind === "free_form" ? replyRich : undefined,
        template: templateInput,
        // Conversation-addressed channels (TikTok) send to the provider
        // conversation id learned from inbound events; the adapter
        // refuses typed when it is missing rather than guessing.
        conversationExternalId: conversation.externalId ?? undefined,
        idempotencyKey,
      });
      await updateMessageStatus(db, message.id, "sent", result.externalMessageId);
      // AI takeover (package #7): a human replying takes the wheel - any
      // AUTOMATIC AI sends on this conversation pause until a human
      // resumes them (POST /conversations/:id/ai-resume). Only a
      // SUCCESSFUL send pauses: a failed attempt changed nothing the
      // customer saw, so automation keeps its state. Idempotent - an
      // already-paused thread keeps its original stamp.
      if (!conversation.aiPausedAt) {
        await setConversationAiPaused(db, ws, id, true).catch(() => undefined);
        await deps.realtimePublisher
          .publishInboxUpdate({ workspaceId: ws, conversationId: id })
          .catch(() => undefined);
      }
      // Live inbox: dashboards on this workspace refetch the thread.
      await deps.realtimePublisher.publishInboxMessage({
        workspaceId: ws, conversationId: id, direction: "out", messageId: message.id,
      }).catch(() => undefined);
      return c.json({
        message: { ...message, status: "sent", externalId: result.externalMessageId, createdAt: iso(message.createdAt) },
        window: decision,
        ...(result.warnings ? { warnings: result.warnings } : {}),
        ...(interpolationWarnings.length > 0 ? { interpolationWarnings } : {}),
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
    if (status === "resolved") {
      // Collect-input waits (package #3) on a resolved thread end
      // quietly: drop them so a later reopen + reply never resumes a
      // run whose conversation was closed underneath it.
      await deleteFlowWaitsForConversation(db, id).catch(() => undefined);
    }

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

  // -------------------------------------------------------- saved replies
  // Package #2: the workspace's shared quick-reply library. Reads are
  // open to every member (agents compose with them); writes are
  // mutator-role (guardMutator), like other workspace content.
  const serializeSavedReply = (r: SavedReplyRow) => ({
    ...r,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  });
  /** Shortcuts are stored canonical: trimmed, always "/"-prefixed; empty clears. */
  const normalizeShortcut = (raw: string | null | undefined): string | null => {
    if (raw === undefined || raw === null) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  };
  const assertShortcutFree = async (
    db: Database, ws: string, shortcut: string | null, excludeId?: string,
  ): Promise<void> => {
    if (!shortcut) return;
    const clash = await getSavedReplyByShortcut(db, ws, shortcut);
    if (clash && clash.id !== excludeId) {
      throw new AppError(
        "CONFLICT",
        `A saved reply with shortcut ${shortcut} already exists in this workspace.`,
        { status: 409 },
      );
    }
  };
  const shortcutConflict = (shortcut: string | null) => new AppError(
    "CONFLICT",
    `A saved reply with shortcut ${shortcut} already exists in this workspace.`,
    { status: 409 },
  );
  const validateShortcut = (shortcut: string | null): void => {
    if (shortcut && (shortcut.length > 60 || !/^\/\S+$/.test(shortcut))) {
      throw new AppError(
        "VALIDATION",
        "Shortcut must be a single token like /halo (max 60 characters, no spaces).",
        { status: 400 },
      );
    }
  };

  const listSavedRepliesRoute = createRoute({
    method: "get", path: "/saved-replies",
    responses: { 200: { description: "Saved replies" } },
  });
  app.openapi(listSavedRepliesRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const rows = await listSavedReplies(db, ws);
    return c.json({ savedReplies: rows.map(serializeSavedReply) });
  });

  const createSavedReplyRoute = createRoute({
    method: "post", path: "/saved-replies",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              title: z.string().min(1).max(200),
              body: z.string().min(1).max(10000),
              shortcut: z.string().max(60).nullable().optional(),
            }),
          },
        },
      },
    },
    responses: { 201: { description: "Saved reply created" } },
  });
  app.openapi(createSavedReplyRoute, async (c) => {
    guardMutator(c);
    const auth = authContext(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const body = c.req.valid("json");
    const title = body.title.trim();
    const text = body.body.trim();
    if (!title || !text) {
      throw new AppError("VALIDATION", "Title and body must not be empty.", { status: 400 });
    }
    const shortcut = normalizeShortcut(body.shortcut);
    validateShortcut(shortcut);
    await assertShortcutFree(db, ws, shortcut);
    try {
      const row = await createSavedReply(db, {
        workspaceId: ws, title, body: text, shortcut, createdBy: auth.user.id,
      });
      return c.json({ savedReply: serializeSavedReply(row) }, 201);
    } catch (err) {
      // Race backstop: the partial unique index fired between the
      // pre-check and the insert - same typed 409, never a raw 500.
      if (shortcut && isUniqueViolation(err)) throw shortcutConflict(shortcut);
      throw err;
    }
  });

  const updateSavedReplyRoute = createRoute({
    method: "patch", path: "/saved-replies/{id}",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              title: z.string().min(1).max(200).optional(),
              body: z.string().min(1).max(10000).optional(),
              /** null clears the shortcut; absent leaves it unchanged. */
              shortcut: z.string().max(60).nullable().optional(),
            }),
          },
        },
      },
    },
    responses: { 200: { description: "Saved reply updated" } },
  });
  app.openapi(updateSavedReplyRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const existing = await getSavedReply(db, ws, id);
    if (!existing) throw new AppError("NOT_FOUND", "Saved reply not found.", { status: 404 });
    const patch: { title?: string; body?: string; shortcut?: string | null } = {};
    if (body.title !== undefined) {
      const title = body.title.trim();
      if (!title) throw new AppError("VALIDATION", "Title must not be empty.", { status: 400 });
      patch.title = title;
    }
    if (body.body !== undefined) {
      const text = body.body.trim();
      if (!text) throw new AppError("VALIDATION", "Body must not be empty.", { status: 400 });
      patch.body = text;
    }
    if (body.shortcut !== undefined) {
      patch.shortcut = normalizeShortcut(body.shortcut);
      validateShortcut(patch.shortcut);
      await assertShortcutFree(db, ws, patch.shortcut, id);
    }
    try {
      const row = await updateSavedReply(db, ws, id, patch);
      if (!row) throw new AppError("NOT_FOUND", "Saved reply not found.", { status: 404 });
      return c.json({ savedReply: serializeSavedReply(row) });
    } catch (err) {
      if (patch.shortcut && isUniqueViolation(err)) throw shortcutConflict(patch.shortcut);
      throw err;
    }
  });

  const deleteSavedReplyRoute = createRoute({
    method: "delete", path: "/saved-replies/{id}",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Saved reply deleted" } },
  });
  app.openapi(deleteSavedReplyRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const deleted = await deleteSavedReply(db, ws, id);
    if (!deleted) throw new AppError("NOT_FOUND", "Saved reply not found.", { status: 404 });
    return c.json({ deleted: true });
  });

  // ------------------------------------------- sales pipelines + deals
  // Package #6: Kanban sales pipelines. Reads are open to every member;
  // writes are mutator-role (guardMutator), like other workspace content.
  // Cross-workspace ids answer 404 (the row is simply not in this
  // workspace); ids that are in the workspace but mis-composed (foreign
  // contact, a stage from another pipeline) answer 400 VALIDATION - the
  // caller named real things in an impossible combination.
  const serializePipeline = (p: PipelineRow) => ({
    ...p, createdAt: iso(p.createdAt), updatedAt: iso(p.updatedAt),
  });
  const serializeStage = (s: PipelineStageRow) => ({
    ...s, createdAt: iso(s.createdAt), updatedAt: iso(s.updatedAt),
  });
  const serializeDeal = (d: DealRow | DealWithContact) => ({
    ...d,
    // numeric columns arrive as decimal strings (the broadcast money
    // lesson): the wire shape is number | null, never a raw string.
    value: d.value === null || d.value === undefined ? null : Number(d.value),
    stageChangedAt: iso(d.stageChangedAt),
    closedAt: iso(d.closedAt),
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  });
  const dealValidation = (message: string) => new AppError("VALIDATION", message, { status: 400 });
  const requirePipeline = async (db: Database, ws: string, id: string): Promise<PipelineRow> => {
    const pipeline = await getPipeline(db, ws, id);
    if (!pipeline) throw new AppError("NOT_FOUND", "Pipeline not found.", { status: 404 });
    return pipeline;
  };
  /** The workspace's default currency, upper-cased (IDR when unset). */
  const workspaceDefaultCurrency = async (db: Database, ws: string): Promise<string> => {
    const workspace = await getWorkspaceById(db, ws).catch(() => null);
    return (workspace?.defaultCurrency ?? "IDR").toUpperCase();
  };

  const listPipelinesRoute = createRoute({
    method: "get", path: "/pipelines",
    responses: { 200: { description: "Pipelines with their stages" } },
  });
  app.openapi(listPipelinesRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const rows = await listPipelines(db, ws);
    const out = [];
    for (const p of rows) {
      out.push({ ...serializePipeline(p), stages: (await listPipelineStages(db, p.id)).map(serializeStage) });
    }
    return c.json({ pipelines: out });
  });

  const createPipelineRoute = createRoute({
    method: "post", path: "/pipelines",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1).max(200),
              /** Seed the standard five stages (New → Negotiation). */
              withDefaultStages: z.boolean().optional(),
              /** Explicit stage names, in column order (wins over withDefaultStages). */
              stages: z.array(z.string().min(1).max(200)).max(50).optional(),
              makeDefault: z.boolean().optional(),
            }),
          },
        },
      },
    },
    responses: { 201: { description: "Pipeline created" } },
  });
  app.openapi(createPipelineRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const body = c.req.valid("json");
    const name = body.name.trim();
    if (!name) throw dealValidation("Pipeline name must not be empty.");
    const stageNames = (body.stages ?? (body.withDefaultStages ? [...DEFAULT_PIPELINE_STAGE_NAMES] : []))
      .map((s) => s.trim());
    if (stageNames.some((s) => !s)) throw dealValidation("Stage names must not be empty.");
    // The workspace's first pipeline becomes its default automatically.
    const existing = await listPipelines(db, ws);
    const isDefault = body.makeDefault ?? existing.length === 0;
    const { pipeline, stages } = await createPipeline(db, { workspaceId: ws, name, isDefault, stageNames });
    return c.json({ pipeline: { ...serializePipeline(pipeline), stages: stages.map(serializeStage) } }, 201);
  });

  const updatePipelineRoute = createRoute({
    method: "patch", path: "/pipelines/{id}",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1).max(200).optional(),
              isDefault: z.boolean().optional(),
            }),
          },
        },
      },
    },
    responses: { 200: { description: "Pipeline updated" } },
  });
  app.openapi(updatePipelineRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    await requirePipeline(db, ws, id);
    const patch: { name?: string; isDefault?: boolean } = {};
    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) throw dealValidation("Pipeline name must not be empty.");
      patch.name = name;
    }
    if (body.isDefault !== undefined) patch.isDefault = body.isDefault;
    const row = await updatePipeline(db, ws, id, patch);
    if (!row) throw new AppError("NOT_FOUND", "Pipeline not found.", { status: 404 });
    const stages = await listPipelineStages(db, id);
    return c.json({ pipeline: { ...serializePipeline(row), stages: stages.map(serializeStage) } });
  });

  const deletePipelineRoute = createRoute({
    method: "delete", path: "/pipelines/{id}",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Pipeline deleted" } },
  });
  app.openapi(deletePipelineRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    await requirePipeline(db, ws, id);
    // Delete semantics mirror the channel-account precedent: a pipeline
    // carrying deals is never destroyed by accident. The bare DELETE is
    // a 409; ?force=true is the explicit, auditable override and takes
    // the deals + stages with it.
    const dealCount = await countPipelineDeals(db, id);
    if (dealCount > 0 && c.req.query("force") !== "true") {
      throw new AppError(
        "CONFLICT",
        `Pipeline still holds ${dealCount} deal(s). Delete it with ?force=true to remove them with it.`,
        { status: 409, details: { reason: "pipeline_has_deals", dealCount } },
      );
    }
    await deletePipelineCascade(db, ws, id);
    return c.json({ deleted: true });
  });

  const pipelineSummaryRoute = createRoute({
    method: "get", path: "/pipelines/{id}/summary",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Per-stage open totals + won/lost totals" } },
  });
  app.openapi(pipelineSummaryRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    await requirePipeline(db, ws, id);
    return c.json({ summary: await getPipelineSummary(db, ws, id) });
  });

  const createStageRoute = createRoute({
    method: "post", path: "/pipelines/{id}/stages",
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { "application/json": { schema: z.object({ name: z.string().min(1).max(200) }) } } },
    },
    responses: { 201: { description: "Stage added at the end of the pipeline" } },
  });
  app.openapi(createStageRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    await requirePipeline(db, ws, id);
    const name = c.req.valid("json").name.trim();
    if (!name) throw dealValidation("Stage name must not be empty.");
    const stage = await createPipelineStage(db, id, name);
    return c.json({ stage: serializeStage(stage) }, 201);
  });

  const updateStageRoute = createRoute({
    method: "patch", path: "/pipelines/{id}/stages/{stageId}",
    request: {
      params: z.object({ id: z.string(), stageId: z.string() }),
      body: { content: { "application/json": { schema: z.object({ name: z.string().min(1).max(200) }) } } },
    },
    responses: { 200: { description: "Stage renamed" } },
  });
  app.openapi(updateStageRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id, stageId } = c.req.valid("param");
    await requirePipeline(db, ws, id);
    const name = c.req.valid("json").name.trim();
    if (!name) throw dealValidation("Stage name must not be empty.");
    const row = await updatePipelineStage(db, id, stageId, { name });
    if (!row) throw new AppError("NOT_FOUND", "Pipeline stage not found.", { status: 404 });
    return c.json({ stage: serializeStage(row) });
  });

  const deleteStageRoute = createRoute({
    method: "delete", path: "/pipelines/{id}/stages/{stageId}",
    request: { params: z.object({ id: z.string(), stageId: z.string() }) },
    responses: { 200: { description: "Stage deleted" } },
  });
  app.openapi(deleteStageRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id, stageId } = c.req.valid("param");
    await requirePipeline(db, ws, id);
    const stage = await getPipelineStage(db, id, stageId);
    if (!stage) throw new AppError("NOT_FOUND", "Pipeline stage not found.", { status: 404 });
    // Deals must be moved out first - a stage full of deals is never
    // silently emptied (there is no ?force here by design).
    const dealCount = await countStageDeals(db, stageId);
    if (dealCount > 0) {
      throw new AppError(
        "CONFLICT",
        `Stage still holds ${dealCount} deal(s). Move them to another stage before deleting it.`,
        { status: 409, details: { reason: "stage_has_deals", dealCount } },
      );
    }
    await deletePipelineStage(db, id, stageId);
    return c.json({ deleted: true });
  });

  const reorderStagesRoute = createRoute({
    method: "post", path: "/pipelines/{id}/stages/reorder",
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { "application/json": { schema: z.object({ stageIds: z.array(z.string().min(1)) }) } } },
    },
    responses: { 200: { description: "Stages in their new order" } },
  });
  app.openapi(reorderStagesRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    await requirePipeline(db, ws, id);
    const { stageIds } = c.req.valid("json");
    const current = await listPipelineStages(db, id);
    const currentIds = new Set(current.map((s) => s.id));
    if (stageIds.length !== current.length || stageIds.some((s) => !currentIds.has(s))) {
      throw dealValidation("stageIds must list every stage of the pipeline exactly once.");
    }
    const stages = await reorderPipelineStages(db, id, stageIds);
    return c.json({ stages: stages.map(serializeStage) });
  });

  const dealStatusSchema = z.enum(["open", "won", "lost"]);
  const dealCurrencySchema = z.string().regex(/^[A-Za-z]{3}$/);
  const dealDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

  const listDealsRoute = createRoute({
    method: "get", path: "/deals",
    request: {
      query: z.object({
        pipelineId: z.string().optional(),
        stageId: z.string().optional(),
        status: dealStatusSchema.optional(),
        contactId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      }),
    },
    responses: { 200: { description: "Deals + total" } },
  });
  app.openapi(listDealsRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const q = c.req.valid("query");
    const { deals, total } = await listDeals(db, ws, {
      pipelineId: q.pipelineId, stageId: q.stageId, status: q.status,
      contactId: q.contactId, limit: q.limit, offset: q.offset,
    });
    return c.json({ deals: deals.map(serializeDeal), total });
  });

  /** Compose a deal's targets from ids, all workspace-checked (400s). */
  const resolveDealTargets = async (
    db: Database, ws: string,
    input: { pipelineId: string; stageId?: string; contactId: string; conversationId?: string | null },
  ): Promise<{ pipeline: PipelineRow; stage: PipelineStageRow }> => {
    const contact = await getContact(db, ws, input.contactId);
    if (!contact) throw dealValidation("contactId does not reference a contact in this workspace.");
    const pipeline = await getPipeline(db, ws, input.pipelineId);
    if (!pipeline) throw dealValidation("pipelineId does not reference a pipeline in this workspace.");
    let stage: PipelineStageRow | null;
    if (input.stageId) {
      stage = await getPipelineStage(db, pipeline.id, input.stageId);
      if (!stage) throw dealValidation("stageId does not reference a stage of the given pipeline.");
    } else {
      const stages = await listPipelineStages(db, pipeline.id);
      stage = stages[0] ?? null;
      if (!stage) throw dealValidation("The pipeline has no stages yet - add a stage before creating deals.");
    }
    if (input.conversationId) {
      const conversation = await getConversation(db, ws, input.conversationId);
      if (!conversation) throw dealValidation("conversationId does not reference a conversation in this workspace.");
    }
    return { pipeline, stage };
  };

  const createDealRoute = createRoute({
    method: "post", path: "/deals",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              pipelineId: z.string().min(1),
              stageId: z.string().min(1).optional(),
              contactId: z.string().min(1),
              conversationId: z.string().min(1).nullable().optional(),
              title: z.string().min(1).max(300),
              value: z.number().nonnegative().nullable().optional(),
              currency: dealCurrencySchema.optional(),
              expectedCloseDate: dealDateSchema.nullable().optional(),
              notes: z.string().max(5000).nullable().optional(),
            }),
          },
        },
      },
    },
    responses: { 201: { description: "Deal created" } },
  });
  app.openapi(createDealRoute, async (c) => {
    guardMutator(c);
    const auth = authContext(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const body = c.req.valid("json");
    const title = body.title.trim();
    if (!title) throw dealValidation("Deal title must not be empty.");
    const { stage } = await resolveDealTargets(db, ws, body);
    const row = await createDeal(db, {
      workspaceId: ws,
      pipelineId: body.pipelineId,
      stageId: stage.id,
      contactId: body.contactId,
      conversationId: body.conversationId ?? null,
      title,
      value: body.value === undefined || body.value === null ? null : String(body.value),
      currency: body.currency?.toUpperCase() ?? (await workspaceDefaultCurrency(db, ws)),
      expectedCloseDate: body.expectedCloseDate ?? null,
      notes: body.notes ?? null,
      createdByUserId: auth.user.id,
    });
    const full = await getDeal(db, ws, row.id);
    return c.json({ deal: serializeDeal(full ?? row) }, 201);
  });

  const getDealRoute = createRoute({
    method: "get", path: "/deals/{id}",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "One deal" } },
  });
  app.openapi(getDealRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const deal = await getDeal(db, ws, c.req.valid("param").id);
    if (!deal) throw new AppError("NOT_FOUND", "Deal not found.", { status: 404 });
    return c.json({ deal: serializeDeal(deal) });
  });

  const updateDealRoute = createRoute({
    method: "patch", path: "/deals/{id}",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              title: z.string().min(1).max(300).optional(),
              pipelineId: z.string().min(1).optional(),
              stageId: z.string().min(1).optional(),
              contactId: z.string().min(1).optional(),
              conversationId: z.string().min(1).nullable().optional(),
              value: z.number().nonnegative().nullable().optional(),
              currency: dealCurrencySchema.optional(),
              status: dealStatusSchema.optional(),
              expectedCloseDate: dealDateSchema.nullable().optional(),
              notes: z.string().max(5000).nullable().optional(),
            }),
          },
        },
      },
    },
    responses: { 200: { description: "Deal updated" } },
  });
  app.openapi(updateDealRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const existing = await getDeal(db, ws, id);
    if (!existing) throw new AppError("NOT_FOUND", "Deal not found.", { status: 404 });

    const patch: Parameters<typeof updateDeal>[3] = {};
    if (body.title !== undefined) {
      const title = body.title.trim();
      if (!title) throw dealValidation("Deal title must not be empty.");
      patch.title = title;
    }
    // Pipeline / stage composition: the stage must belong to the
    // (possibly new) pipeline; switching pipelines without naming a
    // stage lands the deal in the new pipeline's first stage.
    const targetPipelineId = body.pipelineId ?? existing.pipelineId;
    if (body.pipelineId !== undefined && body.pipelineId !== existing.pipelineId) {
      const pipeline = await getPipeline(db, ws, body.pipelineId);
      if (!pipeline) throw dealValidation("pipelineId does not reference a pipeline in this workspace.");
      patch.pipelineId = body.pipelineId;
    }
    if (body.stageId !== undefined || patch.pipelineId !== undefined) {
      let stage: PipelineStageRow | null;
      if (body.stageId !== undefined) {
        stage = await getPipelineStage(db, targetPipelineId, body.stageId);
        if (!stage) throw dealValidation("stageId does not reference a stage of the deal's pipeline.");
      } else {
        const stages = await listPipelineStages(db, targetPipelineId);
        stage = stages[0] ?? null;
        if (!stage) throw dealValidation("The target pipeline has no stages yet.");
      }
      if (stage.id !== existing.stageId || patch.pipelineId !== undefined) {
        patch.stageId = stage.id;
        patch.stageChangedAt = new Date();
      }
    }
    if (body.contactId !== undefined && body.contactId !== existing.contactId) {
      const contact = await getContact(db, ws, body.contactId);
      if (!contact) throw dealValidation("contactId does not reference a contact in this workspace.");
      patch.contactId = body.contactId;
    }
    if (body.conversationId !== undefined) {
      if (body.conversationId !== null) {
        const conversation = await getConversation(db, ws, body.conversationId);
        if (!conversation) throw dealValidation("conversationId does not reference a conversation in this workspace.");
      }
      patch.conversationId = body.conversationId;
    }
    if (body.value !== undefined) patch.value = body.value === null ? null : String(body.value);
    if (body.currency !== undefined) patch.currency = body.currency.toUpperCase();
    if (body.status !== undefined && body.status !== existing.status) {
      patch.status = body.status as DealStatus;
      // Closing stamps closedAt; reopening clears it.
      patch.closedAt = body.status === "open" ? null : new Date();
    }
    if (body.expectedCloseDate !== undefined) patch.expectedCloseDate = body.expectedCloseDate;
    if (body.notes !== undefined) patch.notes = body.notes;

    const row = await updateDeal(db, ws, id, patch);
    if (!row) throw new AppError("NOT_FOUND", "Deal not found.", { status: 404 });
    const full = await getDeal(db, ws, row.id);
    return c.json({ deal: serializeDeal(full ?? row) });
  });

  const deleteDealRoute = createRoute({
    method: "delete", path: "/deals/{id}",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Deal deleted" } },
  });
  app.openapi(deleteDealRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const deleted = await deleteDeal(db, ws, id);
    if (!deleted) throw new AppError("NOT_FOUND", "Deal not found.", { status: 404 });
    return c.json({ deleted: true });
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
    const body = c.req.valid("json");
    // Validate the account BEFORE the insert (same idiom as broadcasts /
    // sequences / growth-links): a bogus or cross-workspace id must be a
    // typed 404, not a raw FK violation surfacing as a 500.
    const account = await getChannelAccount(db, ws, body.channelAccountId);
    if (!account) throw new AppError("NOT_FOUND", "Channel account not found.", { status: 404 });
    const row = await createTemplate(db, { workspaceId: ws, ...body });
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
  /**
   * postgres-js returns drizzle `numeric` columns as strings, so a raw
   * broadcast row carries estimatedCostUsd as "0.100000" (or null).
   * Money crosses the wire as a JSON number or null - the same
   * Number(...) normalization every other cost serializer applies.
   */
  const usdOrNull = (value: string | null | undefined): number | null =>
    value === null || value === undefined ? null : Number(value);

  const createBroadcastRoute = createRoute({
    method: "post", path: "/broadcasts",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              channelAccountId: z.string().min(1),
              templateId: z.string().optional(),
              /**
               * Ordered body positional parameter templates (variables
               * package #1): each entry is interpolated PER RECIPIENT at
               * send time. Requires templateId - they only make sense as
               * a template's body components.
               */
              templateParams: z.array(z.string().min(1).max(1000)).max(25).optional(),
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

    if (body.templateParams && body.templateParams.length > 0 && !body.templateId) {
      throw new AppError("VALIDATION", "templateParams requires a templateId: parameters only render into a template broadcast.", { status: 400 });
    }

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
      templateParams: body.templateParams,
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
      broadcast: {
        ...broadcast,
        status: "queued",
        estimatedCostUsd: usdOrNull(broadcast.estimatedCostUsd),
        createdAt: iso(broadcast.createdAt),
      },
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
        estimatedCostUsd: usdOrNull(row.estimatedCostUsd),
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
      broadcast: {
        ...broadcast,
        estimatedCostUsd: usdOrNull(broadcast.estimatedCostUsd),
        createdAt: iso(broadcast.createdAt),
      },
      sentCount: broadcast.sentCount,
      failedCount: broadcast.failedCount,
      totalCostUsd: cost.totalUsd,
      costEntries: cost.entries,
      costUnits: cost.units,
    });
  });

  // Per-recipient delivery records (package #4): the aggregate counts
  // above say HOW MANY; these rows say WHO, at which lifecycle stage,
  // and why a send failed. Filtering + pagination happen after the
  // fetch so the per-status counts always describe the WHOLE broadcast.
  const listBroadcastRecipientsRoute = createRoute({
    method: "get", path: "/broadcasts/{id}/recipients",
    request: {
      params: z.object({ id: z.string() }),
      query: z.object({
        status: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      }),
    },
    responses: { 200: { description: "Recipient rows + per-status counts for the broadcast" } },
  });
  app.openapi(listBroadcastRecipientsRoute, async (c) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const broadcast = await getBroadcast(db, ws, id);
    if (!broadcast) throw new AppError("NOT_FOUND", "Broadcast not found.", { status: 404 });
    const query = c.req.valid("query");
    const all = await listBroadcastRecipients(db, ws, id);
    const counts: Record<string, number> = {
      pending: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, total: all.length,
    };
    for (const row of all) {
      if (row.status in counts) counts[row.status] = (counts[row.status] ?? 0) + 1;
    }
    const filtered = query.status ? all.filter((r) => r.status === query.status) : all;
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    return c.json({
      recipients: filtered.slice(offset, offset + limit).map((r) => ({
        ...r,
        sentAt: iso(r.sentAt),
        deliveredAt: iso(r.deliveredAt),
        readAt: iso(r.readAt),
        repliedAt: iso(r.repliedAt),
        createdAt: iso(r.createdAt),
        updatedAt: iso(r.updatedAt),
      })),
      counts,
      total: filtered.length,
      limit,
      offset,
    });
  });

  const resendFailedBroadcastRoute = createRoute({
    method: "post", path: "/broadcasts/{id}/resend-failed",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Failed recipients re-queued" } },
  });
  app.openapi(resendFailedBroadcastRoute, async (c) => {
    guardMutator(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const broadcast = await getBroadcast(db, ws, id);
    if (!broadcast) throw new AppError("NOT_FOUND", "Broadcast not found.", { status: 404 });
    const contactIds = await listFailedBroadcastRecipientContactIds(db, ws, id);
    if (contactIds.length === 0) return c.json({ resent: 0 });
    // Reset first so a concurrent resend finds nothing left to queue;
    // if the enqueue itself fails the rows go back to failed with the
    // reason instead of dangling in pending forever.
    await resetBroadcastRecipients(db, { broadcastId: id, contactIds, to: "pending" });
    try {
      await deps.broadcastEnqueuer.enqueueBroadcast(id, {
        contactIds,
        resendToken: crypto.randomUUID(),
      });
    } catch (err) {
      await resetBroadcastRecipients(db, {
        broadcastId: id, contactIds, to: "failed", error: "Resend could not be queued - try again.",
      }).catch(() => undefined);
      throw err;
    }
    return c.json({ resent: contactIds.length });
  });

  // ------------------------------------------------------- AI (Fase 2)
  /**
   * AI usage -> cost_ledger (package #7): EVERY AI call writes one row
   * (category "ai", amount 0 - there is no per-model rate card, so the
   * token count is the truth and no price is invented). Units are the
   * call's total tokens when the provider returned usage, else NULL.
   * Bookkeeping is best-effort, like the broadcast recipient rows: a
   * ledger failure is logged, never allowed to fail the AI call itself.
   */
  const recordAiUsage = async (input: {
    db: Database;
    workspaceId: string;
    channelAccountId?: string;
    channel: string;
    model: string;
    usage?: { inputTokens: number; outputTokens: number };
    referenceId: string;
  }): Promise<void> => {
    try {
      await insertAiUsageLedger(input.db, {
        workspaceId: input.workspaceId,
        channelAccountId: input.channelAccountId,
        channel: input.channel,
        model: input.model,
        totalTokens: input.usage ? input.usage.inputTokens + input.usage.outputTokens : null,
        referenceId: input.referenceId,
      });
    } catch (err) {
      console.warn(
        `[api] ai usage ledger write failed (reference ${input.referenceId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

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
    // Internal notes stay out of the prompt: they are team coordination,
    // not conversation history, and must never bleed into a customer-
    // facing draft.
    const history = (await listMessages(db, id)).filter((m) => m.kind !== "note").slice(-20);
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
          const embeddingModel = deps.env.AI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
          const queryEmbedding = await provider.embedding({
            model: embeddingModel,
            text: lastInbound,
          });
          // The embedding seam returns no usage (bare vector), so this
          // row records the call with NULL tokens - never an estimate.
          await recordAiUsage({
            db, workspaceId: ws, channelAccountId: conversation.channelAccountId,
            channel: conversation.channel, model: embeddingModel, referenceId: id,
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
    await recordAiUsage({
      db, workspaceId: ws, channelAccountId: conversation.channelAccountId,
      channel: conversation.channel, model: result.model, usage: result.usage, referenceId: id,
    });
    return c.json({ suggestion: result.text, model: result.model, kbChunksUsed });
  });

  /**
   * AI analysis (package #7): one chat call -> {summary, intent,
   * intentScore} persisted on the conversation. Fail-closed exactly
   * like ai-suggest (503 when no provider is configured - an analysis
   * is never faked), and strict about the model's answer: malformed
   * output is a typed 502 AI_RESPONSE_INVALID and NOTHING is persisted
   * (the usage row for the call itself is still written - the tokens
   * were spent either way; see recordAiUsage).
   */
  const aiAnalyzeRoute = createRoute({
    method: "post", path: "/conversations/{id}/ai-analyze",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "AI conversation analysis persisted" } },
  });
  app.openapi(aiAnalyzeRoute, async (c) => {
    requireRole(c.get("auth"), ROLES);
    const provider = deps.getAiProvider();
    if (!provider) {
      throw new AppError(
        "CONFIGURATION",
        "No AI provider is configured (AI_API_KEY); analysis is unavailable and is never faked.",
        { status: 503 },
      );
    }
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const { id } = c.req.valid("param");
    const conversation = await getConversation(db, ws, id);
    if (!conversation) throw new AppError("NOT_FOUND", "Conversation not found.", { status: 404 });
    // Internal notes never enter the prompt (same rule as ai-suggest).
    const history = (await listMessages(db, id))
      .filter((m) => m.kind !== "note")
      .slice(-CONVERSATION_ANALYSIS_HISTORY_CAP);
    const result = await provider.chatCompletion({
      model: deps.env.AI_MODEL ?? DEFAULT_AI_MODEL,
      temperature: 0,
      messages: buildConversationAnalysisMessages(
        history.map((m) => ({ direction: m.direction as "in" | "out", body: m.body })),
      ),
    });
    await recordAiUsage({
      db, workspaceId: ws, channelAccountId: conversation.channelAccountId,
      channel: conversation.channel, model: result.model, usage: result.usage, referenceId: id,
    });
    // Throws AI_RESPONSE_INVALID (502) on malformed output - before ANY
    // analysis field is written.
    const analysis = parseConversationAnalysis(result.text);
    const updated = await updateConversationAiAnalysis(db, ws, id, analysis);
    if (!updated) throw new AppError("NOT_FOUND", "Conversation not found.", { status: 404 });
    return c.json({
      aiSummary: updated.aiSummary,
      aiSummaryAt: iso(updated.aiSummaryAt),
      aiIntent: updated.aiIntent,
      aiIntentScore: updated.aiIntentScore,
      model: result.model,
    });
  });

  /**
   * AI takeover (package #7): pause/resume AUTOMATIC AI sends on one
   * conversation. While ai_paused_at is set, the worker's ai_reply port
   * returns null before calling the model (the flow sends its authored
   * fallback instead). Agent-invoked tools (ai-suggest, ai-analyze) are
   * deliberately NOT blocked - pausing automation must not disarm the
   * human's own instruments.
   */
  const aiPauseRoute = createRoute({
    method: "post", path: "/conversations/{id}/ai-pause",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Automatic AI paused for this conversation" } },
  });
  const aiResumeRoute = createRoute({
    method: "post", path: "/conversations/{id}/ai-resume",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Automatic AI resumed for this conversation" } },
  });
  const applyAiPauseToggle = async (c: Ctx, id: string, paused: boolean) => {
    requireRole(c.get("auth"), ROLES);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const conversation = await getConversation(db, ws, id);
    if (!conversation) throw new AppError("NOT_FOUND", "Conversation not found.", { status: 404 });
    // Idempotent: re-pausing keeps the original stamp, re-resuming an
    // unpaused thread is a no-op - the write only happens on a change.
    const already = Boolean(conversation.aiPausedAt);
    let aiPausedAt = conversation.aiPausedAt;
    if (paused !== already) {
      const updated = await setConversationAiPaused(db, ws, id, paused);
      if (!updated) throw new AppError("NOT_FOUND", "Conversation not found.", { status: 404 });
      aiPausedAt = updated.aiPausedAt;
      // Other open inboxes refresh their thread header state.
      await deps.realtimePublisher
        .publishInboxUpdate({ workspaceId: ws, conversationId: id })
        .catch(() => undefined);
    }
    const memberById = await memberMapOf(ws);
    return c.json({
      conversation: serializeConversation({ ...conversation, aiPausedAt }, memberById),
    });
  };
  app.openapi(aiPauseRoute, async (c) => applyAiPauseToggle(c, c.req.valid("param").id, true));
  app.openapi(aiResumeRoute, async (c) => applyAiPauseToggle(c, c.req.valid("param").id, false));

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
    status: d.status ?? "pending",
    chunkCount: d.chunkCount ?? 0,
    error: d.error ?? undefined,
    sourceFilename: d.sourceFilename ?? undefined,
    createdAt: iso(d.createdAt),
  });

  /** KB creation requires an AI provider (ingestion embeds the chunks) - fail fast, never fake. */
  const requireKbAiProvider = (): void => {
    if (!deps.getAiProvider()) {
      throw new AppError(
        "CONFIGURATION",
        "No AI provider is configured (AI_API_KEY); KB ingestion needs embeddings and is never faked.",
        { status: 503 },
      );
    }
  };

  /**
   * Shared KB document creation: persist + enqueue the kb-ingest job
   * (chunk + embed in the worker). Used by both the typed-text route and
   * the file-upload route so every document flows through ONE pipeline.
   * A queue failure surfaces as 503; the document stays "pending".
   */
  const persistKbDocument = async (
    c: Ctx,
    input: { title: string; content: string; sourceFilename?: string | null },
  ) => {
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const doc = await createKbDocument(db, {
      workspaceId: ws,
      title: input.title,
      sourceText: input.content,
      sourceFilename: input.sourceFilename ?? null,
    });
    await deps.kbEnqueuer.enqueueKbIngest({ workspaceId: ws, documentId: doc.id });
    return doc;
  };

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
    requireKbAiProvider();
    const body = c.req.valid("json");
    const doc = await persistKbDocument(c, { title: body.title, content: body.content });
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

  // File upload: multipart form (file + optional title). The text is
  // extracted server-side (PDF/DOCX/TXT/MD - see ./kb-upload.ts) and the
  // result becomes a normal KB document via persistKbDocument; the
  // original file is never stored. Extraction failures are honest typed
  // errors (400 wrong type/oversize, 422 unreadable/no text layer).
  app.post("/kb/documents/upload", async (c) => {
    guardMutator(c);
    requireKbAiProvider();
    const limits = { ...DEFAULT_KB_UPLOAD_LIMITS, ...deps.kbUploadLimits };
    const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
    const file = form.file;
    if (!(file instanceof File)) {
      throw new AppError("VALIDATION", "Multipart form field 'file' is required.", { status: 400 });
    }
    if (file.size > limits.maxFileBytes) {
      throw new AppError(
        "VALIDATION",
        `File is too large: ${file.size} bytes exceeds the ${limits.maxFileBytes}-byte (10 MB) upload limit.`,
        { status: 400, details: { maxFileBytes: limits.maxFileBytes } },
      );
    }
    const filename = sanitizeUploadFilename(file.name || "upload");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const extraction = await extractKbFileText({ filename, bytes }, limits);
    const rawTitle = typeof form.title === "string" ? form.title.trim() : "";
    if (rawTitle.length > 300) {
      throw new AppError("VALIDATION", "Title must be at most 300 characters.", { status: 400 });
    }
    const doc = await persistKbDocument(c, {
      title: rawTitle || titleFromFilename(filename),
      content: extraction.text,
      sourceFilename: filename,
    });
    return c.json({
      document: serializeKbDocument(doc),
      extraction: {
        format: extraction.format,
        chars: extraction.chars,
        truncated: extraction.truncated,
        sourceFilename: filename,
      },
    }, 201);
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
    // This listing is CUSTOMER-facing (the visitor's own widget): internal
    // notes (kind "note", package #2) must never reach it.
    const visible = rows.filter((m) => m.kind !== "note");
    const filtered = after
      ? visible.filter((m) => m.createdAt.toISOString() > after)
      : visible;
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
      /** Per-recipient body parameter templates (variables package #1). */
      templateParams: z.array(z.string().min(1).max(1000)).max(25).optional(),
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

  // ------------------------------------------- outbound webhooks (#10)
  // Workspace-scoped signed event subscriptions (Settings -> Webhooks).
  // Management is an owner/admin surface (settings resource): members
  // and agents get 403. The signing secret is generated server-side,
  // sealed with the platform vault key, and returned in plaintext
  // EXACTLY ONCE (create / rotate-secret responses) - list reads carry
  // no secret material at all. URL validation mirrors the delivery-time
  // SSRF guard, so an endpoint that cannot be safely delivered to is
  // refused at write time with the reason attached.
  const webhookEndpointView = (row: WebhookEndpointRow) => ({
    id: row.id,
    name: row.name,
    url: row.url,
    events: Array.isArray(row.events) ? (row.events as string[]) : [],
    enabled: row.enabled,
    consecutiveFailures: row.consecutiveFailures,
    disabledAt: iso(row.disabledAt),
    autoDisabled: row.disabledBySystem === true,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
  const webhookDeliveryView = (row: WebhookDeliveryRow) => ({
    id: row.id,
    endpointId: row.endpointId,
    event: row.event,
    status: row.status,
    responseStatus: row.responseStatus,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: iso(row.createdAt),
    deliveredAt: iso(row.deliveredAt),
  });
  const guardWebhookAdmin = (c: Ctx): void => {
    requireRole(authContext(c), ADMIN_ROLES);
  };
  const webhookVaultKey = (): Buffer => {
    const key = tryParseVaultKey(deps.env.TOKEN_VAULT_KEY);
    if (!key) {
      throw new AppError(
        "CONFIGURATION",
        "Outbound webhook secrets require TOKEN_VAULT_KEY to be configured on the server.",
        { status: 503 },
      );
    }
    return key;
  };
  const validateWebhookUrl = async (raw: string): Promise<string> => {
    const check = await checkOutboundWebhookUrl(raw);
    if (!check.ok) {
      throw new AppError(
        "VALIDATION",
        `Webhook URL rejected: ${check.reason}`,
        { status: 400, details: { reason: check.reason } },
      );
    }
    return check.url.toString();
  };
  const webhookName = (raw: string): string => {
    const name = raw.trim();
    if (!name) throw new AppError("VALIDATION", "Webhook name must not be empty.", { status: 400 });
    return name;
  };
  const loadWebhookEndpoint = async (ws: string, id: string): Promise<WebhookEndpointRow> => {
    const row = await getWebhookEndpoint(deps.getDatabase(), ws, id);
    if (!row) throw new AppError("NOT_FOUND", "Webhook endpoint not found.", { status: 404 });
    return row;
  };

  const webhookEventsBody = z.object({
    name: z.string().min(1).max(200),
    url: z.string().min(1).max(2000),
    events: z.array(z.string()).min(1),
  });

  const createWebhookRoute = createRoute({
    method: "post", path: "/settings/webhooks",
    request: { body: { content: { "application/json": { schema: webhookEventsBody } } } },
    responses: { 201: { description: "Webhook endpoint created; `secret` is shown ONCE - store it now" } },
  });
  app.openapi(createWebhookRoute, async (c) => {
    guardWebhookAdmin(c);
    const auth = authContext(c);
    const ws = workspaceId(c);
    const body = c.req.valid("json");
    const events = parseWebhookEvents(body.events);
    if (!events) {
      throw new AppError("VALIDATION", "Events must be a non-empty list of supported event types.", { status: 400 });
    }
    const url = await validateWebhookUrl(body.url);
    const secret = generateWebhookSecret();
    const row = await createWebhookEndpoint(deps.getDatabase(), {
      workspaceId: ws,
      name: webhookName(body.name),
      url,
      secretSealed: sealSettingValue(webhookVaultKey(), secret),
      events,
    });
    await deps.authStore.audit({
      workspaceId: ws, userId: auth.user.id, action: "webhook_endpoint.created",
      details: { endpointId: row.id, url: row.url, events },
    });
    // The raw secret leaves the server only here (and at rotation).
    return c.json({ ...webhookEndpointView(row), secret }, 201);
  });

  const listWebhooksRoute = createRoute({
    method: "get", path: "/settings/webhooks",
    responses: { 200: { description: "Webhook endpoints (no secret material)" } },
  });
  app.openapi(listWebhooksRoute, async (c) => {
    guardWebhookAdmin(c);
    const ws = workspaceId(c);
    const rows = await listWebhookEndpoints(deps.getDatabase(), ws);
    return c.json({ webhooks: rows.map(webhookEndpointView) });
  });

  const patchWebhookRoute = createRoute({
    method: "patch", path: "/settings/webhooks/{id}",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1).max(200).optional(),
              url: z.string().min(1).max(2000).optional(),
              events: z.array(z.string()).min(1).optional(),
              enabled: z.boolean().optional(),
            }),
          },
        },
      },
    },
    responses: { 200: { description: "Webhook endpoint updated" } },
  });
  app.openapi(patchWebhookRoute, async (c) => {
    guardWebhookAdmin(c);
    const auth = authContext(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const existing = await loadWebhookEndpoint(ws, c.req.valid("param").id);
    const body = c.req.valid("json");
    const patch: Parameters<typeof updateWebhookEndpoint>[3] = {};
    if (body.name !== undefined) patch.name = webhookName(body.name);
    if (body.url !== undefined) patch.url = await validateWebhookUrl(body.url);
    if (body.events !== undefined) {
      const events = parseWebhookEvents(body.events);
      if (!events) {
        throw new AppError("VALIDATION", "Events must be a non-empty list of supported event types.", { status: 400 });
      }
      patch.events = events;
    }
    if (body.enabled !== undefined) {
      patch.enabled = body.enabled;
      if (body.enabled) {
        // Manual re-enable is the recovery path from auto-disable:
        // the failure streak and the system stamps reset.
        patch.consecutiveFailures = 0;
        patch.disabledAt = null;
        patch.disabledBySystem = null;
      }
    }
    const row = await updateWebhookEndpoint(db, ws, existing.id, patch);
    if (!row) throw new AppError("NOT_FOUND", "Webhook endpoint not found.", { status: 404 });
    await deps.authStore.audit({
      workspaceId: ws, userId: auth.user.id, action: "webhook_endpoint.updated",
      details: { endpointId: row.id, fields: Object.keys(patch) },
    });
    return c.json(webhookEndpointView(row));
  });

  const rotateWebhookRoute = createRoute({
    method: "post", path: "/settings/webhooks/{id}/rotate-secret",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Secret rotated; the new `secret` is shown ONCE and the old one stops working immediately" } },
  });
  app.openapi(rotateWebhookRoute, async (c) => {
    guardWebhookAdmin(c);
    const auth = authContext(c);
    const ws = workspaceId(c);
    const existing = await loadWebhookEndpoint(ws, c.req.valid("param").id);
    const secret = generateWebhookSecret();
    const row = await updateWebhookEndpoint(deps.getDatabase(), ws, existing.id, {
      secretSealed: sealSettingValue(webhookVaultKey(), secret),
    });
    if (!row) throw new AppError("NOT_FOUND", "Webhook endpoint not found.", { status: 404 });
    await deps.authStore.audit({
      workspaceId: ws, userId: auth.user.id, action: "webhook_endpoint.secret_rotated",
      details: { endpointId: row.id },
    });
    return c.json({ ...webhookEndpointView(row), secret });
  });

  const deleteWebhookRoute = createRoute({
    method: "delete", path: "/settings/webhooks/{id}",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Webhook endpoint and its delivery history deleted" } },
  });
  app.openapi(deleteWebhookRoute, async (c) => {
    guardWebhookAdmin(c);
    const auth = authContext(c);
    const ws = workspaceId(c);
    const removed = await deleteWebhookEndpoint(deps.getDatabase(), ws, c.req.valid("param").id);
    if (!removed) throw new AppError("NOT_FOUND", "Webhook endpoint not found.", { status: 404 });
    await deps.authStore.audit({
      workspaceId: ws, userId: auth.user.id, action: "webhook_endpoint.deleted",
      details: { endpointId: c.req.valid("param").id },
    });
    return c.json({ deleted: true });
  });

  const listWebhookDeliveriesRoute = createRoute({
    method: "get", path: "/settings/webhooks/{id}/deliveries",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Latest 50 deliveries for the endpoint" } },
  });
  app.openapi(listWebhookDeliveriesRoute, async (c) => {
    guardWebhookAdmin(c);
    const ws = workspaceId(c);
    const endpoint = await loadWebhookEndpoint(ws, c.req.valid("param").id);
    const rows = await listWebhookDeliveries(deps.getDatabase(), ws, endpoint.id, 50);
    return c.json({ deliveries: rows.map(webhookDeliveryView) });
  });

  const testWebhookRoute = createRoute({
    method: "post", path: "/settings/webhooks/{id}/test",
    request: { params: z.object({ id: z.string() }) },
    responses: { 201: { description: "Test ping enqueued through the normal delivery pipeline" } },
  });
  app.openapi(testWebhookRoute, async (c) => {
    guardWebhookAdmin(c);
    const auth = authContext(c);
    const ws = workspaceId(c);
    const db = deps.getDatabase();
    const endpoint = await loadWebhookEndpoint(ws, c.req.valid("param").id);
    // Same pipeline as real events: a delivery row + the worker queue.
    // Works on disabled endpoints too - that is exactly the state an
    // operator wants to probe before re-enabling.
    const deliveryId = crypto.randomUUID();
    const payload = webhookEnvelope({
      deliveryId,
      type: WEBHOOK_TEST_EVENT,
      workspaceId: ws,
      data: webhookTestData(endpoint.id),
      at: new Date(),
    });
    const row = await createWebhookDelivery(db, {
      id: deliveryId, endpointId: endpoint.id, workspaceId: ws, event: WEBHOOK_TEST_EVENT, payload,
    });
    try {
      await deps.webhookEnqueuer.enqueueWebhookDelivery(row.id);
    } catch (err) {
      throw new AppError(
        "CONFIGURATION",
        `Webhook test could not be queued: ${err instanceof Error ? err.message : String(err)}`,
        { status: 503 },
      );
    }
    await deps.authStore.audit({
      workspaceId: ws, userId: auth.user.id, action: "webhook_endpoint.test_sent",
      details: { endpointId: endpoint.id, deliveryId: row.id },
    });
    return c.json(webhookDeliveryView(row), 201);
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
