import { describe, expect, test } from "bun:test";
import {
  processBroadcast, processFlowRun, processSendMessage,
  type BroadcastSnapshot, type SendMessageJobData, type WorkerPorts,
} from "./processors";

function fakePorts(overrides: Partial<WorkerPorts> = {}) {
  const sent: SendMessageJobData[] = [];
  const costs: Array<Parameters<WorkerPorts["writeCost"]>[0]> = [];
  const statuses: Array<{ id: string; status: string; externalId?: string }> = [];
  const increments: Array<{ id: string; sent?: number; failed?: number }> = [];
  const fields: Array<{ contactId: string; field: string; value: string }> = [];
  const resumes: Array<{ seconds: number }> = [];
  const ensured: Array<{ broadcastId: string; workspaceId: string; contactIds: string[] }> = [];
  const recipientUpdates: Array<{
    broadcastId: string; contactId: string; to: string; providerMessageId?: string; error?: string;
  }> = [];
  const broadcast: BroadcastSnapshot = {
    id: "b1", workspaceId: "ws1", channelAccountId: "acc1", channel: "whatsapp",
    accountExternalId: "62812", template: { name: "promo", language: "id", latestCategory: "marketing" },
    tag: "vip", country: "ID",
  };
  const ports: WorkerPorts = {
    async send() { return { externalMessageId: "wamid.1", status: "sent" as const }; },
    async writeCost(entry) { costs.push(entry); },
    async updateMessageStatus(id, status, externalId) { statuses.push({ id, status, externalId }); },
    async incrementBroadcastCounts(id, delta) { increments.push({ id, ...delta }); },
    async loadBroadcast() { return broadcast; },
    async listBroadcastTargets() {
      return [
        { contactId: "c1", externalId: "628111" },
        { contactId: "c2", externalId: "628222" },
      ];
    },
    async enqueueSendMessage(data) { sent.push(data); },
    async ensureBroadcastRecipients(broadcastId, workspaceId, contactIds) {
      ensured.push({ broadcastId, workspaceId, contactIds });
    },
    async updateBroadcastRecipient(update) { recipientUpdates.push(update); },
    async setContactField(_ws, contactId, field, value) { fields.push({ contactId, field, value }); },
    async httpFetch() {},
    async scheduleFlowResume(_job, seconds) { resumes.push({ seconds }); },
    ...overrides,
  };
  return { ports, sent, costs, statuses, increments, fields, resumes, ensured, recipientUpdates };
}

describe("worker processors (fake ports)", () => {
  test("send-message: sends, writes rated cost_ledger row, marks sent", async () => {
    const f = fakePorts();
    const result = await processSendMessage(f.ports, {
      workspaceId: "ws1", channelAccountId: "acc1", channel: "whatsapp",
      accountExternalId: "62812", toExternalId: "628999",
      template: { name: "promo", language: "id", latestCategory: "marketing" },
      country: "ID", messageId: "m1", referenceId: "b1", idempotencyKey: "b1:c9",
    });
    expect(result.externalMessageId).toBe("wamid.1");
    expect(result.costUsd).toBe(0.0416); // sample ID marketing rate
    expect(f.costs).toHaveLength(1);
    expect(f.costs[0]).toMatchObject({ channel: "whatsapp", category: "marketing", amountUsd: 0.0416, referenceId: "b1" });
    expect(f.statuses).toEqual([{ id: "m1", status: "sent", externalId: "wamid.1" }]);
    expect(f.increments).toEqual([{ id: "b1", sent: 1 }]);
  });

  test("send-message: provider failure marks failed, counts failure, rethrows", async () => {
    const f = fakePorts({
      async send() { throw new Error("provider down"); },
    });
    await expect(processSendMessage(f.ports, {
      workspaceId: "ws1", channelAccountId: "acc1", channel: "telegram",
      accountExternalId: "bot", toExternalId: "42", text: "hi",
      messageId: "m2", referenceId: "b1", idempotencyKey: "k2",
    })).rejects.toThrow("provider down");
    expect(f.statuses).toEqual([{ id: "m2", status: "failed", externalId: undefined }]);
    expect(f.increments).toEqual([{ id: "b1", failed: 1 }]);
    expect(f.costs).toHaveLength(0);
  });

  test("broadcast: fan-out enqueues one send per target with stable idempotency keys", async () => {
    const f = fakePorts();
    const result = await processBroadcast(f.ports, { broadcastId: "b1" });
    expect(result.enqueued).toBe(2);
    expect(f.sent.map((s) => s.idempotencyKey)).toEqual(["b1:c1", "b1:c2"]);
    expect(f.sent[0]).toMatchObject({ referenceId: "b1", toExternalId: "628111", channel: "whatsapp" });
    expect(f.sent[0]!.template?.latestCategory).toBe("marketing");
  });

  test("flow-run: keyword flow enqueues a send-message job", async () => {
    const f = fakePorts();
    const result = await processFlowRun(f.ports, {
      flow: {
        id: "welcome", version: 1, startNodeId: "t1",
        nodes: [
          { id: "t1", type: "trigger", trigger: "keyword", config: { keyword: "halo" }, next: "s1" },
          { id: "s1", type: "send_message", text: "Halo juga!", next: null },
        ],
      },
      event: { type: "message.received", text: "halo bot" },
      context: {
        workspaceId: "ws1", channelAccountId: "acc1", channel: "telegram",
        accountExternalId: "bot", contactId: "c1", contactExternalId: "42",
      },
    });
    expect(result.state.status).toBe("completed");
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ text: "Halo juga!", toExternalId: "42", channel: "telegram" });
  });

  test("flow-run: delay node schedules a resume and pauses", async () => {
    const f = fakePorts();
    const result = await processFlowRun(f.ports, {
      flow: {
        id: "drip", version: 1, startNodeId: "t1",
        nodes: [
          { id: "t1", type: "trigger", trigger: "manual", config: {}, next: "d1" },
          { id: "d1", type: "delay", seconds: 600, next: "s1" },
          { id: "s1", type: "send_message", text: "Follow up", next: null },
        ],
      },
      event: { type: "manual" },
      context: {
        workspaceId: "ws1", channelAccountId: "acc1", channel: "telegram",
        accountExternalId: "bot", contactId: "c1", contactExternalId: "42",
      },
    });
    expect(result.paused).toBe(true);
    expect(f.resumes).toEqual([{ seconds: 600 }]);
    expect(f.sent).toHaveLength(0);
  });
});

