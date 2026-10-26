import { AppError } from "@botara/shared";
import type { Database } from "./client";
import {
  deletePlatformSetting, listPlatformSettings, upsertPlatformSetting,
  type PlatformSettingRow,
} from "./repositories";
import { parseVaultKey, sealSecret, unsealSecret, type SealedSecret } from "./vault";

/**
 * Platform settings service (admin panel).
 *
 * WHY THIS LIVES IN @botara/db: the service is persistence + vault crypto.
 * The rows live in a @botara/db table (repositories.ts) and the encryption
 * primitives (AES-256-GCM seal/unseal, TOKEN_VAULT_KEY parsing) live in
 * vault.ts - both already here. The managed-key registry below is pure
 * data (env var names); @botara/config's env schema remains the separate
 * validation layer and deliberately gains no DB dependency.
 *
 * RESOLUTION ORDER (the operator contract): DB setting -> env -> unset.
 * Processes build an "effective env" at startup by overlaying decrypted
 * DB values onto their env, and a 60s refresher re-applies the overlay so
 * panel edits propagate without restarts. Bootstrap secrets are NOT
 * panel-managed (SESSION_SECRET, TOKEN_VAULT_KEY, DATABASE_URL, REDIS_URL,
 * PORT_*): the vault key encrypts the settings themselves, and the session
 * secret / DB / Redis coordinates are needed before the DB can be read.
 */

export type EnvLike = Record<string, string | undefined>;

export type ManagedSettingGroup =
  | "meta" | "threads" | "instagram" | "tiktok" | "telegram" | "storage" | "email" | "ai";

export interface ManagedSettingDef {
  key: string;
  secret: boolean;
  group: ManagedSettingGroup;
  label: string;
  hint?: string;
}

/**
 * The managed keys - ONLY env vars the code genuinely reads (traced via
 * deps.env / process.env reads in apps/api, apps/worker, packages/channels
 * credential providers, packages/media, packages/ai). Notably EXCLUDED:
 * RESEND_FROM_EMAIL (declared in the config schema + env examples but no
 * runtime code consumes it - the email adapter derives the sender from
 * the channel account) and the per-account `env:` vault-ref stubs are
 * covered by the *_ACCESS_TOKEN fallbacks below.
 */
