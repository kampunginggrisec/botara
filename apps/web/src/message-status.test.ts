import { describe, expect, test } from "bun:test";
import { messageStatusLabelKey, messageStatusTicks } from "./message-status";

/**
 * Outbound bubble status glyphs (package #8): the inbox renders ticks
 * from the message status the API serializer already exposes - whose
 * values now actually advance via provider delivery receipts.
 */
describe("messageStatusTicks", () => {
  test("maps each lifecycle status to its glyph", () => {
    expect(messageStatusTicks("queued")).toEqual({ ticks: "◷", read: false });
    expect(messageStatusTicks("sent")).toEqual({ ticks: "✓", read: false });
    expect(messageStatusTicks("delivered")).toEqual({ ticks: "✓✓", read: false });
    expect(messageStatusTicks("read")).toEqual({ ticks: "✓✓", read: true });
    expect(messageStatusTicks("failed")).toEqual({ ticks: "✗", read: false });
  });

  test("inbound and unknown statuses render no ticks", () => {
    expect(messageStatusTicks("received")).toEqual({ ticks: "", read: false });
    expect(messageStatusTicks("whatever")).toEqual({ ticks: "", read: false });
  });
});

describe("messageStatusLabelKey", () => {
  test("known statuses map to inbox.status.* keys", () => {
    expect(messageStatusLabelKey("queued")).toBe("inbox.status.queued");
    expect(messageStatusLabelKey("read")).toBe("inbox.status.read");
    expect(messageStatusLabelKey("failed")).toBe("inbox.status.failed");
  });

  test("unknown statuses have no label key (the raw status is shown)", () => {
    expect(messageStatusLabelKey("received")).toBeNull();
    expect(messageStatusLabelKey("whatever")).toBeNull();
  });
});
