import { AppError } from "@botara/shared";
import { WhatsAppAdapter, type FetchLike } from "@botara/channels";

/**
 * WhatsApp template sync (WA-4).
 *
 * Meta owns a template's existence and approval state; Botara's
 * `templates` table is a MIRROR. Before this module the mirror was filled
 * by hand (the register form asked the operator to paste an external id),
 * which is how a broadcast could be built on a template Meta never
 * approved.
 *
 * The sync:
 *   1. resolves the account's access token (vault, env fallback),
 *   2. resolves the owning WABA - the id captured at onboarding
 *      (`capabilities.wabaId`) when present, else a discovery lookup,
 *   3. pages `GET /{waba-id}/message_templates` (bounded - 10 pages),
 *   4. upserts every template into the local table keyed by
 *      (workspace, account, name, language) - the identity Meta uses.
 *
 * It never DELETES local rows: a template missing from Meta may still be
 * referenced by an old broadcast, and a silent delete would orphan that
 * history. Deletion stays an explicit operator action.
 */

export interface TemplateSyncAccountRef {
  id: string;
  externalId: string;
  tokenVaultRef?: string | null;
  /** WABA id captured at onboarding; skips the discovery lookup when set. */
  wabaId?: string | null;
  /** The account row's capabilities bag (jsonb, untyped); may carry `wabaId`. */
  capabilities?: unknown;
}

/**
 * The WABA id stored on the account, if any. Embedded Signup knows the
 * WABA at exchange time and the persister stamps it into
 * `capabilities.wabaId`; template operations and the health check must
 * prefer it, because the discovery field used before
 * (`?fields=whatsapp_business_account` on the phone-number node) does not
 * exist in Graph v26 - Meta answers (#100) "nonexisting field" (verified
 * live 2026-10-28, when Sync from Meta returned 502 for a healthy
 * account). An explicit `wabaId` field wins over the capabilities bag.
 */
export function storedWabaIdForAccount(account: {
  wabaId?: string | null;
  capabilities?: unknown;
}): string | undefined {
  if (account.wabaId) return account.wabaId;
  const capabilities = account.capabilities;
  if (capabilities && typeof capabilities === "object") {
    const fromCapabilities = (capabilities as Record<string, unknown>).wabaId;
    if (typeof fromCapabilities === "string" && fromCapabilities) return fromCapabilities;
  }
  return undefined;
}

/** Everything needed to talk Graph for a template operation. */
export interface TemplateGraphDeps {
  fetchFn: FetchLike;
  graphVersion?: string;
  baseUrl?: string;
  resolveAccessToken: (account: TemplateSyncAccountRef) => Promise<string | null>;
}

export interface TemplateSyncStoreRow {
  workspaceId: string;
  channelAccountId: string;
  name: string;
  language: string;
  category?: string;
  externalId?: string;
  status: string;
  messagingAccountId?: string;
  components?: unknown[];
  rejectedReason?: string;
}

export interface TemplateSyncDeps extends TemplateGraphDeps {
  store: {
    upsert: (row: TemplateSyncStoreRow) => Promise<{ created: boolean }>;
  };
}

export interface TemplateSyncResult {
  wabaId: string;
  templates: number;
  created: number;
  updated: number;
  syncedAt: string;
}

/** Hard cap: a sync never pages more than this, however big the WABA. */
export const TEMPLATE_SYNC_MAX_PAGES = 10;

/** A resolved Graph context for one template operation. */
export interface TemplateGraphContext {
  token: string;
  wabaId: string;
  adapter: WhatsAppAdapter;
}

/**
 * Resolve the token, the owning WABA and a ready adapter - the shared
 * prologue of every template operation (list, create, delete).
 *
 * `knownWabaId` skips the discovery round-trip: a mirrored row already
 * carries the WABA it came from (`templates.messaging_account_id`), and
 * re-discovering it on every delete would double the Graph calls for no
 * new information.
 */
