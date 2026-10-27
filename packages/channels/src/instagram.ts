import { AppError, NotImplementedError } from "@botara/shared";
import { mapGraphError, ProviderApiError, type GraphErrorBodyShape } from "./errors";
import { metaAttachmentPayload, metaAttachmentType, uploadMetaAttachment } from "./meta-media";
import { evaluateLongLivedRefresh } from "./token-lifecycle";
import {
  CHANNEL_CAPABILITIES, type AdapterHealth, type ChannelAccountRef, type ChannelAdapter,
  type CredentialProvider, type FetchLike, type InboundEvent, type MessageMedia,
  type PublishInput, type SendInput, type SendResult, type WelcomeMessageFlow,
} from "./types";
import { richToPlainText, type RichBlock, type RichWarning } from "./rich";

/**
 * Instagram adapter (Fase 2 - real). ONE adapter, two auth modes, selected
 * per account from channel_accounts.auth_mode:
 *
 * - "instagram-login" (default): host graph.instagram.com, no Facebook Page
 *   required, scopes are the instagram_business_* set.
 * - "facebook-login": host graph.facebook.com (pinned Graph version), the
 *   account is an IG professional account linked to a Page, scopes are the
 *   instagram_* set (adds hashtag search / product tagging).
 *
 * Professional (Business/Creator) accounts only - the Basic Display API
 * retired 2024-12-04. Publishing is two-step (create container, then
 * media_publish) and Meta fetches media from a PUBLIC https URL; there is no
 * file upload. Insights use the Views metric family only - the legacy
 * reach/impression metric names were retired in June 2026 and are never sent.
 */

export type InstagramAuthMode = "instagram-login" | "facebook-login";

/** Canonical scope list for Instagram Login. */
export const INSTAGRAM_LOGIN_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_comments",
  "instagram_business_manage_messages",
  "instagram_business_manage_insights",
] as const;

/** Canonical scope list for Facebook Login for Business (IG via linked Page). */
export const FACEBOOK_LOGIN_SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
  "instagram_manage_messages",
  "instagram_manage_insights",
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
] as const;

export interface InstagramAdapterOptions {
  credentials: CredentialProvider;
  fetchFn?: FetchLike;
  /** Pinned Graph version for the facebook-login host (default v26.0). */
  graphVersion?: string;
  instagramHost?: string;
  facebookHost?: string;
  /**
   * Video container polling bounds (Fase 3): a REELS container must reach
   * status FINISHED before media_publish. Polling is bounded - attempts x
   * delay - and the sleep is injectable so tests never wait in real time.
   */
  containerPoll?: {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  };
}

export function instagramModeOf(account: ChannelAccountRef): InstagramAuthMode {
  return account.authMode === "facebook-login" ? "facebook-login" : "instagram-login";
}

/**
 * Build the OAuth authorize URL for onboarding.
 *
 * TRAP (encoded on purpose): with Instagram Login, passing a `scope`
 * parameter REPLACES the app's default scopes entirely - a partial list
 * silently drops permissions the app later needs. This builder therefore
 * ALWAYS sends the full canonical list for the mode and ignores any subset
 * the caller asks for.
 */
export function buildInstagramAuthorizeUrl(input: {
  mode: InstagramAuthMode;
  appId: string;
  redirectUri: string;
  graphVersion?: string;
  state?: string;
  /** Ignored on purpose - see the trap note above. */
  requestedScopes?: string[];
}): string {
  const version = input.graphVersion ?? "v26.0";
  if (input.mode === "facebook-login") {
    const url = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
    url.searchParams.set("client_id", input.appId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", FACEBOOK_LOGIN_SCOPES.join(","));
    if (input.state) url.searchParams.set("state", input.state);
    return url.toString();
  }
  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", input.appId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", INSTAGRAM_LOGIN_SCOPES.join(","));
  if (input.state) url.searchParams.set("state", input.state);
  return url.toString();
}

const isoFromEpochSeconds = (ts: unknown): string =>
  new Date((typeof ts === "string" ? Number(ts) : (ts as number)) * 1000).toISOString();

