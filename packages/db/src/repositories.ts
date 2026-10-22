import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client";
import {
  broadcasts, channelAccounts, contacts, conversations, costLedger, messages, templates,
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
