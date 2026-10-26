/** Standard error taxonomy for the whole platform. */
export const ERROR_CODES = [
  "NOT_IMPLEMENTED",
  "VALIDATION",
  "NOT_FOUND",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "CONFLICT",
  "RATE_LIMITED",
  "PROVIDER_ERROR",
  "AI_RESPONSE_INVALID",
  "TOKEN_EXPIRED",
  "MESSAGING_WINDOW_CLOSED",
  "CONSECUTIVE_SEND_CAP",
  "CHANNEL_INITIATION_UNSUPPORTED",
  "CHANNEL_ACCOUNT_DISCONNECTED",
  "CONVERSATION_ADDRESS_MISSING",
  "CONFIGURATION",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, options?: { status?: number; details?: unknown }) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = options?.status ?? defaultStatusFor(code);
    this.details = options?.details;
  }
}

function defaultStatusFor(code: ErrorCode): number {
  switch (code) {
    case "VALIDATION": return 400;
    case "UNAUTHORIZED": return 401;
    case "FORBIDDEN": return 403;
    case "NOT_FOUND": return 404;
    case "CONFLICT": return 409;
    case "RATE_LIMITED": return 429;
    case "NOT_IMPLEMENTED": return 501;
    default: return 500;
  }
}

export class NotImplementedError extends AppError {
  constructor(what: string) {
    super("NOT_IMPLEMENTED", `${what} is not implemented yet (Fase 0 stub)`);
    this.name = "NotImplementedError";
  }
}

/**
 * A send was attempted on a channel that cannot initiate conversations
 * (reactive-only channels such as TikTok: the customer must message first,
 * and broadcasts / sequences / growth outreach are provider-forbidden).
 * Raised by the broadcast + sequence create routes and by the worker
 * fan-out processors as a backstop, always with the surface named.
 */
export class ChannelInitiationError extends AppError {
  constructor(channel: string, surface: string) {
    super(
      "CHANNEL_INITIATION_UNSUPPORTED",
      `${surface} is not supported on ${channel}: this channel is reactive-only and cannot initiate conversations.`,
      { status: 400, details: { channel, surface } },
    );
    this.name = "ChannelInitiationError";
  }
}

/**
 * A send was attempted through a channel account that is not connected
 * (soft-disconnected from the Channels page, or purged). The account row
 * and its history survive a soft disconnect, but nothing may be sent
 * through it until it is reconnected.
 */
export class ChannelAccountDisconnectedError extends AppError {
  constructor(channel: string) {
    super(
      "CHANNEL_ACCOUNT_DISCONNECTED",
      `Cannot send on ${channel}: this channel account is disconnected. Reconnect it from the Channels page to send again.`,
      { status: 409, details: { channel } },
    );
    this.name = "ChannelAccountDisconnectedError";
  }
}

/**
 * A send was attempted on a conversation-addressed channel (TikTok) without
 * the provider conversation id (and without a comment-reply reference that
 * could open one). The send cannot be addressed at all - failing typed here
 * beats guessing a recipient the provider would reject or misroute.
 */
export class ConversationAddressMissingError extends AppError {
  constructor(channel: string) {
    super(
      "CONVERSATION_ADDRESS_MISSING",
      `Cannot send on ${channel}: no provider conversation id is known for this conversation yet (the customer must message first, or the send must open a comment reply).`,
      { status: 422, details: { channel } },
    );
    this.name = "ConversationAddressMissingError";
  }
}
