import { describe, expect, test } from "bun:test";
import { messageStatusTransition } from "./repositories";

/**
 * The forward-only transition guard behind inbox message status
 * advancement (package #8): provider delivery receipts arrive out of
 * order, so a late "delivered" must never regress a "read", and
 * "failed" is reachable only before delivery.
 */
describe("messageStatusTransition", () => {
  test("happy path advances strictly by rank", () => {
    expect(messageStatusTransition("queued", "sent")).toBe("sent");
    expect(messageStatusTransition("sent", "delivered")).toBe("delivered");
    expect(messageStatusTransition("delivered", "read")).toBe("read");
  });

  test("a receipt may skip stages (read implies delivered and sent)", () => {
    expect(messageStatusTransition("queued", "read")).toBe("read");
    expect(messageStatusTransition("sent", "read")).toBe("read");
    expect(messageStatusTransition("queued", "delivered")).toBe("delivered");
  });

  test("out-of-order and duplicate receipts never regress", () => {
    expect(messageStatusTransition("read", "delivered")).toBeNull();
    expect(messageStatusTransition("read", "sent")).toBeNull();
    expect(messageStatusTransition("delivered", "sent")).toBeNull();
    expect(messageStatusTransition("sent", "sent")).toBeNull();
    expect(messageStatusTransition("read", "read")).toBeNull();
  });

  test("failed is reachable only from queued/sent and is terminal", () => {
    expect(messageStatusTransition("queued", "failed")).toBe("failed");
    expect(messageStatusTransition("sent", "failed")).toBe("failed");
    expect(messageStatusTransition("delivered", "failed")).toBeNull();
    expect(messageStatusTransition("read", "failed")).toBeNull();
    expect(messageStatusTransition("failed", "sent")).toBeNull();
    expect(messageStatusTransition("failed", "delivered")).toBeNull();
    expect(messageStatusTransition("failed", "read")).toBeNull();
  });

  test("unknown current statuses never move", () => {
    expect(messageStatusTransition("received", "delivered")).toBeNull();
    expect(messageStatusTransition("", "read")).toBeNull();
  });
});
