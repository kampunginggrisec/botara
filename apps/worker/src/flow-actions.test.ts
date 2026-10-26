import { describe, expect, test } from "bun:test";
import type { Flow, FlowState } from "@botara/flow-engine";
import {
  isFlowWaitTimeout, processFlowRun, processFlowWaitTimeout,
  type ClaimedFlowWait, type FlowRunRef, type SendMessageJobData, type WorkerPorts,
} from "./processors";

/**
 * Adoption package #3 at the worker seam: the action-step ports, the
 * collect-input wait scheduling, and the timeout processor's claim
 * discipline (reply vs timeout - exactly one resumer wins).
 */
function fakePorts(overrides: Partial<WorkerPorts> = {}) {
  const sent: SendMessageJobData[] = [];
  const calls: string[] = [];
  const waits: Array<{ state?: FlowState; variable: string; timeoutHours?: number }> = [];
  const runRefs: FlowRunRef[] = [];
  const ports: WorkerPorts = {
    async send() { return { externalMessageId: "m.1", status: "sent" as const }; },
    async writeCost() {},
    async updateMessageStatus() {},
    async incrementBroadcastCounts() {},
    async loadBroadcast() { return null; },
    async listBroadcastTargets() { return []; },
    async enqueueSendMessage(data) { sent.push(data); },
    async setContactField() {},
    async httpFetch() {},
    async scheduleFlowResume() {},
    async addContactTag(_ws, _c, tag) { calls.push(`add:${tag}`); },
    async removeContactTag(_ws, _c, tag) { calls.push(`remove:${tag}`); },
    async assignConversation({ conversationId, userId }) { calls.push(`assign:${conversationId}:${userId ?? "null"}`); return true; },
    async setConversationStatus({ conversationId, status }) { calls.push(`status:${conversationId}:${status}`); },
    async subscribeSequence({ sequenceId }) { calls.push(`sub:${sequenceId}`); return true; },
    async unsubscribeSequence({ sequenceId }) { calls.push(`unsub:${sequenceId}`); },
    async scheduleFlowInputWait(job, wait) {
      waits.push({ state: job.state, variable: wait.variable, timeoutHours: wait.timeoutHours });
    },
    async enqueueFlowRun(ref) { runRefs.push(ref); },
    ...overrides,
  };
  return { ports, sent, calls, waits, runRefs };
}

const ctx = {
  workspaceId: "ws1", channelAccountId: "acc1", channel: "telegram",
  accountExternalId: "bot", contactId: "c1", contactExternalId: "42",
  conversationId: "conv1",
};

const actionFlow: Flow = {
  id: "fa", version: 1, startNodeId: "t1",
  nodes: [
    { id: "t1", type: "trigger", trigger: "manual", config: {}, next: "a1" },
    { id: "a1", type: "add_tag", tag: "vip", next: "a2" },
    { id: "a2", type: "remove_tag", tag: "trial", next: "a3" },
    { id: "a3", type: "assign", userId: "user-9", next: "a4" },
    { id: "a4", type: "sequence_subscribe", sequenceId: "seq-1", next: "a5" },
    { id: "a5", type: "sequence_unsubscribe", sequenceId: "seq-2", next: "a6" },
    { id: "a6", type: "set_conversation_status", status: "resolved", next: "s1" },
    { id: "s1", type: "send_message", text: "done", next: null },
  ],
};

describe("flow action steps (worker ports)", () => {
  test("each step mutates through its port with the run's ids", async () => {
    const f = fakePorts();
    const result = await processFlowRun(f.ports, { flow: actionFlow, event: { type: "manual" }, context: ctx });
    expect(f.calls).toEqual([
      "add:vip", "remove:trial", "assign:conv1:user-9", "sub:seq-1", "unsub:seq-2", "status:conv1:resolved",
    ]);
    expect(result.actionWarnings).toEqual([]);
    expect(f.sent.map((s) => s.text)).toEqual(["done"]);
  });

  test("a non-member assignee (port false) warns; the run completes", async () => {
    const f = fakePorts({ async assignConversation() { return false; } });
    const result = await processFlowRun(f.ports, { flow: actionFlow, event: { type: "manual" }, context: ctx });
    expect(result.actionWarnings).toEqual(["assign user-9: target not found - skipped"]);
    expect(result.state.status).toBe("completed");
  });

  test("a missing sequence (port false) warns; later steps still run", async () => {
    const f = fakePorts({ async subscribeSequence() { return false; } });
    const result = await processFlowRun(f.ports, { flow: actionFlow, event: { type: "manual" }, context: ctx });
    expect(result.actionWarnings).toEqual(["sequence_subscribe seq-1: target not found - skipped"]);
    expect(f.calls).toContain("status:conv1:resolved");
  });

  test("without a conversation id, conversation-scoped steps warn instead of acting", async () => {
    const f = fakePorts();
    const { conversationId: _drop, ...noConv } = ctx;
    const result = await processFlowRun(f.ports, { flow: actionFlow, event: { type: "manual" }, context: noConv });
    expect(f.calls.filter((c) => c.startsWith("assign:"))).toEqual([]);
    expect(f.calls.filter((c) => c.startsWith("status:"))).toEqual([]);
    expect(result.actionWarnings.some((w) => w.startsWith("assign"))).toBe(true);
    expect(result.actionWarnings.some((w) => w.startsWith("set_conversation_status"))).toBe(true);
    // Contact-scoped steps are unaffected.
    expect(f.calls).toContain("add:vip");
  });
});

