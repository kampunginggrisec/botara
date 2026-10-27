import { beforeAll, describe, expect, test } from "bun:test";
import { AppError } from "@botara/shared";
import { deleteTemplate, getTemplate, listTemplates, upsertTemplateFromMeta } from "@botara/db";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";
import {
  countBodyParams,
  deleteWhatsAppTemplate,
  submitWhatsAppTemplate,
  templateBodyParamCount,
  validateTemplateComponents,
} from "./template-write";
import type { TemplateSyncStoreRow } from "./template-sync";

/**
 * WhatsApp template WRITE path (WA-4 continuation).
 *
 * Three layers, each pinned separately:
 *   1. the validator - it decides what Meta will accept, and the same
 *      function feeds the pre-send parameter count, so a bug here either
 *      wastes a Meta review or rejects a valid broadcast;
 *   2. the service - submit mirrors Meta's status (never "approved" on
 *      optimism), delete removes on Meta FIRST;
 *   3. the routes - including the broadcast pre-send gate that refuses a
 *      pending/rejected template and a parameter-count mismatch.
 */

const ACCOUNT = { id: "acc-1", externalId: "15550001", tokenVaultRef: "vault:db:ref-1" };

const body = (text: string) => ({ type: "BODY", text });

// ------------------------------------------------------------- validator

describe("template component validator", () => {
  test("counts sequential body placeholders", () => {
    expect(countBodyParams("Halo")).toBe(0);
    expect(countBodyParams("Halo {{1}}")).toBe(1);
    expect(countBodyParams("Halo {{1}}, pesanan {{2}} siap")).toBe(2);
    // the same index twice is still ONE parameter
    expect(countBodyParams("{{1}} dan {{1}}")).toBe(1);
    // Meta tolerates inner spaces
    expect(countBodyParams("Halo {{ 1 }}")).toBe(1);
  });

  test("rejects gaps, named placeholders and out-of-range indexes", () => {
    expect(() => countBodyParams("{{1}} {{3}}")).toThrow(/sequential/i);
    expect(() => countBodyParams("{{2}}")).toThrow(/sequential/i);
    expect(() => countBodyParams("{{name}}")).toThrow(/positional/i);
    expect(() => countBodyParams("{{0}}")).toThrow(/out of range/i);
  });

  test("a template needs exactly one BODY", () => {
    expect(() => validateTemplateComponents([])).toThrow(/non-empty array/i);
    expect(() => validateTemplateComponents([{ type: "HEADER", text: "Halo" }])).toThrow(/must have a BODY/i);
    expect(() => validateTemplateComponents([body("A"), body("B")])).toThrow(/Duplicate BODY/i);
  });

  test("text caps are enforced with the real limit in the message", () => {
    expect(() => validateTemplateComponents([body("x".repeat(1025))])).toThrow(/1024/);
    expect(() => validateTemplateComponents([
      { type: "HEADER", format: "TEXT", text: "x".repeat(61) }, body("A"),
    ])).toThrow(/60/);
    expect(() => validateTemplateComponents([
      body("A"), { type: "FOOTER", text: "x".repeat(61) },
    ])).toThrow(/60/);
  });

  test("button ceilings and required fields follow Meta's rules", () => {
    const buttons = (list: unknown[]) => [body("A"), { type: "BUTTONS", buttons: list }];
    expect(() => validateTemplateComponents(buttons([]))).toThrow(/at least one button/i);
    expect(() => validateTemplateComponents(buttons(
      Array.from({ length: 11 }, (_, i) => ({ type: "QUICK_REPLY", text: `b${i}` })),
    ))).toThrow(/at most 10/i);
    // only two URL buttons are allowed
    expect(() => validateTemplateComponents(buttons(
      Array.from({ length: 3 }, () => ({ type: "URL", text: "Buka", url: "https://a.test" })),
    ))).toThrow(/at most 2 URL/i);
    expect(() => validateTemplateComponents(buttons([{ type: "URL", text: "Buka" }]))).toThrow(/http\(s\) url/i);
    expect(() => validateTemplateComponents(buttons([{ type: "PHONE_NUMBER", text: "Telp" }]))).toThrow(/phone_number/i);
    expect(() => validateTemplateComponents(buttons([{ type: "CAROUSEL", text: "X" }]))).toThrow(/Unknown button type/i);
  });

  test("a media header must carry the sample handle Meta reviews", () => {
    expect(() => validateTemplateComponents([{ type: "HEADER", format: "IMAGE" }, body("A")]))
      .toThrow(/header_handle/i);
    const ok = validateTemplateComponents([
      { type: "HEADER", format: "IMAGE", example: { header_handle: ["https://cdn.test/a.jpg"] } },
      body("A"),
    ]);
    expect(ok.components[0]).toEqual({
      type: "HEADER", format: "IMAGE", example: { header_handle: ["https://cdn.test/a.jpg"] },
    });
  });

  test("a valid tree normalizes and reports its body parameter count", () => {
    const result = validateTemplateComponents([
      { type: "header", format: "text", text: "  Status  " },
      { type: "body", text: "Halo {{1}}, pesanan {{2}} siap" },
      { type: "buttons", buttons: [{ type: "quick_reply", text: "Lacak" }] },
    ]);
    expect(result.bodyParamCount).toBe(2);
    expect(result.components[0]).toEqual({ type: "HEADER", format: "TEXT", text: "Status" });
    expect(result.components[2]).toEqual({ type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Lacak" }] });
  });

  test("templateBodyParamCount reads a stored tree and degrades to null", () => {
    expect(templateBodyParamCount([body("Halo {{1}}")])).toBe(1);
    expect(templateBodyParamCount(null)).toBeNull();
    expect(templateBodyParamCount([{ type: "HEADER", text: "x" }])).toBeNull();
    // a malformed mirrored row must not break the broadcast path
    expect(templateBodyParamCount([body("{{1}} {{3}}")])).toBeNull();
  });
});

// --------------------------------------------------------------- service

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status, headers: { "content-type": "application/json" },
  });
}