export async function connectTemplateGraph(
  deps: TemplateGraphDeps,
  account: TemplateSyncAccountRef,
  options: { knownWabaId?: string | null } = {},
): Promise<TemplateGraphContext> {
  const version = deps.graphVersion ?? "v26.0";
  const base = (deps.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "");
  const token = await deps.resolveAccessToken(account);
  if (!token) {
    throw new AppError(
      "CONFIGURATION",
      "WhatsApp access token is not configured for this account; template operations need a connected account with a valid token in the vault.",
      { status: 503 },
    );
  }

  const adapter = new WhatsAppAdapter({
    credentials: { resolve: async () => ({ accessToken: token }) },
    fetchFn: deps.fetchFn,
    graphVersion: version,
    baseUrl: base,
  });

  const knownWabaId = options.knownWabaId ?? storedWabaIdForAccount(account);
  if (knownWabaId) return { token, wabaId: knownWabaId, adapter };

  const wabaId = await resolveWabaIdForNumber(deps, { token, phoneNumberId: account.externalId });
  return { token, wabaId, adapter };
}

/**
 * Discover the WhatsApp Business Account that owns a phone number.
 *
 * Extracted from `connectTemplateGraph` so the health check (P2-2) can ask
 * the same question with the same auth and the same error mapping - two
 * copies of this lookup would eventually disagree about which number's
 * WABA is being checked.
 */
export async function resolveWabaIdForNumber(
  deps: Pick<TemplateGraphDeps, "fetchFn" | "graphVersion" | "baseUrl">,
  input: { token: string; phoneNumberId: string },
): Promise<string> {
  const version = deps.graphVersion ?? "v26.0";
  const base = (deps.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "");
  const numberUrl = new URL(`${base}/${version}/${input.phoneNumberId}`);
  numberUrl.searchParams.set("fields", "whatsapp_business_account");
  const numberRes = await deps.fetchFn(numberUrl.toString(), {
    headers: { Authorization: `Bearer ${input.token}` },
  });
  const numberJson = (await numberRes.json().catch(() => ({}))) as {
    whatsapp_business_account?: { id?: string };
    error?: { message?: string };
  };
  const wabaId = numberJson.whatsapp_business_account?.id;
  if (!numberRes.ok || numberJson.error || !wabaId) {
    throw new AppError(
      "PROVIDER_ERROR",
      `Could not resolve the WhatsApp Business Account for this number: ${
        numberJson.error?.message ?? `HTTP ${numberRes.status}`
      }`,
      { status: 502 },
    );
  }
  return wabaId;
}

export async function syncWhatsAppTemplates(
  deps: TemplateSyncDeps,
  input: { workspaceId: string; account: TemplateSyncAccountRef },
): Promise<TemplateSyncResult> {
  // Token + WABA discovery + adapter (same auth, error mapping and paging
  // rules the send path uses).
  const { wabaId, adapter } = await connectTemplateGraph(deps, input.account);
  const templates = await adapter.listMessageTemplates(
    { id: input.account.id, externalId: input.account.externalId },
    wabaId,
    { maxPages: TEMPLATE_SYNC_MAX_PAGES },
  );

  // Mirror each template locally.
  let created = 0;
  let updated = 0;
  for (const template of templates) {
    const result = await deps.store.upsert({
      workspaceId: input.workspaceId,
      channelAccountId: input.account.id,
      name: template.name,
      language: template.language,
      ...(template.category ? { category: template.category } : {}),
      ...(template.id ? { externalId: template.id } : {}),
      status: template.status.toLowerCase(),
      messagingAccountId: wabaId,
      ...(template.components ? { components: template.components } : {}),
      ...(template.rejectedReason ? { rejectedReason: template.rejectedReason } : {}),
    });
    if (result.created) created++;
    else updated++;
  }

  return {
    wabaId,
    templates: templates.length,
    created,
    updated,
    syncedAt: new Date().toISOString(),
  };
}
