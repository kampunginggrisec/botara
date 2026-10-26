import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Database } from "./client";
import {
  apiTokens, auditLog, broadcastRecipients, broadcasts, catalogProducts, channelAccounts, contacts, conversations, costLedger,
  dataDeletionRequests, flows, flowWaits, growthLinks, kbChunks, kbDocuments, messages,
  platformSettings,
  processedComments,
  savedReplies,
  scheduledPosts, sequenceEnrollments, sequences, templates, tokenVault,
  users, webchatSessions, workspaceDomains, workspaceMembers, workspaces,
} from "./schema";

/**
 * Fase 1 repositories: the ONLY place API/worker code touches Drizzle.
 * Every query is workspace-scoped - handlers pass the workspaceId from the
 * workspace-context middleware, never from the request body.
 */

// ---------------------------------------------------------------- contacts

export type ContactRow = typeof contacts.$inferSelect;

export async function listContacts(
  db: Database,
  workspaceId: string,
  filter: { tag?: string; channel?: string } = {},
): Promise<ContactRow[]> {
  const rows = await db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.workspaceId, workspaceId),
        filter.channel ? eq(contacts.channel, filter.channel) : undefined,
      ),
    )
    .orderBy(desc(contacts.createdAt));
  if (!filter.tag) return rows;
  return rows.filter((r) => Array.isArray(r.tags) && (r.tags as string[]).includes(filter.tag!));
}

export async function getContact(db: Database, workspaceId: string, id: string): Promise<ContactRow | null> {
  const [row] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, id), eq(contacts.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

export async function createContact(
  db: Database,
  input: {
    workspaceId: string;
    channel: string;
    externalId: string;
    displayName?: string;
    tags?: string[];
    customFields?: Record<string, unknown>;
  },
): Promise<ContactRow> {
  const [row] = await db
    .insert(contacts)
    .values({
      workspaceId: input.workspaceId,
      channel: input.channel,
      externalId: input.externalId,
      displayName: input.displayName,
      tags: input.tags ?? [],
      customFields: input.customFields ?? {},
    })
    .returning();
  return row!;
}

export async function updateContact(
  db: Database,
  workspaceId: string,
  id: string,
  patch: { displayName?: string; tags?: string[]; customFields?: Record<string, unknown> },
): Promise<ContactRow | null> {
  const existing = await getContact(db, workspaceId, id);
  if (!existing) return null;
  const [row] = await db
    .update(contacts)
    .set({
      displayName: patch.displayName ?? existing.displayName,
      tags: patch.tags ?? existing.tags,
      // Custom fields merge: PATCH adds/overwrites keys, never wipes.
      customFields: { ...(existing.customFields as Record<string, unknown>), ...(patch.customFields ?? {}) },
    })
    .where(eq(contacts.id, id))
    .returning();
  return row ?? null;
}

/** Per-tag contact counts for one workspace (segments screen). */
export async function segmentCounts(
  db: Database,
  workspaceId: string,
): Promise<Array<{ tag: string; contactCount: number }>> {
  const rows = await db
    .select({ tags: contacts.tags })
    .from(contacts)
    .where(eq(contacts.workspaceId, workspaceId));
  const counts = new Map<string, number>();
  for (const row of rows) {
    const tags = Array.isArray(row.tags) ? (row.tags as string[]) : [];
    for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, contactCount]) => ({ tag, contactCount }))
    .sort((a, b) => b.contactCount - a.contactCount);
}

// ------------------------------------------------------------ conversations

export type ConversationRow = typeof conversations.$inferSelect;

export interface ConversationListItem extends ConversationRow {
  channel: string;
  channelAccountExternalId: string;
  contactExternalId: string;
  contactDisplayName: string | null;
  /** The contact's tags (the conversation row itself carries contactId). */
  contactTags: string[];
}

export async function listConversations(
  db: Database,
  workspaceId: string,
  filter: { channel?: string; status?: string; assignedTo?: string | null } = {},
): Promise<ConversationListItem[]> {
  const rows = await db
    .select({
      conversation: conversations,
      channel: channelAccounts.channel,
      channelAccountExternalId: channelAccounts.externalId,
      contactExternalId: contacts.externalId,
      contactDisplayName: contacts.displayName,
      contactTags: contacts.tags,
    })
    .from(conversations)
    .innerJoin(channelAccounts, eq(conversations.channelAccountId, channelAccounts.id))
    .innerJoin(contacts, eq(conversations.contactId, contacts.id))
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        filter.status ? eq(conversations.status, filter.status) : undefined,
        filter.channel ? eq(channelAccounts.channel, filter.channel) : undefined,
      ),
    )
    .orderBy(desc(conversations.createdAt));
  const mapped = rows.map((r) => ({
    ...r.conversation,
    channel: r.channel,
    channelAccountExternalId: r.channelAccountExternalId,
    contactExternalId: r.contactExternalId,
    contactDisplayName: r.contactDisplayName,
    contactTags: (r.contactTags as string[] | null) ?? [],
  }));
  // Assignee filter in JS (same precedent as the contacts tag filter):
  // `assignedTo: null` means unassigned-only, a string means that member,
  // undefined means all. Keeps the filter identical across SQL backends.
  if (filter.assignedTo === undefined) return mapped;
  return mapped.filter((r) => (r.assignedUserId ?? null) === filter.assignedTo);
}

/**
 * Set (or clear, with null) a conversation's assignee. Workspace-scoped:
 * returns null when the conversation does not belong to the workspace.
 * Membership of the assignee is the CALLER's job (route validates it
 * against the workspace member list before writing).
 */
export async function updateConversationAssignment(
  db: Database,
  workspaceId: string,
  conversationId: string,
  assignedUserId: string | null,
): Promise<ConversationRow | null> {
  const [row] = await db
    .update(conversations)
    .set({ assignedUserId })
    .where(and(eq(conversations.id, conversationId), eq(conversations.workspaceId, workspaceId)))
    .returning();
  return row ?? null;
}

