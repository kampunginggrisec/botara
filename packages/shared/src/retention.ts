/**
 * Retention policy for soft-disconnected channel accounts (item G).
 *
 * Disconnecting an account that still has history keeps the data
 * (status "disconnected") so the operator can reconnect or purge
 * manually — but not forever: DISCONNECT_RETENTION_DAYS after the
 * disconnect stamp, the worker's daily retention sweeper permanently
 * purges the account (children deleted FK-safe; cost_ledger and
 * workspace_domains references are nulled, mirroring manual purge).
 * Reconnecting clears the stamp and cancels the countdown.
 */
export const DISCONNECT_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** When a disconnected account becomes purgeable (null while connected). */
export function disconnectPurgeAt(disconnectedAt: Date | null | undefined): Date | null {
  if (!disconnectedAt) return null;
  return new Date(disconnectedAt.getTime() + DISCONNECT_RETENTION_DAYS * DAY_MS);
}

/** Accounts disconnected at or before this instant are expired at `now`. */
export function disconnectRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - DISCONNECT_RETENTION_DAYS * DAY_MS);
}
