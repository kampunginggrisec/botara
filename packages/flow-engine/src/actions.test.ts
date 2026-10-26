import { describe, expect, test } from "bun:test";
import { buildVariableContext } from "@botara/shared";
import { runFlow, type FlowPorts } from "./executor";
import { flowSchema, type Flow } from "./schemas";
import type { FlowState } from "./interpreter";

/**
 * Adoption package #3: action steps + collect_input.
 *
 * The fakes below mirror the two production runtimes: "live" ports
 * record every mutation (the worker), "dry-run" ports are no-ops whose
 * only observable effect is the executor's executed list (the API
 * test-run) - the SAME flow must produce the SAME executed list in
 * both, with mutations happening only in the live one.
 */
function fakePorts() {
  const sent: Array<{ text: string; channel?: string }> = [];
  const calls: string[] = [];
  const waits: Array<{
    nodeId: string | null; variable: string; saveToContactField?: string;
    timeoutHours?: number; resumeState: FlowState;
  }> = [];
  const ports: FlowPorts = {
    async sendMessage(input) { sent.push(input); },
    async scheduleDelay() {},
    async httpWebhook() {},
    async setContactField() {},
    async addTag({ tag }) { calls.push(`add_tag:${tag}`); },
    async removeTag({ tag }) { calls.push(`remove_tag:${tag}`); },
    async assignConversation({ userId }) { calls.push(`assign:${userId ?? "null"}`); return true; },
    async setConversationStatus({ status }) { calls.push(`status:${status}`); },
    async subscribeSequence({ sequenceId }) { calls.push(`sub:${sequenceId}`); return true; },
    async unsubscribeSequence({ sequenceId }) { calls.push(`unsub:${sequenceId}`); },
    async awaitInput(input) { waits.push(input); },
  };
  return { ports, sent, calls, waits };
}

const actionFlow: Flow = {
  id: "actions",
  version: 1,
  startNodeId: "t1",
  nodes: [
    { id: "t1", type: "trigger", trigger: "manual", config: {}, next: "a1" },
    { id: "a1", type: "add_tag", tag: "vip", next: "a2" },
    { id: "a2", type: "remove_tag", tag: "trial", next: "a3" },
    { id: "a3", type: "assign", userId: "user-9", next: "a4" },
    { id: "a4", type: "sequence_subscribe", sequenceId: "seq-1", next: "a5" },
    { id: "a5", type: "sequence_unsubscribe", sequenceId: "all", next: "a6" },
    { id: "a6", type: "set_conversation_status", status: "resolved", next: "s1" },
    { id: "s1", type: "send_message", text: "Selesai!", next: null },
  ],
};

describe("action step schemas", () => {
  test("all new node types parse inside a flow", () => {
    const parsed = flowSchema.parse(actionFlow);
    expect(parsed.nodes.map((n) => n.type)).toEqual([
      "trigger", "add_tag", "remove_tag", "assign",
      "sequence_subscribe", "sequence_unsubscribe", "set_conversation_status", "send_message",
    ]);
    const withCollect: Flow = {
      id: "c", version: 1, startNodeId: "t1",
      nodes: [
        { id: "t1", type: "trigger", trigger: "manual", config: {}, next: "c1" },
        { id: "c1", type: "collect_input", promptText: "Kota?", variable: "city", saveToContactField: "city", timeoutHours: 24, next: null },
      ],
    };
    expect(flowSchema.parse(withCollect).nodes[1]!.type).toBe("collect_input");
  });

  test("invalid shapes are rejected", () => {
    const bad = (node: unknown) => () =>
      flowSchema.parse({ id: "x", version: 1, startNodeId: "n", nodes: [node] });
    expect(bad({ id: "n", type: "add_tag", tag: "", next: null })).toThrow();
    expect(bad({ id: "n", type: "set_conversation_status", status: "pending", next: null })).toThrow();
    expect(bad({ id: "n", type: "sequence_subscribe", sequenceId: 42, next: null })).toThrow();
    expect(bad({ id: "n", type: "collect_input", promptText: "Kota?", variable: "not a var!", next: null })).toThrow();
    expect(bad({ id: "n", type: "collect_input", promptText: "", variable: "city", next: null })).toThrow();
    expect(bad({ id: "n", type: "collect_input", promptText: "Kota?", variable: "city", timeoutHours: -1, next: null })).toThrow();
    expect(bad({ id: "n", type: "assign", userId: "", next: null })).toThrow();
  });
});

