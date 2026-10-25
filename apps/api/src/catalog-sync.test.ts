import { beforeAll, describe, expect, test } from "bun:test";
import { AppError } from "@botara/shared";
import {
  deleteCatalogProduct, listCatalogProductKeys, listCatalogProducts, upsertCatalogProduct,
} from "@botara/db";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";
import {
  parseGraphPrice, syncWhatsAppCatalog,
  type CatalogProductStore, type CatalogProductSyncRow,
} from "./catalog-sync";

/**
 * Meta Catalog sync (parity: product catalogs / Meta Catalog sync).
 *
 * Service tests run the real sync against a mocked Graph fetch and an
 * in-memory store port: WABA discovery, multi-page products, upserts,
 * stale deletion ONLY on a fully-paged sync, the page cap, and Graph
 * error mapping. Route tests wire the same service through the API
 * with repository-backed storage over the fake DB.
 */

const ACCOUNT = { id: "acc-1", externalId: "15550001", tokenVaultRef: "vault:db:ref-1" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

function product(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "g-1", retailer_id: "sku-1", name: "Trail Shoes",
    description: "Waterproof", price: "49.99", currency: "USD",
    image_url: "https://img.example/shoes.png", availability: "in stock",
    url: "https://shop.example/shoes", ...overrides,
  };
}

/** In-memory CatalogProductStore with call tracking. */
function makeStore(seedRows: CatalogProductSyncRow[] = []) {
  const rows = new Map<string, CatalogProductSyncRow & { id: string }>();
  let seq = 0;
  const key = (r: { channelAccountId: string; catalogId: string; retailerId: string }) =>
    `${r.channelAccountId}|${r.catalogId}|${r.retailerId}`;
  for (const row of seedRows) rows.set(key(row), { ...row, id: `row-${++seq}` });
  const deleted: string[] = [];
  const store: CatalogProductStore = {
    async upsertProduct(row) {
      const k = key(row);
      rows.set(k, { ...row, id: rows.get(k)?.id ?? `row-${++seq}` });
    },
    async listKeys(channelAccountId, catalogId) {
      return [...rows.values()]
        .filter((r) => r.channelAccountId === channelAccountId && r.catalogId === catalogId)
        .map((r) => ({ id: r.id, retailerId: r.retailerId }));
    },
    async deleteProduct(id) {
      deleted.push(id);
      for (const [k, r] of rows) if (r.id === id) rows.delete(k);
    },
  };
  return { store, rows, deleted, key };
}

const staleRow: CatalogProductSyncRow = {
  workspaceId: "ws-1", channelAccountId: "acc-1", catalogId: "cat-1",
  retailerId: "sku-stale", name: "Old Product", description: null,
  priceAmount: null, currency: null, imageUrl: null, availability: null,
  link: null, raw: null, syncedAt: new Date("2026-01-01T00:00:00Z"),
};

