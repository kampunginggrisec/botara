import { describe, expect, test } from "bun:test";
import { broadcastRecipientTransition } from "./repositories";

/**
 * The forward-only transition guard behind every broadcast recipient
 * update (package #4): provider webhooks arrive out of order, so a late
 * "delivered" must never regress a "read", and "failed" is reachable
 * only before delivery - afterwards only a resend can move it.
 */
const at = new Date("2026-10-26T12:00:00.000Z");
const row = (status: string) => ({
  status,
  sentAt: null as Date | null,
  deliveredAt: null as Date | null,
  readAt: null as Date | null,
  repliedAt: null as Date | null,
});

describe("broadcastRecipientTransition", () => {
  test("happy path advances and stamps each stage", () => {
    expect(broadcastRecipientTransition(row("pending"), "sent", at))
      .toEqual({ status: "sent", sentAt: at });
    expect(broadcastRecipientTransition(row("sent"), "delivered", at))
      .toEqual({ status: "delivered", deliveredAt: at, sentAt: at });
    expect(broadcastRecipientTransition(row("delivered"), "read", at))
      .toEqual({ status: "read", readAt: at, sentAt: at, deliveredAt: at });
    expect(broadcastRecipientTransition(row("read"), "replied", at))
      .toEqual({ status: "replied", repliedAt: at, sentAt: at, deliveredAt: at, readAt: at });
  });

  test("skipped stages are backfilled (delivered implies sent)", () => {
    const patch = broadcastRecipientTransition(row("pending"), "read", at);
    expect(patch).toEqual({ status: "read", readAt: at, sentAt: at, deliveredAt: at });
  });

  test("backwards and same-state transitions are rejected (no regression)", () => {
    expect(broadcastRecipientTransition(row("read"), "delivered", at)).toBeNull();
    expect(broadcastRecipientTransition(row("read"), "sent", at)).toBeNull();
    expect(broadcastRecipientTransition(row("delivered"), "delivered", at)).toBeNull();
    expect(broadcastRecipientTransition(row("replied"), "read", at)).toBeNull();
    expect(broadcastRecipientTransition(row("pending"), "pending", at)).toBeNull();
  });

  test("failed only from pending/sent; terminal afterwards", () => {
    expect(broadcastRecipientTransition(row("pending"), "failed", at)).toEqual({ status: "failed" });
    expect(broadcastRecipientTransition(row("sent"), "failed", at)).toEqual({ status: "failed" });
    expect(broadcastRecipientTransition(row("delivered"), "failed", at)).toBeNull();
    expect(broadcastRecipientTransition(row("read"), "failed", at)).toBeNull();
    expect(broadcastRecipientTransition(row("replied"), "failed", at)).toBeNull();
    expect(broadcastRecipientTransition(row("failed"), "delivered", at)).toBeNull();
    // ... but a resend outcome can move failed -> sent again.
    expect(broadcastRecipientTransition(row("failed"), "sent", at))
      .toEqual({ status: "sent", sentAt: at });
  });

  test("an existing stamp is never overwritten (first reply wins)", () => {
    const earlier = new Date("2026-10-26T11:00:00.000Z");
    const current = { ...row("sent"), sentAt: earlier };
    const patch = broadcastRecipientTransition(current, "delivered", at);
    expect(patch?.sentAt).toBe(earlier);
    expect(patch?.deliveredAt).toBe(at);
  });
});
