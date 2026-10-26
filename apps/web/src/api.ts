/**
 * Botara web API client (Fase 3: real auth).
 * Base URL from VITE_API_URL (default: same-origin "/api" — the reverse
 * proxy in front of every deployment, trial nginx and production Caddy
 * alike, routes /api/* to the API process; an absolute localhost default
 * here made the deployed SPA call the VISITOR's own machine and report
 * "Cannot reach the API" while the API was perfectly healthy). For the
 * vite dev server, set VITE_API_URL=http://localhost:3000 (the dev API).
 * The session JWT from
 * /auth/login|register is kept in localStorage and sent as a Bearer token;
 * the selected workspace id rides along as X-Workspace-Id, which the API
 * now treats purely as a workspace SELECTOR - membership and role are
 * verified server-side from the token. (The API also sets an httpOnly
 * session cookie; the Bearer token is what this SPA uses.)
 */

export const BASE_URL: string = import.meta.env.VITE_API_URL ?? "/api";

const WORKSPACE_KEY = "botara.workspaceId";
const TOKEN_KEY = "botara.token";

/** UI language for client-side error strings (set by the i18n provider). */
let apiLanguage: "en" | "id" = "en";
export function setApiLanguage(lang: "en" | "id"): void {
  apiLanguage = lang;
}
const API_STRINGS = {
  en: {
    unreachable: "Cannot reach the API. Make sure the API server is running.",
    requestFailed: "Request failed (HTTP {status}).",
  },
  id: {
    unreachable: "API tidak dapat dihubungi. Pastikan server API berjalan.",
    requestFailed: "Request gagal (HTTP {status}).",
  },
} as const;

export function getWorkspaceId(): string {
  return localStorage.getItem(WORKSPACE_KEY) ?? "";
}

export function setWorkspaceId(id: string): void {
  localStorage.setItem(WORKSPACE_KEY, id);
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** App-level hook: fired when the API answers 401 (session expired). */
let unauthorizedHandler: (() => void) | null = null;
export function onUnauthorized(handler: () => void): void {
  unauthorizedHandler = handler;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const workspaceId = getWorkspaceId();
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        // FormData bodies (file uploads) must NOT get a manual
        // content-type: the browser sets multipart/form-data with the
        // boundary itself.
        ...(init.body instanceof FormData ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError("NETWORK", 0, API_STRINGS[apiLanguage].unreachable);
  }
  const body = (await res.json().catch(() => null)) as
    | (T & { error?: { code: string; message: string } })
    | null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) {
      // Session expired or revoked: drop the token and let the app shell
      // route back to the login page.
      clearSession();
      unauthorizedHandler?.();
    }
    throw new ApiError(
      body?.error?.code ?? "INTERNAL",
      res.status,
      body?.error?.message ?? API_STRINGS[apiLanguage].requestFailed.replace("{status}", String(res.status)),
    );
  }
  return body as T;
}

/** Like request(), but for non-JSON payloads (CSV/JSON export text, QR SVG). */
async function requestText(path: string): Promise<string> {
  const workspaceId = getWorkspaceId();
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
      },
    });
  } catch {
    throw new ApiError("NETWORK", 0, API_STRINGS[apiLanguage].unreachable);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
    throw new ApiError(
      body?.error?.code ?? "INTERNAL",
      res.status,
      body?.error?.message ?? API_STRINGS[apiLanguage].requestFailed.replace("{status}", String(res.status)),
    );
  }
  return res.text();
}

/** Save text as a downloaded file (exports, QR SVGs). */
export function downloadTextFile(filename: string, text: string, mime = "text/plain"): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  /** Platform operator flag (admin panel) - NOT a workspace role. */
  isPlatformAdmin: boolean;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
  /** Workspace default currency (ISO 4217) for new deals - package #6. */
  defaultCurrency: string;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
  /** The workspace the session starts in; null when the user has none. */
  workspace: { id: string; name: string; slug: string } | null;
}

/** Raw POST /auth/login payload: plural `workspaces`, unlike register's
 *  singular `workspace` - the two shapes MUST stay distinct here (typing
 *  login as AuthResponse hid that difference and broke SPA sign-in). */
interface LoginResponse {
  token: string;
  user: AuthUser;
  workspaces: { id: string; name: string; slug: string; role: string }[];
}

export interface KbDocument {
  id: string;
  title: string;
  status: string;
  chunkCount: number;
  error?: string;
  /** Original filename for uploaded documents (provenance; the file itself is never stored). */
  sourceFilename?: string;
  createdAt: string;
}

/** POST /kb/documents/upload result: the document + extraction metadata. */
export interface KbUploadResult {
  document: KbDocument;
  extraction: { format: string; chars: number; truncated: boolean; sourceFilename: string };
}

export interface ConversationAssignee {
  userId: string;
  name: string | null;
  email: string | null;
}

export interface Conversation {
  id: string;
  channel: string;
  channelAccountId: string;
  status: string;
  /** The contact behind this conversation (contact editing, F1). */
  contactId: string;
  contactExternalId: string;
  contactDisplayName: string | null;
  /** The contact's tags, shown as chips in the inbox header (B4). */
  contactTags: string[];
  lastUserMessageAt: string | null;
  windowOpen: boolean;
  assignedUserId: string | null;
  assignee: ConversationAssignee | null;
  createdAt: string;
}

