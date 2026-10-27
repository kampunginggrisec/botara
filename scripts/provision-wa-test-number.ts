#!/usr/bin/env bun
/**
 * One-off provisioning: register Meta's WhatsApp TEST number as a real
 * `whatsapp` channel account in a chosen workspace.
 *
 * Why this exists: Meta's WhatsApp API Setup hands every app a shared test
 * number (default below: +1 (555) 651-4110) plus a temporary 24h access
 * token. Botara's only WhatsApp connect path is Embedded Signup, which
 * cannot onboard Meta's shared test number (no signup session ever happens
 * for it). This script bridges the gap by writing EXACTLY what a successful
 * Embedded Signup exchange writes (apps/api/src/whatsapp-onboarding.ts):
 *
 *   - the access token into the REAL encrypted TokenVault via
 *     vault.store({ channel: "whatsapp", label: "waba:{wabaId}" }) - the
 *     raw token never lands in channel_accounts, only the `vault:db:` ref;
 *   - one channel_accounts row via createChannelAccount with externalId =
 *     the phone_number_id, the WhatsApp capability snapshot, and
 *     status "connected" - so the normal dispatcher/send paths (which
 *     resolve the token from token_vault_ref through VaultCredentialProvider)
 *     pick the account up with no special-casing.
 *
 * The subscription call: onboarding now makes it too (step 6 of the
 * exchange, ES-1 fix), and this script attempts the same
 * POST /{wabaId}/subscribed_apps with the temp token because a
 * hand-provisioned test number never went through that flow
 * (best-effort - a failure is reported, never fatal). To additionally
 * pin this WABA's deliveries to Botara regardless of the app-level
 * webhook config, see scripts/set-wa-test-callback-override.ts.
 *
 * Idempotent: re-running for the same workspace + phone_number_id rotates
 * the stored token under the existing vault ref instead of duplicating the
 * account (the temp token expires after 24h, so re-running with a fresh
 * token is the expected refresh path).
 *
 * Usage (on the server, from the repo root):
 *   DATABASE_URL=... TOKEN_VAULT_KEY=... WORKSPACE_ID=<uuid> \
 *   WA_TEST_TOKEN=<temporary token> bun run scripts/provision-wa-test-number.ts
 *
 * Env:
 *   WORKSPACE_ID        (required) target workspace uuid
 *   WA_TEST_TOKEN       (required) temporary token from the Meta dashboard;
 *                       never printed by this script
 *   WA_PHONE_NUMBER_ID  default 1361611993704410 (Meta's test number)
 *   WA_WABA_ID          default 2227032434830165 (the test WABA)
 *   WA_DISPLAY_NAME     default "Nomor Uji Meta"
 *   META_GRAPH_VERSION  default "v26.0" (same default as onboarding)
 *   DATABASE_URL, TOKEN_VAULT_KEY - the real DB + vault, as in production
 */
// Imported by relative path on purpose: scripts/ sits outside the
// workspaces (same convention as scripts/check-deprecations.ts).
import { CHANNEL_CAPABILITIES, type FetchLike } from "../packages/channels/src/index";
import {
  createChannelAccount, createTokenVault, getDb, getWorkspaceById,
  listChannelAccounts, updateChannelAccountToken,
} from "../packages/db/src/index";

// ------------------------------------------------------------- core (tested)

export interface ProvisionVaultPort {
  /** Same shape onboarding uses: TokenVault.store / InMemoryVault.store. */
  store(input: { channel: string; workspaceId: string; label: string; secret: string }): Promise<string>;
  /** Replace the secret under an existing `vault:db:` ref (TokenVault.rotate). */
  rotate(ref: string, secret: string): Promise<void>;
}

export interface ProvisionAccountsPort {
  findExisting(
    workspaceId: string,
    externalId: string,
  ): Promise<{ id: string; tokenVaultRef: string | null } | null>;
  create(input: {
    workspaceId: string;
    channel: "whatsapp";
    externalId: string;
    displayName?: string;
    apiVersion: string;
    capabilities: Record<string, unknown>;
    isCoexistence: boolean;
    tokenVaultRef: string;
    status: string;
  }): Promise<{ id: string }>;
  /** Point an existing account at a (new) vault ref and mark it connected. */
  setTokenRef(accountId: string, tokenVaultRef: string): Promise<void>;
}

export interface ProvisionWaTestNumberDeps {
  vault: ProvisionVaultPort;
  accounts: ProvisionAccountsPort;
  fetchFn: FetchLike;
  graphVersion?: string;
  baseUrl?: string;
}

export interface ProvisionWaTestNumberInput {
  workspaceId: string;
  phoneNumberId: string;
  wabaId: string;
  displayName: string;
  accessToken: string;
}

export interface ProvisionWaTestNumberResult {
  accountId: string;
  workspaceId: string;
  externalId: string;
  /** true when a new channel_accounts row was created, false on token refresh. */
  created: boolean;
  /** true when the token was sealed into the vault (stored or rotated). */
  tokenStored: boolean;
  subscription: "subscribed" | "failed";
  // Deliberately NO access token / vault internals in this summary.
}

