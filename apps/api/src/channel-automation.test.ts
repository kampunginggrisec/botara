import { beforeAll, describe, expect, test } from "bun:test";
import { AppError } from "@botara/shared";
import type { ChannelAdapter, MessengerProfileInput } from "@botara/channels";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";
import {
  LIMITS,
  resolveAutomationAdapter,
  validateFlowName,
  validateProfileFields,
  validateProfileInput,
  validateWelcomeFlow,
  type ChannelAutomationPort,
} from "./channel-automation";

/**
 * Instagram automation (IG-1 welcome flows, IG-2 messaging profile).
 *
 * Three layers pinned separately:
 *   1. the validators - they encode Meta's documented limits, and a wrong
 *      one either blocks a legitimate flow or spends a provider round-trip
 *      on an error the operator could have been told up front;
 *   2. the resolver - workspace boundary + channel gate, the two things a
 *      route must never skip;
 *   3. the routes - workspace propagation, validation-before-provider, and
 *      the shape handed to the port.
 */

const flowMessage = (text: string) => ({ message: { text } });

// ------------------------------------------------------------- validators

describe("welcome flow validators", () => {
  test("names are trimmed and capped", () => {
    expect(validateFlowName("  Customer intake  ")).toBe("Customer intake");
    expect(() => validateFlowName("   ")).toThrow(/needs a name/i);
    expect(() => validateFlowName("x".repeat(LIMITS.flowName + 1))).toThrow(/limit is 100/i);
  });

  test("a flow needs at least one message with text", () => {
    expect(() => validateWelcomeFlow([])).toThrow(/at least one message/i);
    expect(() => validateWelcomeFlow([{}])).toThrow(/must have a "message"/i);
    expect(() => validateWelcomeFlow([{ message: { text: "  " } }])).toThrow(/non-empty text/i);
    expect(() => validateWelcomeFlow([flowMessage("x".repeat(LIMITS.messageText + 1))])).toThrow(/limit is 640/i);
  });

  test("quick replies are normalized to content_type=text", () => {
    const normalized = validateWelcomeFlow([
      { message: { text: "Halo", quick_replies: [{ title: " Ya ", payload: " yes " }] } },
    ]);
    expect(normalized).toEqual([
      { message: { text: "Halo", quick_replies: [{ content_type: "text", title: "Ya", payload: "yes" }] } },
    ]);
  });

  test("quick reply limits and required fields are named in the error", () => {
    const withReplies = (replies: unknown[]) => [{ message: { text: "Halo", quick_replies: replies } }];
    expect(() => validateWelcomeFlow(withReplies([]))).toThrow(/non-empty array/i);
    expect(() => validateWelcomeFlow(withReplies(
      Array.from({ length: LIMITS.quickReplies + 1 }, (_, i) => ({ title: `t${i}`, payload: `p${i}` })),
    ))).toThrow(/limit is 11/i);
    expect(() => validateWelcomeFlow(withReplies([{ title: "x".repeat(21), payload: "p" }]))).toThrow(/limit is 20/i);
    expect(() => validateWelcomeFlow(withReplies([{ title: "Ya" }]))).toThrow(/needs a payload/i);
  });

  test("unknown keys are dropped rather than forwarded", () => {
    const normalized = validateWelcomeFlow([{ message: { text: "Halo", junk: true }, extra: 1 }]) as Array<Record<string, unknown>>;
    expect(Object.keys(normalized[0]!)).toEqual(["message"]);
    expect(Object.keys(normalized[0]!.message as Record<string, unknown>)).toEqual(["text"]);
  });
});

