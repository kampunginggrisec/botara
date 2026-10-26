import { rateWhatsAppMessage, type WhatsAppCategory } from "@botara/billing";
import { runFlow, type Flow, type FlowEvent, type FlowPorts, type FlowRunResult, type FlowState } from "@botara/flow-engine";
import {
  CHANNEL_CAPABILITIES, type ChannelKey, type RichBlock, type SendInput, type SendResult,
} from "@botara/channels";
import {
  buildVariableContext, ChannelInitiationError, ConsecutiveSendCapError, ConversationAddressMissingError,
  interpolate,
} from "@botara/shared";

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
  /** Rich block from a flow send_message node (rendered per channel by the adapter). */
  rich?: RichBlock;
  template?: {
    name: string;
    language: string;
    latestCategory: string;
    /** Provider template components (broadcast/sequence per-recipient params, variables #1). */
    components?: unknown[];
  };
  /** Recipient country (rating); defaults to ID for WhatsApp estimates. */
  country?: string;
  /** Explicit billing category; falls back to the template category, then "service". */
  category?: WhatsAppCategory;
  /** DB message row to update (inbox replies); absent for broadcast fan-out. */
  messageId?: string;
  /** Broadcast id this send belongs to (cost ledger reference + counters). */
  referenceId?: string;
  /**
   * Explicit broadcast context (package #4): when set together with
   * contactId, the send outcome is recorded on the broadcast_recipients
   * row for (broadcastId, contactId). referenceId alone is NOT used for
   * this - it stays a pure billing/counter reference.
   */
  broadcastId?: string;
  /** Botara contact id (flow runs), used by conversation-scoped send guards. */
  contactId?: string;
  /**
   * Provider conversation id for conversation-addressed channels
   * (TikTok). Flow runs resolve it from the conversation row; a send on
   * a reactive-only channel without it (or a comment-reply reference)
   * fails typed instead of guessing an address.
   */
  conversationExternalId?: string;
  /** TikTok comment-to-DM: high-intent comment id this send replies to. */
  commentReplyExternalId?: string;
  /** Stable idempotency key - retries with the same key never double-send. */
  idempotencyKey: string;
}

export interface BroadcastTarget {
  contactId: string;
  externalId: string;
  country?: string;
  /** Variable-interpolation context for this recipient (variables #1). */
  displayName?: string | null;
  channel?: string;
  tags?: string[];
  customFields?: Record<string, unknown>;
}

export interface BroadcastSnapshot {
  id: string;
  workspaceId: string;
  channelAccountId: string;
  channel: string;
  accountExternalId: string;
  /** Live account status at load time; fan-out skips non-"connected" accounts. */
  accountStatus?: string;
  tokenVaultRef?: string;
  template?: { name: string; language: string; latestCategory: string };
  /** Ordered per-recipient body parameter templates (variables #1). */
  templateParams?: string[];
  tag?: string;
  country?: string;
  /** Variable-interpolation context shared by all recipients. */
  workspaceName?: string | null;
  channelDisplayName?: string | null;
}

export interface FlowRunContext {
  workspaceId: string;
  channelAccountId: string;
  channel: string;
  accountExternalId: string;
  tokenVaultRef?: string;
  contactId: string;
  contactExternalId: string;
  /**
   * Botara conversation id this run belongs to (action steps -
   * assign / set_conversation_status / collect_input - act on it).
   * Optional: embedded jobs queued before package #3 lack it, and
   * conversation-scoped steps then degrade to run warnings.
   */
  conversationId?: string;
  /** Provider conversation id (TikTok), resolved from the conversation row. */
  conversationExternalId?: string;
  country?: string;
  /** Variable-interpolation context (variables #1), filled by loadFlowRun. */
  contactDisplayName?: string | null;
  contactTags?: string[];
  contactCustomFields?: Record<string, unknown>;
  workspaceName?: string | null;
  channelDisplayName?: string | null;
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
  /** Comment-automation context: the comment that triggered this run. */
  commentId?: string;
  /**
   * Comment-to-DM: the flow's first send_message was already delivered as
   * the private reply to the comment - loadFlowRun starts the run AFTER
   * that node so it is never sent twice.
   */
  skipFirstSendMessage?: boolean;
  /**
   * Collect-input resume (package #3): the run paused at a collect_input
   * node and a reply (or the timeout) claimed its wait. loadFlowRun
   * restarts from this state snapshot instead of the flow's start, with
   * `resumeVariables` (the captured answer) merged into the event.
   */
  resumeState?: FlowState;
  resumeVariables?: Record<string, string>;
}

