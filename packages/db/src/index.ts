export * as schema from "./schema";
export {
  workspaces, users, workspaceMembers, channelAccounts, contacts,
  conversations, messages, savedReplies, templates, broadcasts, broadcastRecipients, costLedger,
  webchatSessions, scheduledPosts, sequences, sequenceEnrollments,
  tokenVault, workspaceDomains, auditLog, kbDocuments, kbChunks,
  dataDeletionRequests, flows, flowWaits, apiTokens, processedComments, growthLinks,
  catalogProducts, platformSettings, pipelines, pipelineStages, deals,
  webhookEndpoints, webhookDeliveries, webhookReceipts,
} from "./schema";
export { getDb, closeDb, type Database } from "./client";
/** Re-exported so API/worker code can build raw SQL fragments without depending on drizzle-orm directly. */
export { sql } from "drizzle-orm";
export * from "./repositories";
export {
  TokenVault, InMemoryVaultStore, createDbVaultStore, createTokenVault,
  parseVaultKey, sealSecret, unsealSecret, vaultRefFor, parseVaultRef,
  type SealedSecret, type VaultStore, type VaultAuditSink,
} from "./vault";
export {
  MANAGED_SETTINGS, MANAGED_SETTING_KEYS, managedSettingDef,
  PlatformSettingsService, DbPlatformSettingsStorage, InMemoryPlatformSettingsStorage,
  sealSettingValue, unsealSettingValue, tryParseVaultKey,
  resolveEffectiveEnv, applyEffectiveEnv, startEffectiveEnvRefresh,
  type EnvLike, type ManagedSettingDef, type ManagedSettingGroup,
  type PlatformSettingsStorage, type PlatformSettingView,
  type PlatformSettingsServiceOptions, type EffectiveEnvRefresher,
} from "./platform-settings";
