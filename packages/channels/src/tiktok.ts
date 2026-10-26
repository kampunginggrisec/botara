import { createHmac, timingSafeEqual } from "node:crypto";
import {
  AppError, ConversationAddressMissingError, NotImplementedError,
} from "@botara/shared";
import { ProviderApiError, ProviderAuthError, ProviderRateLimitError } from "./errors";
import { evaluateShortLivedRefresh } from "./token-lifecycle";
import {
  CHANNEL_CAPABILITIES, type AdapterHealth, type ChannelAccountRef, type ChannelAdapter,
  type CredentialProvider, type FetchLike, type InboundEvent, type MessageMedia,
  type SendInput, type SendResult,
} from "./types";
import { richToPlainText, type RichBlock, type RichWarning } from "./rich";

/**
 * TikTok adapter (Business Messaging API v1.3, Open Beta).
 *
 * EVIDENCE BASIS (2026-10-26 research, docs/tiktok.md has the full list):
 * TikTok's own Business Messaging reference is partner-gated, so endpoint
 * shapes here rest on official-doc text reproduced verbatim in the TikTok
 * Business SDK packages (chiefly github.com/bububa/tiktok-business) plus
 * consistent partner documentation. Items that could NOT be verified are
 * implemented defensively and flagged inline:
 *
 * - The full webhook event catalogue + payload envelopes are unverified:
 *   parseWebhook tolerates several envelope shapes, handles the one
 *   CONFIRMED event (`im_receive_high_intent_comment`) plus DM messages in
 *   the content-list shape, and ignores everything else.
 * - The webhook SIGNATURE scheme is unverified: verifyTikTokWebhookSignature
 *   is a clearly-marked HMAC placeholder (see its comment).
 * - The refresh-token lifetime is unresolved (~30d vs ~365d in public
 *   sources): the lifecycle below never depends on it - refresh early,
 *   rotate the pair, surface failure as reauthorization.
 *
 * PRODUCT RULES encoded here and in the capability matrix: reactive only
 * (no business-initiated messages), 48h reply window, max 10 consecutive
 * business messages, sends addressed by conversation_id (never user id),
 * QA cards carry reply buttons only, links in DMs are not clickable.
 */

export const TIKTOK_BUSINESS_API_BASE = "https://business-api.tiktok.com/open_api/v1.3";
export const TIKTOK_OAUTH_BASE = "https://open.tiktokapis.com/v2";

/** The one webhook event name confirmed by official-doc text (SDK). */
export const TIKTOK_HIGH_INTENT_COMMENT_EVENT = "im_receive_high_intent_comment";

/** TEXT body limit from the SDK-documented send contract. */
const TIKTOK_TEXT_LIMIT = 6000;
/** QA card title limit (SDK). */
const QA_CARD_TITLE_LIMIT = 40;
/** QA_BUTTON_CARD button title limit (SDK); QA_LINK_CARD allows 40. */
const QA_BUTTON_TITLE_LIMIT = 20;
/** QA cards carry 1-3 buttons (SDK). */
const QA_BUTTON_LIMIT = 3;

/**
 * Scopes requested at authorize time. ASSUMPTION (flagged): messaging
 * permission itself is granted at the APP level in the TikTok portal
 * (the "TikTok Accounts" permission + Business Messaging access approval);
 * the tt_user OAuth grant exchanged here is the standard user grant whose
 * baseline scope is user.info.basic (open_id + display name).
 */
export const TIKTOK_OAUTH_SCOPES = ["user.info.basic"] as const;

export function buildTikTokAuthorizeUrl(input: {
  appId: string;
  redirectUri: string;
  state?: string;
  scopes?: string[];
}): string {
  const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
  url.searchParams.set("client_key", input.appId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (input.scopes ?? [...TIKTOK_OAUTH_SCOPES]).join(","));
  url.searchParams.set("redirect_uri", input.redirectUri);
  if (input.state) url.searchParams.set("state", input.state);
  return url.toString();
}

/**
 * PLACEHOLDER webhook signature verification - NOT TikTok's real scheme.
 *
 * TikTok verifies webhooks somehow (partner docs confirm a signature
 * exists and that timestamps must be within ~5 seconds, which suggests a
 * timestamped HMAC), but the exact Business Messaging scheme lives in the
 * partner-gated docs and could not be sourced. Until access is approved
 * and the gated docs can be read, verification is HMAC-SHA256 of the raw
 * body keyed with the app secret, accepted as a bare hex digest or with a
 * `sha256=` prefix. The API route only enforces this when
 * TIKTOK_APP_SECRET is configured. REVISIT after access approval - see
 * docs/tiktok.md ("Unverified items").
 */
export function verifyTikTokWebhookSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const given = signatureHeader.startsWith("sha256=") ? signatureHeader.slice("sha256=".length) : signatureHeader;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ------------------------------------------------------------ token pairs

/**
 * A TikTok OAuth token pair. The vault stores ONE secret string per
 * account, so the pair is sealed as a single JSON string:
 * {"accessToken": "...", "refreshToken": "...", "openId": "..."}.
 * The credential providers place that string in the accessToken slot and
 * the adapter unwraps it here. A NON-JSON access token (env stub) is a
 * bare access token with no refresh capability.
 */
export interface TikTokTokenPair {
  accessToken: string;
  refreshToken?: string;
  openId?: string;
  /** ISO timestamp when the ACCESS token expires (~24h after issue). */
  expiresAt?: string;
  /** ISO timestamp when the REFRESH token expires (lifetime unverified). */
  refreshExpiresAt?: string;
  scope?: string;
}