export async function provisionWaTestNumber(
  deps: ProvisionWaTestNumberDeps,
  input: ProvisionWaTestNumberInput,
): Promise<ProvisionWaTestNumberResult> {
  const version = deps.graphVersion ?? "v26.0";
  const base = (deps.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "");
  const label = `waba:${input.wabaId}`;

  const existing = await deps.accounts.findExisting(input.workspaceId, input.phoneNumberId);
  let accountId: string;
  let created = false;

  if (existing) {
    accountId = existing.id;
    const ref = existing.tokenVaultRef;
    if (ref?.startsWith("vault:db:")) {
      // Rotate in place: the account row (and every queued job holding the
      // ref) sees the fresh token immediately. A missing entry falls back
      // to a fresh store + ref swap.
      try {
        await deps.vault.rotate(ref, input.accessToken);
      } catch {
        const freshRef = await deps.vault.store({
          channel: "whatsapp", workspaceId: input.workspaceId, label, secret: input.accessToken,
        });
        await deps.accounts.setTokenRef(accountId, freshRef);
      }
    } else {
      const freshRef = await deps.vault.store({
        channel: "whatsapp", workspaceId: input.workspaceId, label, secret: input.accessToken,
      });
      await deps.accounts.setTokenRef(accountId, freshRef);
    }
  } else {
    const tokenVaultRef = await deps.vault.store({
      channel: "whatsapp", workspaceId: input.workspaceId, label, secret: input.accessToken,
    });
    const row = await deps.accounts.create({
      workspaceId: input.workspaceId,
      channel: "whatsapp",
      externalId: input.phoneNumberId,
      displayName: input.displayName,
      apiVersion: version,
      capabilities: CHANNEL_CAPABILITIES.whatsapp as unknown as Record<string, unknown>,
      isCoexistence: false,
      tokenVaultRef,
      status: "connected",
    });
    accountId = row.id;
    created = true;
  }

  // Best-effort: subscribe this app to the (test) WABA so Meta delivers its
  // webhooks. Never fails provisioning - the summary reports the outcome.
  let subscription: ProvisionWaTestNumberResult["subscription"] = "failed";
  try {
    const res = await deps.fetchFn(`${base}/${version}/${input.wabaId}/subscribed_apps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.accessToken}` },
    });
    const json = (await res.json().catch(() => ({}))) as { error?: unknown };
    if (res.ok && !json.error) subscription = "subscribed";
  } catch {
    subscription = "failed";
  }

  return {
    accountId,
    workspaceId: input.workspaceId,
    externalId: input.phoneNumberId,
    created,
    tokenStored: true,
    subscription,
  };
}

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  const env = process.env;
  const workspaceId = env.WORKSPACE_ID?.trim();
  const accessToken = env.WA_TEST_TOKEN?.trim();
  if (!workspaceId) {
    console.error("ERROR: WORKSPACE_ID is required (the target workspace uuid).");
    process.exit(1);
  }
  if (!accessToken) {
    console.error("ERROR: WA_TEST_TOKEN is required (the temporary token from Meta's WhatsApp API Setup page).");
    process.exit(1);
  }
  if (!env.DATABASE_URL || !env.TOKEN_VAULT_KEY) {
    console.error("ERROR: DATABASE_URL and TOKEN_VAULT_KEY must be set (the server wrapper exports them from ~/botara/.env).");
    process.exit(1);
  }

  const db = getDb(env.DATABASE_URL);
  const workspace = await getWorkspaceById(db, workspaceId);
  if (!workspace) {
    console.error(`ERROR: workspace ${workspaceId} not found.`);
    process.exit(1);
  }

  const vault = createTokenVault(db, env);
  const result = await provisionWaTestNumber(
    {
      vault: {
        store: (input) => vault.store(input),
        rotate: (ref, secret) => vault.rotate(ref, secret),
      },
      accounts: {
        async findExisting(wsId, externalId) {
          const rows = await listChannelAccounts(db, wsId);
          const row = rows.find((r) => r.channel === "whatsapp" && r.externalId === externalId);
          return row ? { id: row.id, tokenVaultRef: row.tokenVaultRef } : null;
        },
        async create(input) {
          const row = await createChannelAccount(db, input);
          return { id: row.id };
        },
        async setTokenRef(accountId, tokenVaultRef) {
          await updateChannelAccountToken(db, accountId, { tokenVaultRef, status: "connected" });
        },
      },
      fetchFn: (url, init) => fetch(url, init as RequestInit),
      graphVersion: env.META_GRAPH_VERSION ?? "v26.0",
    },
    {
      workspaceId,
      phoneNumberId: env.WA_PHONE_NUMBER_ID?.trim() || "1361611993704410",
      wabaId: env.WA_WABA_ID?.trim() || "2227032434830165",
      displayName: env.WA_DISPLAY_NAME?.trim() || "Nomor Uji Meta",
      accessToken,
    },
  );

  console.log("WhatsApp test number provisioned:");
  console.log(`  account id:   ${result.accountId} (${result.created ? "created" : "existing - token refreshed"})`);
  console.log(`  workspace:    ${result.workspaceId}`);
  console.log(`  externalId:   ${result.externalId} (phone_number_id)`);
  console.log(`  token stored: ${result.tokenStored ? "yes (encrypted vault)" : "no"}`);
  console.log(`  app subscribed to WABA: ${result.subscription}`);
  if (result.subscription === "failed") {
    console.warn("  WARNING: subscribed_apps failed - webhooks for the test number may not be delivered until the app is subscribed (check the token's whatsapp_business_messaging permission). Provisioning itself succeeded.");
  }
}

if (import.meta.main) {
  await main();
}
