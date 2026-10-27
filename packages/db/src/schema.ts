import { sql } from "drizzle-orm";
import {
  pgTable, uuid, varchar, text, timestamp, boolean, jsonb, integer, numeric, date, uniqueIndex, index,
} from "drizzle-orm/pg-core";

/**
 * Fase 0 core schema. Deliberately minimal but shaped for the blueprint:
 * multi-workspace tenancy, channel accounts with capability snapshots and a
 * token-vault reference (raw tokens are never stored in these tables),
 * conversations carry last_user_message_at for messaging-window enforcement,
 * templates carry latest_category for WhatsApp dual-API routing, and every
 * billable send lands in cost_ledger.
 */

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 200 }).notNull(),
  slug: varchar("slug", { length: 120 }).notNull(),
  /**
   * Default currency for money the workspace denominates itself (deal
   * values, package #6). ISO 4217 code; IDR-first per the adoption
   * program defaults - Indonesian workspaces are the primary audience,
   * and a deal created without an explicit currency lands here.
   */
  defaultCurrency: varchar("default_currency", { length: 3 }).notNull().default("IDR"),
  /**
   * Reply target in minutes (package #8): an open conversation whose
   * latest inbound message has waited longer than this counts as
   * over-target in GET /stats/insights. Workspace-level service goal,
   * edited by workspace admins next to the default currency.
   */
  replyTargetMinutes: integer("reply_target_minutes").notNull().default(60),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("workspaces_slug_idx").on(t.slug)]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 320 }).notNull(),
  name: varchar("name", { length: 200 }),
  /**
   * Argon2id password hash (Bun.password). Nullable: a user row can exist
   * before its owner ever logs in - workspace invites create the row by
   * email, and registration later claims it by setting the hash.
   */
  passwordHash: varchar("password_hash", { length: 300 }),
  /**
   * Platform operator flag (admin panel). NOT a workspace role: it marks
   * the deployment's operator, who can open /admin. Bootstrap rule: the
   * FIRST registered user (users table empty at registration) receives it;
   * platform admins can grant/revoke it later, but never from the last
   * remaining platform admin.
   */
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  /** Last successful login - the honest basis for "active users" counts. */
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("users_email_idx").on(t.email)]);

export const workspaceMembers = pgTable("workspace_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  role: varchar("role", { length: 40 }).notNull().default("member"), // owner|admin|member|agent
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("workspace_members_ws_user_idx").on(t.workspaceId, t.userId)]);

/**
 * Invite-by-link (adoption package #9): a workspace admin mints a
 * shareable link; anyone with the link who signs in can accept it and
 * join with the invite's role. Hygiene mirrors api_tokens: only the
 * SHA-256 of the raw token is stored (`token_hash`), the raw token is
 * returned ONCE at creation, and `prefix` is the non-secret display
 * fragment the admin list shows. `role` can never be "owner" (ownership
 * only moves via the transfer endpoint). Acceptance consumes a use with
 * a conditional UPDATE so the last use cannot be double-spent by two
 * concurrent accepts; `max_uses` NULL means unlimited.
 */
export const workspaceInvites = pgTable("workspace_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  prefix: varchar("prefix", { length: 20 }).notNull(),
  role: varchar("role", { length: 40 }).notNull().default("member"), // admin|member|agent (never owner)
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  maxUses: integer("max_uses"),
  usesCount: integer("uses_count").notNull().default(0),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("workspace_invites_hash_idx").on(t.tokenHash),
  index("workspace_invites_ws_idx").on(t.workspaceId),
]);

export const channelAccounts = pgTable("channel_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  channel: varchar("channel", { length: 40 }).notNull(), // whatsapp|instagram|messenger|threads|telegram|email|tiktok
  externalId: varchar("external_id", { length: 200 }).notNull(), // WABA/phone id, IG id, page id, threads user id, TikTok open_id...
  displayName: varchar("display_name", { length: 200 }),
  // Public profile-picture URL captured best-effort at connect time (Meta
  // channels). Telegram is NEVER stored here: its file URLs embed the bot
  // token - telegram avatars are served by an authenticated API proxy.
  avatarUrl: text("avatar_url"),
  authMode: varchar("auth_mode", { length: 60 }), // e.g. instagram: "instagram-login" | "facebook-login"
  apiVersion: varchar("api_version", { length: 20 }), // pinned provider API version, e.g. "v26.0"
  capabilities: jsonb("capabilities").notNull().default({}), // CapabilitySet snapshot at connect time
  isCoexistence: boolean("is_coexistence").notNull().default(false), // WhatsApp Business App + Cloud API same number
  // Token vault references only - raw access tokens live in the vault, never here.
  tokenVaultRef: varchar("token_vault_ref", { length: 200 }),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  status: varchar("status", { length: 40 }).notNull().default("connected"),
  // When the account was soft-disconnected (item G): the retention
  // sweeper permanently purges the account once this is older than
  // DISCONNECT_RETENTION_DAYS. NULL while connected.
  disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("channel_accounts_ws_idx").on(t.workspaceId)]);