describe("WhatsApp service allowance (Fase 3, fake counting port)", () => {
  const serviceMsg = {
    workspaceId: "ws1", channelAccountId: "acc1", channel: "whatsapp",
    accountExternalId: "62812", toExternalId: "628999",
    category: "service" as const, country: "ID",
    idempotencyKey: "svc:1",
  };

  test("999 already sent this month -> this one is still free (allowance not exhausted)", async () => {
    const f = fakePorts({
      async countServiceMessagesThisMonth() { return 999; },
    });
    const result = await processSendMessage(f.ports, serviceMsg);
    expect(result.costUsd).toBe(0);
    expect(f.costs[0]!.amountUsd).toBe(0);
  });

  test("1000 already sent -> the allowance is exhausted, this one bills at the utility rate", async () => {
    const f = fakePorts({
      async countServiceMessagesThisMonth() { return 1000; },
    });
    const result = await processSendMessage(f.ports, serviceMsg);
    expect(result.costUsd).toBe(0.0125); // sample ID utility rate
  });

  test("1001 already sent -> still utility rate (no double-free)", async () => {
    const f = fakePorts({
      async countServiceMessagesThisMonth() { return 1001; },
    });
    const result = await processSendMessage(f.ports, serviceMsg);
    expect(result.costUsd).toBe(0.0125);
  });

  test("marketing messages ignore the allowance entirely", async () => {
    let consulted = false;
    const f = fakePorts({
      async countServiceMessagesThisMonth() { consulted = true; return 0; },
    });
    const result = await processSendMessage(f.ports, {
      ...serviceMsg, category: "marketing",
      template: { name: "promo", language: "id", latestCategory: "marketing" },
    });
    expect(result.costUsd).toBe(0.0416); // sample ID marketing rate
    expect(consulted).toBe(false);
  });

  test("without a counting port, service messages bill at utility (never silently free)", async () => {
    const f = fakePorts();
    const result = await processSendMessage(f.ports, serviceMsg);
    expect(result.costUsd).toBe(0.0125);
  });
});

