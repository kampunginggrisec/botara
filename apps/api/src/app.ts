import { randomBytes } from "node:crypto";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context, Next } from "hono";
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
  type Database, type ScheduledPostTarget, type SequenceStep,
} from "@botara/db";
import {
  getAdapter, verifyWebhookChallenge, verifyWebhookSignature, verifyResendWebhookSignature,
  WebchatAdapter, CHANNEL_CAPABILITIES,
  type ChannelKey, type InboundEvent,
} from "@botara/channels";
import { estimateBroadcastCost, type WhatsAppCategory } from "@botara/billing";
import {
  createAIProviderFromEnv, moderateText, DEFAULT_AI_MODEL, type AIProvider,
} from "@botara/ai";
import {
  InMemoryVault, exchangeEmbeddedSignup,
  type EmbeddedSignupInput, type EmbeddedSignupResult,
} from "./whatsapp-onboarding";
import { createDbWebchatStore } from "./webchat-store";

/**
 * Botara API - Fase 1.
 *
 * WORKSPACE CONTEXT (Fase 1 stand-in): until full auth lands in a later
 * phase, DB-backed routes read the workspace from the `X-Workspace-Id`
 * header (see workspaceMiddleware below). This is a deliberate, documented
 * placeholder - NOT an authentication mechanism. Web clients send the
 * header from a locally stored workspace id (apps/web/src/api.ts).
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
  const vault = new InMemoryVault();
  return {
    getDatabase: defaultGetDatabase,
    eventSink: logEventSink,
    broadcastEnqueuer: createBullMqBroadcastEnqueuer(redisUrl),
    publishEnqueuer: createBullMqPublishEnqueuer(redisUrl),
    templateCategoryUpdater: createDbTemplateCategoryUpdater(defaultGetDatabase),
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

// ------------------------------------------------------------------- types

type AppEnv = { Variables: { workspaceId?: string } };
type Ctx = Context<AppEnv>;


function errorBody(err: AppError) {
  return { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } };
}

/** Workspace id from the middleware; DB handlers must have one. */
function workspaceId(c: Ctx): string {
  const id = c.get("workspaceId");
  if (!id) {
    throw new AppError("VALIDATION", "Missing X-Workspace-Id header (Fase 1 workspace context).", { status: 400 });
  }
  return id;
}

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

  // ------------------------------------------------------------- health
  const healthRoute = createRoute({
    method: "get", path: "/health",
    responses: { 200: { description: "Service health", content: { "application/json": { schema: z.object({ status: z.literal("ok"), service: z.literal("api") }) } } } },
  });
  app.openapi(healthRoute, (c) => c.json({ status: "ok" as const, service: "api" as const }));
  app.get("/", (c) => c.json({ name: "botara-api", phase: "Fase 2" }));

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
    return c.json({ received: true, events: events.length });
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

  // ------------------------------------------- workspace context middleware
  // Fase 1 stand-in for auth: X-Workspace-Id header -> request context.
  const workspaceMiddleware = async (c: Ctx, next: Next) => {
    const id = c.req.header("x-workspace-id");
    if (id) c.set("workspaceId", id);
    await next();
  };
  for (const prefix of ["/conversations", "/contacts", "/segments", "/templates", "/broadcasts", "/channels", "/posts", "/sequences"]) {
    app.use(prefix, workspaceMiddleware);
    app.use(`${prefix}/*`, workspaceMiddleware);
  }

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
