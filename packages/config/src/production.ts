/**
 * Production startup guard (Fase 3).
 *
 * When NODE_ENV=production the API must FAIL FAST at boot when a required
 * secret is missing, instead of starting in a degraded/insecure mode (e.g.
 * auth endpoints answering 503 forever, or - worse - a vault that cannot
 * encrypt). Development and test environments are unaffected: features that
 * need a missing secret answer 503 CONFIGURATION per request there.
 */
export const REQUIRED_PRODUCTION_ENV = ["DATABASE_URL", "SESSION_SECRET", "TOKEN_VAULT_KEY"] as const;

/** A non-empty env value, used without disclosing its value in diagnostics. */
function hasValue(env: Record<string, string | undefined>, name: string): boolean {
  return (env[name] ?? "").trim() !== "";
}

/** Names of required production env vars that are absent or empty. */
export function missingProductionEnv(
  env: Record<string, string | undefined>,
): string[] {
  if (env.NODE_ENV !== "production") return [];
  const missing: string[] = REQUIRED_PRODUCTION_ENV.filter((name) => !hasValue(env, name));

  // WhatsApp is optional for a deployment. Once an operator enables either
  // its webhook or Embedded Signup, though, an unsigned webhook must never
  // be accepted in production. Embedded Signup additionally needs an app id.
  if (hasValue(env, "WHATSAPP_VERIFY_TOKEN") && !hasValue(env, "META_APP_SECRET")) {
    missing.push("META_APP_SECRET (required when WHATSAPP_VERIFY_TOKEN is set)");
  }
  if (hasValue(env, "WHATSAPP_EMBEDDED_CONFIG_ID")) {
    if (!hasValue(env, "META_APP_ID")) {
      missing.push("META_APP_ID (required when WHATSAPP_EMBEDDED_CONFIG_ID is set)");
    }
    if (!hasValue(env, "META_APP_SECRET") && !missing.includes("META_APP_SECRET (required when WHATSAPP_VERIFY_TOKEN is set)")) {
      missing.push("META_APP_SECRET (required when WHATSAPP_EMBEDDED_CONFIG_ID is set)");
    }
  }
  return missing;
}

export interface ResolveBootEnvOptions {
  /**
   * Loads the panel (DB) overlay of the base env - injected by the caller
   * so this package stays free of DB dependencies. Only invoked when the
   * raw env carries both DATABASE_URL and TOKEN_VAULT_KEY (the overlay's
   * own prerequisites).
   */
  loadEffective?: (
    baseEnv: Record<string, string | undefined>,
  ) => Promise<Record<string, string | undefined>>;
  /** Notified when the overlay load fails and the raw env is used instead. */
  onOverlayError?: (err: unknown) => void;
}

/**
 * The env the production boot gate must judge: the process env overlaid
 * with the admin-panel (DB) settings when those are loadable, so a secret
 * stored ONLY in the panel satisfies the guard exactly like an env var -
 * the effective env is what the runtime handlers actually read. Env-only
 * installs (no DATABASE_URL / TOKEN_VAULT_KEY, or no loader wired)
 * resolve to the raw process env unchanged, and a failed overlay load
 * falls back to the raw env too: the gate then keeps its original
 * refusal semantics instead of booting on a guess.
 */
export async function resolveBootEnv(
  processEnv: Record<string, string | undefined>,
  options: ResolveBootEnvOptions = {},
): Promise<Record<string, string | undefined>> {
  const { loadEffective, onOverlayError } = options;
  if (!loadEffective || !hasValue(processEnv, "DATABASE_URL") || !hasValue(processEnv, "TOKEN_VAULT_KEY")) {
    return processEnv;
  }
  try {
    return await loadEffective(processEnv);
  } catch (err) {
    onOverlayError?.(err);
    return processEnv;
  }
}

/**
 * Throws an Error listing every missing required variable. Call at process
 * startup (API entrypoint) so a misconfigured production deploy crashes
 * loudly in the deploy logs instead of booting insecure.
 */
export function assertProductionEnv(env: Record<string, string | undefined>): void {
  const missing = missingProductionEnv(env);
  if (missing.length > 0) {
    throw new Error(
      `Refusing to start with NODE_ENV=production: missing required environment variable(s): ${missing.join(", ")}. ` +
        "Set them (see .env.production.example) or run with NODE_ENV=development.",
    );
  }
}
