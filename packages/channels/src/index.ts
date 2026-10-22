export {
  CHANNEL_CAPABILITIES, type CapabilitySet, type ChannelKey, type InboundEvent,
  type ChannelAccountRef, type SendInput, type SendTemplateInput, type SendResult,
  type PublishInput, type AdapterHealth, type ChannelAdapter, type MessageMedia,
  type MessageStatusError, type ChannelSecrets, type CredentialProvider, type FetchLike,
  type RealAdapterOptions,
} from "./types";
export { PlaceholderAdapter, registerAdapter, getAdapter, listAdapters } from "./registry";
export {
  ProviderApiError, ProviderAuthError, ProviderRateLimitError,
  TemplateCategoryMismatchError, MarketingPausedError, type ProviderErrorDetails,
} from "./errors";
export {
  StaticCredentialProvider, EnvCredentialProvider, envWhatsAppCredentials,
  envTelegramCredentials, type EnvCredentialProviderOptions,
} from "./credentials";
export {
  WhatsAppAdapter, routeForTemplateCategory, mapWhatsAppError,
  verifyWebhookSignature, verifyWebhookChallenge,
  type WhatsAppAdapterOptions, type WhatsAppRoute,
} from "./whatsapp";
export { TelegramAdapter, type TelegramAdapterOptions } from "./telegram";
