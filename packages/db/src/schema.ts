import { sql } from "drizzle-orm";
import {
  pgTable, uuid, varchar, text, timestamp, boolean, jsonb, integer, numeric, uniqueIndex, index,
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
   * from the message_template_category_update webhook (entry.id). Persisted
   * by the Fase 2 webhook wiring whenever Meta reports a category change.
   */
  messagingAccountId: varchar("messaging_account_id", { length: 200 }),
  status: varchar("status", { length: 40 }).notNull().default("draft"),
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
 * Personal API tokens (adopted-features package). A token is shown ONCE at
 * creation; only its SHA-256 hash is stored. `prefix` is the non-secret
 * display fragment (e.g. "bta_AbCd1234") shown in Settings so users can
 * tell tokens apart. Tokens authenticate as their user (Bearer bta_...)
 * and power the MCP server + third-party API access.
 */
export const apiTokens = pgTable("api_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  name: varchar("name", { length: 120 }).notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  prefix: varchar("prefix", { length: 20 }).notNull(),
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
  category: varchar("category", { length: 40 }).notNull(), // marketing|utility|authentication|service|...
  country: varchar("country", { length: 8 }), // recipient country (dial code / ISO) used for rating
  units: integer("units").notNull().default(1), // messages, tokens, etc.
  amount: numeric("amount", { precision: 14, scale: 6 }).notNull().default("0"),
  currency: varchar("currency", { length: 8 }).notNull().default("USD"),
  referenceId: varchar("reference_id", { length: 200 }), // message id / job id
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("cost_ledger_ws_created_idx").on(t.workspaceId, t.createdAt)]);
