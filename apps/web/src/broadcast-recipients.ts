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