export const MANAGED_SETTINGS: ManagedSettingDef[] = [
  // Meta platform (incl. WhatsApp + Messenger, which ride the Meta app)
  { key: "META_APP_ID", secret: false, group: "meta", label: "Meta App ID", hint: "developers.facebook.com app id; enables OAuth connects + Embedded Signup." },
  { key: "META_APP_SECRET", secret: true, group: "meta", label: "Meta App Secret", hint: "Verifies webhook signatures (X-Hub-Signature-256) and signed requests." },
  { key: "META_GRAPH_VERSION", secret: false, group: "meta", label: "Meta Graph API version", hint: "Pinned Graph version for onboarding/catalog calls (default v26.0)." },
  { key: "META_VERIFY_TOKEN", secret: true, group: "meta", label: "Meta webhook verify token", hint: "Challenge token for Meta/Threads webhook verification." },
  { key: "WHATSAPP_VERIFY_TOKEN", secret: true, group: "meta", label: "WhatsApp webhook verify token", hint: "Challenge token for the WhatsApp webhook; also the META_VERIFY_TOKEN fallback." },
  { key: "WHATSAPP_EMBEDDED_CONFIG_ID", secret: false, group: "meta", label: "WhatsApp Embedded Signup config ID", hint: "From the WhatsApp product settings; the Connect button appears only when set." },
  { key: "WHATSAPP_ACCESS_TOKEN", secret: true, group: "meta", label: "WhatsApp access token (env fallback)", hint: "Fallback credential for accounts without a vault token." },
  { key: "MESSENGER_ACCESS_TOKEN", secret: true, group: "meta", label: "Messenger access token (env fallback)", hint: "Fallback credential for accounts without a vault token." },
  // Threads (separate app)
  { key: "THREADS_APP_ID", secret: false, group: "threads", label: "Threads App ID" },
  { key: "THREADS_APP_SECRET", secret: true, group: "threads", label: "Threads App Secret", hint: "Falls back to the Meta app secret when unset." },
  { key: "THREADS_VERIFY_TOKEN", secret: true, group: "threads", label: "Threads webhook verify token", hint: "Falls back to the Meta verify token when unset." },
  { key: "THREADS_ACCESS_TOKEN", secret: true, group: "threads", label: "Threads access token (env fallback)" },
  // Instagram
  { key: "INSTAGRAM_APP_ID", secret: false, group: "instagram", label: "Instagram App ID", hint: "Business Login for Instagram; falls back to the Meta App ID when unset." },
  { key: "INSTAGRAM_APP_SECRET", secret: true, group: "instagram", label: "Instagram App Secret", hint: "Falls back to the Meta App Secret when unset." },
  { key: "INSTAGRAM_ACCESS_TOKEN", secret: true, group: "instagram", label: "Instagram access token (env fallback)" },
  // TikTok
  { key: "TIKTOK_APP_ID", secret: false, group: "tiktok", label: "TikTok App ID (client key)", hint: "From the TikTok for Business app portal; becomes the OAuth client_key." },
  { key: "TIKTOK_APP_SECRET", secret: true, group: "tiktok", label: "TikTok App Secret" },
  { key: "TIKTOK_ACCESS_TOKEN", secret: true, group: "tiktok", label: "TikTok access token (dev stub)", hint: "Development-only fallback; prefer the OAuth connect flow." },
  // Telegram
  { key: "TELEGRAM_BOT_TOKEN", secret: true, group: "telegram", label: "Telegram bot token (env fallback)", hint: "From @BotFather; per-workspace connect flows store their own in the vault." },
  { key: "TELEGRAM_WEBHOOK_SECRET", secret: true, group: "telegram", label: "Telegram webhook secret", hint: "Checked against X-Telegram-Bot-Api-Secret-Token." },
  // Cloudflare R2 (object storage for media)
  { key: "R2_ACCOUNT_ID", secret: false, group: "storage", label: "R2 account ID" },
  { key: "R2_ACCESS_KEY_ID", secret: false, group: "storage", label: "R2 access key ID" },
  { key: "R2_SECRET_ACCESS_KEY", secret: true, group: "storage", label: "R2 secret access key" },
  { key: "R2_BUCKET", secret: false, group: "storage", label: "R2 bucket", hint: "Default botara-media." },
  { key: "R2_PUBLIC_BASE_URL", secret: false, group: "storage", label: "R2 public base URL", hint: "Custom domain serving stored media, e.g. https://media.example.com." },
  // Resend (email)
  { key: "RESEND_API_KEY", secret: true, group: "email", label: "Resend API key" },
  { key: "RESEND_WEBHOOK_SECRET", secret: true, group: "email", label: "Resend webhook secret", hint: "Verifies inbound-email webhook signatures (Svix)." },
  // AI / LLM (OpenAI-compatible)
  { key: "AI_API_KEY", secret: true, group: "ai", label: "AI provider API key", hint: "No key = AI features answer 503 (never faked)." },
  { key: "AI_BASE_URL", secret: false, group: "ai", label: "AI base URL", hint: "OpenAI-compatible endpoint (default https://api.openai.com/v1)." },
  { key: "AI_MODEL", secret: false, group: "ai", label: "AI chat model" },
  { key: "AI_EMBEDDING_MODEL", secret: false, group: "ai", label: "AI embedding model" },
];

export const MANAGED_SETTING_KEYS: ReadonlySet<string> = new Set(MANAGED_SETTINGS.map((d) => d.key));

export function managedSettingDef(key: string): ManagedSettingDef | undefined {
  return MANAGED_SETTINGS.find((d) => d.key === key);
}

// ------------------------------------------------------------- sealed blobs

/**
 * A secret setting is stored as ONE text blob: the vault's SealedSecret
 * (ciphertext/iv/authTag, all base64) serialized as JSON in the
 * secret_ciphertext column. Same AES-256-GCM scheme as the token vault.
 */
export function sealSettingValue(vaultKey: Buffer, value: string): string {
  return JSON.stringify(sealSecret(vaultKey, value));
}

export function unsealSettingValue(vaultKey: Buffer, blob: string): string {
  let sealed: SealedSecret;
  try {
    sealed = JSON.parse(blob) as SealedSecret;
  } catch {
    throw new AppError("INTERNAL", "Stored platform setting is not a valid sealed blob.", { status: 500 });
  }
  return unsealSecret(vaultKey, sealed);
}