export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  channel: varchar("channel", { length: 40 }).notNull(),
  externalId: varchar("external_id", { length: 200 }).notNull(),
  displayName: varchar("display_name", { length: 200 }),
  tags: jsonb("tags").notNull().default([]),
  customFields: jsonb("custom_fields").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("contacts_ws_channel_ext_idx").on(t.workspaceId, t.channel, t.externalId)]);

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  channelAccountId: uuid("channel_account_id").notNull().references(() => channelAccounts.id),
  contactId: uuid("contact_id").notNull().references(() => contacts.id),
  /**
   * The provider's own conversation id, when the channel addresses sends
   * by conversation rather than by contact (TikTok conversation_id).
   * Learned from inbound events and backfilled by the dispatcher; null
   * for contact-addressed channels and for conversations a comment opened
   * before the customer ever sent a DM.
   */
  externalId: varchar("external_id", { length: 200 }),
  status: varchar("status", { length: 40 }).notNull().default("open"), // open|pending|resolved
  assignedUserId: uuid("assigned_user_id").references(() => users.id),
  /** Drives messaging-window enforcement (Meta 24h window, human-agent 7d). */
  lastUserMessageAt: timestamp("last_user_message_at", { withTimezone: true }),
  /**
   * AI copilot analysis (package #7): written ONLY by POST
   * /conversations/:id/ai-analyze from a real model response - never
   * fabricated, never updated by heuristics. aiSummary is the model's
   * short thread summary; aiIntent one of the closed label set in
   * @botara/ai (inquiry|purchase_intent|support|complaint|spam|other);
   * aiIntentScore its 0-100 confidence. All four stay null until the
   * first successful analysis; aiSummaryAt stamps that write.
   */
  aiSummary: text("ai_summary"),
  aiSummaryAt: timestamp("ai_summary_at", { withTimezone: true }),
  aiIntent: varchar("ai_intent", { length: 40 }),
  aiIntentScore: integer("ai_intent_score"),
  /**
   * AI takeover (package #7): while set, AUTOMATIC AI sends on this
   * conversation (flow ai_reply nodes) are paused - the worker port
   * returns null before calling the model and the flow sends its
   * authored fallback. Agent-invoked AI tools (suggest/analyze) are NOT
   * blocked. Stamped by POST /ai-pause and automatically by any human
   * inbox reply (classic takeover); cleared by POST /ai-resume.
   */
  aiPausedAt: timestamp("ai_paused_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("conversations_ws_idx").on(t.workspaceId),
  /**
   * At most ONE non-resolved conversation per (channel account, contact):
   * concurrent inbound webhooks must never fragment one contact into
   * parallel open threads (the race this index backstops is handled in
   * createConversation, which falls back to the existing thread on a
   * unique violation). Resolved threads do not block a fresh thread, so
   * the index is partial on status <> 'resolved' (covers open + pending).
   */
  uniqueIndex("conversations_open_unique_idx")
    .on(t.channelAccountId, t.contactId)
    .where(sql`${t.status} <> 'resolved'`),
]);

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id),
  direction: varchar("direction", { length: 10 }).notNull(), // in|out
  /**
   * Timeline kind: "message" rows are customer-visible traffic (the only
   * kind any send path may ever deliver); "note" rows are INTERNAL team
   * notes (package #2) - they render in the inbox thread only, are never
   * enqueued or sent, never counted as outbound sends, and are filtered
   * out of every customer-facing listing (webchat widget, AI suggest).
   */
  kind: varchar("kind", { length: 20 }).notNull().default("message"), // message|note
  /**
   * The workspace user who authored this row, when a human wrote it
   * (internal notes today). Null for customer messages and automated
   * sends; the inbox resolves the display name from the member list.
   */
  authorUserId: uuid("author_user_id").references(() => users.id),
  /**
   * WHO produced this row (package #7): "human" for everything a person
   * or an authored automation (flows, sequences, broadcasts, templates)
   * wrote; "ai" ONLY for text a model generated (flow ai_reply nodes) -
   * the badge is stamped at the send seam by origin, never inferred from
   * content. The inbox renders an "AI" chip on ai rows. Default "human"
   * keeps every pre-#7 row honest: none of them were model-generated
   * through a badged path.
   */
  authorKind: varchar("author_kind", { length: 20 }).notNull().default("human"), // human|ai
  type: varchar("type", { length: 40 }).notNull().default("text"),
  body: text("body"),
  /**
   * Structured payload riding with the message (jsonb, nullable):
   * for outbound rich sends, the RichBlock exactly as authored (the
   * webchat widget renders buttons/lists from it; the inbox thread shows
   * read-only chips); for inbound webchat button clicks, { buttonPayload }
   * - the code the visitor's tap sent back. Null for plain messages.
   */
  payload: jsonb("payload"),
  /**
   * Stored media backing this message (inbound media pipeline): public
   * URLs the SPA renders, parallel to mediaKeys. Bytes are copied into
   * Botara's own storage at ingest because provider URLs/ids expire;
   * a message whose media could not be fetched keeps both arrays empty
   * (caption-only persistence - a media failure never loses the message).
   */
  mediaUrls: jsonb("media_urls").notNull().default([]),
  /** Storage object keys backing mediaUrls, kept for lifecycle management. */
  mediaKeys: jsonb("media_keys").notNull().default([]),
  externalId: varchar("external_id", { length: 200 }),
  /**
   * Quoted-reply reference: the provider id (e.g. wamid) of the message
   * THIS row quotes, captured from the inbound payload's context field
   * (WhatsApp). Null when the message quotes nothing. Resolution to the
   * quoted row happens at read time within the same conversation - the
   * original may predate Botara or have been sent outside it, in which
   * case the reference simply never resolves.
   */
  replyToExternalId: text("reply_to_external_id"),
  status: varchar("status", { length: 40 }).notNull().default("queued"), // queued|sent|delivered|read|failed
  /** Idempotency key used on the provider send call; safe retries depend on it. */
  idempotencyKey: varchar("idempotency_key", { length: 256 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("messages_conversation_idx").on(t.conversationId)]);