interface RecordedCall { url: string; method: string }

function memoryStore() {
  const rows = new Map<string, TemplateSyncStoreRow & { id: string }>();
  let seq = 0;
  return {
    rows,
    store: {
      upsert: async (row: TemplateSyncStoreRow) => {
        const key = `${row.channelAccountId}|${row.name}|${row.language}`;
        const existing = rows.get(key);
        if (existing) {
          rows.set(key, { ...existing, ...row });
          return { row: rows.get(key) as never, created: false };
        }
        const created = { ...row, id: `tpl-${++seq}` };
        rows.set(key, created);
        return { row: created as never, created: true };
      },
      remove: async (id: string) => {
        for (const [key, row] of rows) {
          if (row.id === id) {
            rows.delete(key);
            return true;
          }
        }
        return false;
      },
    },
  };
}

describe("template submit service", () => {
  test("submits to the WABA and mirrors Meta's status, not 'approved'", async () => {
    const calls: RecordedCall[] = [];
    const fetchFn = async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("?fields=whatsapp_business_account")) {
        return jsonResponse({ whatsapp_business_account: { id: "waba-9" } });
      }
      return jsonResponse({ id: "tpl-77", status: "PENDING", category: "UTILITY" });
    };
    const { rows, store } = memoryStore();
    const result = await submitWhatsAppTemplate(
      { fetchFn, resolveAccessToken: async () => "tok", store },
      {
        workspaceId: "ws-1", account: ACCOUNT,
        name: "order_update", language: "id", category: "utility",
        components: [body("Halo {{1}}")],
      },
    );

    expect(result.wabaId).toBe("waba-9");
    expect(result.created).toBe(true);
    expect(result.template.status).toBe("pending");
    expect(result.template.externalId).toBe("tpl-77");
    expect(result.template.messagingAccountId).toBe("waba-9");
    const stored = rows.get("acc-1|order_update|id")!;
    expect(stored.components).toEqual([body("Halo {{1}}")]);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  test("an invalid component tree never reaches Graph", async () => {
    const calls: RecordedCall[] = [];
    const fetchFn = async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return jsonResponse({});
    };
    await expect(submitWhatsAppTemplate(
      { fetchFn, resolveAccessToken: async () => "tok", store: memoryStore().store },
      {
        workspaceId: "ws-1", account: ACCOUNT,
        name: "order_update", language: "id", category: "utility",
        components: [body("{{1}} {{3}}")],
      },
    )).rejects.toThrow(/sequential/i);
    expect(calls).toHaveLength(0);
  });

  test("name / language / category are validated before the provider call", async () => {
    const deps = { fetchFn: async () => jsonResponse({}), resolveAccessToken: async () => "tok", store: memoryStore().store };
    const base = { workspaceId: "ws-1", account: ACCOUNT, components: [body("A")] };
    await expect(submitWhatsAppTemplate(deps, { ...base, name: "Order Update", language: "id", category: "utility" }))
      .rejects.toThrow(/lowercase/i);
    await expect(submitWhatsAppTemplate(deps, { ...base, name: "order_update", language: "ID-id", category: "utility" }))
      .rejects.toThrow(/language/i);
    await expect(submitWhatsAppTemplate(deps, { ...base, name: "order_update", language: "id", category: "promo" }))
      .rejects.toThrow(/category/i);
  });

  test("a missing token is a typed 503, never an empty mirror row", async () => {
    const { rows, store } = memoryStore();
    await expect(submitWhatsAppTemplate(
      { fetchFn: async () => jsonResponse({}), resolveAccessToken: async () => null, store },
      { workspaceId: "ws-1", account: ACCOUNT, name: "x", language: "id", category: "utility", components: [body("A")] },
    )).rejects.toBeInstanceOf(AppError);
    expect(rows.size).toBe(0);
  });
});

