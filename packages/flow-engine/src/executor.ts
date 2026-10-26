import { interpolateRichBlock, type RichBlock } from "@botara/channels";
import { interpolate, type InterpolationWarning, type VariableContext } from "@botara/shared";
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
  // Action steps (adoption package #3). All OPTIONAL: a runtime that
  // does not wire one records the action in `executed` with an
  // actionWarning instead of performing it - the run never crashes on
  // a missing or failing action port. Boolean ports report a soft
  // failure (target missing) as `false`, which also becomes a warning.
  addTag?(input: { tag: string }): Promise<void>;
  removeTag?(input: { tag: string }): Promise<void>;
  /** False = the user is not assignable (not a workspace member). */
  assignConversation?(input: { userId: string | null }): Promise<boolean>;
  setConversationStatus?(input: { status: "resolved" | "open" }): Promise<void>;
  /** False = the sequence does not exist or cannot take enrollments. */
  subscribeSequence?(input: { sequenceId: string }): Promise<boolean>;
  unsubscribeSequence?(input: { sequenceId: string }): Promise<void>;
  /**
   * Persist a collect-input wait for `resumeState` (already advanced
   * past the collect node, status "waiting"): the runtime stores the
   * marker (node, conversation/contact, variable, deadline) so an
   * inbound reply - or the timeout - can claim it and resume the run.
   */
  awaitInput?(input: {
    nodeId: string | null;
    variable: string;
    saveToContactField?: string;
    timeoutHours?: number;
    resumeState: FlowState;
  }): Promise<void>;
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
  /**
   * Variable-interpolation warnings collected while rendering
   * send_message texts (unknown variables rendered empty). Empty when
   * every template resolved - or when no interpolation context ran.
   */
  warnings: InterpolationWarning[];
  /**
   * Action-step warnings (adoption package #3): an action whose port
   * is unwired in this runtime, reported a missing target (sequence /
   * assignee), or threw. Actions NEVER crash a run - the failure is
   * recorded here and execution continues at the next node.
   */
  actionWarnings: string[];
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
 *
 * Variable interpolation (variables package #1): when the caller passes
 * `options.interpolation` (contact / workspace / channel context), every
 * send_message text and rich block is rendered through the shared
 * @botara/shared engine at the moment of the send, with the run's own
 * variables merged in as the `vars` root (run values win over any the
 * caller pre-seeded). AI-generated reply text is NEVER interpolated (it
 * is generated content, sent verbatim); the ai_reply node's configured
 * fallbackText IS rendered like any authored text. Without a context,
 * texts pass through untouched - the interpreter's legacy flat
 * `{{key}}` substitution against run variables still applies either way.
 */
export async function runFlow(
  ports: FlowPorts,
  flow: Flow,
  state: FlowState | undefined,
  event: FlowEvent,
  options: { maxSteps?: number; interpolation?: VariableContext } = {},
): Promise<FlowRunResult> {
  const maxSteps = options.maxSteps ?? 50;
  const isFreshRun = state === undefined;
  let current: FlowState = state ?? initialState(flow);
  const executed: FlowAction[] = [];
  const warnings: InterpolationWarning[] = [];
  const actionWarnings: string[] = [];

  /** Render one authored send text (+ optional rich block) for this step. */
  const renderSend = (
    text: string,
    rich: RichBlock | undefined,
    runVars: Record<string, string>,
  ): { text: string; rich?: RichBlock } => {
    if (!options.interpolation) return { text, rich };
    const ctx: VariableContext = {
      ...options.interpolation,
      vars: { ...(options.interpolation.vars ?? {}), ...runVars },
    };
    const renderedText = interpolate(text, ctx);
    warnings.push(...renderedText.warnings);
    if (!rich) return { text: renderedText.text };
    const renderedRich = interpolateRichBlock(rich, ctx);
    warnings.push(...renderedRich.warnings);
    return { text: renderedText.text, rich: renderedRich.block };
  };

  if (isFreshRun && !triggerMatches(flow, current, event)) {
    // Keyword trigger did not match: the run ends before any action.
    return { state: { ...current, status: "completed", currentNodeId: null }, executed, paused: false, warnings, actionWarnings };
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

  /**
   * Run one action-step port under the action discipline: unwired port,
   * soft-false report, or a throw all become an actionWarning and the
   * run continues. The action itself is recorded by the caller either
   * way (in dry-run runtimes the record IS the effect).
   */
  const runActionPort = async (
    label: string,
    port: (() => Promise<boolean | void>) | undefined,
  ): Promise<void> => {
    if (!port) {
      actionWarnings.push(`${label}: not supported by this runtime (recorded only)`);
      return;
    }
    try {
      const ok = await port();
      if (ok === false) actionWarnings.push(`${label}: target not found - skipped`);
    } catch (err) {
      actionWarnings.push(`${label}: failed (${err instanceof Error ? err.message : String(err)})`);
    }
  };

  for (let i = 0; i < maxSteps; i++) {
    if (current.status === "completed" || !current.currentNodeId) {
      return { state: current, executed, paused: false, warnings, actionWarnings };
    }
    const stepNodeId = current.currentNodeId;
    const { state: next, actions } = step(flow, current, enrichedEvent);
    current = next;
    for (const action of actions) {
      switch (action.type) {
        case "send_message": {
          const rendered = renderSend(action.text, action.rich, current.variables);
          await ports.sendMessage({ text: rendered.text, channel: action.channel, rich: rendered.rich });
          executed.push({
            type: "send_message",
            text: rendered.text,
            channel: action.channel,
            ...(rendered.rich ? { rich: rendered.rich } : {}),
          });
          break;
        }
        case "ai_reply": {
          const generated = ports.aiReply
            ? await ports.aiReply({ prompt: action.prompt, query: action.query })
            : null;
          if (generated !== null && generated !== undefined) {
            // Generated text is sent verbatim - never interpolated.
            await ports.sendMessage({ text: generated, channel: action.channel });
            executed.push({ type: "send_message", text: generated, channel: action.channel });
          } else {
            const rendered = renderSend(action.fallbackText, undefined, current.variables);
            await ports.sendMessage({ text: rendered.text, channel: action.channel });
            executed.push({ type: "send_message", text: rendered.text, channel: action.channel });
          }
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
          return { state: current, executed, paused: true, warnings, actionWarnings };
        case "add_tag":
          await runActionPort(`add_tag "${action.tag}"`, ports.addTag && (() => ports.addTag!({ tag: action.tag })));
          executed.push(action);
          break;
        case "remove_tag":
          await runActionPort(`remove_tag "${action.tag}"`, ports.removeTag && (() => ports.removeTag!({ tag: action.tag })));
          executed.push(action);
          break;
        case "assign_conversation":
          await runActionPort(
            `assign ${action.userId ?? "(unassign)"}`,
            ports.assignConversation && (() => ports.assignConversation!({ userId: action.userId })),
          );
          executed.push(action);
          break;
        case "set_conversation_status":
          await runActionPort(
            `set_conversation_status ${action.status}`,
            ports.setConversationStatus && (() => ports.setConversationStatus!({ status: action.status })),
          );
          executed.push(action);
          break;
        case "sequence_subscribe":
          await runActionPort(
            `sequence_subscribe ${action.sequenceId}`,
            ports.subscribeSequence && (() => ports.subscribeSequence!({ sequenceId: action.sequenceId })),
          );
          executed.push(action);
          break;
        case "sequence_unsubscribe":
          await runActionPort(
            `sequence_unsubscribe ${action.sequenceId}`,
            ports.unsubscribeSequence && (() => ports.unsubscribeSequence!({ sequenceId: action.sequenceId })),
          );
          executed.push(action);
          break;
        case "collect_input": {
          // Send the (rendered) prompt, then hand the resume state to
          // the wait port and pause - the mirror image of delay, except
          // the resume is claimed by an inbound reply or the timeout.
          const rendered = renderSend(action.promptText, undefined, current.variables);
          await ports.sendMessage({ text: rendered.text });
          executed.push({ type: "send_message", text: rendered.text });
          await runActionPort(
            `collect_input "${action.variable}"`,
            ports.awaitInput && (() => ports.awaitInput!({
              nodeId: stepNodeId,
              variable: action.variable,
              saveToContactField: action.saveToContactField,
              timeoutHours: action.timeoutHours,
              resumeState: current,
            })),
          );
          executed.push({
            type: "collect_input",
            promptText: rendered.text,
            variable: action.variable,
            ...(action.saveToContactField ? { saveToContactField: action.saveToContactField } : {}),
            ...(action.timeoutHours !== undefined ? { timeoutHours: action.timeoutHours } : {}),
          });
          return { state: current, executed, paused: true, warnings, actionWarnings };
        }
        case "complete":
          break;
      }
    }
  }
  // Step guard hit: return the state as-is so the caller can resume later
  // instead of looping forever on a malformed (cyclic) flow.
  return { state: current, executed, paused: current.status === "waiting", warnings, actionWarnings };
}
