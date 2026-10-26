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
  /**
   * Runtime bookkeeping: how many outbound sends this run has already
   * performed across ALL its segments. Effectful runtimes (the worker)
   * build send idempotency keys from this count and stamp it into every
   * pause snapshot (delay / collect-input), so a resumed segment
   * continues the sequence instead of restarting at 0 - a restarted
   * count would reuse an earlier segment's keys and the send pipeline
   * would dedupe the resumed run's sends away. The interpreter never
   * reads or writes it; every transition spreads state, so the value
   * simply rides along. Absent = no sends yet.
   */
  sendSeq?: number;
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
  // Action steps (adoption package #3): world mutations, pass-through.
  | { type: "add_tag"; tag: string }
  | { type: "remove_tag"; tag: string }
  | { type: "assign_conversation"; userId: string | null }
  | { type: "set_conversation_status"; status: "resolved" | "open" }
  | { type: "sequence_subscribe"; sequenceId: string }
  | { type: "sequence_unsubscribe"; sequenceId: string }
  /**
   * Pause-and-listen: the executor sends `promptText`, persists a wait
   * via its awaitInput port, and the run resumes when the contact's
   * next reply (or the timeout) claims the wait - the answer enters
   * the run through the resume event's variables under `variable`.
   */
  | {
      type: "collect_input";
      promptText: string;
      variable: string;
      saveToContactField?: string;
      timeoutHours?: number;
    }
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
    case "add_tag":
      return { state: advance(node.next), actions: [{ type: "add_tag", tag: node.tag }] };
    case "remove_tag":
      return { state: advance(node.next), actions: [{ type: "remove_tag", tag: node.tag }] };
    case "assign":
      return { state: advance(node.next), actions: [{ type: "assign_conversation", userId: node.userId }] };
    case "set_conversation_status":
      return { state: advance(node.next), actions: [{ type: "set_conversation_status", status: node.status }] };
    case "sequence_subscribe":
      return { state: advance(node.next), actions: [{ type: "sequence_subscribe", sequenceId: node.sequenceId }] };
    case "sequence_unsubscribe":
      return { state: advance(node.next), actions: [{ type: "sequence_unsubscribe", sequenceId: node.sequenceId }] };
    case "collect_input": {
      // Same pause shape as delay: the state is already advanced past
      // this node (status "waiting"); the resume event carries the
      // captured answer in its variables, merged by the step() preamble.
      const promptText = node.promptText.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => variables[k] ?? "");
      return {
        state: { ...advance(node.next), status: "waiting" },
        actions: [{
          type: "collect_input",
          promptText,
          variable: node.variable,
          ...(node.saveToContactField ? { saveToContactField: node.saveToContactField } : {}),
          ...(node.timeoutHours !== undefined ? { timeoutHours: node.timeoutHours } : {}),
        }],
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