/**
 * Saved replies (package #2): the workspace's shared quick-reply library
 * for the inbox composer. Every member reads the same library; mutating
 * it is a mutator-role action (owner/admin/member). Bodies may contain
 * {{variables}} - they insert into the composer as drafts and render per
 * contact through the normal reply path, never at rest. `shortcut` (e.g.
 * "/halo") is an optional picker search handle, unique per workspace
 * when present (partial index - any number of rows may omit it).
 */
export const savedReplies = pgTable("saved_replies", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  title: varchar("title", { length: 200 }).notNull(),
  body: text("body").notNull(),
  shortcut: varchar("shortcut", { length: 60 }),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("saved_replies_ws_idx").on(t.workspaceId),
  uniqueIndex("saved_replies_ws_shortcut_idx")
    .on(t.workspaceId, t.shortcut)
    .where(sql`${t.shortcut} is not null`),
]);

/**
 * One entry of a WhatsApp template's component tree. Deliberately loose:
 * Meta adds component fields faster than this repo can type them, and the
 * value is stored/sent verbatim (the API validates the shape it accepts
 * before it ever reaches the column).
 */
export type TemplateComponentRow = Record<string, unknown>;

export const templates = pgTable("templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  channelAccountId: uuid("channel_account_id").notNull().references(() => channelAccounts.id),
  externalId: varchar("external_id", { length: 200 }),
  name: varchar("name", { length: 200 }).notNull(),
  language: varchar("language", { length: 20 }).notNull().default("en"),
  /** Original provider category at approval time. */
  category: varchar("category", { length: 40 }),
  /**
   * Latest category after provider reclassification webhooks.
   * WhatsApp routing MUST use this, never `category` (see ADR-008).
   */
  latestCategory: varchar("latest_category", { length: 40 }),
  /**
   * WhatsApp messaging account (WABA) id that owns this template, learned
   * from the template_category_update webhook (entry.id). Persisted
   * by the Fase 2 webhook wiring whenever Meta reports a category change.
   */
  messagingAccountId: varchar("messaging_account_id", { length: 200 }),
  status: varchar("status", { length: 40 }).notNull().default("draft"),
  /**
   * Provider component tree (HEADER / BODY / FOOTER / BUTTONS) exactly as
   * submitted to Meta. Null for hand-registered templates and for rows
   * mirrored before the composer existed. The Broadcast composer and the
   * pre-send parameter-count check both read it.
   */
  components: jsonb("components").$type<TemplateComponentRow[]>(),
  /** Meta's `rejected_reason`, surfaced next to the status in the panel. */
  rejectedReason: varchar("rejected_reason", { length: 200 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const broadcasts = pgTable("broadcasts", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  channelAccountId: uuid("channel_account_id").notNull().references(() => channelAccounts.id),
  templateId: uuid("template_id").references(() => templates.id),
  /**
   * Ordered body positional parameter templates (variables package #1).
   * Each entry is a literal/variable string interpolated PER RECIPIENT at
   * send time (e.g. "{{contact.name}}") and passed to the provider as
   * the template's body components. Null = no parameters.
   */
  templateParams: jsonb("template_params").$type<string[]>(),
  name: varchar("name", { length: 200 }),
  /** Targeting: contacts carrying this tag (null = caller-supplied recipientCount only). */
  tag: varchar("tag", { length: 120 }),
  /** Primary recipient country used for rating when no per-contact country is known. */
  country: varchar("country", { length: 8 }),
  recipientCount: integer("recipient_count").notNull().default(0),
  status: varchar("status", { length: 40 }).notNull().default("draft"), // draft|queued|sending|sent|partial|failed
  sentCount: integer("sent_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  estimatedCostUsd: numeric("estimated_cost_usd", { precision: 14, scale: 6 }),
  ratesVersion: varchar("rates_version", { length: 40 }), // rate card snapshot used for the estimate
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("broadcasts_ws_idx").on(t.workspaceId)]);

/**
 * Per-recipient delivery truth for one broadcast (package #4): the
 * broadcasts row keeps only aggregate counters, so the lifecycle of each
 * individual send lives here - pending at fan-out, sent/failed from the
 * send processor's outcome, delivered/read mirrored from provider status
 * webhooks (matched on provider_message_id inside the workspace), and
 * replied from the contact's next inbound message. Transitions never
 * move backwards; failed is terminal except via an explicit resend,
 * which resets the row to pending for a fresh attempt. Like every other
 * FK in this schema the references are NO ACTION - the purge paths
 * delete recipient rows before their broadcast/contact (see
 * purgeChannelAccount / purgeExternalUserData).
 */
export const broadcastRecipients = pgTable("broadcast_recipients", {
  id: uuid("id").primaryKey().defaultRandom(),
  broadcastId: uuid("broadcast_id").notNull().references(() => broadcasts.id),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  contactId: uuid("contact_id").notNull().references(() => contacts.id),
  status: varchar("status", { length: 40 }).notNull().default("pending"), // pending|sent|delivered|read|replied|failed
  /** Provider message id of the accepted send (WhatsApp wamid etc.). */
  providerMessageId: varchar("provider_message_id", { length: 200 }),
  /** Persisted inbox message row for this send, when the send path creates one. */
  messageId: uuid("message_id").references(() => messages.id),
  /** Last failure detail (send processor error or provider status error). */
  error: text("error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  readAt: timestamp("read_at", { withTimezone: true }),
  repliedAt: timestamp("replied_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("broadcast_recipients_broadcast_contact_idx").on(t.broadcastId, t.contactId),
  index("broadcast_recipients_ws_idx").on(t.workspaceId),
  index("broadcast_recipients_provider_idx").on(t.providerMessageId),
]);

/**
 * Webchat visitor sessions (Fase 2). A session binds a secret token (issued
 * by the public widget API, presented by the visitor's browser on every
 * poll/send) to a contact + conversation. The contact's externalId is
 * `webchat-session:{session row id}` - the token itself never appears in
 * conversation lists or URLs.
 */
export const webchatSessions = pgTable("webchat_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  /** Secret bearer token for the visitor's browser. Unique per session. */
  token: varchar("token", { length: 200 }).notNull(),
  contactId: uuid("contact_id").notNull().references(() => contacts.id),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id),
  visitorName: varchar("visitor_name", { length: 200 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("webchat_sessions_token_idx").on(t.token),
  index("webchat_sessions_ws_idx").on(t.workspaceId),
]);

/**
 * Scheduled / published social posts (Fase 2 publishing suite). One post,
 * many channel targets; `results` carries the per-target outcome keyed by
 * channelAccountId: { status: "sent"|"failed", externalPostId?, error? }.
 * Media is referenced by R2 keys + their public URLs (Meta fetches media
 * from public URLs - the URLs are what adapters consume).
 */
export const scheduledPosts = pgTable("scheduled_posts", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  text: text("text"),
  /** Public media URLs (R2 custom domain) in publish order. */
  mediaUrls: jsonb("media_urls").notNull().default([]),
  /** R2 object keys backing mediaUrls, kept for lifecycle management. */
  mediaKeys: jsonb("media_keys").notNull().default([]),
  /** Targets: [{ channelAccountId, channel }]. */
  targets: jsonb("targets").notNull().default([]),
  /** Null = publish as soon as a worker picks it up (publish-now / draft). */
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  status: varchar("status", { length: 40 }).notNull().default("scheduled"), // draft|scheduled|publishing|published|partial|failed|cancelled
  results: jsonb("results").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("scheduled_posts_ws_status_idx").on(t.workspaceId, t.status)]);

/**
 * Drip sequences (Fase 2). A sequence is an ordered list of steps stored as
 * jsonb: [{ delaySeconds, text?, template?: { name, language, latestCategory } }].
 * Step 0's delay counts from enrollment; each later step's delay counts from
 * the previous step's send.
 */
export const sequences = pgTable("sequences", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  channelAccountId: uuid("channel_account_id").notNull().references(() => channelAccounts.id),
  name: varchar("name", { length: 200 }).notNull(),
  steps: jsonb("steps").notNull().default([]),
  status: varchar("status", { length: 40 }).notNull().default("active"), // active|paused|archived
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("sequences_ws_idx").on(t.workspaceId)]);

export const sequenceEnrollments = pgTable("sequence_enrollments", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  sequenceId: uuid("sequence_id").notNull().references(() => sequences.id),
  contactId: uuid("contact_id").notNull().references(() => contacts.id),
  /** Index of the NEXT step to send. */
  currentStep: integer("current_step").notNull().default(0),
  status: varchar("status", { length: 40 }).notNull().default("active"), // active|completed|paused|failed
  nextStepAt: timestamp("next_step_at", { withTimezone: true }),
  lastStepAt: timestamp("last_step_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("sequence_enrollments_seq_contact_idx").on(t.sequenceId, t.contactId),
  index("sequence_enrollments_due_idx").on(t.status, t.nextStepAt),
]);

/**
 * Token vault (Fase 3). Raw channel secrets live ONLY here, AES-256-GCM
 * encrypted with TOKEN_VAULT_KEY (see packages/db/src/vault.ts). Channel
 * account rows carry nothing but the vault entry id as `token_vault_ref`
 * (`vault:db:{id}`). iv/auth_tag are base64; rotatedAt records the last
 * rotation (a rotate replaces ciphertext in place under the same ref).
 */
export const tokenVault = pgTable("token_vault", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  /** What the secret is for: a channel key ("whatsapp", "telegram", ...) or "generic". */
  kind: varchar("kind", { length: 60 }).notNull(),
  label: varchar("label", { length: 200 }),
  ciphertext: text("ciphertext").notNull(),
  iv: varchar("iv", { length: 64 }).notNull(),
  authTag: varchar("auth_tag", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
}, (t) => [index("token_vault_ws_idx").on(t.workspaceId)]);

/**
 * Workspace email domains (Fase 3). An inbound Resend webhook resolves the
 * owning workspace by the RECIPIENT domain through this table, then routes
 * the message to the workspace's email channel account (explicit link wins,
 * otherwise the workspace's email account is discovered).
 */
export const workspaceDomains = pgTable("workspace_domains", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  /** Lowercase ASCII domain, e.g. "mail.example.com". Unique platform-wide. */
  domain: varchar("domain", { length: 255 }).notNull(),
  channelAccountId: uuid("channel_account_id").references(() => channelAccounts.id),
  /** Resend-side domain id once the domain is registered with Resend. */
  resendDomainId: varchar("resend_domain_id", { length: 200 }),
  status: varchar("status", { length: 40 }).notNull().default("pending"), // pending|verified
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("workspace_domains_domain_idx").on(t.domain),
  index("workspace_domains_ws_idx").on(t.workspaceId),
]);

/**
 * Security audit trail (Fase 3): logins, registrations, vault writes and
 * rotations, member add/remove. `details` is jsonb and must NEVER contain
 * secret material - ids and emails only.
 */
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id"),
  userId: uuid("user_id"),
  action: varchar("action", { length: 80 }).notNull(), // auth.register|auth.login|vault.put|vault.rotate|workspace.member.add|workspace.member.remove
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("audit_log_ws_created_idx").on(t.workspaceId, t.createdAt)]);

