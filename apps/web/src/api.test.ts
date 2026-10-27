import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api, type PipelineSummary } from "./api";
import { boardTotals } from "./deals";

/**
 * Client-envelope regression tests. The API wraps payloads in a named
 * envelope ({ summary }, { contacts }, ...) and the client declares those
 * envelopes as its return types; callers unwrap. Package #6 shipped one
 * lie: getPipelineSummary declared Promise<PipelineSummary> while the API
 * returns { summary: PipelineSummary } (apps/api/src/app.ts), so the board
 * stored the envelope as the summary and the header's summary.open.count
 * threw on render - a white screen seconds after the board loaded.
 * These tests pin the client contract against the REAL wire shapes.
 */

const SUMMARY: PipelineSummary = {
  pipelineId: "p1",
  stages: [{ stageId: "s1", openCount: 2, openValue: 300 }],
  open: { count: 3, value: 450 },
  won: { count: 1, value: 200 },
  lost: { count: 2, value: 0 },
};

let realFetch: typeof fetch;
let realLocalStorage: unknown;
let lastUrl = "";

function stubFetchJson(payload: unknown, status = 200): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    lastUrl = String(input);
    return new Response(JSON.stringify(payload), {
      status, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  const g = globalThis as Record<string, unknown>;
  realLocalStorage = g.localStorage;
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  lastUrl = "";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as Record<string, unknown>).localStorage = realLocalStorage;
});

describe("api.getPipelineSummary envelope (#6 white-screen regression)", () => {
  test("the envelope unwraps to a summary whose open/won/lost counts are readable", async () => {
    // The exact wire shape of GET /pipelines/:id/summary: { summary }.
    stubFetchJson({ summary: SUMMARY });
    const res = await api.getPipelineSummary("p1");
    expect(lastUrl.endsWith("/pipelines/p1/summary")).toBe(true);
    // What DealsPage.loadBoard stores after the fix:
    const summary: PipelineSummary = res.summary;
    expect(summary.open.count).toBe(3);
    expect(summary.won.count).toBe(1);
    expect(summary.lost.count).toBe(2);
    expect(summary.stages[0]!.openCount).toBe(2);
  });

  test("header math runs off the unwrapped summary", async () => {
    stubFetchJson({ summary: SUMMARY });
    const { summary } = await api.getPipelineSummary("p1");
    // boardTotals feeds the header's money figures.
    expect(boardTotals(summary)).toEqual({ open: 450, won: 200, lost: 0 });
    // deletePipeline's confirm count: total deals across the buckets.
    expect(summary.open.count + summary.won.count + summary.lost.count).toBe(6);
  });
});

describe("api.listMessages quoted-reply fields (migration 0019)", () => {
  test("replyToExternalId + quotedMessage pass through the { messages } envelope intact", async () => {
    // The exact wire shape of GET /conversations/:id/messages for a
    // resolved quote and an unresolved one.
    stubFetchJson({
      messages: [{
        id: "m1", direction: "in", type: "text", body: "Sama sami",
        externalId: "wamid.REPLY", replyToExternalId: "wamid.ORIG",
        quotedMessage: { externalId: "wamid.ORIG", direction: "out", body: "Siap. Terima kasih" },
        status: "delivered", createdAt: "2026-10-27T00:00:00.000Z",
      }, {
        id: "m2", direction: "in", type: "text", body: "yang tadi mana?",
        externalId: "wamid.REPLY2", replyToExternalId: "wamid.GONE", quotedMessage: null,
        status: "delivered", createdAt: "2026-10-27T00:01:00.000Z",
      }],
    });
    const data = await api.listMessages("conv-1");
    expect(lastUrl.endsWith("/conversations/conv-1/messages")).toBe(true);
    // What MessageQuoteBlock reads: a resolved preview vs a bare ref.
    expect(data.messages[0]!.quotedMessage?.body).toBe("Siap. Terima kasih");
    expect(data.messages[0]!.replyToExternalId).toBe("wamid.ORIG");
    expect(data.messages[1]!.quotedMessage).toBeNull();
    expect(data.messages[1]!.replyToExternalId).toBe("wamid.GONE");
  });
});

describe("api.reply quote payload (outbound quotes)", () => {
  let lastBody: Record<string, unknown> | null;

  function stubFetchCapture(): void {
    lastBody = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      lastUrl = String(input);
      lastBody = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      return new Response(JSON.stringify({ message: { id: "m-out" }, delivery: "sent" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }

  test("includes replyToMessageId when a quote is pending", async () => {
    stubFetchCapture();
    await api.reply("conv-1", { kind: "free_form", text: "Masih ada kak", replyToMessageId: "m-in" });
    expect(lastUrl.endsWith("/conversations/conv-1/reply")).toBe(true);
    expect(lastBody?.replyToMessageId).toBe("m-in");
    expect(lastBody?.text).toBe("Masih ada kak");
  });

  test("omits replyToMessageId entirely when no quote is pending", async () => {
    stubFetchCapture();
    await api.reply("conv-1", { kind: "free_form", text: "tanpa kutipan" });
    expect(lastBody).not.toBeNull();
    expect("replyToMessageId" in (lastBody ?? {})).toBe(false);
  });
});

describe("api.listContacts envelope (ContactsPage add-contact reload path)", () => {
  test("returns data.contacts from the { contacts } envelope", async () => {
    stubFetchJson({
      contacts: [{
        id: "c1", workspaceId: "ws", channel: "whatsapp", externalId: "628111",
        displayName: "Rina", tags: [], customFields: {}, createdAt: "2026-10-27T00:00:00.000Z",
      }],
    });
    const data = await api.listContacts();
    expect(data.contacts).toHaveLength(1);
    expect(data.contacts[0]!.id).toBe("c1");
  });
});