describe("messaging profile validators", () => {
  test("an empty write is refused (nothing to update)", () => {
    expect(() => validateProfileInput({})).toThrow(/Nothing to update/i);
  });

  test("menu items: type, title, url/payload and the 3-item ceiling", () => {
    const menu = (items: unknown[]) => ({ persistentMenu: { items } });
    expect(() => validateProfileInput(menu([]))).toThrow(/at least one item/i);
    expect(() => validateProfileInput(menu(
      Array.from({ length: LIMITS.menuItems + 1 }, (_, i) => ({ type: "postback", title: `m${i}`, payload: `p${i}` })),
    ))).toThrow(/at most 3 items/i);
    expect(() => validateProfileInput(menu([{ type: "carousel", title: "X", payload: "p" }]))).toThrow(/postback.*web_url/i);
    expect(() => validateProfileInput(menu([{ type: "web_url", title: "Toko" }]))).toThrow(/http\(s\) url/i);
    expect(() => validateProfileInput(menu([{ type: "postback", title: "Bantuan" }]))).toThrow(/needs a payload/i);
    expect(() => validateProfileInput(menu([{ type: "postback", title: "x".repeat(31), payload: "p" }])))
      .toThrow(/limit is 30/i);
  });

  test("a valid menu normalizes to postback/web_url entries", () => {
    const profile = validateProfileInput({
      persistentMenu: {
        items: [
          { type: "postback", title: "Bantuan", payload: "CARE_HELP" },
          { type: "web_url", title: "Toko", url: "https://toko.test" },
        ],
        locale: "id_ID",
      },
    });
    expect(profile.persistentMenu).toEqual({
      items: [
        { type: "postback", title: "Bantuan", payload: "CARE_HELP" },
        { type: "web_url", title: "Toko", url: "https://toko.test" },
      ],
      locale: "id_ID",
    });
  });

  test("ice breakers: 4 max, question 80 chars, payload required", () => {
    expect(() => validateProfileInput({ iceBreakers: [] })).toThrow(/non-empty array/i);
    expect(() => validateProfileInput({
      iceBreakers: Array.from({ length: LIMITS.iceBreakers + 1 }, (_, i) => ({ question: `q${i}`, payload: `p${i}` })),
    })).toThrow(/at most 4/i);
    expect(() => validateProfileInput({
      iceBreakers: [{ question: "x".repeat(LIMITS.iceBreakerQuestion + 1), payload: "p" }],
    })).toThrow(/limit is 80/i);
    expect(() => validateProfileInput({ iceBreakers: [{ question: "Ada promo?" }] })).toThrow(/needs a payload/i);
  });

  test("getStarted needs a payload", () => {
    expect(validateProfileInput({ getStarted: " START " })).toEqual({ getStarted: "START" });
    expect(() => validateProfileInput({ getStarted: "   " })).toThrow(/non-empty payload/i);
  });

  test("profile fields are an allow-list, de-duplicated", () => {
    expect(validateProfileFields(["persistent_menu", "persistent_menu"])).toEqual(["persistent_menu"]);
    expect(() => validateProfileFields(["menu"])).toThrow(/Unknown profile field/i);
    expect(() => validateProfileFields([])).toThrow(/non-empty array/i);
  });
});

// --------------------------------------------------------------- resolver

describe("resolveAutomationAdapter", () => {
  let fake: FakeDatabase;
  const adapterStub = { key: "instagram" } as unknown as ChannelAdapter;
  const getAdapterStub = () => adapterStub;

  beforeAll(() => {
    fake = createFakeDatabase();
    fake.seed("channelAccounts", {
      id: "acc-ig", workspaceId: "ws-1", channel: "instagram",
      externalId: "ig-1", status: "connected", authMode: "instagram-login", tokenVaultRef: "vault:ig",
    });
    fake.seed("channelAccounts", {
      id: "acc-tg", workspaceId: "ws-1", channel: "telegram",
      externalId: "tg-1", status: "connected", authMode: null, tokenVaultRef: null,
    });
    fake.seed("channelAccounts", {
      id: "acc-foreign", workspaceId: "ws-2", channel: "instagram",
      externalId: "ig-2", status: "connected", authMode: null, tokenVaultRef: null,
    });
  });

  test("returns a nullable-free account ref for an own-workspace account", async () => {
    const { account, adapter } = await resolveAutomationAdapter(
      fake.db, "ws-1", "acc-ig", ["instagram"], getAdapterStub,
    );
    expect(adapter).toBe(adapterStub);
    expect(account).toEqual({ id: "acc-ig", externalId: "ig-1", authMode: "instagram-login", tokenVaultRef: "vault:ig" });
    // null columns must not leak through as null
    expect("tokenExpiresAt" in account).toBe(false);
  });

  test("a foreign-workspace account is a 404, indistinguishable from missing", async () => {
    await expect(resolveAutomationAdapter(fake.db, "ws-1", "acc-foreign", ["instagram"], getAdapterStub))
      .rejects.toThrow(/not found/i);
  });

  test("a channel without the surface is a typed 400 naming both sides", async () => {
    await expect(resolveAutomationAdapter(fake.db, "ws-1", "acc-tg", ["instagram"], getAdapterStub))
      .rejects.toThrow(/only available for instagram accounts \(this one is telegram\)/i);
  });
});

