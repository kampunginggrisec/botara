import { createTokenVault, getChannelAccountById, getDb, updateChannelAccountToken } from "@botara/db";
import {
  VaultCredentialProvider, configureAdapterCredentials, configureTikTokTokenPersistence,
  envEmailCredentials, envInstagramCredentials, envMessengerCredentials,
  envTelegramCredentials, envThreadsCredentials, envTikTokCredentials, envWhatsAppCredentials,
  type ChannelKey, type CredentialProvider,
} from "@botara/channels";
import { assertProductionEnv } from "@botara/config";
import { createApp, defaultDeps } from "./app";

/**
 * Botara API entrypoint (Bun runtime). All route logic lives in app.ts
 * (createApp with injectable deps, used by tests and the smoke check);
 * this file only validates the environment, wires production defaults,
 * and serves.
 *
 * Fase 3 startup behaviour:
 * - NODE_ENV=production refuses to boot when DATABASE_URL, SESSION_SECRET
 *   or TOKEN_VAULT_KEY is missing (fail fast, never boot insecure).
 * - When the DB + vault key are configured, every channel adapter resolves
 *   secrets through the encrypted token vault (env vars remain the
 *   per-channel fallback for accounts without a vault ref).
 *
 * Routes (Fase 1-3):
 *   GET  /health, GET /health/ready, GET /doc (OpenAPI)
 *   POST /auth/register, POST /auth/login, POST /auth/logout, GET /auth/me
 *   POST/GET /workspaces, GET/POST /workspaces/:id/members, DELETE .../members/:userId
 *   GET+POST /webhooks/whatsapp, POST /webhooks/telegram,
 *   GET+POST /webhooks/instagram|messenger|threads, POST /webhooks/resend,
 *   POST /webhooks/meta/data-deletion, GET /data-deletion/status/:code
 *   GET  /conversations, GET /conversations/:id/messages, POST /conversations/:id/reply
 *   POST /conversations/:id/ai-suggest, POST /moderation/check
 *   GET/POST /contacts, PATCH /contacts/:id, GET /segments
 *   GET/POST /templates, PATCH /templates/:id/category
 *   POST /broadcasts/estimate (public), POST /broadcasts, GET /broadcasts/:id
 *   GET  /channels/accounts, POST /channels/whatsapp/embedded-signup/exchange
 *   GET/POST /channels/email/domains
 *   POST /kb/documents, GET /kb/documents, GET/DELETE /kb/documents/:id
 *   POST /public/webchat/:workspaceId/session, GET+POST /public/webchat/:workspaceId/messages
 *   CRUD /posts + POST /posts/:id/publish-now
 *   CRUD /sequences + POST /sequences/:id/enroll
 */

try {
  assertProductionEnv(process.env);
} catch (err) {
  console.error(`[api] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const envCredentials: Record<string, () => CredentialProvider> = {
  whatsapp: envWhatsAppCredentials,
  telegram: envTelegramCredentials,
  instagram: envInstagramCredentials,
  messenger: envMessengerCredentials,
  threads: envThreadsCredentials,
  email: envEmailCredentials,
  tiktok: envTikTokCredentials,
  webchat: envWhatsAppCredentials, // unused - webchat resolves no secrets
};

if (process.env.DATABASE_URL && process.env.TOKEN_VAULT_KEY) {
  try {
    const db = getDb(process.env.DATABASE_URL);
    const vault = createTokenVault(db, process.env);
    configureAdapterCredentials((key: ChannelKey) =>
      new VaultCredentialProvider(
        { getSecret: (ref) => vault.get(ref) },
        envCredentials[key]?.(),
      ));
    // TikTok rotates its OAuth pair on refresh (incl. refresh-on-401):
    // persist every rotation back into the vault + account row.
    configureTikTokTokenPersistence(async ({ account, pair, serialized }) => {
      const row = await getChannelAccountById(db, account.id);
      if (!row) return;
      const ref = await vault.put({
        workspaceId: row.workspaceId, kind: "tiktok",
        label: row.displayName ?? "TikTok", secret: serialized,
      });
      await updateChannelAccountToken(db, row.id, {
        tokenVaultRef: ref,
        tokenExpiresAt: pair.expiresAt ? new Date(pair.expiresAt) : undefined,
        status: "connected",
      });
    });
    console.log("[api] channel credentials: token vault (env fallback per channel)");
  } catch (err) {
    console.error(`[api] token vault wiring failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const app = createApp(defaultDeps());

const port = Number(process.env.PORT_API ?? process.env.PORT ?? 3000);
console.log(`[api] listening on http://localhost:${port} (health: /health, openapi: /doc)`);

export default { port, fetch: app.fetch };
export { app };
