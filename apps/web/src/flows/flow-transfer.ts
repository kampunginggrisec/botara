// Subpath import on purpose: the flow-engine root re-exports the
// executor, which pulls node:crypto channel adapters - the graph
// module (schemas only) is browser-safe.
import { storedGraphSchema } from "@botara/flow-engine/graph";
import type { FlowGraph, FlowTrigger } from "../api";

/**
 * Flow export/import (adoption package #3).
 *
 * Export wraps a flow in a small versioned envelope; import validates
 * the envelope AND the graph before anything is created. Graph
 * validation uses the engine's own `storedGraphSchema` - the exact
 * validator the API applies on POST /flows - so a file that parses
 * here is a file the server accepts, and the create itself rides the
 * existing POST /flows endpoint (a NEW draft; imports never
 * overwrite). Round-trip property: export -> import stores a graph
 * deep-equal to the exported one.
 */

export interface FlowExportEnvelope {
  kind: "botara-flow";
  version: 1;
  name: string;
  trigger: FlowTrigger;
  graph: FlowGraph;
}

export function buildFlowExport(flow: { name: string; trigger: FlowTrigger; graph: FlowGraph }): FlowExportEnvelope {
  return { kind: "botara-flow", version: 1, name: flow.name, trigger: flow.trigger, graph: flow.graph };
}

export function serializeFlowExport(flow: { name: string; trigger: FlowTrigger; graph: FlowGraph }): string {
  return JSON.stringify(buildFlowExport(flow), null, 2);
}

/** Suggested download filename for a flow export. */
export function flowExportFilename(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug || "flow"}.botara-flow.json`;
}

export type FlowImportResult =
  | { ok: true; name: string; trigger: FlowTrigger; graph: FlowGraph }
  | { ok: false; error: string };

const TRIGGER_TYPES = ["keyword", "postback", "manual", "comment_keyword"] as const;

/**
 * Parse + validate an imported file's text. Errors are stable machine
 * codes (the UI maps them to localized messages): "invalid-json",
 * "not-a-flow-file", "unsupported-version", "missing-name",
 * "invalid-trigger", "invalid-graph".
 */
export function parseFlowImport(text: string): FlowImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid-json" };
  }
  if (!raw || typeof raw !== "object") return { ok: false, error: "not-a-flow-file" };
  const env = raw as Record<string, unknown>;
  if (env.kind !== "botara-flow") return { ok: false, error: "not-a-flow-file" };
  if (env.version !== 1) return { ok: false, error: "unsupported-version" };
  if (typeof env.name !== "string" || env.name.trim() === "") {
    return { ok: false, error: "missing-name" };
  }
  const trigger = env.trigger as FlowTrigger | undefined;
  if (
    !trigger || typeof trigger !== "object" ||
    !(TRIGGER_TYPES as readonly string[]).includes(trigger.type) ||
    !trigger.config || typeof trigger.config !== "object"
  ) {
    return { ok: false, error: "invalid-trigger" };
  }
  const graph = storedGraphSchema.safeParse(env.graph);
  if (!graph.success) return { ok: false, error: "invalid-graph" };
  return {
    ok: true,
    name: env.name.trim(),
    trigger: { type: trigger.type, config: trigger.config as Record<string, unknown> },
    graph: graph.data as FlowGraph,
  };
}

/** Trigger a browser download of a flow export (list/builder share). */
export function downloadFlowExport(flow: { name: string; trigger: FlowTrigger; graph: FlowGraph }): void {
  const blob = new Blob([serializeFlowExport(flow)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = flowExportFilename(flow.name);
  a.click();
  URL.revokeObjectURL(url);
}