/**
 * Knowledge base (Fase 3). Documents are chunked + embedded by the worker's
 * kb-ingest job. Chunk embeddings are stored as jsonb number arrays for
 * portability (any Postgres, no extension required) and retrieval ranks by
 * cosine similarity in application code.
 *
 * OPTIONAL pgvector path: on instances where the `vector` extension is
 * available, an operator MAY add a `embedding_vec vector(1536)` column +
 * ivfflat index via a manual migration and backfill from the jsonb arrays;
 * the runtime deliberately does NOT depend on the extension (see the
 * retrieval helper in packages/ai and docs/runbook.md).
 */
export const kbDocuments = pgTable("kb_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  title: varchar("title", { length: 300 }).notNull(),
  sourceText: text("source_text").notNull(),
  /** Original filename when the document came from a file upload (provenance only; the file itself is never stored). Null for typed documents. */
  sourceFilename: text("source_filename"),
  status: varchar("status", { length: 40 }).notNull().default("pending"), // pending|processing|ready|failed
  chunkCount: integer("chunk_count").notNull().default(0),
  /** Last ingestion failure reason (status = failed), for the admin UI. */
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("kb_documents_ws_idx").on(t.workspaceId)]);

export const kbChunks = pgTable("kb_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  documentId: uuid("document_id").notNull().references(() => kbDocuments.id),
  chunkIndex: integer("chunk_index").notNull().default(0),
  text: text("text").notNull(),
  /** Embedding vector as a jsonb number array (portable; see table note). */
  embedding: jsonb("embedding").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("kb_chunks_ws_idx").on(t.workspaceId),
  index("kb_chunks_document_idx").on(t.documentId),
]);

