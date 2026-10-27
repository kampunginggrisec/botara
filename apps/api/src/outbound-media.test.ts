import { beforeAll, describe, expect, test } from "bun:test";
import { AppError } from "@botara/shared";
import type { ChannelAdapter, ChannelKey, SendInput } from "@botara/channels";
import {
  OUTBOUND_MEDIA_MAX_BYTES,
  createOutboundMediaPort,
  mediaTypeForMime,
  validateAttachment,
} from "./outbound-media";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";

/**
 * Outbound attachments (M-1).
 *
 * Two layers are tested separately because they fail differently:
 *   - validateAttachment decides what may leave at all (cheap, pure),
 *   - the port decides HOW it leaves, and the interesting cases are the
 *     per-channel strategies: Meta messaging uploads (no public URL), the
 *     WhatsApp URL-then-upload fallback, and Telegram's hard requirement.
 * The route tests then prove the ordering contract: validation happens
 * BEFORE storage, and a failed send never leaves a "sent" row.
 */

const bytes = (n = 16) => new Uint8Array(n).fill(7);

describe("mediaTypeForMime", () => {
  test("maps the four families and ignores a charset suffix", () => {
    expect(mediaTypeForMime("image/png")).toBe("image");
    expect(mediaTypeForMime("video/mp4")).toBe("video");
    expect(mediaTypeForMime("audio/ogg")).toBe("audio");
    expect(mediaTypeForMime("application/pdf")).toBe("document");
    expect(mediaTypeForMime("text/plain; charset=utf-8")).toBe("document");
  });

  test("unknown mime types are null, never a guessed 'document'", () => {
    expect(mediaTypeForMime("application/octet-stream")).toBeNull();
    expect(mediaTypeForMime("")).toBeNull();
  });
});

describe("validateAttachment", () => {
  test("rejects a channel with no outbound media surface, naming the ones that have it", () => {
    expect(() => validateAttachment({ channel: "webchat", mimeType: "image/png", size: 10 }))
      .toThrow(/not supported on webchat/);
  });

  test("rejects an empty file", () => {
    expect(() => validateAttachment({ channel: "messenger", mimeType: "image/png", size: 0 }))
      .toThrow(/empty/);
  });

  test("names the byte limit when the file is too large", () => {
    expect(() => validateAttachment({
      channel: "messenger", mimeType: "image/png", size: OUTBOUND_MEDIA_MAX_BYTES + 1,
    })).toThrow(new RegExp(`${OUTBOUND_MEDIA_MAX_BYTES} bytes`));
  });

  test("rejects an unsupported mime type instead of sending it as a document", () => {
    expect(() => validateAttachment({ channel: "whatsapp", mimeType: "application/octet-stream", size: 10 }))
      .toThrow(/Unsupported file type/);
  });

  test("telegram accepts images only until the adapter grows other send methods", () => {
    expect(validateAttachment({ channel: "telegram", mimeType: "image/jpeg", size: 10 }).type).toBe("image");
    expect(() => validateAttachment({ channel: "telegram", mimeType: "application/pdf", size: 10 }))
      .toThrow(/telegram cannot receive a document/);
  });

  test("fills a filename when the upload had none", () => {
    expect(validateAttachment({ channel: "messenger", mimeType: "image/png", size: 10, filename: "  " }))
      .toEqual({ type: "image", mimeType: "image/png", filename: "image.bin" });
  });
});

// ---------------------------------------------------------------- port

interface SentCall {
  toExternalId: string;
  media: NonNullable<SendInput["media"]>;
  idempotencyKey: string;
}

