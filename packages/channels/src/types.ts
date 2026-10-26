import type { RichBlock, RichWarning } from "./rich";

/**
 * Channel capability model. The flow engine, inbox UI, and composer all read
 * capabilities from here - capabilities are NEVER assumed per channel in
 * product code.
 */
export interface CapabilitySet {
  canDM: boolean;
  canPublish: boolean;
  canReplyToComments: boolean;
  canHideComments: boolean;
  canLike: boolean;
  canFetchInsights: boolean;
  canBroadcast: boolean;
  /** Provider natively supports scheduled sends (false = Botara schedules via its own queue). */
  canScheduleNatively: boolean;
  /** Rich blocks: native interactive reply/url/postback buttons. */
  richButtons: boolean;
  /** Rich blocks: native list-picker messages. */
  richLists: boolean;
  /** Rich blocks: native card carousel (generic template / equivalent). */
  carousel: boolean;
  /** Rich blocks: native product / catalog messages. */
  catalog: boolean;
  /** WhatsApp only: where marketing-category sends must be routed. */
  marketingRoute?: "cloud-api" | "marketing-messages-api";
  /** Instagram only: supported OAuth flavours. */
  authModes?: Array<"instagram-login" | "facebook-login">;
  notes?: string;
}

export type ChannelKey = "whatsapp" | "instagram" | "messenger" | "threads" | "telegram" | "email" | "webchat";

/**
 * Capability matrix — verified against Meta's current docs on 2026-10-22.
 * Key facts encoded here:
 * - Threads: NO DM API and NO like API. Publish, reply, hide, insights only.
 * - WhatsApp: marketing sends route to the Marketing Messages API
 *   (Cloud API marketing sunsets 2027-10-13).
 * - Instagram: two auth modes with different hosts, tokens, and scopes.
 */
export const CHANNEL_CAPABILITIES: Record<ChannelKey, CapabilitySet> = {
  whatsapp: {
    canDM: true, canPublish: false, canReplyToComments: false, canHideComments: false,
    canLike: false, canFetchInsights: true, canBroadcast: true, canScheduleNatively: false,
    richButtons: true, richLists: true, carousel: false, catalog: true,
    marketingRoute: "marketing-messages-api",
    notes: "Template-based outside the 24h window. Per-message pricing since 2025-07-01; service messages billed since 2026-10-01 after 1,000 free/number/month. Rich: interactive buttons/list/CTA-URL + product & catalog messages; no free-form carousel (carousels exist only as pre-approved templates).",
  },
  instagram: {
    canDM: true, canPublish: true, canReplyToComments: true, canHideComments: true,
    canLike: true, canFetchInsights: true, canBroadcast: false, canScheduleNatively: false,
    richButtons: true, richLists: false, carousel: true, catalog: false,
    authModes: ["instagram-login", "facebook-login"],
    notes: "Professional accounts only (Basic Display API retired 2024-12-04). Media is fetched by Meta from a public URL. Rich: buttons render as quick replies, carousel as a Send API generic template; no list or catalog messages.",
  },
  messenger: {
    canDM: true, canPublish: false, canReplyToComments: true, canHideComments: true,
    canLike: false, canFetchInsights: true, canBroadcast: false, canScheduleNatively: false,
    richButtons: true, richLists: false, carousel: true, catalog: false,
    notes: "Page-based. Customer Chat Plugin retired 2024-05-09 - webchat is Botara's own widget. Rich: button template + quick replies + generic-template carousel; the old list template was retired by Meta.",
  },
  threads: {
    canDM: false, canPublish: true, canReplyToComments: true, canHideComments: true,
    canLike: false, canFetchInsights: true, canBroadcast: false, canScheduleNatively: false,
    richButtons: false, richLists: false, carousel: false, catalog: false,
    notes: "No DM API and no like API. Public reply + hide only for comment automation. Publishing quotas: 250 posts / 1,000 replies / 100 deletions per profile per 24h.",
  },
  telegram: {
    canDM: true, canPublish: true, canReplyToComments: false, canHideComments: false,
    canLike: false, canFetchInsights: false, canBroadcast: true, canScheduleNatively: false,
    richButtons: true, richLists: false, carousel: false, catalog: false,
    notes: "Bot API. Channel posts = publish; groups/chats = DM-style messaging. Rich: inline keyboards; lists render as keyboards and carousels as sequential card messages (with a typed warning), never silently.",
  },
  email: {
    canDM: true, canPublish: false, canReplyToComments: false, canHideComments: false,
    canLike: false, canFetchInsights: true, canBroadcast: true, canScheduleNatively: false,
    richButtons: false, richLists: false, carousel: false, catalog: false,
    notes: "Via Resend. Inbound webhook carries metadata only; content is fetched via the Receiving API. Rich blocks degrade to formatted plain text (typed warning).",
  },
  webchat: {
    canDM: true, canPublish: false, canReplyToComments: false, canHideComments: false,
    canLike: false, canFetchInsights: false, canBroadcast: false, canScheduleNatively: false,
    richButtons: true, richLists: true, carousel: false, catalog: false,
    notes: "Botara's own website widget (Meta's Customer Chat Plugin retired 2024-05-09, no replacement). Messages persist in Botara's DB via a store port - there is no external API. Rich buttons and lists render natively in the widget as clickable buttons (a tap posts the button payload back, where flow postback/keyword triggers match it); carousel/product/catalog blocks degrade to formatted plain text (typed warning).",
  },
};

