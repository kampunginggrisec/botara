import {
  addContactTag, advanceBroadcastRecipientByProviderId, advanceConversationLastUserMessage, advanceMessageStatusByProviderId,
  broadcastRecipientTransition, claimFlowWaitByConversation, createContact, createConversation, insertConversation, createMessage,
  findChannelAccountByExternal, findMessageByExternalId, findOpenConversation,
  getContactByExternal, getGrowthLinkBySlug, incrementGrowthLinkConversions,
  isCommentProcessed, listActiveFlows, listConnectedAccountsByChannel,
  listGrowthLinksByAccount, markBroadcastRecipientReplied, messageStatusTransition, touchConversationLastUserMessage, updateContact, updateConversationExternalId,
  upsertContactByExternal, type Database,
} from "@botara/db";
import {
  commentTriggerConfig, flowTriggerMatches, type FlowState, type FlowTrigger,
} from "@botara/flow-engine";
import type { InboundEvent, MessageMedia } from "@botara/channels";
import { webhookMessagePreview, type OutboundWebhookEvent } from "@botara/shared";
import type { RealtimePublisher } from "./realtime-publish";

/**
 * Inbound flow dispatcher (Fase 4, extended by the adopted-features
 * package).
 *
 * Channel webhooks hand their parsed events here AFTER the event sink. For
 * each event the dispatcher:
 *   1. resolves the channel account -> workspace,
 *   2. persists the message into the inbox (contact/conversation/message,
 *      deduplicated on the provider message id for webhook redeliveries),
 *   3. applies GROWTH attribution when the event carries a growth-link
 *      slug (Messenger ref, Telegram /start payload, WhatsApp ctwa
 *      referral): the contact is tagged `growth:<slug>`, conversions
 *      increment once per contact, and a bound flow runs INSTEAD of
 *      keyword matching,
 *   4. matches ACTIVE flows whose keyword/postback trigger fits, and
 *      enqueues one flow-run job per match.
 *
 * Between 2 and 3 sits collect-input capture (package #3): when a flow
 * run is waiting at a collect_input node on the conversation, the
 * newly persisted message is claimed as that run's answer (atomic
 * claim on the wait row; the worker's timeout job races the same
 * claim) and a resume job is enqueued INSTEAD of steps 3-4 - a
 * captured reply never double-fires triggers.
 *
 * Comment events (Instagram + Messenger) match flows with a
 * "comment_keyword" trigger: the dispatcher enqueues a "comment-action"
 * job (the worker performs the public reply / hide / private reply), so
 * webhooks still answer 200 fast. Duplicate comments are suppressed here
 * (cheap check) AND in the worker (atomic claim).
 *
 * Webchat is the one channel NOT routed through dispatch(): the public
 * widget route persists visitor messages itself, then calls
 * dispatchPersistedWebchat() for trigger evaluation only (no double
 * persistence) - typed text matches keyword triggers; widget button
 * clicks match postback triggers by payload and keyword triggers by the
 * button's title.
 *
 * WhatsApp coexistence events are handled here too, each with its own
 * discipline: Business-app echoes persist as outbound inbox messages
 * (never flow-triggering, never window-opening, never billed),
 * app-state syncs upsert contacts by phone, and history backfill
 * persists with original provider timestamps, deduped on the wamid.
 *
 * Inbound MEDIA (any of the paths above): when a media port is wired,
 * the bytes behind a message's media reference are copied into Botara
 * storage BEFORE persistence and the row records mediaUrls/mediaKeys -
 * provider media ids/URLs expire, so ingest is the only moment the
 * bytes are guaranteed reachable. The copy is strictly best-effort:
 * any failure degrades to the caption-only row that used to be all
 * there was, and dispatch still succeeds.
 *
 * Persistence goes through the DispatchStore port: production wires the
 * Drizzle repositories, tests wire the in-memory store below.
 *
 * Webhooks must always acknowledge the provider: this port NEVER throws -
 * failures are logged as structured lines and swallowed.
 */

export interface FlowRunJobPayload {
  flowId: string;
  workspaceId: string;
  contactId: string;
  conversationId: string;
  channelAccountId: string;
  triggerText?: string;
  /**
   * Collect-input resume (package #3): set when this job resumes a run
   * that was waiting at a collect_input node - the worker restarts from
   * `resumeState` with `resumeVariables` (the captured answer) merged.
   */
  resumeState?: FlowState;
  resumeVariables?: Record<string, string>;
}

/**
 * A claimed collect-input wait (package #3): the marker row is deleted
 * by the claim, so the holder is the wait's ONLY resumer - the reply
 * path here and the worker's timeout job race on the same claim.
 */
export interface ClaimedFlowWait {
  id: string;
  workspaceId: string;
  contactId: string;
  channelAccountId: string;
  flowId: string;
  variable: string;
  saveToContactField?: string | null;
  resumeState: FlowState;
}

export interface FlowRunEnqueuer {
  enqueueFlowRun(job: FlowRunJobPayload): Promise<unknown>;
}

/** One comment-automation job: everything the worker needs, ids + config. */
export interface CommentActionJobPayload {
  workspaceId: string;
  channelAccountId: string;
  channel: string;
  accountExternalId: string;
  tokenVaultRef?: string;
  authMode?: string;
  flowId: string;
  commentExternalId: string;
  postExternalId?: string;
  authorExternalId: string;
  commentText?: string;
  publicReplyText?: string;
  autoHide?: boolean;
  privateText?: string;
}

export interface CommentActionEnqueuer {
  enqueueCommentAction(job: CommentActionJobPayload): Promise<unknown>;
}

/**
 * Outbound event webhooks (package #10): after the dispatcher persists
 * something noteworthy, the emitter fans it out to the workspace's
 * subscribed endpoints (one delivery row + one queue job each).
 * CONTRACT: implementations guard internally and the dispatcher guards
 * again - a webhook failure (DB, Redis, anything) must never break
 * message processing or delay a provider acknowledgment.
 */