/** Legal conversation statuses (schema default "open"). */
export const CONVERSATION_STATUSES = ["open", "pending", "resolved"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/**
 * Set a conversation's status. Workspace-scoped: returns null when the
 * conversation does not belong to the workspace. Any transition is legal
 * (including resolved -> open, i.e. reopening); status validation is the
 * CALLER's job (route restricts the body to CONVERSATION_STATUSES).
 */
export async function updateConversationStatus(
  db: Database,
  workspaceId: string,
  conversationId: string,
  status: ConversationStatus,
): Promise<ConversationRow | null> {
  const [row] = await db
    .update(conversations)
    .set({ status })
    .where(and(eq(conversations.id, conversationId), eq(conversations.workspaceId, workspaceId)))
    .returning();
  return row ?? null;
}

export async function getConversation(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<ConversationListItem | null> {
  const rows = await listConversations(db, workspaceId);
  return rows.find((r) => r.id === id) ?? null;
}

// ---------------------------------------------------------------- messages

export type MessageRow = typeof messages.$inferSelect;

export async function listMessages(db: Database, conversationId: string): Promise<MessageRow[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}

export async function createMessage(
  db: Database,
  input: {
    conversationId: string;
    direction: "in" | "out";
    /** Timeline kind; "note" rows are internal-only and never sent. */
    kind?: "message" | "note";
    /** Authoring workspace user (internal notes); null for traffic. */
    authorUserId?: string;
    type?: string;
    body?: string;
    /** Rich block (outbound sends) or { buttonPayload } (webchat clicks). */
    payload?: unknown;
    /** Stored inbound media (public URLs + storage keys), parallel arrays. */
    mediaUrls?: string[];
    mediaKeys?: string[];
    externalId?: string;
    status?: string;
    idempotencyKey?: string;
    /**
     * Explicit row timestamp for BACKFILLED messages (WhatsApp coexistence
     * history): the provider's original send time, not the ingest time.
     * Omitted for live traffic, where the DB default (now) is correct.
     */
    createdAt?: Date;
  },
): Promise<MessageRow> {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId: input.conversationId,
      direction: input.direction,
      kind: input.kind ?? "message",
      authorUserId: input.authorUserId,
      type: input.type ?? "text",
      body: input.body,
      payload: input.payload ?? null,
      mediaUrls: input.mediaUrls ?? [],
      mediaKeys: input.mediaKeys ?? [],
      externalId: input.externalId,
      status: input.status ?? "queued",
      idempotencyKey: input.idempotencyKey,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .returning();
  return row!;
}

export async function updateMessageStatus(
  db: Database,
  messageId: string,
  status: string,
  externalId?: string,
): Promise<void> {
  await db
    .update(messages)
    .set({ status, ...(externalId ? { externalId } : {}) })
    .where(eq(messages.id, messageId));
}

export async function touchConversationLastUserMessage(
  db: Database,
  conversationId: string,
  at: Date,
): Promise<void> {
  await db.update(conversations).set({ lastUserMessageAt: at }).where(eq(conversations.id, conversationId));
}

/**
 * Forward-only variant for BACKFILLED inbound messages (coexistence
 * history import): move last_user_message_at to `at` ONLY when that is
 * later than the current anchor. An old replayed message must never pull
 * the anchor backwards (which would falsely close the reply window) nor
 * be stamped as "now" (which would falsely open it).
 */
export async function advanceConversationLastUserMessage(
  db: Database,
  conversationId: string,
  at: Date,
): Promise<void> {
  await db
    .update(conversations)
    .set({ lastUserMessageAt: at })
    .where(
      and(
        eq(conversations.id, conversationId),
        or(isNull(conversations.lastUserMessageAt), lt(conversations.lastUserMessageAt, at)),
      ),
    );
}

// ---------------------------------------------------------- saved replies

export type SavedReplyRow = typeof savedReplies.$inferSelect;

/** The workspace's shared quick-reply library, ordered by title. */
export async function listSavedReplies(db: Database, workspaceId: string): Promise<SavedReplyRow[]> {
  return db
    .select()
    .from(savedReplies)
    .where(eq(savedReplies.workspaceId, workspaceId))
    .orderBy(asc(savedReplies.title));
}

export async function getSavedReply(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<SavedReplyRow | null> {
  const [row] = await db
    .select()
    .from(savedReplies)
    .where(and(eq(savedReplies.id, id), eq(savedReplies.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

/** Shortcut lookup (uniqueness pre-check; the partial unique index is the backstop). */
export async function getSavedReplyByShortcut(
  db: Database,
  workspaceId: string,
  shortcut: string,
): Promise<SavedReplyRow | null> {
  const [row] = await db
    .select()
    .from(savedReplies)
    .where(and(eq(savedReplies.workspaceId, workspaceId), eq(savedReplies.shortcut, shortcut)))
    .limit(1);
  return row ?? null;
}

export async function createSavedReply(
  db: Database,
  input: {
    workspaceId: string;
    title: string;
    body: string;
    shortcut?: string | null;
    createdBy: string;
  },
): Promise<SavedReplyRow> {
  const [row] = await db
    .insert(savedReplies)
    .values({
      workspaceId: input.workspaceId,
      title: input.title,
      body: input.body,
      shortcut: input.shortcut ?? null,
      createdBy: input.createdBy,
    })
    .returning();
  return row!;
}

/**
 * Partial update; returns null when the row is not in the workspace.
 * Only the keys present in `patch` are written (shortcut: null clears it).
 */
export async function updateSavedReply(
  db: Database,
  workspaceId: string,
  id: string,
  patch: { title?: string; body?: string; shortcut?: string | null },
): Promise<SavedReplyRow | null> {
  const [row] = await db
    .update(savedReplies)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(savedReplies.id, id), eq(savedReplies.workspaceId, workspaceId)))
    .returning();
  return row ?? null;
}

/** Hard delete (workspace-scoped); false when the row is not the workspace's. */
export async function deleteSavedReply(db: Database, workspaceId: string, id: string): Promise<boolean> {
  const existing = await getSavedReply(db, workspaceId, id);
  if (!existing) return false;
  await db.delete(savedReplies).where(eq(savedReplies.id, id));
  return true;
}

// --------------------------------------------------------------- templates

export type TemplateRow = typeof templates.$inferSelect;

export async function listTemplates(db: Database, workspaceId: string): Promise<TemplateRow[]> {
  return db
    .select()
    .from(templates)
    .where(eq(templates.workspaceId, workspaceId))
    .orderBy(desc(templates.createdAt));
}

export async function getTemplate(db: Database, workspaceId: string, id: string): Promise<TemplateRow | null> {
  const [row] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.id, id), eq(templates.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

export async function createTemplate(
  db: Database,
  input: {
    workspaceId: string;
    channelAccountId: string;
    name: string;
    language?: string;
    category?: string;
    latestCategory?: string;
    externalId?: string;
    status?: string;
  },
): Promise<TemplateRow> {
  const [row] = await db
    .insert(templates)
    .values({
      workspaceId: input.workspaceId,
      channelAccountId: input.channelAccountId,
      name: input.name,
      language: input.language ?? "en",
      category: input.category,
      // latestCategory starts as the approval category until a reclassification webhook says otherwise.
      latestCategory: input.latestCategory ?? input.category,
      externalId: input.externalId,
      status: input.status ?? "approved",
    })
    .returning();
  return row!;
}

/** Category-changed flow: routing must follow latestCategory. */
export async function updateTemplateLatestCategory(
  db: Database,
  workspaceId: string,
  id: string,
  latestCategory: string,
): Promise<TemplateRow | null> {
  const [row] = await db
    .update(templates)
    .set({ latestCategory })
    .where(and(eq(templates.id, id), eq(templates.workspaceId, workspaceId)))
    .returning();
  return row ?? null;
}

// -------------------------------------------------------------- broadcasts

export type BroadcastRow = typeof broadcasts.$inferSelect;

export async function createBroadcast(
  db: Database,
  input: {
    workspaceId: string;
    channelAccountId: string;
    templateId?: string;
    /** Ordered per-recipient body parameter templates (variables #1). */
    templateParams?: string[];
    name?: string;
    tag?: string;
    country?: string;
    recipientCount: number;
    status?: string;
    estimatedCostUsd?: string;
    ratesVersion?: string;
  },
): Promise<BroadcastRow> {
  const [row] = await db
    .insert(broadcasts)
    .values({
      workspaceId: input.workspaceId,
      channelAccountId: input.channelAccountId,
      templateId: input.templateId,
      templateParams: input.templateParams ?? null,
      name: input.name,
      tag: input.tag,
      country: input.country,
      recipientCount: input.recipientCount,
      status: input.status ?? "draft",
      estimatedCostUsd: input.estimatedCostUsd,
      ratesVersion: input.ratesVersion,
    })
    .returning();
  return row!;
}

/** All broadcasts of a workspace, newest first (Broadcast history view). */
export async function listBroadcasts(db: Database, workspaceId: string): Promise<BroadcastRow[]> {
  return db
    .select()
    .from(broadcasts)
    .where(eq(broadcasts.workspaceId, workspaceId))
    .orderBy(desc(broadcasts.createdAt));
}

export async function getBroadcast(db: Database, workspaceId: string, id: string): Promise<BroadcastRow | null> {
  const [row] = await db
    .select()
    .from(broadcasts)
    .where(and(eq(broadcasts.id, id), eq(broadcasts.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

/** Worker-side lookup: jobs carry only the broadcast id, not the workspace. */
export async function getBroadcastById(db: Database, id: string): Promise<BroadcastRow | null> {
  const [row] = await db.select().from(broadcasts).where(eq(broadcasts.id, id)).limit(1);
  return row ?? null;
}

export async function updateBroadcastStatus(db: Database, id: string, status: string): Promise<void> {
  await db.update(broadcasts).set({ status }).where(eq(broadcasts.id, id));
}

export async function incrementBroadcastCounts(
  db: Database,
  id: string,
  delta: { sent?: number; failed?: number },
): Promise<void> {
  await db
    .update(broadcasts)
    .set({
      sentCount: sql`${broadcasts.sentCount} + ${delta.sent ?? 0}`,
      failedCount: sql`${broadcasts.failedCount} + ${delta.failed ?? 0}`,
    })
    .where(eq(broadcasts.id, id));
}

// ------------------------------------------------- broadcast recipients

export type BroadcastRecipientRow = typeof broadcastRecipients.$inferSelect;
export type BroadcastRecipientStatus =
  | "pending" | "sent" | "delivered" | "read" | "replied" | "failed";

/** Forward-only ordering of the happy-path lifecycle (failed sits outside it). */
const RECIPIENT_RANK: Record<string, number> = {
  pending: 0, sent: 1, delivered: 2, read: 3, replied: 4,
};

export interface BroadcastRecipientStamps {
  status: string;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  repliedAt: Date | null;
}

/**
 * Pure lifecycle guard for one recipient row (package #4): given the
 * current status + stamps and a desired transition, return the stamp
 * patch to apply, or null when the transition must not happen.
 *  - happy-path statuses advance strictly by rank (a late "delivered"
 *    webhook never regresses a "read" row; earlier unset stamps are
 *    backfilled with the same instant, e.g. delivered implies sent);
 *  - "replied" is the top rank and is stamped once - a second inbound
 *    message finds rank already maximal and changes nothing;
 *  - "failed" is reachable only from pending/sent (a provider cannot
 *    un-deliver a message) and a retry/resend success ("sent") is the
 *    one exit from it besides the explicit resend reset.
 */
export function broadcastRecipientTransition(
  current: BroadcastRecipientStamps,
  to: BroadcastRecipientStatus,
  at: Date,
): Partial<BroadcastRecipientStamps> | null {
  if (to === "failed") {
    if (current.status === "pending" || current.status === "sent" || current.status === "failed") {
      return { status: "failed" };
    }
    return null;
  }
  if (to === "sent") {
    if (current.status === "pending" || current.status === "failed") {
      return { status: "sent", sentAt: current.sentAt ?? at };
    }
    return null;
  }
  if (current.status === "failed") return null;
  const from = RECIPIENT_RANK[current.status];
  const target = RECIPIENT_RANK[to];
  if (from === undefined || target === undefined || target <= from) return null;
  const patch: Partial<BroadcastRecipientStamps> = { status: to };
  if (target >= 1) patch.sentAt = current.sentAt ?? at;
  if (target >= 2) patch.deliveredAt = current.deliveredAt ?? at;
  if (target >= 3) patch.readAt = current.readAt ?? at;
  if (to === "replied") patch.repliedAt = at;
  return patch;
}

/**
 * Fan-out bookkeeping: one pending row per (broadcast, contact),
 * created BEFORE the sends are enqueued. Safe to re-run (job retry,
 * crash recovery): existing rows are kept untouched.
 */
export async function ensureBroadcastRecipients(
  db: Database,
  input: { broadcastId: string; workspaceId: string; contactIds: string[] },
): Promise<void> {
  for (const contactId of input.contactIds) {
    const [existing] = await db
      .select({ id: broadcastRecipients.id })
      .from(broadcastRecipients)
      .where(and(eq(broadcastRecipients.broadcastId, input.broadcastId), eq(broadcastRecipients.contactId, contactId)))
      .limit(1);
    if (existing) continue;
    try {
      await db.insert(broadcastRecipients).values({
        broadcastId: input.broadcastId,
        workspaceId: input.workspaceId,
        contactId,
        status: "pending",
      });
    } catch (err) {
      // A concurrent fan-out won the insert; the unique index is the
      // arbiter and the row now exists, which is all this needs.
      if (!isUniqueViolation(err)) throw err;
    }
  }
}

async function applyRecipientTransition(
  db: Database,
  row: BroadcastRecipientRow,
  to: BroadcastRecipientStatus,
  at: Date,
  extra: { providerMessageId?: string; error?: string | null },
): Promise<boolean> {
  const patch = broadcastRecipientTransition(row, to, at);
  if (!patch) return false;
  const set: Record<string, unknown> = { ...patch, updatedAt: at };
  if (extra.providerMessageId) set.providerMessageId = extra.providerMessageId;
  if (to === "failed") set.error = extra.error ?? null;
  if (to === "sent") set.error = null;
  await db.update(broadcastRecipients).set(set).where(eq(broadcastRecipients.id, row.id));
  return true;
}

/**
 * Advance the recipient of one broadcast send, keyed by (broadcast,
 * contact) - the send processor's outcome seam. Returns true when the
 * transition was applied.
 */
export async function advanceBroadcastRecipient(
  db: Database,
  input: {
    broadcastId: string;
    contactId: string;
    to: BroadcastRecipientStatus;
    at?: Date;
    providerMessageId?: string;
    error?: string | null;
  },
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(broadcastRecipients)
    .where(and(eq(broadcastRecipients.broadcastId, input.broadcastId), eq(broadcastRecipients.contactId, input.contactId)))
    .limit(1);
  if (!row) return false;
  return applyRecipientTransition(db, row, input.to, input.at ?? new Date(), input);
}

/**
 * Advance a recipient from a provider status webhook: the webhook
 * knows only the provider message id, so the row is matched on
 * (workspace, provider_message_id). A provider "sent" echo arriving
 * while the row is still pending also advances (and backfills sentAt).
 */
export async function advanceBroadcastRecipientByProviderId(
  db: Database,
  input: {
    workspaceId: string;
    providerMessageId: string;
    to: "sent" | "delivered" | "read" | "failed";
    at?: Date;
    error?: string | null;
  },
): Promise<boolean> {
  const rows = await db
    .select()
    .from(broadcastRecipients)
    .where(and(
      eq(broadcastRecipients.workspaceId, input.workspaceId),
      eq(broadcastRecipients.providerMessageId, input.providerMessageId),
    ));
  for (const row of rows) {
    if (await applyRecipientTransition(db, row, input.to, input.at ?? new Date(), input)) return true;
  }
  return false;
}

/**
 * Mark a contact's LATEST still-open broadcast recipient as replied:
 * when a contact answers, the reply is attributed to the most recent
 * broadcast they actually received (sent/delivered/read) - older
 * broadcasts keep their state. Already-replied rows are untouched, so
 * only the first reply is ever stamped.
 */
export async function markBroadcastRecipientReplied(
  db: Database,
  input: { workspaceId: string; contactId: string; at?: Date },
): Promise<boolean> {
  const rows = await db
    .select()
    .from(broadcastRecipients)
    .where(and(
      eq(broadcastRecipients.workspaceId, input.workspaceId),
      eq(broadcastRecipients.contactId, input.contactId),
    ));
  const open = rows
    .filter((r) => r.status === "sent" || r.status === "delivered" || r.status === "read")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const latest = open[0];
  if (!latest) return false;
  return applyRecipientTransition(db, latest, "replied", input.at ?? new Date(), {});
}

export interface BroadcastRecipientWithContact extends BroadcastRecipientRow {
  contactDisplayName: string | null;
  contactExternalId: string;
  contactChannel: string;
}

/** All recipient rows of one broadcast (workspace-scoped), oldest first, with contact display info. */
export async function listBroadcastRecipients(
  db: Database,
  workspaceId: string,
  broadcastId: string,
): Promise<BroadcastRecipientWithContact[]> {
  const rows = await db
    .select({
      id: broadcastRecipients.id,
      broadcastId: broadcastRecipients.broadcastId,
      workspaceId: broadcastRecipients.workspaceId,
      contactId: broadcastRecipients.contactId,
      status: broadcastRecipients.status,
      providerMessageId: broadcastRecipients.providerMessageId,
      messageId: broadcastRecipients.messageId,
      error: broadcastRecipients.error,
      sentAt: broadcastRecipients.sentAt,
      deliveredAt: broadcastRecipients.deliveredAt,
      readAt: broadcastRecipients.readAt,
      repliedAt: broadcastRecipients.repliedAt,
      createdAt: broadcastRecipients.createdAt,
      updatedAt: broadcastRecipients.updatedAt,
      contactDisplayName: contacts.displayName,
      contactExternalId: contacts.externalId,
      contactChannel: contacts.channel,
    })
    .from(broadcastRecipients)
    .innerJoin(contacts, eq(broadcastRecipients.contactId, contacts.id))
    .where(and(
      eq(broadcastRecipients.workspaceId, workspaceId),
      eq(broadcastRecipients.broadcastId, broadcastId),
    ))
    .orderBy(asc(broadcastRecipients.createdAt));
  return rows as BroadcastRecipientWithContact[];
}

/** Contact ids of one broadcast's recipients currently in `failed` (resend targeting). */
export async function listFailedBroadcastRecipientContactIds(
  db: Database,
  workspaceId: string,
  broadcastId: string,
): Promise<string[]> {
  const rows = await db
    .select({ contactId: broadcastRecipients.contactId })
    .from(broadcastRecipients)
    .where(and(
      eq(broadcastRecipients.workspaceId, workspaceId),
      eq(broadcastRecipients.broadcastId, broadcastId),
      eq(broadcastRecipients.status, "failed"),
    ));
  return rows.map((r) => r.contactId);
}

/**
 * Resend bookkeeping: move specific recipients back to `pending` for a
 * fresh attempt (stale provider id + delivery stamps of the failed
 * attempt are cleared), or - when the resend enqueue itself failed -
 * back to `failed` with the reason.
 */
export async function resetBroadcastRecipients(
  db: Database,
  input: {
    broadcastId: string;
    contactIds: string[];
    to: "pending" | "failed";
    error?: string | null;
  },
): Promise<void> {
  for (const contactId of input.contactIds) {
    await db
      .update(broadcastRecipients)
      .set(input.to === "pending"
        ? {
            status: "pending", error: null, providerMessageId: null,
            sentAt: null, deliveredAt: null, readAt: null, updatedAt: new Date(),
          }
        : { status: "failed", error: input.error ?? null, updatedAt: new Date() })
      .where(and(
        eq(broadcastRecipients.broadcastId, input.broadcastId),
        eq(broadcastRecipients.contactId, contactId),
      ));
  }
}

// ------------------------------------------------------------- cost ledger

export async function insertCostLedger(
  db: Database,
  input: {
    workspaceId: string;
    channelAccountId?: string;
    channel: string;
    category: string;
    country?: string;
    units?: number;
    amountUsd: number;
    referenceId?: string;
  },
): Promise<void> {
  await db.insert(costLedger).values({
    workspaceId: input.workspaceId,
    channelAccountId: input.channelAccountId,
    channel: input.channel,
    category: input.category,
    country: input.country,
    units: input.units ?? 1,
    amount: input.amountUsd.toFixed(6),
    currency: "USD",
    referenceId: input.referenceId,
  });
}

/** Aggregate ledger rows written against one reference (e.g. a broadcast id). */
export async function sumCostLedgerByReference(
  db: Database,
  referenceId: string,
): Promise<{ totalUsd: number; units: number; entries: number }> {
  const rows = await db
    .select({ amount: costLedger.amount, units: costLedger.units })
    .from(costLedger)
    .where(eq(costLedger.referenceId, referenceId));
  return {
    totalUsd: rows.reduce((sum, r) => sum + Number(r.amount), 0),
    units: rows.reduce((sum, r) => sum + r.units, 0),
    entries: rows.length,
  };
}

// ---------------------------------------------------------- channel accounts

export type ChannelAccountRow = typeof channelAccounts.$inferSelect;

export async function getChannelAccount(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<ChannelAccountRow | null> {
  const [row] = await db
    .select()
    .from(channelAccounts)
    .where(and(eq(channelAccounts.id, id), eq(channelAccounts.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

/** Worker-side lookup: jobs carry only the account id, not the workspace. */
export async function getChannelAccountById(db: Database, id: string): Promise<ChannelAccountRow | null> {
  const [row] = await db.select().from(channelAccounts).where(eq(channelAccounts.id, id)).limit(1);
  return row ?? null;
}

export async function listChannelAccounts(db: Database, workspaceId: string): Promise<ChannelAccountRow[]> {
  return db
    .select()
    .from(channelAccounts)
    .where(eq(channelAccounts.workspaceId, workspaceId))
    .orderBy(desc(channelAccounts.createdAt));
}

export async function createChannelAccount(
  db: Database,
  input: {
    workspaceId: string;
    channel: string;
    externalId: string;
    displayName?: string;
    /** Public profile-picture URL captured at connect time (never a Telegram file URL - those embed the bot token). */
    avatarUrl?: string;
    authMode?: string;
    apiVersion?: string;
    capabilities?: Record<string, unknown>;
    isCoexistence?: boolean;
    /** Vault reference ONLY - raw tokens never land in this table. */
    tokenVaultRef?: string;
    tokenExpiresAt?: Date;
    status?: string;
  },
): Promise<ChannelAccountRow> {
  const [row] = await db
    .insert(channelAccounts)
    .values({
      workspaceId: input.workspaceId,
      channel: input.channel,
      externalId: input.externalId,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      authMode: input.authMode,
      apiVersion: input.apiVersion,
      capabilities: input.capabilities ?? {},
      isCoexistence: input.isCoexistence ?? false,
      tokenVaultRef: input.tokenVaultRef,
      tokenExpiresAt: input.tokenExpiresAt,
      status: input.status ?? "connected",
    })
    .returning();
  return row!;
}

/**
 * Hard-delete one channel account (Channels "disconnect"). Workspace-scoped:
 * returns the deleted row, or null when no account with that id belongs to
 * the workspace. Callers must surface FK violations (child rows in
 * conversations/broadcasts/etc. reference this table without cascades).
 */
export async function deleteChannelAccount(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<ChannelAccountRow | null> {
  const existing = await getChannelAccount(db, workspaceId, id);
  if (!existing) return null;
  await db
    .delete(channelAccounts)
    .where(and(eq(channelAccounts.id, id), eq(channelAccounts.workspaceId, workspaceId)));
  return existing;
}

/**
 * Does anything reference this channel account? Every FK into
 * channel_accounts is ON DELETE NO ACTION (baseline migration), so ANY
 * referencing row - a conversation, a template, a cost-ledger entry, a
 * domain link - means the account carries data and may only be
 * soft-disconnected, never hard-deleted. Grandchildren (messages,
 * enrollments) hang off conversations/sequences, so probing the direct
 * children is sufficient.
 */
export async function channelAccountHasReferences(db: Database, accountId: string): Promise<boolean> {
  const probes = await Promise.all([
    db.select().from(conversations).where(eq(conversations.channelAccountId, accountId)).limit(1),
    db.select().from(templates).where(eq(templates.channelAccountId, accountId)).limit(1),
    db.select().from(broadcasts).where(eq(broadcasts.channelAccountId, accountId)).limit(1),
    db.select().from(sequences).where(eq(sequences.channelAccountId, accountId)).limit(1),
    db.select().from(processedComments).where(eq(processedComments.channelAccountId, accountId)).limit(1),
    db.select().from(growthLinks).where(eq(growthLinks.channelAccountId, accountId)).limit(1),
    db.select().from(catalogProducts).where(eq(catalogProducts.channelAccountId, accountId)).limit(1),
    db.select().from(costLedger).where(eq(costLedger.channelAccountId, accountId)).limit(1),
    db.select().from(workspaceDomains).where(eq(workspaceDomains.channelAccountId, accountId)).limit(1),
  ]);
  return probes.some((rows) => rows.length > 0);
}

/**
 * Soft-disconnect one channel account in a single transaction: the row
 * (and ALL its attached data) survives, but the account is marked
 * "disconnected" and its vault reference is dropped - the caller deletes
 * the vault entry itself (the vault is an API-layer port) using the
 * tokenVaultRef of the row it read BEFORE calling this. Reconnecting the
 * same (channel, externalId) reactivates the row (see the connect
 * upserts). Returns the updated row, or null when not found in the
 * workspace.
 */
export async function softDisconnectChannelAccount(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<ChannelAccountRow | null> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const existing = await getChannelAccount(txDb, workspaceId, id);
    if (!existing) return null;
    // Item G: stamp the disconnect time — the retention sweeper purges
    // the account once the stamp is older than the retention window.
    const disconnectedAt = new Date();
    await txDb
      .update(channelAccounts)
      .set({ status: "disconnected", tokenVaultRef: null, disconnectedAt })
      .where(and(eq(channelAccounts.id, id), eq(channelAccounts.workspaceId, workspaceId)));
    return { ...existing, status: "disconnected", tokenVaultRef: null, disconnectedAt };
  });
}

/**
 * Accounts whose soft disconnect has expired at `cutoff` (item G):
 * status "disconnected" with a disconnected_at stamp at or before the
 * cutoff. The timestamp comparison runs in JS after an eq status query
 * so it behaves identically on SQL and in-memory backends (the same
 * pattern listContacts/listConversations use for non-eq filters).
 */
export async function listExpiredDisconnectedAccounts(
  db: Database,
  cutoff: Date,
): Promise<ChannelAccountRow[]> {
  const rows = await db
    .select()
    .from(channelAccounts)
    .where(eq(channelAccounts.status, "disconnected"));
  return rows.filter(
    (r) => r.disconnectedAt != null && r.disconnectedAt.getTime() <= cutoff.getTime(),
  );
}

/**
 * Retention purge (item G): permanently delete every expired
 * disconnected account via purgeChannelAccount's FK-safe semantics and
 * write one `channel.purged` audit entry per account with
 * details.reason "retention_expired" (manual purge uses "manual").
 * Returns the purged rows.
 */
export async function purgeExpiredDisconnectedAccounts(
  db: Database,
  cutoff: Date,
): Promise<ChannelAccountRow[]> {
  const expired = await listExpiredDisconnectedAccounts(db, cutoff);
  const purged: ChannelAccountRow[] = [];
  for (const account of expired) {
    const row = await purgeChannelAccount(db, account.workspaceId, account.id);
    if (!row) continue;
    purged.push(row);
    await insertAuditLog(db, {
      workspaceId: account.workspaceId,
      action: "channel.purged",
      details: { channel: account.channel, externalId: account.externalId, reason: "retention_expired" },
    });
  }
  return purged;
}

/**
 * Permanently delete a channel account AND its attached data in one
 * transaction (Channels "delete permanently", allowed only after a soft
 * disconnect - enforced by the caller). Deletion order is FK-safe for
 * the schema's all-NO-ACTION foreign keys: grandchildren first
 * (messages/webchat sessions per conversation, enrollments per
 * sequence), then the direct children (broadcasts before the templates
 * they reference), then the account row. Two referencing tables are
 * UNLINKED instead of deleted: cost_ledger (billing history is platform
 * evidence; its channel_account_id is nullable) and workspace_domains
 * (the domain registration belongs to the workspace, only the account
 * link is cleared; also nullable). Contacts and flows are shared
 * workspace data and are never touched. Returns the deleted row, or
 * null when not found in the workspace.
 */
export async function purgeChannelAccount(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<ChannelAccountRow | null> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const existing = await getChannelAccount(txDb, workspaceId, id);
    if (!existing) return null;

    const convs = await txDb.select().from(conversations).where(eq(conversations.channelAccountId, id));
    for (const conv of convs) {
      await txDb.delete(messages).where(eq(messages.conversationId, conv.id));
      await txDb.delete(webchatSessions).where(eq(webchatSessions.conversationId, conv.id));
    }
    await txDb.delete(conversations).where(eq(conversations.channelAccountId, id));

    const seqs = await txDb.select().from(sequences).where(eq(sequences.channelAccountId, id));
    for (const seq of seqs) {
      await txDb.delete(sequenceEnrollments).where(eq(sequenceEnrollments.sequenceId, seq.id));
    }
    await txDb.delete(sequences).where(eq(sequences.channelAccountId, id));

    const bcs = await txDb.select().from(broadcasts).where(eq(broadcasts.channelAccountId, id));
    for (const bc of bcs) {
      await txDb.delete(broadcastRecipients).where(eq(broadcastRecipients.broadcastId, bc.id));
    }
    await txDb.delete(broadcasts).where(eq(broadcasts.channelAccountId, id));
    await txDb.delete(templates).where(eq(templates.channelAccountId, id));
    await txDb.delete(processedComments).where(eq(processedComments.channelAccountId, id));
    await txDb.delete(growthLinks).where(eq(growthLinks.channelAccountId, id));
    await txDb.delete(catalogProducts).where(eq(catalogProducts.channelAccountId, id));

    await txDb.update(costLedger).set({ channelAccountId: null }).where(eq(costLedger.channelAccountId, id));
    await txDb.update(workspaceDomains).set({ channelAccountId: null }).where(eq(workspaceDomains.channelAccountId, id));

    await txDb
      .delete(channelAccounts)
      .where(and(eq(channelAccounts.id, id), eq(channelAccounts.workspaceId, workspaceId)));
    return existing;
  });
}

/** Worker-side lookup by provider identity (webhooks carry no workspace). */
export async function findChannelAccountByExternal(
  db: Database,
  channel: string,
  externalId: string,
): Promise<ChannelAccountRow | null> {
  const [row] = await db
    .select()
    .from(channelAccounts)
    .where(and(eq(channelAccounts.channel, channel), eq(channelAccounts.externalId, externalId)))
    .limit(1);
  return row ?? null;
}

/**
 * Update the stored profile-picture URL (re-connect refresh). Passing null
 * clears it. Telegram accounts never store a URL here (token-bearing file
 * URLs) - their avatars are proxied by the API instead.
 */
export async function updateChannelAccountAvatar(
  db: Database,
  accountId: string,
  avatarUrl: string | null,
): Promise<void> {
  await db
    .update(channelAccounts)
    .set({ avatarUrl })
    .where(eq(channelAccounts.id, accountId));
}

/** Persist the outcome of a token refresh (new expiry and/or vault ref, status). */
export async function updateChannelAccountToken(
  db: Database,
  accountId: string,
  patch: {
    tokenExpiresAt?: Date | null;
    tokenVaultRef?: string;
    status?: string;
    /** Item G: reactivation upserts clear the disconnect stamp. */
    disconnectedAt?: Date | null;
  },
): Promise<void> {
  await db
    .update(channelAccounts)
    .set({
      ...(patch.tokenExpiresAt !== undefined ? { tokenExpiresAt: patch.tokenExpiresAt } : {}),
      ...(patch.tokenVaultRef !== undefined ? { tokenVaultRef: patch.tokenVaultRef } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.disconnectedAt !== undefined ? { disconnectedAt: patch.disconnectedAt } : {}),
    })
    .where(eq(channelAccounts.id, accountId));
}

/**
 * Accounts whose token expires at or before `before` - the token-refresh
 * worker's work list. Accounts without a recorded expiry are excluded (the
 * adapters decide refresh eligibility from the expiry; unknown = skip).
 */
export async function listChannelAccountsDueForRefresh(
  db: Database,
  before: Date,
): Promise<ChannelAccountRow[]> {
  return db
    .select()
    .from(channelAccounts)
    .where(
      and(
        isNotNull(channelAccounts.tokenExpiresAt),
        lte(channelAccounts.tokenExpiresAt, before),
        eq(channelAccounts.status, "connected"),
      ),
    )
    .orderBy(asc(channelAccounts.tokenExpiresAt));
}

/** All connected accounts of one channel (webhook account resolution). */
export async function listConnectedAccountsByChannel(
  db: Database,
  channel: string,
): Promise<ChannelAccountRow[]> {
  return db
    .select()
    .from(channelAccounts)
    .where(and(eq(channelAccounts.channel, channel), eq(channelAccounts.status, "connected")));
}

// ------------------------------------------- template category (webhook flow)

/**
 * Apply a WhatsApp template category-change event: routing follows the
 * LATEST category, and the owning messaging account (WABA) id from the
 * webhook is persisted alongside. Templates are matched by provider
 * external id first, then by name inside the account's workspace.
 */
export async function applyTemplateCategoryChange(
  db: Database,
  input: {
    templateExternalId: string;
    templateName?: string;
    newCategory: string;
    messagingAccountId?: string;
  },
): Promise<TemplateRow | null> {
  let target: TemplateRow | null = null;
  if (input.templateExternalId) {
    const [row] = await db
      .select()
      .from(templates)
      .where(eq(templates.externalId, input.templateExternalId))
      .limit(1);
    target = row ?? null;
  }
  if (!target && input.templateName) {
    const [row] = await db
      .select()
      .from(templates)
      .where(eq(templates.name, input.templateName))
      .limit(1);
    target = row ?? null;
  }
  if (!target) return null;
  const [updated] = await db
    .update(templates)
    .set({
      latestCategory: input.newCategory,
      ...(input.messagingAccountId ? { messagingAccountId: input.messagingAccountId } : {}),
    })
    .where(eq(templates.id, target.id))
    .returning();
  return updated ?? null;
}

// ------------------------------------------------------------------ webchat

export type WebchatSessionRow = typeof webchatSessions.$inferSelect;

/** One webchat "account" per workspace (the widget), created on first use. */
export async function findOrCreateWebchatAccount(db: Database, workspaceId: string): Promise<ChannelAccountRow> {
  const existing = await findChannelAccountByExternal(db, "webchat", `webchat:${workspaceId}`);
  if (existing && existing.workspaceId === workspaceId) return existing;
  return createChannelAccount(db, {
    workspaceId,
    channel: "webchat",
    externalId: `webchat:${workspaceId}`,
    displayName: "Website chat",
    apiVersion: "botara-webchat-v1",
    status: "connected",
  });
}

/**
 * True when `err` is, or wraps, a Postgres unique_violation (SQLSTATE
 * 23505). The postgres-js driver surfaces it as a PostgresError carrying
 * `code`; drizzle may wrap it, so the `cause` chain is walked. An insert
 * into `conversations` can only ever hit the partial unique index
 * `conversations_open_unique_idx` (the PK is a random uuid), so a 23505
 * from a conversation insert unambiguously means "a non-resolved thread
 * for this (account, contact) already exists".
 */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth++) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function createConversation(
  db: Database,
  input: {
    workspaceId: string;
    channelAccountId: string;
    contactId: string;
    status?: string;
    /** Provider conversation id (TikTok) when the first event carries one. */
    externalId?: string;
  },
): Promise<ConversationRow> {
  try {
    const [row] = await db
      .insert(conversations)
      .values({
        workspaceId: input.workspaceId,
        channelAccountId: input.channelAccountId,
        contactId: input.contactId,
        status: input.status ?? "open",
        ...(input.externalId ? { externalId: input.externalId } : {}),
      })
      .returning();
    return row!;
  } catch (err) {
    // Race backstop for the one-open-thread invariant: two concurrent
    // inbound events can both miss the find-open lookup; the partial
    // unique index lets exactly one insert win, and the loser lands here.
    // Reuse the winner's thread instead of failing the event (the same
    // treatment findOrCreateContact gives contacts in the dispatcher).
    // Resolved inserts are outside the partial index, so they never
    // take this branch.
    if (isUniqueViolation(err) && (input.status ?? "open") !== "resolved") {
      const existing = await findOpenConversation(db, input);
      if (existing) return existing;
    }
    throw err;
  }
}

/**
 * Backfill a conversation's provider id (TikTok conversation_id learned
 * from a later inbound event). Only fills an EMPTY external_id - the
 * first learned id wins, a conflicting later id never rewrites history.
 */
export async function updateConversationExternalId(
  db: Database,
  conversationId: string,
  externalId: string,
): Promise<void> {
  await db
    .update(conversations)
    .set({ externalId })
    .where(and(eq(conversations.id, conversationId), isNull(conversations.externalId)));
}

/** Find a conversation by its provider id within one channel account. */
export async function findConversationByExternalId(
  db: Database,
  channelAccountId: string,
  externalId: string,
): Promise<ConversationRow | null> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.channelAccountId, channelAccountId), eq(conversations.externalId, externalId)))
    .limit(1);
  return row ?? null;
}

/** Fetch one conversation row by its Botara id (worker flow-run resolution). */
export async function getConversationById(
  db: Database,
  conversationId: string,
): Promise<ConversationRow | null> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return row ?? null;
}

export async function getContactByExternal(
  db: Database,
  workspaceId: string,
  channel: string,
  externalId: string,
): Promise<ContactRow | null> {
  const [row] = await db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.workspaceId, workspaceId),
        eq(contacts.channel, channel),
        eq(contacts.externalId, externalId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function createWebchatSession(
  db: Database,
  input: {
    /** Explicit id so the contact externalId `webchat-session:{id}` can reference it before insert. */
    id?: string;
    workspaceId: string;
    token: string;
    contactId: string;
    conversationId: string;
    visitorName?: string;
  },
): Promise<WebchatSessionRow> {
  const [row] = await db
    .insert(webchatSessions)
    .values({
      ...(input.id ? { id: input.id } : {}),
      workspaceId: input.workspaceId,
      token: input.token,
      contactId: input.contactId,
      conversationId: input.conversationId,
      visitorName: input.visitorName,
    })
    .returning();
  return row!;
}

/** Hard delete (publishing CRUD); worker publish jobs tolerate a missing post. */
export async function deleteScheduledPost(db: Database, workspaceId: string, id: string): Promise<boolean> {
  const existing = await getScheduledPost(db, workspaceId, id);
  if (!existing) return false;
  await db.delete(scheduledPosts).where(eq(scheduledPosts.id, id));
  return true;
}

export async function getWebchatSessionByToken(db: Database, token: string): Promise<WebchatSessionRow | null> {
  const [row] = await db.select().from(webchatSessions).where(eq(webchatSessions.token, token)).limit(1);
  return row ?? null;
}

export async function getWebchatSessionById(db: Database, id: string): Promise<WebchatSessionRow | null> {
  const [row] = await db.select().from(webchatSessions).where(eq(webchatSessions.id, id)).limit(1);
  return row ?? null;
}

export async function touchWebchatSession(db: Database, id: string, at: Date): Promise<void> {
  await db.update(webchatSessions).set({ lastSeenAt: at }).where(eq(webchatSessions.id, id));
}

// ------------------------------------------------------------ scheduled posts

export type ScheduledPostRow = typeof scheduledPosts.$inferSelect;

export interface ScheduledPostTarget {
  channelAccountId: string;
  channel: string;
  /**
   * Publish DESTINATION distinct from the account identity (item H):
   * Telegram accounts are bots, and a bot cannot post to itself — a
   * telegram target names the channel chat (chat ID or @username) the
   * post goes to. Required for telegram targets (API-enforced);
   * credentials always resolve from channelAccountId, never from this.
   */
  targetExternalId?: string;
}

export type ScheduledPostResults = Record<
  string,
  { status: "sent" | "failed"; externalPostId?: string; error?: string }
>;

export async function createScheduledPost(
  db: Database,
  input: {
    workspaceId: string;
    text?: string;
    mediaUrls?: string[];
    mediaKeys?: string[];
    targets: ScheduledPostTarget[];
    scheduledAt?: Date | null;
    status?: string;
  },
): Promise<ScheduledPostRow> {
  const [row] = await db
    .insert(scheduledPosts)
    .values({
      workspaceId: input.workspaceId,
      text: input.text,
      mediaUrls: input.mediaUrls ?? [],
      mediaKeys: input.mediaKeys ?? [],
      targets: input.targets,
      scheduledAt: input.scheduledAt ?? null,
      status: input.status ?? "scheduled",
    })
    .returning();
  return row!;
}

export async function listScheduledPosts(
  db: Database,
  workspaceId: string,
  filter: { status?: string } = {},
): Promise<ScheduledPostRow[]> {
  return db
    .select()
    .from(scheduledPosts)
    .where(
      and(
        eq(scheduledPosts.workspaceId, workspaceId),
        filter.status ? eq(scheduledPosts.status, filter.status) : undefined,
      ),
    )
    .orderBy(desc(scheduledPosts.createdAt));
}

export async function getScheduledPost(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<ScheduledPostRow | null> {
  const [row] = await db
    .select()
    .from(scheduledPosts)
    .where(and(eq(scheduledPosts.id, id), eq(scheduledPosts.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

/** Worker-side lookup: publish jobs carry only the post id. */
export async function getScheduledPostById(db: Database, id: string): Promise<ScheduledPostRow | null> {
  const [row] = await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, id)).limit(1);
  return row ?? null;
}

export async function updateScheduledPost(
  db: Database,
  id: string,
  patch: {
    text?: string;
    mediaUrls?: string[];
    targets?: ScheduledPostTarget[];
    scheduledAt?: Date | null;
    status?: string;
    results?: ScheduledPostResults;
  },
): Promise<void> {
  await db
    .update(scheduledPosts)
    .set({
      ...(patch.text !== undefined ? { text: patch.text } : {}),
      ...(patch.mediaUrls !== undefined ? { mediaUrls: patch.mediaUrls } : {}),
      ...(patch.targets !== undefined ? { targets: patch.targets } : {}),
      ...(patch.scheduledAt !== undefined ? { scheduledAt: patch.scheduledAt } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.results !== undefined ? { results: patch.results } : {}),
    })
    .where(eq(scheduledPosts.id, id));
}

/** Posts whose scheduled time has arrived and that still await publishing. */
export async function listDueScheduledPosts(db: Database, now: Date): Promise<ScheduledPostRow[]> {
  return db
    .select()
    .from(scheduledPosts)
    .where(
      and(
        eq(scheduledPosts.status, "scheduled"),
        isNotNull(scheduledPosts.scheduledAt),
        lte(scheduledPosts.scheduledAt, now),
      ),
    )
    .orderBy(asc(scheduledPosts.scheduledAt));
}

// ---------------------------------------------------------------- sequences

export type SequenceRow = typeof sequences.$inferSelect;
export type SequenceEnrollmentRow = typeof sequenceEnrollments.$inferSelect;

export interface SequenceStep {
  delaySeconds: number;
  text?: string;
  template?: {
    name: string;
    language: string;
    latestCategory: string;
    /**
     * Ordered body positional parameter templates (variables #1),
     * interpolated per recipient at send time like broadcast params.
     */
    templateParams?: string[];
  };
}

export async function createSequence(
  db: Database,
  input: { workspaceId: string; channelAccountId: string; name: string; steps: SequenceStep[]; status?: string },
): Promise<SequenceRow> {
  const [row] = await db
    .insert(sequences)
    .values({
      workspaceId: input.workspaceId,
      channelAccountId: input.channelAccountId,
      name: input.name,
      steps: input.steps,
      status: input.status ?? "active",
    })
    .returning();
  return row!;
}

export async function listSequences(db: Database, workspaceId: string): Promise<SequenceRow[]> {
  return db
    .select()
    .from(sequences)
    .where(eq(sequences.workspaceId, workspaceId))
    .orderBy(desc(sequences.createdAt));
}

export async function getSequence(db: Database, workspaceId: string, id: string): Promise<SequenceRow | null> {
  const [row] = await db
    .select()
    .from(sequences)
    .where(and(eq(sequences.id, id), eq(sequences.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

export async function updateSequence(
  db: Database,
  workspaceId: string,
  id: string,
  patch: { name?: string; steps?: SequenceStep[]; status?: string },
): Promise<SequenceRow | null> {
  const existing = await getSequence(db, workspaceId, id);
  if (!existing) return null;
  const [row] = await db
    .update(sequences)
    .set({
      name: patch.name ?? existing.name,
      steps: patch.steps ?? existing.steps,
      status: patch.status ?? existing.status,
    })
    .where(eq(sequences.id, id))
    .returning();
  return row ?? null;
}

/** Enroll one contact; re-enrolling the same contact is a no-op (unique index). */
export async function createEnrollment(
  db: Database,
  input: { workspaceId: string; sequenceId: string; contactId: string; nextStepAt: Date },
): Promise<SequenceEnrollmentRow | null> {
  const [row] = await db
    .insert(sequenceEnrollments)
    .values({
      workspaceId: input.workspaceId,
      sequenceId: input.sequenceId,
      contactId: input.contactId,
      currentStep: 0,
      status: "active",
      nextStepAt: input.nextStepAt,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

export interface DueEnrollmentSnapshot {
  enrollmentId: string;
  sequenceId: string;
  workspaceId: string;
  currentStep: number;
  steps: SequenceStep[];
  contactId: string;
  contactExternalId: string;
  channelAccountId: string;
  channel: string;
  accountExternalId: string;
  tokenVaultRef?: string;
  /** Variable-interpolation context (variables package #1). */
  contactDisplayName?: string | null;
  contactChannel: string;
  contactTags: string[];
  contactCustomFields: Record<string, unknown>;
  workspaceName?: string | null;
  channelDisplayName?: string | null;
}

/** Enrollments due to advance, fully joined for the sequence processor. */
export async function listDueEnrollments(db: Database, now: Date): Promise<DueEnrollmentSnapshot[]> {
  const rows = await db
    .select({
      enrollment: sequenceEnrollments,
      sequence: sequences,
      contact: contacts,
      account: channelAccounts,
      workspace: workspaces,
    })
    .from(sequenceEnrollments)
    .innerJoin(sequences, eq(sequenceEnrollments.sequenceId, sequences.id))
    .innerJoin(contacts, eq(sequenceEnrollments.contactId, contacts.id))
    .innerJoin(channelAccounts, eq(sequences.channelAccountId, channelAccounts.id))
    .innerJoin(workspaces, eq(sequences.workspaceId, workspaces.id))
    .where(
      and(
        eq(sequenceEnrollments.status, "active"),
        eq(sequences.status, "active"),
        isNotNull(sequenceEnrollments.nextStepAt),
        lte(sequenceEnrollments.nextStepAt, now),
      ),
    )
    .orderBy(asc(sequenceEnrollments.nextStepAt));
  return rows.map((r) => ({
    enrollmentId: r.enrollment.id,
    sequenceId: r.sequence.id,
    workspaceId: r.enrollment.workspaceId,
    currentStep: r.enrollment.currentStep,
    steps: (r.sequence.steps as SequenceStep[]) ?? [],
    contactId: r.contact.id,
    contactExternalId: r.contact.externalId,
    channelAccountId: r.account.id,
    channel: r.account.channel,
    accountExternalId: r.account.externalId,
    tokenVaultRef: r.account.tokenVaultRef ?? undefined,
    contactDisplayName: r.contact.displayName,
    contactChannel: r.contact.channel,
    contactTags: (r.contact.tags as string[]) ?? [],
    contactCustomFields: (r.contact.customFields as Record<string, unknown>) ?? {},
    workspaceName: r.workspace.name,
    channelDisplayName: r.account.displayName,
  }));
}

export async function updateEnrollment(
  db: Database,
  id: string,
  patch: { currentStep?: number; status?: string; nextStepAt?: Date | null; lastStepAt?: Date | null },
): Promise<void> {
  await db
    .update(sequenceEnrollments)
    .set({
      ...(patch.currentStep !== undefined ? { currentStep: patch.currentStep } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.nextStepAt !== undefined ? { nextStepAt: patch.nextStepAt } : {}),
      ...(patch.lastStepAt !== undefined ? { lastStepAt: patch.lastStepAt } : {}),
    })
    .where(eq(sequenceEnrollments.id, id));
}

// ------------------------------------------------- users + workspaces (Fase 3)

export type UserRow = typeof users.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type WorkspaceMemberRow = typeof workspaceMembers.$inferSelect;

export async function createUser(
  db: Database,
  input: { email: string; name?: string; passwordHash?: string; isPlatformAdmin?: boolean },
): Promise<UserRow> {
  const [row] = await db
    .insert(users)
    .values({
      email: input.email.toLowerCase(),
      name: input.name,
      passwordHash: input.passwordHash,
      isPlatformAdmin: input.isPlatformAdmin ?? false,
    })
    .returning();
  return row!;
}

export async function getUserByEmail(db: Database, email: string): Promise<UserRow | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  return row ?? null;
}

export async function getUserById(db: Database, id: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

/** Set (or replace) a user's password hash - registration claiming an invited row, password change. */
export async function setUserPasswordHash(db: Database, userId: string, passwordHash: string): Promise<void> {
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
}

export async function createWorkspace(
  db: Database,
  input: { name: string; slug: string },
): Promise<WorkspaceRow> {
  const [row] = await db.insert(workspaces).values(input).returning();
  return row!;
}

export async function getWorkspaceById(db: Database, id: string): Promise<WorkspaceRow | null> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  return row ?? null;
}

export async function getWorkspaceBySlug(db: Database, slug: string): Promise<WorkspaceRow | null> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
  return row ?? null;
}

/** Add a member, or update the role when the membership already exists. */
export async function upsertWorkspaceMember(
  db: Database,
  input: { workspaceId: string; userId: string; role: string },
): Promise<WorkspaceMemberRow> {
  const [row] = await db
    .insert(workspaceMembers)
    .values(input)
    .onConflictDoUpdate({
      target: [workspaceMembers.workspaceId, workspaceMembers.userId],
      set: { role: input.role },
    })
    .returning();
  return row!;
}

export async function getWorkspaceMember(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMemberRow | null> {
  const [row] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  return row ?? null;
}

export interface WorkspaceMembershipView {
  workspaceId: string;
  workspaceName: string;
  slug: string;
  role: string;
  createdAt: Date;
}

/** Every workspace a user belongs to, with their role - /auth/me + /workspaces. */
export async function listWorkspacesForUser(db: Database, userId: string): Promise<WorkspaceMembershipView[]> {
  const rows = await db
    .select({
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      slug: workspaces.slug,
      role: workspaceMembers.role,
      createdAt: workspaces.createdAt,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaces.createdAt));
  return rows;
}

export interface WorkspaceMemberView {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  createdAt: Date;
}

export async function listWorkspaceMembers(db: Database, workspaceId: string): Promise<WorkspaceMemberView[]> {
  return db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      role: workspaceMembers.role,
      createdAt: workspaceMembers.createdAt,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(workspaceMembers.createdAt));
}

export async function removeWorkspaceMember(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const existing = await getWorkspaceMember(db, workspaceId, userId);
  if (!existing) return false;
  await db
    .delete(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  return true;
}

// ------------------------------------------------------------ token vault (Fase 3)

export type TokenVaultRow = typeof tokenVault.$inferSelect;

export async function insertTokenVaultEntry(
  db: Database,
  input: {
    workspaceId: string;
    kind: string;
    label?: string;
    ciphertext: string;
    iv: string;
    authTag: string;
  },
): Promise<TokenVaultRow> {
  const [row] = await db.insert(tokenVault).values(input).returning();
  return row!;
}

export async function getTokenVaultEntry(db: Database, id: string): Promise<TokenVaultRow | null> {
  const [row] = await db.select().from(tokenVault).where(eq(tokenVault.id, id)).limit(1);
  return row ?? null;
}

/** Rotation replaces the sealed material in place - the vault ref stays stable. */
export async function updateTokenVaultEntry(
  db: Database,
  id: string,
  sealed: { ciphertext: string; iv: string; authTag: string },
): Promise<void> {
  await db
    .update(tokenVault)
    .set({ ...sealed, rotatedAt: new Date() })
    .where(eq(tokenVault.id, id));
}

export async function deleteTokenVaultEntry(db: Database, id: string): Promise<void> {
  await db.delete(tokenVault).where(eq(tokenVault.id, id));
}

// ------------------------------------------------------- workspace domains (Fase 3)

export type WorkspaceDomainRow = typeof workspaceDomains.$inferSelect;

export async function createWorkspaceDomain(
  db: Database,
  input: {
    workspaceId: string;
    domain: string;
    channelAccountId?: string;
    resendDomainId?: string;
    status?: string;
  },
): Promise<WorkspaceDomainRow> {
  const [row] = await db
    .insert(workspaceDomains)
    .values({ ...input, domain: input.domain.toLowerCase() })
    .returning();
  return row!;
}

export async function listWorkspaceDomains(db: Database, workspaceId: string): Promise<WorkspaceDomainRow[]> {
  return db
    .select()
    .from(workspaceDomains)
    .where(eq(workspaceDomains.workspaceId, workspaceId))
    .orderBy(asc(workspaceDomains.domain));
}

/** Inbound routing lookup: which workspace owns mail for this recipient domain. */
export async function findWorkspaceDomain(db: Database, domain: string): Promise<WorkspaceDomainRow | null> {
  const [row] = await db
    .select()
    .from(workspaceDomains)
    .where(eq(workspaceDomains.domain, domain.toLowerCase()))
    .limit(1);
  return row ?? null;
}

export async function deleteWorkspaceDomain(db: Database, workspaceId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select()
    .from(workspaceDomains)
    .where(and(eq(workspaceDomains.id, id), eq(workspaceDomains.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return false;
  await db.delete(workspaceDomains).where(eq(workspaceDomains.id, id));
  return true;
}

/** The workspace's email channel account (inbound routing fallback). */
export async function findEmailAccountForWorkspace(
  db: Database,
  workspaceId: string,
): Promise<ChannelAccountRow | null> {
  const [row] = await db
    .select()
    .from(channelAccounts)
    .where(and(eq(channelAccounts.workspaceId, workspaceId), eq(channelAccounts.channel, "email")))
    .orderBy(asc(channelAccounts.createdAt))
    .limit(1);
  return row ?? null;
}

// ------------------------------------------------------------------ audit (Fase 3)

export async function insertAuditLog(
  db: Database,
  input: {
    workspaceId?: string;
    userId?: string;
    action: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    workspaceId: input.workspaceId,
    userId: input.userId,
    action: input.action,
    details: input.details ?? {},
  });
}

// ------------------------------------------------- WhatsApp allowance count (Fase 3)

/**
 * Delivered service-message UNITS already rated for one phone number
 * (channel account) inside [from, to) - the month-to-date figure the
 * send-message processor consults before rating the next service message:
 * the first 1,000 per number per month are free.
 */
export async function countServiceUnitsInRange(
  db: Database,
  channelAccountId: string,
  from: Date,
  to: Date,
): Promise<number> {
  const rows = await db
    .select({ units: costLedger.units })
    .from(costLedger)
    .where(
      and(
        eq(costLedger.channelAccountId, channelAccountId),
        eq(costLedger.category, "service"),
        sql`${costLedger.createdAt} >= ${from}`,
        sql`${costLedger.createdAt} < ${to}`,
      ),
    );
  return rows.reduce((sum, r) => sum + r.units, 0);
}

// ------------------------------------------------------------- readiness (Fase 3)

/** Cheap liveness probe for /health/ready. Throws when the DB is unreachable. */
export async function pingDb(db: Database): Promise<void> {
  await db.execute(sql`select 1`);
}

// --------------------------------------------------------------------- KB (Fase 3)

export type KbDocumentRow = typeof kbDocuments.$inferSelect;
export type KbChunkRow = typeof kbChunks.$inferSelect;

export async function createKbDocument(
  db: Database,
  input: { workspaceId: string; title: string; sourceText: string; sourceFilename?: string | null },
): Promise<KbDocumentRow> {
  const [row] = await db.insert(kbDocuments).values(input).returning();
  return row!;
}

export async function getKbDocument(db: Database, workspaceId: string, id: string): Promise<KbDocumentRow | null> {
  const [row] = await db
    .select()
    .from(kbDocuments)
    .where(and(eq(kbDocuments.id, id), eq(kbDocuments.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

/** Worker-side lookup: ingest jobs carry only the document id. */
export async function getKbDocumentById(db: Database, id: string): Promise<KbDocumentRow | null> {
  const [row] = await db.select().from(kbDocuments).where(eq(kbDocuments.id, id)).limit(1);
  return row ?? null;
}

export async function listKbDocuments(db: Database, workspaceId: string): Promise<KbDocumentRow[]> {
  return db
    .select()
    .from(kbDocuments)
    .where(eq(kbDocuments.workspaceId, workspaceId))
    .orderBy(desc(kbDocuments.createdAt));
}

export async function updateKbDocument(
  db: Database,
  id: string,
  patch: { status?: string; chunkCount?: number; error?: string | null },
): Promise<void> {
  await db
    .update(kbDocuments)
    .set({
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.chunkCount !== undefined ? { chunkCount: patch.chunkCount } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
    })
    .where(eq(kbDocuments.id, id));
}

export async function deleteKbDocument(db: Database, workspaceId: string, id: string): Promise<boolean> {
  const existing = await getKbDocument(db, workspaceId, id);
  if (!existing) return false;
  await db.delete(kbChunks).where(eq(kbChunks.documentId, id));
  await db.delete(kbDocuments).where(eq(kbDocuments.id, id));
  return true;
}

/** Replace a document's chunks (re-ingestion is idempotent). */
export async function replaceKbChunks(
  db: Database,
  document: { id: string; workspaceId: string },
  chunks: Array<{ chunkIndex: number; text: string; embedding: number[] }>,
): Promise<void> {
  await db.delete(kbChunks).where(eq(kbChunks.documentId, document.id));
  if (chunks.length === 0) return;
  await db.insert(kbChunks).values(
    chunks.map((c) => ({
      workspaceId: document.workspaceId,
      documentId: document.id,
      chunkIndex: c.chunkIndex,
      text: c.text,
      embedding: c.embedding,
    })),
  );
}

/** Every chunk of a workspace - retrieval ranks them in code (cosine). */
/** Chunks of ONE document, in chunk order (document detail views). */
export async function listKbChunks(
  db: Database,
  workspaceId: string,
  documentId: string,
): Promise<KbChunkRow[]> {
  return db
    .select()
    .from(kbChunks)
    .where(and(eq(kbChunks.workspaceId, workspaceId), eq(kbChunks.documentId, documentId)))
    .orderBy(kbChunks.chunkIndex);
}

export async function listKbChunksByWorkspace(db: Database, workspaceId: string): Promise<KbChunkRow[]> {
  return db
    .select()
    .from(kbChunks)
    .where(eq(kbChunks.workspaceId, workspaceId))
    .orderBy(asc(kbChunks.createdAt));
}

// ------------------------------------------------- Meta data deletion (Fase 3)

export type DataDeletionRequestRow = typeof dataDeletionRequests.$inferSelect;

export async function createDataDeletionRequest(
  db: Database,
  input: { confirmationCode: string; providerUserId: string },
): Promise<DataDeletionRequestRow> {
  const [row] = await db.insert(dataDeletionRequests).values(input).returning();
  return row!;
}

export async function getDataDeletionRequestByCode(
  db: Database,
  confirmationCode: string,
): Promise<DataDeletionRequestRow | null> {
  const [row] = await db
    .select()
    .from(dataDeletionRequests)
    .where(eq(dataDeletionRequests.confirmationCode, confirmationCode))
    .limit(1);
  return row ?? null;
}

export async function completeDataDeletionRequest(db: Database, confirmationCode: string): Promise<void> {
  await db
    .update(dataDeletionRequests)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(dataDeletionRequests.confirmationCode, confirmationCode));
}

// ------------------------------------------------------------------- flows

export type FlowRow = typeof flows.$inferSelect;

export interface FlowTrigger {
  type: "keyword" | "postback" | "manual" | "comment_keyword";
  config: Record<string, unknown>;
}

export interface FlowGraph {
  startNodeId: string;
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
}

export async function createFlow(
  db: Database,
  input: { workspaceId: string; name: string; trigger: FlowTrigger; graph: FlowGraph; status?: string },
): Promise<FlowRow> {
  const [row] = await db
    .insert(flows)
    .values({
      workspaceId: input.workspaceId,
      name: input.name,
      trigger: input.trigger,
      graph: input.graph,
      status: input.status ?? "draft",
    })
    .returning();
  return row!;
}

export async function listFlows(db: Database, workspaceId: string): Promise<FlowRow[]> {
  return db
    .select()
    .from(flows)
    .where(eq(flows.workspaceId, workspaceId))
    .orderBy(desc(flows.updatedAt));
}

/** Active flows only - the inbound dispatcher's matching set. */
export async function listActiveFlows(db: Database, workspaceId: string): Promise<FlowRow[]> {
  return db
    .select()
    .from(flows)
    .where(and(eq(flows.workspaceId, workspaceId), eq(flows.status, "active")))
    .orderBy(asc(flows.createdAt));
}

export async function getFlow(db: Database, workspaceId: string, id: string): Promise<FlowRow | null> {
  const [row] = await db
    .select()
    .from(flows)
    .where(and(eq(flows.id, id), eq(flows.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

/** Worker-side lookup: flow-run jobs carry the flow id + workspace. */
export async function getFlowById(db: Database, id: string): Promise<FlowRow | null> {
  const [row] = await db.select().from(flows).where(eq(flows.id, id)).limit(1);
  return row ?? null;
}

export async function updateFlow(
  db: Database,
  workspaceId: string,
  id: string,
  patch: { name?: string; trigger?: FlowTrigger; graph?: FlowGraph; status?: string },
): Promise<FlowRow | null> {
  const existing = await getFlow(db, workspaceId, id);
  if (!existing) return null;
  const [row] = await db
    .update(flows)
    .set({
      name: patch.name ?? existing.name,
      trigger: patch.trigger ?? (existing.trigger as FlowTrigger),
      graph: patch.graph ?? (existing.graph as FlowGraph),
      status: patch.status ?? existing.status,
      updatedAt: new Date(),
    })
    .where(eq(flows.id, id))
    .returning();
  return row ?? null;
}

export async function deleteFlow(db: Database, workspaceId: string, id: string): Promise<boolean> {
  const existing = await getFlow(db, workspaceId, id);
  if (!existing) return false;
  await db.delete(flows).where(eq(flows.id, id));
  return true;
}

// ------------------------------------------------- flow waits (package #3)

/** A collect_input wait row: a flow run paused for the contact's reply. */
export type FlowWaitRow = typeof flowWaits.$inferSelect;

export async function createFlowWait(
  db: Database,
  input: {
    workspaceId: string;
    conversationId: string;
    contactId: string;
    channelAccountId: string;
    flowId: string;
    nodeId: string;
    variable: string;
    saveToContactField?: string | null;
    resumeState: Record<string, unknown>;
    deadlineAt?: Date | null;
  },
): Promise<FlowWaitRow> {
  const [row] = await db
    .insert(flowWaits)
    .values({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      channelAccountId: input.channelAccountId,
      flowId: input.flowId,
      nodeId: input.nodeId,
      variable: input.variable,
      saveToContactField: input.saveToContactField ?? null,
      resumeState: input.resumeState,
      deadlineAt: input.deadlineAt ?? null,
    })
    .returning();
  return row!;
}

/**
 * Atomically claim the OLDEST wait on a conversation: a single
 * delete ... returning statement, so when an inbound reply and the
 * wait's timeout race, exactly one claimant gets the row and the
 * other sees null (and no-ops). Returns null when nothing waits.
 */
export async function claimFlowWaitByConversation(
  db: Database,
  conversationId: string,
): Promise<FlowWaitRow | null> {
  const oldest = db
    .select({ id: flowWaits.id })
    .from(flowWaits)
    .where(eq(flowWaits.conversationId, conversationId))
    .orderBy(asc(flowWaits.createdAt))
    .limit(1);
  const [row] = await db.delete(flowWaits).where(inArray(flowWaits.id, oldest)).returning();
  return row ?? null;
}

/** Atomically claim one wait by id (the timeout path). Same race rule. */
export async function claimFlowWaitById(db: Database, id: string): Promise<FlowWaitRow | null> {
  const [row] = await db.delete(flowWaits).where(eq(flowWaits.id, id)).returning();
  return row ?? null;
}

/**
 * Drop every wait on a conversation without resuming: used when the
 * conversation resolves - a run waiting on a closed thread ends
 * quietly rather than resuming into it later.
 */
export async function deleteFlowWaitsForConversation(db: Database, conversationId: string): Promise<void> {
  await db.delete(flowWaits).where(eq(flowWaits.conversationId, conversationId));
}

/** Remove one tag from a contact if present (flow remove_tag step). */
export async function removeContactTag(
  db: Database,
  workspaceId: string,
  contactId: string,
  tag: string,
): Promise<boolean> {
  const contact = await getContact(db, workspaceId, contactId);
  if (!contact) return false;
  const tags = (contact.tags as string[]) ?? [];
  if (!tags.includes(tag)) return false;
  await updateContact(db, workspaceId, contactId, { tags: tags.filter((t) => t !== tag) });
  return true;
}

/**
 * Cancel a contact's ACTIVE sequence enrollments (flow
 * sequence_unsubscribe step): the rows are deleted, so a later
 * re-subscribe starts a fresh enrollment (the unique index would
 * otherwise block it). Without `sequenceId`, every active enrollment
 * of the contact in the workspace is cancelled. Returns the count.
 */
export async function cancelActiveEnrollments(
  db: Database,
  input: { workspaceId: string; contactId: string; sequenceId?: string },
): Promise<number> {
  const conditions = [
    eq(sequenceEnrollments.workspaceId, input.workspaceId),
    eq(sequenceEnrollments.contactId, input.contactId),
    eq(sequenceEnrollments.status, "active"),
    ...(input.sequenceId ? [eq(sequenceEnrollments.sequenceId, input.sequenceId)] : []),
  ];
  const rows = await db
    .delete(sequenceEnrollments)
    .where(and(...conditions))
    .returning({ id: sequenceEnrollments.id });
  return rows.length;
}

// ------------------------------------------- inbound persistence (Fase 4)

/** The contact's most recent not-resolved conversation on one account. */
export async function findOpenConversation(
  db: Database,
  input: { workspaceId: string; channelAccountId: string; contactId: string },
): Promise<ConversationRow | null> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, input.workspaceId),
        eq(conversations.channelAccountId, input.channelAccountId),
        eq(conversations.contactId, input.contactId),
      ),
    )
    .orderBy(desc(conversations.createdAt))
    .limit(1);
  return row && row.status !== "resolved" ? row : null;
}

/**
 * Idempotency guard for OUTBOUND sends: callers that persist a message row
 * BEFORE handing the send to a channel adapter (the inbox reply route) and
 * adapters whose store persists on delivery (webchat) meet at the
 * idempotency key - whoever arrives second must reuse the existing row
 * instead of inserting a duplicate.
 */
export async function findMessageByIdempotencyKey(
  db: Database,
  conversationId: string,
  idempotencyKey: string,
): Promise<MessageRow | null> {
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.idempotencyKey, idempotencyKey)))
    .limit(1);
  return row ?? null;
}

/** Webhook redelivery guard: provider message ids are unique per conversation. */
export async function findMessageByExternalId(
  db: Database,
  conversationId: string,
  externalId: string,
): Promise<MessageRow | null> {
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.externalId, externalId)))
    .limit(1);
  return row ?? null;
}

// ------------------------------------------------------- sequences (extra)

export async function deleteSequence(db: Database, workspaceId: string, id: string): Promise<boolean> {
  const existing = await getSequence(db, workspaceId, id);
  if (!existing) return false;
  await db.delete(sequenceEnrollments).where(eq(sequenceEnrollments.sequenceId, id));
  await db.delete(sequences).where(eq(sequences.id, id));
  return true;
}

/** Enrollment counts per sequence (all statuses) for the Sequences page. */
export async function countEnrollmentsBySequence(
  db: Database,
  workspaceId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ sequenceId: sequenceEnrollments.sequenceId })
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.workspaceId, workspaceId));
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.sequenceId, (counts.get(r.sequenceId) ?? 0) + 1);
  return counts;
}

// ------------------------------------------------------------ user/profile

export async function updateUserName(db: Database, userId: string, name: string): Promise<void> {
  await db.update(users).set({ name }).where(eq(users.id, userId));
}

export async function updateWorkspaceName(db: Database, workspaceId: string, name: string): Promise<void> {
  await db.update(workspaces).set({ name }).where(eq(workspaces.id, workspaceId));
}

// ------------------------------------------------------- dashboard stats

export interface WorkspaceStats {
  contactsTotal: number;
  conversationsOpen: number;
  conversationsTotal: number;
  messagesLast30d: { in: number; out: number };
  broadcastsThisMonth: { sent: number; failed: number };
  /** Messaging cost for the current month, summed per currency. */
  costThisMonth: Array<{ currency: string; amount: number }>;
  scheduledPostsPending: number;
  activeFlows: number;
}

/**
 * Dashboard aggregations (Fase 4). Plain counts/sums over the workspace's
 * own rows; messages join through conversations because the messages table
 * carries no workspace column by design.
 */
export async function getWorkspaceStats(
  db: Database,
  workspaceId: string,
  monthStart: Date,
  thirtyDaysAgo: Date,
): Promise<WorkspaceStats> {
  const countOf = async (p: Promise<Array<{ value: number | string }>>): Promise<number> => {
    const rows = await p;
    return Number(rows[0]?.value ?? 0);
  };
  const cnt = () => sql<number>`count(*)::int`;

  const contactsTotal = await countOf(
    db.select({ value: cnt() }).from(contacts).where(eq(contacts.workspaceId, workspaceId)),
  );
  const conversationsTotal = await countOf(
    db.select({ value: cnt() }).from(conversations).where(eq(conversations.workspaceId, workspaceId)),
  );
  const conversationsOpen = await countOf(
    db.select({ value: cnt() }).from(conversations)
      .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.status, "open"))),
  );
  const messageRows = await db
    .select({ direction: messages.direction, value: cnt() })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(and(eq(conversations.workspaceId, workspaceId), sql`${messages.createdAt} >= ${thirtyDaysAgo.toISOString()}::timestamptz`))
    .groupBy(messages.direction);
  const broadcastsRows = await db
    .select({ sent: broadcasts.sentCount, failed: broadcasts.failedCount })
    .from(broadcasts)
    .where(and(eq(broadcasts.workspaceId, workspaceId), sql`${broadcasts.createdAt} >= ${monthStart.toISOString()}::timestamptz`));
  const costRows = await db
    .select({ currency: costLedger.currency, total: sql<string>`coalesce(sum(${costLedger.amount}),0)` })
    .from(costLedger)
    .where(and(eq(costLedger.workspaceId, workspaceId), sql`${costLedger.createdAt} >= ${monthStart.toISOString()}::timestamptz`))
    .groupBy(costLedger.currency);
  const scheduledPostsPending = await countOf(
    db.select({ value: cnt() }).from(scheduledPosts)
      .where(and(
        eq(scheduledPosts.workspaceId, workspaceId),
        sql`${scheduledPosts.status} in ('draft','scheduled','publishing')`,
      )),
  );
  const activeFlows = await countOf(
    db.select({ value: cnt() }).from(flows)
      .where(and(eq(flows.workspaceId, workspaceId), eq(flows.status, "active"))),
  );
  const byDirection = new Map(messageRows.map((r) => [r.direction, Number(r.value)]));
  return {
    contactsTotal,
    conversationsOpen,
    conversationsTotal,
    messagesLast30d: { in: byDirection.get("in") ?? 0, out: byDirection.get("out") ?? 0 },
    broadcastsThisMonth: {
      sent: broadcastsRows.reduce((s, r) => s + r.sent, 0),
      failed: broadcastsRows.reduce((s, r) => s + r.failed, 0),
    },
    costThisMonth: costRows.map((r) => ({ currency: r.currency, amount: Number(r.total) })),
    scheduledPostsPending,
    activeFlows,
  };
}

// ------------------------------------------------- API tokens (adopted features)

export type ApiTokenRow = typeof apiTokens.$inferSelect;

export async function createApiToken(
  db: Database,
  input: { userId: string; name: string; tokenHash: string; prefix: string },
): Promise<ApiTokenRow> {
  const [row] = await db
    .insert(apiTokens)
    .values({ userId: input.userId, name: input.name, tokenHash: input.tokenHash, prefix: input.prefix })
    .returning();
  return row!;
}

export async function listApiTokensByUser(db: Database, userId: string): Promise<ApiTokenRow[]> {
  return db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(desc(apiTokens.createdAt));
}

/** Auth lookup: the caller hashes the presented token; revoked rows never match. */
export async function findApiTokenByHash(db: Database, tokenHash: string): Promise<ApiTokenRow | null> {
  const [row] = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, tokenHash), sql`${apiTokens.revokedAt} is null`))
    .limit(1);
  return row ?? null;
}

export async function touchApiToken(db: Database, id: string, at: Date): Promise<void> {
  await db.update(apiTokens).set({ lastUsedAt: at }).where(eq(apiTokens.id, id));
}

/** Revoke (soft delete): the row stays for audit, the hash stops authenticating. */
export async function revokeApiToken(db: Database, userId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId), sql`${apiTokens.revokedAt} is null`))
    .returning();
  return rows.length > 0;
}

// ------------------------------------------- processed comments (adopted features)

/** True when a comment-action for (account, comment, flow) was already claimed. */
export async function isCommentProcessed(
  db: Database,
  input: { channelAccountId: string; commentExternalId: string; flowId: string },
): Promise<boolean> {
  const [row] = await db
    .select({ id: processedComments.id })
    .from(processedComments)
    .where(
      and(
        eq(processedComments.channelAccountId, input.channelAccountId),
        eq(processedComments.commentExternalId, input.commentExternalId),
        eq(processedComments.flowId, input.flowId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Claim a comment for a flow. Returns false when the unique index says it
 * was already claimed (webhook redelivery / queue retry) - the caller must
 * then skip the whole action set.
 */
export async function markCommentProcessed(
  db: Database,
  input: { workspaceId: string; channelAccountId: string; commentExternalId: string; flowId: string },
): Promise<boolean> {
  const inserted = await db
    .insert(processedComments)
    .values(input)
    .onConflictDoNothing()
    .returning();
  return inserted.length > 0;
}

// ------------------------------------------------ growth links (adopted features)

export type GrowthLinkRow = typeof growthLinks.$inferSelect;

export async function createGrowthLink(
  db: Database,
  input: {
    workspaceId: string;
    channelAccountId: string;
    kind: string;
    slug: string;
    label: string;
    prefilledText?: string;
    boundFlowId?: string;
    targetRef?: string;
    targetUrl?: string;
  },
): Promise<GrowthLinkRow> {
  const [row] = await db
    .insert(growthLinks)
    .values({
      workspaceId: input.workspaceId,
      channelAccountId: input.channelAccountId,
      kind: input.kind,
      slug: input.slug,
      label: input.label,
      prefilledText: input.prefilledText,
      boundFlowId: input.boundFlowId,
      targetRef: input.targetRef,
      targetUrl: input.targetUrl,
    })
    .returning();
  return row!;
}

export async function listGrowthLinks(db: Database, workspaceId: string): Promise<GrowthLinkRow[]> {
  return db
    .select()
    .from(growthLinks)
    .where(eq(growthLinks.workspaceId, workspaceId))
    .orderBy(desc(growthLinks.createdAt));
}

export async function getGrowthLink(db: Database, workspaceId: string, id: string): Promise<GrowthLinkRow | null> {
  const [row] = await db
    .select()
    .from(growthLinks)
    .where(and(eq(growthLinks.id, id), eq(growthLinks.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

/** All growth links bound to one channel account (WhatsApp single-link attribution). */
export async function listGrowthLinksByAccount(db: Database, channelAccountId: string): Promise<GrowthLinkRow[]> {
  return db
    .select()
    .from(growthLinks)
    .where(eq(growthLinks.channelAccountId, channelAccountId))
    .orderBy(desc(growthLinks.createdAt));
}

/** Slugs are globally unique - the public redirect resolves by slug alone. */
export async function getGrowthLinkBySlug(db: Database, slug: string): Promise<GrowthLinkRow | null> {
  const [row] = await db
    .select()
    .from(growthLinks)
    .where(eq(growthLinks.slug, slug))
    .limit(1);
  return row ?? null;
}

export async function deleteGrowthLink(db: Database, workspaceId: string, id: string): Promise<boolean> {
  const existing = await getGrowthLink(db, workspaceId, id);
  if (!existing) return false;
  await db.delete(growthLinks).where(eq(growthLinks.id, id));
  return true;
}

export async function incrementGrowthLinkClicks(db: Database, id: string): Promise<void> {
  await db
    .update(growthLinks)
    .set({ clicks: sql`${growthLinks.clicks} + 1`, updatedAt: new Date() })
    .where(eq(growthLinks.id, id));
}

export async function incrementGrowthLinkConversions(db: Database, id: string): Promise<void> {
  await db
    .update(growthLinks)
    .set({ conversions: sql`${growthLinks.conversions} + 1`, updatedAt: new Date() })
    .where(eq(growthLinks.id, id));
}

// --------------------------------------------- contact import + tagging helpers

/**
 * Insert-or-update one contact by its (workspace, channel, externalId)
 * identity - the bulk-import workhorse. "skip" leaves an existing row
 * untouched; "update" overwrites the display name when provided, UNIONS
 * the tags, and merges custom fields.
 */
export async function upsertContactByExternal(
  db: Database,
  input: {
    workspaceId: string;
    channel: string;
    externalId: string;
    displayName?: string;
    tags?: string[];
    customFields?: Record<string, unknown>;
  },
  conflict: "skip" | "update",
): Promise<{ row: ContactRow; created: boolean }> {
  const existing = await getContactByExternal(db, input.workspaceId, input.channel, input.externalId);
  if (!existing) {
    const row = await createContact(db, input);
    return { row, created: true };
  }
  if (conflict === "skip") return { row: existing, created: false };
  const mergedTags = [...new Set([...((existing.tags as string[]) ?? []), ...(input.tags ?? [])])];
  const updated = await updateContact(db, input.workspaceId, existing.id, {
    displayName: input.displayName ?? undefined,
    tags: mergedTags,
    customFields: input.customFields,
  });
  return { row: updated ?? existing, created: false };
}

/** Add one tag to a contact if absent (growth attribution writes `growth:<slug>`). */
export async function addContactTag(
  db: Database,
  workspaceId: string,
  contactId: string,
  tag: string,
): Promise<boolean> {
  const contact = await getContact(db, workspaceId, contactId);
  if (!contact) return false;
  const tags = (contact.tags as string[]) ?? [];
  if (tags.includes(tag)) return false;
  await updateContact(db, workspaceId, contactId, { tags: [...tags, tag] });
  return true;
}

// ------------------------------------------------------- catalog products

export type CatalogProductRow = typeof catalogProducts.$inferSelect;

export interface CatalogProductInput {
  workspaceId: string;
  channelAccountId: string;
  catalogId: string;
  retailerId: string;
  name: string;
  description?: string | null;
  priceAmount?: string | null;
  currency?: string | null;
  imageUrl?: string | null;
  availability?: string | null;
  link?: string | null;
  raw?: Record<string, unknown> | null;
  syncedAt: Date;
}

/**
 * Insert or update one synced product, keyed by
 * (channelAccountId, catalogId, retailerId). Lookup-then-write keeps the
 * upsert portable across SQL backends (and the in-memory test fake).
 */
export async function upsertCatalogProduct(
  db: Database,
  input: CatalogProductInput,
): Promise<CatalogProductRow> {
  const [existing] = await db
    .select()
    .from(catalogProducts)
    .where(
      and(
        eq(catalogProducts.channelAccountId, input.channelAccountId),
        eq(catalogProducts.catalogId, input.catalogId),
        eq(catalogProducts.retailerId, input.retailerId),
      ),
    )
    .limit(1);
  const values = {
    name: input.name,
    description: input.description ?? null,
    priceAmount: input.priceAmount ?? null,
    currency: input.currency ?? null,
    imageUrl: input.imageUrl ?? null,
    availability: input.availability ?? null,
    link: input.link ?? null,
    raw: input.raw ?? null,
    syncedAt: input.syncedAt,
    updatedAt: new Date(),
  };
  if (existing) {
    const [row] = await db
      .update(catalogProducts)
      .set(values)
      .where(eq(catalogProducts.id, existing.id))
      .returning();
    return row!;
  }
  const [row] = await db
    .insert(catalogProducts)
    .values({ ...input, ...values })
    .returning();
  return row!;
}

/**
 * List a workspace's synced catalog products (picker + summary reads).
 * `q` matches name or retailer id, case-insensitively (JS filter, same
 * precedent as the contacts tag filter).
 */
export async function listCatalogProducts(
  db: Database,
  workspaceId: string,
  filter: { accountId?: string; q?: string; limit?: number } = {},
): Promise<CatalogProductRow[]> {
  const rows = await db
    .select()
    .from(catalogProducts)
    .where(
      and(
        eq(catalogProducts.workspaceId, workspaceId),
        filter.accountId ? eq(catalogProducts.channelAccountId, filter.accountId) : undefined,
      ),
    )
    .orderBy(asc(catalogProducts.name));
  const q = filter.q?.trim().toLowerCase();
  const filtered = q
    ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.retailerId.toLowerCase().includes(q))
    : rows;
  return filter.limit ? filtered.slice(0, filter.limit) : filtered;
}

/** (id, retailerId) pairs currently mirrored for one account + catalog - the stale-deletion baseline. */
export async function listCatalogProductKeys(
  db: Database,
  channelAccountId: string,
  catalogId: string,
): Promise<Array<{ id: string; retailerId: string }>> {
  const rows = await db
    .select({ id: catalogProducts.id, retailerId: catalogProducts.retailerId })
    .from(catalogProducts)
    .where(
      and(
        eq(catalogProducts.channelAccountId, channelAccountId),
        eq(catalogProducts.catalogId, catalogId),
      ),
    );
  return rows;
}

export async function deleteCatalogProduct(db: Database, id: string): Promise<void> {
  await db.delete(catalogProducts).where(eq(catalogProducts.id, id));
}

/**
 * Best-effort purge of everything Botara holds for one provider user id
 * (the id Meta puts in a data-deletion signed_request): contacts with that
 * external id, plus their messages, webchat sessions, sequence enrollments
 * and conversations. Channel accounts are the WORKSPACE's credentials, not
 * the end user's data, and are never touched here.
 */
// ------------------------------------------- platform admin (admin panel)

export type PlatformSettingRow = typeof platformSettings.$inferSelect;

export async function getPlatformSetting(db: Database, key: string): Promise<PlatformSettingRow | null> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, key)).limit(1);
  return row ?? null;
}

export async function listPlatformSettings(db: Database): Promise<PlatformSettingRow[]> {
  return db.select().from(platformSettings).orderBy(asc(platformSettings.key));
}

/**
 * Insert or replace one platform setting. Exactly one of `value` /
 * `secretCiphertext` carries the payload (plaintext for non-secrets,
 * AES-256-GCM sealed blob for secrets - see platform-settings.ts); the
 * other is always written as null so a key can never hold both.
 */
export async function upsertPlatformSetting(
  db: Database,
  input: { key: string; value?: string | null; secretCiphertext?: string | null; updatedBy?: string },
): Promise<PlatformSettingRow> {
  const values = {
    key: input.key,
    value: input.value ?? null,
    secretCiphertext: input.secretCiphertext ?? null,
    updatedBy: input.updatedBy,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(platformSettings)
    .values(values)
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { value: values.value, secretCiphertext: values.secretCiphertext, updatedBy: values.updatedBy, updatedAt: values.updatedAt },
    })
    .returning();
  return row!;
}

/** Remove the DB value for a key (env fallback then applies). Returns false when no row existed. */
export async function deletePlatformSetting(db: Database, key: string): Promise<boolean> {
  const rows = await db.delete(platformSettings).where(eq(platformSettings.key, key)).returning();
  return rows.length > 0;
}

/** Total registered users - the platform-admin bootstrap checks this for 0. */
export async function countUsers(db: Database): Promise<number> {
  const rows = await db.select({ value: sql<number>`count(*)::int` }).from(users);
  return Number(rows[0]?.value ?? 0);
}

export async function countPlatformAdmins(db: Database): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.isPlatformAdmin, true));
  return Number(rows[0]?.value ?? 0);
}

/** Grant or revoke the platform-operator flag. Returns the updated row (null when no such user). */
export async function setUserPlatformAdmin(
  db: Database,
  userId: string,
  isPlatformAdmin: boolean,
): Promise<UserRow | null> {
  const [row] = await db
    .update(users)
    .set({ isPlatformAdmin })
    .where(eq(users.id, userId))
    .returning();
  return row ?? null;
}

/** Stamp a successful login (drives the admin panel's "active users"). */
export async function touchUserLastLogin(db: Database, userId: string, at: Date): Promise<void> {
  await db.update(users).set({ lastLoginAt: at }).where(eq(users.id, userId));
}

/** Users whose last login is at/after `since` (active-user windows). */
export async function countActiveUsers(db: Database, since: Date): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(users)
    .where(sql`${users.lastLoginAt} >= ${since.toISOString()}::timestamptz`);
  return Number(rows[0]?.value ?? 0);
}