/**
 * Meta data-deletion requests (Fase 3). Meta's deletion callback posts a
 * signed_request; we record one row per request, answer with a public
 * status URL keyed by confirmation_code, and purge the provider user's
 * contact data best-effort (see repositories.purgeExternalUserData).
 */
export const dataDeletionRequests = pgTable("data_deletion_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  confirmationCode: varchar("confirmation_code", { length: 64 }).notNull(),
  providerUserId: varchar("provider_user_id", { length: 200 }).notNull(),
  status: varchar("status", { length: 40 }).notNull().default("received"), // received|completed
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [uniqueIndex("data_deletion_requests_code_idx").on(t.confirmationCode)]);

/**
 * Automation flows (Fase 4 - the visual builder's persistence). One row per
 * flow: the flow-level `trigger` ({ type: "keyword"|"postback"|"manual",
 * config }) is what the inbound dispatcher matches on, and `graph` is the
 * builder document { startNodeId, nodes, edges } where nodes conform to
 * the packages/flow-engine node schemas (each node may additionally carry
 * a builder `position`). The runnable Flow is derived from the graph by
 * flow-engine's toRunnableFlow - the graph is the single source of truth.
 */
export const flows = pgTable("flows", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: varchar("name", { length: 200 }).notNull(),
  trigger: jsonb("trigger").notNull().default({ type: "manual", config: {} }),
  graph: jsonb("graph").notNull().default({ startNodeId: "", nodes: [], edges: [] }),
  status: varchar("status", { length: 40 }).notNull().default("draft"), // draft|active
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("flows_ws_status_idx").on(t.workspaceId, t.status)]);

/**
 * Collect-input waits (adoption package #3). One row per flow run
 * paused at a `collect_input` node: everything needed to resume the
 * run - the executor's resume state snapshot plus the capture spec
 * (which variable, which contact field). A wait is CLAIMED by deleting
 * its row (single-statement delete ... returning): the inbound reply
 * path (API dispatcher) and the timeout job (worker) race on the
 * claim, exactly one wins, the loser no-ops. Resolving the
 * conversation deletes its waits - a run waiting on a closed thread
 * ends quietly instead of resuming into it.
 */
