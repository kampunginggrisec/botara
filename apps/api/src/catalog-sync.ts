import { AppError } from "@botara/shared";
import type { FetchLike } from "@botara/channels";

/**
 * Meta Catalog sync for WhatsApp accounts.
 *
 * Mirrors a WhatsApp account's product catalogs into `catalog_products`
 * so the FlowBuilder / Inbox pickers can offer real (catalog_id,
 * retailer_id) pairs for rich product/catalog sends instead of
 * hand-typed ids.
 *
 * Graph API (pinned v26.0, same as the channel adapters):
 *   1. Resolve the WhatsApp Business Account (WABA) id for the account's
 *      phone number: GET /{phone-number-id}?fields=whatsapp_business_account
 *      Botara stores only the phone-number id on the account row (the
 *      WABA id lives in the vault label from Embedded Signup), so this
 *      lookup is the derivable path. When it yields nothing - or the
 *      caller already knows the catalog - a `catalogId` in the sync
 *      request skips discovery entirely.
 *   2. GET /{waba-id}/owned_product_catalogs -> catalog ids.
 *   3. Page GET /{catalog-id}/products?fields=... (hard caps below),
 *      upserting per page. Stale rows (products Meta no longer returns
 *      for that catalog) are deleted ONLY when the catalog's paging ran
 *      to completion - a capped or failed sync must never shrink the
 *      mirror on partial data.
 *
 * The access token comes from the token vault port (the same
 * VaultCredentialProvider mechanism the channel adapters resolve with);
 * no resolvable token is a typed 503 CONFIGURATION, never a fake sync.
 */

export interface CatalogAccountRef {
  id: string;
  externalId: string;
  tokenVaultRef?: string | null;
}

/** One product row to mirror - mirrors the catalog_products columns. */
export interface CatalogProductSyncRow {
  workspaceId: string;
  channelAccountId: string;
  catalogId: string;
  retailerId: string;
  name: string;
  description: string | null;
  priceAmount: string | null;
  currency: string | null;
  imageUrl: string | null;
  availability: string | null;
  link: string | null;
  raw: Record<string, unknown> | null;
  syncedAt: Date;
}

/** Persistence port for the sync (repositories in production, fake in tests). */
export interface CatalogProductStore {
  upsertProduct(row: CatalogProductSyncRow): Promise<void>;
  listKeys(channelAccountId: string, catalogId: string): Promise<Array<{ id: string; retailerId: string }>>;
  deleteProduct(id: string): Promise<void>;
}

export interface CatalogSyncDeps {
  fetchFn: FetchLike;
  graphVersion?: string;
  baseUrl?: string;
  /** Resolve the account's Meta access token (vault port); null = unusable. */
  resolveAccessToken(account: CatalogAccountRef): Promise<string | null>;
  store: CatalogProductStore;
  now?: () => Date;
}

export interface CatalogSyncResult {
  catalogs: number;
  products: number;
  syncedAt: string;
}

/** Hard caps: a sync never mirrors more than this, however big the catalog. */
export const CATALOG_SYNC_MAX_PRODUCTS = 1000;
export const CATALOG_SYNC_MAX_PAGES_PER_CATALOG = 20;
export const CATALOG_SYNC_MAX_CATALOG_PAGES = 5;

const PRODUCT_FIELDS = "id,retailer_id,name,description,price,currency,image_url,availability,url";

interface GraphError {
  message?: string;
  code?: number;
  fbtrace_id?: string;
}

interface GraphPage {
  data?: Array<Record<string, unknown>>;
  paging?: { next?: string };
  error?: GraphError;
}

/** Graph `price` arrives as a string ("10.00", occasionally "USD 10.00"); keep the first numeric token. */
export function parseGraphPrice(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw.toFixed(2);
  if (typeof raw !== "string") return null;
  const match = raw.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value.toFixed(2) : null;
}