function fakeAdapter(overrides: Partial<ChannelAdapter> & Record<string, unknown> = {}) {
  const sent: SentCall[] = [];
  const uploads: Array<{ attachmentId?: string; mediaId?: string; type?: string }> = [];
  const adapter = {
    key: "messenger",
    apiVersion: "v26.0",
    capabilities: {},
    async send(input: SendInput) {
      sent.push({
        toExternalId: input.toExternalId,
        media: input.media!,
        idempotencyKey: input.idempotencyKey,
      });
      return { externalMessageId: `mid-${sent.length}`, status: "sent" as const };
    },
    async uploadAttachment(_account: unknown, input: { type?: string }) {
      uploads.push({ attachmentId: "att-1", type: input.type });
      return { attachmentId: "att-1" };
    },
    async uploadMedia() {
      uploads.push({ mediaId: "wa-media-1" });
      return { mediaId: "wa-media-1" };
    },
    async health() { return { ok: true, detail: "ok" }; },
    async parseWebhook() { return []; },
    ...overrides,
  };
  return { adapter: adapter as unknown as ChannelAdapter, sent, uploads };
}

const account = { id: "acc-1", externalId: "page-1" };

describe("outbound media port", () => {
  test("messenger uploads first and sends the reusable attachment id (no public URL)", async () => {
    const { adapter, sent, uploads } = fakeAdapter();
    const port = createOutboundMediaPort({ getAdapter: () => adapter });

    const result = await port.send({
      workspaceId: "ws-1", channel: "messenger", account,
      toExternalId: "psid-1", data: bytes(), mimeType: "image/png",
      filename: "photo.png", idempotencyKey: "k1",
    });

    expect(result.strategy).toBe("provider_upload");
    expect(result.externalMessageId).toBe("mid-1");
    expect(uploads).toEqual([{ attachmentId: "att-1", type: "image" }]);
    expect(sent[0]!.media.id).toBe("att-1");
    // The URL path is what M-1 replaced: it must not be used.
    expect(sent[0]!.media.link).toBeUndefined();
  });

  test("a document becomes Meta's 'file' attachment type", async () => {
    const { adapter, uploads } = fakeAdapter();
    const port = createOutboundMediaPort({ getAdapter: () => adapter });
    await port.send({
      workspaceId: "ws-1", channel: "instagram", account,
      toExternalId: "ig-1", data: bytes(), mimeType: "application/pdf",
      filename: "invoice.pdf", idempotencyKey: "k2",
    });
    expect(uploads[0]!.type).toBe("file");
  });

  test("a caption rides on the media payload", async () => {
    const { adapter, sent } = fakeAdapter();
    const port = createOutboundMediaPort({ getAdapter: () => adapter });
    await port.send({
      workspaceId: "ws-1", channel: "messenger", account,
      toExternalId: "psid-1", data: bytes(), mimeType: "image/png",
      filename: "photo.png", caption: "Struk ya kak", idempotencyKey: "k3",
    });
    expect(sent[0]!.media.caption).toBe("Struk ya kak");
  });

  test("messenger without an upload surface is a typed 503, not a silent text send", async () => {
    const { adapter } = fakeAdapter({ uploadAttachment: undefined });
    const port = createOutboundMediaPort({ getAdapter: () => adapter });
    const err = await port.send({
      workspaceId: "ws-1", channel: "messenger", account,
      toExternalId: "psid-1", data: bytes(), mimeType: "image/png",
      filename: "photo.png", idempotencyKey: "k4",
    }).catch((e) => e as AppError);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("CONFIGURATION");
  });

  test("whatsapp prefers the public URL when one exists (one call, no upload)", async () => {
    const { adapter, sent, uploads } = fakeAdapter();
    const port = createOutboundMediaPort({ getAdapter: () => adapter });
    const result = await port.send({
      workspaceId: "ws-1", channel: "whatsapp", account,
      toExternalId: "628123", data: bytes(), mimeType: "image/png",
      filename: "photo.png", publicUrl: "https://cdn.example.com/photo.png", idempotencyKey: "k5",
    });
    expect(result.strategy).toBe("public_url");
    expect(uploads).toHaveLength(0);
    expect(sent[0]!.media.link).toBe("https://cdn.example.com/photo.png");
  });

  test("whatsapp falls back to a Meta media upload when no public URL is configured", async () => {
    const { adapter, sent, uploads } = fakeAdapter();
    const port = createOutboundMediaPort({ getAdapter: () => adapter });
    const result = await port.send({
      workspaceId: "ws-1", channel: "whatsapp", account,
      toExternalId: "628123", data: bytes(), mimeType: "image/png",
      filename: "photo.png", idempotencyKey: "k6",
    });
    expect(result.strategy).toBe("provider_upload");
    expect(uploads).toEqual([{ mediaId: "wa-media-1" }]);
    expect(sent[0]!.media.id).toBe("wa-media-1");
  });

  test("telegram without a public URL is an honest 503 naming the missing setting", async () => {
    const { adapter } = fakeAdapter();
    const port = createOutboundMediaPort({ getAdapter: () => adapter });
    const err = await port.send({
      workspaceId: "ws-1", channel: "telegram", account,
      toExternalId: "12345", data: bytes(), mimeType: "image/png",
      filename: "photo.png", idempotencyKey: "k7",
    }).catch((e) => e as AppError);
    expect((err as AppError).message).toContain("R2_PUBLIC_BASE_URL");
  });

  test("the port re-validates: a caller cannot bypass the size ceiling", async () => {
    const { adapter } = fakeAdapter();
    const port = createOutboundMediaPort({ getAdapter: () => adapter });
    await expect(port.send({
      workspaceId: "ws-1", channel: "messenger", account,
      toExternalId: "psid-1", data: bytes(OUTBOUND_MEDIA_MAX_BYTES + 1),
      mimeType: "image/png", filename: "big.png", idempotencyKey: "k8",
    })).rejects.toThrow(/limit is/);
  });
});

