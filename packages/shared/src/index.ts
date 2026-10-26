export {
  AppError, NotImplementedError, ERROR_CODES, type ErrorCode,
  ChannelInitiationError, ChannelAccountDisconnectedError, ConversationAddressMissingError,
} from "./errors";
export {
  money, addMoney, usdToCents, startOfUtcMonth, addHours, isWithinWindow, type Money,
} from "./utils";
export { idSchema, slugSchema, paginationSchema, type Pagination } from "./schemas";
export {
  evaluateReplyWindow, channelEnforcesWindow, channelWindowHours, MessagingWindowClosedError,
  countConsecutiveOutbound, ConsecutiveSendCapError,
  WHATSAPP_FREE_FORM_WINDOW_HOURS, type ReplyKind, type ReplyWindowDecision,
} from "./window";
export {
  DISCONNECT_RETENTION_DAYS, disconnectPurgeAt, disconnectRetentionCutoff,
} from "./retention";
export {
  interpolate, buildVariableContext,
  type InterpolationWarning, type InterpolationResult, type VariableContext,
  type InterpolationContactInput, type InterpolationChannelInput,
} from "./variables";
export {
  API_TOKEN_RESOURCES, API_TOKEN_SCOPES, isApiTokenScope, parseApiTokenScopes,
  scopeCovers, grantsAnyRead, tokenIsRestricted,
  type ApiTokenResource, type ApiTokenScope, type ApiTokenScopeLevel,
} from "./api-tokens";
export {
  PRESENCE_KEY_PREFIX, PRESENCE_HEARTBEAT_MS, PRESENCE_TTL_SECONDS, presenceKey,
} from "./presence";
export {
  OUTBOUND_WEBHOOK_EVENTS, WEBHOOK_TEST_EVENT, isOutboundWebhookEvent, parseWebhookEvents,
  WEBHOOK_DELIVERY_MAX_ATTEMPTS, WEBHOOK_AUTO_DISABLE_FAILURES, WEBHOOK_HTTP_TIMEOUT_MS,
  WEBHOOK_MESSAGE_PREVIEW_CHARS, webhookMessagePreview,
  type OutboundWebhookEvent, type WebhookDeliveryEvent,
} from "./outbound-webhooks";
// NOTE: ./webhook-signing (node:crypto) and ./ssrf (node:dns) are
// deliberately NOT re-exported here - the root export is bundled into
// the web app. Server code imports them via subpaths:
//   "@botara/shared/webhook-signing", "@botara/shared/ssrf".
