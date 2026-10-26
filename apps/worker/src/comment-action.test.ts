import { describe, expect, test } from "bun:test";
import { processCommentAction, type CommentActionJobData, type CommentActionPorts } from "./comment-action";
import { processFlowRun, processSendMessage, type WorkerPorts } from "./processors";
import type { Flow } from "@botara/flow-engine";

/**
 * Comment-action processor over fake ports: the mandated ordering
 * (public reply -> hide -> private reply -> flow-run), duplicate
 * suppression, and the privateText vs first-message-node semantics.
 * Plus the rich passthrough of the send paths it builds on.
 */

function fakeCommentPorts(overrides: Partial<CommentActionPorts> = {}) {
  const calls: string[] = [];
  const state = { processed: false, firstMessageText: "First DM from the flow" as string | null };
  const flowRuns: Array<Record<string, unknown>> = [];
  const persisted: Array<Record<string, unknown>> = [];
  const ports: CommentActionPorts = {
    async isProcessed() { return state.processed; },
    async markProcessed() { calls.push("mark"); state.processed = true; },
    async loadFlowFirstMessageText() { return state.firstMessageText; },
    async moderate(input) { calls.push(input.action === "reply" ? "public-reply" : "hide"); },
    async privateReply() { calls.push("private-reply"); return { externalMessageId: "dm-1" }; },
    async findOrCreateConversation() { return { conversationId: "conv-1", contactId: "contact-1" }; },
    async persistMessage(input) { calls.push("persist"); persisted.push(input); },
    async enqueueFlowRun(ref) { calls.push("flow-run"); flowRuns.push(ref as unknown as Record<string, unknown>); },
    ...overrides,
  };
  return { ports, calls, state, flowRuns, persisted };
}

const baseJob: CommentActionJobData = {
  workspaceId: "ws-1",
  channelAccountId: "acc-ig",
  channel: "instagram",
  accountExternalId: "ig-1",
  flowId: "f-1",
  commentExternalId: "c-1",
  postExternalId: "p-1",
  authorExternalId: "u-9",
  commentText: "price?",
  publicReplyText: "Check your DM!",
  autoHide: true,
};

describe("comment-action processor", () => {
  test("executes public reply -> hide -> private -> mark -> flow-run in order", async () => {
    const f = fakeCommentPorts();
    const result = await processCommentAction(f.ports, { ...baseJob });
    expect(result.skipped).toBe(false);
    expect(f.calls).toEqual(["public-reply", "hide", "private-reply", "persist", "mark", "flow-run"]);
    expect(result.actions).toEqual(["public-reply", "hide", "private-reply", "flow-run"]);
  });

  test("without explicit privateText the flow's first message is the DM and the run skips it", async () => {
    const f = fakeCommentPorts();
    await processCommentAction(f.ports, { ...baseJob });
    expect(f.persisted[0]).toMatchObject({
      conversationId: "conv-1",
      body: "First DM from the flow",
      externalId: "dm-1",
      idempotencyKey: "comment:c-1:f-1",
    });
    expect(f.flowRuns[0]).toMatchObject({
      flowId: "f-1", contactId: "contact-1", conversationId: "conv-1",
      commentId: "c-1", skipFirstSendMessage: true, triggerText: "price?",
    });
  });

  test("explicit privateText wins and the flow run does NOT skip its first message", async () => {
    const f = fakeCommentPorts();
    await processCommentAction(f.ports, { ...baseJob, privateText: "Config DM text" });
    expect(f.persisted[0]).toMatchObject({ body: "Config DM text" });
    expect(f.flowRuns[0]).toMatchObject({ skipFirstSendMessage: false });
  });

  test("an already-processed comment is skipped entirely (no provider calls)", async () => {
    const f = fakeCommentPorts({ async isProcessed() { return true; } });
    const result = await processCommentAction(f.ports, { ...baseJob });
    expect(result).toEqual({ skipped: true, reason: "already-processed", actions: [] });
    expect(f.calls).toEqual([]);
    expect(f.flowRuns).toHaveLength(0);
  });

  test("no public reply / hide configured: only the private reply + flow-run run", async () => {
    const f = fakeCommentPorts();
    const result = await processCommentAction(f.ports, {
      ...baseJob, publicReplyText: undefined, autoHide: false,
    });
    expect(result.actions).toEqual(["private-reply", "flow-run"]);
    expect(f.calls).toEqual(["private-reply", "persist", "mark", "flow-run"]);
  });

  test("a flow with no send_message and no privateText still runs (public actions only)", async () => {
    const f = fakeCommentPorts({ async loadFlowFirstMessageText() { return null; } });
    const result = await processCommentAction(f.ports, { ...baseJob });
    expect(result.actions).toEqual(["public-reply", "hide", "flow-run"]);
    expect(f.flowRuns[0]).toMatchObject({ skipFirstSendMessage: false });
  });
});