/**
 * A claimed collect-input wait (package #3), as the repositories hand
 * it back: the marker row is DELETED by the claim, so whoever holds
 * this object is the wait's only resumer.
 */
export interface ClaimedFlowWait {
  id: string;
  workspaceId: string;
  conversationId: string;
  contactId: string;
  channelAccountId: string;
  flowId: string;
  variable: string;
  saveToContactField?: string | null;
  resumeState: FlowState;
}

/** Delayed-job marker enqueued alongside a wait that has a timeout. */
export interface FlowWaitTimeoutJobData {
  flowWaitTimeoutId: string;
}

export function isFlowWaitTimeout(data: unknown): data is FlowWaitTimeoutJobData {
  if (!data || typeof data !== "object") return false;
  return typeof (data as Record<string, unknown>).flowWaitTimeoutId === "string";
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
  /** Mark a broadcast terminally failed (capability-gate backstop). Optional. */
  updateBroadcastStatus?(broadcastId: string, status: string): Promise<void>;
  /**
   * Count a conversation's consecutive outbound messages since the
   * customer's last inbound one (the shared counter's data source).
   * Optional: without it, capability caps on sends are unenforced here
   * (the API reply route still enforces them synchronously).
   */
  countConsecutiveOutbound?(input: {
    workspaceId: string;
    channel: string;
    channelAccountId: string;
    contactExternalId: string;
    conversationExternalId?: string;
  }): Promise<number>;
  loadBroadcast(broadcastId: string): Promise<BroadcastSnapshot | null>;
  /**
   * Fan-out targets. Without `onlyContactIds`, the broadcast's audience
   * (its tag) decides; with it (resend-to-failed), exactly those
   * contacts are targeted, whatever the tag matches today.
   */
  listBroadcastTargets(broadcast: BroadcastSnapshot, onlyContactIds?: string[]): Promise<BroadcastTarget[]>;
  /**
   * Per-recipient records (package #4): create the pending rows for a
   * fan-out (idempotent). Optional - without it, sends proceed exactly
   * as before, just without per-recipient truth.
   */
  ensureBroadcastRecipients?(broadcastId: string, workspaceId: string, contactIds: string[]): Promise<void>;
  /**
   * Record one broadcast send's outcome on its recipient row (package
   * #4). Optional, same rationale as ensureBroadcastRecipients.
   */
  updateBroadcastRecipient?(input: {
    broadcastId: string;
    contactId: string;
    to: "sent" | "failed";
    providerMessageId?: string;
    error?: string;
  }): Promise<void>;
  /**
   * Live status of a channel account (the send choke point's disconnect
   * guard). Optional: without it, sends rely on the enqueue-time
   * snapshot alone (the API reply route still guards synchronously).
   * A null result (account purged) also blocks the send.
   */
  resolveAccountStatus?(channelAccountId: string): Promise<string | null>;
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
  // ---- flow action steps + collect_input (package #3), all optional:
  // processFlowRun wires whichever exist into the executor's ports;
  // a missing one degrades that step to a recorded action + warning.
  addContactTag?(workspaceId: string, contactId: string, tag: string): Promise<void>;
  removeContactTag?(workspaceId: string, contactId: string, tag: string): Promise<void>;
  /** False = the user is not a workspace member (executor warns). */
  assignConversation?(input: { workspaceId: string; conversationId: string; userId: string | null }): Promise<boolean>;
  setConversationStatus?(input: { workspaceId: string; conversationId: string; status: "resolved" | "open" }): Promise<void>;
  /** False = sequence missing / not enrollable (executor warns). */
  subscribeSequence?(input: { workspaceId: string; contactId: string; sequenceId: string }): Promise<boolean>;
  unsubscribeSequence?(input: { workspaceId: string; contactId: string; sequenceId: string }): Promise<void>;
  /**
   * Open a deal for the run's contact (package #6). False = the named
   * pipeline/stage does not exist or the pipeline has no stages (the
   * executor warns and the run continues).
   */
  createDeal?(input: {
    workspaceId: string; contactId: string; conversationId?: string;
    pipelineId?: string; stageId?: string; title: string; value?: number;
  }): Promise<boolean>;
  /**
   * Persist a collect-input wait for a paused run and arrange its
   * timeout (when the step configured one). The wait row is the only
   * durable trace of the paused run - resumes claim it by deletion.
   */
  scheduleFlowInputWait?(job: FlowRunJobData, wait: {
    nodeId: string | null;
    variable: string;
    saveToContactField?: string;
    timeoutHours?: number;
  }): Promise<void>;
  /** Atomically claim one wait by id (timeout path); null = already claimed / gone. */
  claimFlowWaitById?(waitId: string): Promise<ClaimedFlowWait | null>;
  /** Live conversation status for the timeout path's quiet-end check. */
  getConversationStatus?(conversationId: string): Promise<string | null>;
  /** Enqueue an id-based flow run (the timeout path's resume). */
  enqueueFlowRun?(ref: FlowRunRef): Promise<void>;
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
): Promise<{ externalMessageId: string; costUsd: number; skipped?: boolean }> {
  const category = billingCategory(data);
  // Per-recipient broadcast record (package #4): only broadcast fan-out
  // jobs carry both ids. Bookkeeping is best-effort, exactly like the
  // aggregate counters - a recipient-row failure never fails the send.
  const recordRecipient = async (to: "sent" | "failed", extra: { providerMessageId?: string; error?: string }) => {
    if (!data.broadcastId || !data.contactId || !ports.updateBroadcastRecipient) return;
    await ports.updateBroadcastRecipient({
      broadcastId: data.broadcastId, contactId: data.contactId, to, ...extra,
    }).catch(() => undefined);
  };
  try {
    // Disconnected-account guard: a soft-disconnected (or purged)
    // account must not send, whatever surface queued the job (flow,
    // sequence, broadcast, inbox reply). The job COMPLETES as a skip -
    // with the usual failure bookkeeping so inbox rows and broadcast
    // counters never get stuck - instead of crashing into retries.
    if (ports.resolveAccountStatus) {
      const accountStatus = await ports.resolveAccountStatus(data.channelAccountId);
      if (accountStatus !== "connected") {
        if (data.messageId) await ports.updateMessageStatus(data.messageId, "failed").catch(() => undefined);
        if (data.referenceId) await ports.incrementBroadcastCounts(data.referenceId, { failed: 1 }).catch(() => undefined);
        await recordRecipient("failed", { error: "Channel account is not connected." });
        return { externalMessageId: "", costUsd: 0, skipped: true };
      }
    }
    // Capability-driven send guards for reactive-only channels (TikTok),
    // enforced at this choke point because EVERY send (flow, sequence,
    // broadcast fan-out, comment DM) passes through it:
    //  - no provider conversation id and no comment-reply reference means
    //    the send cannot be addressed at all -> typed failure;
    //  - the consecutive-outbound cap (TikTok: 10) is counted live.
    const caps = CHANNEL_CAPABILITIES[data.channel as ChannelKey];
    if (caps?.canInitiate === false && !data.conversationExternalId && !data.commentReplyExternalId) {
      throw new ConversationAddressMissingError(data.channel);
    }
    if (caps?.maxConsecutiveOutbound && ports.countConsecutiveOutbound) {
      const consecutive = await ports.countConsecutiveOutbound({
        workspaceId: data.workspaceId,
        channel: data.channel,
        channelAccountId: data.channelAccountId,
        contactExternalId: data.toExternalId,
        conversationExternalId: data.conversationExternalId,
      });
      if (consecutive >= caps.maxConsecutiveOutbound) {
        throw new ConsecutiveSendCapError(data.channel, caps.maxConsecutiveOutbound, consecutive);
      }
    }
    const result = await ports.send(data.channel, {
      account: { id: data.channelAccountId, externalId: data.accountExternalId, tokenVaultRef: data.tokenVaultRef },
      toExternalId: data.toExternalId,
      text: data.text,
      rich: data.rich,
      template: data.template,
      conversationExternalId: data.conversationExternalId,
      commentReplyExternalId: data.commentReplyExternalId,
      idempotencyKey: data.idempotencyKey,
    });
    if (result.warnings && result.warnings.length > 0) {
      console.warn(`[worker] send-message ${data.idempotencyKey}: rich block degraded (${result.warnings.join(", ")})`);
    }
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
    await recordRecipient("sent", { providerMessageId: result.externalMessageId });
    return { externalMessageId: result.externalMessageId, costUsd };
  } catch (err) {
    if (data.messageId) await ports.updateMessageStatus(data.messageId, "failed").catch(() => undefined);
    if (data.referenceId) await ports.incrementBroadcastCounts(data.referenceId, { failed: 1 }).catch(() => undefined);
    await recordRecipient("failed", { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/**
 * Broadcast fan-out job (package #4 adds the resend mode): a plain
 * `{ broadcastId }` fans out to the broadcast's whole audience; a job
 * carrying `contactIds` (from POST /broadcasts/:id/resend-failed) sends
 * ONLY to those contacts - the resend re-renders the original template
 * + params per recipient exactly like the first pass, but its send jobs
 * carry a `:resend:{token}` idempotency suffix because BullMQ keeps the
 * original `${broadcastId}:${contactId}` jobs and would silently drop a
 * same-id re-add.
 */
export interface BroadcastJobData {
  broadcastId: string;
  /** Resend mode: restrict the fan-out to these contacts. */
  contactIds?: string[];
  /** Resend mode: per-request token making the send job ids unique. */
  resendToken?: string;
}

/**
 * "broadcast": fan-out. For each target contact, enqueue one send-message
 * job whose idempotency key is the stable `${broadcastId}:${contactId}` -
 * re-running the fan-out (retry, crash recovery) can never double-send.
 * A pending broadcast_recipients row is ensured per target BEFORE the
 * send is enqueued, so the send outcome always has a row to land on.
 */
export async function processBroadcast(
  ports: WorkerPorts,
  data: BroadcastJobData,
): Promise<{ enqueued: number }> {
  const broadcast = await ports.loadBroadcast(data.broadcastId);
  if (!broadcast) throw new Error(`Broadcast ${data.broadcastId} not found`);
  // Backstop for the API create gate: a broadcast row that exists for a
  // channel that cannot broadcast (reactive-only, e.g. TikTok) fails
  // terminally here instead of fanning out sends the provider forbids.
  const caps = CHANNEL_CAPABILITIES[broadcast.channel as ChannelKey];
  if (caps && !caps.canBroadcast) {
    await ports.updateBroadcastStatus?.(broadcast.id, "failed").catch(() => undefined);
    throw new ChannelInitiationError(broadcast.channel, "Broadcasts");
  }
  // A broadcast whose account was disconnected after creation fans out
  // nothing: terminally failed (like the capability backstop) and the
  // job completes - the per-send guard in processSendMessage remains
  // the backstop for jobs queued before the disconnect.
  if (broadcast.accountStatus !== undefined && broadcast.accountStatus !== "connected") {
    await ports.updateBroadcastStatus?.(broadcast.id, "failed").catch(() => undefined);
    return { enqueued: 0 };
  }
  const resendOnly = data.contactIds !== undefined;
  const targets = await ports.listBroadcastTargets(broadcast, data.contactIds);
  if (ports.ensureBroadcastRecipients && targets.length > 0) {
    await ports.ensureBroadcastRecipients(
      broadcast.id, broadcast.workspaceId, targets.map((t) => t.contactId),
    );
  }
  const paramTemplates = broadcast.templateParams ?? [];
  for (const target of targets) {
    // Per-recipient template parameters (variables #1): each param
    // template renders against THIS recipient's contact, then rides the
    // send job as the template's body components - the WhatsApp adapter
    // passes components through to Meta verbatim. No param schema is
    // validated here (template rows carry none); a wrong count surfaces
    // as a per-recipient provider error in the send processor, as before.
    let template: SendMessageJobData["template"] = broadcast.template;
    if (template && paramTemplates.length > 0) {
      const varCtx = buildVariableContext({
        contact: {
          displayName: target.displayName,
          externalId: target.externalId,
          channel: target.channel ?? broadcast.channel,
          tags: target.tags,
          customFields: target.customFields,
        },
        workspaceName: broadcast.workspaceName,
        channelAccount: { displayName: broadcast.channelDisplayName, channel: broadcast.channel },
      });
      const parameters = paramTemplates.map((paramTemplate) => {
        const rendered = interpolate(paramTemplate, varCtx);
        if (rendered.warnings.length > 0) {
          console.warn(
            `[worker] broadcast ${broadcast.id} -> contact ${target.contactId}: unknown variables rendered empty (${rendered.warnings.map((w) => w.path).join(", ")})`,
          );
        }
        return { type: "text", text: rendered.text };
      });
      template = { ...template, components: [{ type: "body", parameters }] };
    }
    await ports.enqueueSendMessage({
      workspaceId: broadcast.workspaceId,
      channelAccountId: broadcast.channelAccountId,
      channel: broadcast.channel,
      accountExternalId: broadcast.accountExternalId,
      tokenVaultRef: broadcast.tokenVaultRef,
      toExternalId: target.externalId,
      template,
      country: target.country ?? broadcast.country,
      referenceId: broadcast.id,
      broadcastId: broadcast.id,
      contactId: target.contactId,
      idempotencyKey: resendOnly
        ? `${broadcast.id}:${target.contactId}:resend:${data.resendToken ?? "1"}`
        : `${broadcast.id}:${target.contactId}`,
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
  // Send idempotency sequence: continuous across the run's pause/resume
  // segments. The incoming state's stamp (written into every pause
  // snapshot by the scheduleDelay / awaitInput ports below) seeds the
  // counter; a fresh run starts at 0. Restarting at 0 on a resume would
  // rebuild an earlier segment's `flow:...:{seq}` keys, and the
  // send-message pipeline would dedupe the resumed run's sends away -
  // the run would "complete" while its messages never leave.
  let sendSeq = data.state?.sendSeq ?? 0;
  const flowPorts: FlowPorts = {
    async sendMessage({ text, channel, rich }) {
      await ports.enqueueSendMessage({
        workspaceId: ctx.workspaceId,
        channelAccountId: ctx.channelAccountId,
        channel: channel ?? ctx.channel,
        accountExternalId: ctx.accountExternalId,
        tokenVaultRef: ctx.tokenVaultRef,
        toExternalId: ctx.contactExternalId,
        contactId: ctx.contactId,
        conversationExternalId: ctx.conversationExternalId,
        text,
        rich,
        country: ctx.country,
        idempotencyKey: `flow:${data.flow.id}:${ctx.contactId}:${sendSeq++}`,
      });
    },
    async scheduleDelay({ seconds, resumeState }) {
      await ports.scheduleFlowResume(
        // Stamp the send counter into the snapshot: the delayed job IS
        // this object, and the resumed segment seeds its counter from it.
        { flow: data.flow, state: { ...resumeState, sendSeq }, event: { type: "resume" }, context: ctx },
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
    // Action steps (package #3): wired only when the matching worker
    // port exists - the executor degrades unwired steps to a recorded
    // action + warning. Conversation-scoped steps also warn (via a
    // false report) when the job carries no conversation id.
    ...(ports.addContactTag ? {
      addTag: async ({ tag }: { tag: string }) => { await ports.addContactTag!(ctx.workspaceId, ctx.contactId, tag); },
    } : {}),
    ...(ports.removeContactTag ? {
      removeTag: async ({ tag }: { tag: string }) => { await ports.removeContactTag!(ctx.workspaceId, ctx.contactId, tag); },
    } : {}),
    ...(ports.assignConversation ? {
      assignConversation: async ({ userId }: { userId: string | null }) => {
        if (!ctx.conversationId) return false;
        return ports.assignConversation!({ workspaceId: ctx.workspaceId, conversationId: ctx.conversationId, userId });
      },
    } : {}),
    ...(ports.setConversationStatus ? {
      setConversationStatus: async ({ status }: { status: "resolved" | "open" }) => {
        if (!ctx.conversationId) throw new Error("flow run carries no conversation");
        await ports.setConversationStatus!({ workspaceId: ctx.workspaceId, conversationId: ctx.conversationId, status });
      },
    } : {}),
    ...(ports.subscribeSequence ? {
      subscribeSequence: async ({ sequenceId }: { sequenceId: string }) =>
        ports.subscribeSequence!({ workspaceId: ctx.workspaceId, contactId: ctx.contactId, sequenceId }),
    } : {}),
    ...(ports.unsubscribeSequence ? {
      unsubscribeSequence: async ({ sequenceId }: { sequenceId: string }) => {
        await ports.unsubscribeSequence!({ workspaceId: ctx.workspaceId, contactId: ctx.contactId, sequenceId });
      },
    } : {}),
    ...(ports.createDeal ? {
      createDeal: async (input: { pipelineId?: string; stageId?: string; title: string; value?: number }) =>
        ports.createDeal!({
          workspaceId: ctx.workspaceId, contactId: ctx.contactId,
          ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
          ...input,
        }),
    } : {}),
    ...(ports.scheduleFlowInputWait ? {
      awaitInput: async (input: {
        nodeId: string | null; variable: string; saveToContactField?: string;
        timeoutHours?: number; resumeState: FlowState;
      }) => {
        if (!ctx.conversationId) throw new Error("flow run carries no conversation");
        await ports.scheduleFlowInputWait!(
          // Same send-counter stamp as scheduleDelay: the wait row's
          // resumeState is what the claiming resumer restarts from.
          // (The executor sends the prompt BEFORE this port runs, so
          // the prompt's own send is already counted in `sendSeq`.)
          { flow: data.flow, state: { ...input.resumeState, sendSeq }, event: { type: "awaiting-input" }, context: ctx },
          {
            nodeId: input.nodeId, variable: input.variable,
            saveToContactField: input.saveToContactField, timeoutHours: input.timeoutHours,
          },
        );
      },
    } : {}),
  };
  // Variable interpolation (variables #1): the executor renders every
  // send_message against this context; the run's own variables (trigger
  // data + contact fields the dispatcher merged) form the `vars` root.
  const interpolation = buildVariableContext({
    contact: {
      displayName: ctx.contactDisplayName,
      externalId: ctx.contactExternalId,
      channel: ctx.channel,
      tags: ctx.contactTags,
      customFields: ctx.contactCustomFields,
    },
    workspaceName: ctx.workspaceName,
    channelAccount: { displayName: ctx.channelDisplayName, channel: ctx.channel },
  });
  const result = await runFlow(flowPorts, data.flow, data.state, data.event, { interpolation });
  if (result.warnings.length > 0) {
    console.warn(
      `[worker] flow ${data.flow.id} -> contact ${ctx.contactId}: unknown variables rendered empty (${result.warnings.map((w) => w.path).join(", ")})`,
    );
  }
  if (result.actionWarnings.length > 0) {
    console.warn(
      `[worker] flow ${data.flow.id} -> contact ${ctx.contactId}: action steps skipped (${result.actionWarnings.join("; ")})`,
    );
  }
  return result;
}

/**
 * "flow-run" timeout marker for a collect-input wait (package #3):
 * the delayed companion job of a wait created with `timeoutHours`.
 * Claiming is the race guard - when the contact's reply already
 * claimed the wait (dispatcher), this is a no-op; when the claim
 * succeeds here, the run resumes with an EMPTY captured value and the
 * reply (if it ever comes) falls back to normal trigger matching.
 * A wait whose conversation has since resolved ends quietly: the run
 * is dropped, never resumed into a closed thread.
 */
export async function processFlowWaitTimeout(
  ports: WorkerPorts,
  waitId: string,
): Promise<{ resumed: boolean; reason?: string }> {
  if (!ports.claimFlowWaitById || !ports.enqueueFlowRun) {
    return { resumed: false, reason: "ports-unwired" };
  }
  const wait = await ports.claimFlowWaitById(waitId);
  if (!wait) return { resumed: false, reason: "already-claimed" };
  const status = ports.getConversationStatus
    ? await ports.getConversationStatus(wait.conversationId)
    : null;
  if (status === "resolved") {
    console.log(
      `[worker] flow wait ${waitId}: conversation ${wait.conversationId} resolved while waiting - run ended quietly`,
    );
    return { resumed: false, reason: "conversation-resolved" };
  }
  console.warn(
    `[worker] flow wait ${waitId}: no reply within the timeout - resuming flow ${wait.flowId} with an empty {{vars.${wait.variable}}}`,
  );
  await ports.enqueueFlowRun({
    flowId: wait.flowId,
    workspaceId: wait.workspaceId,
    contactId: wait.contactId,
    conversationId: wait.conversationId,
    channelAccountId: wait.channelAccountId,
    resumeState: wait.resumeState,
    resumeVariables: { [wait.variable]: "" },
  });
  return { resumed: true };
}