// ------------------------------------------------------------ route wiring

interface Recorded {
  workspaceId: string;
  accountId: string;
  extra?: Record<string, unknown>;
}

const calls: Recorded[] = [];

const port: ChannelAutomationPort = {
  welcomeFlows: {
    async list(input) {
      calls.push({ workspaceId: input.workspaceId, accountId: input.accountId });
      return [{
        id: "flow-1", name: "Customer intake", flow: [flowMessage("Halo")], lastUpdateTime: "2025-08-14T19:06:34+0000",
      }];
    },
    async get(input) {
      calls.push({ workspaceId: input.workspaceId, accountId: input.accountId, extra: { flowId: input.flowId } });
      return input.flowId === "flow-1"
        ? { id: "flow-1", name: "Customer intake", flow: [flowMessage("Halo")] }
        : null;
    },
    async create(input) {
      calls.push({ workspaceId: input.workspaceId, accountId: input.accountId, extra: { name: input.name, flow: input.flow } });
      return { id: "flow-new" };
    },
    async update(input) {
      calls.push({ workspaceId: input.workspaceId, accountId: input.accountId, extra: { flowId: input.flowId, name: input.name } });
      return { id: input.flowId };
    },
    async remove(input) {
      calls.push({ workspaceId: input.workspaceId, accountId: input.accountId, extra: { flowId: input.flowId } });
    },
  },
  profile: {
    async get(input) {
      calls.push({ workspaceId: input.workspaceId, accountId: input.accountId, extra: { fields: input.fields } });
      return { data: [{ persistent_menu: [{ call_to_actions: [] }] }] };
    },
    async set(input) {
      calls.push({ workspaceId: input.workspaceId, accountId: input.accountId, extra: { profile: input.profile } });
    },
    async remove(input) {
      calls.push({ workspaceId: input.workspaceId, accountId: input.accountId, extra: { fields: input.fields } });
    },
  },
};

const app = createApp(testDeps({ channelAutomation: port }));
let owner: Registered;

beforeAll(async () => {
  owner = await registerUser(app, "ig-automation@example.com");
});