describe("tiktok send guards (capability-driven)", () => {
  const ttJob = {
    workspaceId: "ws1", channelAccountId: "acc-tt", channel: "tiktok",
    accountExternalId: "open-123", toExternalId: "uniq-1",
    text: "halo", idempotencyKey: "tt:1",
  };

  test("a send without a conversation id fails typed (CONVERSATION_ADDRESS_MISSING) and never reaches the adapter", async () => {
    let sendCalled = false;
    const f = fakePorts({
      async send() { sendCalled = true; return { externalMessageId: "x", status: "sent" as const }; },
    });
    await expect(processSendMessage(f.ports, { ...ttJob }))
      .rejects.toMatchObject({ code: "CONVERSATION_ADDRESS_MISSING", status: 422 });
    expect(sendCalled).toBe(false);
  });

  test("at the consecutive cap the send fails typed (CONSECUTIVE_SEND_CAP) and never reaches the adapter", async () => {
    let sendCalled = false;
    const f = fakePorts({
      async send() { sendCalled = true; return { externalMessageId: "x", status: "sent" as const }; },
      async countConsecutiveOutbound() { return 10; },
    });
    await expect(processSendMessage(f.ports, { ...ttJob, conversationExternalId: "conv-1" }))
      .rejects.toMatchObject({ code: "CONSECUTIVE_SEND_CAP", details: { cap: 10, consecutive: 10 } });
    expect(sendCalled).toBe(false);
  });

  test("under the cap the send goes through with the conversation id on the SendInput", async () => {
    const inputs: unknown[] = [];
    const f = fakePorts({
      async send(_channel, input) { inputs.push(input); return { externalMessageId: "tt-m1", status: "sent" as const }; },
      async countConsecutiveOutbound() { return 9; },
    });
    const result = await processSendMessage(f.ports, { ...ttJob, conversationExternalId: "conv-1" });
    expect(result.externalMessageId).toBe("tt-m1");
    expect(inputs[0]).toMatchObject({ conversationExternalId: "conv-1", toExternalId: "uniq-1" });
  });

  test("a comment-reply reference satisfies the address guard (comment-to-DM opener)", async () => {
    const f = fakePorts({
      async countConsecutiveOutbound() { return 0; },
    });
    const result = await processSendMessage(f.ports, { ...ttJob, commentReplyExternalId: "comment-1" });
    expect(result.externalMessageId).toBe("wamid.1");
  });

  test("broadcast to a tiktok account fails typed and marks the broadcast failed", async () => {
    const statusUpdates: Array<{ id: string; status: string }> = [];
    const f = fakePorts({
      async loadBroadcast() {
        return {
          id: "b-tt", workspaceId: "ws1", channelAccountId: "acc-tt", channel: "tiktok",
          accountExternalId: "open-123", tag: "vip", country: "ID",
        };
      },
      async updateBroadcastStatus(id, status) { statusUpdates.push({ id, status }); },
    });
    await expect(processBroadcast(f.ports, { broadcastId: "b-tt" }))
      .rejects.toMatchObject({ code: "CHANNEL_INITIATION_UNSUPPORTED" });
    expect(statusUpdates).toEqual([{ id: "b-tt", status: "failed" }]);
    expect(f.sent).toHaveLength(0);
  });
});

describe("disconnected-account send guards", () => {
  const job = {
    workspaceId: "ws1", channelAccountId: "acc1", channel: "telegram",
    accountExternalId: "bot", toExternalId: "42", text: "hi",
    messageId: "m-disc", referenceId: "b1", idempotencyKey: "k-disc",
  };

  test("send-message: disconnected account is SKIPPED (no send, no throw, failure bookkeeping runs)", async () => {
    let sendCalls = 0;
    const f = fakePorts({
      async resolveAccountStatus() { return "disconnected"; },
      async send() { sendCalls++; return { externalMessageId: "x", status: "sent" as const }; },
    });
    const result = await processSendMessage(f.ports, { ...job });
    expect(result).toEqual({ externalMessageId: "", costUsd: 0, skipped: true });
    expect(sendCalls).toBe(0);
    expect(f.costs).toHaveLength(0);
    expect(f.statuses).toEqual([{ id: "m-disc", status: "failed", externalId: undefined }]);
    expect(f.increments).toEqual([{ id: "b1", failed: 1 }]);
  });

  test("send-message: purged account (status resolves null) is skipped too", async () => {
    let sendCalls = 0;
    const f = fakePorts({
      async resolveAccountStatus() { return null; },
      async send() { sendCalls++; return { externalMessageId: "x", status: "sent" as const }; },
    });
    const result = await processSendMessage(f.ports, { ...job });
    expect(result.skipped).toBe(true);
    expect(sendCalls).toBe(0);
  });

  test("send-message: connected account proceeds normally when the status port is wired", async () => {
    const f = fakePorts({
      async resolveAccountStatus() { return "connected"; },
    });
    const result = await processSendMessage(f.ports, { ...job, channel: "whatsapp", text: undefined });
    expect(result.skipped).toBeUndefined();
    expect(result.externalMessageId).toBe("wamid.1");
  });

  test("broadcast: snapshot with a disconnected account fans out nothing and is marked failed", async () => {
    const statusUpdates: Array<{ id: string; status: string }> = [];
    const f = fakePorts({
      async loadBroadcast() {
        return {
          id: "b-disc", workspaceId: "ws1", channelAccountId: "acc1", channel: "whatsapp",
          accountExternalId: "62812", accountStatus: "disconnected",
          template: { name: "promo", language: "id", latestCategory: "marketing" },
          tag: "vip", country: "ID",
        };
      },
      async updateBroadcastStatus(id, status) { statusUpdates.push({ id, status }); },
    });
    const result = await processBroadcast(f.ports, { broadcastId: "b-disc" });
    expect(result).toEqual({ enqueued: 0 });
    expect(f.sent).toHaveLength(0);
    expect(statusUpdates).toEqual([{ id: "b-disc", status: "failed" }]);
  });
});

