#!/usr/bin/env bun
/**
 * One-off ops tool: send Meta's sample `hello_world` template from the
 * provisioned WhatsApp TEST number to the owner's personal number,
 * through Botara's real WhatsApp adapter.
 *
 * Why this exists: the 2026-10-27 test-number E2E proof. The inbound
 * leg (owner -> test number) produced no webhook even after the
 * per-WABA callback override (scripts/set-wa-test-callback-override.ts),
 * so the remaining diagnostic fork was to reverse the direction: the
 * test number sends FIRST and we watch whether Meta accepts the send
 * and whether delivery-status webhooks (sent / delivered / read) come
 * back to Botara's callback. This script is that reversed test, run
 * through the production send path — VaultCredentialProvider resolves
 * the vaulted token and WhatsAppAdapter builds and posts the payload,
 * exactly as the API/worker send.
 *
 * Token hygiene:
 *   - the access token comes ONLY from the encrypted TokenVault,
 *     resolved through VaultCredentialProvider over the provisioned
 *     account's token_vault_ref — exactly how the API/worker send paths
 *     resolve it. It is never read from env and never printed.
 *
 * Usage (on the server, from the repo root, .env sourced):
 *   bun run scripts/send-wa-test-template.ts
 *
 * Env:
 *   WORKSPACE_ID            default 5a8621e0-95a0-4d7d-960e-45c1c7808836
 *                           (the trial workspace the test number lives in)
 *   WA_PHONE_NUMBER_ID      default 1361611993704410 (Meta's test number)
 *   WA_TEST_RECIPIENT       default 6285790702476 (the owner's number, a
 *                           verified recipient on the test WABA)
 *   WA_TEMPLATE_NAME        default hello_world (Meta's sample template)
 *   WA_TEMPLATE_LANGUAGE    default en_US
 *   META_GRAPH_VERSION      default "v26.0" (same default as onboarding)
 *   DATABASE_URL, TOKEN_VAULT_KEY - the real DB + vault, as in production
 */
// Imported by relative path on purpose: scripts/ sits outside the
// workspaces (same convention as scripts/set-wa-test-callback-override.ts).
import {
  VaultCredentialProvider, WhatsAppAdapter,
  type CredentialProvider, type FetchLike,
} from "../packages/channels/src/index";
import {
  createTokenVault, getDb, getWorkspaceById, listChannelAccounts,
} from "../packages/db/src/index";

// ------------------------------------------------------------- core (tested)

export interface WaTestTemplateAccount {
  id: string;
  externalId: string;
  tokenVaultRef: string | null;
}

export interface WaTestTemplateAccountsPort {
  findExisting(workspaceId: string, externalId: string): Promise<WaTestTemplateAccount | null>;
}

export interface WaTestTemplateSenderPort {
  /**
   * Send a template message through the channel adapter. Resolves to
   * the provider message id Meta returned for the accepted send.
   */
  sendTemplate(input: {
    account: WaTestTemplateAccount;
    toExternalId: string;
    templateName: string;
    templateLanguage: string;
  }): Promise<{ externalMessageId: string }>;
}

export interface SendWaTestTemplateDeps {
  accounts: WaTestTemplateAccountsPort;
  sender: WaTestTemplateSenderPort;
}

export interface SendWaTestTemplateInput {
  workspaceId: string;
  phoneNumberId: string;
  recipient: string;
  templateName: string;
  templateLanguage: string;
}

export interface SendWaTestTemplateResult {
  accountId: string;
  workspaceId: string;
  externalId: string;
  recipient: string;
  templateName: string;
  templateLanguage: string;
  status: "sent" | "failed";
  /** Meta's wamid for the accepted message (present only when sent). */
  messageId?: string;
  /** Meta's error message when the send was rejected. */
  error?: string;
  /** Meta's numeric error code when the send was rejected. */
  errorCode?: number;
  // Deliberately NO access token / vault internals here.
}

