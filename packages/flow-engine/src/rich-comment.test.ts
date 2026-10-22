import { describe, expect, test } from "bun:test";
import { runFlow, type FlowPorts } from "./executor";
import { firstSendMessageOf, storedGraphSchema } from "./graph";
import { commentTriggerConfig, flowTriggerMatches, type FlowTrigger } from "./triggers";
import type { Flow } from "./schemas";

/**
 * Adopted-features coverage for the engine: send_message nodes carry rich
 * blocks through the interpreter + executor untouched, and comment_keyword
 * triggers match comment text (never message text).
 */

const RICH = {
  kind: "buttons" as const,
  text: "Pick one",
  buttons: [{ type: "reply" as const, title: "Prices", payload: "PRICES" }],
};

const flowWithRich: Flow = {
  id: "flow-rich",
  version: 1,
  startNodeId: "t1",
  nodes: [
    { id: "t1", type: "trigger", trigger: "manual", config: {}, next: "s1" },
    { id: "s1", type: "send_message", text: "Pick one", rich: RICH, next: null },
  ],
};

function recordingPorts() {
  const sent: Array<{ text: string; channel?: string; rich?: unknown }> = [];
  const ports: FlowPorts = {
    async sendMessage(input) { sent.push(input); },
    async scheduleDelay() {},
    async httpWebhook() {},
    async setContactField() {},
  };
  return { ports, sent };
}

describe("send_message rich passthrough", () => {
  test("runFlow delivers the rich block to the sendMessage port intact", async () => {
    const { ports, sent } = recordingPorts();
    const result = await runFlow(ports, flowWithRich, undefined, { type: "manual" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.rich).toEqual(RICH);
    const action = result.executed.find((a) => a.type === "send_message");
    expect(action).toMatchObject({ type: "send_message", rich: RICH });
  });

  test("a stored graph with a rich send_message node validates", () => {
    const parsed = storedGraphSchema.safeParse({
      startNodeId: "t1",
      nodes: [
        { id: "t1", type: "trigger", trigger: "keyword", config: {}, next: "s1" },
        { id: "s1", type: "send_message", text: "Pick one", rich: RICH, next: null },
      ],
      edges: [{ id: "e1", source: "t1", target: "s1" }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("comment_keyword triggers", () => {
  const trigger: FlowTrigger = {
    type: "comment_keyword",
    config: { keyword: "price", match: "contains", publicReplyText: "Check DM!", autoHide: true },
  };

  test("matches comment text case-insensitively (contains default)", () => {
    expect(flowTriggerMatches(trigger, { commentText: "What is the PRICE for this?" })).toBe(true);
    expect(flowTriggerMatches(trigger, { commentText: "nice post" })).toBe(false);
  });

  test("does NOT match message text - comment triggers are comment-only", () => {
    expect(flowTriggerMatches(trigger, { text: "price please" })).toBe(false);
    expect(flowTriggerMatches(
      { type: "keyword", config: { keyword: "price" } },
      { commentText: "price please" },
    )).toBe(false);
  });

  test("equals mode requires the whole comment", () => {
    const eq: FlowTrigger = { type: "comment_keyword", config: { keyword: "price", match: "equals" } };
    expect(flowTriggerMatches(eq, { commentText: "  Price " })).toBe(true);
    expect(flowTriggerMatches(eq, { commentText: "price please" })).toBe(false);
  });

  test("commentTriggerConfig reads the automation fields defensively", () => {
    expect(commentTriggerConfig(trigger)).toEqual({
      keyword: "price", match: "contains",
      publicReplyText: "Check DM!", autoHide: true, privateText: undefined,
    });
    expect(commentTriggerConfig({ type: "keyword", config: { keyword: "x" } })).toBeNull();
    expect(commentTriggerConfig({ type: "comment_keyword", config: {} })).toBeNull();
  });
});

describe("firstSendMessageOf", () => {
  test("walks through the trigger to the first send_message and reports its next", () => {
    const graph = {
      startNodeId: "t1",
      nodes: [
        { id: "t1", type: "trigger" as const, trigger: "keyword" as const, config: {}, next: "s1" },
        { id: "s1", type: "send_message" as const, text: "DM text", next: "s2" },
        { id: "s2", type: "send_message" as const, text: "second", next: null },
      ],
      edges: [],
    };
    expect(firstSendMessageOf(graph)).toEqual({ nodeId: "s1", text: "DM text", nextNodeId: "s2" });
  });

  test("returns null when a condition branches before any send_message", () => {
    const graph = {
      startNodeId: "t1",
      nodes: [
        { id: "t1", type: "trigger" as const, trigger: "manual" as const, config: {}, next: "c1" },
        {
          id: "c1", type: "condition" as const, field: "x", operator: "exists" as const,
          whenTrue: "s1", whenFalse: null, next: null,
        },
        { id: "s1", type: "send_message" as const, text: "hi", next: null },
      ],
      edges: [],
    };
    expect(firstSendMessageOf(graph)).toBeNull();
  });
});
