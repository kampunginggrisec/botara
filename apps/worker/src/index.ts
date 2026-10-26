import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import {
  createAIProviderFromEnv, DEFAULT_AI_MODEL, DEFAULT_EMBEDDING_MODEL, rankChunks,
} from "@botara/ai";
import {
  getDb, getBroadcastById, getChannelAccount, getChannelAccountById, getTemplate, listContacts,
  getFlowById, getContact,
  insertCostLedger, updateMessageStatus, incrementBroadcastCounts, updateContact,
  countServiceUnitsInRange,
  getKbDocument, listKbChunksByWorkspace, replaceKbChunks, updateKbDocument,
  listChannelAccountsDueForRefresh, updateChannelAccountToken, purgeExpiredDisconnectedAccounts,
  getScheduledPostById, listDueScheduledPosts, updateScheduledPost,
  listDueEnrollments, updateEnrollment,
  getContactByExternal, createContact, listConversations, findOpenConversation,
  findConversationByExternalId, getConversationById, listMessages, updateBroadcastStatus,
  isCommentProcessed, markCommentProcessed,
  createConversation as createConversationRow, createMessage, touchConversationLastUserMessage,
  findMessageByIdempotencyKey, getWebchatSessionById, createTokenVault,
  startEffectiveEnvRefresh,
  type Database,
} from "@botara/db";
import {
  getAdapter, configureTikTokTokenPersistence, EmailAdapter, InstagramAdapter, WebchatAdapter,
  type ChannelAccountRef, type ChannelKey, type WebchatStore,
} from "@botara/channels";
import { countConsecutiveOutbound } from "@botara/shared";
import { putObject } from "@botara/media";
import {
  processBroadcast, processFlowRun, processSendMessage,
  type BroadcastSnapshot, type FlowRunJobData, type FlowRunRef, type SendMessageJobData, type WorkerPorts,
} from "./processors";
import { firstSendMessageOf, storedGraphSchema, toRunnableFlow, type FlowState } from "@botara/flow-engine";
import {
  processCommentAction,
  type CommentActionJobData, type CommentActionPorts,
} from "./comment-action";
import {
  processTokenRefreshAccount, processTokenRefreshScan, tokenRefreshJobId,
  type DueTokenAccount, type TokenRefreshPorts,
} from "./token-refresh";
import {
  processPublish, processPublishScan,
  type PublishPorts, type ScheduledPostSnapshot,
} from "./publish";
import { processSequenceAdvance, type SequencePorts } from "./sequences";
import { processRetentionScan } from "./retention";
import { processEmailInbound, type EmailInboundJobData, type EmailInboundPorts } from "./email-inbound";
import { processKbIngest, type KbIngestJobData, type KbIngestPorts } from "./kb-ingest";

/**
 * Botara worker - Fase 2 entrypoint.
 * Every queue now has a REAL processor (pure orchestration over ports in
 * ./processors.ts, ./token-refresh.ts, ./publish.ts, ./sequences.ts,
 * ./email-inbound.ts); this file builds the production ports from Drizzle
 * repositories + the channel registry + the BullMQ queues, and registers
 * the recurring job schedulers (daily token-refresh scan, per-minute
 * sequence advance + publish scan).
 * When DATABASE_URL is not configured, processors log a clear configuration
 * error and skip - they never fake success. Redis failures are LOGGED;
 * SIGTERM shuts down gracefully.
 */