export async function sendWaTestTemplate(
  deps: SendWaTestTemplateDeps,
  input: SendWaTestTemplateInput,
): Promise<SendWaTestTemplateResult> {
  // Fail honestly on every missing prerequisite — a misleading "sent"
  // would corrupt the E2E diagnosis this tool exists to settle.
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

  const base: SendWaTestTemplateResult = {
    accountId: account.id,
    workspaceId: input.workspaceId,
    externalId: input.phoneNumberId,
    recipient: input.recipient,
    templateName: input.templateName,
    templateLanguage: input.templateLanguage,
    status: "failed",
  };

  try {
    const sent = await deps.sender.sendTemplate({
      account,
      toExternalId: input.recipient,
      templateName: input.templateName,
      templateLanguage: input.templateLanguage,
    });
    return { ...base, status: "sent", messageId: sent.externalMessageId };
  } catch (err) {
    // The adapter maps Meta's error body onto ProviderApiError: its
    // message IS Meta's message, and details carries the numeric code.
    const details = (err as { details?: { providerCode?: number } }).details;
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
      ...(typeof details?.providerCode === "number" ? { errorCode: details.providerCode } : {}),
    };
  }
}

/**
 * The production sender: Botara's real WhatsAppAdapter, credentials via
 * the injected CredentialProvider (VaultCredentialProvider in main, so
 * the token flows vault -> provider -> adapter and nowhere else).
 * Exported so the tests exercise the exact wiring main runs.
 */
export function createAdapterSender(deps: {
  credentials: CredentialProvider;
  fetchFn?: FetchLike;
  graphVersion?: string;
}): WaTestTemplateSenderPort {
  const adapter = new WhatsAppAdapter({
    credentials: deps.credentials,
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
    ...(deps.graphVersion ? { graphVersion: deps.graphVersion } : {}),
  });
  return {
    async sendTemplate({ account, toExternalId, templateName, templateLanguage }) {
      const result = await adapter.send({
        account: {
          id: account.id,
          externalId: account.externalId,
          tokenVaultRef: account.tokenVaultRef ?? undefined,
        },
        toExternalId,
        template: {
          name: templateName,
          language: templateLanguage,
          // hello_world is Meta's UTILITY sample template; utility
          // routes to /messages (ADR-008). The adapter never guesses a
          // category, so the caller states it.
          latestCategory: "utility",
        },
        idempotencyKey: `wa-test-template:${account.id}:${toExternalId}:${templateName}`,
      });
      return { externalMessageId: result.externalMessageId };
    },
  };
}

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  const env = process.env;
  if (!env.DATABASE_URL || !env.TOKEN_VAULT_KEY) {
    console.error("ERROR: DATABASE_URL and TOKEN_VAULT_KEY must be set (source the server .env first).");
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

  const result = await sendWaTestTemplate(
    {
      accounts: {
        async findExisting(wsId, externalId) {
          const rows = await listChannelAccounts(db, wsId);
          const row = rows.find((r) => r.channel === "whatsapp" && r.externalId === externalId);
          return row ? { id: row.id, externalId: row.externalId, tokenVaultRef: row.tokenVaultRef } : null;
        },
      },
      sender: createAdapterSender({
        credentials: provider,
        fetchFn: (url, init) => fetch(url, init as RequestInit),
        graphVersion: env.META_GRAPH_VERSION ?? "v26.0",
      }),
    },
    {
      workspaceId,
      phoneNumberId: env.WA_PHONE_NUMBER_ID?.trim() || "1361611993704410",
      recipient: env.WA_TEST_RECIPIENT?.trim() || "6285790702476",
      templateName: env.WA_TEMPLATE_NAME?.trim() || "hello_world",
      templateLanguage: env.WA_TEMPLATE_LANGUAGE?.trim() || "en_US",
    },
  );

  console.log("WhatsApp test template send:");
  console.log(`  account id: ${result.accountId}`);
  console.log(`  workspace:  ${result.workspaceId}`);
  console.log(`  from:       ${result.externalId} (phone_number_id)`);
  console.log(`  to:         ${result.recipient}`);
  console.log(`  template:   ${result.templateName} (${result.templateLanguage})`);
  console.log(`  status:     ${result.status}`);
  if (result.status === "sent") {
    console.log(`  message id: ${result.messageId}`);
  } else {
    console.error(
      `  ERROR: template send failed${result.errorCode ? ` (Meta code ${result.errorCode})` : ""}: ${result.error ?? "unknown error"}`,
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
