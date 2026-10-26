import { describe, expect, test } from "bun:test";
import type { Flow } from "@botara/flow-engine";
import {
  processFlowRun,
  type FlowRunJobData, type SendMessageJobData, type WorkerPorts,
} from "./processors";

/**
 * Regression suite for the cross-segment send-sequence bug found by the
 * live survey E2E of adoption package #3: processFlowRun used to restart
 * its send counter at 0 in every invocation, so a resumed run's first
 * send rebuilt the pre-pause segment's `flow:{flowId}:{contactId}:0`
 * idempotency key and the send pipeline deduped it away - the run
 * "completed" while its message never left. The counter now lives on
 * the run state (FlowState.sendSeq): seeded from the incoming state and
 * stamped into every pause snapshot (delay resume + collect-input
 * wait), so keys stay unique across segments yet deterministic for a
 * given incoming state (BullMQ job retries reproduce the same keys).
 */
function fakePorts() {
  const sent: SendMessageJobData[] = [];
  const calls: string[] = [];
  const waits: Array<{ job: FlowRunJobData; variable: string }> = [];
  const resumes: Array<{ job: FlowRunJobData; seconds: number }> = [];
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
    async scheduleFlowResume(job, delaySeconds) { resumes.push({ job, seconds: delaySeconds }); },
    async addContactTag(_ws, _c, tag) { calls.push(`add:${tag}`); },
    async scheduleFlowInputWait(job, wait) { waits.push({ job, variable: wait.variable }); },
  };
  return { ports, sent, calls, waits, resumes };
}

const ctx = {
  workspaceId: "ws1", channelAccountId: "acc1", channel: "webchat",
  accountExternalId: "site", contactId: "c1", contactExternalId: "visitor-1",
  conversationId: "conv1",
};

const keys = (sent: SendMessageJobData[]) => sent.map((s) => s.idempotencyKey);

describe("send sequence across collect-input segments", () => {
  // The exact live-survey shape: prompt -> answer -> follow-up -> tag.
  const collectFlow: Flow = {
    id: "survey", version: 1, startNodeId: "t1",
    nodes: [
      { id: "t1", type: "trigger", trigger: "message.received", config: {}, next: "c1" },
      { id: "c1", type: "collect_input", promptText: "Kota apa?", variable: "city", next: "s1" },
      { id: "s1", type: "send_message", text: "Kamu dari {{vars.city}}", next: "a1" },
      { id: "a1", type: "add_tag", tag: "survey-done", next: null },
    ],
  };

  test("segment 1 sends the prompt as :0 and stamps sendSeq=1 into the wait", async () => {
    const f = fakePorts();
    const result = await processFlowRun(f.ports, {
      flow: collectFlow, event: { type: "message.received", text: "survei" }, context: ctx,
    });
    expect(result.paused).toBe(true);
    expect(f.sent.map((s) => s.text)).toEqual(["Kota apa?"]);
    expect(keys(f.sent)).toEqual(["flow:survey:c1:0"]);
    expect(f.waits).toHaveLength(1);
    expect(f.waits[0]!.job.state?.currentNodeId).toBe("s1");
    expect(f.waits[0]!.job.state?.sendSeq).toBe(1);
  });

  test("the resumed segment sends the follow-up as :1 - distinct from the prompt", async () => {
    const f1 = fakePorts();
    await processFlowRun(f1.ports, {
      flow: collectFlow, event: { type: "message.received", text: "survei" }, context: ctx,
    });
    // Segment 2, built the way loadFlowRun builds it in production:
    // the claimed wait's resumeState becomes the job state and the
    // captured answer rides the event.
    const f2 = fakePorts();
    const result = await processFlowRun(f2.ports, {
      flow: collectFlow,
      state: f1.waits[0]!.job.state,
      event: { type: "message.received", text: "Bandung", variables: { city: "Bandung" } },
      context: ctx,
    });
    expect(result.state.status).toBe("completed");
    expect(f2.sent.map((s) => s.text)).toEqual(["Kamu dari Bandung"]);
    expect(keys(f2.sent)).toEqual(["flow:survey:c1:1"]);
    // The post-send steps of the resumed segment run too (in the live
    // bug the tag landed while the send was swallowed).
    expect(f2.calls).toEqual(["add:survey-done"]);
    // No key is ever reused across the whole run.
    expect(new Set([...keys(f1.sent), ...keys(f2.sent)]).size).toBe(2);
  });
});