describe("template delete service", () => {
  test("uses the stored WABA (no discovery round-trip) and deletes Meta-first", async () => {
    const calls: RecordedCall[] = [];
    const fetchFn = async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return jsonResponse({ success: true });
    };
    const { rows, store } = memoryStore();
    await store.upsert({
      workspaceId: "ws-1", channelAccountId: "acc-1", name: "order_update", language: "id",
      status: "approved", messagingAccountId: "waba-9",
    });
    const result = await deleteWhatsAppTemplate(
      { fetchFn, resolveAccessToken: async () => "tok", store },
      {
        workspaceId: "ws-1", account: ACCOUNT,
        template: { id: "tpl-1", name: "order_update", messagingAccountId: "waba-9" },
      },
    );
    expect(result).toEqual({ wabaId: "waba-9", deleted: true });
    // one call only: the WABA was already known
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toContain("/waba-9/message_templates?name=order_update");
    expect(rows.size).toBe(0);
  });

  test("a failed provider delete keeps the local row", async () => {
    const { rows, store } = memoryStore();
    await store.upsert({
      workspaceId: "ws-1", channelAccountId: "acc-1", name: "order_update", language: "id",
      status: "approved", messagingAccountId: "waba-9",
    });
    await expect(deleteWhatsAppTemplate(
      {
        fetchFn: async () => jsonResponse({ error: { message: "Unsupported delete request" } }, 400),
        resolveAccessToken: async () => "tok",
        store,
      },
      { workspaceId: "ws-1", account: ACCOUNT, template: { id: "tpl-1", name: "order_update", messagingAccountId: "waba-9" } },
    )).rejects.toThrow(/Unsupported delete request/);
    expect(rows.size).toBe(1);
  });
});

// ------------------------------------------------------------ route wiring

let fake: FakeDatabase;
let owner: Registered;
let unconfiguredOwner: Registered;

const routeCalls: RecordedCall[] = [];

const routeFetch = async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  routeCalls.push({ url, method: init?.method ?? "GET" });
  if (url.includes("?fields=whatsapp_business_account")) {
    return jsonResponse({ whatsapp_business_account: { id: "waba-9" } });
  }
  if (url.includes("/message_templates") && (init?.method ?? "GET") === "POST") {
    return jsonResponse({ id: "tpl-new", status: "PENDING", category: "UTILITY" });
  }
  if (url.includes("/message_templates") && init?.method === "DELETE") {
    return jsonResponse({ success: true });
  }
  throw new Error(`unexpected fetch: ${url}`);
};

