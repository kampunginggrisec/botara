import { beforeAll, describe, expect, test } from "bun:test";
import { createChannelAccount } from "@botara/db";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";
import { InMemoryVault } from "./whatsapp-onboarding";

/**
 * Channel account avatars:
 * - GET /channels/accounts lists avatarUrl (round-trip from the row).
 * - GET /channels/accounts/{id}/avatar proxies a TELEGRAM bot's profile
 *   photo bytes (its file URL embeds the bot token and is never exposed):
 *   own workspace -> 200 image bytes + private cache header; another
 *   workspace -> 404; non-telegram account -> 404; bot without a profile
 *   photo -> 404; unauthenticated -> 401.
 */

let fake: FakeDatabase;
const vault = new InMemoryVault();
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0x10, 0x20, 0x30]);
let photosEmpty = false;

const providerFetch = async (input: string | URL): Promise<Response> => {
  const url = String(input);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (url.endsWith("/getUserProfilePhotos")) {
    return json({
      ok: true,
      result: photosEmpty
        ? { total_count: 0, photos: [] }
        : { total_count: 1, photos: [[{ file_id: "s", width: 160, height: 160 }, { file_id: "m", width: 320, height: 320 }]] },
    });
  }
  if (url.endsWith("/getFile")) return json({ ok: true, result: { file_path: "photos/avatar.jpg" } });
  if (url.includes("/file/bot")) {
    return new Response(JPEG_BYTES, { status: 200, headers: { "Content-Type": "image/jpeg" } });
  }
  return json({});
};

const app = createApp(testDeps({
  getDatabase: () => fake.db,
  vault,
  providerFetch: providerFetch as never,
}));

let owner: Registered;
let second: Registered;
let telegramAccountId: string;
let whatsappAccountId: string;

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(app, "avatar-owner@example.com", "Olivia Owner");
  second = await registerUser(app, "avatar-second@example.com", "Sam Second");

  const ref = await vault.store({
    channel: "telegram",
    workspaceId: owner.workspaceId,
    label: "avatar-test bot",
    secret: "123456:TEST-BOT-TOKEN",
  });
  const telegram = await createChannelAccount(fake.db, {
    workspaceId: owner.workspaceId,
    channel: "telegram",
    externalId: "555000111",
    displayName: "@avatar_test_bot",
    tokenVaultRef: ref,
  });
  telegramAccountId = telegram.id;

  const whatsapp = await createChannelAccount(fake.db, {
    workspaceId: owner.workspaceId,
    channel: "whatsapp",
    externalId: "pn-1",
    displayName: "Toko Berkah",
    avatarUrl: "https://cdn.example.com/wa-profile.jpg",
  });
  whatsappAccountId = whatsapp.id;
});

describe("GET /channels/accounts avatarUrl serializer", () => {
  test("avatarUrl round-trips; telegram accounts carry null (never a token-bearing URL)", async () => {
    const res = await app.request("/channels/accounts", { headers: owner.headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: Array<{ id: string; avatarUrl: string | null }> };
    const wa = body.accounts.find((a) => a.id === whatsappAccountId);
    expect(wa?.avatarUrl).toBe("https://cdn.example.com/wa-profile.jpg");
    const tg = body.accounts.find((a) => a.id === telegramAccountId);
    expect(tg?.avatarUrl).toBeNull();
  });
});

describe("GET /channels/accounts/{id}/avatar (telegram proxy)", () => {
  test("own workspace telegram account -> 200 image bytes with private cache header", async () => {
    photosEmpty = false;
    const res = await app.request(`/channels/accounts/${telegramAccountId}/avatar`, { headers: owner.headers });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG_BYTES);
  });

  test("another workspace's account -> 404", async () => {
    const res = await app.request(`/channels/accounts/${telegramAccountId}/avatar`, { headers: second.headers });
    expect(res.status).toBe(404);
  });

  test("non-telegram account -> 404 (its avatarUrl is rendered directly instead)", async () => {
    const res = await app.request(`/channels/accounts/${whatsappAccountId}/avatar`, { headers: owner.headers });
    expect(res.status).toBe(404);
  });

  test("bot without a profile photo -> 404", async () => {
    photosEmpty = true;
    try {
      const res = await app.request(`/channels/accounts/${telegramAccountId}/avatar`, { headers: owner.headers });
      expect(res.status).toBe(404);
    } finally {
      photosEmpty = false;
    }
  });

  test("unauthenticated -> 401", async () => {
    const res = await app.request(`/channels/accounts/${telegramAccountId}/avatar`);
    expect(res.status).toBe(401);
  });
});
