import type { RichBlock } from "@botara/channels";
import type { Flow } from "./schemas";
import { initialState, step, type FlowAction, type FlowEvent, type FlowState } from "./interpreter";

/**
 * Flow execution core (Fase 1).
 *
 * The interpreter (interpreter.ts) stays pure: (state, event) -> actions.
 * This executor is the thin effectful shell around it: it walks the
 * interpreter step by step and performs each action through INJECTED PORTS,
 * so the worker can back ports with queues/DB while tests use in-memory
 * fakes. No clocks, no randomness - given the same ports behaviour, runs are
 * deterministic and replayable.
 *
 * Delay nodes PAUSE the run: the executor hands the resume state to the
 * scheduleDelay port and returns with status "waiting". The caller persists
 * that state and later calls runFlow again with it to resume.
 */
export interface FlowPorts {
  sendMessage(input: { text: string; channel?: string; rich?: RichBlock }): Promise<void>;
  /** Persist/schedule a resume of `resumeState` after `seconds`. */
  scheduleDelay(input: { seconds: number; resumeState: FlowState }): Promise<void>;
  httpWebhook(input: { url: string; method: "GET" | "POST" }): Promise<void>;
  setContactField(input: { field: string; value: string }): Promise<void>;
  /**
   * AI reply port (Fase 3): KB retrieval + AI generation for ai_reply
   * nodes. Return the reply text, or null when AI is unconfigured / the KB
   * has nothing relevant - the executor then sends the node's configured
   * fallbackText instead, so a flow never dead-ends on AI availability.
   */
  aiReply?(input: { prompt: string; query: string }): Promise<string | null>;
}

export interface FlowRunResult {
  state: FlowState;
  /** Actions actually performed through the ports, in order. */
  executed: FlowAction[];
  /** True when the run paused at a delay node and must be resumed later. */
  paused: boolean;
}

/**
 * Keyword gate for trigger nodes: a `keyword` trigger only starts the flow
 * when the incoming message text contains the configured keyword
 * (flow trigger node config: { keyword: "..." }, case-insensitive).
 * Other trigger types always pass.
 */
export function triggerMatches(flow: Flow, state: FlowState, event: FlowEvent): boolean {
  const node = flow.nodes.find((n) => n.id === state.currentNodeId);
  if (!node || node.type !== "trigger" || node.trigger !== "keyword") return true;
  const keyword = typeof node.config?.keyword === "string" ? node.config.keyword : "";
  if (!keyword) return true;
  return (event.text ?? "").toLowerCase().includes(keyword.toLowerCase());
}

/**
 * Run one batch of steps until the flow completes, pauses at a delay node,
 * or hits the step guard. The incoming event's text is exposed to condition
 * nodes as the `messageText` variable, and event variables (e.g. contact
 * fields loaded by the caller) are merged into the run state, so conditions
 * can branch on message keywords AND contact fields.
 */
export async function runFlow(
  ports: FlowPorts,
  flow: Flow,
  state: FlowState | undefined,
  event: FlowEvent,
  options: { maxSteps?: number } = {},
): Promise<FlowRunResult> {
  const maxSteps = options.maxSteps ?? 50;
  const isFreshRun = state === undefined;
  let current: FlowState = state ?? initialState(flow);
  const executed: FlowAction[] = [];

  if (isFreshRun && !triggerMatches(flow, current, event)) {
    // Keyword trigger did not match: the run ends before any action.
    return { state: { ...current, status: "completed", currentNodeId: null }, executed, paused: false };
  }
  if (state && state.status === "waiting") {
    // Resuming after a delay: the interpreter already advanced past the
    // delay node when it paused, so we simply continue as running.
    current = { ...current, status: "running" };
  }

  const enrichedEvent: FlowEvent = {
    ...event,
    variables: { messageText: event.text ?? "", ...(event.variables ?? {}) },
  };

  for (let i = 0; i < maxSteps; i++) {
    if (current.status === "completed" || !current.currentNodeId) {
      return { state: current, executed, paused: false };
    }
    const { state: next, actions } = step(flow, current, enrichedEvent);
    current = next;
    for (const action of actions) {
      switch (action.type) {
        case "send_message":
          await ports.sendMessage({ text: action.text, channel: action.channel, rich: action.rich });
          executed.push(action);
          break;
        case "ai_reply": {
          const generated = ports.aiReply
            ? await ports.aiReply({ prompt: action.prompt, query: action.query })
            : null;
          const text = generated ?? action.fallbackText;
          await ports.sendMessage({ text, channel: action.channel });
          executed.push({ type: "send_message", text, channel: action.channel });
          break;
        }
        case "call_webhook":
          await ports.httpWebhook({ url: action.url, method: action.method });
          executed.push(action);
          break;
        case "set_contact_field":
          await ports.setContactField({ field: action.field, value: action.value });
          executed.push(action);
          break;
        case "schedule_delay":
          await ports.scheduleDelay({ seconds: action.seconds, resumeState: current });
          executed.push(action);
          return { state: current, executed, paused: true };
        case "complete":
          break;
      }
    }
  }
  // Step guard hit: return the state as-is so the caller can resume later
  // instead of looping forever on a malformed (cyclic) flow.
  return { state: current, executed, paused: current.status === "waiting" };
}