export function serializeTikTokTokenPair(pair: TikTokTokenPair): string {
  return JSON.stringify(pair);
}

export function parseTikTokTokenPair(raw: string | undefined): TikTokTokenPair | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return { accessToken: trimmed };
  try {
    const parsed = JSON.parse(trimmed) as Partial<TikTokTokenPair>;
    if (typeof parsed.accessToken !== "string" || !parsed.accessToken) return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined,
      openId: typeof parsed.openId === "string" ? parsed.openId : undefined,
      expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : undefined,
      refreshExpiresAt: typeof parsed.refreshExpiresAt === "string" ? parsed.refreshExpiresAt : undefined,
      scope: typeof parsed.scope === "string" ? parsed.scope : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Persistence hook for rotated token pairs. When a refresh rotates the
 * pair OUTSIDE the worker's refresh processor (the refresh-on-401 path),
 * the new pair must land back in the vault or the next refresh presents a
 * dead refresh token. Process wiring (API/worker entrypoints) registers a
 * handler once at startup - the same pattern as
 * configureAdapterCredentials. Without a handler the adapter still keeps
 * the rotated pair in an in-process cache, so sends keep working until
 * the process restarts (and the worker's refresh processor, which DOES
 * persist via its rotatedSecret return, repairs the vault on its cycle).
 */
export type TikTokTokenPersistenceHandler = (input: {
  account: ChannelAccountRef;
  pair: TikTokTokenPair;
  serialized: string;
}) => Promise<void>;

let tokenPersistenceHandler: TikTokTokenPersistenceHandler | undefined;

export function configureTikTokTokenPersistence(
  handler: TikTokTokenPersistenceHandler | undefined,
): void {
  tokenPersistenceHandler = handler;
}

// ------------------------------------------------------------ API shapes

/** Normalized inbound message (content/list + webhook share this shape). */
export interface TikTokInboundMessage {
  messageExternalId: string;
  conversationExternalId: string;
  /** unique_identifier of the customer (stable across TikTok APIs). */
  contactExternalId: string;
  direction: "in" | "out";
  text?: string;
  media?: MessageMedia;
  receivedAt: string;
}

export interface TikTokConversationSummary {
  conversationExternalId: string;
  /** Epoch ms of the last message in the conversation. */
  upTime?: number;
  referral?: unknown;
}

interface TikTokEnvelope {
  code?: number;
  message?: string;
  request_id?: string;
  data?: Record<string, unknown>;
}

/** Envelope codes treated as a dead/expired access token. ASSUMPTION:
 * 40100 is the TikTok for Business "access token invalid" family code in
 * the SDK error tables; HTTP 401 is honoured alongside it. */
const AUTH_ENVELOPE_CODES = new Set([40100]);

const isoFromEpochMs = (ms: unknown): string => {
  const raw = typeof ms === "string" ? Number(ms) : (ms as number);
  if (!Number.isFinite(raw)) return new Date(0).toISOString();
  // Content-list timestamps are documented as epoch MILLIseconds; webhook
  // envelopes (unverified) may carry seconds - normalize by magnitude.
  const millis = raw < 1e11 ? raw * 1000 : raw;
  return new Date(millis).toISOString();
};

export interface TikTokAdapterOptions {
  credentials: CredentialProvider;
  fetchFn?: FetchLike;
  /** Business API base (tests can point it at a fake). */
  businessBase?: string;
  /** tt_user OAuth base (tests can point it at a fake). */
  oauthBase?: string;
  /** Clock injection for token-lifecycle decisions in tests. */
  nowFn?: () => Date;
}

interface ResolvedTikTokSecrets {
  pair: TikTokTokenPair | null;
  appId?: string;
  appSecret?: string;
}

export class TikTokAdapter implements ChannelAdapter {
  readonly key = "tiktok" as const;
  readonly apiVersion = "v1.3";
  readonly capabilities = CHANNEL_CAPABILITIES.tiktok;

  private readonly credentials: CredentialProvider;
  private readonly fetchFn: FetchLike;
  private readonly businessBase: string;
  private readonly oauthBase: string;
  private readonly nowFn: () => Date;
  /** Latest known pair per account id (rotation cache; see hook comment). */
  private readonly pairCache = new Map<string, TikTokTokenPair>();

  constructor(options: TikTokAdapterOptions) {
    this.credentials = options.credentials;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.businessBase = (options.businessBase ?? TIKTOK_BUSINESS_API_BASE).replace(/\/$/, "");
    this.oauthBase = (options.oauthBase ?? TIKTOK_OAUTH_BASE).replace(/\/$/, "");
    this.nowFn = options.nowFn ?? (() => new Date());
  }

  // --- account lifecycle ---------------------------------------------------

  async connect(): Promise<ChannelAccountRef> {
    throw new NotImplementedError(
      "tiktok.connect (OAuth onboarding lives at the API layer; use buildTikTokAuthorizeUrl + exchangeCode)",
    );
  }

  async disconnect(): Promise<void> {
    // The credential lives in the vault; revocation is an app-side action.
  }

  async health(account?: ChannelAccountRef): Promise<AdapterHealth> {
    if (!account) return { ok: false, detail: "tiktok: an account is required for a health check" };
    const secrets = await this.secretsFor(account);
    return secrets.pair?.accessToken
      ? { ok: true, detail: "tiktok adapter ready (Business Messaging API v1.3)" }
      : { ok: false, detail: "tiktok: no access token resolvable for this account (vault/env)" };
  }

  // --- secrets / token plumbing ---------------------------------------------

  private async secretsFor(account: ChannelAccountRef): Promise<ResolvedTikTokSecrets> {
    const cached = this.pairCache.get(account.id);
    const secrets = await this.credentials.resolve(account);
    const fromStore = parseTikTokTokenPair(secrets.accessToken);
    // The cache wins over the store: it holds the freshest rotation when a
    // refresh-on-401 landed after the store value was read.
    const pair = cached ?? fromStore;
    return { pair, appId: secrets.appId, appSecret: secrets.appSecret };
  }

  private async tokenFor(account: ChannelAccountRef): Promise<{ pair: TikTokTokenPair; accessToken: string }> {
    const { pair } = await this.secretsFor(account);
    if (!pair?.accessToken) {
      throw new AppError(
        "CONFIGURATION",
        "TikTok access token is not configured for this account (credential provider returned none)",
        { status: 503 },
      );
    }
    return { pair, accessToken: pair.accessToken };
  }

  /** The business identity (open_id) API calls are made for. */
  private businessIdFor(account: ChannelAccountRef, pair: TikTokTokenPair | null): string {
    return pair?.openId ?? account.externalId;
  }

  private async persistRotatedPair(account: ChannelAccountRef, pair: TikTokTokenPair): Promise<void> {
    this.pairCache.set(account.id, pair);
    if (!tokenPersistenceHandler) return;
    try {
      await tokenPersistenceHandler({ account, pair, serialized: serializeTikTokTokenPair(pair) });
    } catch (err) {
      // Persistence failure must not fail the send/refresh that rotated
      // the pair - the in-process cache keeps this process correct, and
      // the worker refresh cycle re-persists via rotatedSecret.
      console.error(`[tiktok] token persistence failed for account ${account.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- tt_user OAuth (token exchange / refresh / profile) ---------------------

  /**
   * Exchange an authorization code for a token pair (onboarding-time
   * helper used by the API layer; app credentials are passed explicitly
   * because no channel account - and therefore no vault ref - exists yet).
   * Endpoint family: POST {oauthBase}/oauth/token/ (form-encoded), the
   * official TikTok for Developers tt_user OAuth endpoints.
   */
  async exchangeCode(input: {
    appId: string;
    appSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<TikTokTokenPair> {
    return this.oauthTokenCall({
      clientKey: input.appId,
      clientSecret: input.appSecret,
      form: { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri },
    });
  }

  /** Rotate a token pair with its refresh token (new pair issued). */
  async refreshTokens(input: {
    appId: string;
    appSecret: string;
    refreshToken: string;
  }): Promise<TikTokTokenPair> {
    return this.oauthTokenCall({
      clientKey: input.appId,
      clientSecret: input.appSecret,
      form: { grant_type: "refresh_token", refresh_token: input.refreshToken },
    });
  }

  private async oauthTokenCall(input: {
    clientKey: string;
    clientSecret: string;
    form: Record<string, string>;
  }): Promise<TikTokTokenPair> {
    const form = new URLSearchParams({
      client_key: input.clientKey,
      client_secret: input.clientSecret,
      ...input.form,
    });
    const res = await this.fetchFn(`${this.oauthBase}/oauth/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string; refresh_token?: string; open_id?: string;
      expires_in?: number; refresh_expires_in?: number; scope?: string;
      error?: string; error_description?: string;
    };
    if (!res.ok || json.error || !json.access_token) {
      throw new ProviderAuthError(
        `TikTok OAuth token call failed: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`,
        { provider: "tiktok", retryable: false },
      );
    }
    const now = this.nowFn().getTime();
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      openId: json.open_id,
      expiresAt: json.expires_in ? new Date(now + json.expires_in * 1000).toISOString() : undefined,
      refreshExpiresAt: json.refresh_expires_in
        ? new Date(now + json.refresh_expires_in * 1000).toISOString()
        : undefined,
      scope: json.scope,
    };
  }

  /** Best-effort profile lookup for the connect flow's display name. */
  async fetchUserProfile(accessToken: string): Promise<{ openId?: string; displayName?: string; avatarUrl?: string }> {
    const url = new URL(`${this.oauthBase}/user/info/`);
    url.searchParams.set("fields", "open_id,display_name,avatar_url");
    const res = await this.fetchFn(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const json = (await res.json().catch(() => ({}))) as {
      data?: { user?: { open_id?: string; display_name?: string; avatar_url?: string } };
    };
    if (!res.ok || !json.data?.user) {
      throw new ProviderApiError(`TikTok user info failed (HTTP ${res.status})`, {
        provider: "tiktok", retryable: res.status >= 500,
      });
    }
    const user = json.data.user;
    return { openId: user.open_id, displayName: user.display_name, avatarUrl: user.avatar_url };
  }

  async refreshTokenIfNeeded(
    account: ChannelAccountRef,
  ): Promise<{ refreshed: boolean; expiresAt?: string; rotatedSecret?: string }> {
    const { pair, appId, appSecret } = await this.secretsFor(account);
    if (!pair?.refreshToken) return { refreshed: false };
    const decision = evaluateShortLivedRefresh({
      expiresAt: account.tokenExpiresAt ?? pair.expiresAt,
      now: this.nowFn(),
    });
    if (decision.action === "skip") return { refreshed: false };
    if (!appId || !appSecret) {
      throw new AppError(
        "CONFIGURATION",
        "TikTok token refresh needs TIKTOK_APP_ID and TIKTOK_APP_SECRET (client_key/client_secret) on this server",
        { status: 503 },
      );
    }
    // A failed refresh (dead refresh token) throws ProviderAuthError: the
    // worker marks the account refresh_failed and alerts - that status IS
    // Botara's needs-reauthorization surface for this channel.
    const next = await this.refreshTokens({ appId, appSecret, refreshToken: pair.refreshToken });
    const merged: TikTokTokenPair = { ...next, openId: next.openId ?? pair.openId };
    await this.persistRotatedPair(account, merged);
    return {
      refreshed: true,
      expiresAt: merged.expiresAt,
      rotatedSecret: serializeTikTokTokenPair(merged),
    };
  }

  // --- Business API HTTP plumbing ----------------------------------------------

  private async rawBusinessCall(
    accessToken: string,
    req: {
      method: "GET" | "POST";
      path: string;
      query?: Record<string, string | number | undefined>;
      json?: Record<string, unknown>;
      form?: FormData;
    },
  ): Promise<{ status: number; envelope: TikTokEnvelope }> {
    const url = new URL(`${this.businessBase}/${req.path}`);
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const res = await this.fetchFn(url.toString(), {
      method: req.method,
      headers: {
        "Access-Token": accessToken,
        ...(req.json ? { "Content-Type": "application/json" } : {}),
      },
      ...(req.json ? { body: JSON.stringify(req.json) } : {}),
      ...(req.form ? { body: req.form } : {}),
    });
    const envelope = (await res.json().catch(() => ({}))) as TikTokEnvelope;
    return { status: res.status, envelope };
  }

  private isAuthFailure(status: number, envelope: TikTokEnvelope): boolean {
    return status === 401 || (envelope.code !== undefined && AUTH_ENVELOPE_CODES.has(envelope.code));
  }

  private unwrapBusiness<T>(status: number, envelope: TikTokEnvelope): T {
    if (status === 429 || envelope.code === 42900) {
      throw new ProviderRateLimitError(envelope.message ?? "TikTok rate limit", {
        provider: "tiktok", providerCode: envelope.code, retryable: true,
      });
    }
    if (this.isAuthFailure(status, envelope)) {
      throw new ProviderAuthError(envelope.message ?? "TikTok access token invalid or expired", {
        provider: "tiktok", providerCode: envelope.code, retryable: false,
      });
    }
    if (status < 200 || status >= 300 || (envelope.code !== undefined && envelope.code !== 0)) {
      throw new ProviderApiError(envelope.message ?? `TikTok Business API error (HTTP ${status})`, {
        provider: "tiktok", providerCode: envelope.code, retryable: status >= 500,
      });
    }
    return (envelope.data ?? {}) as T;
  }

  /**
   * Business API call with refresh-on-401: an auth failure with a refresh
   * token available triggers ONE rotation + retry. The rotated pair is
   * persisted through the configured hook (and always cached in-process).
   */
  private async business<T>(
    account: ChannelAccountRef,
    req: {
      method: "GET" | "POST";
      path: string;
      query?: Record<string, string | number | undefined>;
      json?: Record<string, unknown>;
      form?: FormData;
    },
  ): Promise<T> {
    const { accessToken } = await this.tokenFor(account);
    let result = await this.rawBusinessCall(accessToken, req);
    if (this.isAuthFailure(result.status, result.envelope)) {
      const rotated = await this.tryRotatePair(account);
      if (rotated) result = await this.rawBusinessCall(rotated.accessToken, req);
    }
    return this.unwrapBusiness<T>(result.status, result.envelope);
  }

  /** Refresh the pair for the refresh-on-401 path; null when impossible. */
  private async tryRotatePair(account: ChannelAccountRef): Promise<TikTokTokenPair | null> {
    const { pair, appId, appSecret } = await this.secretsFor(account);
    if (!pair?.refreshToken || !appId || !appSecret) return null;
    try {
      const next = await this.refreshTokens({ appId, appSecret, refreshToken: pair.refreshToken });
      const merged: TikTokTokenPair = { ...next, openId: next.openId ?? pair.openId };
      await this.persistRotatedPair(account, merged);
      return merged;
    } catch {
      return null;
    }
  }

  // --- messaging ---------------------------------------------------------------

  /**
   * Build the /business/message/send/ body. recipient_type/recipient are
   * sent ONLY for conversation-addressed sends: the SDK-documented
   * contract says they are required when direct_reply is absent and NOT
   * supported when it is present.
   */
  private sendBody(input: {
    businessId: string;
    conversationExternalId?: string;
    commentReplyExternalId?: string;
    messageType: string;
    extra?: Record<string, unknown>;
  }): Record<string, unknown> {
    const body: Record<string, unknown> = {
      business_id: input.businessId,
      message_type: input.messageType,
      ...(input.extra ?? {}),
    };
    if (input.commentReplyExternalId) {
      body.direct_reply = {
        reply_type: "COMMENT_REPLY",
        comment_reply: { comment_id: input.commentReplyExternalId },
      };
    } else {
      body.recipient_type = "CONVERSATION";
      body.recipient = input.conversationExternalId;
    }
    return body;
  }

  private async postSend(
    account: ChannelAccountRef,
    body: Record<string, unknown>,
  ): Promise<{ externalMessageId: string }> {
    const data = await this.business<{ message?: { message_id?: string } }>(account, {
      method: "POST", path: "business/message/send/", json: body,
    });
    // The SDK notes message_id is empty for SENDER_ACTION sends; a plain
    // message send without one is a provider anomaly worth surfacing.
    return { externalMessageId: data.message?.message_id ?? "" };
  }

  async send(input: SendInput): Promise<SendResult> {
    if (input.template || input.templateName) {
      throw new AppError(
        "VALIDATION",
        "TikTok has no message templates - sends are free-form inside the 48h reply window only",
      );
    }
    if (!input.commentReplyExternalId && !input.conversationExternalId) {
      throw new ConversationAddressMissingError("tiktok");
    }
    if (input.rich) return this.sendRich(input, input.rich);
    const { pair } = await this.tokenFor(input.account);
    const businessId = this.businessIdFor(input.account, pair);
    const addressing = {
      businessId,
      conversationExternalId: input.conversationExternalId,
      commentReplyExternalId: input.commentReplyExternalId,
    };

    if (input.media) {
      const mediaId = await this.resolveOutboundImageId(input);
      const sent = await this.postSend(input.account, this.sendBody({
        ...addressing, messageType: "IMAGE", extra: { image: { media_id: mediaId } },
      }));
      return { externalMessageId: sent.externalMessageId, status: "sent" };
    }
    if (input.text !== undefined) {
      const sent = await this.postSend(input.account, this.sendBody({
        ...addressing,
        messageType: "TEXT",
        extra: { text: { body: input.text.slice(0, TIKTOK_TEXT_LIMIT) } },
      }));
      return { externalMessageId: sent.externalMessageId, status: "sent" };
    }
    throw new AppError("VALIDATION", "tiktok.send requires text, an image, or a rich block");
  }

  /**
   * Outbound images: a Botara media id that is already a TikTok media_id
   * is used directly; a public link is fetched and uploaded first (TikTok
   * accepts uploads only, never URLs). Non-image media cannot be sent -
   * the Business Messaging send contract has no video/document type.
   */
  private async resolveOutboundImageId(input: SendInput): Promise<string> {
    const media = input.media!;
    if (media.type !== "image" && media.type !== "photo") {
      throw new AppError(
        "VALIDATION",
        `TikTok cannot send ${media.type} media - the Business Messaging send contract supports images only (plus SHARE_POST for the business's own posts)`,
      );
    }
    if (media.id) return media.id;
    if (!media.link) {
      throw new AppError("VALIDATION", "tiktok image send needs a media id or a public link to upload");
    }
    const res = await this.fetchFn(media.link);
    if (!res.ok) {
      throw new ProviderApiError(`TikTok image source fetch failed (HTTP ${res.status})`, {
        provider: "tiktok", retryable: res.status >= 500,
      });
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const uploaded = await this.uploadMedia(input.account, {
      bytes,
      contentType: res.headers.get("content-type") ?? media.mimeType ?? "image/jpeg",
      filename: media.filename,
    });
    return uploaded.mediaId;
  }

  /**
   * Rich-block renderer. TikTok QA cards are the ONLY interactive surface:
   * a "buttons" block becomes a QA_BUTTON_CARD whose buttons are REPLY
   * buttons - a tap sends the button's title as the customer's next
   * message (so keyword flows match it; postback payloads do not survive,
   * the button id below is Botara-side bookkeeping only). URL buttons
   * cannot exist on TikTok (links in DMs are not clickable) and are
   * dropped with the standard typed warning; every other rich kind
   * degrades to formatted plain text, never silently.
   */
  private async sendRich(input: SendInput, rich: RichBlock): Promise<SendResult> {
    const { pair } = await this.tokenFor(input.account);
    const businessId = this.businessIdFor(input.account, pair);
    const addressing = {
      businessId,
      conversationExternalId: input.conversationExternalId,
      commentReplyExternalId: input.commentReplyExternalId,
    };
    const warnings: RichWarning[] = [];

    if (rich.kind === "buttons" && rich.text.trim()) {
      const usable = rich.buttons.filter((b) => b.type !== "url");
      if (usable.length < rich.buttons.length) warnings.push("RICH_URL_BUTTONS_DROPPED");
      if (usable.length > 0) {
        if (usable.length > QA_BUTTON_LIMIT) warnings.push("RICH_BUTTONS_TRUNCATED");
        let title = rich.text;
        if (title.length > QA_CARD_TITLE_LIMIT) {
          title = title.slice(0, QA_CARD_TITLE_LIMIT);
          warnings.push("RICH_TITLES_TRUNCATED");
        }
        const buttons = usable.slice(0, QA_BUTTON_LIMIT).map((b) => {
          let buttonTitle = b.title;
          if (buttonTitle.length > QA_BUTTON_TITLE_LIMIT) {
            buttonTitle = buttonTitle.slice(0, QA_BUTTON_TITLE_LIMIT);
            if (!warnings.includes("RICH_TITLES_TRUNCATED")) warnings.push("RICH_TITLES_TRUNCATED");
          }
          return { type: "REPLY", title: buttonTitle, id: (b.payload ?? b.title).slice(0, 40) };
        });
        const sent = await this.postSend(input.account, this.sendBody({
          ...addressing,
          messageType: "TEMPLATE",
          extra: { template: { type: "QA_BUTTON_CARD", title, buttons } },
        }));
        return {
          externalMessageId: sent.externalMessageId, status: "sent",
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      }
    }

    warnings.push("RICH_DEGRADED_TO_TEXT");
    const sent = await this.postSend(input.account, this.sendBody({
      ...addressing,
      messageType: "TEXT",
      extra: { text: { body: richToPlainText(rich).slice(0, TIKTOK_TEXT_LIMIT) } },
    }));
    return { externalMessageId: sent.externalMessageId, status: "sent", warnings };
  }

  /**
   * Private reply to a high-intent comment (comment-to-DM): the send
   * carries direct_reply.comment_reply.comment_id and NO recipient - the
   * SDK-documented shape. TikTok opens (or continues) the DM with the
   * commenter; the reply is subject to TikTok's own eligibility rules
   * (VN/ID/TH-registered business, first-level comment on the business's
   * own video, within 48h, commenter 18+ - enforced provider-side).
   */
  async privateReplyToComment(
    account: ChannelAccountRef,
    commentExternalId: string,
    text: string,
  ): Promise<{ externalMessageId: string }> {
    const { pair } = await this.tokenFor(account);
    return this.postSend(account, this.sendBody({
      businessId: this.businessIdFor(account, pair),
      commentReplyExternalId: commentExternalId,
      messageType: "TEXT",
      extra: { text: { body: text.slice(0, TIKTOK_TEXT_LIMIT) } },
    }));
  }

  /** Typing indicator / mark-read (SENDER_ACTION; returns no message id). */
  async sendSenderAction(
    account: ChannelAccountRef,
    conversationExternalId: string,
    action: "TYPING" | "MARK_READ",
  ): Promise<void> {
    const { pair } = await this.tokenFor(account);
    await this.postSend(account, this.sendBody({
      businessId: this.businessIdFor(account, pair),
      conversationExternalId,
      messageType: "SENDER_ACTION",
      extra: { sender_action: action },
    }));
  }

  /** Share one of the business's OWN posts into a conversation. */
  async sendSharePost(
    account: ChannelAccountRef,
    input: { conversationExternalId: string; itemId: string; embedUrl?: string },
  ): Promise<{ externalMessageId: string }> {
    const { pair } = await this.tokenFor(account);
    return this.postSend(account, this.sendBody({
      businessId: this.businessIdFor(account, pair),
      conversationExternalId: input.conversationExternalId,
      messageType: "SHARE_POST",
      extra: { share_post: { item_id: input.itemId, ...(input.embedUrl ? { embed_url: input.embedUrl } : {}) } },
    }));
  }

  // --- media (upload / download) -------------------------------------------------

  /**
   * Upload an image for sending (POST /business/message/media/upload/,
   * multipart). SDK-documented limits: JPG/PNG only, <= 3MB; the returned
   * media_id stays valid 30 days. (A partner source claims 20MB
   * JPEG/WebP - the SDK text is treated as authoritative; see docs.)
   */
  async uploadMedia(
    account: ChannelAccountRef,
    input: { bytes: Uint8Array; contentType: string; filename?: string },
  ): Promise<{ mediaId: string }> {
    if (!/image\/(jpeg|png)/i.test(input.contentType)) {
      throw new AppError(
        "VALIDATION",
        `TikTok media upload accepts JPG/PNG images only (got ${input.contentType})`,
      );
    }
    const { pair } = await this.tokenFor(account);
    const form = new FormData();
    form.set("business_id", this.businessIdFor(account, pair));
    form.set("media_type", "IMAGE");
    const blob = new Blob([input.bytes], { type: input.contentType });
    form.set("file", blob, input.filename ?? "image.jpg");
    const data = await this.business<{ media_id?: string }>(account, {
      method: "POST", path: "business/message/media/upload/", form,
    });
    if (!data.media_id) {
      throw new ProviderApiError("TikTok media upload returned no media_id", {
        provider: "tiktok", retryable: false,
      });
    }
    return { mediaId: data.media_id };
  }

  /**
   * Download inbound media bytes (POST /business/message/media/download/
   * per the SDK; one partner integration documents GET instead - POST is
   * implemented, flagged in docs/tiktok.md). The response's download_url
   * is valid 24h and fetching it REQUIRES the `x-user` header carrying
   * the access token. Mirrors WhatsAppAdapter.downloadMedia's return.
   */
  async downloadMedia(
    account: ChannelAccountRef,
    input: { conversationId: string; messageId: string; mediaId: string; mediaType: "IMAGE" | "VIDEO" },
  ): Promise<{ data: ArrayBuffer; mimeType?: string }> {
    const { pair, accessToken } = await this.tokenFor(account);
    const data = await this.business<{ download_url?: string }>(account, {
      method: "POST",
      path: "business/message/media/download/",
      json: {
        business_id: this.businessIdFor(account, pair),
        conversation_id: input.conversationId,
        message_id: input.messageId,
        media_id: input.mediaId,
        media_type: input.mediaType,
      },
    });
    if (!data.download_url) {
      throw new ProviderApiError("TikTok media download returned no download_url", {
        provider: "tiktok", retryable: false,
      });
    }
    const res = await this.fetchFn(data.download_url, { headers: { "x-user": accessToken } });
    if (!res.ok) {
      throw new ProviderApiError(`TikTok media download failed (HTTP ${res.status})`, {
        provider: "tiktok", retryable: res.status >= 500,
      });
    }
    return { data: await res.arrayBuffer(), mimeType: res.headers.get("content-type") ?? undefined };
  }

  // --- history / capabilities / comment-to-DM management ---------------------------

  /** Conversation list (history backfill source): STRANGER or SINGLE. */
  async listConversations(
    account: ChannelAccountRef,
    input: { conversationType: "STRANGER" | "SINGLE"; limit?: number; cursor?: number },
  ): Promise<{ conversations: TikTokConversationSummary[]; hasMore: boolean; cursor?: number }> {
    const { pair } = await this.tokenFor(account);
    const data = await this.business<{
      conversations?: Array<{ conversation_id?: string; up_time?: number; referral?: unknown }>;
      has_more?: boolean; cursor?: number;
    }>(account, {
      method: "GET",
      path: "business/message/conversation/list/",
      query: {
        business_id: this.businessIdFor(account, pair),
        conversation_type: input.conversationType,
        limit: input.limit ?? 100,
        cursor: input.cursor,
      },
    });
    return {
      conversations: (data.conversations ?? []).map((c) => ({
        conversationExternalId: String(c.conversation_id ?? ""),
        upTime: c.up_time,
        referral: c.referral,
      })),
      hasMore: Boolean(data.has_more),
      cursor: data.cursor,
    };
  }

  /**
   * Message history of one conversation (content/list), normalized with
   * the same mapper the webhook path uses - a manual "sync history"
   * consumer reads Botara-shaped messages from day one.
   */
  async listMessages(
    account: ChannelAccountRef,
    conversationExternalId: string,
  ): Promise<{ messages: TikTokInboundMessage[] }> {
    const { pair } = await this.tokenFor(account);
    const data = await this.business<{
      messages?: Array<Record<string, any>>;
      participants?: Array<Record<string, any>>;
    }>(account, {
      method: "GET",
      path: "business/message/content/list/",
      query: {
        business_id: this.businessIdFor(account, pair),
        // URLSearchParams percent-encodes "+" as %2B, which the SDK
        // explicitly warns is required for conversation ids.
        conversation_id: conversationExternalId,
      },
    });
    const businessId = this.businessIdFor(account, pair);
    const messages: TikTokInboundMessage[] = [];
    for (const raw of data.messages ?? []) {
      const normalized = normalizeTikTokMessage(raw, businessId);
      if (normalized) messages.push(normalized);
    }
    return { messages };
  }

  /**
   * IMAGE_SEND capability for one conversation: whether this business may
   * exchange images with this customer (market-gated on BOTH sides). The
   * send path does not pre-check (Botara does not track the conversation's
   * STRANGER/SINGLE type); provider refusals surface as typed errors.
   */
  async getImageSendCapability(
    account: ChannelAccountRef,
    input: { conversationExternalId: string; conversationType: "STRANGER" | "SINGLE" },
  ): Promise<boolean> {
    const { pair } = await this.tokenFor(account);
    const data = await this.business<{
      capability_infos?: Array<{ capability_type?: string; capability_result?: boolean }>;
    }>(account, {
      method: "GET",
      path: "business/message/capabilities/get/",
      query: {
        business_id: this.businessIdFor(account, pair),
        capability_types: "IMAGE_SEND",
        conversation_id: input.conversationExternalId,
        conversation_type: input.conversationType,
      },
    });
    const info = (data.capability_infos ?? []).find((i) => i.capability_type === "IMAGE_SEND");
    return Boolean(info?.capability_result);
  }

  /** Comment-to-Message switch state for this business (direct_reply/get). */
  async getCommentToMessageEnabled(account: ChannelAccountRef): Promise<boolean> {
    const { pair } = await this.tokenFor(account);
    const data = await this.business<{ operation_status?: string }>(account, {
      method: "GET",
      path: "business/message/direct_reply/get/",
      query: {
        business_id: this.businessIdFor(account, pair),
        direct_reply_type: "COMMENT_TO_MESSAGE",
      },
    });
    return data.operation_status === "ENABLE";
  }

  /** Enable/disable Comment-to-Message for this business (direct_reply/update). */
  async setCommentToMessageEnabled(account: ChannelAccountRef, enabled: boolean): Promise<void> {
    const { pair } = await this.tokenFor(account);
    await this.business(account, {
      method: "POST",
      path: "business/message/direct_reply/update/",
      json: {
        business_id: this.businessIdFor(account, pair),
        direct_reply_type: "COMMENT_TO_MESSAGE",
        operation_status: enabled ? "ENABLE" : "DISABLE",
      },
    });
  }

  // --- webhooks -----------------------------------------------------------------------

  /**
   * Normalize a raw webhook payload. The Business Messaging webhook
   * catalogue is UNVERIFIED (gated docs), so this parser is deliberately
   * tolerant: it accepts a single event object, an { events: [...] }
   * batch, and content carried as an object or a JSON string; it handles
   * the confirmed high-intent comment event and any item carrying a
   * content-list-shaped message; unknown items are ignored (never thrown -
   * webhook handlers must ack and move on). Messages sent BY the business
   * are skipped: Botara's own send path already persisted them.
   */
  async parseWebhook(payload: unknown): Promise<InboundEvent[]> {
    const events: InboundEvent[] = [];
    for (const item of collectWebhookItems(payload)) {
      const eventName = typeof item.event === "string" ? item.event
        : typeof item.event_type === "string" ? item.event_type
        : undefined;
      const content = asRecord(parseMaybeJson(item.content ?? item.data ?? item)) ?? {};
      const accountExternalId = firstString(
        item.user_openid, item.business_id, content.business_id, content.open_id,
      ) ?? "";

      if (eventName === TIKTOK_HIGH_INTENT_COMMENT_EVENT) {
        const comment = asRecord(content.comment) ?? content;
        const commentExternalId = firstString(comment.comment_id, comment.id, content.comment_id);
        if (!commentExternalId) continue;
        const authorExternalId = firstString(
          comment.user_id, comment.commenter_id, comment.unique_identifier,
          asRecord(comment.from_user)?.id, content.user_id, content.unique_identifier,
        );
        events.push({
          type: "comment.received",
          channel: "tiktok",
          accountExternalId,
          postExternalId: firstString(comment.video_id, comment.item_id, comment.video?.id, content.video_id, content.item_id) ?? "",
          commentExternalId,
          text: firstString(comment.comment_text, comment.text, content.comment_text, content.text),
          ...(authorExternalId ? { authorExternalId } : {}),
          receivedAt: isoFromEpochMs(firstNumber(comment.create_time, comment.timestamp, content.timestamp) ?? Date.now()),
        });
        continue;
      }

      const rawMessage = asRecord(content.message) ?? (looksLikeMessage(content) ? content : null)
        ?? (looksLikeMessage(item) ? item : null);
      if (!rawMessage) continue;
      const businessId = accountExternalId || undefined;
      const normalized = normalizeTikTokMessage(rawMessage, businessId);
      if (!normalized || normalized.direction === "out") continue;
      events.push({
        type: "message.received",
        channel: "tiktok",
        accountExternalId,
        contactExternalId: normalized.contactExternalId,
        messageExternalId: normalized.messageExternalId,
        ...(normalized.text !== undefined ? { text: normalized.text } : {}),
        ...(normalized.media ? { media: normalized.media } : {}),
        conversationExternalId: normalized.conversationExternalId,
        receivedAt: normalized.receivedAt,
      });
    }
    return events;
  }
}

// ------------------------------------------------------------ webhook helpers

type AnyRecord = Record<string, any>;

function asRecord(value: unknown): AnyRecord | null {
  return typeof value === "object" && value !== null ? (value as AnyRecord) : null;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function looksLikeMessage(value: AnyRecord): boolean {
  return typeof value.conversation_id === "string"
    && typeof value.message_id === "string"
    && typeof value.message_type === "string";
}

/** Flatten the tolerated webhook envelope shapes into event items. */
function collectWebhookItems(payload: unknown): AnyRecord[] {
  const root = asRecord(payload);
  if (!root) return [];
  if (Array.isArray(root.events)) {
    return root.events.map((e) => asRecord(parseMaybeJson(e))).filter((e): e is AnyRecord => e !== null);
  }
  if (Array.isArray(root.entry)) {
    const items: AnyRecord[] = [];
    for (const entry of root.entry) {
      const record = asRecord(entry);
      if (record) items.push(record);
    }
    return items;
  }
  return [root];
}

/**
 * Normalize one content-list-shaped TikTok message. Identity rule (SDK):
 * participants carry `id` = unique_identifier for personal accounts and
 * the open_id for the business; direction is "out" when the sender IS the
 * business (matched by id or by the BUSINESS_ACCOUNT role). Reactions and
 * quote-reply references have no Botara event field and are dropped -
 * the same treatment the Meta adapters give reactions today.
 */
export function normalizeTikTokMessage(
  raw: AnyRecord,
  businessId: string | undefined,
): TikTokInboundMessage | null {
  const conversationExternalId = firstString(raw.conversation_id);
  const messageExternalId = firstString(raw.message_id);
  if (!conversationExternalId || !messageExternalId) return null;
  const from = asRecord(raw.from_user);
  const to = asRecord(raw.to_user);
  const senderId = firstString(from?.id, raw.sender_id);
  const recipientId = firstString(to?.id, raw.recipient_id);
  const fromBusiness = (businessId !== undefined && senderId === businessId)
    || from?.role === "BUSINESS_ACCOUNT";
  const contactExternalId = fromBusiness ? recipientId : senderId;
  if (!contactExternalId) return null;

  const type = typeof raw.message_type === "string" ? raw.message_type : "OTHER";
  let text: string | undefined;
  let media: MessageMedia | undefined;
  switch (type) {
    case "TEXT":
      text = firstString(asRecord(raw.text)?.body);
      break;
    case "IMAGE": {
      const mediaId = firstString(asRecord(raw.image)?.media_id);
      if (mediaId) media = { type: "image", id: mediaId };
      break;
    }
    case "VIDEO": {
      const mediaId = firstString(asRecord(raw.video)?.media_id);
      if (mediaId) media = { type: "video", id: mediaId };
      break;
    }
    case "SHARE_POST": {
      const share = asRecord(raw.share_post);
      const itemId = firstString(share?.item_id);
      if (itemId) {
        media = { type: "video", id: itemId, ...(firstString(share?.embed_url) ? { url: firstString(share?.embed_url) } : {}) };
      }
      break;
    }
    case "STICKER": {
      const url = firstString(asRecord(raw.sticker)?.url);
      if (url) media = { type: "sticker", url };
      break;
    }
    case "EMOJI": {
      const url = firstString(asRecord(raw.emoji)?.url);
      if (url) media = { type: "sticker", url };
      break;
    }
    case "TEMPLATE":
      // A QA card in history: its title is the readable text. (Users do
      // not send templates; business-sent ones are direction "out".)
      text = firstString(asRecord(raw.template)?.title);
      break;
    default:
      break;
  }

  const timestamp = firstNumber(raw.timestamp) ?? Date.now();
  return {
    messageExternalId,
    conversationExternalId,
    contactExternalId,
    direction: fromBusiness ? "out" : "in",
    ...(text !== undefined ? { text } : {}),
    ...(media ? { media } : {}),
    receivedAt: isoFromEpochMs(timestamp),
  };
}