describe("variables package #1 (broadcast params + flow context)", () => {
  test("broadcast: templateParams render PER RECIPIENT into body components", async () => {
    const f = fakePorts({
      async loadBroadcast() {
        return {
          id: "b-vars", workspaceId: "ws1", channelAccountId: "acc1", channel: "whatsapp",
          accountExternalId: "62812",
          template: { name: "promo", language: "id", latestCategory: "marketing" },
          templateParams: ["Halo {{contact.name}} dari {{contact.city}}", "{{workspace.name}}"],
          workspaceName: "Toko Uji",
          channelDisplayName: "WA Bisnis",
          tag: "vip", country: "ID",
        };
      },
      async listBroadcastTargets() {
        return [
          { contactId: "c1", externalId: "628111", displayName: "Andi", channel: "whatsapp", tags: [], customFields: { city: "Jakarta" } },
          { contactId: "c2", externalId: "628222", displayName: "Rina", channel: "whatsapp", tags: [], customFields: { city: "Bogor" } },
        ];
      },
    });
    const result = await processBroadcast(f.ports, { broadcastId: "b-vars" });
    expect(result.enqueued).toBe(2);
    expect(f.sent[0]!.template?.components).toEqual([{
      type: "body",
      parameters: [
        { type: "text", text: "Halo Andi dari Jakarta" },
        { type: "text", text: "Toko Uji" },
      ],
    }]);
    expect(f.sent[1]!.template?.components).toEqual([{
      type: "body",
      parameters: [
        { type: "text", text: "Halo Rina dari Bogor" },
        { type: "text", text: "Toko Uji" },
      ],
    }]);
    // Template identity survives alongside the components.
    expect(f.sent[0]!.template?.name).toBe("promo");
  });

  test("broadcast: without templateParams the template passes through with no components", async () => {
    const f = fakePorts();
    await processBroadcast(f.ports, { broadcastId: "b1" });
    expect(f.sent[0]!.template).toEqual({ name: "promo", language: "id", latestCategory: "marketing" });
  });

  test("flow-run: send_message renders against the run context (contact + run vars)", async () => {
    const f = fakePorts();
    const result = await processFlowRun(f.ports, {
      flow: {
        id: "vars-flow", version: 1, startNodeId: "t1",
        nodes: [
          { id: "t1", type: "trigger", trigger: "keyword", config: { keyword: "halo" }, next: "s1" },
          { id: "s1", type: "send_message", text: "Halo {{contact.name}}, kode {{vars.code}} dari {{workspace.name}}!", next: null },
        ],
      },
      event: { type: "message.received", text: "halo", variables: { code: "K-9" } },
      context: {
        workspaceId: "ws1", channelAccountId: "acc1", channel: "telegram",
        accountExternalId: "bot", contactId: "c1", contactExternalId: "42",
        contactDisplayName: "Bima", contactTags: [], contactCustomFields: {},
        workspaceName: "Toko Uji", channelDisplayName: "Bot Uji",
      },
    });
    expect(result.state.status).toBe("completed");
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ text: "Halo Bima, kode K-9 dari Toko Uji!" });
    expect(result.warnings).toEqual([]);
  });
});