/** One synced Meta catalog product (picker + summary reads). */
export interface CatalogProduct {
  id: string;
  workspaceId: string;
  channelAccountId: string;
  catalogId: string;
  retailerId: string;
  name: string;
  description: string | null;
  priceAmount: string | null;
  currency: string | null;
  imageUrl: string | null;
  availability: string | null;
  link: string | null;
  syncedAt: string;
}

export interface CatalogSyncResult {
  catalogs: number;
  products: number;
  syncedAt: string;
}

export interface CatalogSummary {
  accountId: string;
  productCount: number;
  catalogs: string[];
  lastSyncedAt: string | null;
}

export interface Message {
  id: string;
  direction: "in" | "out";
  /**
   * Timeline kind (package #2): "message" is customer traffic; "note" is
   * an internal team note - rendered as an internal card, never sent.
   * Absent on rows written before the kind column existed (= message).
   */
  kind?: "message" | "note";
  /** Authoring member for human-written rows (notes); null otherwise. */
  authorUserId?: string | null;
  author?: { userId: string; name: string | null; email: string | null } | null;
  type: string;
  body: string | null;
  /**
   * Structured payload: the RichBlock for outbound rich sends (the
   * inbox thread renders read-only chips from it), or { buttonPayload }
   * for an inbound webchat button click. Null for plain messages.
   */
  payload?: RichBlock | { buttonPayload: string } | null;
  /**
   * Stored media backing this message (inbound media pipeline): public
   * URLs to render, parallel to mediaKeys (storage object keys - the
   * filename shown on file chips comes from the key's last segment).
   * Empty when the message has no media or its media could not be
   * fetched at ingest (caption-only persistence).
   */
  mediaUrls?: string[];
  mediaKeys?: string[];
  status: string;
  createdAt: string;
}

