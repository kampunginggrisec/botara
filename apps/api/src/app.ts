import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context, Next } from "hono";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { AppError, evaluateReplyWindow, MessagingWindowClosedError } from "@botara/shared";
import {
  getDb, listContacts, createContact, updateContact, segmentCounts,
  listConversations, getConversation, listMessages, createMessage, updateMessageStatus,
  listTemplates, createTemplate, updateTemplateLatestCategory,
  createBroadcast, getBroadcast, updateBroadcastStatus, sumCostLedgerByReference,
  getChannelAccount, getTemplate, type Database,
} from "@botara/db";
import {
  getAdapter, verifyWebhookChallenge, verifyWebhookSignature,
  type ChannelKey, type InboundEvent,
} from "@botara/channels";
import { estimateBroadcastCost, type WhatsAppCategory } from "@botara/billing";

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

export interface ApiDeps {
  /** Returns the DB or throws AppError CONFIGURATION (503) when unconfigured. */
  getDatabase: () => Database;
  eventSink: WebhookEventSink;
  broadcastEnqueuer: BroadcastEnqueuer;
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

/**
 * Production broadcast enqueuer: BullMQ on Redis. Fails fast and honestly -
 * when Redis is unreachable the caller gets a 503, never a fake success.
 */
export function createBullMqBroadcastEnqueuer(redisUrl: string): BroadcastEnqueuer {
  return {
    async enqueueBroadcast(broadcastId: string): Promise<void> {
      const connection = new IORedis(redisUrl, {
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      });
      connection.on("error", () => { /* surfaced via the raced add() below */ });
      const queue = new Queue("broadcast", { connection });
      try {
        const add = queue.add("broadcast", { broadcastId }, { jobId: `broadcast:${broadcastId}` });
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("redis enqueue timed out")), 3000),
        );
        await Promise.race([add, timeout]);
      } catch (err) {
        throw new AppError(
          "CONFIGURATION",
          `Broadcast queue (Redis) is unavailable: ${err instanceof Error ? err.message : String(err)}`,
          { status: 503 },
        );
      } finally {
        await queue.close().catch(() => undefined);
        connection.disconnect();
      }
    },
  };
}

export function defaultDeps(): ApiDeps {
  return {
    getDatabase: defaultGetDatabase,
    eventSink: logEventSink,
    broadcastEnqueuer: createBullMqBroadcastEnqueuer(process.env.REDIS_URL ?? "redis://localhost:6379"),
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
  app.get("/", (c) => c.json({ name: "botara-api", phase: "Fase 1" }));

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
  for (const prefix of ["/conversations", "/contacts", "/segments", "/templates", "/broadcasts"]) {
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

    const adapter = getAdapter(conversation.channel as ChannelKey);
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

  app.doc("/doc", {
    openapi: "3.0.0",
    info: {
      title: "Botara API", version: "0.1.0",
      description: "Omnichannel chatbot platform API (Fase 1). DB routes use the X-Workspace-Id header as the Fase 1 workspace-context stand-in.",
    },
  });

  return app;
}
