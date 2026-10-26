import { describe, expect, test } from "bun:test";
import {
  RECIPIENT_STATUSES, broadcastCostUsd, countRecipientsByStatus, filterRecipientsByStatus,
  formatUsd, isRecipientStatus, recipientTimeline, usdNumber,
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

describe("broadcast cost helpers (null-safe money rendering)", () => {
  test("usdNumber coerces numbers and numeric strings, rejects the unknown", () => {
    expect(usdNumber(0.25)).toBe(0.25);
    expect(usdNumber(0)).toBe(0);
    expect(usdNumber("0.250000")).toBe(0.25);
    expect(usdNumber(null)).toBeNull();
    expect(usdNumber(undefined)).toBeNull();
    expect(usdNumber("")).toBeNull();
    expect(usdNumber("not-a-number")).toBeNull();
  });

  test("null estimate falls back: no cost is known, none is invented", () => {
    // The white-screen regression: totalCostUsd 0 + estimatedCostUsd null.
    expect(broadcastCostUsd({ totalCostUsd: 0, estimatedCostUsd: null })).toBeNull();
    expect(formatUsd(broadcastCostUsd({ totalCostUsd: 0, estimatedCostUsd: null }))).toBe("—");
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(undefined)).toBe("—");
  });

  test("0 total with an estimate shows the estimate (number or wire string)", () => {
    expect(broadcastCostUsd({ totalCostUsd: 0, estimatedCostUsd: 0.25 })).toBe(0.25);
    expect(broadcastCostUsd({ totalCostUsd: 0, estimatedCostUsd: "0.250000" })).toBe(0.25);
    expect(formatUsd(broadcastCostUsd({ totalCostUsd: 0, estimatedCostUsd: "0.250000" }))).toBe("$0.2500");
  });

  test("positive total wins over the estimate", () => {
    expect(broadcastCostUsd({ totalCostUsd: 1.5, estimatedCostUsd: 0.25 })).toBe(1.5);
    expect(broadcastCostUsd({ totalCostUsd: "1.500000", estimatedCostUsd: null })).toBe(1.5);
    expect(formatUsd(1.5)).toBe("$1.5000");
  });

  test("a genuine zero is rendered as $0.0000, not as unknown", () => {
    expect(broadcastCostUsd({ totalCostUsd: 0, estimatedCostUsd: 0 })).toBe(0);
    expect(formatUsd(0)).toBe("$0.0000");
    expect(formatUsd("0.000000")).toBe("$0.0000");
  });
});
