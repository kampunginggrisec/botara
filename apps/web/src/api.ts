/**
 * Botara web API client (Fase 3: real auth).
 * Base URL from VITE_API_URL (default: local API). The session JWT from
 * /auth/login|register is kept in localStorage and sent as a Bearer token;
 * the selected workspace id rides along as X-Workspace-Id, which the API
 * now treats purely as a workspace SELECTOR - membership and role are
 * verified server-side from the token. (The API also sets an httpOnly
 * session cookie; the Bearer token is what this SPA uses.)
 */

const BASE_URL: string = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

const WORKSPACE_KEY = "botara.workspaceId";
const TOKEN_KEY = "botara.token";

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
    throw new ApiError("NETWORK", 0, "API tidak dapat dihubungi. Pastikan server API berjalan.");
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
      body?.error?.message ?? `Request gagal (HTTP ${res.status}).`,
    );
  }
  return body as T;
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
  reply(conversationId: string, body: { kind: "free_form" | "template"; text?: string; templateId?: string }): Promise<unknown> {
    return request(`/conversations/${conversationId}/reply`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  listContacts(tag?: string): Promise<{ contacts: Contact[] }> {
    const suffix = tag ? `?tag=${encodeURIComponent(tag)}` : "";
    return request(`/contacts${suffix}`);
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
};
