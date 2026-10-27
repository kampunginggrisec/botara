import { AppError, NotImplementedError } from "@botara/shared";
import { mapGraphError, ProviderApiError, type GraphErrorBodyShape } from "./errors";
import { metaAttachmentPayload, metaAttachmentType, uploadMetaAttachment } from "./meta-media";
import {
  CHANNEL_CAPABILITIES, type AdapterHealth, type ChannelAccountRef, type ChannelAdapter,
  type CredentialProvider, type FetchLike, type InboundEvent, type MessageMedia,
  type PublishInput, type SendInput, type SendResult,
} from "./types";
import { richToPlainText, type RichBlock, type RichButton, type RichWarning } from "./rich";

/**
 * Messenger adapter (Fase 2 - real). Facebook Page messaging via the Send
 * API on graph.facebook.com (pinned Graph version), authenticated with a
 * Page access token resolved through the credential provider.
 *
 * Includes the handover protocol (pass/take thread control) so a Botara bot
 * and a human-agent inbox app can share one thread, and messenger-profile
 * setup helpers (Get Started button, persistent menu).
 *
 * Note: this adapter is for Page CONVERSATIONS. Botara's website chat is
 * the self-built webchat widget - Meta's Customer Chat Plugin retired
 * 2024-05-09 with no replacement and is deliberately NOT integrated.
 */

export interface MessengerAdapterOptions {
  credentials: CredentialProvider;
  fetchFn?: FetchLike;
  graphVersion?: string;
  baseUrl?: string;
}

const isoFromEpochMs = (ts: unknown): string =>
  new Date(typeof ts === "number" ? ts : Number(ts)).toISOString();

/**
 * First attachment of a Meta messaging webhook message, normalized.
 * Meta delivers attachments as [{ type, payload: { url } }] - the URL
 * is a self-signed CDN link (fetched without auth by the inbound media
 * pipeline). Attachments without a URL (locations carry coordinates
 * instead) yield no media. Shared shape with Instagram messaging.
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

/** Scopes requested at Facebook Login for Messenger Page onboarding. */
export const MESSENGER_OAUTH_SCOPES = [
  "pages_show_list", "pages_messaging", "pages_manage_metadata", "pages_read_engagement",
] as const;