describe("syncWhatsAppCatalog (mocked Graph)", () => {
  test("discovers catalogs via the WABA, pages products, upserts, and deletes stale rows", async () => {
    const { store, rows, deleted } = makeStore([staleRow]);
    const calls: string[] = [];
    const fetchFn = async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/15550001") && url.includes("whatsapp_business_account")) {
        return jsonResponse({ whatsapp_business_account: { id: "waba-1" } });
      }
      if (url.includes("/waba-1/owned_product_catalogs")) {
        return jsonResponse({ data: [{ id: "cat-1", name: "Main" }] });
      }
      if (url.includes("/cat-1/products") && url.includes("after=c2")) {
        return jsonResponse({ data: [product({ id: "g-3", retailer_id: "sku-3", name: "Cap" })] });
      }
      if (url.includes("/cat-1/products")) {
        return jsonResponse({
          data: [product(), product({ id: "g-2", retailer_id: "sku-2", name: "Socks", price: "USD 5" })],
          paging: { next: "https://graph.facebook.com/v26.0/cat-1/products?after=c2" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const result = await syncWhatsAppCatalog(
      { fetchFn, resolveAccessToken: async () => "tok-1", store, now: () => new Date("2026-10-26T00:00:00Z") },
      { workspaceId: "ws-1", account: ACCOUNT },
    );
    expect(result).toEqual({ catalogs: 1, products: 3, syncedAt: "2026-10-26T00:00:00.000Z" });
    expect(calls[0]).toContain("/v26.0/15550001");
    const keys = [...rows.values()].map((r) => r.retailerId).sort();
    expect(keys).toEqual(["sku-1", "sku-2", "sku-3"]);
    // The stale product vanished from Meta -> deleted locally (sync completed).
    expect(deleted).toEqual(["row-1"]);
    const shoes = [...rows.values()].find((r) => r.retailerId === "sku-1")!;
    expect(shoes).toMatchObject({
      catalogId: "cat-1", name: "Trail Shoes", priceAmount: "49.99", currency: "USD",
      imageUrl: "https://img.example/shoes.png", link: "https://shop.example/shoes",
    });
    const socks = [...rows.values()].find((r) => r.retailerId === "sku-2")!;
    expect(socks.priceAmount).toBe("5.00");
  });

  test("an explicit catalogId skips discovery entirely", async () => {
    const { store, rows } = makeStore();
    const calls: string[] = [];
    const fetchFn = async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      return jsonResponse({ data: [product()] });
    };
    const result = await syncWhatsAppCatalog(
      { fetchFn, resolveAccessToken: async () => "tok", store },
      { workspaceId: "ws-1", account: ACCOUNT, catalogId: "cat-9" },
    );
    expect(result).toEqual({ catalogs: 1, products: 1, syncedAt: expect.any(String) });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/cat-9/products");
    expect([...rows.values()][0]!.catalogId).toBe("cat-9");
  });

  test("no resolvable token -> 503 CONFIGURATION, Graph never called", async () => {
    const { store } = makeStore();
    let fetched = false;
    const err = await syncWhatsAppCatalog(
      {
        fetchFn: async () => { fetched = true; return jsonResponse({}); },
        resolveAccessToken: async () => null,
        store,
      },
      { workspaceId: "ws-1", account: ACCOUNT },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("CONFIGURATION");
    expect((err as AppError).status).toBe(503);
    expect(fetched).toBe(false);
  });

  test("undiscoverable WABA (no catalogId given) -> 400 VALIDATION naming the fallback", async () => {
    const { store } = makeStore();
    const err = await syncWhatsAppCatalog(
      {
        fetchFn: async () => jsonResponse({ error: { message: "bad field", code: 100 } }, 400),
        resolveAccessToken: async () => "tok",
        store,
      },
      { workspaceId: "ws-1", account: ACCOUNT },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("VALIDATION");
    expect((err as AppError).message).toContain("catalogId");
  });

  test("a Graph error mid-paging maps to 502 PROVIDER_ERROR and stale rows survive", async () => {
    const { store, rows, deleted } = makeStore([staleRow]);
    const fetchFn = async (input: string | URL) => {
      const url = String(input);
      if (url.includes("after=c2")) {
        return jsonResponse(
          { error: { message: "OAuthException: token expired", code: 190, fbtrace_id: "trace-42" } },
          401,
        );
      }
      if (url.includes("/cat-1/products")) {
        return jsonResponse({
          data: [product()],
          paging: { next: "https://graph.facebook.com/v26.0/cat-1/products?after=c2" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const err = await syncWhatsAppCatalog(
      { fetchFn, resolveAccessToken: async () => "tok", store },
      { workspaceId: "ws-1", account: ACCOUNT, catalogId: "cat-1" },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("PROVIDER_ERROR");
    expect((err as AppError).status).toBe(502);
    expect((err as AppError).details).toMatchObject({ provider: "whatsapp", fbtraceId: "trace-42" });
    // Page 1 upserts stay; the failed sync must NOT delete the stale row.
    expect(deleted).toHaveLength(0);
    expect([...rows.values()].map((r) => r.retailerId).sort()).toEqual(["sku-1", "sku-stale"]);
  });

  test("the page cap stops an endless catalog and stale rows survive a capped sync", async () => {
    const { store, rows, deleted } = makeStore([staleRow]);
    let productCalls = 0;
    const fetchFn = async (input: string | URL) => {
      const url = String(input);
      if (!url.includes("/cat-1/products")) throw new Error(`unexpected fetch: ${url}`);
      productCalls += 1;
      const n = productCalls;
      return jsonResponse({
        data: [product({ id: `g-${n}`, retailer_id: `sku-${n}` })],
        paging: { next: `https://graph.facebook.com/v26.0/cat-1/products?after=c${n}` },
      });
    };
    const result = await syncWhatsAppCatalog(
      { fetchFn, resolveAccessToken: async () => "tok", store },
      { workspaceId: "ws-1", account: ACCOUNT, catalogId: "cat-1" },
    );
    expect(productCalls).toBe(20);
    expect(result.products).toBe(20);
    expect(rows.size).toBe(21); // 20 new + the untouched stale row
    expect(deleted).toHaveLength(0);
  });
});

describe("parseGraphPrice", () => {
  test("plain, prefixed, and numeric prices normalize; junk is null", () => {
    expect(parseGraphPrice("49.99")).toBe("49.99");
    expect(parseGraphPrice("USD 5")).toBe("5.00");
    expect(parseGraphPrice("1,299.50")).toBe("1299.50");
    expect(parseGraphPrice(7)).toBe("7.00");
    expect(parseGraphPrice("free")).toBeNull();
    expect(parseGraphPrice(undefined)).toBeNull();
  });
});

// ------------------------------------------------------------ route wiring

let fake: FakeDatabase;
let owner: Registered;

const routeFetch = async (input: string | URL) => {
  const url = String(input);
  if (url.includes("/cat-7/products")) {
    return jsonResponse({
      data: [
        product({ retailer_id: "sku-red", name: "Red Shoes" }),
        product({ id: "g-2", retailer_id: "sku-blue", name: "Blue Shoes" }),
      ],
    });
  }
  throw new Error(`unexpected fetch: ${url}`);
};

const repoStore: CatalogProductStore = {
  upsertProduct: async (row) => { await upsertCatalogProduct(fake.db, row); },
  listKeys: (accountId, catalogId) => listCatalogProductKeys(fake.db, accountId, catalogId),
  deleteProduct: async (id) => { await deleteCatalogProduct(fake.db, id); },
};

const wiredApp = createApp(testDeps({
  getDatabase: () => fake.db,
  catalogSync: (input) => syncWhatsAppCatalog(
    {
      fetchFn: routeFetch,
      resolveAccessToken: async () => "tok",
      store: repoStore,
      now: () => new Date("2026-10-26T00:00:00Z"),
    },
    {
      workspaceId: input.workspaceId,
      account: { id: input.accountId, externalId: "15550001" },
      catalogId: input.catalogId,
    },
  ),
}));

/** App with the DEFAULT test catalogSync port (throws CONFIGURATION 503). */
const unconfiguredApp = createApp(testDeps({ getDatabase: () => fake.db }));
let unconfiguredOwner: Registered;

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(wiredApp, "catalog-owner@example.com");
  unconfiguredOwner = await registerUser(unconfiguredApp, "catalog-owner2@example.com");
  fake.seed("channelAccounts", {
    id: "acc-wa", workspaceId: owner.workspaceId, channel: "whatsapp",
    externalId: "15550001", status: "connected", tokenVaultRef: "vault:db:ref-1", authMode: null,
  });
});

describe("catalog routes", () => {
  test("sync -> summary -> products list + search, end to end over repositories", async () => {
    const sync = await wiredApp.request("/channels/acc-wa/catalog/sync", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ catalogId: "cat-7" }),
    });
    expect(sync.status).toBe(200);
    expect(await sync.json()).toEqual({
      catalogs: 1, products: 2, syncedAt: "2026-10-26T00:00:00.000Z",
    });

    const summaryRes = await wiredApp.request("/channels/acc-wa/catalog", { headers: owner.headers });
    expect(summaryRes.status).toBe(200);
    expect(await summaryRes.json()).toEqual({
      accountId: "acc-wa", productCount: 2, catalogs: ["cat-7"],
      lastSyncedAt: "2026-10-26T00:00:00.000Z",
    });

    const list = await wiredApp.request("/catalog-products", { headers: owner.headers });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { products: Array<{ name: string; retailerId: string; catalogId: string }> };
    expect(listBody.products.map((p) => p.retailerId).sort()).toEqual(["sku-blue", "sku-red"]);
    expect(listBody.products[0]).toMatchObject({ catalogId: "cat-7" });

    const search = await wiredApp.request("/catalog-products?q=red", { headers: owner.headers });
    const searchBody = (await search.json()) as { products: Array<{ retailerId: string }> };
    expect(searchBody.products.map((p) => p.retailerId)).toEqual(["sku-red"]);

    const byRetailer = await wiredApp.request("/catalog-products?q=SKU-BLUE", { headers: owner.headers });
    const byRetailerBody = (await byRetailer.json()) as { products: Array<{ retailerId: string }> };
    expect(byRetailerBody.products.map((p) => p.retailerId)).toEqual(["sku-blue"]);

    const byAccount = await wiredApp.request("/catalog-products?accountId=acc-other", { headers: owner.headers });
    const byAccountBody = (await byAccount.json()) as { products: unknown[] };
    expect(byAccountBody.products).toHaveLength(0);
  });

  test("the default (unconfigured) port answers an honest 503 CONFIGURATION", async () => {
    const res = await unconfiguredApp.request("/channels/acc-wa/catalog/sync", {
      method: "POST",
      headers: { ...unconfiguredOwner.headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFIGURATION");
  });

  test("sync requires a mutator role (agents are read-only here)", async () => {
    const invite = await wiredApp.request(`/workspaces/${owner.workspaceId}/members`, {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ email: "catalog-agent@example.com", role: "agent" }),
    });
    expect(invite.status).toBe(201);
    const claim = await registerUser(wiredApp, "catalog-agent@example.com", "Agent");
    const res = await wiredApp.request("/channels/acc-wa/catalog/sync", {
      method: "POST",
      headers: {
        authorization: `Bearer ${claim.token}`,
        "x-workspace-id": owner.workspaceId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ catalogId: "cat-7" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("the summary of an unknown account is 404", async () => {
    const res = await wiredApp.request("/channels/acc-nope/catalog", { headers: owner.headers });
    expect(res.status).toBe(404);
  });
});

describe("catalog product repositories (fake DB)", () => {
  test("upsert dedupes on (account, catalog, retailer) and updates in place", async () => {
    const local = createFakeDatabase();
    const base = {
      workspaceId: "ws-x", channelAccountId: "acc-x", catalogId: "cat-x",
      retailerId: "sku-x", description: null, priceAmount: "10.00", currency: "USD",
      imageUrl: null, availability: null, link: null, raw: null,
      syncedAt: new Date("2026-10-26T00:00:00Z"),
    };
    const first = await upsertCatalogProduct(local.db, { ...base, name: "First Name" });
    const second = await upsertCatalogProduct(local.db, { ...base, name: "Renamed", priceAmount: "12.50" });
    expect(second.id).toBe(first.id);
    const rows = await listCatalogProducts(local.db, "ws-x", {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Renamed", priceAmount: "12.50" });

    // Same retailer id in a DIFFERENT catalog is a different product.
    await upsertCatalogProduct(local.db, { ...base, catalogId: "cat-y", name: "Other Catalog" });
    expect(await listCatalogProducts(local.db, "ws-x", {})).toHaveLength(2);
    const keys = await listCatalogProductKeys(local.db, "acc-x", "cat-x");
    expect(keys).toEqual([{ id: first.id, retailerId: "sku-x" }]);
  });
});
