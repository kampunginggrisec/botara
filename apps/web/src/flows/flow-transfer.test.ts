import { describe, expect, test } from "bun:test";
import type { FlowGraph, FlowTrigger } from "../api";
import { buildFlowExport, flowExportFilename, parseFlowImport, serializeFlowExport } from "./flow-transfer";

/**
 * Import/export model (adoption package #3): the envelope shape, the
 * round-trip property across ALL node types (including the new action
 * steps + collect_input), and the validation failures the import UI
 * surfaces as localized messages.
 */

const trigger: FlowTrigger = { type: "keyword", config: { keyword: "survei", match: "contains" } };
const graph: FlowGraph = {
  startNodeId: "t1",
  nodes: [
    { id: "t1", type: "trigger", trigger: "keyword", config: { keyword: "survei" }, next: "s1", position: { x: 0, y: 0 } },
    { id: "s1", type: "send_message", text: "Hai!", next: "c1", position: { x: 0, y: 80 } },
    { id: "c1", type: "collect_input", promptText: "Kota apa?", variable: "city", saveToContactField: "city", timeoutHours: 12, next: "a1", position: { x: 0, y: 160 } },
    { id: "a1", type: "add_tag", tag: "survey-done", next: "a2", position: { x: 0, y: 240 } },
    { id: "a2", type: "remove_tag", tag: "prospect", next: "a3", position: { x: 0, y: 320 } },
    { id: "a3", type: "assign", userId: "user-1", next: "a4", position: { x: 0, y: 400 } },
    { id: "a4", type: "set_conversation_status", status: "resolved", next: "a5", position: { x: 0, y: 480 } },
    { id: "a5", type: "sequence_subscribe", sequenceId: "seq-9", next: "a6", position: { x: 0, y: 560 } },
    { id: "a6", type: "sequence_unsubscribe", sequenceId: "all", next: null, position: { x: 0, y: 640 } },
  ],
  edges: [
    { id: "e1", source: "t1", target: "s1" },
    { id: "e2", source: "s1", target: "c1" },
    { id: "e3", source: "c1", target: "a1" },
    { id: "e4", source: "a1", target: "a2" },
    { id: "e5", source: "a2", target: "a3" },
    { id: "e6", source: "a3", target: "a4" },
    { id: "e7", source: "a4", target: "a5" },
    { id: "e8", source: "a5", target: "a6" },
  ],
};

describe("flow export envelope", () => {
  test("buildFlowExport stamps kind/version and keeps name/trigger/graph", () => {
    const env = buildFlowExport({ name: "Survey", trigger, graph });
    expect(env.kind).toBe("botara-flow");
    expect(env.version).toBe(1);
    expect(env.name).toBe("Survey");
    expect(env.trigger).toEqual(trigger);
    expect(env.graph).toEqual(graph);
    expect(flowExportFilename("Survey Kota!")).toBe("survey-kota.botara-flow.json");
    expect(flowExportFilename("!!!")).toBe("flow.botara-flow.json");
  });

  test("serialize -> parse round-trips the graph EXACTLY (all node types)", () => {
    const parsed = parseFlowImport(serializeFlowExport({ name: "Survey", trigger, graph }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.name).toBe("Survey");
    expect(parsed.trigger).toEqual(trigger);
    expect(parsed.graph).toEqual(graph);
  });
});

describe("flow import validation", () => {
  const env = (patch: Record<string, unknown>) =>
    JSON.stringify({ kind: "botara-flow", version: 1, name: "X", trigger, graph, ...patch });

  test("rejects non-JSON, wrong kind, wrong version, missing name, bad trigger", () => {
    expect(parseFlowImport("not json")).toEqual({ ok: false, error: "invalid-json" });
    expect(parseFlowImport(env({ kind: "other" }))).toEqual({ ok: false, error: "not-a-flow-file" });
    expect(parseFlowImport(env({ version: 2 }))).toEqual({ ok: false, error: "unsupported-version" });
    expect(parseFlowImport(env({ name: "  " }))).toEqual({ ok: false, error: "missing-name" });
    expect(parseFlowImport(env({ trigger: { type: "webhook", config: {} } }))).toEqual({ ok: false, error: "invalid-trigger" });
    expect(parseFlowImport(env({ trigger: null }))).toEqual({ ok: false, error: "invalid-trigger" });
  });

  test("rejects graphs the server would reject (empty tag, bad variable, unknown type, bad status)", () => {
    // These are exactly the checks storedGraphSchema performs - the
    // same schema POST /flows applies - so import and server agree.
    const badTag = structuredClone(graph);
    (badTag.nodes[3] as { tag: string }).tag = "";
    expect(parseFlowImport(env({ graph: badTag }))).toEqual({ ok: false, error: "invalid-graph" });

    const badVar = structuredClone(graph);
    (badVar.nodes[2] as { variable: string }).variable = "1city";
    expect(parseFlowImport(env({ graph: badVar }))).toEqual({ ok: false, error: "invalid-graph" });

    const unknownType = structuredClone(graph);
    (unknownType.nodes[1] as { type: string }).type = "teleport";
    expect(parseFlowImport(env({ graph: unknownType }))).toEqual({ ok: false, error: "invalid-graph" });

    const badStatus = structuredClone(graph);
    (badStatus.nodes[6] as { status: string }).status = "pending";
    expect(parseFlowImport(env({ graph: badStatus }))).toEqual({ ok: false, error: "invalid-graph" });

    const emptyNodes = { startNodeId: "t1", nodes: [], edges: [] };
    expect(parseFlowImport(env({ graph: emptyNodes }))).toEqual({ ok: false, error: "invalid-graph" });
  });
});