/** Build the Facebook Login authorize URL for Messenger onboarding. */
export function buildMessengerAuthorizeUrl(input: {
  appId: string;
  redirectUri: string;
  graphVersion?: string;
  state?: string;
}): string {
  const url = new URL(`https://www.facebook.com/${input.graphVersion ?? "v26.0"}/dialog/oauth`);
  url.searchParams.set("client_id", input.appId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", MESSENGER_OAUTH_SCOPES.join(","));
  if (input.state) url.searchParams.set("state", input.state);
  return url.toString();
}

export interface MessengerPageSummary {
  id: string;
  name: string;
  /** Page access token - return to the API layer ONLY so it can be vaulted. */
  accessToken: string;
}

export class MessengerAdapter implements ChannelAdapter {
  readonly key = "messenger" as const;
  readonly apiVersion: string;
  readonly capabilities = CHANNEL_CAPABILITIES.messenger;

  private readonly credentials: CredentialProvider;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;

  constructor(options: MessengerAdapterOptions) {
    this.credentials = options.credentials;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.apiVersion = options.graphVersion ?? "v26.0";
    this.baseUrl = (options.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "");
  }

  // --- account lifecycle -----------------------------------------------------

  async connect(): Promise<ChannelAccountRef> {
    throw new NotImplementedError(
      "messenger.connect (Facebook Login onboarding provisions Page accounts at the API layer)",
    );
  }

  async disconnect(): Promise<void> {
    // Page tokens are revoked app-side; nothing to call here in Fase 2.
  }

  /**
   * OAuth onboarding (API layer): exchange an authorization code for a
   * LONG-LIVED user access token (code -> short-lived -> fb_exchange_token).
   */
  async exchangeCode(input: {
    appId: string;
    appSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<{ userAccessToken: string; expiresAt: string }> {
    const base = `${this.baseUrl}/${this.apiVersion}/oauth/access_token`;
    const shortUrl = new URL(base);
    shortUrl.searchParams.set("client_id", input.appId);
    shortUrl.searchParams.set("client_secret", input.appSecret);
    shortUrl.searchParams.set("redirect_uri", input.redirectUri);
    shortUrl.searchParams.set("code", input.code);
    const shortRes = await this.fetchFn(shortUrl.toString());
    const shortJson = (await shortRes.json().catch(() => ({}))) as { access_token?: string } & GraphErrorBodyShape;
    if (!shortRes.ok || !shortJson.access_token) throw mapGraphError(shortJson, shortRes.status, "messenger");
    const longUrl = new URL(base);
    longUrl.searchParams.set("grant_type", "fb_exchange_token");
    longUrl.searchParams.set("client_id", input.appId);
    longUrl.searchParams.set("client_secret", input.appSecret);
    longUrl.searchParams.set("fb_exchange_token", shortJson.access_token);
    const longRes = await this.fetchFn(longUrl.toString());
    const longJson = (await longRes.json().catch(() => ({}))) as {
      access_token?: string; expires_in?: number;
    } & GraphErrorBodyShape;
    if (!longRes.ok || !longJson.access_token) throw mapGraphError(longJson, longRes.status, "messenger");
    return {
      userAccessToken: longJson.access_token,
      expiresAt: new Date(Date.now() + (longJson.expires_in ?? 5184000) * 1000).toISOString(),
    };
  }

  /** Pages the token's user manages, each with its Page access token. */
  async listPages(userAccessToken: string): Promise<MessengerPageSummary[]> {
    const url = new URL(`${this.baseUrl}/${this.apiVersion}/me/accounts`);
    url.searchParams.set("fields", "id,name,access_token");
    url.searchParams.set("access_token", userAccessToken);
    const res = await this.fetchFn(url.toString());
    const json = (await res.json().catch(() => ({}))) as {
      data?: Array<{ id?: string; name?: string; access_token?: string }>;
    } & GraphErrorBodyShape;
    if (!res.ok) throw mapGraphError(json, res.status, "messenger");
    return (json.data ?? [])
      .filter((p) => p.id && p.access_token)
      .map((p) => ({ id: String(p.id), name: p.name ?? String(p.id), accessToken: p.access_token! }));
  }

  /**
   * Onboarding-time helper (API layer): the Page's public profile picture
   * URL (GET /{page-id}?fields=picture with the Page token) for the
   * Channels account card. Best-effort - null on any failure or when the
   * Page has no picture; a missing avatar never fails a connect.
   */
  async fetchPagePictureUrl(input: { pageId: string; pageAccessToken: string }): Promise<string | null> {
    try {
      const url = new URL(`${this.baseUrl}/${this.apiVersion}/${input.pageId}`);
      url.searchParams.set("fields", "picture");
      url.searchParams.set("access_token", input.pageAccessToken);
      const res = await this.fetchFn(url.toString());
      if (!res.ok) return null;
      const json = (await res.json().catch(() => ({}))) as {
        picture?: { data?: { url?: string } };
      };
      return json.picture?.data?.url ?? null;
    } catch {
      return null;
    }
  }

  async refreshTokenIfNeeded(): Promise<{ refreshed: boolean }> {
    // Page access tokens derived from a long-lived user token do not expire.
    return { refreshed: false };
  }

  async health(account?: ChannelAccountRef): Promise<AdapterHealth> {
    if (!account) return { ok: false, detail: "messenger: an account is required for a health check" };
    const secrets = await this.credentials.resolve(account);
    return secrets.accessToken
      ? { ok: true, detail: `messenger adapter ready (Graph ${this.apiVersion})` }
      : { ok: false, detail: "messenger: no Page access token resolvable for this account (vault/env)" };
  }

  // --- HTTP plumbing -----------------------------------------------------------

  private async tokenFor(account: ChannelAccountRef): Promise<string> {
    const secrets = await this.credentials.resolve(account);
    if (!secrets.accessToken) {
      throw new AppError(
        "CONFIGURATION",
        "Messenger Page access token is not configured for this account (credential provider returned none)",
        { status: 503 },
      );
    }
    return secrets.accessToken;
  }

  private async graph(
    account: ChannelAccountRef,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const token = await this.tokenFor(account);
    const res = await this.fetchFn(`${this.baseUrl}/${this.apiVersion}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as GraphErrorBodyShape & Record<string, unknown>;
    if (!res.ok || json.error) throw mapGraphError(json, res.status, "messenger");
    return json;
  }

  // --- sending ---------------------------------------------------------------------

  async send(input: SendInput): Promise<SendResult> {
    if (input.rich) return this.sendRich(input, input.rich);
    let message: Record<string, unknown>;
    if (input.media && (input.media.id || input.media.link || input.media.url)) {
      // A caption is not part of a Send API attachment: Meta renders
      // media-only bubbles, so the caption goes out as its own text
      // message FIRST (a failed text send aborts before the attachment
      // leaves, which is the only ordering that cannot lose the words).
      if (input.media.caption) {
        await this.graph(input.account, "POST", "me/messages", {
          recipient: { id: input.toExternalId },
          messaging_type: "RESPONSE",
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
        "messenger.send requires text, an uploaded attachment id, or media with a public link",
      );
    }
    if (input.replyToExternalId) message.reply_to = { mid: input.replyToExternalId };
    const json = await this.graph(input.account, "POST", "me/messages", {
      recipient: { id: input.toExternalId },
      messaging_type: "RESPONSE",
      message,
    });
    const messageId = json.message_id as string | undefined;
    if (!messageId) {
      throw new ProviderApiError("Messenger send returned no message id", { provider: "messenger", retryable: false });
    }
    return { externalMessageId: messageId, status: "sent" };
  }

  /**
   * Upload bytes once, get a REUSABLE attachment id (M-1).
   *
   * The id is what `send({ media: { id } })` takes, and it is the reason
   * Messenger media no longer needs a publicly hosted URL: Meta holds the
   * bytes. The endpoint owner is the Page itself.
   */
  async uploadAttachment(
    account: ChannelAccountRef,
    input: { data: Uint8Array; type?: "image" | "video" | "audio" | "file"; filename?: string; mimeType?: string },
  ): Promise<{ attachmentId: string }> {
    const attachmentId = await uploadMetaAttachment(this.fetchFn, {
      endpointBase: `${this.baseUrl}/${this.apiVersion}`,
      accessToken: await this.tokenFor(account),
      ownerId: account.externalId,
      provider: "messenger",
      data: input.data,
      type: input.type ?? "file",
      ...(input.filename ? { filename: input.filename } : {}),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    });
    return { attachmentId };
  }

  /** Map a rich button onto a Messenger template button. */
  private templateButton(button: RichButton): Record<string, unknown> {
    return button.type === "url"
      ? { type: "web_url", title: button.title, url: button.url }
      : { type: "postback", title: button.title, payload: button.payload };
  }

  /**
   * Rich-block renderer (Send API templates). Native: button template
   * (<= 3 buttons), quick replies on text (for larger reply/postback sets),
   * and the generic template for carousels. Lists (Meta retired the list
   * template), product and catalog blocks degrade to formatted text with a
   * typed warning.
   */
  private async sendRich(input: SendInput, rich: RichBlock): Promise<SendResult> {
    const warnings: RichWarning[] = [];
    let message: Record<string, unknown> | null = null;

    if (rich.kind === "buttons") {
      if (rich.buttons.length <= 3) {
        message = {
          attachment: {
            type: "template",
            payload: {
              template_type: "button",
              text: rich.text,
              buttons: rich.buttons.map((b) => this.templateButton(b)),
            },
          },
        };
      } else {
        const tappable = rich.buttons.filter((b) => b.type !== "url");
        if (tappable.length > 0) {
          if (tappable.length < rich.buttons.length) warnings.push("RICH_URL_BUTTONS_DROPPED");
          message = {
            text: rich.text,
            quick_replies: tappable.slice(0, 13).map((b) => ({
              content_type: "text",
              title: b.title.slice(0, 20),
              payload: b.payload,
            })),
          };
          if (tappable.length > 13) warnings.push("RICH_BUTTONS_TRUNCATED");
        } else {
          warnings.push("RICH_BUTTONS_TRUNCATED");
          message = {
            attachment: {
              type: "template",
              payload: {
                template_type: "button",
                text: rich.text,
                buttons: rich.buttons.slice(0, 3).map((b) => this.templateButton(b)),
              },
            },
          };
        }
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
                ? { buttons: card.buttons.slice(0, 3).map((b) => this.templateButton(b)) }
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
    const json = await this.graph(input.account, "POST", "me/messages", {
      recipient: { id: input.toExternalId },
      messaging_type: "RESPONSE",
      message,
    });
    const messageId = json.message_id as string | undefined;
    if (!messageId) {
      throw new ProviderApiError("Messenger send returned no message id", { provider: "messenger", retryable: false });
    }
    return { externalMessageId: messageId, status: "sent", ...(warnings.length > 0 ? { warnings } : {}) };
  }

  /**
   * Private reply to a comment: exactly ONE DM per comment, sent through
   * the Send API with the comment id as the recipient (the comment author
   * receives it as a private message). Distinct from a public reply - see
   * moderate "reply".
   */
  async privateReplyToComment(
    account: ChannelAccountRef,
    commentExternalId: string,
    text: string,
  ): Promise<{ externalMessageId: string }> {
    const json = await this.graph(account, "POST", "me/messages", {
      recipient: { comment_id: commentExternalId },
      messaging_type: "RESPONSE",
      message: { text },
    });
    return { externalMessageId: String(json.message_id ?? "") };
  }

  // --- presence (read receipts + typing) -------------------------------------

  /**
   * Send API sender actions. They must be their OWN request - Meta
   * rejects a payload that carries both `sender_action` and `message`.
   */
  private async senderAction(
    account: ChannelAccountRef,
    psid: string,
    action: "mark_seen" | "typing_on" | "typing_off",
  ): Promise<void> {
    await this.graph(account, "POST", "me/messages", {
      recipient: { id: psid },
      sender_action: action,
    });
  }

  /**
   * Messenger has no per-message read receipt: `mark_seen` marks the
   * whole thread seen by the Page, so the customer id (PSID) is what
   * addresses it and the message id is unused.
   */
  async markRead(input: {
    account: ChannelAccountRef;
    contactExternalId: string;
    messageExternalId?: string;
  }): Promise<void> {
    if (!input.contactExternalId) {
      throw new AppError("VALIDATION", "messenger.markRead requires the customer PSID (contactExternalId).");
    }
    await this.senderAction(input.account, input.contactExternalId, "mark_seen");
  }

  /** Typing on/off for a thread (typing_off is a real request here). */
  async typing(input: { account: ChannelAccountRef; toExternalId: string; on: boolean }): Promise<void> {
    await this.senderAction(input.account, input.toExternalId, input.on ? "typing_on" : "typing_off");
  }

  // --- handover protocol -----------------------------------------------------------------

  /** Hand the thread to another app (e.g. the Page inbox / a human-agent app). */
  async passThreadControl(
    account: ChannelAccountRef,
    psid: string,
    input: { targetAppId: number | string; metadata?: string },
  ): Promise<void> {
    await this.graph(account, "POST", "me/pass_thread_control", {
      recipient: { id: psid },
      target_app_id: input.targetAppId,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  }

  /** Take the thread back from the secondary receiver. */
  async takeThreadControl(
    account: ChannelAccountRef,
    psid: string,
    input: { metadata?: string } = {},
  ): Promise<void> {
    await this.graph(account, "POST", "me/take_thread_control", {
      recipient: { id: psid },
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  }

  // --- messenger profile setup ---------------------------------------------------------

  /** Get Started button shown to first-time users (payload arrives as a postback). */
  async setGetStarted(account: ChannelAccountRef, payload: string): Promise<void> {
    await this.graph(account, "POST", "me/messenger_profile", {
      get_started: { payload },
    });
  }

  /** Persistent menu (composer-level navigation). Items are postback or web_url entries. */
  async setPersistentMenu(
    account: ChannelAccountRef,
    items: Array<Record<string, unknown>>,
    input: { locale?: string; composerInputDisabled?: boolean } = {},
  ): Promise<void> {
    await this.graph(account, "POST", "me/messenger_profile", {
      persistent_menu: [{
        locale: input.locale ?? "default",
        composer_input_disabled: input.composerInputDisabled ?? false,
        call_to_actions: items,
      }],
    });
  }

  /**
   * Messaging profile as a capability (IG-2 parity). `setGetStarted` and
   * `setPersistentMenu` above are the focused setters Botara used before the
   * panel existed; this is the same endpoint addressed generically so the
   * API can read, replace and delete profile fields for a Page the same way
   * it does for an Instagram account.
   *
   * Messenger addresses the profile as `me` (the token identifies the Page);
   * Instagram must use its user id. No `platform` tag here: on Messenger it
   * is meaningless, on Instagram it is what keeps the write off a linked Page.
   */
  readonly messengerProfile: NonNullable<ChannelAdapter["messengerProfile"]> = {
    get: async ({ account, fields }) => {
      const query = new URLSearchParams({ fields: fields.join(",") });
      return this.graph(account, "GET", `me/messenger_profile?${query.toString()}`);
    },

    set: async ({ account, profile }) => {
      const body: Record<string, unknown> = {};
      if (profile.persistentMenu) {
        body.persistent_menu = [{
          locale: profile.persistentMenu.locale ?? "default",
          composer_input_disabled: profile.persistentMenu.composerInputDisabled ?? false,
          call_to_actions: profile.persistentMenu.items,
        }];
      }
      if (profile.iceBreakers) body.ice_breakers = profile.iceBreakers;
      if (profile.getStarted) body.get_started = { payload: profile.getStarted };
      await this.graph(account, "POST", "me/messenger_profile", body);
    },

    remove: async ({ account, fields }) => {
      const query = new URLSearchParams({ fields: JSON.stringify(fields) });
      await this.graph(account, "DELETE", `me/messenger_profile?${query.toString()}`);
    },
  };

  // --- page posts + comment moderation -----------------------------------------------------

  /** Publish a post to the Page feed (the Messenger account IS a Page). */
  async publish(input: PublishInput): Promise<{ externalPostId: string }> {
    const pageId = input.account.externalId;
    const json = await this.graph(input.account, "POST", `${pageId}/feed`, {
      ...(input.text ? { message: input.text } : {}),
      ...(input.mediaUrls?.[0] ? { link: input.mediaUrls[0] } : {}),
    });
    const postId = json.id as string | undefined;
    if (!postId) {
      throw new ProviderApiError("Messenger page post returned no id", { provider: "messenger", retryable: false });
    }
    return { externalPostId: postId };
  }

  async moderate(input: {
    account: ChannelAccountRef;
    targetExternalId: string;
    action: "hide" | "unhide" | "delete" | "reply";
    text?: string;
  }): Promise<void> {
    const commentId = input.targetExternalId;
    switch (input.action) {
      case "hide":
        await this.graph(input.account, "POST", commentId, { is_hidden: true });
        return;
      case "unhide":
        await this.graph(input.account, "POST", commentId, { is_hidden: false });
        return;
      case "delete":
        await this.graph(input.account, "DELETE", commentId);
        return;
      case "reply": {
        if (!input.text) throw new AppError("VALIDATION", "messenger comment reply requires text");
        await this.graph(input.account, "POST", `${commentId}/comments`, { message: input.text });
        return;
      }
    }
  }

  async fetchInsights(input: {
    account: ChannelAccountRef;
    targetExternalId?: string;
  }): Promise<Record<string, number>> {
    // Views family only, same retirement rule as Instagram.
    // NOTE: `page_post_views` is NOT a Page Insights metric (Meta's set is
    // page_views_total / page_post_engagements / page_posts_impressions …);
    // requesting it answered 400 "invalid metric". `page_post_engagements`
    // is the post-interaction counter that survives the impressions
    // retirement.
    const target = input.targetExternalId ?? input.account.externalId;
    const json = await this.graph(
      input.account, "GET",
      `${target}/insights?metric=page_views_total,page_post_engagements&period=day`,
    );
    const data = (json.data as Array<{ name: string; values?: Array<{ value: number }> }> | undefined) ?? [];
    const out: Record<string, number> = {};
    for (const metric of data) out[metric.name] = metric.values?.[metric.values.length - 1]?.value ?? 0;
    return out;
  }

  // --- webhooks --------------------------------------------------------------------------------

  async parseWebhook(payload: unknown): Promise<InboundEvent[]> {
    const events: InboundEvent[] = [];
    const root = payload as { entry?: Array<Record<string, any>> } | null;
    for (const entry of root?.entry ?? []) {
      const accountExternalId = String(entry.id ?? "");
      for (const item of (entry.messaging as Array<Record<string, any>> | undefined) ?? []) {
        const contactExternalId = String(item.sender?.id ?? "");
        const receivedAt = isoFromEpochMs(item.timestamp ?? Date.now());
        if (item.message?.mid) {
          events.push({
            type: "message.received",
            channel: "messenger",
            accountExternalId,
            contactExternalId,
            messageExternalId: String(item.message.mid),
            text: item.message.text,
            ...metaAttachmentMedia(item.message.attachments),
            receivedAt,
          });
        } else if (item.postback) {
          events.push({
            type: "postback.received",
            channel: "messenger",
            accountExternalId,
            contactExternalId,
            payload: String(item.postback.payload ?? ""),
            title: item.postback.title,
            receivedAt,
          });
          // m.me links with ?ref= deliver the ref INSIDE the Get Started /
          // CTA postback - surface it as a referral event for growth
          // attribution alongside the postback itself.
          if (item.postback.referral?.ref) {
            events.push({
              type: "referral.received",
              channel: "messenger",
              accountExternalId,
              contactExternalId,
              ref: String(item.postback.referral.ref),
              source: item.postback.referral.source,
              receivedAt,
            });
          }
        } else if (item.referral) {
          events.push({
            type: "referral.received",
            channel: "messenger",
            accountExternalId,
            contactExternalId,
            ref: item.referral.ref,
            source: item.referral.source,
            receivedAt,
          });
        }
      }
      // Page feed changes: comments on Page posts (comment automation
      // input). Only NEW comments (verb "add", item "comment") become
      // comment.received; edits/removals and other feed items are ignored.
      for (const change of (entry.changes as Array<Record<string, any>> | undefined) ?? []) {
        const value = (change.value ?? {}) as Record<string, any>;
        if (change.field !== "feed" || value.item !== "comment" || (value.verb && value.verb !== "add")) continue;
        if (!value.comment_id) continue;
        events.push({
          type: "comment.received",
          channel: "messenger",
          accountExternalId,
          postExternalId: String(value.post_id ?? ""),
          commentExternalId: String(value.comment_id),
          text: typeof value.message === "string" ? value.message : undefined,
          authorExternalId: value.from?.id !== undefined ? String(value.from.id) : undefined,
          receivedAt: value.created_time
            ? new Date(Number(value.created_time) * 1000).toISOString()
            : new Date().toISOString(),
        });
      }
    }
    return events;
  }
}
