/**
 * Botara web API client (Fase 1).
 * Base URL from VITE_API_URL (default: local API). Workspace context is the
 * Fase 1 stand-in for auth: the workspace id is kept in localStorage and
 * sent as the X-Workspace-Id header on every DB-backed request.
 */

const BASE_URL: string = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

const WORKSPACE_KEY = "botara.workspaceId";

export function getWorkspaceId(): string {
  return localStorage.getItem(WORKSPACE_KEY) ?? "";
}

export function setWorkspaceId(id: string): void {
  localStorage.setItem(WORKSPACE_KEY, id);
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
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
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
    throw new ApiError(
      body?.error?.code ?? "INTERNAL",
      res.status,
      body?.error?.message ?? `Request gagal (HTTP ${res.status}).`,
    );
  }
  return body as T;
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

export const api = {
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
};
