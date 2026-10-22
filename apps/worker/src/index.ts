import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import {
  getDb, getBroadcastById, getChannelAccount, getChannelAccountById, getTemplate, listContacts,
  insertCostLedger, updateMessageStatus, incrementBroadcastCounts, updateContact,
  countServiceUnitsInRange,
  listChannelAccountsDueForRefresh, updateChannelAccountToken,
  getScheduledPostById, listDueScheduledPosts, updateScheduledPost,
  listDueEnrollments, updateEnrollment,
  getContactByExternal, createContact, listConversations,
  createConversation as createConversationRow, createMessage, touchConversationLastUserMessage,
  type Database,
} from "@botara/db";
import { getAdapter, EmailAdapter, InstagramAdapter, type ChannelKey } from "@botara/channels";
import { putObject } from "@botara/media";
import {
  processBroadcast, processFlowRun, processSendMessage,
  type BroadcastSnapshot, type FlowRunJobData, type SendMessageJobData, type WorkerPorts,
} from "./processors";
import {
  processTokenRefreshAccount, processTokenRefreshScan, tokenRefreshJobId,
  type DueTokenAccount, type TokenRefreshPorts,
} from "./token-refresh";
import {
  processPublish, processPublishScan,
  type PublishPorts, type ScheduledPostSnapshot,
} from "./publish";
import { processSequenceAdvance, type SequencePorts } from "./sequences";
import { processEmailInbound, type EmailInboundJobData, type EmailInboundPorts } from "./email-inbound";

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
  "broadcast", "sequence", "publish", "token-refresh", "email", "send-message", "flow-run",
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

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

function buildProdPorts(db: Database): WorkerPorts {
  return {
    async send(channel, input) {
      return getAdapter(channel as ChannelKey).send(input);
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
    async updateMessageStatus(messageId, status, externalId) {
      await updateMessageStatus(db, messageId, status, externalId);
    },
    async incrementBroadcastCounts(broadcastId, delta) {
      await incrementBroadcastCounts(db, broadcastId, delta);
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
      await updateChannelAccountToken(db, accountId, {
        tokenExpiresAt: patch.tokenExpiresAt ? new Date(patch.tokenExpiresAt) : undefined,
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
      const rawTargets = (row.targets as Array<{ channelAccountId: string; channel: string }>) ?? [];
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
        return adapter.createMediaContainer(input);
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

function buildEmailPorts(db: Database): EmailInboundPorts {
  return {
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
      await createMessage(db, {
        conversationId,
        direction: "in",
        type: "email",
        body: fullBody || undefined,
        externalId,
        status: "delivered",
      });
    },
    async touchLastUserMessage(conversationId, at) {
      await touchConversationLastUserMessage(db, conversationId, at);
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
      return processFlowRun(buildProdPorts(db), job.data as FlowRunJobData);
    case "token-refresh":
      return job.name === "scan"
        ? processTokenRefreshScan(buildTokenRefreshPorts(db), new Date())
        : processTokenRefreshAccount(buildTokenRefreshPorts(db), job.data as { accountId: string });
    case "publish":
      return job.name === "scan"
        ? processPublishScan(buildPublishPorts(db), new Date())
        : processPublish(buildPublishPorts(db), job.data as { postId: string });
    case "sequence":
      return processSequenceAdvance(buildSequencePorts(db), { now: new Date() });
    case "email":
      return processEmailInbound(buildEmailPorts(db), job.data as EmailInboundJobData);
    default:
      console.log(`[worker] ${queueName}: received job ${job.id} (${job.name}) - no handler`);
      return { stub: true };
  }
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
    await queueByName.get("sequence")!.upsertJobScheduler(
      "sequence-advance", { pattern: "* * * * *" }, { name: "advance", data: {} },
    );
    await queueByName.get("publish")!.upsertJobScheduler(
      "publish-scan", { pattern: "* * * * *" }, { name: "scan", data: {} },
    );
    console.log("[worker] job schedulers registered (token-refresh daily 03:00, sequence + publish scans every minute)");
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
