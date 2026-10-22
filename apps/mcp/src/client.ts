/**
 * Botara REST client for the MCP server. The MCP process holds ONE
 * personal API token (BOTARA_API_TOKEN, a `bta_...` token created in
 * Botara Settings) and talks to the Botara API exactly like any other API
 * client - all authorization, workspace membership, and messaging-window
 * rules are enforced server-side by the API, never re-implemented here.
 */

export interface BotaraClientConfig {
  baseUrl: string;
  token: string;
  fetchFn?: typeof fetch;
}

export class BotaraApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "BotaraApiError";
    this.code = code;
    this.status = status;
  }
}

export class BotaraClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: BotaraClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.token = config.token;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  /** Botara config from the environment. BOTARA_API_TOKEN is mandatory. */
  static fromEnv(env: Record<string, string | undefined> = process.env): BotaraClient {
    const token = env.BOTARA_API_TOKEN;
    if (!token) {
      throw new Error(
        "BOTARA_API_TOKEN is not set. Create a token in Botara Settings -> API tokens and pass it as BOTARA_API_TOKEN (see docs/mcp.md).",
      );
    }
    return new BotaraClient({
      baseUrl: env.BOTARA_API_URL ?? "http://localhost:3000/api",
      token,
    });
  }

  async request<T>(
    method: "GET" | "POST",
    path: string,
    options: { workspaceId?: string; body?: unknown } = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
          ...(options.workspaceId ? { "x-workspace-id": options.workspaceId } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (err) {
      throw new BotaraApiError(
        "NETWORK",
        0,
        `Cannot reach the Botara API at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const body = (await res.json().catch(() => null)) as
      | (T & { error?: { code: string; message: string } })
      | null;
    if (!res.ok) {
      throw new BotaraApiError(
        body?.error?.code ?? "INTERNAL",
        res.status,
        body?.error?.message ?? `Botara API request failed (HTTP ${res.status}).`,
      );
    }
    return body as T;
  }

  // ------------------------------------------------------------ endpoints

  me(): Promise<{ user: { id: string; email: string; name: string | null }; workspaces: Array<{ id: string; name: string; slug: string; role: string }> }> {
    return this.request("GET", "/auth/me");
  }

  overview(workspaceId: string): Promise<Record<string, unknown>> {
    return this.request("GET", "/stats/overview", { workspaceId });
  }

  listConversations(workspaceId: string, filter: { channel?: string; status?: string }): Promise<{ conversations: unknown[] }> {
    const qs = new URLSearchParams();
    if (filter.channel) qs.set("channel", filter.channel);
    if (filter.status) qs.set("status", filter.status);
    const suffix = qs.toString() ? `?${qs}` : "";
    return this.request("GET", `/conversations${suffix}`, { workspaceId });
  }

  listMessages(workspaceId: string, conversationId: string): Promise<{ messages: unknown[] }> {
    return this.request("GET", `/conversations/${conversationId}/messages`, { workspaceId });
  }

  reply(workspaceId: string, conversationId: string, text: string): Promise<unknown> {
    return this.request("POST", `/conversations/${conversationId}/reply`, {
      workspaceId,
      body: { kind: "free_form", text },
    });
  }

  listContacts(workspaceId: string, filter: { tag?: string; channel?: string }): Promise<{ contacts: unknown[] }> {
    const qs = new URLSearchParams();
    if (filter.tag) qs.set("tag", filter.tag);
    if (filter.channel) qs.set("channel", filter.channel);
    const suffix = qs.toString() ? `?${qs}` : "";
    return this.request("GET", `/contacts${suffix}`, { workspaceId });
  }

  listFlows(workspaceId: string): Promise<{ flows: unknown[] }> {
    return this.request("GET", "/flows", { workspaceId });
  }

  testRunFlow(workspaceId: string, flowId: string, text?: string): Promise<unknown> {
    return this.request("POST", `/flows/${flowId}/test-run`, {
      workspaceId,
      body: { text },
    });
  }

  broadcastEstimate(body: {
    category: string;
    countryMix: Array<{ country: string; recipients: number }>;
  }): Promise<unknown> {
    return this.request("POST", "/broadcasts/estimate", { body });
  }

  listSequences(workspaceId: string): Promise<{ sequences: unknown[] }> {
    return this.request("GET", "/sequences", { workspaceId });
  }

  enrollSequence(workspaceId: string, sequenceId: string, tag: string): Promise<unknown> {
    return this.request("POST", `/sequences/${sequenceId}/enroll`, {
      workspaceId,
      body: { tag },
    });
  }
}
