#!/usr/bin/env bun
/**
 * One-off ops tool: pin the WhatsApp TEST WABA's webhook delivery to
 * Botara with a per-WABA callback override.
 *
 * Why this exists: scripts/provision-wa-test-number.ts subscribed the
 * app to the test WABA with a PLAIN POST /{wabaId}/subscribed_apps (no
 * body), so deliveries follow the APP-LEVEL webhook callback configured
 * in the Meta dashboard. In the 2026-10-27 test-number incident that
 * configuration never reached dev.botara.my.id — Meta's delivery list
 * showed "messages" events while Botara's API log showed zero webhook
 * hits. The same subscription call accepts a JSON body
 * { override_callback_uri, verify_token } (documented identically in
 * Meta's WhatsApp Cloud API and Embedded Signup collections, see the
 * 2026-10-27 Postman cross-check §5): with it, deliveries for THIS WABA
 * go to the override endpoint regardless of the app-level config.
 *
 * The override is deliberately scoped to the shared test WABA.
 * Production customer WABAs use the standard app-level callback model —
 * do not generalize this into onboarding.
 *
 * Token hygiene:
 *   - the access token comes ONLY from the encrypted TokenVault,
 *     resolved through VaultCredentialProvider over the provisioned
 *     account's token_vault_ref — exactly how the API/worker send paths
 *     resolve it. It is never read from env and never printed;
 *   - the webhook verify token (a shared config string, not an access
 *     credential) comes from WHATSAPP_VERIFY_TOKEN env and is never
 *     printed either — the summary reports only whether it was set.
 *
 * Usage (on the server, from the repo root, .env sourced):
 *   bun run scripts/set-wa-test-callback-override.ts
 *
 * Env:
 *   WORKSPACE_ID            default 5a8621e0-95a0-4d7d-960e-45c1c7808836
 *                           (the trial workspace the test number lives in)
 *   WA_PHONE_NUMBER_ID      default 1361611993704410 (Meta's test number)
 *   WA_WABA_ID              default 2227032434830165 (the test WABA)
 *   PUBLIC_WEBHOOK_BASE_URL (required) override URL = {base}/webhooks/whatsapp
 *   WHATSAPP_VERIFY_TOKEN   (required) webhook verify token for the override
 *   META_GRAPH_VERSION      default "v26.0" (same default as onboarding)
 *   DATABASE_URL, TOKEN_VAULT_KEY - the real DB + vault, as in production
 */
// Imported by relative path on purpose: scripts/ sits outside the
// workspaces (same convention as scripts/provision-wa-test-number.ts).
import { VaultCredentialProvider, type FetchLike } from "../packages/channels/src/index";
import {
  createTokenVault, getDb, getWorkspaceById, listChannelAccounts,
} from "../packages/db/src/index";

// ------------------------------------------------------------- core (tested)

export interface WaTestOverrideAccount {
  id: string;
  externalId: string;
  tokenVaultRef: string | null;
}

export interface WaTestOverrideAccountsPort {
  findExisting(workspaceId: string, externalId: string): Promise<WaTestOverrideAccount | null>;
}

export interface WaTestOverrideCredentialsPort {
  /** Resolve the account's access token from its vault ref (never env). */
  resolveAccessToken(account: WaTestOverrideAccount): Promise<string | null>;
}

export interface SetWaTestCallbackOverrideDeps {
  accounts: WaTestOverrideAccountsPort;
  credentials: WaTestOverrideCredentialsPort;
  fetchFn: FetchLike;
  graphVersion?: string;
  baseUrl?: string;
}

export interface SetWaTestCallbackOverrideInput {
  workspaceId: string;
  phoneNumberId: string;
  wabaId: string;
  overrideCallbackUri: string;
  /** undefined when WHATSAPP_VERIFY_TOKEN was not set — the core fails honestly. */
  verifyToken?: string;
}

export interface SetWaTestCallbackOverrideResult {
  accountId: string;
  workspaceId: string;
  externalId: string;
  wabaId: string;
  overrideCallbackUri: string;
  /** Whether a verify token was supplied (its value is never reported). */
  verifyTokenSet: boolean;
  subscribed: "subscribed" | "failed";
  /** Meta's error message when the subscription call was rejected. */
  error?: string;
  // Deliberately NO access token / verify token / vault internals here.
}

