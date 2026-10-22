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
    async setContactField(_ws, contactId, field, value) { fields.push({ contactId, field, value }); },
    async httpFetch() {},
    async scheduleFlowResume(_job, seconds) { resumes.push({ seconds }); },
    ...overrides,
  };
  return { ports, sent, costs, statuses, increments, fields, resumes };
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
