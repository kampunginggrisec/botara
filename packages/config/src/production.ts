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

/** Names of required production env vars that are absent or empty. */
export function missingProductionEnv(
  env: Record<string, string | undefined>,
): string[] {
  if (env.NODE_ENV !== "production") return [];
  return REQUIRED_PRODUCTION_ENV.filter((name) => {
    const value = env[name];
    return value === undefined || value.trim() === "";
  });
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
