export {
  CHANNEL_CAPABILITIES, type CapabilitySet, type ChannelKey, type InboundEvent,
  type ChannelAccountRef, type SendInput, type SendTemplateInput, type SendResult,
  type PublishInput, type AdapterHealth, type ChannelAdapter, type MessageMedia,
  type MessageAttachment, type MessageStatusError, type MessageReferral, type ChannelSecrets,
  type CredentialProvider, type FetchLike, type RealAdapterOptions,
} from "./types";
export {
  richBlockSchema, richButtonSchema, richButtonsBlockSchema, richListBlockSchema,
  richCarouselBlockSchema, richProductBlockSchema, richCatalogBlockSchema,
  richBlockText, richToPlainText,
  type RichBlock, type RichButton, type RichWarning,
} from "./rich";
export {
  PlaceholderAdapter, registerAdapter, getAdapter, listAdapters, configureAdapterCredentials,
} from "./registry";
export {
  ProviderApiError, ProviderAuthError, ProviderRateLimitError,
  TemplateCategoryMismatchError, MarketingPausedError, mapGraphError,
  type ProviderErrorDetails, type GraphErrorBodyShape,
} from "./errors";
export {
  StaticCredentialProvider, EnvCredentialProvider, VaultCredentialProvider,
  CompositeCredentialProvider, envWhatsAppCredentials,
  envTelegramCredentials, envInstagramCredentials, envMessengerCredentials,
  envThreadsCredentials, envEmailCredentials,
  type EnvCredentialProviderOptions, type VaultSecretResolver,
} from "./credentials";
export {
  evaluateLongLivedRefresh, type RefreshDecision, type LongLivedRefreshInput,
} from "./token-lifecycle";
export {
  WhatsAppAdapter, routeForTemplateCategory, mapWhatsAppError,
  verifyWebhookSignature, verifyWebhookChallenge,
  type WhatsAppAdapterOptions, type WhatsAppRoute,
} from "./whatsapp";
export { TelegramAdapter, type TelegramAdapterOptions } from "./telegram";
export {
  InstagramAdapter, buildInstagramAuthorizeUrl, instagramModeOf,
  INSTAGRAM_LOGIN_SCOPES, FACEBOOK_LOGIN_SCOPES,
  type InstagramAdapterOptions, type InstagramAuthMode,
} from "./instagram";
export {
  MessengerAdapter, buildMessengerAuthorizeUrl, MESSENGER_OAUTH_SCOPES,
  type MessengerAdapterOptions, type MessengerPageSummary,
} from "./messenger";
export {
  ThreadsAdapter, threadsRefreshDecision, buildThreadsAuthorizeUrl, THREADS_OAUTH_SCOPES,
  type ThreadsAdapterOptions,
} from "./threads";
export {
  WebchatAdapter, UnconfiguredWebchatStore,
  type WebchatStore, type WebchatAdapterOptions,
} from "./webchat";
export {
  EmailAdapter, verifyResendWebhookSignature,
  type EmailAdapterOptions, type InboundEmailContent,
} from "./email";