// ---------------------------------------------------------------- route

let fake: FakeDatabase;
let owner: Registered;
let other: Registered;
let mediaCalls: Array<{ channel: string; publicUrl?: string; caption?: string }>;
let mediaShouldFail: boolean;

const app = createApp(testDeps({
  getDatabase: () => fake.db,
  outboundMedia: {
    async send(input) {
      mediaCalls.push({
        channel: input.channel,
        ...(input.publicUrl ? { publicUrl: input.publicUrl } : {}),
        ...(input.caption ? { caption: input.caption } : {}),
      });
      if (mediaShouldFail) throw new AppError("PROVIDER_ERROR", "provider said no", { status: 502 });
      return { externalMessageId: "mid-route-1", strategy: "provider_upload" as const };
    },
  },
  putOutboundObject: async (key) => ({ key, publicUrl: `https://cdn.example.com/${key}` }),
}));

const form = (name: string, type: string, size = 32, caption?: string) => {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(size).fill(1)], name, { type }));
  if (caption !== undefined) fd.append("caption", caption);
  return fd;
};

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(app, "attach-owner@example.com");
  other = await registerUser(app, "attach-other@example.com");
  const ws = owner.workspaceId;
  fake.seed("workspaces", { id: ws, name: "Toko Attach", slug: "toko-attach" });
  fake.seed("workspaces", { id: other.workspaceId, name: "Toko Lain", slug: "toko-lain-attach" });
  fake.seed("channelAccounts", {
    id: "acc-messenger", workspaceId: ws, channel: "messenger",
    externalId: "page-1", displayName: "Page Toko", status: "connected",
    tokenVaultRef: null, authMode: null,
  });
  fake.seed("channelAccounts", {
    id: "acc-webchat", workspaceId: ws, channel: "webchat",
    externalId: `webchat:${ws}`, displayName: "Webchat", status: "connected",
    tokenVaultRef: null, authMode: null,
  });
  fake.seed("contacts", {
    id: "contact-1", workspaceId: ws, channel: "messenger",
    externalId: "psid-1", displayName: "Budi", tags: [], customFields: {},
  });
  fake.seed("conversations", {
    id: "conv-messenger", workspaceId: ws, channelAccountId: "acc-messenger",
    contactId: "contact-1", status: "open", assignedUserId: null,
    lastUserMessageAt: new Date(),
  });
  fake.seed("conversations", {
    id: "conv-webchat", workspaceId: ws, channelAccountId: "acc-webchat",
    contactId: "contact-1", status: "open", assignedUserId: null,
    lastUserMessageAt: new Date(),
  });
});