export async function syncWhatsAppCatalog(
  deps: CatalogSyncDeps,
  input: { workspaceId: string; account: CatalogAccountRef; catalogId?: string },
): Promise<CatalogSyncResult> {
  const version = deps.graphVersion ?? "v26.0";
  const base = (deps.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "");
  const now = deps.now ?? (() => new Date());
  const syncedAt = now();

  const accessToken = await deps.resolveAccessToken(input.account);
  if (!accessToken) {
    throw new AppError(
      "CONFIGURATION",
      "WhatsApp access token is not configured for this account; catalog sync needs a connected account with a valid token in the vault.",
      { status: 503 },
    );
  }

  async function graphGet(url: string): Promise<GraphPage> {
    const res = await deps.fetchFn(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const json = (await res.json().catch(() => ({}))) as GraphPage;
    if (!res.ok || json.error) {
      throw new AppError(
        "PROVIDER_ERROR",
        `Meta catalog sync failed: ${json.error?.message ?? `HTTP ${res.status}`}`,
        { status: 502, details: { provider: "whatsapp", fbtraceId: json.error?.fbtrace_id } },
      );
    }
    return json;
  }

  // ------------------------------------------------------------ discovery
  async function discoverCatalogIds(): Promise<string[]> {
    // The account row stores the phone-number id; the WABA id is
    // derivable from the phone-number node. Any failure here (Graph
    // error, missing field) falls through to the catalogId requirement -
    // discovery is a convenience, never a silent guess.
    let wabaId: string | null = null;
    try {
      const url = new URL(`${base}/${version}/${input.account.externalId}`);
      url.searchParams.set("fields", "whatsapp_business_account");
      const res = await deps.fetchFn(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const json = (await res.json().catch(() => ({}))) as {
        whatsapp_business_account?: { id?: string };
      };
      wabaId = json.whatsapp_business_account?.id ?? null;
    } catch {
      wabaId = null;
    }
    if (!wabaId) {
      throw new AppError(
        "VALIDATION",
        "Could not discover the WhatsApp Business Account for this phone number; provide catalogId to sync a specific catalog.",
        { status: 400 },
      );
    }
    const ids: string[] = [];
    let next: string | null =
      `${base}/${version}/${wabaId}/owned_product_catalogs?fields=id,name&limit=100`;
    let pages = 0;
    while (next && pages < CATALOG_SYNC_MAX_CATALOG_PAGES) {
      const page = await graphGet(next);
      pages += 1;
      for (const row of page.data ?? []) {
        if (typeof row.id === "string") ids.push(row.id);
      }
      next = page.paging?.next ?? null;
    }
    return ids;
  }

  const catalogIds = input.catalogId ? [input.catalogId] : await discoverCatalogIds();

  // ------------------------------------------------------------ per catalog
  let totalProducts = 0;
  for (const catalogId of catalogIds) {
    const seen = new Set<string>();
    let next: string | null =
      `${base}/${version}/${catalogId}/products?fields=${PRODUCT_FIELDS}&limit=100`;
    let pages = 0;
    let completed = false;
    while (next) {
      if (pages >= CATALOG_SYNC_MAX_PAGES_PER_CATALOG || totalProducts >= CATALOG_SYNC_MAX_PRODUCTS) {
        break; // capped: NOT completed, stale rows stay untouched
      }
      const page = await graphGet(next);
      pages += 1;
      for (const product of page.data ?? []) {
        if (totalProducts >= CATALOG_SYNC_MAX_PRODUCTS) break;
        const retailerId = typeof product.retailer_id === "string" ? product.retailer_id : "";
        if (!retailerId) continue; // unsendable without a retailer id
        seen.add(retailerId);
        await deps.store.upsertProduct({
          workspaceId: input.workspaceId,
          channelAccountId: input.account.id,
          catalogId,
          retailerId,
          name: typeof product.name === "string" && product.name ? product.name : retailerId,
          description: typeof product.description === "string" ? product.description : null,
          priceAmount: parseGraphPrice(product.price),
          currency: typeof product.currency === "string" ? product.currency : null,
          imageUrl: typeof product.image_url === "string" ? product.image_url : null,
          availability: typeof product.availability === "string" ? product.availability : null,
          link: typeof product.url === "string" ? product.url : null,
          raw: product,
          syncedAt,
        });
        totalProducts += 1;
      }
      next = page.paging?.next ?? null;
      if (!next) completed = true;
    }
    if (completed) {
      // The full catalog was read: rows Meta no longer returns are stale.
      const existing = await deps.store.listKeys(input.account.id, catalogId);
      for (const key of existing) {
        if (!seen.has(key.retailerId)) await deps.store.deleteProduct(key.id);
      }
    }
  }

  return { catalogs: catalogIds.length, products: totalProducts, syncedAt: syncedAt.toISOString() };
}