/** Media attached to a message, normalized across providers. */
export interface MessageMedia {
  type: "image" | "video" | "document" | "audio" | "sticker" | "photo" | "unknown";
  /** Provider media id (e.g. WhatsApp media id, Telegram file_id). */
  id?: string;
  caption?: string;
  mimeType?: string;
  filename?: string;
}

export interface MessageStatusError {
  code: number;
  title?: string;
  message?: string;
}

/** A file attached to an inbound message (email attachments, Fase 2). */
export interface MessageAttachment {
  /** Provider-side attachment id (e.g. a Resend Receiving attachment id). */
  id: string;
  filename?: string;
  contentType?: string;
  size?: number;
}

/** Click-to-WhatsApp ad referral data attached to a first message (growth attribution input). */
export interface MessageReferral {
  /** Referral source label (e.g. "ADS", "SHORT_LINK") when the provider sends one. */
  source?: string;
  /** Click id from a click-to-WhatsApp ad (ctwa_clid), when present. */
  ctwaClid?: string;
  /** Provider source id (ad / post id), when present. */
  sourceId?: string;
}

/**
 * One address-book contact carried by a coexistence state sync
 * (WhatsApp `smb_app_state_sync`). `externalId` is the phone number /
 * wa_id the contact is keyed by. `remove` means the contact was deleted
 * from the Business app's address book - consumers decide what that
 * means for their own records (Botara's dispatcher keeps the platform
 * contact: conversation history and consent live on it).
 */
export interface SyncedContact {
  externalId: string;
  displayName?: string;
  action: "add" | "remove" | "update";
}

/** Standardized inbound events every adapter must normalize webhooks into. */
export type InboundEvent =
  | { type: "message.received"; channel: ChannelKey; accountExternalId: string; contactExternalId: string; messageExternalId: string; text?: string; media?: MessageMedia; receivedAt: string; subject?: string; attachments?: MessageAttachment[]; recipients?: string[]; referral?: MessageReferral }
  | { type: "message.echo"; channel: ChannelKey; accountExternalId: string; contactExternalId: string; messageExternalId: string; text?: string; media?: MessageMedia; receivedAt: string }
  | { type: "contacts.synced"; channel: ChannelKey; accountExternalId: string; contacts: SyncedContact[]; receivedAt: string }
  | { type: "message.history"; channel: ChannelKey; accountExternalId: string; contactExternalId: string; messageExternalId: string; direction: "in" | "out"; text?: string; media?: MessageMedia; receivedAt: string }
  | { type: "comment.received"; channel: ChannelKey; accountExternalId: string; postExternalId: string; commentExternalId: string; text?: string; authorExternalId?: string; parentPostExternalId?: string; receivedAt: string }
  | { type: "mention.received"; channel: ChannelKey; accountExternalId: string; postExternalId: string; commentExternalId?: string; authorExternalId?: string; receivedAt: string }
  | { type: "postback.received"; channel: ChannelKey; accountExternalId: string; contactExternalId: string; payload: string; title?: string; receivedAt: string }
  | { type: "referral.received"; channel: ChannelKey; accountExternalId: string; contactExternalId: string; ref?: string; source?: string; receivedAt: string }
  | { type: "message.status"; channel: ChannelKey; accountExternalId?: string; messageExternalId: string; status: "sent" | "delivered" | "read" | "failed"; errors?: MessageStatusError[]; receivedAt: string }
  | { type: "template.category_changed"; channel: ChannelKey; templateExternalId: string; templateName?: string; language?: string; previousCategory?: string; newCategory: string; accountExternalId?: string; receivedAt: string };

