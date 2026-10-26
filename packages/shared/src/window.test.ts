import { describe, expect, test } from "bun:test";
import {
  ConsecutiveSendCapError, countConsecutiveOutbound, evaluateReplyWindow, MessagingWindowClosedError,
} from "./window";

const NOW = new Date("2026-10-22T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("evaluateReplyWindow (messaging-window policy)", () => {
  test("free-form whatsapp reply allowed 1h after user message", () => {
    const d = evaluateReplyWindow({ channel: "whatsapp", kind: "free_form", lastUserMessageAt: hoursAgo(1), now: NOW });
    expect(d.allowed).toBe(true);
    expect(d.windowOpen).toBe(true);
  });

  test("free-form whatsapp reply rejected 25h after user message (fail closed)", () => {
    const d = evaluateReplyWindow({ channel: "whatsapp", kind: "free_form", lastUserMessageAt: hoursAgo(25), now: NOW });
    expect(d.allowed).toBe(false);
    expect(d.windowOpen).toBe(false);
  });

  test("free-form rejected when the user never messaged", () => {
    const d = evaluateReplyWindow({ channel: "whatsapp", kind: "free_form", lastUserMessageAt: null, now: NOW });
    expect(d.allowed).toBe(false);
  });

  test("exactly at the 24h boundary is still allowed", () => {
    const d = evaluateReplyWindow({ channel: "whatsapp", kind: "free_form", lastUserMessageAt: hoursAgo(24), now: NOW });
    expect(d.allowed).toBe(true);
  });

  test("template reply stays allowed outside the window", () => {
    const d = evaluateReplyWindow({ channel: "whatsapp", kind: "template", lastUserMessageAt: hoursAgo(72), now: NOW });
    expect(d.allowed).toBe(true);
    expect(d.windowOpen).toBe(false);
  });

  test("telegram has no window: free-form always allowed", () => {
    const d = evaluateReplyWindow({ channel: "telegram", kind: "free_form", lastUserMessageAt: null, now: NOW });
    expect(d.allowed).toBe(true);
    expect(d.windowEnforced).toBe(false);
  });

  test("MessagingWindowClosedError carries the taxonomy code", () => {
    const err = new MessagingWindowClosedError("whatsapp");
    expect(err.code).toBe("MESSAGING_WINDOW_CLOSED");
    expect(err.status).toBe(422);
  });

  test("tiktok window is 48h: a free-form reply 30h after the user message is allowed", () => {
    const d = evaluateReplyWindow({ channel: "tiktok", kind: "free_form", lastUserMessageAt: hoursAgo(30), now: NOW });
    expect(d.allowed).toBe(true);
    expect(d.windowEnforced).toBe(true);
    expect(d.windowOpen).toBe(true);
  });

  test("tiktok free-form reply is rejected 49h after the user message (no template escape)", () => {
    const d = evaluateReplyWindow({ channel: "tiktok", kind: "free_form", lastUserMessageAt: hoursAgo(49), now: NOW });
    expect(d.allowed).toBe(false);
    expect(d.windowOpen).toBe(false);
  });
});

describe("countConsecutiveOutbound (TikTok 10-message cap)", () => {
  const rows = (...dirs: string[]) => dirs.map((direction) => ({ direction }));

  test("counts the trailing outbound run only", () => {
    expect(countConsecutiveOutbound(rows("in", "out", "out", "in", "out", "out", "out"))).toBe(3);
  });

  test("zero when the last message is inbound or the thread is empty", () => {
    expect(countConsecutiveOutbound(rows("out", "in"))).toBe(0);
    expect(countConsecutiveOutbound(rows())).toBe(0);
  });

  test("all-outbound history counts in full", () => {
    expect(countConsecutiveOutbound(rows("out", "out"))).toBe(2);
  });

  test("internal notes are transparent: they neither count nor reset the run", () => {
    const mixed = (
      ...entries: Array<{ direction: string; kind?: string }>
    ) => entries;
    // A note after the last send does not extend the business's run.
    expect(countConsecutiveOutbound(mixed(
      { direction: "in" }, { direction: "out" }, { direction: "out", kind: "note" },
    ))).toBe(1);
    // A note between sends does not break the run either.
    expect(countConsecutiveOutbound(mixed(
      { direction: "in" }, { direction: "out" }, { direction: "out", kind: "note" }, { direction: "out" },
    ))).toBe(2);
    // Notes alone after an inbound message keep the count at zero.
    expect(countConsecutiveOutbound(mixed(
      { direction: "in" }, { direction: "out", kind: "note" }, { direction: "out", kind: "note" },
    ))).toBe(0);
  });

  test("ConsecutiveSendCapError carries cap details", () => {
    const err = new ConsecutiveSendCapError("tiktok", 10, 10);
    expect(err.code).toBe("CONSECUTIVE_SEND_CAP");
    expect(err.status).toBe(422);
    expect(err.details).toEqual({ channel: "tiktok", cap: 10, consecutive: 10 });
  });
});