const json = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { ...owner.headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("welcome flow routes", () => {
  test("list scopes to the authenticated workspace and the path account", async () => {
    calls.length = 0;
    const res = await json("GET", "/channels/acc-ig/welcome-flows");
    expect(res.status).toBe(200);
    const body = await res.json() as { flows: Array<{ id: string }> };
    expect(body.flows[0]!.id).toBe("flow-1");
    expect(calls[0]).toEqual({ workspaceId: owner.workspaceId, accountId: "acc-ig" });
  });

  test("get returns 404 when the provider has no such flow", async () => {
    expect((await json("GET", "/channels/acc-ig/welcome-flows/flow-1")).status).toBe(200);
    expect((await json("GET", "/channels/acc-ig/welcome-flows/nope")).status).toBe(404);
  });

  test("create validates BEFORE the port is called", async () => {
    calls.length = 0;
    const bad = await json("POST", "/channels/acc-ig/welcome-flows", {
      name: "Flow", flow: [{ message: { text: "" } }],
    });
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: { message: string } }).error.message).toMatch(/non-empty text/i);
    expect(calls).toHaveLength(0);
  });

  test("create normalizes the body and returns 201", async () => {
    calls.length = 0;
    const res = await json("POST", "/channels/acc-ig/welcome-flows", {
      name: "  Welcome  ",
      flow: [{ message: { text: "Halo", quick_replies: [{ title: "Ya", payload: "yes" }] } }],
    });
    expect(res.status).toBe(201);
    expect(await res.json() as { id: string }).toEqual({ id: "flow-new" });
    expect(calls[0]!.extra).toEqual({
      name: "Welcome",
      flow: [{ message: { text: "Halo", quick_replies: [{ content_type: "text", title: "Ya", payload: "yes" }] } }],
    });
  });

  test("update and delete address the flow id", async () => {
    calls.length = 0;
    const patch = await json("PATCH", "/channels/acc-ig/welcome-flows/flow-1", {
      name: "Renamed", flow: [{ message: { text: "Baru" } }],
    });
    expect(patch.status).toBe(200);
    const del = await json("DELETE", "/channels/acc-ig/welcome-flows/flow-1");
    expect(del.status).toBe(200);
    expect(calls.map((c) => c.extra?.flowId)).toEqual(["flow-1", "flow-1"]);
  });
});

describe("messaging profile routes", () => {
  test("get defaults to every supported field", async () => {
    calls.length = 0;
    const res = await json("GET", "/channels/acc-ig/messenger-profile");
    expect(res.status).toBe(200);
    expect(calls[0]!.extra).toEqual({ fields: ["persistent_menu", "ice_breakers", "get_started"] });
  });

  test("get narrows to the requested fields", async () => {
    calls.length = 0;
    await json("GET", "/channels/acc-ig/messenger-profile?fields=persistent_menu");
    expect(calls[0]!.extra).toEqual({ fields: ["persistent_menu"] });
  });

  test("an unknown field is a 400 before the port", async () => {
    calls.length = 0;
    const res = await json("GET", "/channels/acc-ig/messenger-profile?fields=menu");
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("put normalizes and forwards the profile", async () => {
    calls.length = 0;
    const res = await json("PUT", "/channels/acc-ig/messenger-profile", {
      persistentMenu: { items: [{ type: "postback", title: " Bantuan ", payload: "CARE_HELP" }] },
    });
    expect(res.status).toBe(200);
    const profile = calls[0]!.extra!.profile as MessengerProfileInput;
    expect(profile.persistentMenu?.items).toEqual([{ type: "postback", title: "Bantuan", payload: "CARE_HELP" }]);
    expect(profile.iceBreakers).toBeUndefined();
  });

  test("an empty put is a 400 (nothing to update)", async () => {
    const res = await json("PUT", "/channels/acc-ig/messenger-profile", {});
    expect(res.status).toBe(400);
  });

  test("delete requires and forwards the field list", async () => {
    calls.length = 0;
    const res = await json("DELETE", "/channels/acc-ig/messenger-profile?fields=ice_breakers");
    expect(res.status).toBe(200);
    expect(calls[0]!.extra).toEqual({ fields: ["ice_breakers"] });
    expect((await json("DELETE", "/channels/acc-ig/messenger-profile")).status).toBe(400);
  });
});

describe("unconfigured automation", () => {
  test("answers 503 instead of pretending", async () => {
    const bare = createApp(testDeps());
    const reg = await registerUser(bare, "ig-automation-2@example.com");
    const res = await bare.request("/channels/acc-ig/welcome-flows", { headers: reg.headers });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CONFIGURATION");
  });
});

// Keep the AppError import meaningful for readers: every rejection above is
// a typed AppError, never a raw throw.
test("validators throw typed AppErrors", () => {
  expect(() => validateFlowName("")).toThrow(AppError);
});
