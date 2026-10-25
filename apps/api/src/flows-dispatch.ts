import {
  addContactTag, createContact, createConversation, createMessage,
  findChannelAccountByExternal, findMessageByExternalId, findOpenConversation,
  getContactByExternal, getGrowthLinkBySlug, incrementGrowthLinkConversions,
  isCommentProcessed, listActiveFlows, listConnectedAccountsByChannel,
  listGrowthLinksByAccount, touchConversationLastUserMessage, type Database,
} from "@botara/db";
import {
  commentTriggerConfig, flowTriggerMatches, type FlowTrigger,
} from "@botara/flow-engine";
import type { InboundEvent } from "@botara/channels";
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
  createContact(input: { workspaceId: string; channel: string; externalId: string }): Promise<DispatchContact>;
  findOpenConversation(input: { workspaceId: string; channelAccountId: string; contactId: string }): Promise<{ id: string } | null>;
  createConversation(input: { workspaceId: string; channelAccountId: string; contactId: string }): Promise<{ id: string }>;
  findMessageByExternalId(conversationId: string, externalId: string): Promise<{ id: string } | null>;
  createMessage(input: { conversationId: string; direction: "in" | "out"; type: string; body?: string; externalId?: string; status: string }): Promise<{ id: string }>;
  touchConversationLastUserMessage(conversationId: string, at: Date): Promise<void>;
  listActiveFlows(workspaceId: string): Promise<Array<{ id: string; trigger: FlowTrigger }>>;
  findGrowthLinkBySlug(slug: string): Promise<DispatchGrowthLink | null>;
  listGrowthLinksByAccount(channelAccountId: string): Promise<DispatchGrowthLink[]>;
  incrementGrowthConversions(linkId: string): Promise<void>;
  /** Returns true when the tag was newly added (first attribution). */
  addContactTag(workspaceId: string, contactId: string, tag: string): Promise<boolean>;
  isCommentProcessed(input: { channelAccountId: string; commentExternalId: string; flowId: string }): Promise<boolean>;
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
      return row ? { id: row.id, tags: (row.tags as string[]) ?? [] } : null;
    },
    async createContact(input) {
      const row = await createContact(getDatabase(), input);
      return { id: row.id, tags: (row.tags as string[]) ?? [] };
    },
    async findOpenConversation(input) {
      const row = await findOpenConversation(getDatabase(), input);
      return row ? { id: row.id } : null;
    },
    async createConversation(input) {
      const row = await createConversation(getDatabase(), input);
      return { id: row.id };
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
  };
}

/** In-memory DispatchStore for tests (and only tests). */
export class InMemoryDispatchStore implements DispatchStore {
  readonly accounts: DispatchAccount[] = [];
  readonly contacts = new Map<string, DispatchContact & { workspaceId: string; channel: string; externalId: string }>();
  readonly conversations = new Map<string, { id: string; workspaceId: string; channelAccountId: string; contactId: string }>();
  readonly messages: Array<{ id?: string; conversationId: string; externalId?: string; body?: string; direction: string; type: string }> = [];
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

  async createContact(input: { workspaceId: string; channel: string; externalId: string }) {
    const contact = { id: crypto.randomUUID(), tags: [] as string[], ...input };
    this.contacts.set(this.contactKey(input.workspaceId, input.channel, input.externalId), contact);
    return contact;
  }

  async findOpenConversation(input: { workspaceId: string; channelAccountId: string; contactId: string }) {
    return [...this.conversations.values()].find(
      (cv) => cv.workspaceId === input.workspaceId && cv.channelAccountId === input.channelAccountId && cv.contactId === input.contactId,
    ) ?? null;
  }

  async createConversation(input: { workspaceId: string; channelAccountId: string; contactId: string }) {
    const conversation = { id: crypto.randomUUID(), ...input };
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  async findMessageByExternalId(conversationId: string, externalId: string) {
    const found = this.messages.find((m) => m.conversationId === conversationId && m.externalId === externalId);
    return found ? { id: externalId } : null;
  }

  async createMessage(input: { conversationId: string; direction: "in" | "out"; type: string; body?: string; externalId?: string; status: string }) {
    const id = crypto.randomUUID();
    this.messages.push({ id, ...input });
    return { id };
  }

  async touchConversationLastUserMessage() {}

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
}

// --------------------------------------------------------------- dispatcher

/** Channels whose inbound messages persist + trigger flows by default. */
const DISPATCH_CHANNELS = new Set(["whatsapp", "telegram", "instagram", "messenger", "threads"]);
/** Channels with a comment surface the dispatcher automates. */
const COMMENT_CHANNELS = new Set(["instagram", "messenger"]);

export interface FlowDispatcherDeps {
  store: DispatchStore;
  flowEnqueuer: FlowRunEnqueuer;
  commentEnqueuer?: CommentActionEnqueuer;
  /** Inbox live updates: notified once per newly persisted inbound message. */
  publisher?: RealtimePublisher;
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

  async function findOrCreateConversation(workspaceId: string, accountId: string, contactId: string): Promise<{ id: string }> {
    const existing = await deps.store.findOpenConversation({ workspaceId, channelAccountId: accountId, contactId });
    if (existing) return existing;
    return deps.store.createConversation({ workspaceId, channelAccountId: accountId, contactId });
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
    const conversation = await findOrCreateConversation(workspaceId, account.id, contact.id);

    if (event.type === "message.received") {
      const existing = await deps.store.findMessageByExternalId(conversation.id, event.messageExternalId);
      if (!existing) {
        const created = await deps.store.createMessage({
          conversationId: conversation.id,
          direction: "in",
          type: event.media ? "media" : "text",
          body: event.text,
          externalId: event.messageExternalId,
          status: "delivered",
        });
        await deps.store.touchConversationLastUserMessage(conversation.id, new Date(event.receivedAt));
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
      const matched = event.type === "message.received"
        ? flowTriggerMatches(trigger, { text: event.text })
        : flowTriggerMatches(trigger, { payload: event.payload });
      if (!matched) continue;
      try {
        await deps.flowEnqueuer.enqueueFlowRun({
          flowId: flow.id,
          workspaceId,
          contactId: contact.id,
          conversationId: conversation.id,
          channelAccountId: account.id,
          triggerText: event.type === "message.received" ? event.text : event.payload,
        });
      } catch (err) {
        log({ event: "flow_run_enqueue_failed", flowId: flow.id, workspaceId, error: String(err) });
      }
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
}

export function createDbFlowDispatcher(deps: DbFlowDispatcherDeps): InboundFlowDispatcher {
  return createFlowDispatcher({
    store: createDbDispatchStore(deps.getDatabase),
    flowEnqueuer: deps.flowEnqueuer,
    commentEnqueuer: deps.commentEnqueuer,
    publisher: deps.publisher,
  });
}

/** No-op dispatcher for tests / unconfigured deployments. */
export const noopFlowDispatcher: InboundFlowDispatcher = {
  async dispatch() {},
  async dispatchPersistedWebchat() {},
};