describe("rich passthrough in send paths", () => {
  const RICH = {
    kind: "buttons" as const,
    text: "Pick one",
    buttons: [{ type: "reply" as const, title: "Prices", payload: "PRICES" }],
  };

  function fakeWorkerPorts(): { ports: WorkerPorts; sentInputs: Array<Record<string, unknown>>; enqueued: Array<Record<string, unknown>> } {
    const sentInputs: Array<Record<string, unknown>> = [];
    const enqueued: Array<Record<string, unknown>> = [];
    const ports: WorkerPorts = {
      async send(_channel, input) {
        sentInputs.push(input as unknown as Record<string, unknown>);
        return { externalMessageId: "ext-1", status: "sent" as const, warnings: ["RICH_DEGRADED_TO_TEXT"] };
      },
      async writeCost() {},
      async updateMessageStatus() {},
      async incrementBroadcastCounts() {},
      async loadBroadcast() { return null; },
      async listBroadcastTargets() { return []; },
      async enqueueSendMessage(data) { enqueued.push(data as unknown as Record<string, unknown>); },
      async setContactField() {},
      async httpFetch() {},
      async scheduleFlowResume() {},
    };
    return { ports, sentInputs, enqueued };
  }

  test("processSendMessage forwards the rich block to the adapter port", async () => {
    const f = fakeWorkerPorts();
    await processSendMessage(f.ports, {
      workspaceId: "ws-1", channelAccountId: "acc-1", channel: "telegram",
      accountExternalId: "555", toExternalId: "777", text: "Pick one",
      rich: RICH, idempotencyKey: "k-rich",
    });
    expect(f.sentInputs[0]).toMatchObject({ rich: RICH, text: "Pick one" });
  });

  test("processFlowRun forwards node rich blocks into send-message jobs", async () => {
    const f = fakeWorkerPorts();
    const flow: Flow = {
      id: "flow-rich", version: 1, startNodeId: "t1",
      nodes: [
        { id: "t1", type: "trigger", trigger: "manual", config: {}, next: "s1" },
        { id: "s1", type: "send_message", text: "Pick one", rich: RICH, next: null },
      ],
    };
    await processFlowRun(f.ports, {
      flow,
      event: { type: "manual" },
      context: {
        workspaceId: "ws-1", channelAccountId: "acc-1", channel: "whatsapp",
        accountExternalId: "10987", contactId: "ct-1", contactExternalId: "62812",
      },
    });
    expect(f.enqueued).toHaveLength(1);
    expect(f.enqueued[0]).toMatchObject({ rich: RICH, text: "Pick one", toExternalId: "62812" });
  });
});

describe("comment-action processor (tiktok)", () => {
  test("public reply + hide are skipped by capability; the direct_reply private reply still runs", async () => {
    const f = fakeCommentPorts();
    const result = await processCommentAction(f.ports, {
      ...baseJob,
      channel: "tiktok",
      channelAccountId: "acc-tt",
      accountExternalId: "open-123",
      privateText: "Halo! Ini info harganya.",
    });
    expect(result.skipped).toBe(false);
    // No moderate calls at all: only private-reply -> persist -> mark -> flow-run.
    expect(f.calls).toEqual(["private-reply", "persist", "mark", "flow-run"]);
    expect(result.actions).toEqual([
      "public-reply-skipped", "hide-skipped", "private-reply", "flow-run",
    ]);
    expect(f.persisted[0]).toMatchObject({ body: "Halo! Ini info harganya." });
  });
});