const wiredApp = createApp(testDeps({
  getDatabase: () => fake.db,
  templateSubmit: (input) => submitWhatsAppTemplate(
    {
      fetchFn: routeFetch,
      resolveAccessToken: async () => "tok",
      store: {
        upsert: async (row) => {
          const result = await upsertTemplateFromMeta(fake.db, row);
          return { row: result.row, created: result.created };
        },
        remove: (id) => deleteTemplate(fake.db, input.workspaceId, id),
      },
    },
    {
      workspaceId: input.workspaceId,
      account: { id: input.accountId, externalId: "15550001" },
      name: input.name,
      language: input.language,
      category: input.category,
      components: input.components,
    },
  ),
  templateDelete: async (input) => {
    const template = await getTemplate(fake.db, input.workspaceId, input.templateId);
    if (!template) throw new AppError("NOT_FOUND", "Template not found.", { status: 404 });
    return deleteWhatsAppTemplate(
      {
        fetchFn: routeFetch,
        resolveAccessToken: async () => "tok",
        store: {
          upsert: async (row) => {
            const result = await upsertTemplateFromMeta(fake.db, row);
            return { row: result.row, created: result.created };
          },
          remove: (id) => deleteTemplate(fake.db, input.workspaceId, id),
        },
      },
      { workspaceId: input.workspaceId, account: { id: input.accountId, externalId: "15550001" }, template },
    );
  },
}));

const unconfiguredApp = createApp(testDeps({ getDatabase: () => fake.db }));

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(wiredApp, "tpl-write-owner@example.com");
  unconfiguredOwner = await registerUser(unconfiguredApp, "tpl-write-owner2@example.com");
  fake.seed("channelAccounts", {
    id: "acc-wa", workspaceId: owner.workspaceId, channel: "whatsapp",
    externalId: "15550001", status: "connected", tokenVaultRef: "vault:db:ref-1", authMode: null,
  });
});

