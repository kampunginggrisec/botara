import { rateWhatsAppMessage, type WhatsAppCategory } from "@botara/billing";
import { runFlow, type Flow, type FlowEvent, type FlowPorts, type FlowRunResult, type FlowState } from "@botara/flow-engine";
import type { SendInput, SendResult } from "@botara/channels";

/**
 * Fase 1 worker processors.
 *
 * Processors are pure orchestration over INJECTED PORTS: production wiring
 * (index.ts) backs the ports with BullMQ queues + Drizzle repositories +
 * the channel registry, while tests back them with in-memory fakes - no
 * Redis or Postgres needed to verify the logic.
 */

export interface SendMessageJobData {
  workspaceId: string;
  channelAccountId: string;
  channel: string;
  accountExternalId: string;
  tokenVaultRef?: string;
  toExternalId: string;
  text?: string;
  template?: { name: string; language: string; latestCategory: string };
  /** Recipient country (rating); defaults to ID for WhatsApp estimates. */
  country?: string;
  /** Explicit billing category; falls back to the template category, then "service". */
  category?: WhatsAppCategory;
  /** DB message row to update (inbox replies); absent for broadcast fan-out. */
  messageId?: string;
  /** Broadcast id this send belongs to (cost ledger reference + counters). */
  referenceId?: string;
  /** Stable idempotency key - retries with the same key never double-send. */
  idempotencyKey: string;
}

export interface BroadcastTarget {
  contactId: string;
  externalId: string;
  country?: string;
}

export interface BroadcastSnapshot {
  id: string;
  workspaceId: string;
  channelAccountId: string;
  channel: string;
  accountExternalId: string;
  tokenVaultRef?: string;
  template?: { name: string; language: string; latestCategory: string };
  tag?: string;
  country?: string;
}

export interface FlowRunContext {
  workspaceId: string;
  channelAccountId: string;
  channel: string;
  accountExternalId: string;
  tokenVaultRef?: string;
  contactId: string;
  contactExternalId: string;
  country?: string;
}

export interface FlowRunJobData {
  flow: Flow;
  state?: FlowState;
  event: FlowEvent;
  context: FlowRunContext;
}

/**
 * Id-based flow-run reference (Fase 4): webhook-triggered runs enqueue only
 * ids; the worker resolves the full job via WorkerPorts.loadFlowRun. This is
 * also the payload the API's flowEnqueuer writes to the queue.
 */
export interface FlowRunRef {
  flowId: string;
  workspaceId: string;
  contactId: string;
  conversationId: string;
  channelAccountId: string;
  triggerText?: string;
  runId?: string;
}

export interface WorkerPorts {
  /** Resolve the channel adapter (registry) and send. */
  send(channel: string, input: SendInput): Promise<SendResult>;
  /** Append one cost_ledger row. */
  writeCost(entry: {
    workspaceId: string;
    channelAccountId: string;
    channel: string;
    category: string;
    country?: string;
    amountUsd: number;
    referenceId?: string;
  }): Promise<void>;
  updateMessageStatus(messageId: string, status: string, externalId?: string): Promise<void>;
  incrementBroadcastCounts(broadcastId: string, delta: { sent?: number; failed?: number }): Promise<void>;
  loadBroadcast(broadcastId: string): Promise<BroadcastSnapshot | null>;
  listBroadcastTargets(broadcast: BroadcastSnapshot): Promise<BroadcastTarget[]>;
  /**
   * Month-to-date count of DELIVERED service messages for a channel
   * account (Fase 3 allowance tracking over cost_ledger). Optional on
   * purpose: without it, service messages are rated at the utility rate
   * (the conservative default - never silently free).
   */
  countServiceMessagesThisMonth?(channelAccountId: string, now: Date): Promise<number>;
  /**
   * AI reply for flow ai_reply nodes (Fase 3): KB retrieval + AI chat in
   * production. Return null when AI/KB have nothing - the flow executor
   * then sends the node's configured fallback text.
   */
  aiReply?(input: { workspaceId: string; prompt: string; query: string }): Promise<string | null>;
  /**
   * Resolve an id-based flow-run reference into a full job (Fase 4).
   * Optional: embedded-payload jobs (tests, delay resumes) do not need it.
   */
  loadFlowRun?(ref: FlowRunRef): Promise<FlowRunJobData | null>;
  /** Enqueue a send-message job; `data.idempotencyKey` is the stable job identity. */
  enqueueSendMessage(data: SendMessageJobData): Promise<void>;
  setContactField(workspaceId: string, contactId: string, field: string, value: string): Promise<void>;
  httpFetch(url: string, method: "GET" | "POST"): Promise<void>;
  /** Schedule a flow-run resume after a delay node paused the run. */
  scheduleFlowResume(job: FlowRunJobData, delaySeconds: number): Promise<void>;
}

function billingCategory(data: SendMessageJobData): WhatsAppCategory {
  if (data.category) return data.category;
  const cat = data.template?.latestCategory.toLowerCase();
  if (cat === "marketing" || cat === "utility" || cat === "authentication" || cat === "service") return cat;
  return "service";
}

