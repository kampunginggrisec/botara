import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";

/**
 * Botara worker - Fase 0 entrypoint.
 * Registers the platform queues and starts placeholder processors.
 * Redis connection failures are LOGGED (never silently swallowed); BullMQ /
 * ioredis keep retrying in the background, and SIGTERM shuts down gracefully.
 */

export const QUEUE_NAMES = ["broadcast", "sequence", "publish", "token-refresh", "email"] as const;
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

const queues: Queue[] = [];
const workers: Worker[] = [];

for (const name of QUEUE_NAMES) {
  queues.push(new Queue(name, { connection }));
  const worker = new Worker(
    name,
    async (job: Job) => {
      // Fase 0 placeholder processor: real handlers land per-queue in Fase 1+.
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
