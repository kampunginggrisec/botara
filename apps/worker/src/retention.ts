import { disconnectRetentionCutoff, webhookReceiptRetentionCutoff } from "@botara/shared";

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

/**
 * Inbound webhook receipt retention (Admin → Webhook log): receipts are
 * a short-lived debugging aid, so the same daily sweep deletes rows
 * older than WEBHOOK_RECEIPT_RETENTION_DAYS (7) - keeping the table
 * (and its up-to-4 KB payload summaries) bounded without any insert-time
 * trim on the hot webhook path.
 */
export interface WebhookReceiptRetentionPorts {
  /** Delete receipts created before the cutoff; returns the row count. */
  deleteExpiredReceipts(cutoff: Date): Promise<number>;
}

export async function processWebhookReceiptRetention(
  ports: WebhookReceiptRetentionPorts,
  now: Date,
): Promise<{ deleted: number }> {
  const deleted = await ports.deleteExpiredReceipts(webhookReceiptRetentionCutoff(now));
  return { deleted };
}