const postJson = (reg: Registered, path: string, payload: unknown) =>
  wiredApp.request(path, {
    method: "POST",
    headers: { ...reg.headers, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

describe("POST /templates/submit", () => {
  test("submits, mirrors the pending status and stores the component tree", async () => {
    const res = await postJson(owner, "/templates/submit", {
      channelAccountId: "acc-wa",
      name: "order_update",
      language: "id",
      category: "utility",
      components: [
        { type: "HEADER", format: "TEXT", text: "Status pesanan" },
        { type: "BODY", text: "Halo {{1}}, pesanan {{2}} siap." },
      ],
    });
    expect(res.status).toBe(201);
    const payload = await res.json() as { template: { id: string; status: string }; created: boolean };
    expect(payload.created).toBe(true);
    expect(payload.template.status).toBe("pending");

    const rows = await listTemplates(fake.db, owner.workspaceId);
    const row = rows.find((r) => r.name === "order_update")!;
    expect(row.status).toBe("pending");
    expect(row.externalId).toBe("tpl-new");
    expect(row.messagingAccountId).toBe("waba-9");
    expect((row.components as unknown[]).length).toBe(2);
  });

  test("an invalid tree is a 400 and never calls the provider", async () => {
    const before = routeCalls.length;
    const res = await postJson(owner, "/templates/submit", {
      channelAccountId: "acc-wa",
      name: "broken",
      language: "id",
      category: "utility",
      components: [{ type: "BODY", text: "{{1}} {{3}}" }],
    });
    expect(res.status).toBe(400);
    const payload = await res.json() as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("VALIDATION");
    expect(payload.error.message).toContain("sequential");
    expect(routeCalls.length).toBe(before);
  });

  test("validation runs even when the provider is unconfigured (400 before 503)", async () => {
    const res = await unconfiguredApp.request("/templates/submit", {
      method: "POST",
      headers: { ...unconfiguredOwner.headers, "content-type": "application/json" },
      body: JSON.stringify({
        channelAccountId: "acc-wa", name: "x", language: "id", category: "utility",
        components: [{ type: "HEADER", text: "tanpa body" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  test("an unconfigured submit answers 503 instead of pretending", async () => {
    const res = await unconfiguredApp.request("/templates/submit", {
      method: "POST",
      headers: { ...unconfiguredOwner.headers, "content-type": "application/json" },
      body: JSON.stringify({
        channelAccountId: "acc-wa", name: "x", language: "id", category: "utility",
        components: [{ type: "BODY", text: "Halo" }],
      }),
    });
    expect(res.status).toBe(503);
  });
});

describe("DELETE /templates/{id}", () => {
  test("deletes on Meta then locally", async () => {
    const rows = await listTemplates(fake.db, owner.workspaceId);
    const target = rows.find((r) => r.name === "order_update")!;
    const before = routeCalls.length;
    const res = await wiredApp.request(`/templates/${target.id}`, {
      method: "DELETE",
      headers: owner.headers,
    });
    expect(res.status).toBe(200);
    const payload = await res.json() as { deleted: boolean; wabaId: string };
    expect(payload).toEqual({ deleted: true, wabaId: "waba-9" });
    // the row knew its WABA, so no discovery call was made
    expect(routeCalls.length - before).toBe(1);
    expect(routeCalls.at(-1)!.method).toBe("DELETE");
    expect(await getTemplate(fake.db, owner.workspaceId, target.id)).toBeNull();
  });

  test("an unknown id is a typed 404", async () => {
    const res = await wiredApp.request("/templates/00000000-0000-4000-8000-000000000000", {
      method: "DELETE",
      headers: owner.headers,
    });
    expect(res.status).toBe(404);
  });
});

// --------------------------------------------------- broadcast pre-send gate

describe("broadcast template pre-send gate", () => {
  beforeAll(() => {
    const ws = owner.workspaceId;
    fake.seed("templates", {
      id: "tpl-pending", workspaceId: ws, channelAccountId: "acc-wa",
      name: "promo_pending", language: "id", category: "marketing", latestCategory: "marketing",
      status: "pending", components: [{ type: "BODY", text: "Halo" }],
    });
    fake.seed("templates", {
      id: "tpl-approved", workspaceId: ws, channelAccountId: "acc-wa",
      name: "promo_approved", language: "id", category: "marketing", latestCategory: "marketing",
      status: "approved", components: [{ type: "BODY", text: "Halo {{1}}, ada promo {{2}}" }],
    });
    fake.seed("templates", {
      id: "tpl-rejected", workspaceId: ws, channelAccountId: "acc-wa",
      name: "promo_rejected", language: "id", category: "marketing", latestCategory: "marketing",
      status: "rejected", rejectedReason: "INVALID_FORMAT",
      components: [{ type: "BODY", text: "Halo" }],
    });
  });

  test("a pending template is refused with an actionable message", async () => {
    const res = await postJson(owner, "/broadcasts", {
      channelAccountId: "acc-wa", templateId: "tpl-pending", recipientCount: 2,
    });
    expect(res.status).toBe(400);
    const payload = await res.json() as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("VALIDATION");
    expect(payload.error.message).toContain("not approved");
    expect(payload.error.message).toContain("pending");
  });

  test("a rejected template is refused too", async () => {
    const res = await postJson(owner, "/broadcasts", {
      channelAccountId: "acc-wa", templateId: "tpl-rejected", recipientCount: 2,
    });
    expect(res.status).toBe(400);
  });

  test("too few body parameters is refused before enqueue", async () => {
    const res = await postJson(owner, "/broadcasts", {
      channelAccountId: "acc-wa", templateId: "tpl-approved",
      templateParams: ["Sari"], recipientCount: 2,
    });
    expect(res.status).toBe(400);
    const payload = await res.json() as { error: { message: string } };
    expect(payload.error.message).toContain("2 body parameter(s)");
    expect(payload.error.message).toContain("1 were supplied");
  });

  test("too many body parameters is refused too", async () => {
    const res = await postJson(owner, "/broadcasts", {
      channelAccountId: "acc-wa", templateId: "tpl-approved",
      templateParams: ["Sari", "diskon", "extra"], recipientCount: 2,
    });
    expect(res.status).toBe(400);
  });

  test("an approved template with the exact parameter count is accepted", async () => {
    const res = await postJson(owner, "/broadcasts", {
      channelAccountId: "acc-wa", templateId: "tpl-approved",
      templateParams: ["Sari", "diskon 20%"], recipientCount: 2,
    });
    expect(res.status).toBe(201);
  });
});
