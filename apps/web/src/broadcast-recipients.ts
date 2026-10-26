/**
 * Pure view-model helpers for the broadcast recipients section
 * (package #4): status vocabulary, filter/count logic and the
 * per-recipient timeline. Kept separate from App.tsx so the logic is
 * unit-testable without rendering.
 */
import type { BroadcastRecipient } from "./api";

/** Lifecycle order - also the chip order in the recipients section. */
export const RECIPIENT_STATUSES = ["pending", "sent", "delivered", "read", "replied", "failed"] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export function isRecipientStatus(value: string): value is RecipientStatus {
  return (RECIPIENT_STATUSES as readonly string[]).includes(value);
}

/** "" (or an unknown value) means "all statuses". */
export function filterRecipientsByStatus(
  rows: BroadcastRecipient[],
  status: string,
): BroadcastRecipient[] {
  if (!status) return rows;
  return rows.filter((r) => r.status === status);
}

export interface RecipientCounts {
  pending: number; sent: number; delivered: number; read: number;
  replied: number; failed: number; total: number;
}

export function countRecipientsByStatus(rows: BroadcastRecipient[]): RecipientCounts {
  const counts: RecipientCounts = {
    pending: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, total: rows.length,
  };
  for (const row of rows) {
    if (isRecipientStatus(row.status)) counts[row.status] += 1;
  }
  return counts;
}

/** Chip styling per status: neutral progress, green completion, red failure. */
export function recipientStatusTone(status: string): string {
  switch (status) {
    case "failed":
      return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
    case "read":
    case "replied":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300";
    case "delivered":
      return "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300";
    default:
      return "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
  }
}

/**
 * Money on broadcast rows. `estimatedCostUsd` is a NULLABLE numeric
 * column and the API passes the raw row through; postgres-js returns
 * numerics as strings, so over the wire the value is a number, a
 * numeric string, or null. Rendering must never call `.toFixed` on it
 * raw - a null (or string) value used to white-screen the whole
 * Broadcast page. These helpers are the only sanctioned way to turn
 * broadcast money fields into display text.
 */
export type UsdValue = number | string | null | undefined;

/** Coerce an API money value to a finite number, or null when unknown. */
export function usdNumber(value: UsdValue): number | null {
  if (value === null || value === undefined) return null;
  // Number("") is 0, but an empty wire value means "no value", not free.
  if (typeof value === "string" && value.trim() === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The cost a broadcast row shows: the realized ledger total once any
 * send is recorded, otherwise the create-time estimate, otherwise
 * null (unknown - the row predates estimates or was made without one).
 */
export function broadcastCostUsd(b: {
  totalCostUsd?: UsdValue;
  estimatedCostUsd?: UsdValue;
}): number | null {
  const total = usdNumber(b.totalCostUsd);
  if (total !== null && total > 0) return total;
  return usdNumber(b.estimatedCostUsd);
}

/** "$x.xxxx" for a known cost, an em dash for an unknown one. */
export function formatUsd(value: UsdValue): string {
  const n = usdNumber(value);
  return n === null ? "—" : `$${n.toFixed(4)}`;
}

export interface RecipientStamp { status: RecipientStatus; at: string }

/**
 * The stamps a recipient actually has, in lifecycle order - the detail
 * table renders these instead of four mostly-empty timestamp columns.
 */
export function recipientTimeline(row: BroadcastRecipient): RecipientStamp[] {
  const stamps: RecipientStamp[] = [];
  if (row.sentAt) stamps.push({ status: "sent", at: row.sentAt });
  if (row.deliveredAt) stamps.push({ status: "delivered", at: row.deliveredAt });
  if (row.readAt) stamps.push({ status: "read", at: row.readAt });
  if (row.repliedAt) stamps.push({ status: "replied", at: row.repliedAt });
  return stamps;
}
