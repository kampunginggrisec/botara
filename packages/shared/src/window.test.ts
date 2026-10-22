import { describe, expect, test } from "bun:test";
import { evaluateReplyWindow, MessagingWindowClosedError } from "./window";

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
});