describe("collect_input at the worker seam", () => {
  const collectFlow: Flow = {
    id: "survey", version: 1, startNodeId: "t1",
    nodes: [
      { id: "t1", type: "trigger", trigger: "message.received", config: {}, next: "c1" },
      { id: "c1", type: "collect_input", promptText: "Kota apa?", variable: "city", timeoutHours: 12, next: "s1" },
      { id: "s1", type: "send_message", text: "Kamu dari {{vars.city}}", next: null },
    ],
  };

  test("the prompt is sent and the wait is scheduled with the resume state", async () => {
    const f = fakePorts();
    const result = await processFlowRun(f.ports, {
      flow: collectFlow, event: { type: "message.received", text: "halo" }, context: ctx,
    });
    expect(result.paused).toBe(true);
    expect(f.sent.map((s) => s.text)).toEqual(["Kota apa?"]);
    expect(f.waits).toHaveLength(1);
    expect(f.waits[0]!.variable).toBe("city");
    expect(f.waits[0]!.timeoutHours).toBe(12);
    expect(f.waits[0]!.state?.currentNodeId).toBe("s1");
    expect(f.waits[0]!.state?.status).toBe("waiting");
  });

  test("a resumed run (state + captured variable) sends the follow-up", async () => {
    const f = fakePorts();
    const resumeState: FlowState = {
      flowId: "survey", currentNodeId: "s1", variables: {}, status: "waiting",
    };
    const result = await processFlowRun(f.ports, {
      flow: collectFlow, state: resumeState,
      event: { type: "message.received", text: "Jakarta", variables: { city: "Jakarta" } },
      context: ctx,
    });
    expect(result.state.status).toBe("completed");
    expect(f.sent.map((s) => s.text)).toEqual(["Kamu dari Jakarta"]);
  });
});

describe("collect_input timeout processor", () => {
  const waitRow: ClaimedFlowWait = {
    id: "wait-1", workspaceId: "ws1", conversationId: "conv1", contactId: "c1",
    channelAccountId: "acc1", flowId: "survey", variable: "city",
    resumeState: { flowId: "survey", currentNodeId: "s1", variables: {}, status: "waiting" },
  };

  /** A claim-once fake: the first claimant (either side) wins the row. */
  function claimOnce() {
    let claimed = false;
    return async () => {
      if (claimed) return null;
      claimed = true;
      return waitRow;
    };
  }

  test("timeout claims the wait and resumes with an empty value", async () => {
    const f = fakePorts({
      async claimFlowWaitById() { return waitRow; },
      async getConversationStatus() { return "open"; },
    });
    const result = await processFlowWaitTimeout(f.ports, "wait-1");
    expect(result).toEqual({ resumed: true });
    expect(f.runRefs).toHaveLength(1);
    expect(f.runRefs[0]).toMatchObject({
      flowId: "survey", conversationId: "conv1",
      resumeVariables: { city: "" },
    });
    expect(f.runRefs[0]!.resumeState?.currentNodeId).toBe("s1");
  });

  test("the reply won the race: timeout is a no-op", async () => {
    const claim = claimOnce();
    await claim(); // the dispatcher claimed it first (its own claim call)
    const f = fakePorts({
      claimFlowWaitById: claim,
      async getConversationStatus() { return "open"; },
    });
    const result = await processFlowWaitTimeout(f.ports, "wait-1");
    expect(result).toEqual({ resumed: false, reason: "already-claimed" });
    expect(f.runRefs).toEqual([]);
  });

  test("the timeout won the race: a second timeout fire is a no-op", async () => {
    const claim = claimOnce();
    const f = fakePorts({
      claimFlowWaitById: claim,
      async getConversationStatus() { return "open"; },
    });
    const first = await processFlowWaitTimeout(f.ports, "wait-1");
    const second = await processFlowWaitTimeout(f.ports, "wait-1");
    expect(first.resumed).toBe(true);
    expect(second).toEqual({ resumed: false, reason: "already-claimed" });
    expect(f.runRefs).toHaveLength(1);
  });

  test("conversation resolved while waiting: the run ends quietly", async () => {
    const f = fakePorts({
      async claimFlowWaitById() { return waitRow; },
      async getConversationStatus() { return "resolved"; },
    });
    const result = await processFlowWaitTimeout(f.ports, "wait-1");
    expect(result).toEqual({ resumed: false, reason: "conversation-resolved" });
    expect(f.runRefs).toEqual([]);
  });

  test("timeout marker detection", () => {
    expect(isFlowWaitTimeout({ flowWaitTimeoutId: "w1" })).toBe(true);
    expect(isFlowWaitTimeout({ flowId: "f1" })).toBe(false);
    expect(isFlowWaitTimeout(null)).toBe(false);
  });
});
