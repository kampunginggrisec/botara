import { disconnectRetentionCutoff } from "@botara/shared";

/**
 * Retention sweeper (item G).
 *
 * One job shape: "retention" on the token-refresh queue (the worker's
 * daily-maintenance queue), scheduled daily at 03:30 — half an hour
 * after the token-refresh scan so the two never contend. The processor
 * computes the cutoff from the shared retention policy
 * (DISCONNECT_RETENTION_DAYS) and delegates to the repository helper,
 * which purges each expired account with the same FK-safe semantics as
 * a manual purge and writes a `channel.purged` audit entry with
 * reason "retention_expired" per account.
 */
export interface RetentionPorts {
  /** Purge every disconnected account whose stamp is at/before the cutoff. */
  purgeExpired(cutoff: Date): Promise<Array<{ id: string }>>;
}

export async function processRetentionScan(
  ports: RetentionPorts,
  now: Date,
): Promise<{ purged: number }> {
  const purged = await ports.purgeExpired(disconnectRetentionCutoff(now));
  return { purged: purged.length };
}
