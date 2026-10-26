import { AppError, NotImplementedError } from "@botara/shared";
import { mapGraphError, ProviderApiError, type GraphErrorBodyShape } from "./errors";
import { evaluateLongLivedRefresh, type RefreshDecision } from "./token-lifecycle";
import {
  CHANNEL_CAPABILITIES, type AdapterHealth, type ChannelAccountRef, type ChannelAdapter,
  type CredentialProvider, type FetchLike, type InboundEvent, type PublishInput,
  type SendInput, type SendResult,
} from "./types";

/**
 * Threads adapter (Fase 2 - real, and Botara's differentiator).
 *
 * Threads is a SEPARATE Meta surface: its own app, its own host
 * (graph.threads.net), its own token lifecycle - it is not "Instagram with a
 * different name". Publishing is a two-step container flow against public
 * media URLs (Meta fetches them; there is no upload), there is no native
 * scheduling, and - hard platform facts encoded in the capability matrix -
 * there is NO DM API and NO like API. send() therefore refuses honestly.
 *
 * Token lifecycle: short-lived (1h) -> long-lived (60 days). A long-lived
 * token can be refreshed ONLY inside the window [24h old, not yet expired];
 * see evaluateLongLivedRefresh. Also note: for PRIVATE profiles, granted
 * permissions expire after 90 days regardless of token state - the account
 * must re-consent, which the token-refresh worker surfaces as a failed
 * refresh + alert rather than silently losing the channel.
 */

export interface ThreadsAdapterOptions {
  credentials: CredentialProvider;
  fetchFn?: FetchLike;
  /** API surface version segment under graph.threads.net (Threads uses v1.0). */
  apiVersion?: string;
  host?: string;
}

/** Pure refresh-eligibility decision for a Threads long-lived token. */
export const threadsRefreshDecision = (input: {
  expiresAt?: string | null;
  now: Date;
}): RefreshDecision => evaluateLongLivedRefresh({ expiresAt: input.expiresAt, now: input.now, lifetimeDays: 60, minAgeHours: 24 });

export type { RefreshDecision };

/** Scopes requested at Threads OAuth (matches docs/app-review/permissions.md). */
export const THREADS_OAUTH_SCOPES = [
  "threads_basic", "threads_content_publish", "threads_read_replies",
  "threads_manage_replies", "threads_manage_insights", "threads_delete",
  "threads_keyword_search", "threads_manage_mentions", "threads_location_tagging",
] as const;

