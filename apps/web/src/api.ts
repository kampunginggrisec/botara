/**
 * Botara web API client (Fase 3: real auth).
 * Base URL from VITE_API_URL (default: local API). The session JWT from
 * /auth/login|register is kept in localStorage and sent as a Bearer token;
 * the selected workspace id rides along as X-Workspace-Id, which the API
 * now treats purely as a workspace SELECTOR - membership and role are
 * verified server-side from the token. (The API also sets an httpOnly
 * session cookie; the Bearer token is what this SPA uses.)
 */

export const BASE_URL: string = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

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
        "content-type": "application/json",
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
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
  workspace: { id: string; name: string; slug: string };
}

export interface KbDocument {
  id: string;
  title: string;
  status: string;
  chunkCount: number;
  error?: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  channel: string;
  status: string;
  contactExternalId: string;
  contactDisplayName: string | null;
  lastUserMessageAt: string | null;
  windowOpen: boolean;
  createdAt: string;
}

export interface Message {
  id: string;
  direction: "in" | "out";
  type: string;
  body: string | null;
  status: string;
  createdAt: string;
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

export interface ChannelAccount {
  id: string;
  channel: string;
  externalId: string;
  displayName: string | null;
  authMode: string | null;
  status: string;
  hasCredential: boolean;
  tokenExpiresAt: string | null;
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
  targets: Array<{ channelAccountId: string; channel: string }>;
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
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
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
  template?: { name: string; language: string; latestCategory: string };
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
  register(body: { email: string; password: string; name?: string; workspaceName?: string }): Promise<AuthResponse> {
    return request("/auth/register", { method: "POST", body: JSON.stringify(body) });
  },
  login(body: { email: string; password: string }): Promise<AuthResponse> {
    return request("/auth/login", { method: "POST", body: JSON.stringify(body) });
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
  createApiToken(name: string): Promise<{ token: string; tokenInfo: ApiTokenInfo }> {
    return request("/auth/tokens", { method: "POST", body: JSON.stringify({ name }) });
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
  deleteKbDocument(id: string): Promise<{ deleted: boolean }> {
    return request(`/kb/documents/${id}`, { method: "DELETE" });
  },
  // ------------------------------------------------------------- domain
  listConversations(params: { channel?: string; status?: string } = {}): Promise<{ conversations: Conversation[] }> {
    const qs = new URLSearchParams();
    if (params.channel) qs.set("channel", params.channel);
    if (params.status) qs.set("status", params.status);
    const suffix = qs.toString() ? `?${qs}` : "";
    return request(`/conversations${suffix}`);
  },
  listMessages(conversationId: string): Promise<{ messages: Message[] }> {
    return request(`/conversations/${conversationId}/messages`);
  },
  reply(
    conversationId: string,
    body: { kind: "free_form" | "template"; text?: string; templateId?: string; rich?: RichBlock },
  ): Promise<{ message: unknown; delivery: string; warnings?: string[] }> {
    return request(`/conversations/${conversationId}/reply`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  listContacts(tag?: string): Promise<{ contacts: Contact[] }> {
    const suffix = tag ? `?tag=${encodeURIComponent(tag)}` : "";
    return request(`/contacts${suffix}`);
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
  estimateBroadcast(body: {
    category: string;
    countryMix: Array<{ country: string; recipients: number }>;
  }): Promise<BroadcastEstimate> {
    return request("/broadcasts/estimate", { method: "POST", body: JSON.stringify(body) });
  },
  createBroadcast(body: {
    channelAccountId: string;
    templateId?: string;
    name?: string;
    country?: string;
    recipientCount?: number;
    tag?: string;
  }): Promise<{ broadcast: { id: string; status: string }; estimate: BroadcastEstimate }> {
    return request("/broadcasts", { method: "POST", body: JSON.stringify(body) });
  },
  listChannelAccounts(): Promise<{ accounts: ChannelAccount[] }> {
    return request("/channels/accounts");
  },
  listPosts(status?: string): Promise<{ posts: ScheduledPost[] }> {
    const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
    return request(`/posts${suffix}`);
  },
  createPost(body: {
    text?: string;
    mediaUrls?: string[];
    targets: Array<{ channelAccountId: string }>;
    scheduledAt?: string;
  }): Promise<{ post: ScheduledPost }> {
    return request("/posts", { method: "POST", body: JSON.stringify(body) });
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
  renameWorkspace(workspaceDbId: string, body: { name: string }): Promise<{ workspace: WorkspaceSummary | null }> {
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
};
