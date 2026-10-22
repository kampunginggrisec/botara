import type { RichBlock } from "@botara/channels";
import type { Flow, FlowNode } from "./schemas";

/**
 * Pure, deterministic interpreter stub: (state, event) -> actions.
 * No I/O, no clocks, no randomness - the same inputs always produce the same
 * actions, which is what makes flows testable and replayable. The worker
 * executes the returned actions; the interpreter only decides.
 */
export interface FlowState {
  flowId: string;
  currentNodeId: string | null;
  variables: Record<string, string>;
  status: "running" | "waiting" | "completed";
}

export interface FlowEvent {
  type: string;
  text?: string;
  variables?: Record<string, string>;
}

export type FlowAction =
  | { type: "send_message"; text: string; channel?: string; rich?: RichBlock }
  | { type: "ai_reply"; prompt: string; fallbackText: string; query: string; channel?: string }
  | { type: "schedule_delay"; seconds: number }
  | { type: "call_webhook"; url: string; method: "GET" | "POST" }
  | { type: "set_contact_field"; field: string; value: string }
  | { type: "complete" };

export function initialState(flow: Flow): FlowState {
  return { flowId: flow.id, currentNodeId: flow.startNodeId, variables: {}, status: "running" };
}

export function step(flow: Flow, state: FlowState, event: FlowEvent): { state: FlowState; actions: FlowAction[] } {
  if (state.status === "completed" || !state.currentNodeId) {
    return { state, actions: [{ type: "complete" }] };
  }
  const node: FlowNode | undefined = flow.nodes.find((n) => n.id === state.currentNodeId);
  if (!node) return { state: { ...state, status: "completed", currentNodeId: null }, actions: [{ type: "complete" }] };

  const variables = { ...state.variables, ...(event.variables ?? {}) };
  const advance = (next: string | null, status: FlowState["status"] = next ? "running" as const : "completed" as const): FlowState =>
    ({ ...state, variables, currentNodeId: next, status });

  switch (node.type) {
    case "trigger":
      return { state: advance(node.next), actions: [] };
    case "send_message": {
      const text = node.text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => variables[k] ?? "");
      return {
        state: advance(node.next),
        actions: [{ type: "send_message", text, channel: node.channel, ...(node.rich ? { rich: node.rich } : {}) }],
      };
    }
    case "condition": {
      const actual = variables[node.field];
      const matched =
        node.operator === "exists" ? actual !== undefined :
        node.operator === "equals" ? actual === node.value :
        actual !== undefined && node.value !== undefined && actual.includes(node.value);
      return { state: advance(matched ? node.whenTrue : node.whenFalse), actions: [] };
    }
    case "delay":
      return { state: { ...advance(node.next), status: "waiting" }, actions: [{ type: "schedule_delay", seconds: node.seconds }] };
    case "webhook":
      return { state: advance(node.next), actions: [{ type: "call_webhook", url: node.url, method: node.method }] };
    case "set_field": {
      const value = node.value.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => variables[k] ?? "");
      return {
        state: advance(node.next),
        actions: [{ type: "set_contact_field", field: node.field, value }],
      };
    }
    case "ai_reply": {
      // The interpreter stays pure: it emits an ai_reply action carrying
      // the (interpolated) instruction + the user's message as the
      // retrieval query. The executor resolves it through its aiReply port
      // (KB retrieval + AI chat) and falls back to fallbackText.
      const prompt = node.prompt.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => variables[k] ?? "");
      const query = event.text ?? variables.messageText ?? "";
      return {
        state: advance(node.next),
        actions: [{ type: "ai_reply", prompt, fallbackText: node.fallbackText, query, channel: node.channel }],
      };
    }
  }
}
