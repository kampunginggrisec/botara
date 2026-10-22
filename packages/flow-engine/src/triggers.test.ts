import { describe, expect, test } from "bun:test";
import { flowTriggerMatches, type FlowTrigger } from "./triggers";
import { storedGraphSchema, toRunnableFlow } from "./graph";

describe("flowTriggerMatches (dispatcher matcher)", () => {
  const keyword = (config: Record<string, unknown>): FlowTrigger => ({ type: "keyword", config });

  test("keyword contains is the default and is case-insensitive", () => {
    expect(flowTriggerMatches(keyword({ keyword: "Harga" }), { text: "kak, HARGA paket berapa?" })).toBe(true);
    expect(flowTriggerMatches(keyword({ keyword: "harga" }), { text: "info dong" })).toBe(false);
  });

  test("keyword equals requires the whole message", () => {
    const t = keyword({ keyword: "menu", match: "equals" });
    expect(flowTriggerMatches(t, { text: "  MENU " })).toBe(true);
    expect(flowTriggerMatches(t, { text: "buka menu" })).toBe(false);
  });

  test("empty keyword / empty text never match", () => {
    expect(flowTriggerMatches(keyword({ keyword: "" }), { text: "halo" })).toBe(false);
    expect(flowTriggerMatches(keyword({ keyword: "halo" }), { text: "" })).toBe(false);
    expect(flowTriggerMatches(keyword({ keyword: "halo" }), {})).toBe(false);
  });

  test("manual triggers never match inbound events", () => {
    expect(flowTriggerMatches({ type: "manual", config: {} }, { text: "halo" })).toBe(false);
  });

  test("postback matches payloads (equals default-strict via config)", () => {
    const t: FlowTrigger = { type: "postback", config: { payload: "GET_STARTED", match: "equals" } };
    expect(flowTriggerMatches(t, { payload: "get_started" })).toBe(true);
    expect(flowTriggerMatches(t, { payload: "OTHER" })).toBe(false);
    expect(flowTriggerMatches(t, { text: "GET_STARTED" })).toBe(false);
  });
});

describe("stored graph schema + runnable conversion", () => {
  const graph = {
    startNodeId: "t1",
    nodes: [
      { id: "t1", type: "trigger", trigger: "keyword", config: { keyword: "halo" }, next: "m1", position: { x: 10, y: 20 } },
      { id: "m1", type: "send_message", text: "Halo juga!", next: null },
    ],
    edges: [{ id: "e1", source: "t1", target: "m1" }],
  };

  test("validates a builder graph (positions allowed)", () => {
    const parsed = storedGraphSchema.parse(graph);
    expect(parsed.nodes).toHaveLength(2);
  });

  test("rejects an invalid node payload", () => {
    const bad = { ...graph, nodes: [{ id: "x", type: "delay", seconds: -5, next: null }] };
    expect(storedGraphSchema.safeParse(bad).success).toBe(false);
  });

  test("toRunnableFlow strips positions and keeps engine fields", () => {
    const flow = toRunnableFlow("flow-1", storedGraphSchema.parse(graph));
    expect(flow.id).toBe("flow-1");
    expect(flow.startNodeId).toBe("t1");
    expect(flow.nodes[0]).not.toHaveProperty("position");
    expect(flow.nodes[1]).toMatchObject({ type: "send_message", text: "Halo juga!" });
  });
});