export const flowWaits = pgTable("flow_waits", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id),
  contactId: uuid("contact_id").notNull().references(() => contacts.id),
  channelAccountId: uuid("channel_account_id").notNull().references(() => channelAccounts.id),
  flowId: uuid("flow_id").notNull().references(() => flows.id),
  /** The collect_input node the run paused at (observability). */
  nodeId: varchar("node_id", { length: 200 }).notNull(),
  /** Run variable the answer lands in ({{vars.<variable>}}). */
  variable: varchar("variable", { length: 120 }).notNull(),
  /** Optional contact custom field that also persists the answer. */
  saveToContactField: varchar("save_to_contact_field", { length: 200 }),
  /** FlowState snapshot: status "waiting", currentNodeId past the collect node. */
  resumeState: jsonb("resume_state").notNull(),
  /** When the timeout resume fires; null = wait for a reply forever. */
  deadlineAt: timestamp("deadline_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("flow_waits_conversation_idx").on(t.conversationId),
  index("flow_waits_deadline_idx").on(t.deadlineAt),
]);

/**
 * Personal API tokens (adopted-features package). A token is shown ONCE at
 * creation; only its SHA-256 hash is stored. `prefix` is the non-secret
 * display fragment (e.g. "bta_AbCd1234") shown in Settings so users can
 * tell tokens apart. Tokens authenticate as their user (Bearer bta_...)
 * and power the MCP server + third-party API access.
 *
 * Adoption #5 adds the scoped-token columns, all NULLABLE: a row with
 * workspace_id/scopes/expires_at all NULL is a LEGACY token and keeps
 * the original all-or-nothing behavior bit-for-bit. A non-NULL
 * workspace_id binds the token to that workspace; a non-NULL scopes
 * (jsonb string array, taxonomy in @botara/shared api-tokens) restricts
 * which workspace resource routes it may call; expires_at is enforced
 * at resolution time (401 TOKEN_EXPIRED).
 */
export const apiTokens = pgTable("api_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  name: varchar("name", { length: 120 }).notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  prefix: varchar("prefix", { length: 20 }).notNull(),
  /** Scoped tokens (#5): bound workspace; NULL = any workspace of the user. */
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  /** Scoped tokens (#5): granted scopes; NULL = unrestricted (legacy). */
  scopes: jsonb("scopes").$type<string[]>(),
  /** Scoped tokens (#5): hard expiry; NULL = never expires. */
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("api_tokens_hash_idx").on(t.tokenHash),
  index("api_tokens_user_idx").on(t.userId),
]);

/**
 * Comment-automation idempotency (adopted-features package). One row per
 * (channel account, comment, flow) that a comment-action job has claimed -
 * webhook redeliveries and queue retries can never double-reply, double-
 * hide, or burn the one private reply a comment is allowed.
 */
export const processedComments = pgTable("processed_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  channelAccountId: uuid("channel_account_id").notNull().references(() => channelAccounts.id),
  commentExternalId: varchar("comment_external_id", { length: 200 }).notNull(),
  flowId: uuid("flow_id").notNull().references(() => flows.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("processed_comments_account_comment_flow_idx").on(t.channelAccountId, t.commentExternalId, t.flowId),
]);

/**
 * Growth links (adopted-features package). A short tracked link per
 * channel account: /r/:slug counts the click, then 302s to the channel
 * target (wa.me / m.me / t.me / ig.me / webchat page). Referral capture on
 * inbound events increments conversions once per contact and can run a
 * bound flow instead of keyword matching. `kind` mirrors the account's
 * channel at creation time. targetRef carries the channel-specific target
 * the account row cannot supply (WhatsApp phone number, Telegram/IG
 * username override); targetUrl is the full destination for webchat.
 */
export const growthLinks = pgTable("growth_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  channelAccountId: uuid("channel_account_id").notNull().references(() => channelAccounts.id),
  kind: varchar("kind", { length: 40 }).notNull(), // whatsapp|instagram|messenger|telegram|webchat|...
  slug: varchar("slug", { length: 32 }).notNull(),
  label: varchar("label", { length: 200 }).notNull(),
  prefilledText: text("prefilled_text"),
  boundFlowId: uuid("bound_flow_id").references(() => flows.id),
  targetRef: varchar("target_ref", { length: 200 }),
  targetUrl: text("target_url"),
  clicks: integer("clicks").notNull().default(0),
  conversions: integer("conversions").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("growth_links_slug_idx").on(t.slug),
  index("growth_links_ws_idx").on(t.workspaceId),
]);

/**
 * Synced Meta (WhatsApp) catalog products. The catalog sync pulls a
 * WhatsApp account's product catalogs from the Graph API and mirrors the
 * products here so the FlowBuilder / Inbox pickers can offer real
 * (catalog_id, retailer_id) pairs instead of hand-typed ids - the rich
 * product/catalog sends consume exactly those two ids. `raw` keeps the
 * full Graph product object for fields the mirror does not model.
 * Uniqueness is per (channel account, catalog, retailer id): retailer_id
 * is only unique inside one catalog.
 */