/** Parse TOKEN_VAULT_KEY leniently for settings use: null when unusable. */
export function tryParseVaultKey(raw: string | undefined): Buffer | null {
  try {
    return parseVaultKey(raw);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ storage

/** Persistence behind the settings service - Drizzle in production, in-memory in tests. */
export interface PlatformSettingsStorage {
  list(): Promise<PlatformSettingRow[]>;
  upsert(input: { key: string; value?: string | null; secretCiphertext?: string | null; updatedBy?: string }): Promise<PlatformSettingRow>;
  remove(key: string): Promise<boolean>;
}

export class DbPlatformSettingsStorage implements PlatformSettingsStorage {
  constructor(private readonly getDatabase: () => Database) {}

  async list() {
    return listPlatformSettings(this.getDatabase());
  }

  async upsert(input: { key: string; value?: string | null; secretCiphertext?: string | null; updatedBy?: string }) {
    return upsertPlatformSetting(this.getDatabase(), input);
  }

  async remove(key: string) {
    return deletePlatformSetting(this.getDatabase(), key);
  }
}

/** In-memory PlatformSettingsStorage for tests. */
export class InMemoryPlatformSettingsStorage implements PlatformSettingsStorage {
  readonly rows = new Map<string, PlatformSettingRow>();

  async list() {
    return [...this.rows.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  async upsert(input: { key: string; value?: string | null; secretCiphertext?: string | null; updatedBy?: string }) {
    const row: PlatformSettingRow = {
      key: input.key,
      value: input.value ?? null,
      secretCiphertext: input.secretCiphertext ?? null,
      updatedBy: input.updatedBy ?? null,
      updatedAt: new Date(),
    };
    this.rows.set(input.key, row);
    return row;
  }

  async remove(key: string) {
    return this.rows.delete(key);
  }
}

// ------------------------------------------------------------------ service

export interface PlatformSettingView {
  key: string;
  secret: boolean;
  group: ManagedSettingGroup;
  label: string;
  hint?: string;
  /** True when a value resolves from either source. */
  isSet: boolean;
  /**
   * Resolved plaintext for NON-secret settings only (app ids and config —
   * already public via /config/public), so the panel can prefill inputs.
   * Secret values NEVER leave the server: always null for secret keys.
   */
  value: string | null;
  source: "db" | "env" | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface PlatformSettingsServiceOptions {
  /** Pristine env baseline (fallback source). Snapshotted, never mutated. */
  baseEnv: EnvLike;
  /**
   * The process's live env object (e.g. process.env / deps.env). When
   * provided, setValue/clearValue apply the change to it IMMEDIATELY so
   * the writing process picks panel edits up without waiting for the
   * periodic refresh (other processes follow within one refresh cycle).
   */
  liveEnv?: EnvLike;
  /** AES-256-GCM key from TOKEN_VAULT_KEY; null = secrets cannot be set/read. */
  vaultKey: Buffer | null;
}

export class PlatformSettingsService {
  private readonly baseEnv: EnvLike;
  private readonly liveEnv?: EnvLike;
  private readonly vaultKey: Buffer | null;

  constructor(
    private readonly storage: PlatformSettingsStorage,
    options: PlatformSettingsServiceOptions,
  ) {
    this.baseEnv = { ...options.baseEnv };
    this.liveEnv = options.liveEnv;
    this.vaultKey = options.vaultKey;
  }

  /** The pristine env snapshot the fallback resolution reads from. */
  baseEnvSnapshot(): EnvLike {
    return this.baseEnv;
  }

  private requireDef(key: string): ManagedSettingDef {
    const def = managedSettingDef(key);
    if (!def) {
      throw new AppError("VALIDATION", `"${key}" is not a panel-managed setting.`, {
        status: 400,
        details: { key },
      });
    }
    return def;
  }

  private requireVaultKey(): Buffer {
    if (!this.vaultKey) {
      throw new AppError(
        "CONFIGURATION",
        "TOKEN_VAULT_KEY is not configured (or invalid); secret platform settings cannot be stored or read.",
        { status: 503 },
      );
    }
    return this.vaultKey;
  }

  private viewFor(def: ManagedSettingDef, row: PlatformSettingRow | undefined): PlatformSettingView {
    if (row) {
      return {
        key: def.key, secret: def.secret, group: def.group, label: def.label, hint: def.hint,
        isSet: true, source: "db",
        // Non-secret DB rows hold plaintext; secret rows hold ciphertext
        // in a separate column and their `value` column is always null.
        value: def.secret ? null : row.value,
        updatedAt: row.updatedAt.toISOString(), updatedBy: row.updatedBy,
      };
    }
    const envValue = this.baseEnv[def.key];
    const fromEnv = typeof envValue === "string" && envValue !== "";
    return {
      key: def.key, secret: def.secret, group: def.group, label: def.label, hint: def.hint,
      isSet: fromEnv, source: fromEnv ? "env" : null,
      value: !def.secret && fromEnv ? (envValue as string) : null,
      updatedAt: null, updatedBy: null,
    };
  }

  /** All managed keys with set/source metadata; values only for non-secret keys. */
  async listViews(): Promise<PlatformSettingView[]> {
    const rows = await this.storage.list();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return MANAGED_SETTINGS.map((def) => this.viewFor(def, byKey.get(def.key)));
  }

  async getView(key: string): Promise<PlatformSettingView> {
    const def = this.requireDef(key);
    const rows = await this.storage.list();
    return this.viewFor(def, rows.find((r) => r.key === key));
  }

  /**
   * Set (or replace) one setting. Secrets are sealed before storage; the
   * plaintext only ever lives in memory (and in liveEnv, like any env var).
   */
  async setValue(key: string, value: string, updatedBy?: string): Promise<PlatformSettingView> {
    const def = this.requireDef(key);
    if (typeof value !== "string" || value === "") {
      throw new AppError("VALIDATION", `Setting "${key}" needs a non-empty value (use clear to remove it).`, {
        status: 400,
      });
    }
    if (def.secret) {
      const sealed = sealSettingValue(this.requireVaultKey(), value);
      await this.storage.upsert({ key, secretCiphertext: sealed, updatedBy });
    } else {
      await this.storage.upsert({ key, value, updatedBy });
    }
    if (this.liveEnv) this.liveEnv[key] = value;
    return this.getView(key);
  }

  /** Remove the DB value; env fallback (if any) applies again immediately. */
  async clearValue(key: string, _updatedBy?: string): Promise<PlatformSettingView> {
    this.requireDef(key);
    void _updatedBy; // audit rows are written by the API layer (it owns the audit store)
    await this.storage.remove(key);
    if (this.liveEnv) {
      const fallback = this.baseEnv[key];
      if (fallback === undefined) delete this.liveEnv[key];
      else this.liveEnv[key] = fallback;
    }
    return this.getView(key);
  }

  /** Resolve one key: DB value (decrypted when secret) -> env -> undefined. */
  async resolveValue(key: string): Promise<string | undefined> {
    const rows = await this.storage.list();
    const row = rows.find((r) => r.key === key);
    if (row) {
      if (row.secretCiphertext) return unsealSettingValue(this.requireVaultKey(), row.secretCiphertext);
      if (row.value !== null) return row.value;
    }
    return this.baseEnv[key];
  }

  /**
   * All DB-held values (decrypted), keyed by env name - the overlay source.
   * A row that cannot be decrypted (wrong/rotated vault key) is SKIPPED and
   * reported via onError so one bad row never breaks process startup; the
   * env fallback for that key then applies.
   */
  async resolveDbValues(onError?: (key: string, err: unknown) => void): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const rows = await this.storage.list();
    for (const row of rows) {
      if (!MANAGED_SETTING_KEYS.has(row.key)) continue;
      try {
        if (row.secretCiphertext) {
          if (!this.vaultKey) throw new Error("TOKEN_VAULT_KEY unavailable");
          out[row.key] = unsealSettingValue(this.vaultKey, row.secretCiphertext);
        } else if (row.value !== null) {
          out[row.key] = row.value;
        }
      } catch (err) {
        onError?.(row.key, err);
      }
    }
    return out;
  }
}

// ------------------------------------------------------- effective-env overlay

/**
 * resolveEffectiveEnv(db, baseEnv): the base env overlaid with every DB
 * platform setting (DB wins). Pure with respect to its inputs - the base
 * env object is not mutated.
 */
export async function resolveEffectiveEnv(db: Database, baseEnv: EnvLike): Promise<EnvLike> {
  const service = new PlatformSettingsService(new DbPlatformSettingsStorage(() => db), {
    baseEnv,
    vaultKey: tryParseVaultKey(baseEnv.TOKEN_VAULT_KEY),
  });
  const dbValues = await service.resolveDbValues();
  return { ...baseEnv, ...dbValues };
}

/**
 * Mutate `target` so its MANAGED keys match the effective env computed
 * from `baseEnv`: DB value when present, env fallback otherwise, deleted
 * when neither has it. Non-managed keys are never touched.
 */
export function applyEffectiveEnv(target: EnvLike, effective: EnvLike): void {
  for (const def of MANAGED_SETTINGS) {
    const value = effective[def.key];
    if (value === undefined) delete target[def.key];
    else target[def.key] = value;
  }
}

export interface EffectiveEnvRefresher {
  /** Re-read the DB and re-apply the overlay to the target now. */
  refreshNow(): Promise<void>;
  stop(): void;
}

/**
 * Periodic overlay refresh (default 60s, unref'd so it never keeps a
 * process alive). The base env is snapshotted ONCE at creation - callers
 * must create the refresher BEFORE anything mutates the target, so the
 * snapshot stays the pristine env fallback.
 */
export function startEffectiveEnvRefresh(options: {
  db: Database;
  target: EnvLike;
  baseEnv?: EnvLike;
  intervalMs?: number;
  onError?: (err: unknown) => void;
}): EffectiveEnvRefresher {
  const baseEnv = options.baseEnv ?? { ...options.target };
  const refreshNow = async (): Promise<void> => {
    try {
      const effective = await resolveEffectiveEnv(options.db, baseEnv);
      applyEffectiveEnv(options.target, effective);
    } catch (err) {
      options.onError?.(err);
    }
  };
  const timer = setInterval(() => void refreshNow(), options.intervalMs ?? 60_000);
  (timer as { unref?: () => void }).unref?.();
  return { refreshNow, stop: () => clearInterval(timer) };
}