export async function setWaTestCallbackOverride(
  deps: SetWaTestCallbackOverrideDeps,
  input: SetWaTestCallbackOverrideInput,
): Promise<SetWaTestCallbackOverrideResult> {
  const version = deps.graphVersion ?? "v26.0";
  const base = (deps.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "");

  // Fail honestly on every missing prerequisite — this tool's only job
  // is the override call, so there is no partial success to report.
  const account = await deps.accounts.findExisting(input.workspaceId, input.phoneNumberId);
  if (!account) {
    throw new Error(
      `No WhatsApp channel account for phone_number_id ${input.phoneNumberId} in workspace ${input.workspaceId} — run scripts/provision-wa-test-number.ts first.`,
    );
  }
  if (!account.tokenVaultRef) {
    throw new Error(
      `Channel account ${account.id} has no token_vault_ref — provision the test number first (its token lives in the vault).`,
    );
  }
  if (!input.verifyToken) {
    throw new Error(
      "WHATSAPP_VERIFY_TOKEN is not set — the override body needs the webhook verify token (reported only as set/unset, never printed).",
    );
  }
  const accessToken = await deps.credentials.resolveAccessToken(account);
  if (!accessToken) {
    throw new Error(
      "Could not resolve an access token for the test account from the vault — the temporary token has likely expired; re-run the provisioning script with a fresh one.",
    );
  }

  let subscribed: "subscribed" | "failed" = "failed";
  let error: string | undefined;
  try {
    const res = await deps.fetchFn(`${base}/${version}/${input.wabaId}/subscribed_apps`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        override_callback_uri: input.overrideCallbackUri,
        verify_token: input.verifyToken,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: number };
    };
    if (res.ok && !json.error) {
      subscribed = "subscribed";
    } else {
      error = json.error?.message ?? `HTTP ${res.status}`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    accountId: account.id,
    workspaceId: input.workspaceId,
    externalId: input.phoneNumberId,
    wabaId: input.wabaId,
    overrideCallbackUri: input.overrideCallbackUri,
    verifyTokenSet: true,
    subscribed,
    ...(error ? { error } : {}),
  };
}

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  const env = process.env;
  if (!env.DATABASE_URL || !env.TOKEN_VAULT_KEY) {
    console.error("ERROR: DATABASE_URL and TOKEN_VAULT_KEY must be set (source the server .env first).");
    process.exit(1);
  }
  const publicBase = env.PUBLIC_WEBHOOK_BASE_URL?.trim().replace(/\/$/, "");
  if (!publicBase) {
    console.error("ERROR: PUBLIC_WEBHOOK_BASE_URL must be set — the override URL is {PUBLIC_WEBHOOK_BASE_URL}/webhooks/whatsapp.");
    process.exit(1);
  }

  const workspaceId = env.WORKSPACE_ID?.trim() || "5a8621e0-95a0-4d7d-960e-45c1c7808836";
  const db = getDb(env.DATABASE_URL);
  const workspace = await getWorkspaceById(db, workspaceId);
  if (!workspace) {
    console.error(`ERROR: workspace ${workspaceId} not found.`);
    process.exit(1);
  }

  const vault = createTokenVault(db, env);
  // The production credential path: VaultCredentialProvider over the
  // account's token_vault_ref, exactly as apps/api wires the adapters.
  const provider = new VaultCredentialProvider({ getSecret: (ref) => vault.get(ref) });

  const result = await setWaTestCallbackOverride(
    {
      accounts: {
        async findExisting(wsId, externalId) {
          const rows = await listChannelAccounts(db, wsId);
          const row = rows.find((r) => r.channel === "whatsapp" && r.externalId === externalId);
          return row ? { id: row.id, externalId: row.externalId, tokenVaultRef: row.tokenVaultRef } : null;
        },
      },
      credentials: {
        async resolveAccessToken(account) {
          const secrets = await provider.resolve({
            id: account.id,
            externalId: account.externalId,
            tokenVaultRef: account.tokenVaultRef ?? undefined,
          });
          return secrets.accessToken ?? null;
        },
      },
      fetchFn: (url, init) => fetch(url, init as RequestInit),
      graphVersion: env.META_GRAPH_VERSION ?? "v26.0",
    },
    {
      workspaceId,
      phoneNumberId: env.WA_PHONE_NUMBER_ID?.trim() || "1361611993704410",
      wabaId: env.WA_WABA_ID?.trim() || "2227032434830165",
      overrideCallbackUri: `${publicBase}/webhooks/whatsapp`,
      verifyToken: env.WHATSAPP_VERIFY_TOKEN?.trim() || undefined,
    },
  );

  console.log("WhatsApp test WABA callback override:");
  console.log(`  account id:   ${result.accountId}`);
  console.log(`  workspace:    ${result.workspaceId}`);
  console.log(`  waba:         ${result.wabaId}`);
  console.log(`  override URL: ${result.overrideCallbackUri}`);
  console.log(`  verify token: ${result.verifyTokenSet ? "set" : "not set"} (value never printed)`);
  console.log(`  subscribed:   ${result.subscribed}`);
  if (result.subscribed === "failed") {
    console.error(`  ERROR: subscribed_apps with override failed${result.error ? `: ${result.error}` : ""}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