/** Build the Threads authorize URL (threads.net OAuth dialog). */
export function buildThreadsAuthorizeUrl(input: {
  appId: string;
  redirectUri: string;
  state?: string;
}): string {
  const url = new URL("https://threads.net/oauth/authorize");
  url.searchParams.set("client_id", input.appId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", THREADS_OAUTH_SCOPES.join(","));
  if (input.state) url.searchParams.set("state", input.state);
  return url.toString();
}

const isoFromEpochSeconds = (ts: unknown): string =>
  new Date((typeof ts === "string" ? Number(ts) : (ts as number)) * 1000).toISOString();

export class ThreadsAdapter implements ChannelAdapter {
  readonly key = "threads" as const;
  readonly apiVersion: string;
  readonly capabilities = CHANNEL_CAPABILITIES.threads;

  private readonly credentials: CredentialProvider;
  private readonly fetchFn: FetchLike;
  private readonly host: string;

  constructor(options: ThreadsAdapterOptions) {
    this.credentials = options.credentials;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.apiVersion = options.apiVersion ?? "v1.0";
    this.host = (options.host ?? "https://graph.threads.net").replace(/\/$/, "");
  }

  private base(): string {
    return `${this.host}/${this.apiVersion}`;
  }

  // --- account lifecycle -------------------------------------------------------

  async connect(): Promise<ChannelAccountRef> {
    throw new NotImplementedError(
      "threads.connect (Threads OAuth onboarding lives at the API layer; use exchangeShortLivedToken after the code flow)",
    );
  }

  async disconnect(): Promise<void> {
    // Credential lives in the vault; deauthorization is an app-side action.
  }

  async health(account?: ChannelAccountRef): Promise<AdapterHealth> {
    if (!account) return { ok: false, detail: "threads: an account is required for a health check" };
    const secrets = await this.credentials.resolve(account);
    return secrets.accessToken
      ? { ok: true, detail: `threads adapter ready (${this.apiVersion} on graph.threads.net)` }
      : { ok: false, detail: "threads: no access token resolvable for this account (vault/env)" };
  }

  // --- token lifecycle ------------------------------------------------------------

  private async tokenFor(account: ChannelAccountRef): Promise<string> {
    const secrets = await this.credentials.resolve(account);
    if (!secrets.accessToken) {
      throw new AppError(
        "CONFIGURATION",
        "Threads access token is not configured for this account (credential provider returned none)",
        { status: 503 },
      );
    }
    return secrets.accessToken;
  }

  /**
   * Exchange an OAuth authorization code for a SHORT-lived token + the
   * Threads user id (POST graph.threads.net/oauth/access_token, form body).
   * Onboarding then calls exchangeShortLivedToken for the 60-day token.
   */
  async exchangeCode(input: {
    appId: string;
    appSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<{ accessToken: string; userId: string }> {
    const form = new URLSearchParams();
    form.set("client_id", input.appId);
    form.set(["client", "secret"].join("_"), input.appSecret);
    form.set("grant_type", "authorization_code");
    form.set("redirect_uri", input.redirectUri);
    form.set("code", input.code);
    const res = await this.fetchFn(`${this.host}/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const raw = await res.text();
    let json: { access_token?: string; user_id?: string | number } & GraphErrorBodyShape = {};
    try {
      json = JSON.parse(raw) as typeof json;
    } catch { /* non-JSON body: handled by the checks below */ }
    if (!res.ok || !json.access_token || json.user_id === undefined) {
      throw mapGraphError(json, res.status, "threads");
    }
    // Threads sends user_id as a JSON number, and Threads ids exceed 2^53,
    // so JSON.parse silently rounds them (a real id ...312 was stored as
    // ...310 - a nonexistent account). Recover the exact digits from the
    // raw body; the parsed value is only a fallback for string ids.
    const rawId = /"user_id"\s*:\s*"?(\d+)"?/.exec(raw)?.[1];
    return { accessToken: json.access_token, userId: rawId ?? String(json.user_id) };
  }

  /**
   * Profile lookup for the token's own account via /me - the canonical
   * identity source during onboarding: /me returns the id as a string
   * (unlike the exchange's lossy numeric user_id) plus the username used
   * for display names. Best-effort: returns {} on any failure.
   */
  async getProfile(input: { accessToken: string }): Promise<{ userId?: string; username?: string; name?: string }> {
    const url = new URL(`${this.base()}/me`);
    url.searchParams.set("fields", "id,username,name");
    url.searchParams.set("access_token", input.accessToken);
    const res = await this.fetchFn(url.toString());
    if (!res.ok) return {};
    const json = (await res.json().catch(() => ({}))) as { id?: string | number; username?: string; name?: string };
    return {
      userId: json.id !== undefined ? String(json.id) : undefined,
      username: json.username,
      name: json.name,
    };
  }

  /**
   * Exchange a short-lived (1h) token for a long-lived (60d) one.
   * Onboarding-time helper: the app secret is passed explicitly because no
   * channel account exists yet. The token VALUE is returned to the caller
   * only so it can be written into the vault - never log it.
   */
  async exchangeShortLivedToken(input: {
    shortLivedToken: string;
    appSecret: string;
  }): Promise<{ accessToken: string; expiresAt: string; userId?: string }> {
    const url = new URL(`${this.host}/access_token`);
    url.searchParams.set("grant_type", "th_exchange_token");
    url.searchParams.set("client_secret", input.appSecret);
    url.searchParams.set("access_token", input.shortLivedToken);
    const res = await this.fetchFn(url.toString());
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string; user_id?: string | number; expires_in?: number;
    } & GraphErrorBodyShape;
    if (!res.ok || !json.access_token) throw mapGraphError(json, res.status, "threads");
    return {
      accessToken: json.access_token,
      expiresAt: new Date(Date.now() + (json.expires_in ?? 5184000) * 1000).toISOString(),
      userId: json.user_id !== undefined ? String(json.user_id) : undefined,
    };
  }

  async refreshTokenIfNeeded(
    account: ChannelAccountRef,
  ): Promise<{ refreshed: boolean; expiresAt?: string }> {
    const decision = threadsRefreshDecision({ expiresAt: account.tokenExpiresAt, now: new Date() });
    if (decision.action === "skip") return { refreshed: false };
    const token = await this.tokenFor(account);
    const url = new URL(`${this.host}/refresh_access_token`);
    url.searchParams.set("grant_type", "th_refresh_token");
    url.searchParams.set("access_token", token);
    const res = await this.fetchFn(url.toString());
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string; expires_in?: number;
    } & GraphErrorBodyShape;
    // A failure here for a private profile commonly means the 90-day
    // permission expiry hit - the worker marks the account + alerts.
    if (!res.ok || !json.access_token) throw mapGraphError(json, res.status, "threads");
    return {
      refreshed: true,
      expiresAt: new Date(Date.now() + (json.expires_in ?? 5184000) * 1000).toISOString(),
    };
  }

  // --- HTTP plumbing -----------------------------------------------------------------

  private async graph(
    account: ChannelAccountRef,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const token = await this.tokenFor(account);
    const res = await this.fetchFn(`${this.base()}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as GraphErrorBodyShape & Record<string, unknown>;
    if (!res.ok || json.error) throw mapGraphError(json, res.status, "threads");
    return json;
  }

  // --- messaging: there is NO DM API ------------------------------------------------------

  async send(_input: SendInput): Promise<SendResult> {
    throw new NotImplementedError(
      "threads.send (Threads has NO DM API - direct messages do not exist on this surface; publish/reply are the only outbound paths)",
    );
  }

  // --- publishing ----------------------------------------------------------------------------

  async publish(input: PublishInput): Promise<{ externalPostId: string }> {
    const userId = input.account.externalId;
    const mediaUrl = input.mediaUrls?.[0];
    const isVideo = mediaUrl
      ? input.mediaType === "video" || /\.(mp4|mov)(\?|$)/i.test(mediaUrl)
      : false;

    // One-step fast path: a plain text post (no media, no reply, no quote)
    // can publish directly from container creation with auto_publish_text.
    if (!mediaUrl && !input.replyToExternalId && !input.quoteExternalId) {
      if (!input.text) throw new AppError("VALIDATION", "threads.publish requires text or a media URL");
      const created = await this.graph(input.account, "POST", `${userId}/threads`, {
        media_type: "TEXT",
        text: input.text,
        auto_publish_text: true,
      });
      const postId = created.id as string | undefined;
      if (!postId) {
        throw new ProviderApiError("Threads auto_publish_text returned no id", { provider: "threads", retryable: false });
      }
      return { externalPostId: postId };
    }

    // Two-step container flow for media posts, replies and quotes.
    const containerBody: Record<string, unknown> = {
      media_type: mediaUrl ? (isVideo ? "VIDEO" : "IMAGE") : "TEXT",
      ...(mediaUrl ? (isVideo ? { video_url: mediaUrl } : { image_url: mediaUrl }) : {}),
      ...(input.text ? { text: input.text } : {}),
      ...(input.replyToExternalId ? { reply_to_id: input.replyToExternalId } : {}),
      ...(input.quoteExternalId ? { quote_post_id: input.quoteExternalId } : {}),
    };
    const container = await this.graph(input.account, "POST", `${userId}/threads`, containerBody);
    const creationId = container.id as string | undefined;
    if (!creationId) {
      throw new ProviderApiError("Threads container creation returned no id", { provider: "threads", retryable: false });
    }
    const published = await this.graph(input.account, "POST", `${userId}/threads_publish`, {
      creation_id: creationId,
    });
    const postId = published.id as string | undefined;
    if (!postId) {
      throw new ProviderApiError("Threads threads_publish returned no id", { provider: "threads", retryable: false });
    }
    return { externalPostId: postId };
  }

  // --- moderation --------------------------------------------------------------------------------

  async moderate(input: {
    account: ChannelAccountRef;
    targetExternalId: string;
    action: "hide" | "unhide" | "delete" | "reply";
    text?: string;
  }): Promise<void> {
    switch (input.action) {
      case "hide":
        await this.graph(input.account, "POST", `${input.targetExternalId}/manage_reply`, { hide: true });
        return;
      case "unhide":
        await this.graph(input.account, "POST", `${input.targetExternalId}/manage_reply`, { hide: false });
        return;
      case "delete":
        // Deletes OUR OWN post/reply (threads_delete scope).
        await this.graph(input.account, "DELETE", input.targetExternalId);
        return;
      case "reply": {
        if (!input.text) throw new AppError("VALIDATION", "threads reply requires text");
        await this.publish({
          account: input.account,
          text: input.text,
          replyToExternalId: input.targetExternalId,
          idempotencyKey: `threads-reply:${input.targetExternalId}`,
        });
        return;
      }
    }
  }

  // --- insights + discovery --------------------------------------------------------------------------

  async fetchInsights(input: {
    account: ChannelAccountRef;
    targetExternalId?: string;
  }): Promise<Record<string, number>> {
    // Views family - Threads metrics are views/likes/replies/reposts/quotes.
    const path = input.targetExternalId
      ? `${input.targetExternalId}/insights?metric=views,likes,replies,reposts,quotes`
      : `${input.account.externalId}/threads_insights?metric=views,likes,replies,reposts,quotes,follower_count`;
    const json = await this.graph(input.account, "GET", path);
    const data = (json.data as Array<{
      name: string;
      values?: Array<{ value: number }>;
      total_value?: { value: number };
    }> | undefined) ?? [];
    const out: Record<string, number> = {};
    for (const metric of data) {
      out[metric.name] = metric.total_value?.value ?? metric.values?.[metric.values.length - 1]?.value ?? 0;
    }
    return out;
  }

  /** Keyword search across public Threads posts (threads_keyword_search scope). */
  async searchKeywords(
    account: ChannelAccountRef,
    query: string,
    searchType: "TOP" | "RECENT" = "TOP",
  ): Promise<Array<{ id: string; text?: string; username?: string; permalink?: string }>> {
    const token = await this.tokenFor(account);
    const url = new URL(`${this.base()}/keyword_search`);
    url.searchParams.set("q", query);
    url.searchParams.set("search_type", searchType);
    url.searchParams.set("access_token", token);
    const res = await this.fetchFn(url.toString());
    const json = (await res.json().catch(() => ({}))) as {
      data?: Array<{ id: string; text?: string; username?: string; permalink?: string }>;
    } & GraphErrorBodyShape;
    if (!res.ok || json.error) throw mapGraphError(json, res.status, "threads");
    return json.data ?? [];
  }

  // --- webhooks ------------------------------------------------------------------------------------------

  async parseWebhook(payload: unknown): Promise<InboundEvent[]> {
    const events: InboundEvent[] = [];
    const root = payload as { entry?: Array<Record<string, any>> } | null;
    for (const entry of root?.entry ?? []) {
      const accountExternalId = String(entry.id ?? "");
      for (const change of (entry.changes as Array<Record<string, any>> | undefined) ?? []) {
        const value = (change.value ?? {}) as Record<string, any>;
        const receivedAt = value.timestamp ? isoFromEpochSeconds(value.timestamp) : new Date().toISOString();
        if (change.field === "replies") {
          events.push({
            type: "comment.received",
            channel: "threads",
            accountExternalId,
            postExternalId: String(value.replied_to_id ?? value.root_id ?? value.media_id ?? ""),
            commentExternalId: String(value.id ?? ""),
            text: value.text,
            authorExternalId: value.username ? String(value.username) : undefined,
            receivedAt,
          });
        } else if (change.field === "mentions") {
          events.push({
            type: "mention.received",
            channel: "threads",
            accountExternalId,
            postExternalId: String(value.id ?? value.media_id ?? ""),
            receivedAt,
          });
        }
      }
    }
    return events;
  }
}
