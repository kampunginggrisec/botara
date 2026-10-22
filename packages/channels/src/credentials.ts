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
  /** Env var holding a non-Meta webhook signing secret (Resend/Svix whsec_). */
  webhookSecretEnv?: string;
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
  private readonly webhookSecretEnv?: string;
  private readonly env: Record<string, string | undefined>;

  constructor(options: EnvCredentialProviderOptions = {}) {
    this.tokenEnv = options.tokenEnv;
    this.botTokenEnv = options.botTokenEnv;
    this.appSecretEnv = options.appSecretEnv;
    this.webhookSecretEnv = options.webhookSecretEnv;
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
      webhookSecret: this.webhookSecretEnv ? this.env[this.webhookSecretEnv] : undefined,
    };
  }
}

/** Resolves a vault reference (`vault:...`) to its decrypted secret. */
export interface VaultSecretResolver {
  getSecret(ref: string): Promise<string | null>;
}

/**
 * Vault-backed credential provider (Fase 3) - the production default.
 *
 * Resolution for an account, in order:
 * 1. `vault:` refs are resolved (decrypted) through the vault resolver.
 *    The single secret is placed in BOTH token slots: each adapter reads
 *    only its own slot (accessToken for Meta/Resend, botToken for
 *    Telegram), so one sealed value serves every channel shape.
 * 2. `env:VAR` refs read that env var (the Fase 1/2 dev behaviour).
 * 3. Otherwise the call delegates to the fallback provider (typically the
 *    per-channel EnvCredentialProvider).
 *
 * Secrets are resolved at send-time and never cached on the account row.
 */
export class VaultCredentialProvider implements CredentialProvider {
  constructor(
    private readonly vault: VaultSecretResolver,
    private readonly fallback?: CredentialProvider,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  async resolve(account: ChannelAccountRef): Promise<ChannelSecrets> {
    const ref = account.tokenVaultRef;
    if (ref?.startsWith("vault:")) {
      const secret = await this.vault.getSecret(ref);
      if (secret) return { accessToken: secret, botToken: secret };
    } else if (ref?.startsWith("env:")) {
      const value = this.env[ref.slice("env:".length)];
      if (value) return { accessToken: value, botToken: value };
    }
    if (this.fallback) return this.fallback.resolve(account);
    return {};
  }
}

/**
 * Ordered composition: providers are consulted in order and the first
 * non-empty value per secret slot wins.
 */
export class CompositeCredentialProvider implements CredentialProvider {
  constructor(private readonly providers: CredentialProvider[]) {}

  async resolve(account: ChannelAccountRef): Promise<ChannelSecrets> {
    const merged: ChannelSecrets = {};
    for (const provider of this.providers) {
      const secrets = await provider.resolve(account);
      merged.accessToken ??= secrets.accessToken;
      merged.botToken ??= secrets.botToken;
      merged.appSecret ??= secrets.appSecret;
      merged.webhookSecret ??= secrets.webhookSecret;
    }
    return merged;
  }
}

/** Preconfigured providers for the real channels (Fase 1 + Fase 2). */
export const envWhatsAppCredentials = (): CredentialProvider =>
  new EnvCredentialProvider({ tokenEnv: "WHATSAPP_ACCESS_TOKEN", appSecretEnv: "META_APP_SECRET" });

export const envTelegramCredentials = (): CredentialProvider =>
  new EnvCredentialProvider({ botTokenEnv: "TELEGRAM_BOT_TOKEN" });

export const envInstagramCredentials = (): CredentialProvider =>
  new EnvCredentialProvider({ tokenEnv: "INSTAGRAM_ACCESS_TOKEN", appSecretEnv: "META_APP_SECRET" });

export const envMessengerCredentials = (): CredentialProvider =>
  new EnvCredentialProvider({ tokenEnv: "MESSENGER_ACCESS_TOKEN", appSecretEnv: "META_APP_SECRET" });

export const envThreadsCredentials = (): CredentialProvider =>
  new EnvCredentialProvider({ tokenEnv: "THREADS_ACCESS_TOKEN", appSecretEnv: "THREADS_APP_SECRET" });

export const envEmailCredentials = (): CredentialProvider =>
  new EnvCredentialProvider({ tokenEnv: "RESEND_API_KEY", webhookSecretEnv: "RESEND_WEBHOOK_SECRET" });