/**
 * First attachment of a Meta messaging webhook message, normalized
 * (same shape as Messenger's - see messenger.ts): attachments arrive
 * as [{ type, payload: { url } }] with a self-signed CDN URL.
 */
function metaAttachmentMedia(attachments: unknown): { media: MessageMedia } | Record<string, never> {
  const first = Array.isArray(attachments) ? (attachments[0] as Record<string, any> | undefined) : undefined;
  const url = first?.payload?.url;
  if (!first || typeof url !== "string" || !url) return {};
  const type = first.type === "image" ? "image"
    : first.type === "video" ? "video"
    : first.type === "audio" ? "audio"
    : first.type === "file" ? "document"
    : "unknown";
  return { media: { type, url } };
}

export class InstagramAdapter implements ChannelAdapter {
  readonly key = "instagram" as const;
  readonly apiVersion: string;
  readonly capabilities = CHANNEL_CAPABILITIES.instagram;

  private readonly credentials: CredentialProvider;
  private readonly fetchFn: FetchLike;
  private readonly instagramHost: string;
  private readonly facebookHost: string;
  private readonly pollAttempts: number;
  private readonly pollDelayMs: number;
  private readonly pollSleep: (ms: number) => Promise<void>;

  constructor(options: InstagramAdapterOptions) {
    this.credentials = options.credentials;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.apiVersion = options.graphVersion ?? "v26.0";
    this.instagramHost = (options.instagramHost ?? "https://graph.instagram.com").replace(/\/$/, "");
    this.facebookHost = (options.facebookHost ?? "https://graph.facebook.com").replace(/\/$/, "");
    this.pollAttempts = options.containerPoll?.attempts ?? 10;
    this.pollDelayMs = options.containerPoll?.delayMs ?? 3000;
    this.pollSleep = options.containerPoll?.sleep
      ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Mode-correct API base for an account (host selection is THE dual-mode rule). */
  baseFor(account: ChannelAccountRef): string {
    return instagramModeOf(account) === "facebook-login"
      ? `${this.facebookHost}/${this.apiVersion}`
      : this.instagramHost;
  }

  // --- account lifecycle ---------------------------------------------------

  async connect(): Promise<ChannelAccountRef> {
    throw new NotImplementedError(
      "instagram.connect (OAuth onboarding lives at the API layer; use buildInstagramAuthorizeUrl + exchangeCode)",
    );
  }

  async disconnect(): Promise<void> {
    // The credential lives in the vault; revocation is an app-side action.
  }

  async health(account?: ChannelAccountRef): Promise<AdapterHealth> {
    if (!account) return { ok: false, detail: "instagram: an account is required for a health check" };
    const secrets = await this.credentials.resolve(account);
    const mode = instagramModeOf(account);
    return secrets.accessToken
      ? { ok: true, detail: `instagram adapter ready (mode: ${mode}, host: ${mode === "facebook-login" ? "graph.facebook.com" : "graph.instagram.com"})` }
      : { ok: false, detail: "instagram: no access token resolvable for this account (vault/env)" };
  }

  // --- token lifecycle -------------------------------------------------------

  private async tokenFor(account: ChannelAccountRef): Promise<string> {
    const secrets = await this.credentials.resolve(account);
    if (!secrets.accessToken) {
      throw new AppError(
        "CONFIGURATION",
        "Instagram access token is not configured for this account (credential provider returned none)",
        { status: 503 },
      );
    }
    return secrets.accessToken;
  }

  /**
   * Exchange an OAuth code for a long-lived token. Onboarding-time helper
   * used by the API layer (app credentials are passed explicitly because no
   * channel account - and therefore no vault ref - exists yet).
   */
  async exchangeCode(input: {
    mode: InstagramAuthMode;
    appId: string;
    appSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<{ accessToken: string; expiresAt: string; externalUserId?: string }> {
    if (input.mode === "instagram-login") {
      // Step 1: code -> short-lived token + user id (form-encoded POST).
      const form = new URLSearchParams({
        client_id: input.appId,
        client_secret: input.appSecret,
        grant_type: "authorization_code",
        redirect_uri: input.redirectUri,
        code: input.code,
      });
      const shortRes = await this.fetchFn("https://api.instagram.com/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      const shortJson = (await shortRes.json().catch(() => ({}))) as {
        access_token?: string; user_id?: number | string; error_message?: string;
      } & GraphErrorBodyShape;
      if (!shortRes.ok || !shortJson.access_token) {
        throw mapGraphError(shortJson, shortRes.status, "instagram");
      }
      // Step 2: short-lived -> long-lived (60 days).
      const longUrl = new URL(`${this.instagramHost}/access_token`);
      longUrl.searchParams.set("grant_type", "ig_exchange_token");
      longUrl.searchParams.set("client_secret", input.appSecret);
      longUrl.searchParams.set("access_token", shortJson.access_token);
      const longRes = await this.fetchFn(longUrl.toString());
      const longJson = (await longRes.json().catch(() => ({}))) as {
        access_token?: string; expires_in?: number;
      } & GraphErrorBodyShape;
      if (!longRes.ok || !longJson.access_token) {
        throw mapGraphError(longJson, longRes.status, "instagram");
      }
      return {
        accessToken: longJson.access_token,
        expiresAt: new Date(Date.now() + (longJson.expires_in ?? 5184000) * 1000).toISOString(),
        externalUserId: shortJson.user_id !== undefined ? String(shortJson.user_id) : undefined,
      };
    }
    // facebook-login: code -> short-lived -> long-lived user token.
    const shortUrl = new URL(`${this.facebookHost}/${this.apiVersion}/oauth/access_token`);
    shortUrl.searchParams.set("client_id", input.appId);
    shortUrl.searchParams.set("client_secret", input.appSecret);
    shortUrl.searchParams.set("redirect_uri", input.redirectUri);
    shortUrl.searchParams.set("code", input.code);
    const shortRes = await this.fetchFn(shortUrl.toString());
    const shortJson = (await shortRes.json().catch(() => ({}))) as { access_token?: string } & GraphErrorBodyShape;
    if (!shortRes.ok || !shortJson.access_token) throw mapGraphError(shortJson, shortRes.status, "instagram");
    const longUrl = new URL(`${this.facebookHost}/${this.apiVersion}/oauth/access_token`);
    longUrl.searchParams.set("grant_type", "fb_exchange_token");
    longUrl.searchParams.set("client_id", input.appId);
    longUrl.searchParams.set("client_secret", input.appSecret);
    longUrl.searchParams.set("fb_exchange_token", shortJson.access_token);
    const longRes = await this.fetchFn(longUrl.toString());
    const longJson = (await longRes.json().catch(() => ({}))) as {
      access_token?: string; expires_in?: number;
    } & GraphErrorBodyShape;
    if (!longRes.ok || !longJson.access_token) throw mapGraphError(longJson, longRes.status, "instagram");
    return {
      accessToken: longJson.access_token,
      expiresAt: new Date(Date.now() + (longJson.expires_in ?? 5184000) * 1000).toISOString(),
    };
  }

  async refreshTokenIfNeeded(
    account: ChannelAccountRef,
  ): Promise<{ refreshed: boolean; expiresAt?: string }> {
    if (instagramModeOf(account) === "facebook-login") {
      // Facebook-Login long-lived USER tokens cannot be refreshed through an
      // API call - the user must re-authenticate. Page tokens derived from a
      // long-lived user token do not expire, so nothing rotates on schedule.
      return { refreshed: false };
    }
    const decision = evaluateLongLivedRefresh({ expiresAt: account.tokenExpiresAt, now: new Date() });
    if (decision.action === "skip") return { refreshed: false };
    const token = await this.tokenFor(account);
    const url = new URL(`${this.instagramHost}/refresh_access_token`);
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", token);
    const res = await this.fetchFn(url.toString());
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string; expires_in?: number;
    } & GraphErrorBodyShape;
    if (!res.ok || !json.access_token) throw mapGraphError(json, res.status, "instagram");
    return {
      refreshed: true,
      expiresAt: new Date(Date.now() + (json.expires_in ?? 5184000) * 1000).toISOString(),
    };
  }

  // --- HTTP plumbing ---------------------------------------------------------

  private async graph(
    account: ChannelAccountRef,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const token = await this.tokenFor(account);
    const res = await this.fetchFn(`${this.baseFor(account)}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as GraphErrorBodyShape & Record<string, unknown>;
    if (!res.ok || json.error) throw mapGraphError(json, res.status, "instagram");
    return json;
  }

  // --- messaging ---------------------------------------------------------------

  async send(input: SendInput): Promise<SendResult> {
    if (input.rich) return this.sendRich(input, input.rich);
    const igUserId = input.account.externalId;
    let message: Record<string, unknown>;
    if (input.media && (input.media.id || input.media.link || input.media.url)) {
      // Same rule as Messenger: an IG attachment has no caption field, so
      // a caption is a separate text message sent first.
      if (input.media.caption) {
        await this.graph(input.account, "POST", `${igUserId}/messages`, {
          recipient: { id: input.toExternalId },
          message: { text: input.media.caption },
        });
      }
      message = {
        attachment: {
          type: metaAttachmentType(input.media.type),
          payload: metaAttachmentPayload(input.media),
        },
      };
    } else if (input.text !== undefined) {
      message = { text: input.text };
    } else {
      throw new AppError(
        "VALIDATION",
        "instagram.send requires text, an uploaded attachment id, or media with a public link",
      );
    }
    if (input.replyToExternalId) message.reply_to = { mid: input.replyToExternalId };
    const json = await this.graph(input.account, "POST", `${igUserId}/messages`, {
      recipient: { id: input.toExternalId },
      message,
    });
    const messageId = json.message_id as string | undefined;
    if (!messageId) {
      throw new ProviderApiError("Instagram send returned no message id", { provider: "instagram", retryable: false });
    }
    return { externalMessageId: messageId, status: "sent" };
  }

  /**
   * Upload bytes once, get a REUSABLE attachment id (M-1 parity with
   * Messenger). The endpoint owner is the IG user, and the host follows
   * the account's auth mode - the same `baseFor` every other call uses.
   */
  async uploadAttachment(
    account: ChannelAccountRef,
    input: { data: Uint8Array; type?: "image" | "video" | "audio" | "file"; filename?: string; mimeType?: string },
  ): Promise<{ attachmentId: string }> {
    const attachmentId = await uploadMetaAttachment(this.fetchFn, {
      endpointBase: this.baseFor(account),
      accessToken: await this.tokenFor(account),
      ownerId: account.externalId,
      provider: "instagram",
      data: input.data,
      type: input.type ?? "file",
      ...(input.filename ? { filename: input.filename } : {}),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    });
    return { attachmentId };
  }

  /**
   * Rich-block renderer (Send API on the mode-correct host). Native:
   * carousel as a generic template, buttons as quick replies on the text.
   * Quick replies cannot open URLs - url buttons are dropped with a typed
   * warning, and a buttons block made ONLY of url buttons degrades to
   * formatted text. Lists / products / catalogs have no IG message surface
   * and degrade to text as well.
   */
  private async sendRich(input: SendInput, rich: RichBlock): Promise<SendResult> {
    const igUserId = input.account.externalId;
    const warnings: RichWarning[] = [];
    let message: Record<string, unknown> | null = null;

    if (rich.kind === "buttons") {
      const tappable = rich.buttons.filter((b) => b.type !== "url");
      if (tappable.length > 0) {
        if (tappable.length < rich.buttons.length) warnings.push("RICH_URL_BUTTONS_DROPPED");
        if (tappable.length > 13) warnings.push("RICH_BUTTONS_TRUNCATED");
        message = {
          text: rich.text,
          quick_replies: tappable.slice(0, 13).map((b) => ({
            content_type: "text",
            title: b.title.slice(0, 20),
            payload: b.payload,
          })),
        };
      }
    } else if (rich.kind === "carousel") {
      message = {
        attachment: {
          type: "template",
          payload: {
            template_type: "generic",
            elements: rich.cards.map((card) => ({
              title: card.title,
              ...(card.subtitle ? { subtitle: card.subtitle } : {}),
              ...(card.imageUrl ? { image_url: card.imageUrl } : {}),
              ...(card.buttons && card.buttons.length > 0
                ? {
                    buttons: card.buttons.slice(0, 3).map((b) => b.type === "url"
                      ? { type: "web_url", title: b.title, url: b.url }
                      : { type: "postback", title: b.title, payload: b.payload }),
                  }
                : {}),
            })),
          },
        },
      };
    }

    if (!message) {
      warnings.push("RICH_DEGRADED_TO_TEXT");
      message = { text: richToPlainText(rich) };
    }
    if (input.replyToExternalId) message.reply_to = { mid: input.replyToExternalId };
    const json = await this.graph(input.account, "POST", `${igUserId}/messages`, {
      recipient: { id: input.toExternalId },
      message,
    });
    const messageId = json.message_id as string | undefined;
    if (!messageId) {
      throw new ProviderApiError("Instagram send returned no message id", { provider: "instagram", retryable: false });
    }
    return { externalMessageId: messageId, status: "sent", ...(warnings.length > 0 ? { warnings } : {}) };
  }

  // --- presence (read receipts + typing) ---------------------------------------

  /**
   * Instagram messaging rides the Messenger Platform surface, so
   * presence is a sender action on the Send API endpoint rather than a
   * separate resource. `mark_seen` marks the thread, not one message.
   */
  private async senderAction(
    account: ChannelAccountRef,
    igsid: string,
    action: "mark_seen" | "typing_on" | "typing_off",
  ): Promise<void> {
    await this.graph(account, "POST", `${account.externalId}/messages`, {
      recipient: { id: igsid },
      sender_action: action,
    });
  }

  async markRead(input: {
    account: ChannelAccountRef;
    contactExternalId: string;
    messageExternalId?: string;
  }): Promise<void> {
    if (!input.contactExternalId) {
      throw new AppError("VALIDATION", "instagram.markRead requires the customer IGSID (contactExternalId).");
    }
    await this.senderAction(input.account, input.contactExternalId, "mark_seen");
  }

  async typing(input: { account: ChannelAccountRef; toExternalId: string; on: boolean }): Promise<void> {
    await this.senderAction(input.account, input.toExternalId, input.on ? "typing_on" : "typing_off");
  }

  /**
   * Private reply to a comment: exactly ONE DM per comment, within 7 days of
   * the comment. (Distinct from a public reply - see moderate "reply".)
   */
  async privateReplyToComment(
    account: ChannelAccountRef,
    commentExternalId: string,
    text: string,
  ): Promise<{ externalMessageId: string }> {
    const json = await this.graph(account, "POST", `${account.externalId}/messages`, {
      recipient: { comment_id: commentExternalId },
      message: { text },
    });
    return { externalMessageId: String(json.message_id ?? "") };
  }

  // --- welcome message flows (IG-1) ------------------------------------------

  /**
   * Welcome message flows: the automated first reply to a brand-new DM
   * thread, stored on the provider (not in Botara's flow engine). A flow is
   * a named array of `{ message: { text, quick_replies? } }`.
   *
   * Listing is bounded (100/page, 5 pages): a big ad account can hold many
   * flows and this feeds a panel dropdown, not a data export.
   */
  readonly welcomeFlows: NonNullable<ChannelAdapter["welcomeFlows"]> = {
    list: async ({ account, limit, maxPages }) => {
      const pageSize = limit ?? 100;
      const pages = maxPages ?? 5;
      const out: WelcomeMessageFlow[] = [];
      let after: string | undefined;
      for (let page = 0; page < pages; page++) {
        const query = new URLSearchParams({ limit: String(pageSize) });
        if (after) query.set("after", after);
        const json = await this.graph(
          account, "GET", `${account.externalId}/welcome_message_flows?${query.toString()}`,
        );
        for (const row of (json.data as Array<Record<string, unknown>> | undefined) ?? []) {
          const normalized = normalizeWelcomeFlow(row);
          if (normalized) out.push(normalized);
        }
        const nextAfter = (json.paging as { cursors?: { after?: string } } | undefined)?.cursors?.after;
        if (!nextAfter) break;
        after = nextAfter;
      }
      return out;
    },

    /**
     * One flow by id. The provider answers with the same `data` envelope as
     * the list (a filter, not a resource read), so an unknown id is an
     * empty list - normalized to null rather than an exception.
     */
    get: async ({ account, flowId }) => {
      const json = await this.graph(
        account, "GET",
        `${account.externalId}/welcome_message_flows?${new URLSearchParams({ flow_id: flowId }).toString()}`,
      );
      const first = ((json.data as Array<Record<string, unknown>> | undefined) ?? [])[0];
      return first ? normalizeWelcomeFlow(first) : null;
    },

    create: async ({ account, name, flow }) => {
      const json = await this.graph(account, "POST", `${account.externalId}/welcome_message_flows`, {
        name,
        // Meta stores the flow as a JSON STRING; sending the array directly
        // is accepted by some versions and silently stringified by others.
        welcome_message_flow: JSON.stringify(flow),
      });
      const id = String(json.id ?? "");
      if (!id) throw new ProviderApiError("Instagram welcome flow create returned no id", { provider: "instagram", retryable: false });
      return { id };
    },

    update: async ({ account, flowId, name, flow }) => {
      const json = await this.graph(
        account, "POST",
        `${account.externalId}/welcome_message_flows?${new URLSearchParams({ flow_id: flowId }).toString()}`,
        { name, welcome_message_flow: JSON.stringify(flow) },
      );
      return { id: String(json.id ?? flowId) };
    },

    remove: async ({ account, flowId }) => {
      await this.graph(
        account, "DELETE",
        `${account.externalId}/welcome_message_flows?${new URLSearchParams({ flow_id: flowId }).toString()}`,
      );
    },
  };

  // --- messaging profile (IG-2) ----------------------------------------------

  /**
   * Persistent menu + ice breakers. The endpoint is the Messenger Platform
   * `messenger_profile`, addressed by the IG user id and tagged
   * `platform: "instagram"` - without that tag the same call would be
   * applied to a linked Page profile instead.
   */
  readonly messengerProfile: NonNullable<ChannelAdapter["messengerProfile"]> = {
    get: async ({ account, fields }) => {
      const query = new URLSearchParams({ fields: fields.join(",") });
      return this.graph(account, "GET", `${account.externalId}/messenger_profile?${query.toString()}`);
    },

    set: async ({ account, profile }) => {
      const body: Record<string, unknown> = { platform: "instagram" };
      if (profile.persistentMenu) {
        body.persistent_menu = [{
          locale: profile.persistentMenu.locale ?? "default",
          composer_input_disabled: profile.persistentMenu.composerInputDisabled ?? false,
          call_to_actions: profile.persistentMenu.items,
        }];
      }
      if (profile.iceBreakers) {
        body.ice_breakers = profile.iceBreakers;
      }
      if (profile.getStarted) {
        body.get_started = { payload: profile.getStarted };
      }
      await this.graph(account, "POST", `${account.externalId}/messenger_profile`, body);
    },

    /**
     * Delete only the named fields. The provider takes `fields` as a
     * JSON-ish list, so each name is quoted; sending a bare comma list
     * deletes nothing and answers success, which is worse than an error.
     */
    remove: async ({ account, fields }) => {
      const query = new URLSearchParams({ fields: JSON.stringify(fields) });
      await this.graph(account, "DELETE", `${account.externalId}/messenger_profile?${query.toString()}`);
    },
  };


  async moderate(input: {
    account: ChannelAccountRef;
    targetExternalId: string;
    action: "hide" | "unhide" | "delete" | "reply";
    text?: string;
  }): Promise<void> {
    const commentId = input.targetExternalId;
    switch (input.action) {
      case "hide":
        await this.graph(input.account, "POST", commentId, { hide: true });
        return;
      case "unhide":
        await this.graph(input.account, "POST", commentId, { hide: false });
        return;
      case "delete":
        await this.graph(input.account, "DELETE", commentId);
        return;
      case "reply": {
        if (!input.text) throw new AppError("VALIDATION", "instagram comment reply requires text");
        await this.graph(input.account, "POST", `${commentId}/replies`, { message: input.text });
        return;
      }
    }
  }

  // --- publishing ----------------------------------------------------------------

  /** Step 1 of publishing: create the media container (image or REELS video). */
  async createMediaContainer(
    account: ChannelAccountRef,
    input: PublishInput,
  ): Promise<{ creationId: string; mediaKind: "image" | "video" }> {
    const mediaUrl = input.mediaUrls?.[0];
    if (!mediaUrl) {
      throw new AppError(
        "VALIDATION",
        "instagram.publish requires a media URL - Instagram has no text-only posts (media is fetched by Meta from a public https URL)",
      );
    }
    const isVideo = input.mediaType === "video" || /\.(mp4|mov)(\?|$)/i.test(mediaUrl);
    const container = await this.graph(account, "POST", `${account.externalId}/media`, {
      ...(isVideo ? { media_type: "REELS", video_url: mediaUrl } : { image_url: mediaUrl }),
      ...(input.text ? { caption: input.text } : {}),
    });
    const creationId = container.id as string | undefined;
    if (!creationId) {
      throw new ProviderApiError("Instagram media container returned no id", { provider: "instagram", retryable: false });
    }
    return { creationId, mediaKind: isVideo ? "video" : "image" };
  }

  /**
   * Container processing status: IN_PROGRESS | FINISHED | ERROR | EXPIRED |
   * PUBLISHED (GET /{creation-id}?fields=status_code). Video containers MUST
   * be FINISHED before media_publish; images are ready immediately.
   */
  async getMediaContainerStatus(account: ChannelAccountRef, creationId: string): Promise<string> {
    const json = await this.graph(account, "GET", `${creationId}?fields=status_code`);
    return typeof json.status_code === "string" ? json.status_code : "UNKNOWN";
  }

  /** Step 2 of publishing: media_publish an existing (FINISHED) container. */
  async publishMediaContainer(
    account: ChannelAccountRef,
    creationId: string,
  ): Promise<{ externalPostId: string }> {
    const published = await this.graph(account, "POST", `${account.externalId}/media_publish`, {
      creation_id: creationId,
    });
    const postId = published.id as string | undefined;
    if (!postId) {
      throw new ProviderApiError("Instagram media_publish returned no id", { provider: "instagram", retryable: false });
    }
    return { externalPostId: postId };
  }

  /**
   * Poll a video container until FINISHED, bounded by the adapter's poll
   * configuration. ERROR/EXPIRED fail non-retryably; exhausting the attempts
   * fails retryably so the worker can requeue the publish job later.
   */
  async waitForContainerFinished(account: ChannelAccountRef, creationId: string): Promise<void> {
    for (let attempt = 1; attempt <= this.pollAttempts; attempt++) {
      const status = await this.getMediaContainerStatus(account, creationId);
      if (status === "FINISHED" || status === "PUBLISHED") return;
      if (status === "ERROR" || status === "EXPIRED") {
        throw new ProviderApiError(
          `Instagram media container ${creationId} failed processing (status ${status})`,
          { provider: "instagram", retryable: false },
        );
      }
      if (attempt < this.pollAttempts) await this.pollSleep(this.pollDelayMs);
    }
    throw new ProviderApiError(
      `Instagram media container ${creationId} was not FINISHED after ${this.pollAttempts} status checks`,
      { provider: "instagram", retryable: true },
    );
  }

  async publish(input: PublishInput): Promise<{ externalPostId: string }> {
    const { creationId, mediaKind } = await this.createMediaContainer(input.account, input);
    // Video/Reels containers process asynchronously - publishing before
    // FINISHED is rejected by Meta, so poll (bounded) first. Images skip this.
    if (mediaKind === "video") {
      await this.waitForContainerFinished(input.account, creationId);
    }
    return this.publishMediaContainer(input.account, creationId);
  }

  // --- insights ---------------------------------------------------------------------

  async fetchInsights(input: {
    account: ChannelAccountRef;
    targetExternalId?: string;
  }): Promise<Record<string, number>> {
    // Views family ONLY. "impressions"/"reach" metric names were retired by
    // Meta in June 2026 - never request them here.
    const isMedia = Boolean(input.targetExternalId);
    const path = isMedia
      ? `${input.targetExternalId}/insights?metric=views,likes,comments,shares,saved`
      : `${input.account.externalId}/insights?metric=views,profile_views&period=day`;
    const json = await this.graph(input.account, "GET", path);
    const data = (json.data as Array<{ name: string; values?: Array<{ value: number }> }> | undefined) ?? [];
    const out: Record<string, number> = {};
    for (const metric of data) {
      out[metric.name] = metric.values?.[metric.values.length - 1]?.value ?? 0;
    }
    return out;
  }

  // --- webhooks -----------------------------------------------------------------------

  async parseWebhook(payload: unknown): Promise<InboundEvent[]> {
    const events: InboundEvent[] = [];
    const root = payload as { entry?: Array<Record<string, any>> } | null;
    for (const entry of root?.entry ?? []) {
      const accountExternalId = String(entry.id ?? "");
      for (const item of (entry.messaging as Array<Record<string, any>> | undefined) ?? []) {
        if (item.message?.mid) {
          events.push({
            type: "message.received",
            channel: "instagram",
            accountExternalId,
            contactExternalId: String(item.sender?.id ?? ""),
            messageExternalId: String(item.message.mid),
            text: item.message.text,
            ...metaAttachmentMedia(item.message.attachments),
            receivedAt: isoFromEpochSeconds(item.timestamp ?? 0),
          });
        }
      }
      for (const change of (entry.changes as Array<Record<string, any>> | undefined) ?? []) {
        const value = (change.value ?? {}) as Record<string, any>;
        if (change.field === "comments") {
          events.push({
            type: "comment.received",
            channel: "instagram",
            accountExternalId,
            postExternalId: String(value.media?.id ?? ""),
            commentExternalId: String(value.id ?? ""),
            text: value.text,
            authorExternalId: value.from?.id !== undefined ? String(value.from.id) : undefined,
            receivedAt: new Date().toISOString(),
          });
        } else if (change.field === "mentions") {
          events.push({
            type: "mention.received",
            channel: "instagram",
            accountExternalId,
            postExternalId: String(value.media_id ?? ""),
            commentExternalId: value.comment_id !== undefined ? String(value.comment_id) : undefined,
            receivedAt: new Date().toISOString(),
          });
        }
      }
    }
    return events;
  }
}

/**
 * Normalize one provider welcome-flow row.
 *
 * `welcome_message_flow` arrives as a JSON STRING (that is how the API
 * stores it) - parsing is best-effort: a row whose body is unparseable
 * still lists (so the panel can show and delete it) but exposes an empty
 * flow rather than crashing the whole list.
 */
function normalizeWelcomeFlow(row: Record<string, unknown>): WelcomeMessageFlow | null {
  const id = String(row.id ?? "");
  const name = typeof row.name === "string" ? row.name : "";
  if (!id || !name) return null;
  const raw = row.welcome_message_flow;
  let flow: unknown[] = [];
  if (Array.isArray(raw)) {
    flow = raw;
  } else if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) flow = parsed;
    } catch { /* keep the empty flow: the row is still listable and deletable */ }
  }
  return {
    id,
    name,
    flow,
    ...(typeof row.last_update_time === "string" ? { lastUpdateTime: row.last_update_time } : {}),
    ...(typeof row.is_used_in_ad === "boolean" ? { isUsedInAd: row.is_used_in_ad } : {}),
  };
}