export interface ChannelAccountRef {
  id: string;
  externalId: string;
  authMode?: string;
  /** Opaque pointer into the credential vault (channel_accounts.token_vault_ref). */
  tokenVaultRef?: string;
  /**
   * When the current access token expires (ISO string), mirrored from
   * channel_accounts.token_expires_at. Token-refresh logic (Threads 24h-60d
   * window, Instagram long-lived tokens) decides from this value.
   */
  tokenExpiresAt?: string;
}

export interface SendTemplateInput {
  name: string;
  language: string;
  /**
   * The template's LATEST provider category (DB owns this via
   * templates.latest_category). WhatsApp routing depends on it: "marketing"
   * goes to the Marketing Messages API, everything else to /messages.
   * Callers must pass it explicitly - adapters never guess.
   */
  latestCategory: string;
  components?: unknown[];
}

export interface SendInput {
  account: ChannelAccountRef;
  toExternalId: string;
  text?: string;
  media?: MessageMedia & { link?: string };
  template?: SendTemplateInput;
  templateName?: string;
  /** Email only: message subject (other channels ignore it). */
  subject?: string;
  /**
   * Rich block (buttons / list / carousel / product / catalog). When set,
   * the adapter renders it natively where its capabilities allow and
   * degrades to formatted plain text + a typed warning elsewhere - never
   * silently. Takes precedence over text/media inside the rich renderer;
   * `text` should carry the block's own text for non-rich consumers.
   */
  rich?: RichBlock;
  /** REQUIRED: providers are called with this key so retries never double-send. */
  idempotencyKey: string;
}

export interface SendResult {
  externalMessageId: string;
  status: "sent" | "queued";
  /** Typed rich-render warning codes (see rich.ts) when a block degraded. */
  warnings?: RichWarning[];
}

export interface PublishInput {
  account: ChannelAccountRef;
  text?: string;
  mediaUrls?: string[];
  /** Hint when a single media URL is given (Threads container media_type, IG media kind). */
  mediaType?: "image" | "video";
  /** Threads/IG: publish as a reply to this existing post/reply external id. */
  replyToExternalId?: string;
  /** Threads: quote this existing post external id. */
  quoteExternalId?: string;
  idempotencyKey: string;
}

export interface AdapterHealth {
  ok: boolean;
  detail: string;
}

/**
 * THE channel contract (ADR-004). Optional capabilities are declared via the
 * CapabilitySet, and calling an unsupported optional method must throw
 * NotImplementedError rather than silently succeeding.
 */
export interface ChannelAdapter {
  readonly key: ChannelKey;
  /** Provider API version this adapter is pinned to, e.g. "v26.0" for Meta Graph. */
  readonly apiVersion: string;
  readonly capabilities: CapabilitySet;

  connect(input: { workspaceId: string; authCode?: string }): Promise<ChannelAccountRef>;
  disconnect(account: ChannelAccountRef): Promise<void>;
  refreshTokenIfNeeded(account: ChannelAccountRef): Promise<{ refreshed: boolean; expiresAt?: string }>;
  send(input: SendInput): Promise<SendResult>;

  publish?(input: PublishInput): Promise<{ externalPostId: string }>;
  moderate?(input: { account: ChannelAccountRef; targetExternalId: string; action: "hide" | "unhide" | "delete" | "reply"; text?: string }): Promise<void>;
  fetchInsights?(input: { account: ChannelAccountRef; targetExternalId?: string }): Promise<Record<string, number>>;

  /** Normalize a raw provider webhook payload into standardized events. */
  parseWebhook(payload: unknown): Promise<InboundEvent[]>;
  health(): Promise<AdapterHealth>;
}

/**
 * Secrets an adapter needs for one account, resolved at call time.
 * Raw tokens are NEVER stored on channel_accounts rows and NEVER logged;
 * the row only carries `tokenVaultRef`, an opaque pointer into the vault.
 */
export interface ChannelSecrets {
  /** Meta user/system access token, or generic bearer token (Resend API key for the email channel). */
  accessToken?: string;
  /** Telegram bot token. */
  botToken?: string;
  /** Meta app secret, used for webhook signature verification. */
  appSecret?: string;
  /** Webhook signing secret for non-Meta providers (Resend/Svix `whsec_...`). */
  webhookSecret?: string;
}

/**
 * Resolves the secrets for an account from its tokenVaultRef.
 * Implementations: a real vault/KMS in production, env vars in dev
 * (see EnvCredentialProvider), in-memory maps in tests.
 */
export interface CredentialProvider {
  resolve(account: ChannelAccountRef): Promise<ChannelSecrets>;
}

/** fetch-compatible function, injected into adapters so tests can mock HTTP. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Options shared by the real (Fase 1) adapters. */
export interface RealAdapterOptions {
  credentials: CredentialProvider;
  fetchFn?: FetchLike;
}