export const QUEUE_NAMES = [
  "broadcast", "sequence", "publish", "token-refresh", "email", "send-message", "flow-run", "kb",
  "comment-action",
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * Platform settings overlay (admin panel): DB settings win over env
 * (resolution DB -> env -> unset). The worker reads managed keys from
 * process.env at JOB time (AI provider + models, R2 media via the media
 * package defaults, channel credential fallbacks), so overlaying
 * process.env itself - refreshed every 60s - is the whole integration.
 * Fire-and-forget: a settings read failure never takes the worker down;
 * the env fallback simply keeps applying.
 */
if (process.env.DATABASE_URL) {
  try {
    const refresher = startEffectiveEnvRefresh({
      db: getDb(process.env.DATABASE_URL),
      target: process.env,
      onError: (err) => console.error(
        `[worker] platform settings refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    });
    void refresher.refreshNow();
    console.log("[worker] platform settings overlay active (DB -> env fallback, 60s refresh)");
  } catch (err) {
    console.error(`[worker] platform settings overlay failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ioredis aggregate errors can have an empty .message - fall back to the code.
const fmtErr = (err: Error): string =>
  err.message || (err as { code?: string }).code || String(err);

const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null, // required by BullMQ
  retryStrategy: (times) => Math.min(times * 500, 5000),
});
connection.on("error", (err) => {
  console.error(`[worker] redis connection error: ${fmtErr(err)}`);
});
connection.on("connect", () => console.log(`[worker] connected to redis at ${redisUrl}`));

const queueByName = new Map<string, Queue>();

/** BullMQ job ids cannot contain ":", so the canonical key is sanitized for jobId use only. */
const jobIdFor = (idempotencyKey: string) => idempotencyKey.replace(/:/g, "_");

function getDbOrNull(): Database | null {
  return process.env.DATABASE_URL ? getDb(process.env.DATABASE_URL) : null;
}

// ------------------------------------------------------------ Fase 1 ports

/**
 * DB-backed WebchatStore for the worker - the same idempotency seam as
 * apps/api's store (kept in step deliberately): a send whose idempotency
 * key already has a message row in the session's conversation reuses that
 * row instead of inserting a second one. Flow/sequence send-message jobs
 * persist ONLY through this store (no row is pre-created for them), so a
 * job retry can never double-deliver a webchat message either.
 */
function buildWorkerWebchatStore(db: Database): WebchatStore {
  return {
    async deliverOutbound(input) {
      const prefix = "webchat-session:";
      if (!input.toExternalId.startsWith(prefix)) {
        throw new Error(`webchat recipient must be a session externalId (${prefix}...).`);
      }
      const session = await getWebchatSessionById(db, input.toExternalId.slice(prefix.length));
      if (!session) throw new Error("Webchat session not found for this conversation.");
      const existing = await findMessageByIdempotencyKey(db, session.conversationId, input.idempotencyKey);
      if (existing) {
        await updateMessageStatus(db, existing.id, "sent");
        return { messageId: existing.id };
      }
      const message = await createMessage(db, {
        conversationId: session.conversationId,
        direction: "out",
        // Mirrors apps/api's store: a payload-carrying send is a rich
        // message - the widget renders its buttons/lists from the row's
        // payload, the body stays the plain-text rendering.
        type: input.payload ? "rich" : "text",
        body: input.text,
        payload: input.payload,
        status: "sent",
        idempotencyKey: input.idempotencyKey,
      });
      return { messageId: message.id };
    },
  };
}

function buildProdPorts(db: Database): WorkerPorts {
  return {
    async send(channel, input) {
      // The registry's webchat adapter intentionally has no store; the
      // worker wires the DB-backed one (flow/sequence sends to webchat
      // conversations deliver through it, exactly one persisted row).
      if (channel === "webchat") {
        return new WebchatAdapter({ store: buildWorkerWebchatStore(db) }).send(input);
      }
      return getAdapter(channel as ChannelKey).send(input);
    },
    async loadFlowRun(ref) {
      // Fase 4: resolve an id-based flow-run (webhook dispatch) into the
      // full job: flow graph -> runnable Flow, contact fields -> variables.
      const flowRow = await getFlowById(db, ref.flowId);
      if (!flowRow || flowRow.workspaceId !== ref.workspaceId) return null;
      const parsed = storedGraphSchema.safeParse(flowRow.graph);
      if (!parsed.success) return null;
      const contact = await getContact(db, ref.workspaceId, ref.contactId);
      if (!contact) return null;
      const account = await getChannelAccount(db, ref.workspaceId, ref.channelAccountId);
      if (!account) return null;
      const variables: Record<string, string> = {};
      const fields = (contact.customFields ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(fields)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          variables[key] = String(value);
        }
      }
      // Comment-to-DM runs: the first send_message was already delivered
      // as the private reply to the comment, so the run starts AFTER that
      // node (state pre-advanced) instead of sending it a second time.
      let state: FlowState | undefined;
      if (ref.skipFirstSendMessage) {
        const first = firstSendMessageOf(parsed.data);
        if (first) {
          state = {
            flowId: flowRow.id,
            currentNodeId: first.nextNodeId,
            variables,
            status: first.nextNodeId ? "running" : "completed",
          };
        }
      }
      // Conversation-addressed channels (TikTok) send to the provider
      // conversation id on the conversation row this run belongs to:
      // the ref's own conversation first, the open one as fallback.
      const runConversation = (ref.conversationId ? await getConversationById(db, ref.conversationId) : null)
        ?? await findOpenConversation(db, {
          workspaceId: ref.workspaceId, channelAccountId: account.id, contactId: contact.id,
        });
      return {
        flow: toRunnableFlow(flowRow.id, parsed.data),
        ...(state ? { state } : {}),
        event: {
          type: ref.commentId ? "comment.received" : "message.received",
          text: ref.triggerText, variables,
        },
        context: {
          workspaceId: ref.workspaceId,
          channelAccountId: account.id,
          channel: account.channel,
          accountExternalId: account.externalId,
          tokenVaultRef: account.tokenVaultRef ?? undefined,
          contactId: contact.id,
          contactExternalId: contact.externalId,
          conversationExternalId: runConversation?.externalId ?? undefined,
        },
      };
    },
    async writeCost(entry) {
      await insertCostLedger(db, entry);
    },
    async countServiceMessagesThisMonth(channelAccountId, now) {
      // WhatsApp free-service allowance: month-to-date delivered service
      // units for this phone number, from the cost ledger (calendar month).
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      return countServiceUnitsInRange(db, channelAccountId, start, end);
    },
    async aiReply({ workspaceId, prompt, query }) {
      // Fase 3: KB-grounded AI reply for flow ai_reply nodes. Retrieval =
      // embed the query, cosine-rank the workspace's stored chunk
      // embeddings in code (no pgvector dependency), top-3 into the chat
      // context. Any gap (no provider, empty KB, no relevant chunk) -> null
      // and the flow sends its configured fallback text.
      const provider = createAIProviderFromEnv(process.env);
      if (!provider) return null;
      const stored = await listKbChunksByWorkspace(db, workspaceId);
      if (stored.length === 0) return null;
      const queryEmbedding = await provider.embedding({
        model: process.env.AI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
        text: query,
      });
      const top = rankChunks(
        stored.map((c) => ({ text: c.text, embedding: c.embedding as number[] | null })),
        queryEmbedding,
        3,
      );
      if (top.length === 0) return null;
      const context = top.map((r) => r.item.text).join("\n---\n");
      const result = await provider.chatCompletion({
        model: process.env.AI_MODEL ?? DEFAULT_AI_MODEL,
        messages: [
          {
            role: "system",
            content: `${prompt}\n\nBasis pengetahuan (gunakan bila relevan, jangan mengarang di luar ini):\n${context}`,
          },
          { role: "user", content: query },
        ],
      });
      return result.text;
    },
    async updateMessageStatus(messageId, status, externalId) {
      await updateMessageStatus(db, messageId, status, externalId);
    },
    async incrementBroadcastCounts(broadcastId, delta) {
      await incrementBroadcastCounts(db, broadcastId, delta);
    },
    async updateBroadcastStatus(broadcastId, status) {
      await updateBroadcastStatus(db, broadcastId, status);
    },
    async countConsecutiveOutbound({ workspaceId, channel, channelAccountId, contactExternalId, conversationExternalId }) {
      // Resolve the conversation the send belongs to: by provider id
      // when the job carries one (TikTok), else the open conversation
      // for (account, contact) - then count from the persisted rows.
      let conversation = conversationExternalId
        ? await findConversationByExternalId(db, channelAccountId, conversationExternalId)
        : null;
      if (!conversation) {
        const contact = await getContactByExternal(db, workspaceId, channel, contactExternalId);
        if (!contact) return 0;
        conversation = await findOpenConversation(db, { workspaceId, channelAccountId, contactId: contact.id });
      }
      if (!conversation) return 0;
      const rows = await listMessages(db, conversation.id);
      return countConsecutiveOutbound(rows);
    },
    async resolveAccountStatus(channelAccountId) {
      const row = await getChannelAccountById(db, channelAccountId);
      return row?.status ?? null;
    },
    async loadBroadcast(broadcastId): Promise<BroadcastSnapshot | null> {
      const row = await getBroadcastById(db, broadcastId);
      if (!row) return null;
      const account = await getChannelAccount(db, row.workspaceId, row.channelAccountId);
      if (!account) return null;
      const template = row.templateId ? await getTemplate(db, row.workspaceId, row.templateId) : null;
      return {
        id: row.id,
        workspaceId: row.workspaceId,
        channelAccountId: row.channelAccountId,
        channel: account.channel,
        accountExternalId: account.externalId,
        accountStatus: account.status,
        tokenVaultRef: account.tokenVaultRef ?? undefined,
        template: template
          ? { name: template.name, language: template.language, latestCategory: template.latestCategory ?? template.category ?? "utility" }
          : undefined,
        tag: row.tag ?? undefined,
        country: row.country ?? undefined,
      };
    },
    async listBroadcastTargets(broadcast) {
      if (!broadcast.tag) return [];
      const rows = await listContacts(db, broadcast.workspaceId, { tag: broadcast.tag });
      return rows.map((r) => ({ contactId: r.id, externalId: r.externalId }));
    },
    async enqueueSendMessage(data: SendMessageJobData) {
      const queue = queueByName.get("send-message");
      if (!queue) throw new Error("send-message queue is not registered");
      await queue.add("send-message", data, { jobId: jobIdFor(data.idempotencyKey) });
    },
    async setContactField(workspaceId, contactId, field, value) {
      await updateContact(db, workspaceId, contactId, { customFields: { [field]: value } });
    },
    async httpFetch(url, method) {
      const res = await fetch(url, { method });
      if (!res.ok) throw new Error(`flow webhook ${method} ${url} -> HTTP ${res.status}`);
    },
    async scheduleFlowResume(job: FlowRunJobData, delaySeconds) {
      const queue = queueByName.get("flow-run");
      if (!queue) throw new Error("flow-run queue is not registered");
      await queue.add("flow-run", job, { delay: delaySeconds * 1000 });
    },
  };
}

// -------------------------------------------------------- token-refresh ports

const TOKEN_REFRESH_HORIZON_DAYS = 30;

function buildTokenRefreshPorts(db: Database): TokenRefreshPorts {
  const toDue = (row: Awaited<ReturnType<typeof getChannelAccountById>>): DueTokenAccount => ({
    id: row!.id,
    workspaceId: row!.workspaceId,
    channel: row!.channel,
    externalId: row!.externalId,
    authMode: row!.authMode ?? undefined,
    tokenVaultRef: row!.tokenVaultRef ?? undefined,
    tokenExpiresAt: row!.tokenExpiresAt?.toISOString(),
  });
  return {
    async listDueAccounts(now) {
      const horizon = new Date(now.getTime() + TOKEN_REFRESH_HORIZON_DAYS * 24 * 3600 * 1000);
      const rows = await listChannelAccountsDueForRefresh(db, horizon);
      return rows.map((r) => toDue(r));
    },
    async enqueueRefresh(accountId) {
      const queue = queueByName.get("token-refresh");
      if (!queue) throw new Error("token-refresh queue is not registered");
      await queue.add("refresh", { accountId }, { jobId: tokenRefreshJobId(accountId, new Date()) });
    },
    async loadAccount(accountId) {
      const row = await getChannelAccountById(db, accountId);
      return row ? toDue(row) : null;
    },
    async refresh(channel, account) {
      return getAdapter(channel as ChannelKey).refreshTokenIfNeeded({
        id: account.id,
        externalId: account.externalId,
        authMode: account.authMode,
        tokenVaultRef: account.tokenVaultRef,
        tokenExpiresAt: account.tokenExpiresAt,
      });
    },
    async persistRefresh(accountId, patch) {
      // A rotated credential (TikTok pair) must replace the vault entry:
      // the old refresh token is dead the moment the new pair is issued.
      let tokenVaultRef: string | undefined;
      if (patch.secret && process.env.TOKEN_VAULT_KEY) {
        const row = await getChannelAccountById(db, accountId);
        if (row) {
          const vault = createTokenVault(db, process.env);
          tokenVaultRef = await vault.put({
            workspaceId: row.workspaceId, kind: row.channel,
            label: row.displayName ?? row.channel, secret: patch.secret,
          });
        }
      }
      await updateChannelAccountToken(db, accountId, {
        tokenExpiresAt: patch.tokenExpiresAt ? new Date(patch.tokenExpiresAt) : undefined,
        tokenVaultRef,
        status: patch.status,
      });
    },
    async alert(entry) {
      console.error(JSON.stringify({ alert: "token-refresh-failed", ...entry }));
    },
  };
}

// -------------------------------------------------------------- publish ports

function buildPublishPorts(db: Database): PublishPorts {
  return {
    async loadPost(postId): Promise<ScheduledPostSnapshot | null> {
      const row = await getScheduledPostById(db, postId);
      if (!row) return null;
      const rawTargets = (row.targets as Array<{ channelAccountId: string; channel: string; targetExternalId?: string }>) ?? [];
      const targets: ScheduledPostSnapshot["targets"] = [];
      for (const t of rawTargets) {
        const account = await getChannelAccount(db, row.workspaceId, t.channelAccountId);
        if (!account) {
          console.error(`[worker] publish: post ${postId} target account ${t.channelAccountId} no longer exists - skipped`);
          continue;
        }
        targets.push({
          channelAccountId: account.id,
          channel: account.channel,
          accountExternalId: account.externalId,
          targetExternalId: t.targetExternalId,
          authMode: account.authMode ?? undefined,
          tokenVaultRef: account.tokenVaultRef ?? undefined,
        });
      }
      return {
        id: row.id,
        workspaceId: row.workspaceId,
        text: row.text ?? undefined,
        mediaUrls: (row.mediaUrls as string[]) ?? [],
        targets,
        status: row.status,
        results: (row.results as ScheduledPostSnapshot["results"]) ?? {},
      };
    },
    async publish(channel, input) {
      const adapter = getAdapter(channel as ChannelKey);
      if (!adapter.publish) throw new Error(`${channel} adapter has no publish surface`);
      return adapter.publish(input);
    },
    // Fase 3: granular Instagram container steps so VIDEO publishes poll
    // container status here (bounded) before media_publish.
    instagramContainers: {
      async createContainer(channel, input) {
        const adapter = getAdapter(channel as ChannelKey);
        if (!(adapter instanceof InstagramAdapter)) {
          throw new Error(`${channel} adapter has no media-container surface`);
        }
        const created = await adapter.createMediaContainer(input.account, input);
        return { containerId: created.creationId };
      },
      async containerStatus(channel, account, containerId) {
        const adapter = getAdapter(channel as ChannelKey);
        if (!(adapter instanceof InstagramAdapter)) {
          throw new Error(`${channel} adapter has no media-container surface`);
        }
        return adapter.getMediaContainerStatus(account, containerId);
      },
      async publishContainer(channel, account, containerId) {
        const adapter = getAdapter(channel as ChannelKey);
        if (!(adapter instanceof InstagramAdapter)) {
          throw new Error(`${channel} adapter has no media-container surface`);
        }
        return adapter.publishMediaContainer(account, containerId);
      },
      async delay(ms) {
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
      poll: { attempts: 10, delayMs: 3000 },
    },
    async recordResults(postId, results) {
      await updateScheduledPost(db, postId, { results });
    },
    async updatePostStatus(postId, status) {
      await updateScheduledPost(db, postId, { status });
    },
    async listDuePosts(now) {
      const rows = await listDueScheduledPosts(db, now);
      return rows.map((r) => ({ id: r.id }));
    },
    async enqueuePublish(postId) {
      const queue = queueByName.get("publish");
      if (!queue) throw new Error("publish queue is not registered");
      await queue.add("publish", { postId }, { jobId: jobIdFor(`publish:${postId}`) });
    },
  };
}

// ------------------------------------------------------------- sequence ports

function buildSequencePorts(db: Database): SequencePorts {
  return {
    async listDueEnrollments(now) {
      const rows = await listDueEnrollments(db, now);
      return rows.map((r) => ({ ...r }));
    },
    async enqueueSendMessage(data: SendMessageJobData) {
      const queue = queueByName.get("send-message");
      if (!queue) throw new Error("send-message queue is not registered");
      await queue.add("send-message", data, { jobId: jobIdFor(data.idempotencyKey) });
    },
    async updateEnrollment(enrollmentId, patch) {
      await updateEnrollment(db, enrollmentId, patch);
    },
  };
}

// ---------------------------------------------------------- email-inbound ports

/**
 * Realtime publisher for the worker (live inbox events).
 *
 * Mirrors apps/api/src/realtime-publish.ts's contract - the worker cannot
 * import from apps/api, so this duplicates the fire-and-forget shape here:
 * publishes `inbox.message` events on the `botara:realtime` channel and
 * swallows all errors so a realtime outage never fails a job.
 */
function createWorkerRealtimePublisher(redisUrl: string) {
  let connection: IORedis | null = null;
  const getConnection = (): IORedis => {
    if (!connection) {
      connection = new IORedis(redisUrl, {
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      });
      connection.on("error", () => { /* surfaced nowhere - fire-and-forget */ });
    }
    return connection;
  };
  return async (event: { workspaceId: string; conversationId: string; direction: "in" | "out"; messageId?: string }) => {
    try {
      await getConnection().publish("botara:realtime", JSON.stringify({ type: "inbox.message", ...event }));
    } catch {
      // Fire-and-forget: realtime is a hint channel, never a dependency.
    }
  };
}

function buildEmailPorts(db: Database, redisUrl: string): EmailInboundPorts {
  const publishRealtime = createWorkerRealtimePublisher(redisUrl);
  return {
    publishInboxMessage: publishRealtime,
    async fetchInbound(job) {
      const account = await getChannelAccountById(db, job.channelAccountId);
      if (!account) throw new Error(`email account ${job.channelAccountId} not found`);
      const adapter = getAdapter("email");
      if (!(adapter instanceof EmailAdapter)) throw new Error("email adapter is not the Resend adapter");
      const content = await adapter.fetchInboundEmail(
        { id: account.id, externalId: account.externalId, tokenVaultRef: account.tokenVaultRef ?? undefined },
        job.emailId,
      );
      return {
        from: content.from,
        subject: content.subject,
        text: content.text,
        html: content.html,
        attachments: content.attachments,
      };
    },
    async storeAttachment({ workspaceId, emailId, attachment }) {
      // Resend download URLs are TEMPORARY: fetch the bytes now and persist
      // them into R2 under a permanent key.
      const res = await fetch(attachment.downloadUrl);
      if (!res.ok) throw new Error(`attachment download failed (HTTP ${res.status}) for email ${emailId}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const filename = attachment.filename ?? attachment.id;
      return putObject(
        `email/${workspaceId}/${emailId}/${filename}`,
        bytes,
        attachment.contentType ?? "application/octet-stream",
      );
    },
    async findOrCreateConversation({ workspaceId, channelAccountId, from }) {
      let contact = await getContactByExternal(db, workspaceId, "email", from);
      if (!contact) {
        contact = await createContact(db, { workspaceId, channel: "email", externalId: from });
      }
      const conversations = await listConversations(db, workspaceId);
      const existing = conversations.find(
        (row) => row.contactId === contact!.id && row.channelAccountId === channelAccountId && row.status !== "resolved",
      );
      if (existing) return { conversationId: existing.id, contactId: contact.id };
      const created = await createConversationRow(db, { workspaceId, channelAccountId, contactId: contact.id });
      return { conversationId: created.id, contactId: contact.id };
    },
    async persistMessage({ conversationId, externalId, subject, body, attachments }) {
      // The messages table has no subject/attachment columns in Fase 2: the
      // subject leads the body and stored attachment keys trail it, so the
      // inbox shows the full content (a typed media model is a later phase).
      const attachmentLines = attachments.map((a) => `[attachment: ${a.key}]`);
      const fullBody = [subject ? `Subject: ${subject}` : null, body ?? null, ...attachmentLines]
        .filter((part): part is string => Boolean(part))
        .join("\n\n");
      const message = await createMessage(db, {
        conversationId,
        direction: "in",
        type: "email",
        body: fullBody || undefined,
        externalId,
        status: "delivered",
      });
      return { id: message.id };
    },
    async touchLastUserMessage(conversationId, at) {
      await touchConversationLastUserMessage(db, conversationId, at);
    },
  };
}

// --------------------------------------------------------------- kb ports

function buildKbPorts(db: Database): KbIngestPorts {
  return {
    async loadDocument(workspaceId, documentId) {
      const row = await getKbDocument(db, workspaceId, documentId);
      return row
        ? { id: row.id, workspaceId: row.workspaceId, title: row.title, content: row.sourceText }
        : null;
    },
    async embed(texts) {
      const provider = createAIProviderFromEnv(process.env);
      if (!provider) {
        throw new Error("AI provider is not configured (set AI_PROVIDER + provider API key) - cannot embed KB chunks");
      }
      const model = process.env.AI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
      const vectors: number[][] = [];
      for (const text of texts) {
        vectors.push(await provider.embedding({ model, text }));
      }
      return vectors;
    },
    async replaceChunks(workspaceId, documentId, chunks) {
      await replaceKbChunks(db, { id: documentId, workspaceId }, chunks);
    },
    async markReady(documentId, chunkCount) {
      await updateKbDocument(db, documentId, { status: "ready", chunkCount });
    },
    async markFailed(documentId, error) {
      await updateKbDocument(db, documentId, { status: "failed", error });
    },
  };
}

// -------------------------------------------------------- comment-action ports

function buildCommentActionPorts(db: Database): CommentActionPorts {
  return {
    async isProcessed(input) {
      return isCommentProcessed(db, input);
    },
    async markProcessed(input) {
      await markCommentProcessed(db, input);
    },
    async loadFlowFirstMessageText(flowId) {
      const flowRow = await getFlowById(db, flowId);
      if (!flowRow) return null;
      const parsed = storedGraphSchema.safeParse(flowRow.graph);
      if (!parsed.success) return null;
      return firstSendMessageOf(parsed.data)?.text ?? null;
    },
    async moderate({ channel, account, commentExternalId, action, text }) {
      const adapter = getAdapter(channel as ChannelKey);
      if (!adapter.moderate) throw new Error(`${channel} adapter has no comment moderation surface`);
      await adapter.moderate({ account, targetExternalId: commentExternalId, action, text });
    },
    async privateReply({ channel, account, commentExternalId, text }) {
      const adapter = getAdapter(channel as ChannelKey) as {
        privateReplyToComment?: (
          account: ChannelAccountRef, commentExternalId: string, text: string,
        ) => Promise<{ externalMessageId: string }>;
      };
      if (!adapter.privateReplyToComment) {
        throw new Error(`${channel} adapter has no private-reply-to-comment surface`);
      }
      return adapter.privateReplyToComment(account, commentExternalId, text);
    },
    async findOrCreateConversation({ workspaceId, channelAccountId, channel, authorExternalId }) {
      let contact = await getContactByExternal(db, workspaceId, channel, authorExternalId);
      if (!contact) {
        contact = await createContact(db, { workspaceId, channel, externalId: authorExternalId });
      }
      const existing = await findOpenConversation(db, { workspaceId, channelAccountId, contactId: contact.id });
      if (existing) return { conversationId: existing.id, contactId: contact.id };
      const created = await createConversationRow(db, { workspaceId, channelAccountId, contactId: contact.id });
      return { conversationId: created.id, contactId: contact.id };
    },
    async persistMessage({ conversationId, body, externalId, idempotencyKey }) {
      await createMessage(db, {
        conversationId,
        direction: "out",
        type: "text",
        body,
        externalId,
        status: "sent",
        idempotencyKey,
      });
    },
    async enqueueFlowRun(ref) {
      const queue = queueByName.get("flow-run");
      if (!queue) throw new Error("flow-run queue is not registered");
      const jobId = ref.commentId
        ? jobIdFor(`commentflow:${ref.commentId}:${ref.flowId}`)
        : jobIdFor(`flowrun:${crypto.randomUUID()}`);
      await queue.add("flow-run", ref, { jobId });
    },
  };
}

// ------------------------------------------------------------------ dispatch

async function dispatch(queueName: string, job: Job): Promise<unknown> {
  const db = getDbOrNull();
  if (!db) {
    console.error(
      `[worker] ${queueName}: DATABASE_URL is not configured - cannot run real processors (job ${job.id} skipped, not faked)`,
    );
    return { configured: false };
  }
  switch (queueName) {
    case "send-message":
      return processSendMessage(buildProdPorts(db), job.data as SendMessageJobData);
    case "broadcast":
      return processBroadcast(buildProdPorts(db), job.data as { broadcastId: string });
    case "flow-run":
      return processFlowRun(buildProdPorts(db), job.data as FlowRunJobData | FlowRunRef);
    case "token-refresh":
      if (job.name === "scan") {
        return processTokenRefreshScan(buildTokenRefreshPorts(db), new Date());
      }
      if (job.name === "retention") {
        // Item G: daily retention sweep for soft-disconnected accounts.
        return processRetentionScan(
          { purgeExpired: (cutoff) => purgeExpiredDisconnectedAccounts(db, cutoff) },
          new Date(),
        );
      }
      return processTokenRefreshAccount(buildTokenRefreshPorts(db), job.data as { accountId: string });
    case "publish":
      return job.name === "scan"
        ? processPublishScan(buildPublishPorts(db), new Date())
        : processPublish(buildPublishPorts(db), job.data as { postId: string });
    case "sequence":
      return processSequenceAdvance(buildSequencePorts(db), { now: new Date() });
    case "email":
      return processEmailInbound(buildEmailPorts(db, redisUrl), job.data as EmailInboundJobData);
    case "kb":
      return processKbIngest(buildKbPorts(db), job.data as KbIngestJobData);
    case "comment-action":
      return processCommentAction(buildCommentActionPorts(db), job.data as CommentActionJobData);
    default:
      console.log(`[worker] ${queueName}: received job ${job.id} (${job.name}) - no handler`);
      return { stub: true };
  }
}

// TikTok token pairs rotate on refresh (including refresh-on-401 inside
// a send): persist every rotation into the vault + account row. Wired
// only when the vault is configured; without it the adapter's in-process
// cache still keeps this process correct until restart.
if (process.env.DATABASE_URL && process.env.TOKEN_VAULT_KEY) {
  configureTikTokTokenPersistence(async ({ account, pair, serialized }) => {
    const db = getDbOrNull();
    if (!db) return;
    const row = await getChannelAccountById(db, account.id);
    if (!row) return;
    const vault = createTokenVault(db, process.env);
    const ref = await vault.put({
      workspaceId: row.workspaceId, kind: "tiktok",
      label: row.displayName ?? "TikTok", secret: serialized,
    });
    await updateChannelAccountToken(db, row.id, {
      tokenVaultRef: ref,
      tokenExpiresAt: pair.expiresAt ? new Date(pair.expiresAt) : undefined,
      status: "connected",
    });
  });
}

const queues: Queue[] = [];
const workers: Worker[] = [];

for (const name of QUEUE_NAMES) {
  const queue = new Queue(name, { connection });
  queueByName.set(name, queue);
  queues.push(queue);
  const worker = new Worker(name, (job: Job) => dispatch(name, job), { connection });
  // Structured JSON lifecycle logs with job context fields (Fase 3
  // observability): queue + job name + job id + attempt. Job DATA is never
  // logged - it can contain message bodies and tokens.
  worker.on("completed", (job) => {
    console.log(JSON.stringify({
      ts: new Date().toISOString(), level: "info", service: "worker",
      queue: name, job: job.name, jobId: job.id, event: "completed",
      attemptsMade: job.attemptsMade,
    }));
  });
  worker.on("failed", (job, err) => {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), level: "error", service: "worker",
      queue: name, job: job?.name, jobId: job?.id, event: "failed",
      attemptsMade: job?.attemptsMade, error: err.message,
    }));
  });
  worker.on("error", (err) => {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), level: "error", service: "worker",
      queue: name, event: "worker-error", error: fmtErr(err),
    }));
  });
  workers.push(worker);
}

console.log(`[worker] registered queues: ${QUEUE_NAMES.join(", ")}`);

/** Recurring scans: daily token refresh; per-minute sequence + publish scans. */
async function registerSchedulers(): Promise<void> {
  try {
    await queueByName.get("token-refresh")!.upsertJobScheduler(
      "token-refresh-daily", { pattern: "0 3 * * *" }, { name: "scan", data: {} },
    );
    await queueByName.get("token-refresh")!.upsertJobScheduler(
      "retention-daily", { pattern: "30 3 * * *" }, { name: "retention", data: {} },
    );
    await queueByName.get("sequence")!.upsertJobScheduler(
      "sequence-advance", { pattern: "* * * * *" }, { name: "advance", data: {} },
    );
    await queueByName.get("publish")!.upsertJobScheduler(
      "publish-scan", { pattern: "* * * * *" }, { name: "scan", data: {} },
    );
    console.log("[worker] job schedulers registered (token-refresh daily 03:00, retention daily 03:30, sequence + publish scans every minute)");
  } catch (err) {
    console.error(`[worker] scheduler registration failed: ${fmtErr(err as Error)}`);
  }
}
void registerSchedulers();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal} received, shutting down gracefully...`);
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled(queues.map((q) => q.close()));
  connection.disconnect();
  console.log("[worker] shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
