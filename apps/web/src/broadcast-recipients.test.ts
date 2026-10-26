import { describe, expect, test } from "bun:test";
import {
  RECIPIENT_STATUSES, countRecipientsByStatus, filterRecipientsByStatus,
  isRecipientStatus, recipientTimeline,
} from "./broadcast-recipients";
import type { BroadcastRecipient } from "./api";

const row = (over: Partial<BroadcastRecipient>): BroadcastRecipient => ({
  id: "r", broadcastId: "b1", workspaceId: "ws1", contactId: "c1",
  status: "pending", providerMessageId: null, messageId: null, error: null,
  contactDisplayName: "Andi", contactExternalId: "628111", contactChannel: "whatsapp",
  sentAt: null, deliveredAt: null, readAt: null, repliedAt: null,
  createdAt: "2026-10-26T10:00:00.000Z", updatedAt: "2026-10-26T10:00:00.000Z",
  ...over,
});

describe("broadcast recipients view model (package #4)", () => {
  const rows = [
    row({ id: "r1", status: "pending" }),
    row({ id: "r2", status: "sent" }),
    row({ id: "r3", status: "failed" }),
    row({ id: "r4", status: "failed" }),
    row({ id: "r5", status: "read" }),
  ];

  test("status vocabulary is the lifecycle order", () => {
    expect(RECIPIENT_STATUSES).toEqual(["pending", "sent", "delivered", "read", "replied", "failed"]);
    expect(isRecipientStatus("read")).toBe(true);
    expect(isRecipientStatus("bogus")).toBe(false);
  });

  test("filter: empty status returns all, a status narrows to matches", () => {
    expect(filterRecipientsByStatus(rows, "")).toHaveLength(5);
    expect(filterRecipientsByStatus(rows, "failed").map((r) => r.id)).toEqual(["r3", "r4"]);
    expect(filterRecipientsByStatus(rows, "replied")).toEqual([]);
  });

  test("counts tally per status plus the total; unknown statuses count only in total", () => {
    const counts = countRecipientsByStatus([...rows, row({ id: "r6", status: "mystery" })]);
    expect(counts).toEqual({
      pending: 1, sent: 1, delivered: 0, read: 1, replied: 0, failed: 2, total: 6,
    });
  });

  test("timeline lists only the stamps the recipient actually has, in lifecycle order", () => {
    expect(recipientTimeline(row({ status: "pending" }))).toEqual([]);
    expect(recipientTimeline(row({
      sentAt: "2026-10-26T10:01:00.000Z", readAt: "2026-10-26T10:05:00.000Z",
    }))).toEqual([
      { status: "sent", at: "2026-10-26T10:01:00.000Z" },
      { status: "read", at: "2026-10-26T10:05:00.000Z" },
    ]);
    expect(recipientTimeline(row({
      sentAt: "t1", deliveredAt: "t2", readAt: "t3", repliedAt: "t4",
    })).map((s) => s.status)).toEqual(["sent", "delivered", "read", "replied"]);
  });
});