describe("action steps through the executor", () => {
  test("every action mutates via its port, in order, then the flow continues", async () => {
    const f = fakePorts();
    const result = await runFlow(f.ports, actionFlow, undefined, { type: "manual" });
    expect(f.calls).toEqual([
      "add_tag:vip", "remove_tag:trial", "assign:user-9", "sub:seq-1", "unsub:all", "status:resolved",
    ]);
    expect(f.sent.map((s) => s.text)).toEqual(["Selesai!"]);
    expect(result.state.status).toBe("completed");
    expect(result.actionWarnings).toEqual([]);
    expect(result.executed.map((a) => a.type)).toEqual([
      "add_tag", "remove_tag", "assign_conversation", "sequence_subscribe",
      "sequence_unsubscribe", "set_conversation_status", "send_message",
    ]);
  });

  test("unassign (userId null) reaches the port as null", async () => {
    const flow: Flow = {
      id: "un", version: 1, startNodeId: "t1",
      nodes: [
        { id: "t1", type: "trigger", trigger: "manual", config: {}, next: "a1" },
        { id: "a1", type: "assign", userId: null, next: null },
      ],
    };
    const f = fakePorts();
    await runFlow(f.ports, flow, undefined, { type: "manual" });
    expect(f.calls).toEqual(["assign:null"]);
  });

  test("dry-run ports (no-ops) record the same executed list without effects", async () => {
    const recorded: string[] = [];
    const dryPorts: FlowPorts = {
      async sendMessage() {},
      async scheduleDelay() {},
      async httpWebhook() {},
      async setContactField() {},
      async addTag() { /* recorded via executed */ },
      async removeTag() {},
      async assignConversation() { return true; },
      async setConversationStatus() {},
      async subscribeSequence() { return true; },
      async unsubscribeSequence() {},
      async awaitInput() {},
    };
    const result = await runFlow(dryPorts, actionFlow, undefined, { type: "manual" });
    expect(recorded).toEqual([]);
    expect(result.executed.map((a) => a.type)).toEqual([
      "add_tag", "remove_tag", "assign_conversation", "sequence_subscribe",
      "sequence_unsubscribe", "set_conversation_status", "send_message",
    ]);
    expect(result.actionWarnings).toEqual([]);
  });

  test("a missing sequence (port reports false) warns and the run continues", async () => {
    const f = fakePorts();
    f.ports.subscribeSequence = async () => false;
    const result = await runFlow(f.ports, actionFlow, undefined, { type: "manual" });
    expect(result.actionWarnings).toEqual(["sequence_subscribe seq-1: target not found - skipped"]);
    expect(result.state.status).toBe("completed");
    expect(f.sent.map((s) => s.text)).toEqual(["Selesai!"]);
  });

  test("a throwing port warns and never crashes the run", async () => {
    const f = fakePorts();
    f.ports.addTag = async () => { throw new Error("db down"); };
    const result = await runFlow(f.ports, actionFlow, undefined, { type: "manual" });
    expect(result.actionWarnings[0]).toContain('add_tag "vip": failed (db down)');
    expect(result.state.status).toBe("completed");
  });

  test("unwired ports record the action with a warning, never crash", async () => {
    const bare: FlowPorts = {
      async sendMessage() {},
      async scheduleDelay() {},
      async httpWebhook() {},
      async setContactField() {},
    };
    const result = await runFlow(bare, actionFlow, undefined, { type: "manual" });
    expect(result.executed.map((a) => a.type)).toContain("add_tag");
    expect(result.actionWarnings.length).toBe(6);
    expect(result.actionWarnings[0]).toContain("recorded only");
    expect(result.state.status).toBe("completed");
  });
});

describe("collect_input", () => {
  const collectFlow: Flow = {
    id: "survey",
    version: 1,
    startNodeId: "t1",
    nodes: [
      { id: "t1", type: "trigger", trigger: "message.received", config: {}, next: "c1" },
      {
        id: "c1", type: "collect_input",
        promptText: "Halo {{contact.name}}, kamu tinggal di kota apa?",
        variable: "city", saveToContactField: "city", timeoutHours: 48,
        next: "s1",
      },
      { id: "s1", type: "send_message", text: "Kamu dari {{vars.city}} ya!", next: null },
    ],
  };
  const interpCtx = buildVariableContext({
    contact: { displayName: "Dewi", externalId: "628777", channel: "telegram" },
  });

  test("the prompt is sent (interpolated), the run pauses, and the wait carries the resume state", async () => {
    const f = fakePorts();
    const result = await runFlow(f.ports, collectFlow, undefined, { type: "message.received", text: "halo" }, { interpolation: interpCtx });
    expect(f.sent).toEqual([{ text: "Halo Dewi, kamu tinggal di kota apa?", channel: undefined }]);
    expect(result.paused).toBe(true);
    expect(result.state.status).toBe("waiting");
    expect(result.state.currentNodeId).toBe("s1");
    expect(f.waits).toHaveLength(1);
    expect(f.waits[0]).toMatchObject({
      nodeId: "c1", variable: "city", saveToContactField: "city", timeoutHours: 48,
    });
    expect(f.waits[0]!.resumeState).toBe(result.state);
    expect(result.executed.map((a) => a.type)).toEqual(["send_message", "collect_input"]);
  });

  test("resume with the captured reply stores the variable and continues", async () => {
    const f = fakePorts();
    const first = await runFlow(f.ports, collectFlow, undefined, { type: "message.received", text: "halo" }, { interpolation: interpCtx });
    const resumed = await runFlow(f.ports, collectFlow, first.state, {
      type: "message.received", text: "Jakarta", variables: { city: "Jakarta" },
    }, { interpolation: interpCtx });
    expect(resumed.paused).toBe(false);
    expect(resumed.state.status).toBe("completed");
    expect(resumed.state.variables.city).toBe("Jakarta");
    expect(f.sent.map((s) => s.text)).toEqual([
      "Halo Dewi, kamu tinggal di kota apa?",
      "Kamu dari Jakarta ya!",
    ]);
  });

  test("timeout resume: an empty value still continues the flow", async () => {
    const f = fakePorts();
    const first = await runFlow(f.ports, collectFlow, undefined, { type: "message.received", text: "halo" }, { interpolation: interpCtx });
    const resumed = await runFlow(f.ports, collectFlow, first.state, {
      type: "input.timeout", variables: { city: "" },
    }, { interpolation: interpCtx });
    expect(resumed.state.status).toBe("completed");
    expect(resumed.state.variables.city).toBe("");
    expect(f.sent[1]!.text).toBe("Kamu dari  ya!");
  });
});
