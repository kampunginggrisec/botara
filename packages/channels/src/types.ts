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
  /** WhatsApp only: where marketing-category sends must be routed. */
  marketingRoute?: "cloud-api" | "marketing-messages-api";
  /** Instagram only: supported OAuth flavours. */
  authModes?: Array<"instagram-login" | "facebook-login">;
  notes?: string;
}

export type ChannelKey = "whatsapp" | "instagram" | "messenger" | "threads" | "telegram" | "email";

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
    marketingRoute: "marketing-messages-api",
    notes: "Template-based outside the 24h window. Per-message pricing since 2025-07-01; service messages billed since 2026-10-01 after 1,000 free/number/month.",
  },
  instagram: {
    canDM: true, canPublish: true, canReplyToComments: true, canHideComments: true,
    canLike: true, canFetchInsights: true, canBroadcast: false, canScheduleNatively: false,
    authModes: ["instagram-login", "facebook-login"],
    notes: "Professional accounts only (Basic Display API retired 2024-12-04). Media is fetched by Meta from a public URL.",
  },
  messenger: {
    canDM: true, canPublish: false, canReplyToComments: true, canHideComments: true,
    canLike: false, canFetchInsights: true, canBroadcast: false, canScheduleNatively: false,
    notes: "Page-based. Customer Chat Plugin retired 2024-05-09 - webchat is Botara's own widget.",
  },
  threads: {
    canDM: false, canPublish: true, canReplyToComments: true, canHideComments: true,
    canLike: false, canFetchInsights: true, canBroadcast: false, canScheduleNatively: false,
    notes: "No DM API and no like API. Public reply + hide only for comment automation. Publishing quotas: 250 posts / 1,000 replies / 100 deletions per profile per 24h.",
  },
  telegram: {
    canDM: true, canPublish: true, canReplyToComments: false, canHideComments: false,
    canLike: false, canFetchInsights: false, canBroadcast: true, canScheduleNatively: false,
    notes: "Bot API. Channel posts = publish; groups/chats = DM-style messaging.",
  },
  email: {
    canDM: true, canPublish: false, canReplyToComments: false, canHideComments: false,
    canLike: false, canFetchInsights: true, canBroadcast: true, canScheduleNatively: false,
    notes: "Via Resend. Inbound webhook carries metadata only; content is fetched via the Receiving API.",
  },
};

/** Standardized inbound events every adapter must normalize webhooks into. */
export type InboundEvent =
  | { type: "message.received"; channel: ChannelKey; accountExternalId: string; contactExternalId: string; messageExternalId: string; text?: string; receivedAt: string }
  | { type: "comment.received"; channel: ChannelKey; accountExternalId: string; postExternalId: string; commentExternalId: string; text?: string; receivedAt: string }
  | { type: "mention.received"; channel: ChannelKey; accountExternalId: string; postExternalId: string; receivedAt: string }
  | { type: "message.status"; channel: ChannelKey; messageExternalId: string; status: "sent" | "delivered" | "read" | "failed"; receivedAt: string }
  | { type: "template.category_changed"; channel: ChannelKey; templateExternalId: string; newCategory: string; receivedAt: string };

export interface ChannelAccountRef {
  id: string;
  externalId: string;
  authMode?: string;
}

export interface SendInput {
  account: ChannelAccountRef;
  toExternalId: string;
  text?: string;
  templateName?: string;
  /** REQUIRED: providers are called with this key so retries never double-send. */
  idempotencyKey: string;
}

export interface SendResult {
  externalMessageId: string;
  status: "sent" | "queued";
}

export interface PublishInput {
  account: ChannelAccountRef;
  text?: string;
  mediaUrls?: string[];
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