describe("POST /conversations/{id}/attachments", () => {
  test("sends the file, persists the media row and reports the strategy", async () => {
    mediaCalls = [];
    mediaShouldFail = false;
    const res = await app.request("/conversations/conv-messenger/attachments", {
      method: "POST", headers: owner.headers,
      body: form("photo.png", "image/png", 32, "Struk ya kak"),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as {
      message: { id: string; type: string; body: string; mediaKeys: string[]; mediaUrls: string[]; status: string };
      strategy: string;
    };
    expect(body.strategy).toBe("provider_upload");
    expect(body.message.type).toBe("image");
    // The caption is the visible body; the stored object is the durable copy.
    expect(body.message.body).toBe("Struk ya kak");
    expect(body.message.mediaKeys).toHaveLength(1);
    expect(body.message.mediaUrls).toEqual([`https://cdn.example.com/${body.message.mediaKeys[0]}`]);
    expect(mediaCalls).toEqual([{
      channel: "messenger", publicUrl: body.message.mediaUrls[0], caption: "Struk ya kak",
    }]);
  });

  test("without a caption the filename becomes the body", async () => {
    mediaCalls = [];
    const res = await app.request("/conversations/conv-messenger/attachments", {
      method: "POST", headers: owner.headers,
      body: form("invoice.pdf", "application/pdf"),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { message: { type: string; body: string } };
    expect(body.message.type).toBe("document");
    expect(body.message.body).toBe("invoice.pdf");
  });

  test("a channel with no media surface is a typed 400 before anything is stored", async () => {
    mediaCalls = [];
    const before = fake.rows.messages.length;
    const res = await app.request("/conversations/conv-webchat/attachments", {
      method: "POST", headers: owner.headers,
      body: form("photo.png", "image/png"),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.message).toContain("not supported on webchat");
    expect(fake.rows.messages.length).toBe(before);
    expect(mediaCalls).toHaveLength(0);
  });

  test("an unsupported file type is refused before the message row exists", async () => {
    const before = fake.rows.messages.length;
    const res = await app.request("/conversations/conv-messenger/attachments", {
      method: "POST", headers: owner.headers,
      body: form("payload.bin", "application/octet-stream"),
    });
    expect(res.status).toBe(400);
    expect(fake.rows.messages.length).toBe(before);
  });

  test("a missing file field is a typed 400", async () => {
    const res = await app.request("/conversations/conv-messenger/attachments", {
      method: "POST", headers: owner.headers, body: new FormData(),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "VALIDATION" } });
  });

  test("a caption over 1024 characters is refused", async () => {
    const res = await app.request("/conversations/conv-messenger/attachments", {
      method: "POST", headers: owner.headers,
      body: form("photo.png", "image/png", 32, "x".repeat(1025)),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { message: expect.stringContaining("1024") } });
  });

  test("a failed provider send marks the row failed and surfaces the provider error", async () => {
    mediaShouldFail = true;
    const res = await app.request("/conversations/conv-messenger/attachments", {
      method: "POST", headers: owner.headers,
      body: form("photo.png", "image/png"),
    });
    mediaShouldFail = false;
    expect(res.status).toBe(502);
    const last = fake.rows.messages[fake.rows.messages.length - 1]!;
    expect(last.status).toBe("failed");
    expect(last.direction).toBe("out");
  });

  test("another workspace's conversation is a 404 (no cross-tenant send)", async () => {
    const res = await app.request("/conversations/conv-messenger/attachments", {
      method: "POST", headers: other.headers,
      body: form("photo.png", "image/png"),
    });
    expect(res.status).toBe(404);
  });
});
