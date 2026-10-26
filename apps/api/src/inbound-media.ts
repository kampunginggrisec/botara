import {
  TelegramAdapter, WhatsAppAdapter, getAdapter,
  type ChannelAccountRef, type FetchLike, type MessageMedia,
} from "@botara/channels";
import { putObject } from "@botara/media";
import type {
  DispatchAccount, InboundMediaPort, StoredInboundMedia,
} from "./flows-dispatch";

/**
 * Production InboundMediaPort (the dispatcher's media pipeline).
 *
 * Provider media references are perishable: WhatsApp media ids need a
 * fresh bearer-authenticated lookup, Telegram file paths expire, and
 * Meta CDN attachment URLs are short-lived. Webhook ingest is the one
 * moment the bytes are guaranteed reachable, so this port copies them
 * into Botara's own storage (R2 via @botara/media - the same store the
 * worker's email-attachment pipeline writes to) and returns the public
 * URL + object key the message row persists, following the
 * mediaUrls/mediaKeys convention scheduled posts already use.
 *
 * Serving model: the SPA renders mediaUrls directly (R2 public base =
 * a custom domain, per packages/media's URL rules). When no public
 * base is configured, putObject returns no URL - the key is still
 * recorded (it is the durable reference for lifecycle/serving work)
 * and the inbox shows the stored file by name without a live link.
 *
 * Bounds: one item per message (the normalized event shape), a byte
 * cap (default 25 MB - checked against the provider-declared size
 * when known and always against the downloaded bytes), and a timeout
 * (default 20 s). ANY failure - storage unconfigured, provider error,
 * oversize, timeout - returns null and the dispatcher persists the
 * message caption-only. This port never throws.
 */

export const INBOUND_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
export const INBOUND_MEDIA_TIMEOUT_MS = 20_000;

export interface InboundMediaPortDeps {
  /** Adapter lookup by channel key (defaults to the channels registry). */
  getAdapterFn?: (channel: string) => unknown;
  /** Fetch for provider-hosted attachment URLs (Messenger / Instagram). */
  fetchFn?: FetchLike;
  /** Object write (defaults to @botara/media putObject against process env). */
  putObjectFn?: (
    key: string,
    data: Uint8Array,
    contentType: string,
  ) => Promise<{ key: string; publicUrl?: string }>;
  maxBytes?: number;
  timeoutMs?: number;
}

interface FetchedBytes {
  data: Uint8Array;
  mimeType?: string;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "application/pdf": "pdf",
};

function toAccountRef(account: DispatchAccount): ChannelAccountRef {
  return {
    id: account.id,
    externalId: account.externalId,
    ...(account.tokenVaultRef ? { tokenVaultRef: account.tokenVaultRef } : {}),
    ...(account.authMode ? { authMode: account.authMode } : {}),
  };
}

/** Path-safe segment for storage keys (external ids are provider-shaped). */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 120);
  return cleaned || "item";
}

/** A display filename for the stored object, extension completed from the mime type when missing. */
function storedFilename(media: MessageMedia, mimeType?: string): string {
  const base = media.filename ? safeSegment(media.filename) : "";
  if (base) {
    if (!/\.[A-Za-z0-9]{1,8}$/.test(base) && mimeType && EXT_BY_MIME[mimeType]) {
      return `${base}.${EXT_BY_MIME[mimeType]}`;
    }
    return base;
  }
  const ext = mimeType ? EXT_BY_MIME[mimeType] : undefined;
  return `${media.type}${ext ? `.${ext}` : ".bin"}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`inbound media fetch timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createInboundMediaPort(deps: InboundMediaPortDeps = {}): InboundMediaPort {
  const getAdapterFn = deps.getAdapterFn ?? ((channel: string) => getAdapter(channel as never));
  const fetchFn: FetchLike = deps.fetchFn ?? ((input, init) => fetch(input, init));
  const putObjectFn = deps.putObjectFn ?? ((key, data, contentType) => putObject(key, data, contentType));
  const maxBytes = deps.maxBytes ?? INBOUND_MEDIA_MAX_BYTES;
  const timeoutMs = deps.timeoutMs ?? INBOUND_MEDIA_TIMEOUT_MS;

  async function fetchBytes(
    account: DispatchAccount,
    channel: string,
    media: MessageMedia,
  ): Promise<FetchedBytes | null> {
    if (channel === "whatsapp") {
      if (!media.id) return null;
      const adapter = getAdapterFn(channel);
      if (!(adapter instanceof WhatsAppAdapter)) return null;
      const result = await withTimeout(adapter.downloadMedia(toAccountRef(account), media.id), timeoutMs);
      if (result.fileSize !== undefined && result.fileSize > maxBytes) return null;
      return { data: new Uint8Array(result.data), mimeType: result.mimeType ?? media.mimeType };
    }
    if (channel === "telegram") {
      if (!media.id) return null;
      const adapter = getAdapterFn(channel);
      if (!(adapter instanceof TelegramAdapter)) return null;
      const result = await withTimeout(adapter.downloadFile(toAccountRef(account), media.id), timeoutMs);
      if (result.fileSize !== undefined && result.fileSize > maxBytes) return null;
      return { data: new Uint8Array(result.data), mimeType: media.mimeType };
    }
    if (channel === "messenger" || channel === "instagram") {
      // Webhook attachment URLs are self-signed CDN links: no auth
      // header (the adapters hold Page/IG tokens for the Graph API,
      // which these URLs neither need nor accept).
      if (!media.url) return null;
      const res = await fetchFn(media.url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      const declared = Number(res.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > maxBytes) return null;
      const data = new Uint8Array(await res.arrayBuffer());
      return { data, mimeType: res.headers.get("content-type") ?? media.mimeType ?? undefined };
    }
    return null;
  }

  return {
    async fetchAndStore(input): Promise<StoredInboundMedia | null> {
      try {
        const fetched = await fetchBytes(input.account, input.channel, input.media);
        if (!fetched) return null;
        if (fetched.data.byteLength === 0 || fetched.data.byteLength > maxBytes) return null;
        const mimeType = fetched.mimeType;
        const key = [
          "workspaces", safeSegment(input.workspaceId),
          "inbound", safeSegment(input.messageExternalId),
          storedFilename(input.media, mimeType),
        ].join("/");
        const stored = await putObjectFn(key, fetched.data, mimeType ?? "application/octet-stream");
        return {
          urls: stored.publicUrl ? [stored.publicUrl] : [],
          keys: [stored.key],
        };
      } catch {
        // The port contract: never throw. Unconfigured storage (R2 env
        // missing -> putObject throws CONFIGURATION), provider errors
        // and timeouts all degrade to caption-only persistence.
        return null;
      }
    },
  };
}
