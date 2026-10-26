import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";

/**
 * Variables package #1 at the API surface:
 *  - inbox free-form replies interpolate against the conversation's
 *    contact and persist the RENDERED text; unknown variables render
 *    empty and surface as `interpolationWarnings`;
 *  - POST /broadcasts stores templateParams (and rejects them without a
 *    templateId);
 *  - sequence template steps carry templateParams through unchanged.
 */

let fake: FakeDatabase;
const app = createApp(testDeps({ getDatabase: () => fake.db }));
let owner: Registered;

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(app, "vars-owner@example.com");
  const ws = owner.workspaceId;
  fake.seed("workspaces", { id: ws, name: "Toko Uji", slug: "toko-uji" });
  fake.seed("channelAccounts", {
    id: "acc-webchat", workspaceId: ws, channel: "webchat",
    externalId: `webchat:${ws}`, displayName: "Webchat Toko", status: "connected",
    tokenVaultRef: null, authMode: null,
  });
  fake.seed("channelAccounts", {
    id: "acc-wa", workspaceId: ws, channel: "whatsapp",
    externalId: "628000111", displayName: "WA Bisnis", status: "connected",
    tokenVaultRef: null, authMode: null,
  });
  fake.seed("contacts", {
    id: "contact-1", workspaceId: ws, channel: "webchat",
    externalId: "webchat-session:sess-1", displayName: "Sari Wulandari",
    tags: ["vip"], customFields: { city: "Depok" },
  });
  fake.seed("conversations", {
    id: "conv-1", workspaceId: ws, channelAccountId: "acc-webchat",
    contactId: "contact-1", status: "open", assignedUserId: null,
    lastUserMessageAt: new Date(),
  });
  fake.seed("webchatSessions", {
    id: "sess-1", workspaceId: ws, token: "visitor-token-1",
    contactId: "contact-1", conversationId: "conv-1",
    visitorName: "Sari", lastSeenAt: new Date(),
  });
  fake.seed("templates", {
    id: "tpl-1", workspaceId: ws, channelAccountId: "acc-wa",
    name: "promo", language: "id", category: "utility", latestCategory: "utility",
  });
});

describe("inbox reply interpolation", () => {
  test("renders contact/workspace variables, persists rendered text, warns on unknown", async () => {
    const res = await app.request("/conversations/conv-1/reply", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "free_form",
        text: "Halo {{contact.name}} dari {{contact.city}} ({{contact.tags}}) — salam dari {{workspace.name}} via {{channel.name}}. [{{contact.unknown}}]",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      message: { body: string };
      interpolationWarnings?: string[];
    };
    expect(body.message.body).toBe("Halo Sari Wulandari dari Depok (vip) — salam dari Toko Uji via Webchat Toko. []");
    expect(body.interpolationWarnings).toEqual(["contact.unknown"]);

    const outRows = fake.rows.messages.filter((m) => m.conversationId === "conv-1" && m.direction === "out");
    expect(outRows).toHaveLength(1);
    expect(outRows[0]!.body).toBe(body.message.body);
  });

  test("a reply without variables has no interpolationWarnings field", async () => {
    const res = await app.request("/conversations/conv-1/reply", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ kind: "free_form", text: "Pesan biasa tanpa variabel." }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { interpolationWarnings?: string[] };
    expect(body.interpolationWarnings).toBeUndefined();
  });
});

describe("broadcast templateParams", () => {
  test("stored on the broadcast and exposed by the detail serializer", async () => {
    const res = await app.request("/broadcasts", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({
        channelAccountId: "acc-wa",
        templateId: "tpl-1",
        templateParams: ["{{contact.name}}", "promo-oktober"],
        recipientCount: 3,
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { broadcast: { id: string; templateParams?: string[] } };
    expect(created.broadcast.templateParams).toEqual(["{{contact.name}}", "promo-oktober"]);

    const detail = await app.request(`/broadcasts/${created.broadcast.id}`, { headers: owner.headers });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { broadcast: { templateParams?: string[] } };
    expect(detailBody.broadcast.templateParams).toEqual(["{{contact.name}}", "promo-oktober"]);
  });

  test("templateParams without a templateId is a typed 400 VALIDATION", async () => {
    const res = await app.request("/broadcasts", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({
        channelAccountId: "acc-wa",
        templateParams: ["{{contact.name}}"],
        recipientCount: 3,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });
});

describe("sequence template step params", () => {
  test("templateParams round-trip through create", async () => {
    const res = await app.request("/sequences", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({
        channelAccountId: "acc-wa",
        name: "Drip Promo",
        steps: [
          { delaySeconds: 0, text: "Halo {{contact.name}}" },
          {
            delaySeconds: 3600,
            template: {
              name: "promo", language: "id", latestCategory: "utility",
              templateParams: ["{{contact.name}}", "{{contact.city}}"],
            },
          },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      sequence: { steps: Array<{ text?: string; template?: { templateParams?: string[] } }> };
    };
    expect(body.sequence.steps[0]!.text).toBe("Halo {{contact.name}}");
    expect(body.sequence.steps[1]!.template?.templateParams).toEqual(["{{contact.name}}", "{{contact.city}}"]);
  });
});
