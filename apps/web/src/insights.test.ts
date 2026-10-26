import { describe, expect, test } from "bun:test";
import { formatMinutes, isStatsInsights, responseDelta } from "./insights";
import type { StatsInsights } from "./api";

/**
 * Analytics (package #8) pure helpers: duration formatting, the
 * previous-period delta phrasing, and the wire-shape guard that keeps
 * a drifted API payload from crashing the Analytics page (the #6
 * lesson: client types must match wire shapes exactly).
 */

const validInsights: StatsInsights = {
  days: 30,
  periodStart: "2026-09-27T00:00:00.000Z",
  previousPeriodStart: "2026-08-28T00:00:00.000Z",
  replyTargetMinutes: 60,
  channels: [{ channel: "whatsapp", conversationsOpened: 4, messagesIn: 4, messagesOut: 3 }],
  response: {
    waitingCount: 2,
    oldestWaitingMinutes: 200,
    overTargetCount: 1,
    medianFirstResponseMinutes: { human: 15, ai: 30 },
    previousMedianFirstResponseMinutes: { human: 50, ai: 20 },
  },
  activity: [{
    id: "a-1",
    actor: { userId: "u-1", name: "Owner", email: "owner@example.com" },
    action: "deal.created",
    details: {},
    createdAt: "2026-10-26T10:00:00.000Z",
  }],
};

describe("formatMinutes", () => {
  test("null renders the empty placeholder", () => {
    expect(formatMinutes(null)).toBe("—");
  });

  test("sub-hour durations render as minutes", () => {
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(45.6)).toBe("46m");
  });

  test("hour-plus durations render h + padded minutes", () => {
    expect(formatMinutes(60)).toBe("1h 00m");
    expect(formatMinutes(125)).toBe("2h 05m");
    expect(formatMinutes(200)).toBe("3h 20m");
  });
});

describe("responseDelta", () => {
  test("no delta when either side has no data", () => {
    expect(responseDelta(null, 50)).toBeNull();
    expect(responseDelta(15, null)).toBeNull();
    expect(responseDelta(null, null)).toBeNull();
  });

  test("faster, slower, and same bucket correctly with rounded diffs", () => {
    expect(responseDelta(15, 50)).toEqual({ direction: "faster", diffMinutes: 35 });
    expect(responseDelta(30, 20)).toEqual({ direction: "slower", diffMinutes: 10 });
    expect(responseDelta(20, 20)).toEqual({ direction: "same", diffMinutes: 0 });
  });
});

describe("isStatsInsights", () => {
  test("accepts the exact wire shape", () => {
    expect(isStatsInsights(validInsights)).toBe(true);
    expect(isStatsInsights({ ...validInsights, channels: [], activity: [] })).toBe(true);
  });

  test("rejects non-objects and drifted shapes instead of rendering them", () => {
    expect(isStatsInsights(null)).toBe(false);
    expect(isStatsInsights("insights")).toBe(false);
    expect(isStatsInsights({ ...validInsights, response: undefined })).toBe(false);
    expect(isStatsInsights({ ...validInsights, days: "30" })).toBe(false);
    expect(isStatsInsights({ ...validInsights, channels: [{ channel: "whatsapp" }] })).toBe(false);
    expect(isStatsInsights({
      ...validInsights,
      response: { ...validInsights.response, medianFirstResponseMinutes: { human: "15", ai: 30 } },
    })).toBe(false);
    expect(isStatsInsights({
      ...validInsights,
      activity: [{ id: "a-1", actor: "u-1", action: "deal.created", details: {}, createdAt: "x" }],
    })).toBe(false);
  });
});