export const catalogProducts = pgTable("catalog_products", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  channelAccountId: uuid("channel_account_id").notNull().references(() => channelAccounts.id),
  catalogId: varchar("catalog_id", { length: 200 }).notNull(),
  /** The product's retailer id - the id WhatsApp sends reference. */
  retailerId: varchar("retailer_id", { length: 200 }).notNull(),
  name: varchar("name", { length: 500 }).notNull(),
  description: text("description"),
  priceAmount: numeric("price_amount", { precision: 14, scale: 2 }),
  currency: varchar("currency", { length: 8 }),
  imageUrl: text("image_url"),
  availability: varchar("availability", { length: 60 }),
  link: text("link"),
  raw: jsonb("raw"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("catalog_products_account_catalog_retailer_idx").on(t.channelAccountId, t.catalogId, t.retailerId),
  index("catalog_products_ws_idx").on(t.workspaceId),
]);

/**
 * Platform settings (admin panel): operator-managed deployment settings
 * (app credentials, verify tokens, R2, Resend, AI) stored in the DB so
 * they can be changed from the admin panel instead of editing .env.
 * Resolution order is DB -> env -> unset (see
 * packages/db/src/platform-settings.ts for the managed-key registry).
 * Non-secret values live in `value`; secrets live ONLY in
 * `secretCiphertext` (AES-256-GCM sealed with TOKEN_VAULT_KEY, the same
 * scheme as the token vault in vault.ts) - a row carries exactly one of
 * the two. `value` and `secretCiphertext` must NEVER both be set.
 */
export const platformSettings = pgTable("platform_settings", {
  /** The env var name this setting overrides (e.g. "META_APP_ID"). PK. */
  key: varchar("key", { length: 120 }).primaryKey(),
  /** Plaintext value - non-secret settings only. */
  value: text("value"),
  /** Base64 AES-256-GCM ciphertext - secret settings only (iv/tag embedded, see platform-settings.ts). */
  secretCiphertext: text("secret_ciphertext"),
  /** The platform admin who last wrote the row (users.id; no FK - settings outlive accounts). */
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const costLedger = pgTable("cost_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  channelAccountId: uuid("channel_account_id").references(() => channelAccounts.id),
  channel: varchar("channel", { length: 40 }).notNull(),
  category: varchar("category", { length: 40 }).notNull(), // marketing|utility|authentication|service|ai|...
  country: varchar("country", { length: 8 }), // recipient country (dial code / ISO) used for rating
  /**
   * Billable units: delivered messages for sends; TOTAL TOKENS for AI
   * rows (package #7) when the provider returned usage. NULL means "the
   * provider reported no usage" - an honest unknown, never a fabricated
   * 0/1. (Was NOT NULL DEFAULT 1 until #7; send writers still always
   * pass an explicit count.)
   */
  units: integer("units"),
  amount: numeric("amount", { precision: 14, scale: 6 }).notNull().default("0"),
  currency: varchar("currency", { length: 8 }).notNull().default("USD"),
  /** Model that produced an AI row's usage (package #7); null for send rows. */
  model: varchar("model", { length: 120 }),
  referenceId: varchar("reference_id", { length: 200 }), // message id / job id
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("cost_ledger_ws_created_idx").on(t.workspaceId, t.createdAt)]);

/**
 * Sales pipelines + deals (adoption package #6, wacrm gap §5).
 *
 * A workspace runs MULTIPLE pipelines (e.g. "Retail" and "Wholesale");
 * each pipeline is an ordered list of stages rendered as Kanban columns.
 * A deal sits in exactly one stage of one pipeline, REQUIRES a contact,
 * and OPTIONALLY links the conversation it grew out of.
 *
 * Won/lost is deliberately a deal STATUS (open|won|lost), NOT a pair of
 * special stages: a deal is won or lost FROM whatever stage it reached,
 * and the stage it closed in stays meaningful for reporting (package
 * #8 analytics reads the summary aggregates built on this split).
 */
export const pipelines = pgTable("pipelines", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: varchar("name", { length: 200 }).notNull(),
  /** The workspace's default pipeline (flow create_deal lands here). At most one per workspace - enforced by the API, not the schema. */
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("pipelines_ws_idx").on(t.workspaceId)]);

export const pipelineStages = pgTable("pipeline_stages", {
  id: uuid("id").primaryKey().defaultRandom(),
  pipelineId: uuid("pipeline_id").notNull().references(() => pipelines.id),
  name: varchar("name", { length: 200 }).notNull(),
  /** Column order within the pipeline (0-based, dense). */
  position: integer("position").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("pipeline_stages_pipeline_position_idx").on(t.pipelineId, t.position),
  index("pipeline_stages_pipeline_idx").on(t.pipelineId),
]);

export const deals = pgTable("deals", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  pipelineId: uuid("pipeline_id").notNull().references(() => pipelines.id),
  stageId: uuid("stage_id").notNull().references(() => pipelineStages.id),
  /** A deal is always ABOUT a contact - the one hard link in the model. */
  contactId: uuid("contact_id").notNull().references(() => contacts.id),
  /** The conversation the deal grew out of, when it came from the inbox. */
  conversationId: uuid("conversation_id").references(() => conversations.id),
  title: varchar("title", { length: 300 }).notNull(),
  /** Deal size in `currency`; null = not yet sized. numeric(14,2) like catalog prices. */
  value: numeric("value", { precision: 14, scale: 2 }),
  currency: varchar("currency", { length: 3 }).notNull(),
  /** open|won|lost - separate from the stage (see the package note above). */
  status: varchar("status", { length: 20 }).notNull().default("open"),
  expectedCloseDate: date("expected_close_date"),
  notes: text("notes"),
  /** Who created the deal; null when a flow's create_deal step made it. */
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  /** Last time the deal changed stage (board dwell-time reporting). */
  stageChangedAt: timestamp("stage_changed_at", { withTimezone: true }).notNull().defaultNow(),
  /** Stamped when status becomes won/lost; cleared on reopen. */
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("deals_ws_idx").on(t.workspaceId),
  index("deals_pipeline_stage_idx").on(t.pipelineId, t.stageId),
  index("deals_contact_idx").on(t.contactId),
]);

