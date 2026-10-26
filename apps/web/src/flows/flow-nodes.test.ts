import { describe, expect, test } from "bun:test";
import { storedGraphSchema } from "@botara/flow-engine/graph";
import { NODE_TYPES, defaultEngineNode, nodeSummary } from "./flow-nodes";

/**
 * Builder node model (adoption package #3): the palette covers all
 * engine node types, the fresh-node defaults for the new types are
 * schema-shaped, and the canvas summaries render for them.
 */

describe("flow node model", () => {
  test("the palette lists every engine node type (14)", () => {
    expect([...NODE_TYPES]).toEqual([
      "trigger", "send_message", "condition", "delay", "webhook", "set_field", "ai_reply",
      "add_tag", "remove_tag", "assign", "set_conversation_status",
      "sequence_subscribe", "sequence_unsubscribe", "collect_input",
    ]);
  });

  test("defaults for the new types carry the engine's config fields", () => {
    expect(defaultEngineNode("add_tag", "n1")).toEqual({ id: "n1", type: "add_tag", tag: "", next: null });
    expect(defaultEngineNode("remove_tag", "n2")).toEqual({ id: "n2", type: "remove_tag", tag: "", next: null });
    expect(defaultEngineNode("assign", "n3")).toEqual({ id: "n3", type: "assign", userId: null, next: null });
    expect(defaultEngineNode("set_conversation_status", "n4")).toEqual({ id: "n4", type: "set_conversation_status", status: "resolved", next: null });
    expect(defaultEngineNode("sequence_subscribe", "n5")).toEqual({ id: "n5", type: "sequence_subscribe", sequenceId: "", next: null });
    expect(defaultEngineNode("sequence_unsubscribe", "n6")).toEqual({ id: "n6", type: "sequence_unsubscribe", sequenceId: "all", next: null });
    expect(defaultEngineNode("collect_input", "n7")).toEqual({ id: "n7", type: "collect_input", promptText: "", variable: "", next: null });
  });

  test("a graph built from filled-in defaults passes the engine's stored-graph schema", () => {
    const nodes = [
      { ...defaultEngineNode("trigger", "t1"), trigger: "keyword", config: { keyword: "go" }, next: "a1" },
      { ...defaultEngineNode("add_tag", "a1"), tag: "vip", next: "c1" },
      { ...defaultEngineNode("collect_input", "c1"), promptText: "Kota?", variable: "city", next: "a2" },
      { ...defaultEngineNode("assign", "a2"), userId: null, next: "a3" },
      { ...defaultEngineNode("set_conversation_status", "a3"), status: "resolved", next: null },
    ];
    const parsed = storedGraphSchema.safeParse({
      startNodeId: "t1",
      nodes,
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e2", source: "a1", target: "c1" },
        { id: "e3", source: "c1", target: "a2" },
        { id: "e4", source: "a2", target: "a3" },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  test("summaries render for the new node types", () => {
    expect(nodeSummary({ id: "n", type: "add_tag", tag: "vip" })).toBe("+ vip");
    expect(nodeSummary({ id: "n", type: "remove_tag", tag: "vip" })).toBe("- vip");
    expect(nodeSummary({ id: "n", type: "assign", userId: null })).toBe("unassigned");
    expect(nodeSummary({ id: "n", type: "set_conversation_status", status: "open" })).toBe("open");
    expect(nodeSummary({ id: "n", type: "sequence_unsubscribe", sequenceId: "all" })).toBe("all sequences");
    expect(nodeSummary({ id: "n", type: "collect_input", variable: "city" })).toBe("? {{vars.city}}");
  });
});