/** "send-message": one provider send + cost ledger row + status bookkeeping. */
export async function processSendMessage(
  ports: WorkerPorts,
  data: SendMessageJobData,
): Promise<{ externalMessageId: string; costUsd: number }> {
  const category = billingCategory(data);
  try {
    const result = await ports.send(data.channel, {
      account: { id: data.channelAccountId, externalId: data.accountExternalId, tokenVaultRef: data.tokenVaultRef },
      toExternalId: data.toExternalId,
      text: data.text,
      template: data.template,
      idempotencyKey: data.idempotencyKey,
    });
    // Cost: WhatsApp is rated per delivered message by category + country
    // from the versioned rates table; other channels are free at Fase 1.
    // Fase 3 allowance: service messages consult the month-to-date service
    // count for this number - the first 1,000 are free, beyond that they
    // bill at the utility rate (rateWhatsAppMessage).
    let costUsd = 0;
    if (data.channel === "whatsapp") {
      const serviceMessagesThisMonth = category === "service"
        ? (ports.countServiceMessagesThisMonth
          ? await ports.countServiceMessagesThisMonth(data.channelAccountId, new Date())
          : Number.POSITIVE_INFINITY)
        : 0;
      costUsd = rateWhatsAppMessage({
        country: data.country ?? "ID",
        category,
        serviceMessagesThisMonth,
      });
    }
    await ports.writeCost({
      workspaceId: data.workspaceId,
      channelAccountId: data.channelAccountId,
      channel: data.channel,
      category,
      country: data.country,
      amountUsd: costUsd,
      referenceId: data.referenceId,
    });
    if (data.messageId) await ports.updateMessageStatus(data.messageId, "sent", result.externalMessageId);
    if (data.referenceId) await ports.incrementBroadcastCounts(data.referenceId, { sent: 1 });
    return { externalMessageId: result.externalMessageId, costUsd };
  } catch (err) {
    if (data.messageId) await ports.updateMessageStatus(data.messageId, "failed").catch(() => undefined);
    if (data.referenceId) await ports.incrementBroadcastCounts(data.referenceId, { failed: 1 }).catch(() => undefined);
    throw err;
  }
}

/**
 * "broadcast": fan-out. For each target contact, enqueue one send-message
 * job whose idempotency key is the stable `${broadcastId}:${contactId}` -
 * re-running the fan-out (retry, crash recovery) can never double-send.
 */
export async function processBroadcast(
  ports: WorkerPorts,
  data: { broadcastId: string },
): Promise<{ enqueued: number }> {
  const broadcast = await ports.loadBroadcast(data.broadcastId);
  if (!broadcast) throw new Error(`Broadcast ${data.broadcastId} not found`);
  const targets = await ports.listBroadcastTargets(broadcast);
  for (const target of targets) {
    await ports.enqueueSendMessage({
      workspaceId: broadcast.workspaceId,
      channelAccountId: broadcast.channelAccountId,
      channel: broadcast.channel,
      accountExternalId: broadcast.accountExternalId,
      tokenVaultRef: broadcast.tokenVaultRef,
      toExternalId: target.externalId,
      template: broadcast.template,
      country: target.country ?? broadcast.country,
      referenceId: broadcast.id,
      idempotencyKey: `${broadcast.id}:${target.contactId}`,
    });
  }
  return { enqueued: targets.length };
}

/** Type guard: id-based references carry flowId and no embedded flow. */
export function isFlowRunRef(data: unknown): data is FlowRunRef {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return typeof d.flowId === "string" && !("flow" in d);
}

/** "flow-run": execute one flow-engine batch; actions go back out as jobs/calls via ports. */
export async function processFlowRun(
  ports: WorkerPorts,
  data: FlowRunJobData | FlowRunRef,
): Promise<FlowRunResult> {
  let job: FlowRunJobData;
  if (isFlowRunRef(data)) {
    if (!ports.loadFlowRun) {
      throw new Error("flow-run job carries only ids but WorkerPorts.loadFlowRun is not wired");
    }
    const loaded = await ports.loadFlowRun(data);
    if (!loaded) throw new Error(`flow-run reference could not be resolved (flow ${data.flowId})`);
    job = loaded;
  } else {
    job = data;
  }
  data = job;
  const ctx = data.context;
  let sendSeq = 0;
  const flowPorts: FlowPorts = {
    async sendMessage({ text, channel }) {
      await ports.enqueueSendMessage({
        workspaceId: ctx.workspaceId,
        channelAccountId: ctx.channelAccountId,
        channel: channel ?? ctx.channel,
        accountExternalId: ctx.accountExternalId,
        tokenVaultRef: ctx.tokenVaultRef,
        toExternalId: ctx.contactExternalId,
        text,
        country: ctx.country,
        idempotencyKey: `flow:${data.flow.id}:${ctx.contactId}:${sendSeq++}`,
      });
    },
    async scheduleDelay({ seconds, resumeState }) {
      await ports.scheduleFlowResume(
        { flow: data.flow, state: resumeState, event: { type: "resume" }, context: ctx },
        seconds,
      );
    },
    async httpWebhook({ url, method }) {
      await ports.httpFetch(url, method);
    },
    async setContactField({ field, value }) {
      await ports.setContactField(ctx.workspaceId, ctx.contactId, field, value);
    },
    async aiReply({ prompt, query }) {
      if (!ports.aiReply) return null;
      return ports.aiReply({ workspaceId: ctx.workspaceId, prompt, query });
    },
  };
  return runFlow(flowPorts, data.flow, data.state, data.event);
}
