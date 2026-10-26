import type { StatsInsights } from "./api";

/**
 * Pure presentation helpers for the Analytics page (package #8), kept
 * out of App.tsx so the formatting rules are unit-testable - including
 * the honesty rules: a missing median renders as an em dash, never as a
 * fabricated zero, and a period delta exists only when BOTH periods
 * produced a median.
 */

/** "45m" under an hour, "2h 05m" above it, "—" for null. Input is minutes (may be fractional). */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "—";
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return `${hours}h ${String(rest).padStart(2, "0")}m`;
}

export type ResponseDelta = { direction: "faster" | "slower" | "same"; diffMinutes: number } | null;

/**
 * Current median vs previous median. Lower is better for response time:
 * a smaller current value is "faster". Null when either side is missing
 * (no honest comparison exists).
 */
export function responseDelta(current: number | null, previous: number | null): ResponseDelta {
  if (current === null || previous === null) return null;
  const diff = Math.round(Math.abs(current - previous) * 10) / 10;
  if (diff === 0) return { direction: "same", diffMinutes: 0 };
  return { direction: current < previous ? "faster" : "slower", diffMinutes: diff };
}

/**
 * Runtime shape check for the insights payload. The lesson of package
 * #6 stands: a client type that drifts from the wire shape crashes the
 * page at render time, so the Analytics page validates before it
 * trusts - a bad shape becomes a load error, not a white screen.
 */
export function isStatsInsights(value: unknown): value is StatsInsights {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.days !== "number" || typeof v.replyTargetMinutes !== "number") return false;
  if (typeof v.periodStart !== "string" || typeof v.previousPeriodStart !== "string") return false;
  if (!Array.isArray(v.channels) || !Array.isArray(v.activity)) return false;
  for (const row of v.channels) {
    if (typeof row !== "object" || row === null) return false;
    const r = row as Record<string, unknown>;
    if (typeof r.channel !== "string") return false;
    if (typeof r.conversationsOpened !== "number" || typeof r.messagesIn !== "number" || typeof r.messagesOut !== "number") return false;
  }
  if (typeof v.response !== "object" || v.response === null) return false;
  const resp = v.response as Record<string, unknown>;
  if (typeof resp.waitingCount !== "number" || typeof resp.overTargetCount !== "number") return false;
  if (resp.oldestWaitingMinutes !== null && typeof resp.oldestWaitingMinutes !== "number") return false;
  for (const key of ["medianFirstResponseMinutes", "previousMedianFirstResponseMinutes"] as const) {
    const med = resp[key] as Record<string, unknown> | null;
    if (typeof med !== "object" || med === null) return false;
    if (med.human !== null && typeof med.human !== "number") return false;
    if (med.ai !== null && typeof med.ai !== "number") return false;
  }
  for (const entry of v.activity) {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.action !== "string" || typeof e.createdAt !== "string") return false;
    if (typeof e.details !== "object" || e.details === null || Array.isArray(e.details)) return false;
    if (e.actor !== null) {
      if (typeof e.actor !== "object" || Array.isArray(e.actor)) return false;
      const actor = e.actor as Record<string, unknown>;
      if (typeof actor.userId !== "string") return false;
      if (actor.name !== null && typeof actor.name !== "string") return false;
      if (actor.email !== null && typeof actor.email !== "string") return false;
    }
  }
  return true;
}