export async function listRecentUsers(db: Database, limit: number): Promise<UserRow[]> {
  return db.select().from(users).orderBy(desc(users.createdAt)).limit(limit);
}

export interface AdminUserView extends UserRow {
  memberships: Array<{ workspaceId: string; workspaceName: string; role: string }>;
}

/** Every user with their workspace memberships (admin Users view). */
export async function listUsersAdmin(db: Database): Promise<AdminUserView[]> {
  const userRows = await db.select().from(users).orderBy(asc(users.createdAt));
  const memberRows = await db
    .select({
      userId: workspaceMembers.userId,
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id));
  const byUser = new Map<string, AdminUserView["memberships"]>();
  for (const m of memberRows) {
    const list = byUser.get(m.userId) ?? [];
    list.push({ workspaceId: m.workspaceId, workspaceName: m.workspaceName, role: m.role });
    byUser.set(m.userId, list);
  }
  return userRows.map((u) => ({ ...u, memberships: byUser.get(u.id) ?? [] }));
}

export interface AdminWorkspaceView extends WorkspaceRow {
  ownerEmail: string | null;
  memberCount: number;
  channelAccountCount: number;
  messageCount: number;
}

/** Every workspace with owner + headline counts (admin Workspaces view). */
export async function listWorkspacesAdmin(db: Database): Promise<AdminWorkspaceView[]> {
  const wsRows = await db.select().from(workspaces).orderBy(asc(workspaces.createdAt));
  const ownerRows = await db
    .select({ workspaceId: workspaceMembers.workspaceId, email: users.email })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(eq(workspaceMembers.role, "owner"));
  const memberCounts = await db
    .select({ workspaceId: workspaceMembers.workspaceId, value: sql<number>`count(*)::int` })
    .from(workspaceMembers)
    .groupBy(workspaceMembers.workspaceId);
  const accountCounts = await db
    .select({ workspaceId: channelAccounts.workspaceId, value: sql<number>`count(*)::int` })
    .from(channelAccounts)
    .groupBy(channelAccounts.workspaceId);
  // Messages carry no workspace column (by design) - count through conversations.
  const messageCounts = await db
    .select({ workspaceId: conversations.workspaceId, value: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .groupBy(conversations.workspaceId);
  const ownerByWs = new Map(ownerRows.map((r) => [r.workspaceId, r.email]));
  const membersByWs = new Map(memberCounts.map((r) => [r.workspaceId, Number(r.value)]));
  const accountsByWs = new Map(accountCounts.map((r) => [r.workspaceId, Number(r.value)]));
  const messagesByWs = new Map(messageCounts.map((r) => [r.workspaceId, Number(r.value)]));
  return wsRows.map((w) => ({
    ...w,
    ownerEmail: ownerByWs.get(w.id) ?? null,
    memberCount: membersByWs.get(w.id) ?? 0,
    channelAccountCount: accountsByWs.get(w.id) ?? 0,
    messageCount: messagesByWs.get(w.id) ?? 0,
  }));
}

export async function countWorkspaces(db: Database): Promise<number> {
  const rows = await db.select({ value: sql<number>`count(*)::int` }).from(workspaces);
  return Number(rows[0]?.value ?? 0);
}

/** Channel account totals per channel key (admin Overview). */
export async function countChannelAccountsByChannel(
  db: Database,
): Promise<Array<{ channel: string; count: number }>> {
  const rows = await db
    .select({ channel: channelAccounts.channel, value: sql<number>`count(*)::int` })
    .from(channelAccounts)
    .groupBy(channelAccounts.channel)
    .orderBy(asc(channelAccounts.channel));
  return rows.map((r) => ({ channel: r.channel, count: Number(r.value) }));
}

/** All messages, or only those created at/after `since` when given. */
export async function countMessages(db: Database, since?: Date): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(messages)
    .where(since ? sql`${messages.createdAt} >= ${since.toISOString()}::timestamptz` : undefined);
  return Number(rows[0]?.value ?? 0);
}

export interface AdminAuditView {
  id: string;
  workspaceId: string | null;
  userId: string | null;
  actorEmail: string | null;
  action: string;
  details: Record<string, unknown>;
  createdAt: Date;
}

/** Most recent audit rows across the whole deployment (admin Audit view). */
export async function listRecentAuditLogs(db: Database, limit: number): Promise<AdminAuditView[]> {
  const rows = await db
    .select({
      id: auditLog.id,
      workspaceId: auditLog.workspaceId,
      userId: auditLog.userId,
      actorEmail: users.email,
      action: auditLog.action,
      details: auditLog.details,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.userId, users.id))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, details: (r.details as Record<string, unknown>) ?? {} }));
}

