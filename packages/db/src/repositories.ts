import { and, asc, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import type { Database } from "./client";
import {
  broadcasts, channelAccounts, contacts, conversations, costLedger, messages,
  scheduledPosts, sequenceEnrollments, sequences, templates, webchatSessions,
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