describe("send sequence across delay segments", () => {
  const delayFlow: Flow = {
    id: "drip", version: 1, startNodeId: "t1",
    nodes: [
      { id: "t1", type: "trigger", trigger: "manual", config: {}, next: "s1" },
      { id: "s1", type: "send_message", text: "satu", next: "d1" },
      { id: "d1", type: "delay", seconds: 60, next: "s2" },
      { id: "s2", type: "send_message", text: "dua", next: null },
    ],
  };

  test("send -> delay -> send yields :0 and :1 across the two segments", async () => {
    const f1 = fakePorts();
    const paused = await processFlowRun(f1.ports, {
      flow: delayFlow, event: { type: "manual" }, context: ctx,
    });
    expect(paused.paused).toBe(true);
    expect(keys(f1.sent)).toEqual(["flow:drip:c1:0"]);
    expect(f1.resumes).toHaveLength(1);
    expect(f1.resumes[0]!.seconds).toBe(60);
    expect(f1.resumes[0]!.job.state?.sendSeq).toBe(1);

    // Production delivers the delayed payload back as the job itself.
    const f2 = fakePorts();
    const done = await processFlowRun(f2.ports, f1.resumes[0]!.job);
    expect(done.state.status).toBe("completed");
    expect(f2.sent.map((s) => s.text)).toEqual(["dua"]);
    expect(keys(f2.sent)).toEqual(["flow:drip:c1:1"]);
  });
});

describe("send sequence basics + retry determinism", () => {
  const twoSendFlow: Flow = {
    id: "plain", version: 1, startNodeId: "t1",
    nodes: [
      { id: "t1", type: "trigger", trigger: "manual", config: {}, next: "s1" },
      { id: "s1", type: "send_message", text: "satu", next: "s2" },
      { id: "s2", type: "send_message", text: "dua", next: null },
    ],
  };

  test("a fresh single-segment run still starts at :0", async () => {
    const f = fakePorts();
    await processFlowRun(f.ports, { flow: twoSendFlow, event: { type: "manual" }, context: ctx });
    expect(keys(f.sent)).toEqual(["flow:plain:c1:0", "flow:plain:c1:1"]);
  });

  test("job retry: re-invoking a segment with the same incoming state reproduces the same keys", async () => {
    const collectFlow: Flow = {
      id: "survey", version: 1, startNodeId: "t1",
      nodes: [
        { id: "t1", type: "trigger", trigger: "message.received", config: {}, next: "c1" },
        { id: "c1", type: "collect_input", promptText: "Kota apa?", variable: "city", next: "s1" },
        { id: "s1", type: "send_message", text: "Kamu dari {{vars.city}}", next: null },
      ],
    };
    // First segment, invoked twice (a BullMQ retry of the same job):
    // same sends, same stamped snapshot - the pipeline dedupes on them.
    const runSegment1 = async () => {
      const f = fakePorts();
      await processFlowRun(f.ports, {
        flow: collectFlow, event: { type: "message.received", text: "survei" }, context: ctx,
      });
      return f;
    };
    const a = await runSegment1();
    const b = await runSegment1();
    expect(keys(a.sent)).toEqual(["flow:survey:c1:0"]);
    expect(keys(b.sent)).toEqual(keys(a.sent));
    expect(b.waits[0]!.job.state).toEqual(a.waits[0]!.job.state);

    // Resumed segment, invoked twice from the same claimed wait state:
    // both attempts build the follow-up's key identically (:1).
    const resumeJob: FlowRunJobData = {
      flow: collectFlow,
      state: a.waits[0]!.job.state,
      event: { type: "message.received", text: "Bandung", variables: { city: "Bandung" } },
      context: ctx,
    };
    const r1 = fakePorts();
    await processFlowRun(r1.ports, resumeJob);
    const r2 = fakePorts();
    await processFlowRun(r2.ports, resumeJob);
    expect(keys(r1.sent)).toEqual(["flow:survey:c1:1"]);
    expect(keys(r2.sent)).toEqual(keys(r1.sent));
  });
});