export interface PlatformBillingRow {
  workspaceId: string;
  workspaceName: string;
  category: string;
  currency: string;
  /** Billable units (messages) in this category over the window. */
  units: number;
  /** Charged entries in the ledger for this slice. */
  entries: number;
  /** Estimated cost: the ledger `amount` sum, in `currency` major units (USD in practice). */
  amount: number;
}

/**
 * Per-workspace usage/cost aggregation over the WhatsApp cost ledger
 * (cost_ledger) since `since`. The ledger records one row per rated send:
 * units = messages, amount = the rated cost in the row's currency (the
 * writer always stamps USD today; grouped by currency so a future
 * multi-currency writer stays correct).
 */
export async function getPlatformBilling(db: Database, since: Date): Promise<PlatformBillingRow[]> {
  const rows = await db
    .select({
      workspaceId: costLedger.workspaceId,
      workspaceName: workspaces.name,
      category: costLedger.category,
      currency: costLedger.currency,
      units: sql<string>`coalesce(sum(${costLedger.units}),0)`,
      entries: sql<number>`count(*)::int`,
      amount: sql<string>`coalesce(sum(${costLedger.amount}),0)`,
    })
    .from(costLedger)
    .innerJoin(workspaces, eq(costLedger.workspaceId, workspaces.id))
    .where(sql`${costLedger.createdAt} >= ${since.toISOString()}::timestamptz`)
    .groupBy(costLedger.workspaceId, workspaces.name, costLedger.category, costLedger.currency)
    .orderBy(asc(workspaces.name), asc(costLedger.category));
  return rows.map((r) => ({
    workspaceId: r.workspaceId,
    workspaceName: r.workspaceName,
    category: r.category,
    currency: r.currency,
    units: Number(r.units),
    entries: Number(r.entries),
    amount: Number(r.amount),
  }));
}

/**
 * Best-effort purge of everything Botara holds for one provider user id
 * (the id Meta puts in a data-deletion signed_request): contacts with that
 * external id, plus their messages, webchat sessions, sequence enrollments
 * and conversations. Channel accounts are the WORKSPACE's credentials, not
 * the end user's data, and are never touched here.
 */
export async function purgeExternalUserData(
  db: Database,
  providerUserId: string,
): Promise<{ contacts: number }> {
  const rows = await db.select().from(contacts).where(eq(contacts.externalId, providerUserId));
  for (const contact of rows) {
    const convs = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.contactId, contact.id));
    for (const conv of convs) {
      await db.delete(messages).where(eq(messages.conversationId, conv.id));
    }
    await db.delete(webchatSessions).where(eq(webchatSessions.contactId, contact.id));
    await db.delete(sequenceEnrollments).where(eq(sequenceEnrollments.contactId, contact.id));
    await db.delete(broadcastRecipients).where(eq(broadcastRecipients.contactId, contact.id));
    await db.delete(conversations).where(eq(conversations.contactId, contact.id));
    await db.delete(contacts).where(eq(contacts.id, contact.id));
  }
  return { contacts: rows.length };
}