export interface OutboundWebhookEmitter {
  emit(input: {
    workspaceId: string;
    type: OutboundWebhookEvent;
    data: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * A webchat visitor message that the public widget route has ALREADY
 * persisted (typed message or button click). The dispatcher must NOT
 * persist it again - it only evaluates flow triggers and enqueues runs.
 */
export interface PersistedWebchatInput {
  workspaceId: string;
  channelAccountId: string;
  contactId: string;
  conversationId: string;
  /** Message text (typed messages) or the tapped button's title (clicks). */
  text?: string;
  /** The tapped button's payload code (clicks only). */
  buttonPayload?: string;
}

export interface InboundFlowDispatcher {
  dispatch(events: InboundEvent[]): Promise<void>;
  dispatchPersistedWebchat(input: PersistedWebchatInput): Promise<void>;
}

/** References to one inbound media item copied into Botara's storage. */
export interface StoredInboundMedia {
  /** Public URLs the SPA renders (empty when no public base is configured). */
  urls: string[];
  /** Storage object keys backing the URLs (the durable reference). */
  keys: string[];
}

/**
 * Inbound media pipeline port: fetch the bytes behind a normalized
 * media reference (per channel, via the channel adapter or the
 * attachment URL) and store them permanently, returning the references
 * to persist on the message row. Provider media ids/URLs expire, so
 * the copy must happen at ingest.
 *
 * CONTRACT: implementations NEVER throw and return null on ANY failure
 * (storage unconfigured, provider error, oversize) - the dispatcher
 * then persists the message caption-only, exactly as before this
 * pipeline existed. A media failure must never lose a message or fail
 * a webhook.
 */
export interface InboundMediaPort {
  fetchAndStore(input: {
    workspaceId: string;
    account: DispatchAccount;
    channel: string;
    media: MessageMedia;
    messageExternalId: string;
    /** Provider conversation id (TikTok media download needs it). */
    conversationExternalId?: string;
  }): Promise<StoredInboundMedia | null>;
}

// ------------------------------------------------------------ store port

export interface DispatchAccount {
  id: string;
  workspaceId: string;
  channel: string;
  externalId: string;
  status: string;
  tokenVaultRef?: string | null;
  authMode?: string | null;
}

export interface DispatchContact {
  id: string;
  tags: string[];
  displayName?: string | null;
}

export interface DispatchGrowthLink {
  id: string;
  workspaceId: string;
  channelAccountId: string;
  slug: string;
  boundFlowId: string | null;
}

export interface DispatchStore {
  findAccountByExternal(channel: string, externalId: string): Promise<DispatchAccount | null>;
  listConnectedAccountsByChannel(channel: string): Promise<DispatchAccount[]>;
  getContactByExternal(workspaceId: string, channel: string, externalId: string): Promise<DispatchContact | null>;
  createContact(input: { workspaceId: string; channel: string; externalId: string; displayName?: string }): Promise<DispatchContact>;
  /** Insert-or-update one contact from a coexistence state sync (name refresh). */
  upsertSyncedContact(input: { workspaceId: string; channel: string; externalId: string; displayName?: string }): Promise<void>;
  findOpenConversation(input: { workspaceId: string; channelAccountId: string; contactId: string }): Promise<{ id: string; externalId?: string | null } | null>;
  /**
   * Create a conversation. `createdNew` is false when the repository's
   * race backstop (#0) reused a concurrent winner's thread instead of
   * inserting - outbound webhooks (#10) announce only genuine creations.
   */
  createConversation(input: { workspaceId: string; channelAccountId: string; contactId: string; externalId?: string }): Promise<{ id: string; externalId?: string | null; createdNew: boolean }>;
  /**
   * Backfill a conversation's provider id (TikTok conversation_id) when
   * an inbound event carries one the stored conversation does not have
   * yet - e.g. the conversation was opened by a comment-to-DM and the
   * customer has now sent their first real DM. Optional: stores that
   * cannot backfill simply never resolve TikTok sends for such
   * conversations (the send path fails typed, never guesses).
   */
  setConversationExternalId?(conversationId: string, externalId: string): Promise<void>;
  findMessageByExternalId(conversationId: string, externalId: string): Promise<{ id: string } | null>;
  createMessage(input: { conversationId: string; direction: "in" | "out"; type: string; body?: string; externalId?: string; replyToExternalId?: string; status: string; createdAt?: Date; mediaUrls?: string[]; mediaKeys?: string[] }): Promise<{ id: string }>;
  touchConversationLastUserMessage(conversationId: string, at: Date): Promise<void>;
  /** Forward-only window anchor move, for backfilled inbound messages. */
  advanceConversationLastUserMessage(conversationId: string, at: Date): Promise<void>;
  listActiveFlows(workspaceId: string): Promise<Array<{ id: string; trigger: FlowTrigger }>>;
  findGrowthLinkBySlug(slug: string): Promise<DispatchGrowthLink | null>;
  listGrowthLinksByAccount(channelAccountId: string): Promise<DispatchGrowthLink[]>;
  incrementGrowthConversions(linkId: string): Promise<void>;
  /** Returns true when the tag was newly added (first attribution). */
  addContactTag(workspaceId: string, contactId: string, tag: string): Promise<boolean>;
  isCommentProcessed(input: { channelAccountId: string; commentExternalId: string; flowId: string }): Promise<boolean>;
  /**
   * Atomically claim the oldest collect-input wait on a conversation
   * (package #3): deletes the marker and returns it, or null when no
   * run is waiting. Racing the worker's timeout claim is safe - the
   * row can only be claimed once.
   */
  claimFlowWait(conversationId: string): Promise<ClaimedFlowWait | null>;
  /** Persist one contact custom field (collect_input's save-to-field). */
  setContactField(workspaceId: string, contactId: string, field: string, value: string): Promise<void>;
  /**
   * Broadcast recipient mirror (package #4): advance the recipient row
   * carrying this provider message id from a provider status webhook.
   * Optional: stores without recipient tracking simply skip it. Returns
   * the advanced row's identity, or null when nothing moved (package
   * #10 emits message.status only for real advancements).
   */
  advanceBroadcastRecipientByProviderId?(input: {
    workspaceId: string; providerMessageId: string;
    status: "sent" | "delivered" | "read" | "failed"; at: Date; error?: string;
  }): Promise<{ recipientId: string; broadcastId: string; contactId: string } | null>;
  /**
   * Inbox message mirror (package #8): advance the outbound inbox
   * message row carrying this provider message id (delivered/read
   * receipts). Optional, same rationale as above; same return contract.
   */
  advanceMessageStatusByProviderId?(input: {
    workspaceId: string; providerMessageId: string;
    status: "sent" | "delivered" | "read" | "failed"; at: Date; error?: string;
  }): Promise<{ messageId: string; conversationId: string } | null>;
  /**
   * Broadcast recipient mirror (package #4): attribute a contact's
   * inbound message as a reply to their latest still-open broadcast.
   * Optional, same rationale as above.
   */
  markBroadcastRecipientReplied?(input: { workspaceId: string; contactId: string; at: Date }): Promise<void>;
}

/** Production DispatchStore over the Drizzle repositories. */
export function createDbDispatchStore(getDatabase: () => Database): DispatchStore {
  const toAccount = (row: {
    id: string; workspaceId: string; channel: string; externalId: string; status: string;
    tokenVaultRef: string | null; authMode: string | null;
  }): DispatchAccount => ({ ...row });
  return {
    async findAccountByExternal(channel, externalId) {
      const row = await findChannelAccountByExternal(getDatabase(), channel, externalId);
      return row ? toAccount(row) : null;
    },
    async listConnectedAccountsByChannel(channel) {
      const rows = await listConnectedAccountsByChannel(getDatabase(), channel);
      return rows.map(toAccount);
    },
    async getContactByExternal(workspaceId, channel, externalId) {
      const row = await getContactByExternal(getDatabase(), workspaceId, channel, externalId);
      return row ? { id: row.id, tags: (row.tags as string[]) ?? [], displayName: row.displayName } : null;
    },
    async createContact(input) {
      const row = await createContact(getDatabase(), input);
      return { id: row.id, tags: (row.tags as string[]) ?? [], displayName: row.displayName };
    },
    async upsertSyncedContact(input) {
      await upsertContactByExternal(getDatabase(), input, "update");
    },
    async findOpenConversation(input) {
      const row = await findOpenConversation(getDatabase(), input);
      return row ? { id: row.id, externalId: row.externalId } : null;
    },
    async createConversation(input) {
      const { row, created } = await insertConversation(getDatabase(), input);
      return { id: row.id, externalId: row.externalId, createdNew: created };
    },
    async setConversationExternalId(conversationId, externalId) {
      await updateConversationExternalId(getDatabase(), conversationId, externalId);
    },
    async findMessageByExternalId(conversationId, externalId) {
      const row = await findMessageByExternalId(getDatabase(), conversationId, externalId);
      return row ? { id: row.id } : null;
    },
    async createMessage(input) {
      const row = await createMessage(getDatabase(), input);
      return { id: row.id };
    },
    async touchConversationLastUserMessage(conversationId, at) {
      await touchConversationLastUserMessage(getDatabase(), conversationId, at);
    },
    async advanceConversationLastUserMessage(conversationId, at) {
      await advanceConversationLastUserMessage(getDatabase(), conversationId, at);
    },
    async listActiveFlows(workspaceId) {
      const rows = await listActiveFlows(getDatabase(), workspaceId);
      return rows.map((row) => ({ id: row.id, trigger: row.trigger as FlowTrigger }));
    },
    async findGrowthLinkBySlug(slug) {
      const row = await getGrowthLinkBySlug(getDatabase(), slug);
      return row
        ? { id: row.id, workspaceId: row.workspaceId, channelAccountId: row.channelAccountId, slug: row.slug, boundFlowId: row.boundFlowId }
        : null;
    },
    async listGrowthLinksByAccount(channelAccountId) {
      const rows = await listGrowthLinksByAccount(getDatabase(), channelAccountId);
      return rows.map((row) => ({
        id: row.id, workspaceId: row.workspaceId, channelAccountId: row.channelAccountId,
        slug: row.slug, boundFlowId: row.boundFlowId,
      }));
    },
    async incrementGrowthConversions(linkId) {
      await incrementGrowthLinkConversions(getDatabase(), linkId);
    },
    async addContactTag(workspaceId, contactId, tag) {
      return addContactTag(getDatabase(), workspaceId, contactId, tag);
    },
    async isCommentProcessed(input) {
      return isCommentProcessed(getDatabase(), input);
    },
    async claimFlowWait(conversationId) {
      const row = await claimFlowWaitByConversation(getDatabase(), conversationId);
      return row
        ? {
            id: row.id, workspaceId: row.workspaceId, contactId: row.contactId,
            channelAccountId: row.channelAccountId, flowId: row.flowId,
            variable: row.variable, saveToContactField: row.saveToContactField,
            resumeState: row.resumeState as unknown as FlowState,
          }
        : null;
    },
    async setContactField(workspaceId, contactId, field, value) {
      await updateContact(getDatabase(), workspaceId, contactId, { customFields: { [field]: value } });
    },
    async advanceBroadcastRecipientByProviderId(input) {
      return advanceBroadcastRecipientByProviderId(getDatabase(), {
        workspaceId: input.workspaceId,
        providerMessageId: input.providerMessageId,
        to: input.status,
        at: input.at,
        ...(input.error !== undefined ? { error: input.error } : {}),
      });
    },
    async advanceMessageStatusByProviderId(input) {
      return advanceMessageStatusByProviderId(getDatabase(), {
        workspaceId: input.workspaceId,
        providerMessageId: input.providerMessageId,
        to: input.status,
      });
    },
    async markBroadcastRecipientReplied(input) {
      await markBroadcastRecipientReplied(getDatabase(), input);
    },
  };
}

/** In-memory DispatchStore for tests (and only tests). */
export class InMemoryDispatchStore implements DispatchStore {
  readonly accounts: DispatchAccount[] = [];
  readonly contacts = new Map<string, DispatchContact & { workspaceId: string; channel: string; externalId: string; customFields: Record<string, unknown> }>();
  /** Collect-input waits in creation order (claim = oldest first). */
  readonly flowWaits: Array<ClaimedFlowWait & { conversationId: string }> = [];
  readonly conversations = new Map<string, { id: string; workspaceId: string; channelAccountId: string; contactId: string; externalId?: string | null; lastUserMessageAt?: string }>();
  readonly messages: Array<{ id?: string; conversationId: string; externalId?: string; replyToExternalId?: string; body?: string; direction: string; type: string; status?: string; createdAt?: string; mediaUrls?: string[]; mediaKeys?: string[] }> = [];
  readonly flows: Array<{ id: string; workspaceId: string; trigger: FlowTrigger }> = [];
  readonly growthLinks: DispatchGrowthLink[] = [];
  readonly conversions = new Map<string, number>();
  readonly processedComments = new Set<string>();

  private contactKey(workspaceId: string, channel: string, externalId: string) {
    return `${workspaceId}:${channel}:${externalId}`;
  }

  async findAccountByExternal(channel: string, externalId: string) {
    return this.accounts.find((a) => a.channel === channel && a.externalId === externalId) ?? null;
  }

  async listConnectedAccountsByChannel(channel: string) {
    return this.accounts.filter((a) => a.channel === channel && a.status === "connected");
  }

  async getContactByExternal(workspaceId: string, channel: string, externalId: string) {
    return this.contacts.get(this.contactKey(workspaceId, channel, externalId)) ?? null;
  }

  async createContact(input: { workspaceId: string; channel: string; externalId: string; displayName?: string }) {
    const contact = { id: crypto.randomUUID(), tags: [] as string[], customFields: {} as Record<string, unknown>, ...input };
    this.contacts.set(this.contactKey(input.workspaceId, input.channel, input.externalId), contact);
    return contact;
  }

  async upsertSyncedContact(input: { workspaceId: string; channel: string; externalId: string; displayName?: string }) {
    const existing = await this.getContactByExternal(input.workspaceId, input.channel, input.externalId);
    if (!existing) {
      await this.createContact(input);
      return;
    }
    if (input.displayName) {
      const row = this.contacts.get(this.contactKey(input.workspaceId, input.channel, input.externalId));
      if (row) row.displayName = input.displayName;
    }
  }

  async findOpenConversation(input: { workspaceId: string; channelAccountId: string; contactId: string }) {
    return [...this.conversations.values()].find(
      (cv) => cv.workspaceId === input.workspaceId && cv.channelAccountId === input.channelAccountId && cv.contactId === input.contactId,
    ) ?? null;
  }

  async createConversation(input: { workspaceId: string; channelAccountId: string; contactId: string; externalId?: string }) {
    const conversation = { id: crypto.randomUUID(), ...input };
    this.conversations.set(conversation.id, conversation);
    return { ...conversation, createdNew: true };
  }

  async setConversationExternalId(conversationId: string, externalId: string) {
    const conversation = this.conversations.get(conversationId);
    if (conversation && !conversation.externalId) conversation.externalId = externalId;
  }

  async findMessageByExternalId(conversationId: string, externalId: string) {
    const found = this.messages.find((m) => m.conversationId === conversationId && m.externalId === externalId);
    return found ? { id: externalId } : null;
  }

  async createMessage(input: { conversationId: string; direction: "in" | "out"; type: string; body?: string; externalId?: string; replyToExternalId?: string; status: string; createdAt?: Date; mediaUrls?: string[]; mediaKeys?: string[] }) {
    const id = crypto.randomUUID();
    const { createdAt, ...rest } = input;
    this.messages.push({ id, ...rest, createdAt: (createdAt ?? new Date()).toISOString() });
    return { id };
  }

  async touchConversationLastUserMessage(conversationId: string, at: Date) {
    const conversation = this.conversations.get(conversationId);
    if (conversation) conversation.lastUserMessageAt = at.toISOString();
  }

  async advanceConversationLastUserMessage(conversationId: string, at: Date) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    if (!conversation.lastUserMessageAt || new Date(conversation.lastUserMessageAt) < at) {
      conversation.lastUserMessageAt = at.toISOString();
    }
  }

  async listActiveFlows(workspaceId: string) {
    return this.flows.filter((f) => f.workspaceId === workspaceId).map((f) => ({ id: f.id, trigger: f.trigger }));
  }

  async findGrowthLinkBySlug(slug: string) {
    return this.growthLinks.find((l) => l.slug === slug) ?? null;
  }

  async listGrowthLinksByAccount(channelAccountId: string) {
    return this.growthLinks.filter((l) => l.channelAccountId === channelAccountId);
  }

  async incrementGrowthConversions(linkId: string) {
    this.conversions.set(linkId, (this.conversions.get(linkId) ?? 0) + 1);
  }

  async addContactTag(_workspaceId: string, contactId: string, tag: string) {
    const contact = [...this.contacts.values()].find((ct) => ct.id === contactId);
    if (!contact || contact.tags.includes(tag)) return false;
    contact.tags.push(tag);
    return true;
  }

  async isCommentProcessed(input: { channelAccountId: string; commentExternalId: string; flowId: string }) {
    return this.processedComments.has(`${input.channelAccountId}:${input.commentExternalId}:${input.flowId}`);
  }

  async claimFlowWait(conversationId: string) {
    const idx = this.flowWaits.findIndex((w) => w.conversationId === conversationId);
    if (idx < 0) return null;
    const [wait] = this.flowWaits.splice(idx, 1);
    return wait!;
  }

  async setContactField(_workspaceId: string, contactId: string, field: string, value: string) {
    const contact = [...this.contacts.values()].find((ct) => ct.id === contactId);
    if (contact) contact.customFields[field] = value;
  }

  /** Broadcast recipient rows (package #4), seeded directly by tests. */
  readonly broadcastRecipients: Array<{
    id: string; broadcastId: string; workspaceId: string; contactId: string;
    status: string; providerMessageId?: string | null; error?: string | null;
    sentAt: Date | null; deliveredAt: Date | null; readAt: Date | null; repliedAt: Date | null;
    createdAt: Date;
  }> = [];

  async advanceBroadcastRecipientByProviderId(input: {
    workspaceId: string; providerMessageId: string;
    status: "sent" | "delivered" | "read" | "failed"; at: Date; error?: string;
  }) {
    for (const row of this.broadcastRecipients) {
      if (row.workspaceId !== input.workspaceId || row.providerMessageId !== input.providerMessageId) continue;
      const patch = broadcastRecipientTransition(row, input.status, input.at);
      if (!patch) continue;
      Object.assign(row, patch);
      if (input.status === "failed") row.error = input.error ?? null;
      if (input.status === "sent") row.error = null;
      return { recipientId: row.id, broadcastId: row.broadcastId, contactId: row.contactId };
    }
    return null;
  }

  async markBroadcastRecipientReplied(input: { workspaceId: string; contactId: string; at: Date }) {
    const open = this.broadcastRecipients
      .filter((r) => r.workspaceId === input.workspaceId && r.contactId === input.contactId
        && (r.status === "sent" || r.status === "delivered" || r.status === "read"))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const latest = open[0];
    if (!latest) return;
    const patch = broadcastRecipientTransition(latest, "replied", input.at);
    if (patch) Object.assign(latest, patch);
  }

  /** Inbox message rows advanced by provider receipts (package #8). */
  async advanceMessageStatusByProviderId(input: {
    workspaceId: string; providerMessageId: string;
    status: "sent" | "delivered" | "read" | "failed"; at: Date; error?: string;
  }) {
    for (const m of this.messages) {
      if (m.externalId !== input.providerMessageId || m.direction !== "out") continue;
      const conversation = this.conversations.get(m.conversationId);
      if (!conversation || conversation.workspaceId !== input.workspaceId) continue;
      const next = messageStatusTransition(m.status ?? "queued", input.status);
      if (next) {
        m.status = next;
        return { messageId: m.id ?? input.providerMessageId, conversationId: m.conversationId };
      }
      return null;
    }
    return null;
  }
}

// --------------------------------------------------------------- dispatcher

/** Channels whose inbound messages persist + trigger flows by default. */
const DISPATCH_CHANNELS = new Set(["whatsapp", "telegram", "instagram", "messenger", "threads", "tiktok"]);
/**
 * Channels with a comment surface the dispatcher automates. TikTok's
 * events are pre-filtered by TikTok itself to high-intent comments (the
 * keyword match still runs Botara-side, exactly like IG/Messenger);
 * TikTok's public reply/hide do not exist in the Business Messaging API,
 * so the worker's comment-action skips those steps by capability and the
 * private reply (direct_reply) is the effective action.
 */
const COMMENT_CHANNELS = new Set(["instagram", "messenger", "tiktok"]);

export interface FlowDispatcherDeps {
  store: DispatchStore;
  flowEnqueuer: FlowRunEnqueuer;
  commentEnqueuer?: CommentActionEnqueuer;
  /** Inbox live updates: notified once per newly persisted inbound message. */
  publisher?: RealtimePublisher;
  /** Outbound event webhooks (#10): lifecycle events for subscribed endpoints. */
  webhookEmitter?: OutboundWebhookEmitter;
  /**
   * Inbound media pipeline (optional): when wired, media-carrying
   * inbound messages, echoes and history items get their bytes copied
   * into Botara storage before persistence. Absent = caption-only
   * persistence, exactly as before.
   */
  mediaPort?: InboundMediaPort;
}

export function createFlowDispatcher(deps: FlowDispatcherDeps): InboundFlowDispatcher {
  const log = (line: Record<string, unknown>): void =>
    console.error(JSON.stringify({ level: "error", scope: "flows-dispatch", ...line }));

  async function resolveAccount(event: InboundEvent): Promise<DispatchAccount | null> {
    let account = event.accountExternalId
      ? await deps.store.findAccountByExternal(event.channel, event.accountExternalId)
      : null;
    if (!account) {
      // Telegram updates carry no bot identity: when exactly ONE connected
      // account exists for the channel, the update must be for it. With
      // several bots the event cannot be attributed and is skipped (per-bot
      // webhook URLs are a documented follow-up).
      const candidates = await deps.store.listConnectedAccountsByChannel(event.channel);
      if (candidates.length === 1) account = candidates[0]!;
    }
    return account && account.status === "connected" ? account : null;
  }

  async function findOrCreateContact(workspaceId: string, channel: string, externalId: string): Promise<DispatchContact | null> {
    let contact = await deps.store.getContactByExternal(workspaceId, channel, externalId);
    if (!contact) {
      try {
        contact = await deps.store.createContact({ workspaceId, channel, externalId });
      } catch {
        contact = await deps.store.getContactByExternal(workspaceId, channel, externalId);
      }
    }
    return contact;
  }

  async function findOrCreateConversation(
    workspaceId: string,
    accountId: string,
    contactId: string,
    conversationExternalId?: string,
  ): Promise<{ id: string; createdNew: boolean }> {
    const existing = await deps.store.findOpenConversation({ workspaceId, channelAccountId: accountId, contactId });
    if (existing) {
      // Backfill the provider conversation id when this event carries one
      // the stored conversation lacks (TikTok: a comment opened the
      // conversation; the first real DM teaches us its address).
      if (conversationExternalId && !existing.externalId && deps.store.setConversationExternalId) {
        await deps.store.setConversationExternalId(existing.id, conversationExternalId).catch(() => undefined);
      }
      return { ...existing, createdNew: false };
    }
    const created = await deps.store.createConversation({
      workspaceId, channelAccountId: accountId, contactId,
      ...(conversationExternalId ? { externalId: conversationExternalId } : {}),
    });
    // The repository backstops the one-open-thread invariant with a
    // partial unique index: when a concurrent event won the create race,
    // createConversation returns THAT thread instead of a fresh row - in
    // which case it may still lack the provider id this event carries,
    // so run the same backfill as the existing-thread branch above. The
    // store's `createdNew` flag carries the distinction (#10 announces
    // only genuine creations).
    if (conversationExternalId && !created.externalId && deps.store.setConversationExternalId) {
      await deps.store.setConversationExternalId(created.id, conversationExternalId).catch(() => undefined);
    }
    return created;
  }

  /**
   * Outbound webhook emission (package #10): pure bookkeeping next to
   * the broadcast-reply attribution - wrapped so an emitter failure is
   * a log line, never a dispatch failure.
   */
  async function emitWebhook(input: {
    workspaceId: string;
    type: OutboundWebhookEvent;
    data: Record<string, unknown>;
  }): Promise<void> {
    if (!deps.webhookEmitter) return;
    try {
      await deps.webhookEmitter.emit(input);
    } catch (err) {
      log({ event: "outbound_webhook_emit_failed", workspaceId: input.workspaceId, type: input.type, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Copy one event's media bytes into Botara storage via the media
   * port. Graceful degradation is the contract: no port wired, no
   * media on the event, or ANY port failure (the port itself already
   * never throws - this catch is belt-and-braces) all resolve to empty
   * references, and the caller persists the message caption-only
   * exactly as it did before the pipeline existed.
   */
  async function resolveMedia(
    account: DispatchAccount,
    channel: string,
    media: MessageMedia | undefined,
    messageExternalId: string,
    conversationExternalId?: string,
  ): Promise<{ mediaUrls: string[]; mediaKeys: string[] }> {
    const empty = { mediaUrls: [] as string[], mediaKeys: [] as string[] };
    if (!media || !deps.mediaPort) return empty;
    try {
      const stored = await deps.mediaPort.fetchAndStore({
        workspaceId: account.workspaceId, account, channel, media, messageExternalId,
        ...(conversationExternalId ? { conversationExternalId } : {}),
      });
      return stored ? { mediaUrls: stored.urls, mediaKeys: stored.keys } : empty;
    } catch (err) {
      log({ event: "inbound_media_failed", channel, messageExternalId, error: err instanceof Error ? err.message : String(err) });
      return empty;
    }
  }


  /**
   * Collect-input capture (package #3): when a flow run is WAITING at a
   * collect_input node on this conversation, the contact's next message
   * belongs to that run - claim the wait and enqueue the resume BEFORE
   * any growth/keyword matching (the caller returns early on true, so
   * the captured reply never ALSO fires triggers for the same message;
   * the message itself is already persisted in the inbox as usual).
   * The captured value is the message text; a textless (media-only)
   * reply resumes with an empty value + a logged warning instead of
   * leaving the run stuck. Returns true when a wait was claimed.
   */
  async function tryResumeWaitingRun(input: {
    conversationId: string;
    text?: string;
  }): Promise<boolean> {
    let wait: ClaimedFlowWait | null;
    try {
      wait = await deps.store.claimFlowWait(input.conversationId);
    } catch (err) {
      log({ event: "flow_wait_claim_failed", conversationId: input.conversationId, error: String(err) });
      return false;
    }
    if (!wait) return false;
    const value = input.text ?? "";
    if (!input.text) {
      log({ event: "flow_wait_empty_reply", waitId: wait.id, flowId: wait.flowId, conversationId: input.conversationId });
    }
    if (wait.saveToContactField && value) {
      try {
        await deps.store.setContactField(wait.workspaceId, wait.contactId, wait.saveToContactField, value);
      } catch (err) {
        log({ event: "flow_wait_field_save_failed", waitId: wait.id, error: String(err) });
      }
    }
    try {
      await deps.flowEnqueuer.enqueueFlowRun({
        flowId: wait.flowId,
        workspaceId: wait.workspaceId,
        contactId: wait.contactId,
        conversationId: input.conversationId,
        channelAccountId: wait.channelAccountId,
        triggerText: input.text,
        resumeState: wait.resumeState,
        resumeVariables: { [wait.variable]: value },
      });
    } catch (err) {
      log({ event: "flow_wait_resume_enqueue_failed", waitId: wait.id, flowId: wait.flowId, error: String(err) });
    }
    return true;
  }

  /**
   * Growth attribution for one event: resolve the link (when any), tag
   * the contact, count the conversion once per contact, and - when the
   * link binds a flow - enqueue that flow INSTEAD of keyword matching.
   * Returns true when a bound flow was enqueued (skip keyword matching).
   */
  async function applyGrowth(
    link: DispatchGrowthLink,
    input: { workspaceId: string; contact: DispatchContact; conversationId: string; accountId: string; triggerText?: string },
  ): Promise<boolean> {
    const tag = `growth:${link.slug}`;
    const newlyTagged = await deps.store.addContactTag(input.workspaceId, input.contact.id, tag);
    if (newlyTagged) {
      await deps.store.incrementGrowthConversions(link.id);
    }
    if (!link.boundFlowId) return false;
    try {
      await deps.flowEnqueuer.enqueueFlowRun({
        flowId: link.boundFlowId,
        workspaceId: input.workspaceId,
        contactId: input.contact.id,
        conversationId: input.conversationId,
        channelAccountId: input.accountId,
        triggerText: input.triggerText,
      });
    } catch (err) {
      log({ event: "growth_flow_enqueue_failed", flowId: link.boundFlowId, workspaceId: input.workspaceId, error: String(err) });
    }
    return true;
  }

  /** Slug carried by an event, if any (Messenger ref / Telegram /start). */
  function slugFromEvent(event: InboundEvent): string | null {
    if (event.type === "referral.received") return event.ref?.trim() || null;
    if (event.type === "message.received" && event.channel === "telegram") {
      const text = (event.text ?? "").trim();
      if (text.startsWith("/start ")) {
        const slug = text.slice("/start ".length).trim().split(/\s+/)[0];
        return slug || null;
      }
    }
    return null;
  }

  async function dispatchMessageLike(event: Extract<InboundEvent, { type: "message.received" | "postback.received" | "referral.received" }>): Promise<void> {
    if (!DISPATCH_CHANNELS.has(event.channel)) return;
    if (!event.contactExternalId) return;
    const account = await resolveAccount(event);
    if (!account) return;
    const workspaceId = account.workspaceId;

    const contact = await findOrCreateContact(workspaceId, event.channel, event.contactExternalId);
    if (!contact) return;
    const conversation = await findOrCreateConversation(
      workspaceId, account.id, contact.id,
      event.type === "message.received" ? event.conversationExternalId : undefined,
    );

    let messagePersisted = false;
    let persistedMessageId: string | null = null;
    if (event.type === "message.received") {
      const existing = await deps.store.findMessageByExternalId(conversation.id, event.messageExternalId);
      if (!existing) {
        const { mediaUrls, mediaKeys } = await resolveMedia(
          account, event.channel, event.media, event.messageExternalId, event.conversationExternalId,
        );
        const created = await deps.store.createMessage({
          conversationId: conversation.id,
          direction: "in",
          type: event.media ? "media" : "text",
          body: event.text,
          externalId: event.messageExternalId,
          // Quoted-reply reference (WhatsApp context.id), when the
          // inbound payload carried one - the inbox resolves it against
          // this conversation's rows at read time.
          replyToExternalId: event.replyToExternalId,
          status: "delivered",
          mediaUrls,
          mediaKeys,
        });
        await deps.store.touchConversationLastUserMessage(conversation.id, new Date(event.receivedAt));
        messagePersisted = true;
        persistedMessageId = created.id;
        // Live inbox: exactly one event per NEWLY persisted message -
        // webhook redeliveries (the `existing` branch) publish nothing.
        if (deps.publisher) {
          await deps.publisher.publishInboxMessage({
            workspaceId,
            conversationId: conversation.id,
            direction: "in",
            messageId: created.id,
          }).catch(() => undefined);
        }
      }
    }

    // --- outbound webhooks (package #10): lifecycle announcements for
    // subscribed operator endpoints. conversation.created fires only
    // for a GENUINELY new thread (the store's createdNew flag - the #0
    // race-fallback reuse announces nothing); message.received fires
    // only for a newly persisted message (webhook redeliveries stay
    // silent). Dispatcher-persisted messages are never internal notes -
    // notes exist only through the inbox API and never pass this seam.
    if (conversation.createdNew) {
      await emitWebhook({
        workspaceId,
        type: "conversation.created",
        data: {
          conversationId: conversation.id,
          channelAccountId: account.id,
          channel: event.channel,
          contactId: contact.id,
        },
      });
    }
    if (event.type === "message.received" && messagePersisted) {
      const preview = webhookMessagePreview(event.text);
      await emitWebhook({
        workspaceId,
        type: "message.received",
        data: {
          messageId: persistedMessageId,
          conversationId: conversation.id,
          channelAccountId: account.id,
          channel: event.channel,
          contactId: contact.id,
          direction: "in",
          externalId: event.messageExternalId,
          ...(preview !== undefined ? { preview } : {}),
          receivedAt: new Date(event.receivedAt).toISOString(),
        },
      });
    }

    // --- broadcast reply attribution (package #4): a NEWLY persisted
    // inbound message is the contact answering - attribute it to their
    // latest still-open broadcast recipient. Best-effort bookkeeping:
    // it runs before the collect-input capture so a captured reply is
    // still attributed, and it never blocks dispatch.
    if (event.type === "message.received" && messagePersisted && deps.store.markBroadcastRecipientReplied) {
      try {
        await deps.store.markBroadcastRecipientReplied({
          workspaceId, contactId: contact.id, at: new Date(event.receivedAt),
        });
      } catch (err) {
        log({ event: "broadcast_recipient_reply_failed", workspaceId, contactId: contact.id, error: String(err) });
      }
    }

    // --- collect-input capture (package #3): a waiting run claims the
    // reply BEFORE growth attribution and keyword matching; only NEWLY
    // persisted messages capture (a webhook redelivery must not resume
    // a run twice - the claim is atomic, but the first delivery owns
    // the reply by construction here).
    if (event.type === "message.received" && messagePersisted) {
      const resumed = await tryResumeWaitingRun({ conversationId: conversation.id, text: event.text });
      if (resumed) return;
    }

    // --- growth attribution (priority over keyword matching) -----------
    let growthHandled = false;
    const slug = slugFromEvent(event);
    if (slug) {
      const link = await deps.store.findGrowthLinkBySlug(slug);
      if (link && link.channelAccountId === account.id) {
        growthHandled = await applyGrowth(link, {
          workspaceId, contact, conversationId: conversation.id, accountId: account.id,
          triggerText: event.type === "message.received" ? event.text : undefined,
        });
      }
    } else if (event.type === "message.received" && event.channel === "whatsapp" && event.referral) {
      // wa.me cannot carry our slug, and click-to-WhatsApp referrals carry
      // only the ad's ctwa_clid - so a WhatsApp conversion attributes to
      // the account's growth link ONLY when exactly one exists (any other
      // case would be a guess, and guesses are not attribution).
      const links = await deps.store.listGrowthLinksByAccount(account.id);
      if (links.length === 1) {
        growthHandled = await applyGrowth(links[0]!, {
          workspaceId, contact, conversationId: conversation.id, accountId: account.id,
          triggerText: event.text,
        });
      }
    }
    if (growthHandled) return;
    if (event.type === "referral.received") return; // referrals only feed growth

    // --- keyword / postback flow matching --------------------------------
    const flows = await deps.store.listActiveFlows(workspaceId);
    for (const flow of flows) {
      const trigger = flow.trigger as FlowTrigger;
      let matched = false;
      let triggerText: string | undefined;
      if (event.type === "message.received") {
        matched = flowTriggerMatches(trigger, { text: event.text });
        triggerText = event.text;
      } else {
        // postback.received: mirror the webchat-click semantics — a tap
        // is tested against postback triggers by its payload AND keyword
        // triggers by its title text (a flow has a single trigger type,
        // so at most one of the two tests can fire for it).
        if (flowTriggerMatches(trigger, { payload: event.payload })) {
          matched = true;
          triggerText = event.payload;
        } else if (event.title && flowTriggerMatches(trigger, { text: event.title })) {
          matched = true;
          triggerText = event.title;
        }
      }
      if (!matched) continue;
      try {
        await deps.flowEnqueuer.enqueueFlowRun({
          flowId: flow.id,
          workspaceId,
          contactId: contact.id,
          conversationId: conversation.id,
          channelAccountId: account.id,
          triggerText,
        });
      } catch (err) {
        log({ event: "flow_run_enqueue_failed", flowId: flow.id, workspaceId, error: String(err) });
      }
    }
  }

  /**
   * Provider delivery-status webhooks (package #4): until now these
   * events were parsed by the adapters and dropped - nothing consumed
   * them. Two mirrors consume them today, each in its own try/catch so
   * one failing never blocks the other:
   *  - the broadcast recipient mirror (package #4): the recipient row
   *    carrying the provider message id advances delivered/read, or
   *    records the provider's failure;
   *  - the inbox message mirror (package #8): the outbound inbox
   *    message row carrying the same provider id advances with it, so
   *    the thread's delivered/read state is real.
   * The forward-only transition guards in the store make out-of-order
   * statuses harmless on both paths.
   */
  async function dispatchMessageStatus(event: Extract<InboundEvent, { type: "message.status" }>): Promise<void> {
    const account = await resolveAccount(event);
    if (!account) return;
    const firstError = event.errors?.[0];
    let recipientAdvanced: { recipientId: string; broadcastId: string; contactId: string } | null = null;
    let messageAdvanced: { messageId: string; conversationId: string } | null = null;
    if (deps.store.advanceBroadcastRecipientByProviderId) {
      try {
        recipientAdvanced = await deps.store.advanceBroadcastRecipientByProviderId({
          workspaceId: account.workspaceId,
          providerMessageId: event.messageExternalId,
          status: event.status,
          at: new Date(event.receivedAt),
          ...(firstError
            ? { error: firstError.message ?? firstError.title ?? `provider error ${firstError.code}` }
            : {}),
        });
      } catch (err) {
        log({ event: "broadcast_recipient_status_failed", workspaceId: account.workspaceId, messageExternalId: event.messageExternalId, error: String(err) });
      }
    }
    if (deps.store.advanceMessageStatusByProviderId) {
      try {
        messageAdvanced = await deps.store.advanceMessageStatusByProviderId({
          workspaceId: account.workspaceId,
          providerMessageId: event.messageExternalId,
          status: event.status,
          at: new Date(event.receivedAt),
        });
      } catch (err) {
        log({ event: "message_status_advance_failed", workspaceId: account.workspaceId, messageExternalId: event.messageExternalId, error: String(err) });
      }
    }
    // Outbound webhooks (package #10): announce only REAL advancements -
    // a duplicate or out-of-order receipt that moved nothing stays
    // silent, like the mirrors themselves.
    if (recipientAdvanced || messageAdvanced) {
      await emitWebhook({
        workspaceId: account.workspaceId,
        type: "message.status",
        data: {
          channel: event.channel,
          channelAccountId: account.id,
          providerMessageId: event.messageExternalId,
          status: event.status,
          ...(messageAdvanced
            ? { messageId: messageAdvanced.messageId, conversationId: messageAdvanced.conversationId }
            : {}),
          ...(recipientAdvanced
            ? {
                broadcastId: recipientAdvanced.broadcastId,
                recipientId: recipientAdvanced.recipientId,
                contactId: recipientAdvanced.contactId,
              }
            : {}),
          ...(firstError
            ? { error: firstError.message ?? firstError.title ?? `provider error ${firstError.code}` }
            : {}),
        },
      });
    }
  }

  async function dispatchComment(event: Extract<InboundEvent, { type: "comment.received" }>): Promise<void> {
    if (!COMMENT_CHANNELS.has(event.channel)) return;
    if (!deps.commentEnqueuer) return;
    if (!event.authorExternalId) return; // no author -> no DM conversation to open
    const account = await resolveAccount(event);
    if (!account) return;
    const workspaceId = account.workspaceId;

    const flows = await deps.store.listActiveFlows(workspaceId);
    for (const flow of flows) {
      const config = commentTriggerConfig(flow.trigger as FlowTrigger);
      if (!config) continue;
      if (!flowTriggerMatches(flow.trigger as FlowTrigger, { commentText: event.text })) continue;
      // Cheap duplicate suppression here; the worker claims atomically.
      const already = await deps.store.isCommentProcessed({
        channelAccountId: account.id,
        commentExternalId: event.commentExternalId,
        flowId: flow.id,
      });
      if (already) continue;
      try {
        await deps.commentEnqueuer.enqueueCommentAction({
          workspaceId,
          channelAccountId: account.id,
          channel: event.channel,
          accountExternalId: account.externalId,
          tokenVaultRef: account.tokenVaultRef ?? undefined,
          authMode: account.authMode ?? undefined,
          flowId: flow.id,
          commentExternalId: event.commentExternalId,
          postExternalId: event.postExternalId,
          authorExternalId: event.authorExternalId,
          commentText: event.text,
          publicReplyText: config.publicReplyText,
          autoHide: config.autoHide,
          privateText: config.privateText,
        });
      } catch (err) {
        log({ event: "comment_action_enqueue_failed", flowId: flow.id, workspaceId, error: String(err) });
      }
    }
  }

  /**
   * WhatsApp coexistence: a Business-app ECHO is a message the business
   * sent from the WhatsApp Business app on the same number. It belongs
   * in the inbox thread as an outbound message - and NOTHING more: it
   * never matches flow triggers, never touches the reply-window anchor
   * (only the customer opens the window), and never reaches the send
   * path, so no billable-send ledger entry can exist for it (billing
   * happens in the API/worker send paths, which echoes never enter;
   * this dispatcher holds no ledger port at all). Deduped on the
   * provider message id: Meta redelivers echo webhooks.
   */
  async function dispatchEcho(event: Extract<InboundEvent, { type: "message.echo" }>): Promise<void> {
    if (!DISPATCH_CHANNELS.has(event.channel)) return;
    if (!event.contactExternalId) return;
    const account = await resolveAccount(event);
    if (!account) return;
    const workspaceId = account.workspaceId;

    const contact = await findOrCreateContact(workspaceId, event.channel, event.contactExternalId);
    if (!contact) return;
    const conversation = await findOrCreateConversation(
      workspaceId, account.id, contact.id, event.conversationExternalId,
    );

    const existing = await deps.store.findMessageByExternalId(conversation.id, event.messageExternalId);
    if (existing) return;
    const { mediaUrls, mediaKeys } = await resolveMedia(
      account, event.channel, event.media, event.messageExternalId, event.conversationExternalId,
    );
    const created = await deps.store.createMessage({
      conversationId: conversation.id,
      direction: "out",
      type: event.media ? "media" : "text",
      body: event.text,
      externalId: event.messageExternalId,
      status: "sent",
      mediaUrls,
      mediaKeys,
    });
    if (deps.publisher) {
      await deps.publisher.publishInboxMessage({
        workspaceId,
        conversationId: conversation.id,
        direction: "out",
        messageId: created.id,
      }).catch(() => undefined);
    }
  }

  /**
   * WhatsApp coexistence: app-state contact sync. `add`/`update` upsert
   * the contact (create, or refresh the display name). `remove` is
   * deliberately NOT destructive: the contact was deleted from the
   * phone's address book, but the platform record carries conversation
   * history and campaign consent, so it is kept untouched.
   */
  async function dispatchContactsSynced(event: Extract<InboundEvent, { type: "contacts.synced" }>): Promise<void> {
    if (!DISPATCH_CHANNELS.has(event.channel)) return;
    const account = await resolveAccount(event);
    if (!account) return;
    for (const contact of event.contacts) {
      if (contact.action === "remove") continue;
      await deps.store.upsertSyncedContact({
        workspaceId: account.workspaceId,
        channel: event.channel,
        externalId: contact.externalId,
        displayName: contact.displayName,
      });
    }
  }

  /**
   * WhatsApp coexistence: ONE backfilled history message. Persisted
   * with its ORIGINAL provider timestamp and deduped on the provider
   * message id (chunks overlap, and a backfilled message may also have
   * arrived live). Quiet by design: no flow triggers, no realtime
   * publish, no billing. A backfilled INBOUND message moves the
   * reply-window anchor only forward, to its own original timestamp -
   * an old message can neither fake a fresh window nor close one a
   * live message opened.
   */
  async function dispatchHistoryMessage(event: Extract<InboundEvent, { type: "message.history" }>): Promise<void> {
    if (!DISPATCH_CHANNELS.has(event.channel)) return;
    if (!event.contactExternalId) return;
    const account = await resolveAccount(event);
    if (!account) return;
    const workspaceId = account.workspaceId;

    const contact = await findOrCreateContact(workspaceId, event.channel, event.contactExternalId);
    if (!contact) return;
    const conversation = await findOrCreateConversation(workspaceId, account.id, contact.id);

    const existing = await deps.store.findMessageByExternalId(conversation.id, event.messageExternalId);
    if (existing) return;
    const at = new Date(event.receivedAt);
    const { mediaUrls, mediaKeys } = await resolveMedia(account, event.channel, event.media, event.messageExternalId);
    await deps.store.createMessage({
      conversationId: conversation.id,
      direction: event.direction,
      type: event.media ? "media" : "text",
      body: event.text,
      externalId: event.messageExternalId,
      status: event.direction === "in" ? "delivered" : "sent",
      createdAt: at,
      mediaUrls,
      mediaKeys,
    });
    if (event.direction === "in") {
      await deps.store.advanceConversationLastUserMessage(conversation.id, at);
    }
  }

  /**
   * Trigger evaluation for a PRE-PERSISTED webchat message (the public
   * widget route owns persistence + the realtime publish; this dispatcher
   * deliberately has no store writes on this path). Matching mirrors the
   * webhook channels: keyword triggers test the text; postback triggers
   * test the button payload. A button CLICK carries both, so it is tested
   * against postback triggers by payload AND keyword triggers by its
   * title text - one enqueue per flow at most (a flow has a single
   * trigger type, so the two tests can never both fire for it).
   */
  async function dispatchPersistedWebchat(input: PersistedWebchatInput): Promise<void> {
    try {
      // Collect-input capture first (package #3), exactly like the
      // webhook channels: a waiting run claims the visitor's reply
      // (typed text, or a button tap's title) and trigger matching is
      // skipped for this message.
      const resumed = await tryResumeWaitingRun({ conversationId: input.conversationId, text: input.text });
      if (resumed) return;
      const flows = await deps.store.listActiveFlows(input.workspaceId);
      for (const flow of flows) {
        const trigger = flow.trigger as FlowTrigger;
        let matched = false;
        let triggerText: string | undefined;
        if (input.buttonPayload && flowTriggerMatches(trigger, { payload: input.buttonPayload })) {
          matched = true;
          triggerText = input.buttonPayload;
        } else if (input.text && flowTriggerMatches(trigger, { text: input.text })) {
          matched = true;
          triggerText = input.text;
        }
        if (!matched) continue;
        try {
          await deps.flowEnqueuer.enqueueFlowRun({
            flowId: flow.id,
            workspaceId: input.workspaceId,
            contactId: input.contactId,
            conversationId: input.conversationId,
            channelAccountId: input.channelAccountId,
            triggerText,
          });
        } catch (err) {
          log({ event: "flow_run_enqueue_failed", flowId: flow.id, workspaceId: input.workspaceId, error: String(err) });
        }
      }
    } catch (err) {
      // Same contract as dispatch(): never throw into the caller's path.
      log({ event: "webchat_dispatch_failed", workspaceId: input.workspaceId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    async dispatch(events: InboundEvent[]): Promise<void> {
      for (const event of events) {
        try {
          if (event.type === "message.received" || event.type === "postback.received" || event.type === "referral.received") {
            await dispatchMessageLike(event);
          } else if (event.type === "comment.received") {
            await dispatchComment(event);
          } else if (event.type === "message.echo") {
            await dispatchEcho(event);
          } else if (event.type === "contacts.synced") {
            await dispatchContactsSynced(event);
          } else if (event.type === "message.history") {
            await dispatchHistoryMessage(event);
          } else if (event.type === "message.status") {
            await dispatchMessageStatus(event);
          }
        } catch (err) {
          // Webhook acknowledgment is king: log and continue with the next event.
          log({ event: "dispatch_failed", channel: event.channel, error: err instanceof Error ? err.message : String(err) });
        }
      }
    },
    dispatchPersistedWebchat,
  };
}

export interface DbFlowDispatcherDeps {
  getDatabase: () => Database;
  flowEnqueuer: FlowRunEnqueuer;
  commentEnqueuer?: CommentActionEnqueuer;
  publisher?: RealtimePublisher;
  mediaPort?: InboundMediaPort;
  webhookEmitter?: OutboundWebhookEmitter;
}

export function createDbFlowDispatcher(deps: DbFlowDispatcherDeps): InboundFlowDispatcher {
  return createFlowDispatcher({
    store: createDbDispatchStore(deps.getDatabase),
    flowEnqueuer: deps.flowEnqueuer,
    commentEnqueuer: deps.commentEnqueuer,
    publisher: deps.publisher,
    mediaPort: deps.mediaPort,
    webhookEmitter: deps.webhookEmitter,
  });
}

/** No-op dispatcher for tests / unconfigured deployments. */
export const noopFlowDispatcher: InboundFlowDispatcher = {
  async dispatch() {},
  async dispatchPersistedWebchat() {},
};
