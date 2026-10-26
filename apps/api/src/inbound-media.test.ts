import { describe, expect, test } from "bun:test";
import {
  StaticCredentialProvider, TelegramAdapter, TikTokAdapter, WhatsAppAdapter,
  serializeTikTokTokenPair, type FetchLike,
} from "@botara/channels";
import { createInboundMediaPort } from "./inbound-media";
import type { DispatchAccount } from "./flows-dispatch";

/**
 * The production inbound media port over REAL adapters with mocked
 * HTTP (the established adapter test style) and a fake object store:
 * per-channel fetch shapes, the byte cap, and the never-throw /
 * null-on-any-failure degradation contract.
 */

const WA_ACCOUNT: DispatchAccount = {
  id: "acc-wa", workspaceId: "ws-1", channel: "whatsapp", externalId: "10987",
  status: "connected", tokenVaultRef: "vault:wa-1",
};
const TG_ACCOUNT: DispatchAccount = {
  id: "acc-tg", workspaceId: "ws-1", channel: "telegram", externalId: "555",
  status: "connected", tokenVaultRef: "vault:tg-1",
};
const MSG_ACCOUNT: DispatchAccount = {
  id: "acc-msg", workspaceId: "ws-1", channel: "messenger", externalId: "page-1",
  status: "connected", tokenVaultRef: "vault:msg-1",
};
const TT_ACCOUNT: DispatchAccount = {
  id: "acc-tt", workspaceId: "ws-1", channel: "tiktok", externalId: "open-123",
  status: "connected", tokenVaultRef: "vault:tt-1",
};