describe("broadcast recipient records (package #4)", () => {
  test("fan-out: ensures one pending row per target BEFORE enqueueing, jobs carry the broadcast context", async () => {
    const f = fakePorts();
    const result = await processBroadcast(f.ports, { broadcastId: "b1" });
    expect(result.enqueued).toBe(2);
    expect(f.ensured).toEqual([{ broadcastId: "b1", workspaceId: "ws1", contactIds: ["c1", "c2"] }]);
    expect(f.sent.map((s) => [s.broadcastId, s.contactId])).toEqual([["b1", "c1"], ["b1", "c2"]]);
  });

  test("fan-out retry safety: re-running the fan-out re-ensures the same rows (repository upsert-ignores)", async () => {
    const f = fakePorts();
    await processBroadcast(f.ports, { broadcastId: "b1" });
    await processBroadcast(f.ports, { broadcastId: "b1" });
    expect(f.ensured).toEqual([
      { broadcastId: "b1", workspaceId: "ws1", contactIds: ["c1", "c2"] },
      { broadcastId: "b1", workspaceId: "ws1", contactIds: ["c1", "c2"] },
    ]);
    // Send job ids stay the stable originals, so BullMQ dedupes the sends.
    expect(f.sent.map((s) => s.idempotencyKey)).toEqual(["b1:c1", "b1:c2", "b1:c1", "b1:c2"]);
  });

  test("resend mode: only the given contacts are targeted and the send keys are resend-scoped", async () => {
    const f = fakePorts({
      async listBroadcastTargets(_broadcast, onlyContactIds) {
        const all = [
          { contactId: "c1", externalId: "628111" },
          { contactId: "c2", externalId: "628222" },
        ];
        return onlyContactIds ? all.filter((t) => onlyContactIds.includes(t.contactId)) : all;
      },
    });
    const result = await processBroadcast(f.ports, {
      broadcastId: "b1", contactIds: ["c2"], resendToken: "tok-1",
    });
    expect(result.enqueued).toBe(1);
    expect(f.ensured).toEqual([{ broadcastId: "b1", workspaceId: "ws1", contactIds: ["c2"] }]);
    expect(f.sent[0]).toMatchObject({ broadcastId: "b1", contactId: "c2", toExternalId: "628222" });
    expect(f.sent[0]!.idempotencyKey).toBe("b1:c2:resend:tok-1");
  });

  test("send success: recipient flips to sent with the provider message id", async () => {
    const f = fakePorts();
    await processSendMessage(f.ports, {
      workspaceId: "ws1", channelAccountId: "acc1", channel: "whatsapp",
      accountExternalId: "62812", toExternalId: "628111",
      template: { name: "promo", language: "id", latestCategory: "marketing" },
      country: "ID", referenceId: "b1", broadcastId: "b1", contactId: "c1",
      idempotencyKey: "b1:c1",
    });
    expect(f.recipientUpdates).toEqual([
      { broadcastId: "b1", contactId: "c1", to: "sent", providerMessageId: "wamid.1" },
    ]);
  });

  test("send failure: recipient flips to failed with the error, send still rethrows", async () => {
    const f = fakePorts({
      async send() { throw new Error("provider down"); },
    });
    await expect(processSendMessage(f.ports, {
      workspaceId: "ws1", channelAccountId: "acc1", channel: "whatsapp",
      accountExternalId: "62812", toExternalId: "628111",
      template: { name: "promo", language: "id", latestCategory: "marketing" },
      country: "ID", referenceId: "b1", broadcastId: "b1", contactId: "c1",
      idempotencyKey: "b1:c1",
    })).rejects.toThrow("provider down");
    expect(f.recipientUpdates).toEqual([
      { broadcastId: "b1", contactId: "c1", to: "failed", error: "provider down" },
    ]);
  });

  test("disconnected skip: recipient flips to failed with the not-connected reason", async () => {
    const f = fakePorts({
      async resolveAccountStatus() { return "disconnected"; },
    });
    const result = await processSendMessage(f.ports, {
      workspaceId: "ws1", channelAccountId: "acc1", channel: "whatsapp",
      accountExternalId: "62812", toExternalId: "628111", text: "hi",
      referenceId: "b1", broadcastId: "b1", contactId: "c1", idempotencyKey: "b1:c1",
    });
    expect(result.skipped).toBe(true);
    expect(f.recipientUpdates).toEqual([
      { broadcastId: "b1", contactId: "c1", to: "failed", error: "Channel account is not connected." },
    ]);
  });

  test("non-broadcast sends record nothing (no broadcast context on the job)", async () => {
    const f = fakePorts();
    await processSendMessage(f.ports, {
      workspaceId: "ws1", channelAccountId: "acc1", channel: "telegram",
      accountExternalId: "bot", toExternalId: "42", text: "hi",
      messageId: "m1", idempotencyKey: "k1",
    });
    expect(f.recipientUpdates).toEqual([]);
  });
});