/**
 * Outbound event webhooks (adoption package #10): a workspace endpoint
 * subscribes to a closed set of lifecycle events (message.received,
 * message.status, conversation.created) and Botara POSTs signed
 * envelopes to it from the worker's outbound-webhooks queue.
 *
 * Secret hygiene mirrors platform_settings: the signing secret is
 * generated server-side (32 random bytes), stored ONLY as an
 * AES-256-GCM sealed blob (`secret_sealed` - the vault's SealedSecret
 * JSON, same scheme as platform settings), and the raw value is shown
 * exactly once, at creation and at rotation.
 *
 * Auto-disable: every terminally failed delivery increments
 * `consecutive_failures`; at the threshold the delivery pipeline itself
 * flips `enabled` off and stamps `disabled_at` + `disabled_by_system`,
 * with an audit_log row. A successful delivery resets the counter, and
 * a human re-enabling the endpoint resets it too.
 */
export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: varchar("name", { length: 200 }).notNull(),
  url: text("url").notNull(),
  /** AES-256-GCM sealed signing secret (SealedSecret JSON) - never the raw secret. */
  secretSealed: text("secret_sealed").notNull(),
  /** Subscribed event names (closed set, validated on write). */
  events: jsonb("events").notNull().default([]),
  enabled: boolean("enabled").notNull().default(true),
  /** Consecutive terminally-failed deliveries; reset by any success or a manual re-enable. */
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  /** When the endpoint was auto-disabled by the delivery pipeline (null = never). */
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  /** True when the disable was the pipeline's auto-disable, false/null when a human toggled it off. */
  disabledBySystem: boolean("disabled_by_system"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("webhook_endpoints_ws_idx").on(t.workspaceId)]);

/**
 * One delivery attempt series for one (endpoint, event): the exact
 * envelope POSTed is stored in `payload` (so retries resend identical
 * bytes and the deliveries view can show precisely what was sent).
 * `attempts` counts tries actually made; `status` leaves `pending` only
 * at a terminal outcome (delivered on a 2xx, failed after the last
 * attempt or a non-retryable refusal).
 */
export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  endpointId: uuid("endpoint_id").notNull().references(() => webhookEndpoints.id),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  /** OutboundWebhookEvent name, or "webhook.test" for the settings ping. */
  event: varchar("event", { length: 60 }).notNull(),
  payload: jsonb("payload").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"), // pending|delivered|failed
  responseStatus: integer("response_status"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
}, (t) => [
  index("webhook_deliveries_endpoint_created_idx").on(t.endpointId, t.createdAt),
  index("webhook_deliveries_ws_idx").on(t.workspaceId),
]);

/**
 * Inbound webhook receipts (Admin → Webhook log): one row per provider
 * webhook POST the API handled, across every channel, so the platform
 * operator can answer "did Meta's webhook actually reach us, and what
 * did we do with it?" without shell access to the API logs.
 *
 * Written BEST-EFFORT by the webhook routes after handling completes -
 * a failed insert never changes the provider-facing response. The
 * payload summary is the raw request BODY (JSON) truncated to 4 KB; it
 * is stored only for signature-VERIFIED requests: a forged or unsigned
 * body is never persisted (its `payload_summary` stays null and the
 * `error` column says why). Headers, signatures and tokens are never
 * stored. Retention is short (see WEBHOOK_RECEIPT_RETENTION_DAYS in
 * @botara/shared): the worker's daily sweeper deletes older rows.
 *
 * workspace_id / channel_account_id are resolved from the first parsed
 * event's account external id when possible; both stay null for
 * unverifiable or unresolvable receipts rather than guessing.
 */
export const webhookReceipts = pgTable("webhook_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Provider channel key: whatsapp|messenger|instagram|threads|telegram|tiktok|... */
  channel: varchar("channel", { length: 40 }).notNull(),
  /** First parsed event type (message.received, message.echo, ...); null when nothing parsed. */
  eventType: varchar("event_type", { length: 80 }),
  /** processed (dispatch ran) | ignored (verified, nothing actionable) | error (rejected/failed). */
  outcome: varchar("outcome", { length: 20 }).notNull(),
  /** The HTTP status the API answered the provider with. */
  httpStatus: integer("http_status").notNull(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  channelAccountId: uuid("channel_account_id").references(() => channelAccounts.id),
  /** Raw body JSON truncated to 4000 chars; null for unverified requests. */
  payloadSummary: text("payload_summary"),
  /** Short failure note when outcome = "error". */
  error: text("error"),
}, (t) => [
  index("webhook_receipts_created_idx").on(t.createdAt),
  index("webhook_receipts_channel_created_idx").on(t.channel, t.createdAt),
  index("webhook_receipts_outcome_created_idx").on(t.outcome, t.createdAt),
]);