/** TikTok: download endpoint returns a download_url; the URL returns bytes (x-user header checked). */
function tiktokAdapter(payload: Uint8Array) {
  const fetchFn: FetchLike = async (input, init) => {
    const url = String(input);
    if (url.includes("/business/message/media/download/")) {
      return new Response(JSON.stringify({
        code: 0, message: "OK",
        data: { download_url: "https://cdn.tiktok.example/dl/xyz" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "https://cdn.tiktok.example/dl/xyz") {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers["x-user"] !== "tt-access") return new Response("forbidden", { status: 403 });
      return new Response(payload, { status: 200, headers: { "Content-Type": "image/jpeg" } });
    }
    return new Response("not found", { status: 404 });
  };
  return new TikTokAdapter({
    credentials: new StaticCredentialProvider({
      accessToken: serializeTikTokTokenPair({ accessToken: "tt-access", refreshToken: "tt-refresh", openId: "open-123" }),
    }),
    fetchFn,
  });
}

interface StoredCall { key: string; data: Uint8Array; contentType: string }

function fakeStore(options: { withPublicUrl?: boolean; throws?: boolean } = {}) {
  const calls: StoredCall[] = [];
  const putObjectFn = async (key: string, data: Uint8Array, contentType: string) => {
    if (options.throws) throw new Error("R2 credentials are not configured");
    calls.push({ key, data, contentType });
    return {
      key,
      ...(options.withPublicUrl === false ? {} : { publicUrl: `https://media.example/${key}` }),
    };
  };
  return { calls, putObjectFn };
}

/** WhatsApp Graph: media lookup returns a download URL; the URL returns bytes. */
function whatsappAdapter(payload: Uint8Array, fileSize?: number) {
  const fetchFn: FetchLike = async (input) => {
    const url = String(input);
    if (url.includes("lookaside.example")) {
      return new Response(payload, { status: 200, headers: { "Content-Type": "image/jpeg" } });
    }
    return new Response(JSON.stringify({
      url: "https://lookaside.example/media-download",
      mime_type: "image/jpeg",
      ...(fileSize !== undefined ? { file_size: fileSize } : {}),
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return new WhatsAppAdapter({
    credentials: new StaticCredentialProvider({ accessToken: "wa-token" }),
    fetchFn,
  });
}

function telegramAdapter(payload: Uint8Array, fileSize?: number) {
  const fetchFn: FetchLike = async (input) => {
    const url = String(input);
    if (url.endsWith("/getFile")) {
      return new Response(JSON.stringify({
        ok: true,
        result: { file_id: "file-9", file_path: "documents/file_9.pdf", ...(fileSize !== undefined ? { file_size: fileSize } : {}) },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(payload, { status: 200 });
  };
  return new TelegramAdapter({
    credentials: new StaticCredentialProvider({ botToken: "123456:TEST" }),
    fetchFn,
  });
}

describe("inbound media port", () => {
  test("whatsapp: media id -> adapter download -> stored under a workspace-scoped key", async () => {
    const bytes = new Uint8Array([10, 20, 30]);
    const store = fakeStore();
    const port = createInboundMediaPort({
      getAdapterFn: () => whatsappAdapter(bytes),
      putObjectFn: store.putObjectFn,
    });
    const result = await port.fetchAndStore({
      workspaceId: "ws-1", account: WA_ACCOUNT, channel: "whatsapp",
      media: { type: "image", id: "wa-media-1", mimeType: "image/jpeg" },
      messageExternalId: "wamid.M1",
    });
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]!.key).toBe("workspaces/ws-1/inbound/wamid.M1/image.jpg");
    expect(store.calls[0]!.data).toEqual(bytes);
    expect(store.calls[0]!.contentType).toBe("image/jpeg");
    expect(result).toEqual({
      urls: ["https://media.example/workspaces/ws-1/inbound/wamid.M1/image.jpg"],
      keys: ["workspaces/ws-1/inbound/wamid.M1/image.jpg"],
    });
  });

  test("telegram: file_id -> adapter download -> media filename preserved", async () => {
    const store = fakeStore();
    const port = createInboundMediaPort({
      getAdapterFn: () => telegramAdapter(new Uint8Array([1, 2])),
      putObjectFn: store.putObjectFn,
    });
    const result = await port.fetchAndStore({
      workspaceId: "ws-1", account: TG_ACCOUNT, channel: "telegram",
      media: { type: "document", id: "file-9", filename: "invoice final.pdf", mimeType: "application/pdf" },
      messageExternalId: "tg-9",
    });
    expect(store.calls[0]!.key).toBe("workspaces/ws-1/inbound/tg-9/invoice_final.pdf");
    expect(result?.keys).toEqual(["workspaces/ws-1/inbound/tg-9/invoice_final.pdf"]);
  });

  test("messenger: attachment url fetched directly (no adapter), content type from the response", async () => {
    const store = fakeStore();
    const fetchFn: FetchLike = async () => new Response(new Uint8Array([7, 7]), {
      status: 200, headers: { "Content-Type": "image/png" },
    });
    const port = createInboundMediaPort({ fetchFn, putObjectFn: store.putObjectFn });
    const result = await port.fetchAndStore({
      workspaceId: "ws-1", account: MSG_ACCOUNT, channel: "messenger",
      media: { type: "image", url: "https://cdn.example.com/x.png" },
      messageExternalId: "mid-9",
    });
    expect(store.calls[0]!.key).toBe("workspaces/ws-1/inbound/mid-9/image.png");
    expect(result?.urls).toEqual(["https://media.example/workspaces/ws-1/inbound/mid-9/image.png"]);
  });

  test("oversize: provider-declared size over the cap skips the store entirely", async () => {
    const store = fakeStore();
    const port = createInboundMediaPort({
      getAdapterFn: () => whatsappAdapter(new Uint8Array([1]), 30 * 1024 * 1024),
      putObjectFn: store.putObjectFn,
    });
    const result = await port.fetchAndStore({
      workspaceId: "ws-1", account: WA_ACCOUNT, channel: "whatsapp",
      media: { type: "video", id: "wa-big" },
      messageExternalId: "wamid.BIG",
    });
    expect(result).toBeNull();
    expect(store.calls).toHaveLength(0);
  });

  test("oversize: downloaded bytes over the cap are dropped, not stored", async () => {
    const store = fakeStore();
    const port = createInboundMediaPort({
      getAdapterFn: () => telegramAdapter(new Uint8Array([1, 2, 3, 4, 5])),
      putObjectFn: store.putObjectFn,
      maxBytes: 4,
    });
    const result = await port.fetchAndStore({
      workspaceId: "ws-1", account: TG_ACCOUNT, channel: "telegram",
      media: { type: "document", id: "file-9" },
      messageExternalId: "tg-big",
    });
    expect(result).toBeNull();
    expect(store.calls).toHaveLength(0);
  });

  test("storage unconfigured (putObject throws): null, never a throw", async () => {
    const store = fakeStore({ throws: true });
    const port = createInboundMediaPort({
      fetchFn: async () => new Response(new Uint8Array([1]), { status: 200 }),
      putObjectFn: store.putObjectFn,
    });
    const result = await port.fetchAndStore({
      workspaceId: "ws-1", account: MSG_ACCOUNT, channel: "instagram",
      media: { type: "image", url: "https://cdn.example.com/y.jpg" },
      messageExternalId: "mid-10",
    });
    expect(result).toBeNull();
  });

  test("provider error (attachment url 404): null", async () => {
    const store = fakeStore();
    const port = createInboundMediaPort({
      fetchFn: async () => new Response("gone", { status: 404 }),
      putObjectFn: store.putObjectFn,
    });
    const result = await port.fetchAndStore({
      workspaceId: "ws-1", account: MSG_ACCOUNT, channel: "messenger",
      media: { type: "image", url: "https://cdn.example.com/gone.jpg" },
      messageExternalId: "mid-11",
    });
    expect(result).toBeNull();
    expect(store.calls).toHaveLength(0);
  });

  test("no public base configured: keys recorded, urls empty", async () => {
    const store = fakeStore({ withPublicUrl: false });
    const port = createInboundMediaPort({
      fetchFn: async () => new Response(new Uint8Array([3]), { status: 200, headers: { "Content-Type": "image/jpeg" } }),
      putObjectFn: store.putObjectFn,
    });
    const result = await port.fetchAndStore({
      workspaceId: "ws-1", account: MSG_ACCOUNT, channel: "messenger",
      media: { type: "image", url: "https://cdn.example.com/z.jpg" },
      messageExternalId: "mid-12",
    });
    expect(result).toEqual({ urls: [], keys: ["workspaces/ws-1/inbound/mid-12/image.jpg"] });
  });

  test("unsupported channel and missing references resolve to null", async () => {
    const store = fakeStore();
    const port = createInboundMediaPort({ putObjectFn: store.putObjectFn });
    await expect(port.fetchAndStore({
      workspaceId: "ws-1", account: WA_ACCOUNT, channel: "threads",
      media: { type: "image", id: "x" }, messageExternalId: "t-1",
    })).resolves.toBeNull();
    await expect(port.fetchAndStore({
      workspaceId: "ws-1", account: WA_ACCOUNT, channel: "whatsapp",
      media: { type: "image" }, messageExternalId: "wamid.NOREF",
    })).resolves.toBeNull();
    expect(store.calls).toHaveLength(0);
  });

  test("tiktok: media id + conversation id -> adapter download -> stored", async () => {
    const bytes = new Uint8Array([5, 6, 7]);
    const store = fakeStore();
    const port = createInboundMediaPort({
      getAdapterFn: () => tiktokAdapter(bytes),
      putObjectFn: store.putObjectFn,
    });
    const result = await port.fetchAndStore({
      workspaceId: "ws-1", account: TT_ACCOUNT, channel: "tiktok",
      media: { type: "image", id: "media-1" },
      messageExternalId: "tm-1", conversationExternalId: "conv-1",
    });
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]!.data).toEqual(bytes);
    expect(result?.keys).toEqual(["workspaces/ws-1/inbound/tm-1/image.jpg"]);
  });

  test("tiktok: without the conversation id the download cannot be addressed -> null (caption-only)", async () => {
    const store = fakeStore();
    const port = createInboundMediaPort({
      getAdapterFn: () => tiktokAdapter(new Uint8Array([1])),
      putObjectFn: store.putObjectFn,
    });
    await expect(port.fetchAndStore({
      workspaceId: "ws-1", account: TT_ACCOUNT, channel: "tiktok",
      media: { type: "image", id: "media-1" },
      messageExternalId: "tm-2",
    })).resolves.toBeNull();
    expect(store.calls).toHaveLength(0);
  });
});
