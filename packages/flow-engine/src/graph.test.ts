import { describe, expect, test } from "bun:test";
import { storedGraphSchema } from "./graph";

/**
 * Cross-reference integrity at the storage/import boundary: the node
 * schemas validate each node in isolation, so these tests pin the
 * graph-level checks - every id a graph points at (startNodeId, next,
 * condition branches, edges) must be a node in the same graph.
 */

const validGraph = {
  startNodeId: "t1",
  nodes: [
    { id: "t1", type: "trigger", trigger: "keyword", config: { keyword: "halo" }, next: "c1", position: { x: 0, y: 0 } },
    {
      id: "c1", type: "condition", field: "city", operator: "exists",
      whenTrue: "a1", whenFalse: "s1", next: null, position: { x: 0, y: 80 },
    },
    { id: "a1", type: "add_tag", tag: "vip", next: "i1", position: { x: 0, y: 160 } },
    {
      id: "i1", type: "collect_input", promptText: "Kota apa?", variable: "city",
      saveToContactField: "city", next: "a2", position: { x: 0, y: 240 },
    },
    { id: "a2", type: "assign", userId: null, next: "a3", position: { x: 0, y: 320 } },
    { id: "a3", type: "sequence_subscribe", sequenceId: "seq-1", next: "s1", position: { x: 0, y: 400 } },
    { id: "s1", type: "send_message", text: "Halo!", next: "a4", position: { x: 0, y: 480 } },
    { id: "a4", type: "set_conversation_status", status: "resolved", next: null, position: { x: 0, y: 560 } },
  ],
  edges: [
    { id: "e1", source: "t1", target: "c1" },
    { id: "e2", source: "c1", target: "a1", sourceHandle: "true" },
    { id: "e3", source: "c1", target: "s1", sourceHandle: "false" },
    { id: "e4", source: "a1", target: "i1" },
    { id: "e5", source: "i1", target: "a2" },
    { id: "e6", source: "a2", target: "a3" },
    { id: "e7", source: "a3", target: "s1" },
    { id: "e8", source: "s1", target: "a4" },
  ],
};

function issuePaths(input: unknown): string[] {
  const parsed = storedGraphSchema.safeParse(input);
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => i.path.join("."));
}

describe("storedGraphSchema cross-reference checks", () => {
  test("a full graph using the package #3 node types passes", () => {
    expect(storedGraphSchema.safeParse(validGraph).success).toBe(true);
  });

  test("startNodeId naming a nonexistent node is rejected", () => {
    const bad = { ...validGraph, startNodeId: "ghost" };
    expect(issuePaths(bad)).toContain("startNodeId");
  });

  test("startNodeId may point at a non-trigger node (existence is the invariant)", () => {
    // The builder falls back to the first node when a graph has no
    // trigger node (manual-trigger flow) - only existence is enforced.
    const noTrigger = {
      startNodeId: "s1",
      nodes: [{ id: "s1", type: "send_message", text: "Halo!", next: null }],
      edges: [],
    };
    expect(storedGraphSchema.safeParse(noTrigger).success).toBe(true);
  });

  test("a dangling next is rejected with the node's path", () => {
    const bad = structuredClone(validGraph);
    (bad.nodes[0] as { next: string | null }).next = "ghost";
    expect(issuePaths(bad)).toContain("nodes.0.next");
  });

  test("dangling condition branches are rejected per branch", () => {
    const badTrue = structuredClone(validGraph);
    (badTrue.nodes[1] as { whenTrue: string | null }).whenTrue = "ghost";
    expect(issuePaths(badTrue)).toContain("nodes.1.whenTrue");

    const badFalse = structuredClone(validGraph);
    (badFalse.nodes[1] as { whenFalse: string | null }).whenFalse = "ghost";
    expect(issuePaths(badFalse)).toContain("nodes.1.whenFalse");
  });

  test("null next / null branches remain valid (end of flow)", () => {
    const ends = structuredClone(validGraph);
    (ends.nodes[1] as { whenTrue: string | null }).whenTrue = null;
    (ends.nodes[1] as { whenFalse: string | null }).whenFalse = null;
    expect(storedGraphSchema.safeParse(ends).success).toBe(true);
  });

  test("edges referencing nonexistent nodes are rejected per endpoint", () => {
    const badSource = structuredClone(validGraph);
    badSource.edges[0]!.source = "ghost";
    expect(issuePaths(badSource)).toContain("edges.0.source");

    const badTarget = structuredClone(validGraph);
    badTarget.edges[0]!.target = "ghost";
    expect(issuePaths(badTarget)).toContain("edges.0.target");
  });

  test("every dangling reference is reported, not just the first", () => {
    const bad = structuredClone(validGraph);
    bad.startNodeId = "ghost";
    (bad.nodes[6] as { next: string | null }).next = "ghost";
    bad.edges[7]!.target = "ghost";
    const paths = issuePaths(bad);
    expect(paths).toContain("startNodeId");
    expect(paths).toContain("nodes.6.next");
    expect(paths).toContain("edges.7.target");
  });

  test("external ids on action steps are NOT graph-checked (runtime concern)", () => {
    const graph = structuredClone(validGraph);
    (graph.nodes[5] as { sequenceId: string }).sequenceId = "no-such-sequence";
    (graph.nodes[4] as { userId: string | null }).userId = "no-such-user";
    expect(storedGraphSchema.safeParse(graph).success).toBe(true);
  });
});
