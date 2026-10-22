/**
 * Token-refresh processors (Fase 2).
 *
 * Two job shapes on the "token-refresh" queue:
 * - "scan"    (daily, via a BullMQ job scheduler): list accounts whose token
 *             expires within the horizon and enqueue one "refresh" job each.
 * - "refresh" (per account): call the adapter's refreshTokenIfNeeded,
 *             persist the new expiry, and on failure mark the account
 *             `refresh_failed` + emit an alert (structured log in prod).
 *
 * Idempotency: the refresh jobId is `token-refresh_{accountId}_{yyyy-mm-dd}`
 * (canonical key sanitized - BullMQ job ids cannot contain ":"), so a
 * repeated scan on the same day can never double-enqueue an account.
 */

export interface DueTokenAccount {
  id: string;
  workspaceId: string;
  channel: string;
  externalId: string;
  authMode?: string;
  tokenVaultRef?: string;
  /** ISO timestamp of the current token's expiry. */
  tokenExpiresAt?: string;
}

export interface TokenRefreshPorts {
  /** Accounts due for a refresh attempt (expiry within the wiring's horizon). */
  listDueAccounts(now: Date): Promise<DueTokenAccount[]>;
  /** Enqueue the per-account job (wiring applies tokenRefreshJobId). */
  enqueueRefresh(accountId: string): Promise<void>;
  loadAccount(accountId: string): Promise<DueTokenAccount | null>;
  /** Delegate to the channel adapter (registry) - it owns the window logic. */
  refresh(channel: string, account: DueTokenAccount): Promise<{ refreshed: boolean; expiresAt?: string }>;
  persistRefresh(accountId: string, patch: { tokenExpiresAt?: string; status?: string }): Promise<void>;
  /** Structured alert sink (prod: error log; later: paging/webhook). */
  alert(entry: { accountId: string; channel: string; error: string }): Promise<void>;
}

/** Canonical per-account-per-day job id, sanitized for BullMQ (":" -> "_"). */
export function tokenRefreshJobId(accountId: string, day: Date): string {
  return `token-refresh:${accountId}:${day.toISOString().slice(0, 10)}`.replace(/:/g, "_");
}

export async function processTokenRefreshScan(
  ports: TokenRefreshPorts,
  now: Date,
): Promise<{ enqueued: number }> {
  const due = await ports.listDueAccounts(now);
  for (const account of due) {
    await ports.enqueueRefresh(account.id);
  }
  return { enqueued: due.length };
}

export async function processTokenRefreshAccount(
  ports: TokenRefreshPorts,
  input: { accountId: string },
): Promise<{ refreshed: boolean }> {
  const account = await ports.loadAccount(input.accountId);
  if (!account) return { refreshed: false };
  try {
    const result = await ports.refresh(account.channel, account);
    if (result.refreshed) {
      await ports.persistRefresh(account.id, {
        tokenExpiresAt: result.expiresAt,
        status: "connected",
      });
    }
    return { refreshed: result.refreshed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Mark + alert, then rethrow so the failed job is visible in the queue:
    // a dead token (expired, or a Threads private profile past its 90-day
    // permission window) needs a human to re-authenticate.
    await ports.persistRefresh(account.id, { status: "refresh_failed" }).catch(() => undefined);
    await ports.alert({ accountId: account.id, channel: account.channel, error: message }).catch(() => undefined);
    throw err;
  }
}
