import { beforeAll, describe, expect, test } from "bun:test";
import { AppError } from "@botara/shared";
import { listTemplates, upsertTemplateFromMeta } from "@botara/db";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";
import {
  TEMPLATE_SYNC_MAX_PAGES, syncWhatsAppTemplates,
  type TemplateSyncStoreRow,
} from "./template-sync";

/**
 * WhatsApp template sync (WA-4).
 *
 * Service tests run the real sync against a mocked Graph fetch and an
 * in-memory store port: WABA discovery from the phone-number id, paging,
 * upsert keying, and the "no token -> typed 503" contract. Route tests
 * wire the same service through the API over the fake DB, so the mirror
 * ends up in real repository rows.
 */

const ACCOUNT = { id: "acc-1", externalId: "15550001", tokenVaultRef: "vault:db:ref-1" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

function template(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tpl-1", name: "order_update", language: "id", status: "APPROVED", category: "UTILITY",
    ...overrides,
  };
}

interface RecordedCall { url: string; method: string }

/** Mock Graph: phone-number -> WABA, then one or more template pages. */
function mockGraph(pages: Array<{ data: unknown[]; next?: string }>) {
  const calls: RecordedCall[] = [];
  let pageIndex = 0;
  const fetchFn = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.includes("/15550001?fields=whatsapp_business_account")) {
      return jsonResponse({ whatsapp_business_account: { id: "waba-9" } });
    }
    if (url.includes("/waba-9/message_templates")) {
      const page = pages[pageIndex] ?? { data: [] };
      pageIndex++;
      return jsonResponse({
        data: page.data,
        paging: { cursors: { after: page.next ?? null } },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { fetchFn, calls };
}

function memoryStore() {
  const rows: TemplateSyncStoreRow[] = [];
  return {
    rows,
    store: {
      upsert: async (row: TemplateSyncStoreRow) => {
        const key = `${row.channelAccountId}|${row.name}|${row.language}`;
        const idx = rows.findIndex((r) => `${r.channelAccountId}|${r.name}|${r.language}` === key);
        if (idx >= 0) {
          rows[idx] = row;
          return { created: false };
        }
        rows.push(row);
        return { created: true };
      },
    },
  };
}

describe("template sync service", () => {
  test("discovers the WABA, pages templates and mirrors each one", async () => {
    const { fetchFn, calls } = mockGraph([
      { data: [template(), template({ id: "tpl-2", name: "promo_juni", language: "en", status: "PENDING", category: "MARKETING" })], next: "cursor-1" },
      { data: [template({ id: "tpl-3", name: "otp", status: "REJECTED", category: "AUTHENTICATION" })] },
    ]);
    const { rows, store } = memoryStore();
    const result = await syncWhatsAppTemplates(
      { fetchFn, resolveAccessToken: async () => "tok", store },
      { workspaceId: "ws-1", account: ACCOUNT },
    );

    expect(result.wabaId).toBe("waba-9");
    expect(result.templates).toBe(3);
    expect(result.created).toBe(3);
    expect(result.updated).toBe(0);
    expect(rows.map((r) => `${r.name}:${r.status}`)).toEqual([
      "order_update:approved", "promo_juni:pending", "otp:rejected",
    ]);
    expect(rows[0]!.messagingAccountId).toBe("waba-9");
    expect(rows[0]!.externalId).toBe("tpl-1");
    // two pages were read (cursor carried over)
    expect(calls.filter((c) => c.url.includes("message_templates"))).toHaveLength(2);
    expect(calls[2]!.url).toContain("after=cursor-1");
  });

  test("prefers the WABA stored on the account and never calls discovery", async () => {
    // Graph v26 has no whatsapp_business_account field on the phone node
    // (Meta answers (#100) "nonexisting field"), so the discovery URL is
    // intentionally unserved here: any discovery attempt throws.
    const calls: RecordedCall[] = [];
    const fetchFn = async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/waba-stored/message_templates")) {
        return jsonResponse({ data: [template()], paging: { cursors: { after: null } } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const { rows, store } = memoryStore();
    const result = await syncWhatsAppTemplates(
      { fetchFn, resolveAccessToken: async () => "tok", store },
      { workspaceId: "ws-1", account: { ...ACCOUNT, capabilities: { wabaId: "waba-stored" } } },
    );
    expect(result.wabaId).toBe("waba-stored");
    expect(result.templates).toBe(1);
    expect(rows[0]!.messagingAccountId).toBe("waba-stored");
    expect(calls.some((c) => c.url.includes("fields=whatsapp_business_account"))).toBe(false);
  });

  test("re-syncing the same templates updates instead of duplicating", async () => {
    const { fetchFn } = mockGraph([{ data: [template()] }]);
    const { rows, store } = memoryStore();
    await syncWhatsAppTemplates({ fetchFn, resolveAccessToken: async () => "tok", store }, { workspaceId: "ws-1", account: ACCOUNT });
    const second = await syncWhatsAppTemplates(
      { fetchFn: mockGraph([{ data: [template({ status: "PAUSED" })] }]).fetchFn, resolveAccessToken: async () => "tok", store },
      { workspaceId: "ws-1", account: ACCOUNT },
    );
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("paused");
  });

  test("a missing token is a typed 503, never an empty sync", async () => {
    const { fetchFn, calls } = mockGraph([]);
    await expect(syncWhatsAppTemplates(
      { fetchFn, resolveAccessToken: async () => null, store: memoryStore().store },
      { workspaceId: "ws-1", account: ACCOUNT },
    )).rejects.toThrow(/token is not configured/i);
    expect(calls).toHaveLength(0);
  });

  test("an unresolvable WABA fails with the provider message, not a silent zero", async () => {
    const fetchFn = async () => jsonResponse({ error: { message: "Unsupported get request" } }, 400);
    await expect(syncWhatsAppTemplates(
      { fetchFn, resolveAccessToken: async () => "tok", store: memoryStore().store },
      { workspaceId: "ws-1", account: ACCOUNT },
    )).rejects.toBeInstanceOf(AppError);
  });

  test("paging is capped so a huge WABA cannot stall the request", async () => {
    // Every page reports another cursor and a full page of results.
    const fullPage = Array.from({ length: 100 }, (_, i) => template({ id: `t-${i}`, name: `tpl_${i}` }));
    let served = 0;
    const fetchFn = async (input: string | URL) => {
      const url = String(input);
      if (url.includes("?fields=whatsapp_business_account")) {
        return jsonResponse({ whatsapp_business_account: { id: "waba-9" } });
      }
      served++;
      return jsonResponse({ data: fullPage, paging: { cursors: { after: `c-${served}` } } });
    };
    const result = await syncWhatsAppTemplates(
      { fetchFn, resolveAccessToken: async () => "tok", store: memoryStore().store },
      { workspaceId: "ws-1", account: ACCOUNT },
    );
    expect(served).toBe(TEMPLATE_SYNC_MAX_PAGES);
    expect(result.templates).toBe(TEMPLATE_SYNC_MAX_PAGES * 100);
  });
});

// ------------------------------------------------------------ route wiring

let fake: FakeDatabase;
let owner: Registered;

const routeFetch = async (input: string | URL) => {
  const url = String(input);
  if (url.includes("?fields=whatsapp_business_account")) {
    return jsonResponse({ whatsapp_business_account: { id: "waba-9" } });
  }
  if (url.includes("/waba-9/message_templates")) {
    return jsonResponse({
      data: [
        template(),
        template({ id: "tpl-2", name: "promo_juni", language: "en", status: "PENDING", category: "MARKETING" }),
      ],
    });
  }
  throw new Error(`unexpected fetch: ${url}`);
};

const wiredApp = createApp(testDeps({
  getDatabase: () => fake.db,
  templateSync: (input) => syncWhatsAppTemplates(
    {
      fetchFn: routeFetch,
      resolveAccessToken: async () => "tok",
      store: {
        upsert: async (row) => {
          const result = await upsertTemplateFromMeta(fake.db, row);
          return { created: result.created };
        },
      },
    },
    {
      workspaceId: input.workspaceId,
      account: { id: input.accountId, externalId: "15550001" },
    },
  ),
}));

const unconfiguredApp = createApp(testDeps({ getDatabase: () => fake.db }));
let unconfiguredOwner: Registered;

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(wiredApp, "tpl-sync-owner@example.com");
  unconfiguredOwner = await registerUser(unconfiguredApp, "tpl-sync-owner2@example.com");
  fake.seed("channelAccounts", {
    id: "acc-wa", workspaceId: owner.workspaceId, channel: "whatsapp",
    externalId: "15550001", status: "connected", tokenVaultRef: "vault:db:ref-1", authMode: null,
  });
});

describe("template sync route", () => {
  test("sync mirrors Meta templates into repository rows", async () => {
    const res = await wiredApp.request("/templates/sync", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ channelAccountId: "acc-wa" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { wabaId: string; templates: number; created: number };
    expect(body.wabaId).toBe("waba-9");
    expect(body.templates).toBe(2);
    expect(body.created).toBe(2);

    const rows = await listTemplates(fake.db, owner.workspaceId);
    expect(rows.map((r) => `${r.name}/${r.language}/${r.status}`).sort()).toEqual([
      "order_update/id/approved", "promo_juni/en/pending",
    ]);
    // the provider id is stored so the panel no longer asks for it by hand
    expect(rows.every((r) => typeof r.externalId === "string" && r.externalId.length > 0)).toBe(true);
    expect(rows.every((r) => r.messagingAccountId === "waba-9")).toBe(true);
  });

  test("a second sync updates the same rows (no duplicates)", async () => {
    const res = await wiredApp.request("/templates/sync", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ channelAccountId: "acc-wa" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { created: number }).created).toBe(0);
    const rows = await listTemplates(fake.db, owner.workspaceId);
    expect(rows).toHaveLength(2);
  });

  test("an unconfigured sync answers 503 instead of pretending", async () => {
    const res = await unconfiguredApp.request("/templates/sync", {
      method: "POST",
      headers: { ...unconfiguredOwner.headers, "content-type": "application/json" },
      body: JSON.stringify({ channelAccountId: "acc-wa" }),
    });
    expect(res.status).toBe(503);
  });
});
