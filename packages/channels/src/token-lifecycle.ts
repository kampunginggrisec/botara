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
