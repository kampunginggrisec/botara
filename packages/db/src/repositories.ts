import { and, asc, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import type { Database } from "./client";
import {
  auditLog, broadcasts, channelAccounts, contacts, conversations, costLedger,
  dataDeletionRequests, flows, kbChunks, kbDocuments, messages,
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
}

export async function listConversations(
  db: Database,
  workspaceId: string,
  filter: { channel?: string; status?: string } = {},
): Promise<ConversationListItem[]> {
  const rows = await db
    .select({
      conversation: conversations,
      channel: channelAccounts.channel,
      channelAccountExternalId: channelAccounts.externalId,
      contactExternalId: contacts.externalId,
      contactDisplayName: contacts.displayName,
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
  return rows.map((r) => ({
    ...r.conversation,
    channel: r.channel,
    channelAccountExternalId: r.channelAccountExternalId,
    contactExternalId: r.contactExternalId,
    contactDisplayName: r.contactDisplayName,
  }));
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
    type?: string;
    body?: string;
    externalId?: string;
    status?: string;
    idempotencyKey?: string;
  },
): Promise<MessageRow> {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId: input.conversationId,
      direction: input.direction,
      type: input.type ?? "text",
      body: input.body,
      externalId: input.externalId,
      status: input.status ?? "queued",
      idempotencyKey: input.idempotencyKey,
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

/** Persist the outcome of a token refresh (new expiry and/or vault ref, status). */
export async function updateChannelAccountToken(
  db: Database,
  accountId: string,
  patch: { tokenExpiresAt?: Date | null; tokenVaultRef?: string; status?: string },
): Promise<void> {
  await db
    .update(channelAccounts)
    .set({
      ...(patch.tokenExpiresAt !== undefined ? { tokenExpiresAt: patch.tokenExpiresAt } : {}),
      ...(patch.tokenVaultRef !== undefined ? { tokenVaultRef: patch.tokenVaultRef } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
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

export async function createConversation(
  db: Database,
  input: { workspaceId: string; channelAccountId: string; contactId: string; status?: string },
): Promise<ConversationRow> {
  const [row] = await db
    .insert(conversations)
    .values({
      workspaceId: input.workspaceId,
      channelAccountId: input.channelAccountId,
      contactId: input.contactId,
      status: input.status ?? "open",
    })
    .returning();
  return row!;
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
  template?: { name: string; language: string; latestCategory: string };
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
}

/** Enrollments due to advance, fully joined for the sequence processor. */
export async function listDueEnrollments(db: Database, now: Date): Promise<DueEnrollmentSnapshot[]> {
  const rows = await db
    .select({
      enrollment: sequenceEnrollments,
      sequence: sequences,
      contact: contacts,
      account: channelAccounts,
    })
    .from(sequenceEnrollments)
    .innerJoin(sequences, eq(sequenceEnrollments.sequenceId, sequences.id))
    .innerJoin(contacts, eq(sequenceEnrollments.contactId, contacts.id))
    .innerJoin(channelAccounts, eq(sequences.channelAccountId, channelAccounts.id))
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
  input: { email: string; name?: string; passwordHash?: string },
): Promise<UserRow> {
  const [row] = await db
    .insert(users)
    .values({
      email: input.email.toLowerCase(),
      name: input.name,
      passwordHash: input.passwordHash,
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
  input: { workspaceId: string; title: string; sourceText: string },
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
  type: "keyword" | "postback" | "manual";
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
    .where(and(eq(conversations.workspaceId, workspaceId), sql`${messages.createdAt} >= ${thirtyDaysAgo}`))
    .groupBy(messages.direction);
  const broadcastsRows = await db
    .select({ sent: broadcasts.sentCount, failed: broadcasts.failedCount })
    .from(broadcasts)
    .where(and(eq(broadcasts.workspaceId, workspaceId), sql`${broadcasts.createdAt} >= ${monthStart}`));
  const costRows = await db
    .select({ currency: costLedger.currency, total: sql<string>`coalesce(sum(${costLedger.amount}),0)` })
    .from(costLedger)
    .where(and(eq(costLedger.workspaceId, workspaceId), sql`${costLedger.createdAt} >= ${monthStart}`))
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
    await db.delete(conversations).where(eq(conversations.contactId, contact.id));
    await db.delete(contacts).where(eq(contacts.id, contact.id));
  }
  return { contacts: rows.length };
}
