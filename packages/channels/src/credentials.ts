import type { ChannelAccountRef, ChannelSecrets, CredentialProvider } from "./types";

/** In-memory provider - tests and single-process dev only. */
export class StaticCredentialProvider implements CredentialProvider {
  constructor(private readonly secrets: ChannelSecrets) {}
  async resolve(): Promise<ChannelSecrets> {
    return this.secrets;
  }
}

export interface EnvCredentialProviderOptions {
  /** Env var holding the Meta access token (channel accounts). */
  tokenEnv?: string;
  /** Env var holding the Telegram bot token. */
  botTokenEnv?: string;
  /** Env var holding the Meta app secret (webhook signature verification). */
  appSecretEnv?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Dev/local credential provider backed by environment variables.
 *
 * Resolution order for the token:
 * 1. `account.tokenVaultRef` of the form `env:VAR_NAME` -> that env var
 *    (this is how a vault ref stays meaningful before a real vault exists);
 * 2. the configured channel env var (WHATSAPP_ACCESS_TOKEN / TELEGRAM_BOT_TOKEN).
 *
 * Secrets are read at call time and never cached on the account object,
 * never logged, never persisted.
 */
export class EnvCredentialProvider implements CredentialProvider {
  private readonly tokenEnv?: string;
  private readonly botTokenEnv?: string;
  private readonly appSecretEnv?: string;
  private readonly env: Record<string, string | undefined>;

  constructor(options: EnvCredentialProviderOptions = {}) {
    this.tokenEnv = options.tokenEnv;
    this.botTokenEnv = options.botTokenEnv;
    this.appSecretEnv = options.appSecretEnv;
    this.env = options.env ?? process.env;
  }

  async resolve(account: ChannelAccountRef): Promise<ChannelSecrets> {
    const fromRef = account.tokenVaultRef?.startsWith("env:")
      ? this.env[account.tokenVaultRef.slice("env:".length)]
      : undefined;
    return {
      accessToken: fromRef ?? (this.tokenEnv ? this.env[this.tokenEnv] : undefined),
      botToken: fromRef ?? (this.botTokenEnv ? this.env[this.botTokenEnv] : undefined),
      appSecret: this.appSecretEnv ? this.env[this.appSecretEnv] : undefined,
    };
  }
}

/** Preconfigured providers for the two real Fase 1 channels. */
export const envWhatsAppCredentials = (): CredentialProvider =>
  new EnvCredentialProvider({ tokenEnv: "WHATSAPP_ACCESS_TOKEN", appSecretEnv: "META_APP_SECRET" });

export const envTelegramCredentials = (): CredentialProvider =>
  new EnvCredentialProvider({ botTokenEnv: "TELEGRAM_BOT_TOKEN" });