/** A saved reply from the workspace's shared quick-reply library (package #2). */
export interface SavedReply {
  id: string;
  title: string;
  body: string;
  /** Canonical "/"-prefixed picker handle; null when unset. */
  shortcut: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Contact {
  id: string;
  channel: string;
  externalId: string;
  displayName: string | null;
  tags: string[];
  customFields: Record<string, unknown>;
  createdAt: string;
}

export interface Template {
  id: string;
  channelAccountId: string;
  name: string;
  language: string;
  category: string | null;
  latestCategory: string | null;
  status: string;
}

export interface BroadcastEstimateLine {
  country: string;
  category: string;
  recipients: number;
  billable: number;
  freeServiceApplied: number;
  rateUsd: number;
  subtotalUsd: number;
}

export interface BroadcastEstimate {
  lines: BroadcastEstimateLine[];
  totalRecipients: number;
  totalUsd: number;
  ratesVersion: string;
  ratesEffectiveDate: string;
}

/** One row of GET /broadcasts (history list, F5). */
export interface BroadcastSummary {
  id: string;
  channelAccountId: string;
  templateId: string | null;
  /** Per-recipient body parameter templates (variables package #1). */
  templateParams: string[] | null;
  name: string | null;
  tag: string | null;
  country: string | null;
  recipientCount: number;
  status: string;
  sentCount: number;
  failedCount: number;
  /**
   * Create-time estimate from a NULLABLE numeric column; the API
   * normalizes it to a JSON number, or null when the row carries no
   * estimate. Render only via formatUsd/broadcastCostUsd - never call
   * .toFixed on it directly (formatUsd still tolerates a numeric
   * string defensively, for older servers that pass the raw
   * postgres-js string through).
   */
  estimatedCostUsd: number | null;
  /** Realized cost from the ledger (0 until sends are recorded). */
  totalCostUsd: number;
  ratesVersion: string;
  createdAt: string;
}

/** GET /broadcasts/{id}: the broadcast plus its realized cost detail. */
export interface BroadcastDetail extends BroadcastSummary {
  costEntries: number;
  costUnits: number;
}

/** Per-recipient broadcast delivery record (package #4). */
export interface BroadcastRecipient {
  id: string;
  broadcastId: string;
  workspaceId: string;
  contactId: string;
  status: string;
  providerMessageId: string | null;
  messageId: string | null;
  error: string | null;
  contactDisplayName: string;
  contactExternalId: string;
  contactChannel: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  repliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BroadcastRecipientCounts {
  pending: number; sent: number; delivered: number; read: number;
  replied: number; failed: number; total: number;
}

export interface BroadcastRecipientsPage {
  recipients: BroadcastRecipient[];
  counts: BroadcastRecipientCounts;
  total: number;
  limit: number;
  offset: number;
}

// ------------------------------------------------------------ deals (#6)

/** One sales pipeline stage; position is dense and 0-based per pipeline. */
export interface PipelineStage {
  id: string;
  pipelineId: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface Pipeline {
  id: string;
  workspaceId: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  stages: PipelineStage[];
}

export type DealStatus = "open" | "won" | "lost";

/**
 * One deal. `value` arrives as a JSON number or null (the API normalizes
 * the drizzle numeric string) - never render it raw without a formatter.
 */
export interface Deal {
  id: string;
  workspaceId: string;
  pipelineId: string;
  stageId: string;
  contactId: string;
  conversationId: string | null;
  title: string;
  value: number | null;
  currency: string;
  status: DealStatus;
  expectedCloseDate: string | null;
  notes: string | null;
  createdByUserId: string | null;
  stageChangedAt: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  contactDisplayName: string;
  contactExternalId: string;
  contactChannel: string;
}

export interface PipelineStageSummary { stageId: string; openCount: number; openValue: number }
export interface PipelineTotals { count: number; value: number }
export interface PipelineSummary {
  pipelineId: string;
  stages: PipelineStageSummary[];
  open: PipelineTotals;
  won: PipelineTotals;
  lost: PipelineTotals;
}

/** One registered sending domain (Channels → Email, F2). */
export interface WorkspaceDomain {
  id: string;
  domain: string;
  channelAccountId: string | null;
  resendDomainId: string | null;
  status: string;
  createdAt: string;
}

/** GET /segments row: a tag with its contact count (F8). */
export interface SegmentInfo {
  tag: string;
  contactCount: number;
}

/** GET /admin/connection-info (F11): callback URLs + token KEY NAMES. */
export interface ConnectionWebhook {
  id: string;
  url: string;
  verifyTokenKey: string | null;
  autoConfigured: boolean;
}

export interface ConnectionInfo {
  base: string;
  webhooks: ConnectionWebhook[];
  oauthRedirects: Array<{ id: string; url: string }>;
}

export interface ChannelAccount {
  id: string;
  channel: string;
  externalId: string;
  displayName: string | null;
  /** Public profile-picture URL captured at connect time; null when none (telegram is proxied instead). */
  avatarUrl: string | null;
  authMode: string | null;
  status: string;
  hasCredential: boolean;
  /** WhatsApp coexistence (Business App + Cloud API on the same number). */
  isCoexistence?: boolean;
  tokenExpiresAt: string | null;
  /** Item G: soft-disconnect stamp + the retention purge instant (null while connected). */
  disconnectedAt: string | null;
  purgeAt: string | null;
  createdAt: string;
}

export interface PostTargetResult {
  status: "sent" | "failed";
  externalPostId?: string;
  error?: string;
}

export interface ScheduledPost {
  id: string;
  text: string | null;
  mediaUrls: string[];
  targets: Array<{ channelAccountId: string; channel: string; targetExternalId?: string }>;
  scheduledAt: string | null;
  status: string;
  results: Record<string, PostTargetResult>;
  createdAt: string;
}

export interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: string;
}

export interface PublicConfig {
  metaAppId: string | null;
  whatsappEmbeddedConfigId: string | null;
  instagramAppId: string | null;
  threadsAppId: string | null;
  tiktokAppId: string | null;
  publicWebhookBaseUrl: string | null;
}

export interface FlowTrigger {
  type: "keyword" | "postback" | "manual" | "comment_keyword";
  config: Record<string, unknown>;
}

/** Rich message blocks (adopted features) - mirrors @botara/channels. */
export interface RichButton {
  type: "reply" | "url" | "postback";
  title: string;
  payload?: string;
  url?: string;
}
export type RichBlock =
  | { kind: "buttons"; text: string; buttons: RichButton[] }
  | {
      kind: "list";
      text: string;
      buttonText: string;
      sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>;
    }
  | {
      kind: "carousel";
      cards: Array<{ title: string; subtitle?: string; imageUrl?: string; buttons?: RichButton[] }>;
    }
  | { kind: "product"; catalogId: string; productId: string; text?: string }
  | {
      kind: "catalog";
      catalogId: string;
      text?: string;
      sections?: Array<{ title: string; productIds: string[] }>;
    };

export interface ApiTokenInfo {
  id: string;
  name: string;
  prefix: string;
  /** Scoped tokens (#5): bound workspace id; null = any of the user's workspaces. */
  workspaceId: string | null;
  /** Scoped tokens (#5): granted scopes; null = unrestricted (legacy). */
  scopes: string[] | null;
  /** Scoped tokens (#5): ISO expiry; null = never expires. */
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Creation payload for an API token; omitting the #5 fields mints a legacy token. */
export interface CreateApiTokenBody {
  name: string;
  workspaceId?: string;
  scopes?: string[];
  expiresAt?: string;
}

export interface ContactImportResult {
  inserted: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
}

export interface GrowthLink {
  id: string;
  channelAccountId: string;
  kind: string;
  slug: string;
  label: string;
  prefilledText: string | null;
  boundFlowId: string | null;
  targetRef: string | null;
  targetUrl: string | null;
  clicks: number;
  conversions: number;
  shortUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface FlowGraphNode {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface FlowGraph {
  startNodeId: string;
  nodes: Array<Record<string, unknown>>;
  edges: Array<{ id: string; source: string; target: string; sourceHandle?: string | null }>;
}

export interface Flow {
  id: string;
  workspaceId: string;
  name: string;
  trigger: FlowTrigger;
  graph: FlowGraph;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface FlowTestRunResult {
  status: string;
  paused: boolean;
  actions: Array<Record<string, unknown>>;
  variables: Record<string, string>;
}

export interface SequenceStep {
  delaySeconds: number;
  text?: string;
  template?: {
    name: string;
    language: string;
    latestCategory: string;
    /** Per-recipient body parameter templates (variables package #1). */
    templateParams?: string[];
  };
}

export interface Sequence {
  id: string;
  channelAccountId: string;
  name: string;
  steps: SequenceStep[];
  status: string;
  stepCount: number;
  enrollmentCount: number;
  createdAt: string;
}

// ------------------------------------------------------- platform admin
// Deployment-scoped operator views (see apps/api/src/admin.ts). Every
// route requires a platform-admin session; values for settings are
// NEVER returned - only set/source metadata.

export interface AdminOverview {
  totals: {
    users: number;
    workspaces: number;
    channelAccounts: number;
    messages: number;
    messagesLast30d: number;
  };
  channelAccountsByChannel: Array<{ channel: string; count: number }>;
  activeUsers: { last7d: number; last30d: number };
  recentRegistrations: Array<{ id: string; email: string; name: string | null; createdAt: string }>;
}

export interface AdminUserItem {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  isPlatformAdmin: boolean;
  workspaces: Array<{ id: string; name: string; role: string }>;
}

export interface AdminWorkspaceItem {
  id: string;
  name: string;
  slug: string;
  ownerEmail: string | null;
  memberCount: number;
  channelAccountCount: number;
  messageCount: number;
  createdAt: string;
}

export interface AdminBillingCategory {
  category: string;
  units: number;
  entries: number;
  amount: number;
}

export interface AdminBillingWorkspace {
  workspaceId: string;
  workspaceName: string;
  currency: string;
  units: number;
  entries: number;
  amount: number;
  byCategory: AdminBillingCategory[];
}

export interface AdminBilling {
  days: number;
  workspaces: AdminBillingWorkspace[];
  totals: Array<{ currency: string; units: number; entries: number; amount: number }>;
}

export interface AdminSettingView {
  key: string;
  secret: boolean;
  group: string;
  label: string;
  hint?: string;
  isSet: boolean;
  /** Resolved value for non-secret keys (input prefill); always null for secrets. */
  value: string | null;
  source: "db" | "env" | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** One settings update: set a value, or clear the DB value (env fallback returns). */
export type AdminSettingUpdate = { key: string; value: string } | { key: string; clear: true };

export interface AdminAuditItem {
  id: string;
  action: string;
  actorEmail: string | null;
  userId: string | null;
  workspaceId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface StatsOverview {
  contacts: { total: number };
  conversations: { open: number; total: number };
  messagesLast30d: { in: number; out: number };
  broadcastsThisMonth: { sent: number; failed: number };
  costThisMonth: Array<{ currency: string; amount: number }>;
  scheduledPostsPending: number;
  activeFlows: number;
  recentConversations: Array<{
    id: string;
    channel: string;
    status: string;
    contactDisplayName: string | null;
    contactExternalId: string;
    updatedAt: string;
  }>;
}

export const api = {
  // ------------------------------------------------------------- auth
  async register(body: { email: string; password: string; name?: string; workspaceName?: string }): Promise<AuthResponse> {
    const res = await request<{ token: string; user: AuthUser; workspace: { id: string; name: string; slug: string } }>(
      "/auth/register", { method: "POST", body: JSON.stringify(body) },
    );
    return { token: res.token, user: res.user, workspace: res.workspace };
  },
  async login(body: { email: string; password: string }): Promise<AuthResponse> {
    const res = await request<LoginResponse>("/auth/login", { method: "POST", body: JSON.stringify(body) });
    // Normalize to the register shape: resume the previously selected
    // workspace when the user is still a member, else their first one.
    const stored = getWorkspaceId();
    const start = res.workspaces.find((w) => w.id === stored) ?? res.workspaces[0] ?? null;
    return { token: res.token, user: res.user, workspace: start ? { id: start.id, name: start.name, slug: start.slug } : null };
  },
  async logout(): Promise<void> {
    await request("/auth/logout", { method: "POST", body: "{}" }).catch(() => undefined);
    clearSession();
  },
  me(): Promise<{ user: AuthUser }> {
    return request("/auth/me");
  },
  // -------------------------------------------------------- API tokens
  listApiTokens(): Promise<{ tokens: ApiTokenInfo[] }> {
    return request("/auth/tokens");
  },
  createApiToken(body: CreateApiTokenBody): Promise<{ token: string; tokenInfo: ApiTokenInfo }> {
    return request("/auth/tokens", { method: "POST", body: JSON.stringify(body) });
  },
  revokeApiToken(id: string): Promise<{ revoked: boolean }> {
    return request(`/auth/tokens/${id}`, { method: "DELETE" });
  },
  listWorkspaces(): Promise<{ workspaces: WorkspaceSummary[] }> {
    return request("/workspaces");
  },
  createWorkspace(body: { name: string }): Promise<{ workspace: WorkspaceSummary }> {
    return request("/workspaces", { method: "POST", body: JSON.stringify(body) });
  },
  // -------------------------------------------------------- knowledge base
  listKbDocuments(): Promise<{ documents: KbDocument[] }> {
    return request("/kb/documents");
  },
  createKbDocument(body: { title: string; content: string }): Promise<{ document: KbDocument }> {
    return request("/kb/documents", { method: "POST", body: JSON.stringify(body) });
  },
  /** Upload a document file (PDF/DOCX/TXT/MD); the API extracts the text server-side. */
  uploadKbDocument(file: File, title?: string): Promise<KbUploadResult> {
    const form = new FormData();
    form.append("file", file);
    if (title?.trim()) form.append("title", title.trim());
    return request("/kb/documents/upload", { method: "POST", body: form });
  },
  deleteKbDocument(id: string): Promise<{ deleted: boolean }> {
    return request(`/kb/documents/${id}`, { method: "DELETE" });
  },
  // ------------------------------------------------------------- domain
  listConversations(
    params: { channel?: string; status?: string; assignee?: string } = {},
  ): Promise<{ conversations: Conversation[] }> {
    const qs = new URLSearchParams();
    if (params.channel) qs.set("channel", params.channel);
    if (params.status) qs.set("status", params.status);
    if (params.assignee) qs.set("assignee", params.assignee);
    const suffix = qs.toString() ? `?${qs}` : "";
    return request(`/conversations${suffix}`);
  },
  /** Set (userId) or clear (null) a conversation's assignee. */
  assignConversation(
    conversationId: string,
    userId: string | null,
  ): Promise<{ conversation: Conversation }> {
    return request(`/conversations/${conversationId}/assign`, {
      method: "PATCH",
      body: JSON.stringify({ userId }),
    });
  },
  /** Move a conversation between open / pending / resolved. */
  setConversationStatus(
    conversationId: string,
    status: "open" | "pending" | "resolved",
  ): Promise<{ conversation: Conversation }> {
    return request(`/conversations/${conversationId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  },
  listMessages(conversationId: string): Promise<{ messages: Message[] }> {
    return request(`/conversations/${conversationId}/messages`);
  },
  reply(
    conversationId: string,
    body: { kind: "free_form" | "template"; text?: string; templateId?: string; rich?: RichBlock },
  ): Promise<{ message: unknown; delivery: string; warnings?: string[]; interpolationWarnings?: string[] }> {
    return request(`/conversations/${conversationId}/reply`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  /** Add an internal note to the thread (package #2): team-only, never sent to the customer. */
  addNote(conversationId: string, body: string): Promise<{ message: Message }> {
    return request(`/conversations/${conversationId}/notes`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  },
  listSavedReplies(): Promise<{ savedReplies: SavedReply[] }> {
    return request("/saved-replies");
  },
  createSavedReply(body: {
    title: string; body: string; shortcut?: string | null;
  }): Promise<{ savedReply: SavedReply }> {
    return request("/saved-replies", { method: "POST", body: JSON.stringify(body) });
  },
  updateSavedReply(
    id: string,
    body: { title?: string; body?: string; shortcut?: string | null },
  ): Promise<{ savedReply: SavedReply }> {
    return request(`/saved-replies/${id}`, { method: "PATCH", body: JSON.stringify(body) });
  },
  deleteSavedReply(id: string): Promise<{ deleted: boolean }> {
    return request(`/saved-replies/${id}`, { method: "DELETE" });
  },
  /** AI reply suggestion for the composer (F4): fills the draft, never sends. 503 when no AI provider is configured. */
  aiSuggest(conversationId: string): Promise<{ suggestion: string; model: string; kbChunksUsed: number }> {
    return request(`/conversations/${conversationId}/ai-suggest`, { method: "POST", body: "{}" });
  },
  /** Local flag-list moderation verdict for a draft (F9). */
  moderationCheck(text: string): Promise<{ flagged: boolean; matches: Array<{ term: string; index: number }> }> {
    return request("/moderation/check", { method: "POST", body: JSON.stringify({ text }) });
  },
  listContacts(tag?: string): Promise<{ contacts: Contact[] }> {
    const suffix = tag ? `?tag=${encodeURIComponent(tag)}` : "";
    return request(`/contacts${suffix}`);
  },
  getContact(id: string): Promise<{ contact: Contact }> {
    return request(`/contacts/${id}`);
  },
  createContact(body: {
    channel: string;
    externalId: string;
    displayName?: string;
    tags?: string[];
    customFields?: Record<string, unknown>;
  }): Promise<{ contact: Contact }> {
    return request("/contacts", { method: "POST", body: JSON.stringify(body) });
  },
  /** PATCH merges customFields key-wise; displayName/tags replace. */
  updateContact(
    id: string,
    body: { displayName?: string | null; tags?: string[]; customFields?: Record<string, unknown> },
  ): Promise<{ contact: Contact }> {
    return request(`/contacts/${id}`, { method: "PATCH", body: JSON.stringify(body) });
  },
  listSegments(): Promise<{ segments: SegmentInfo[] }> {
    return request("/segments");
  },
  importContacts(body: {
    format: "csv" | "json";
    content: string;
    conflict: "skip" | "update";
  }): Promise<ContactImportResult> {
    return request("/contacts/import", { method: "POST", body: JSON.stringify(body) });
  },
  /** Export downloads raw text (CSV/JSON); the caller saves it as a file. */
  async exportContacts(format: "csv" | "json"): Promise<string> {
    return requestText(`/contacts/export?format=${format}`);
  },
  // -------------------------------------------------------- growth links
  listGrowthLinks(): Promise<{ links: GrowthLink[] }> {
    return request("/growth-links");
  },
  createGrowthLink(body: {
    channelAccountId: string;
    label: string;
    prefilledText?: string;
    boundFlowId?: string;
    targetRef?: string;
    targetUrl?: string;
  }): Promise<{ link: GrowthLink }> {
    return request("/growth-links", { method: "POST", body: JSON.stringify(body) });
  },
  deleteGrowthLink(id: string): Promise<{ deleted: boolean }> {
    return request(`/growth-links/${id}`, { method: "DELETE" });
  },
  /** QR SVG markup for a link's short URL (auth-required endpoint). */
  async growthLinkQrSvg(id: string): Promise<string> {
    return requestText(`/growth-links/${id}/qr.svg`);
  },
  listTemplates(): Promise<{ templates: Template[] }> {
    return request("/templates");
  },
  /** Register an existing WhatsApp template with Botara (F6). */
  createTemplate(body: {
    channelAccountId: string;
    name: string;
    language?: string;
    category?: string;
    externalId?: string;
  }): Promise<{ template: Template }> {
    return request("/templates", { method: "POST", body: JSON.stringify(body) });
  },
  /** Correct a template's category after a Meta category-change event (F6). */
  updateTemplateCategory(id: string, latestCategory: string): Promise<{ template: Template }> {
    return request(`/templates/${id}/category`, {
      method: "PATCH",
      body: JSON.stringify({ latestCategory }),
    });
  },
  estimateBroadcast(body: {
    category: string;
    countryMix: Array<{ country: string; recipients: number }>;
  }): Promise<BroadcastEstimate> {
    return request("/broadcasts/estimate", { method: "POST", body: JSON.stringify(body) });
  },
  createBroadcast(body: {
    channelAccountId: string;
    templateId?: string;
    /** Ordered per-recipient body parameter templates (variables #1). */
    templateParams?: string[];
    name?: string;
    country?: string;
    recipientCount?: number;
    tag?: string;
  }): Promise<{ broadcast: { id: string; status: string }; estimate: BroadcastEstimate }> {
    return request("/broadcasts", { method: "POST", body: JSON.stringify(body) });
  },
  /** Broadcast history (F5): newest first, with delivery counts + realized cost. */
  listBroadcasts(): Promise<{ broadcasts: BroadcastSummary[] }> {
    return request("/broadcasts");
  },
  getBroadcast(id: string): Promise<{
    broadcast: BroadcastDetail;
    sentCount: number;
    failedCount: number;
    totalCostUsd: number;
    costEntries: number;
    costUnits: number;
  }> {
    return request(`/broadcasts/${id}`);
  },
  /** Per-recipient delivery records for one broadcast (package #4). */
  listBroadcastRecipients(id: string, status?: string): Promise<BroadcastRecipientsPage> {
    const qs = status ? "?status=" + encodeURIComponent(status) : "";
    return request(`/broadcasts/${id}/recipients${qs}`);
  },
  /** Re-queue sends for the broadcast's failed recipients only (package #4). */
  resendBroadcastFailed(id: string): Promise<{ resent: number }> {
    return request(`/broadcasts/${id}/resend-failed`, { method: "POST" });
  },
  // ------------------------------------------------------ deals (#6)
  listPipelines(): Promise<{ pipelines: Pipeline[] }> {
    return request("/pipelines");
  },
  createPipeline(body: {
    name: string; withDefaultStages?: boolean; stages?: string[]; makeDefault?: boolean;
  }): Promise<{ pipeline: Pipeline }> {
    return request("/pipelines", { method: "POST", body: JSON.stringify(body) });
  },
  updatePipeline(id: string, body: { name?: string; isDefault?: boolean }): Promise<{ pipeline: Pipeline }> {
    return request(`/pipelines/${id}`, { method: "PATCH", body: JSON.stringify(body) });
  },
  deletePipeline(id: string, force = false): Promise<{ deleted: boolean }> {
    return request(`/pipelines/${id}${force ? "?force=true" : ""}`, { method: "DELETE" });
  },
  getPipelineSummary(id: string): Promise<{ summary: PipelineSummary }> {
    return request(`/pipelines/${id}/summary`);
  },
  createPipelineStage(pipelineId: string, body: { name: string }): Promise<{ stage: PipelineStage }> {
    return request(`/pipelines/${pipelineId}/stages`, { method: "POST", body: JSON.stringify(body) });
  },
  updatePipelineStage(pipelineId: string, stageId: string, body: { name: string }): Promise<{ stage: PipelineStage }> {
    return request(`/pipelines/${pipelineId}/stages/${stageId}`, { method: "PATCH", body: JSON.stringify(body) });
  },
  deletePipelineStage(pipelineId: string, stageId: string): Promise<{ deleted: boolean }> {
    return request(`/pipelines/${pipelineId}/stages/${stageId}`, { method: "DELETE" });
  },
  reorderPipelineStages(pipelineId: string, stageIds: string[]): Promise<{ stages: PipelineStage[] }> {
    return request(`/pipelines/${pipelineId}/stages/reorder`, {
      method: "POST", body: JSON.stringify({ stageIds }),
    });
  },
  listDeals(query: {
    pipelineId?: string; stageId?: string; status?: string; contactId?: string;
    limit?: number; offset?: number;
  } = {}): Promise<{ deals: Deal[]; total: number }> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") params.set(key, String(value));
    }
    const suffix = params.toString() ? `?${params}` : "";
    return request(`/deals${suffix}`);
  },
  createDeal(body: {
    pipelineId: string; contactId: string; title: string;
    stageId?: string; conversationId?: string | null; value?: number | null;
    currency?: string; status?: DealStatus; expectedCloseDate?: string | null; notes?: string | null;
  }): Promise<{ deal: Deal }> {
    return request("/deals", { method: "POST", body: JSON.stringify(body) });
  },
  updateDeal(id: string, body: Partial<{
    title: string; pipelineId: string; stageId: string; contactId: string;
    conversationId: string | null; value: number | null; currency: string;
    status: DealStatus; expectedCloseDate: string | null; notes: string | null;
  }>): Promise<{ deal: Deal }> {
    return request(`/deals/${id}`, { method: "PATCH", body: JSON.stringify(body) });
  },
  deleteDeal(id: string): Promise<{ deleted: boolean }> {
    return request(`/deals/${id}`, { method: "DELETE" });
  },
  listChannelAccounts(): Promise<{ accounts: ChannelAccount[] }> {
    return request("/channels/accounts");
  },
  deleteChannelAccount(
    id: string,
    purge = false,
  ): Promise<{ mode: "deleted" | "disconnected" | "purged" }> {
    return request(`/channels/accounts/${id}${purge ? "?purge=true" : ""}`, { method: "DELETE" });
  },
  // ------------------------------------------------- email domains (F2)
  listEmailDomains(): Promise<{ domains: WorkspaceDomain[] }> {
    return request("/channels/email/domains");
  },
  addEmailDomain(body: {
    domain: string;
    channelAccountId?: string;
    resendDomainId?: string;
  }): Promise<{ domain: WorkspaceDomain }> {
    return request("/channels/email/domains", { method: "POST", body: JSON.stringify(body) });
  },
  deleteEmailDomain(id: string): Promise<{ deleted: boolean }> {
    return request(`/channels/email/domains/${id}`, { method: "DELETE" });
  },
  // ------------------------------------------------- Meta catalog sync
  listCatalogProducts(
    params: { accountId?: string; q?: string; limit?: number } = {},
  ): Promise<{ products: CatalogProduct[] }> {
    const qs = new URLSearchParams();
    if (params.accountId) qs.set("accountId", params.accountId);
    if (params.q) qs.set("q", params.q);
    if (params.limit) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs}` : "";
    return request(`/catalog-products${suffix}`);
  },
  getCatalogSummary(accountId: string): Promise<CatalogSummary> {
    return request(`/channels/${accountId}/catalog`);
  },
  syncCatalog(accountId: string, catalogId?: string): Promise<CatalogSyncResult> {
    return request(`/channels/${accountId}/catalog/sync`, {
      method: "POST",
      body: JSON.stringify(catalogId ? { catalogId } : {}),
    });
  },
  listPosts(status?: string): Promise<{ posts: ScheduledPost[] }> {
    const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
    return request(`/posts${suffix}`);
  },
  createPost(body: {
    text?: string;
    mediaUrls?: string[];
    targets: Array<{ channelAccountId: string; targetExternalId?: string }>;
    scheduledAt?: string;
  }): Promise<{ post: ScheduledPost }> {
    return request("/posts", { method: "POST", body: JSON.stringify(body) });
  },
  /** Edit a draft/scheduled post (F10); telegram targets round-trip their destination (item H). */
  updatePost(
    id: string,
    body: {
      text?: string;
      mediaUrls?: string[];
      targets?: Array<{ channelAccountId: string; targetExternalId?: string }>;
      scheduledAt?: string | null;
      status?: "draft" | "scheduled" | "cancelled";
    },
  ): Promise<{ post: ScheduledPost }> {
    return request(`/posts/${id}`, { method: "PATCH", body: JSON.stringify(body) });
  },
  publishPostNow(postId: string): Promise<{ post: ScheduledPost }> {
    return request(`/posts/${postId}/publish-now`, { method: "POST", body: "{}" });
  },
  deletePost(postId: string): Promise<{ deleted: boolean }> {
    return request(`/posts/${postId}`, { method: "DELETE" });
  },
  // ------------------------------------------------- settings (Fase 4)
  patchMe(body: { name: string }): Promise<{ user: AuthUser }> {
    return request("/auth/me", { method: "PATCH", body: JSON.stringify(body) });
  },
  changePassword(body: { currentPassword: string; newPassword: string }): Promise<{ ok: boolean }> {
    return request("/auth/change-password", { method: "POST", body: JSON.stringify(body) });
  },
  renameWorkspace(
    workspaceDbId: string,
    body: { name?: string; defaultCurrency?: string },
  ): Promise<{ workspace: WorkspaceSummary | null }> {
    return request(`/workspaces/${workspaceDbId}`, { method: "PATCH", body: JSON.stringify(body) });
  },
  listMembers(workspaceDbId: string): Promise<{ members: Member[] }> {
    return request(`/workspaces/${workspaceDbId}/members`);
  },
  inviteMember(workspaceDbId: string, body: { email: string; role: string }): Promise<{ member: Member }> {
    return request(`/workspaces/${workspaceDbId}/members`, { method: "POST", body: JSON.stringify(body) });
  },
  patchMemberRole(workspaceDbId: string, userId: string, role: string): Promise<{ member: Member }> {
    return request(`/workspaces/${workspaceDbId}/members/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    });
  },
  removeMember(workspaceDbId: string, userId: string): Promise<{ removed: boolean }> {
    return request(`/workspaces/${workspaceDbId}/members/${userId}`, { method: "DELETE" });
  },
  // ---------------------------------------------------- flows (Fase 4)
  listFlows(): Promise<{ flows: Flow[] }> {
    return request("/flows");
  },
  createFlow(body: { name: string; trigger: FlowTrigger; graph: FlowGraph }): Promise<{ flow: Flow }> {
    return request("/flows", { method: "POST", body: JSON.stringify(body) });
  },
  updateFlow(id: string, body: { name?: string; trigger?: FlowTrigger; graph?: FlowGraph }): Promise<{ flow: Flow }> {
    return request(`/flows/${id}`, { method: "PATCH", body: JSON.stringify(body) });
  },
  deleteFlow(id: string): Promise<{ deleted: boolean }> {
    return request(`/flows/${id}`, { method: "DELETE" });
  },
  activateFlow(id: string): Promise<{ flow: Flow }> {
    return request(`/flows/${id}/activate`, { method: "POST", body: "{}" });
  },
  deactivateFlow(id: string): Promise<{ flow: Flow }> {
    return request(`/flows/${id}/deactivate`, { method: "POST", body: "{}" });
  },
  testRunFlow(id: string, body: { text?: string; contactFields?: Record<string, string> }): Promise<FlowTestRunResult> {
    return request(`/flows/${id}/test-run`, { method: "POST", body: JSON.stringify(body) });
  },
  // ------------------------------------------------ sequences (Fase 4 UI)
  listSequences(): Promise<{ sequences: Sequence[] }> {
    return request("/sequences");
  },
  createSequence(body: { channelAccountId: string; name: string; steps: SequenceStep[] }): Promise<{ sequence: Sequence }> {
    return request("/sequences", { method: "POST", body: JSON.stringify(body) });
  },
  updateSequence(id: string, body: { name?: string; steps?: SequenceStep[]; status?: string }): Promise<{ sequence: Sequence }> {
    return request(`/sequences/${id}`, { method: "PATCH", body: JSON.stringify(body) });
  },
  deleteSequence(id: string): Promise<{ deleted: boolean }> {
    return request(`/sequences/${id}`, { method: "DELETE" });
  },
  enrollSequence(id: string, tag: string): Promise<{ enrolled: number; skipped: number; total: number }> {
    return request(`/sequences/${id}/enroll`, { method: "POST", body: JSON.stringify({ tag }) });
  },
  // -------------------------------------------------- stats + channels
  getStatsOverview(): Promise<StatsOverview> {
    return request("/stats/overview");
  },
  getPublicConfig(): Promise<PublicConfig> {
    return request("/config/public");
  },
  connectTelegram(body: { botToken: string; label?: string }): Promise<{
    account: { id: string; channel: string; externalId: string; displayName: string; status: string; webhookSet: boolean };
  }> {
    return request("/channels/telegram/connect", { method: "POST", body: JSON.stringify(body) });
  },
  getMessengerPendingPages(): Promise<{ pages: Array<{ id: string; name: string }> }> {
    return request("/channels/messenger/pending-pages");
  },
  selectMessengerPage(pageId: string): Promise<{ account: { id: string; externalId: string; displayName: string } }> {
    return request("/channels/messenger/select-page", { method: "POST", body: JSON.stringify({ pageId }) });
  },
  exchangeWhatsAppSignup(body: {
    code: string;
    sessionInfo?: { wabaId?: string; phoneNumberId?: string; isCoexistence?: boolean };
  }): Promise<unknown> {
    return request("/channels/whatsapp/embedded-signup/exchange", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  // ------------------------------------------------ platform admin panel
  adminOverview(): Promise<AdminOverview> {
    return request("/admin/overview");
  },
  adminUsers(): Promise<{ users: AdminUserItem[] }> {
    return request("/admin/users");
  },
  adminSetPlatformAdmin(id: string, grant: boolean): Promise<{ user: { id: string; isPlatformAdmin: boolean } }> {
    return request(`/admin/users/${id}/platform-admin`, {
      method: "POST",
      body: JSON.stringify({ grant }),
    });
  },
  adminWorkspaces(): Promise<{ workspaces: AdminWorkspaceItem[] }> {
    return request("/admin/workspaces");
  },
  adminBilling(days: number): Promise<AdminBilling> {
    return request(`/admin/billing?days=${days}`);
  },
  adminSettings(): Promise<{ settings: AdminSettingView[] }> {
    return request("/admin/settings");
  },
  adminUpdateSettings(updates: AdminSettingUpdate[]): Promise<{ settings: AdminSettingView[] }> {
    return request("/admin/settings", {
      method: "PUT",
      body: JSON.stringify({ updates }),
    });
  },
  adminAudit(limit: number): Promise<{ entries: AdminAuditItem[] }> {
    return request(`/admin/audit?limit=${limit}`);
  },
  /** Callback-URL connection reference for provider dashboards (F11). */
  adminConnectionInfo(): Promise<ConnectionInfo> {
    return request("/admin/connection-info");
  },
};
