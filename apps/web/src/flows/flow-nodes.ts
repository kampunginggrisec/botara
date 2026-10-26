import type { RichBlock } from "../api";

/**
 * Flow node model for the builder (pure - no React): the palette's
 * node types, fresh-node defaults, and the one-line node summaries
 * rendered on canvas cards. The persisted node shape is the engine's:
 * config lives in flat fields on the node itself (tag, userId, ...),
 * exactly as the @botara/flow-engine schemas validate on save.
 */

export type EngineNode = Record<string, unknown> & { id: string; type: string };

export const NODE_TYPES = [
  "trigger", "send_message", "condition", "delay", "webhook", "set_field", "ai_reply",
  // Action steps + collect-input (adoption package #3).
  "add_tag", "remove_tag", "assign", "set_conversation_status",
  "sequence_subscribe", "sequence_unsubscribe", "collect_input",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const NODE_ACCENT: Record<NodeType, string> = {
  trigger: "bg-amber-500",
  send_message: "bg-sky-500",
  condition: "bg-violet-500",
  delay: "bg-slate-500",
  webhook: "bg-emerald-500",
  set_field: "bg-teal-500",
  ai_reply: "bg-fuchsia-500",
  add_tag: "bg-lime-500",
  remove_tag: "bg-orange-500",
  assign: "bg-indigo-500",
  set_conversation_status: "bg-rose-500",
  sequence_subscribe: "bg-cyan-500",
  sequence_unsubscribe: "bg-cyan-700",
  collect_input: "bg-yellow-500",
};

let nodeSeq = 0;
export function newNodeId(type: NodeType): string {
  nodeSeq += 1;
  return `${type.slice(0, 4)}_${Date.now().toString(36)}${nodeSeq}`;
}

export function defaultEngineNode(type: NodeType, id: string): EngineNode {
  switch (type) {
    case "trigger":
      return { id, type, trigger: "keyword", config: { flowTriggerType: "keyword", keyword: "", match: "contains" }, next: null };
    case "send_message":
      return { id, type, text: "", next: null };
    case "condition":
      return { id, type, field: "", operator: "equals", value: "", whenTrue: null, whenFalse: null, next: null };
    case "delay":
      return { id, type, seconds: 60, next: null };
    case "webhook":
      return { id, type, url: "https://", method: "POST", next: null };
    case "set_field":
      return { id, type, field: "", value: "", next: null };
    case "ai_reply":
      return { id, type, prompt: "", fallbackText: "", next: null };
    case "add_tag":
      return { id, type, tag: "", next: null };
    case "remove_tag":
      return { id, type, tag: "", next: null };
    case "assign":
      return { id, type, userId: null, next: null };
    case "set_conversation_status":
      return { id, type, status: "resolved", next: null };
    case "sequence_subscribe":
      return { id, type, sequenceId: "", next: null };
    case "sequence_unsubscribe":
      return { id, type, sequenceId: "all", next: null };
    case "collect_input":
      return { id, type, promptText: "", variable: "", next: null };
  }
}

export const str = (node: EngineNode, key: string): string =>
  typeof node[key] === "string" ? (node[key] as string) : "";
export const cfg = (node: EngineNode): Record<string, unknown> =>
  (node.config && typeof node.config === "object" ? (node.config as Record<string, unknown>) : {});
export const cfgStr = (node: EngineNode, key: string): string => {
  const v = cfg(node)[key];
  return typeof v === "string" ? v : "";
};

export function nodeSummary(node: EngineNode): string {
  switch (node.type) {
    case "trigger": {
      const kind = cfgStr(node, "flowTriggerType") || (node.trigger === "keyword" ? "keyword" : "manual");
      if (kind === "keyword") return `"${cfgStr(node, "keyword")}"`;
      if (kind === "comment_keyword") return `comment: "${cfgStr(node, "keyword")}"`;
      if (kind === "postback") return `payload: ${cfgStr(node, "payload")}`;
      return "manual";
    }
    case "send_message": {
      const rich = node.rich as RichBlock | undefined;
      const base = str(node, "text").slice(0, 60) || "...";
      return rich ? `${base} [+${rich.kind}]` : base;
    }
    case "condition": return `${str(node, "field")} ${str(node, "operator")} ${str(node, "value")}`.trim();
    case "delay": return `${String(node.seconds ?? 0)}s`;
    case "webhook": return str(node, "url").slice(0, 40);
    case "set_field": return `${str(node, "field")} = ${str(node, "value")}`;
    case "ai_reply": return str(node, "prompt").slice(0, 50) || "KB-grounded reply";
    case "add_tag": return `+ ${str(node, "tag") || "…"}`;
    case "remove_tag": return `- ${str(node, "tag") || "…"}`;
    case "assign": return str(node, "userId") ? `→ ${str(node, "userId").slice(0, 8)}…` : "unassigned";
    case "set_conversation_status": return str(node, "status") || "resolved";
    case "sequence_subscribe": return str(node, "sequenceId") ? `seq ${str(node, "sequenceId").slice(0, 8)}…` : "…";
    case "sequence_unsubscribe": return str(node, "sequenceId") === "all" ? "all sequences" : `seq ${str(node, "sequenceId").slice(0, 8)}…`;
    case "collect_input": return `? {{vars.${str(node, "variable") || "…"}}}`;
    default: return "";
  }
}
