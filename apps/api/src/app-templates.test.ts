import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";

/**
 * FK-validation audit (bug fix after package #1 live verification):
 * create routes that take a channelAccountId (or templateId) from the
 * request body must validate workspace ownership BEFORE inserting, so a
 * bogus or cross-workspace id is a typed 404 NOT_FOUND - never a raw FK
 * violation surfacing as a 500. POST /templates was the one route missing
 * the check; broadcasts / sequences / posts / growth-links already had it
 * and are pinned here as regression guards. A cross-workspace id must be
 * indistinguishable from a nonexistent one.
 */

let fake: FakeDatabase;
const app = createApp(testDeps({ getDatabase: () => fake.db }));
let owner: Registered;
let other: Registered;

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(app, "tpl-owner@example.com");
  other = await registerUser(app, "tpl-other@example.com");
  const ws = owner.workspaceId;
  const wsOther = other.workspaceId;
  fake.seed("workspaces", { id: ws, name: "Toko Satu", slug: "toko-satu" });
  fake.seed("workspaces", { id: wsOther, name: "Toko Dua", slug: "toko-dua" });
  fake.seed("channelAccounts", {
    id: "acc-wa", workspaceId: ws, channel: "whatsapp",
    externalId: "628000111", displayName: "WA Bisnis", status: "connected",
    tokenVaultRef: null, authMode: null,
  });
  fake.seed("channelAccounts", {
    id: "acc-other", workspaceId: wsOther, channel: "whatsapp",
    externalId: "628000222", displayName: "WA Tetangga", status: "connected",
    tokenVaultRef: null, authMode: null,
  });
  fake.seed("templates", {
    id: "tpl-other", workspaceId: wsOther, channelAccountId: "acc-other",
    name: "promo-tetangga", language: "id", category: "utility", latestCategory: "utility",
  });
});

async function postJson(reg: Registered, path: string, body: unknown) {
  const res = await app.request(path, {
    method: "POST",
    headers: { ...reg.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, body: (await res.json()) as { error?: { code: string; message: string } } };
}

describe("POST /templates channel account validation", () => {
  test("happy path: own-workspace account creates the template", async () => {
    const before = fake.rows.templates.length;
    const { res, body } = await postJson(owner, "/templates", {
      channelAccountId: "acc-wa", name: "promo-sendiri", language: "id", category: "marketing",
    });
    expect(res.status).toBe(201);
    expect(body.error).toBeUndefined();
    expect(fake.rows.templates.length).toBe(before + 1);
  });

  test("nonexistent account id is a typed 404 NOT_FOUND, nothing inserted", async () => {
    const before = fake.rows.templates.length;
    const { res, body } = await postJson(owner, "/templates", {
      channelAccountId: "acc-tidak-ada", name: "promo-hantu",
    });
    expect(res.status).toBe(404);
    expect(body.error?.code).toBe("NOT_FOUND");
    expect(fake.rows.templates.length).toBe(before);
  });

  test("cross-workspace account id is indistinguishable from nonexistent", async () => {
    const before = fake.rows.templates.length;
    const missing = await postJson(owner, "/templates", {
      channelAccountId: "acc-tidak-ada", name: "promo-hantu",
    });
    const cross = await postJson(owner, "/templates", {
      channelAccountId: "acc-other", name: "promo-hantu",
    });
    expect(cross.res.status).toBe(missing.res.status);
    expect(cross.body.error?.code).toBe(missing.body.error?.code);
    expect(cross.body.error?.message).toBe(missing.body.error?.message);
    expect(fake.rows.templates.length).toBe(before);
  });
});

describe("sibling create routes keep their account validation (regression guards)", () => {
  test("POST /broadcasts: nonexistent and cross-workspace accounts are 404 NOT_FOUND", async () => {
    for (const channelAccountId of ["acc-tidak-ada", "acc-other"]) {
      const { res, body } = await postJson(owner, "/broadcasts", {
        channelAccountId, recipientCount: 3,
      });
      expect(res.status).toBe(404);
      expect(body.error?.code).toBe("NOT_FOUND");
    }
  });

  test("POST /broadcasts: cross-workspace templateId is 404 NOT_FOUND", async () => {
    const { res, body } = await postJson(owner, "/broadcasts", {
      channelAccountId: "acc-wa", templateId: "tpl-other", recipientCount: 3,
    });
    expect(res.status).toBe(404);
    expect(body.error?.code).toBe("NOT_FOUND");
  });

  test("POST /sequences: nonexistent and cross-workspace accounts are 404 NOT_FOUND", async () => {
    for (const channelAccountId of ["acc-tidak-ada", "acc-other"]) {
      const { res, body } = await postJson(owner, "/sequences", {
        channelAccountId, name: "Drip", steps: [{ delaySeconds: 0, text: "Halo" }],
      });
      expect(res.status).toBe(404);
      expect(body.error?.code).toBe("NOT_FOUND");
    }
  });

  test("POST /posts: targets naming nonexistent or cross-workspace accounts are 404 NOT_FOUND", async () => {
    for (const channelAccountId of ["acc-tidak-ada", "acc-other"]) {
      const { res, body } = await postJson(owner, "/posts", {
        text: "Halo", targets: [{ channelAccountId }],
      });
      expect(res.status).toBe(404);
      expect(body.error?.code).toBe("NOT_FOUND");
    }
  });

  test("POST /growth-links: nonexistent and cross-workspace accounts are 404 NOT_FOUND", async () => {
    for (const channelAccountId of ["acc-tidak-ada", "acc-other"]) {
      const { res, body } = await postJson(owner, "/growth-links", {
        channelAccountId, label: "Link uji",
      });
      expect(res.status).toBe(404);
      expect(body.error?.code).toBe("NOT_FOUND");
    }
  });
});
