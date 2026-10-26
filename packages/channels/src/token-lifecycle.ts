/**
 * Long-lived Meta token refresh decisions (Instagram Login + Threads).
 *
 * Both surfaces issue ~60-day long-lived tokens with the same rule:
 * a token can only be refreshed once it is at least 24 hours old, and only
 * while it is still valid - an expired token can NOT be refreshed, the user
 * must re-authenticate. Because expiry is the only timestamp persisted on
 * channel_accounts, the token's age is derived: age = lifetime - remaining.
 *
 * This function is pure so the worker's token-refresh processor and the
 * adapters share one decision, unit-tested without clocks or HTTP.
 */

export type RefreshDecision =
  | { action: "refresh" }
  | { action: "skip"; reason: "unknown-expiry" | "too-early" | "expired" };

export interface LongLivedRefreshInput {
  /** ISO timestamp when the current token expires (channel_accounts.token_expires_at). */
  expiresAt?: string | null;
  now: Date;
  /** Total token lifetime in days (60 for Instagram Login and Threads). */
  lifetimeDays?: number;
  /** Minimum age before the provider accepts a refresh (24h for Meta). */
  minAgeHours?: number;
}

export function evaluateLongLivedRefresh(input: LongLivedRefreshInput): RefreshDecision {
  const lifetimeDays = input.lifetimeDays ?? 60;
  const minAgeHours = input.minAgeHours ?? 24;
  if (!input.expiresAt) return { action: "skip", reason: "unknown-expiry" };
  const expiresMs = Date.parse(input.expiresAt);
  if (Number.isNaN(expiresMs)) return { action: "skip", reason: "unknown-expiry" };
  const nowMs = input.now.getTime();
  const remainingMs = expiresMs - nowMs;
  if (remainingMs <= 0) return { action: "skip", reason: "expired" };
  const ageMs = lifetimeDays * 24 * 3600 * 1000 - remainingMs;
  if (ageMs < minAgeHours * 3600 * 1000) return { action: "skip", reason: "too-early" };
  return { action: "refresh" };
}

/**
 * Short-lived OAuth pair decisions (TikTok tt_user tokens).
 *
 * The semantics differ from Meta's long-lived rule in the one way that
 * matters: the ACCESS token lives ~24h, but the REFRESH token is the
 * long-lived credential, so an already-expired access token CAN still be
 * refreshed - "expired" is a refresh trigger here, never a dead end. The
 * refresh token's own lifetime is the platform's reauthorization deadline
 * (public sources conflict - ~30 days vs ~365 days - so nothing in this
 * decision depends on it: refresh early and often, and a failed refresh
 * surfaces as needs-reauthorization at the call site either way).
 */

export type ShortLivedRefreshDecision =
  | { action: "refresh"; reason: "expired" | "expiring" }
  | { action: "skip"; reason: "unknown-expiry" | "fresh" };

export interface ShortLivedRefreshInput {
  /** ISO timestamp when the current ACCESS token expires. */
  expiresAt?: string | null;
  now: Date;
  /** Refresh once the remaining lifetime drops to this many minutes (default 30). */
  refreshBeforeMinutes?: number;
}

export function evaluateShortLivedRefresh(input: ShortLivedRefreshInput): ShortLivedRefreshDecision {
  if (!input.expiresAt) return { action: "skip", reason: "unknown-expiry" };
  const expiresMs = Date.parse(input.expiresAt);
  if (Number.isNaN(expiresMs)) return { action: "skip", reason: "unknown-expiry" };
  const remainingMs = expiresMs - input.now.getTime();
  if (remainingMs <= 0) return { action: "refresh", reason: "expired" };
  const thresholdMs = (input.refreshBeforeMinutes ?? 30) * 60 * 1000;
  if (remainingMs <= thresholdMs) return { action: "refresh", reason: "expiring" };
  return { action: "skip", reason: "fresh" };
}
