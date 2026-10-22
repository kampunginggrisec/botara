import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import {
  getDb, getBroadcastById, getChannelAccount, getTemplate, listContacts,
  insertCostLedger, updateMessageStatus, incrementBroadcastCounts, updateContact,
} from "@botara/db";
import { getAdapter, type ChannelKey } from "@botara/channels";
import {
  processBroadcast, processFlowRun, processSendMessage,
  type BroadcastSnapshot, type FlowRunJobData, type SendMessageJobData, type WorkerPorts,
} from "./processors";

/**
 * Botara worker - Fase 1 entrypoint.
 * Queues: the Fase 0 set plus "send-message" and "flow-run", which (like
 * "broadcast") have REAL processors in ./processors.ts. Processors are pure
 * orchestration over ports; this file builds the production ports from
 * Drizzle repositories + the channel registry + the BullMQ queues.
 * When DATABASE_URL is not configured, the real processors log a clear
 * configuration error and skip - they never fake success.
 * Redis connection failures are LOGGED; SIGTERM shuts down gracefully.
 */

export const QUEUE_NAMES = [
  "broadcast", "sequence", "publish", "token-refresh", "email", "send-message", "flow-run",
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

const REAL_QUEUES = new Set<string>(["broadcast", "send-message", "flow-run"]);

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

function buildProdPorts(): WorkerPorts | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  const db = getDb(databaseUrl);
  return {
    async send(channel, input) {
      return getAdapter(channel as ChannelKey).send(input);
    },
    async writeCost(entry) {
      await insertCostLedger(db, entry);
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
      // Tag-targeted broadcasts fan out to the segment's contacts. A
      // recipientCount-only broadcast has no contact list to fan out to.
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

const queues: Queue[] = [];
const workers: Worker[] = [];

for (const name of QUEUE_NAMES) {
  const queue = new Queue(name, { connection });
  queueByName.set(name, queue);
  queues.push(queue);
  const worker = new Worker(
    name,
    async (job: Job) => {
      if (REAL_QUEUES.has(name)) {
        const ports = buildProdPorts();
        if (!ports) {
          console.error(
            `[worker] ${name}: DATABASE_URL is not configured - cannot run real processors (job ${job.id} skipped, not faked)`,
          );
          return { configured: false };
        }
        if (name === "send-message") return processSendMessage(ports, job.data as SendMessageJobData);
        if (name === "broadcast") return processBroadcast(ports, job.data as { broadcastId: string });
        return processFlowRun(ports, job.data as FlowRunJobData);
      }
      // Remaining queues keep the Fase 0 placeholder behaviour until their phase.
      console.log(`[worker] ${name}: received job ${job.id} (${job.name}) - no handler yet (Fase 0)`);
      return { stub: true };
    },
    { connection },
  );
  worker.on("error", (err) => console.error(`[worker] ${name} worker error: ${fmtErr(err)}`));
  worker.on("failed", (job, err) =>
    console.error(`[worker] ${name}: job ${job?.id} failed: ${err.message}`),
  );
  workers.push(worker);
}

console.log(`[worker] registered queues: ${QUEUE_NAMES.join(", ")}`);

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
