import { AppError } from "@botara/shared";
import {
  metaAttachmentType, type ChannelAccountRef, type ChannelAdapter, type ChannelKey, type MessageMedia,
} from "@botara/channels";

/**
 * Outbound attachments (M-1).
 *
 * The inbox could only send TEXT (and rich blocks). Every adapter already
 * knew how to send media, but nothing produced `SendInput.media`, and the
 * two Meta messaging channels could only take media as a PUBLIC URL - so
 * "send this photo" was impossible unless R2 was exposed on a custom
 * domain. This module is the missing middle:
 *
 *   validate bytes -> pick the cheapest provider path -> send -> report
 *   which path was used.
 *
 * Path per channel, and why:
 *   messenger / instagram  UPLOAD first (`message_attachments`), then send
 *                          the reusable attachment id. No public URL is
 *                          involved, which is the whole point of M-1.
 *   whatsapp               the public URL when one exists (a single call,
 *                          and captions/filenames ride along); otherwise
 *                          upload to Meta and send the media id - the same
 *                          media id path inbound media already uses.
 *   telegram               the public URL (the Bot API fetches it), and
 *                          only for photos: `send()` has no document/audio
 *                          branch yet, so anything else is refused with the
 *                          reason instead of being sent as text.
 *
 * Bytes are NOT stored here: the caller (the API route) owns storage and
 * passes the resulting public URL in. A port that also wrote to R2 would
 * make the send path untestable without storage.
 */

/** Same ceiling as the inbound media pipeline, so the two cannot disagree. */
export const OUTBOUND_MEDIA_MAX_BYTES = 25 * 1024 * 1024;

/** Media kinds Botara can actually deliver (no "sticker"/"unknown" sends). */
export const OUTBOUND_MEDIA_TYPES = ["image", "video", "audio", "document"] as const;
export type OutboundMediaType = (typeof OUTBOUND_MEDIA_TYPES)[number];

/**
 * Document mime types we accept by name. Everything else must match one
 * of the media prefixes below - an unrecognized mime is refused, because
 * guessing "document" would ship a file the provider may reject anyway.
 */
const DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/zip",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
]);

/** Normalize a mime type onto a media kind, or null when it is not sendable. */
export function mediaTypeForMime(mimeType: string): OutboundMediaType | null {
  const mime = mimeType.split(";")[0]!.trim().toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (DOCUMENT_MIME_TYPES.has(mime)) return "document";
  return null;
}

/**
 * Channels this module can deliver an attachment on, and the media kinds
 * each accepts. Threads/email/webchat/TikTok are absent on purpose: they
 * have no outbound-media surface in Botara today, and pretending otherwise
 * would fail at the provider instead of at the door.
 */
export const ATTACHMENT_CHANNELS: Record<string, readonly OutboundMediaType[]> = {
  whatsapp: ["image", "video", "audio", "document"],
  messenger: ["image", "video", "audio", "document"],
  instagram: ["image", "video", "audio", "document"],
  // Photo-only until the adapter grows sendDocument/sendAudio/sendVideo.
  telegram: ["image"],
};

export interface ValidateAttachmentInput {
  channel: string;
  mimeType: string;
  size: number;
  filename?: string;
  maxBytes?: number;
}

export interface ValidatedAttachment {
  type: OutboundMediaType;
  mimeType: string;
  filename: string;
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new AppError("VALIDATION", message, { status: 400, ...(details ? { details } : {}) });
}

/**
 * Validate an attachment BEFORE anything is uploaded or sent. Every
 * message names the limit that was hit, so the composer can show it
 * verbatim instead of "invalid parameter".
 */
export function validateAttachment(input: ValidateAttachmentInput): ValidatedAttachment {
  const allowed = ATTACHMENT_CHANNELS[input.channel];
  if (!allowed) {
    invalid(
      `Attachments are not supported on ${input.channel}. Supported channels: ${
        Object.keys(ATTACHMENT_CHANNELS).join(", ")
      }.`,
      { reason: "unsupported_channel" },
    );
  }
  const maxBytes = input.maxBytes ?? OUTBOUND_MEDIA_MAX_BYTES;
  if (!Number.isFinite(input.size) || input.size <= 0) {
    invalid("The attached file is empty.", { reason: "empty_file" });
  }
  if (input.size > maxBytes) {
    invalid(
      `The attached file is ${input.size} bytes; the limit is ${maxBytes} bytes (${
        Math.round(maxBytes / (1024 * 1024))
      } MB).`,
      { reason: "file_too_large", maxBytes },
    );
  }
  const type = mediaTypeForMime(input.mimeType);
  if (!type) {
    invalid(
      `Unsupported file type "${input.mimeType}". Send an image, a video, an audio file or a PDF/office document.`,
      { reason: "unsupported_type" },
    );
  }
  if (!allowed.includes(type)) {
    invalid(
      `${input.channel} cannot receive a ${type} attachment (allowed: ${allowed.join(", ")}).`,
      { reason: "unsupported_type_for_channel", allowed },
    );
  }
  const filename = (input.filename ?? "").trim() || `${type}.bin`;
  return { type, mimeType: input.mimeType, filename };
}

/** Structural views of the optional provider uploads (no instanceof: the port stays injectable). */
interface AttachmentUploader {
  uploadAttachment(
    account: ChannelAccountRef,
    input: { data: Uint8Array; type?: "image" | "video" | "audio" | "file"; filename?: string; mimeType?: string },
  ): Promise<{ attachmentId: string }>;
}

interface MediaUploader {
  uploadMedia(
    account: ChannelAccountRef,
    file: { data: Uint8Array; mimeType: string; filename?: string },
  ): Promise<{ mediaId: string }>;
}

export interface OutboundAttachmentInput {
  workspaceId: string;
  channel: string;
  account: ChannelAccountRef;
  toExternalId: string;
  data: Uint8Array;
  mimeType: string;
  filename: string;
  caption?: string;
  /** Public URL of these same bytes, when the caller managed to store them. */
  publicUrl?: string;
  replyToExternalId?: string;
  /** Required by the adapter contract (a retried send must be dedupable). */
  idempotencyKey: string;
}

export type AttachmentStrategy = "provider_upload" | "public_url";

export interface OutboundAttachmentResult {
  externalMessageId: string;
  /** Which provider path delivered the bytes - surfaced so operators can tell. */
  strategy: AttachmentStrategy;
  warnings?: string[];
}

export interface OutboundMediaPort {
  send(input: OutboundAttachmentInput): Promise<OutboundAttachmentResult>;
}

export interface OutboundMediaDeps {
  getAdapter: (channel: ChannelKey) => ChannelAdapter;
  maxBytes?: number;
}

export function createOutboundMediaPort(deps: OutboundMediaDeps): OutboundMediaPort {
  const maxBytes = deps.maxBytes ?? OUTBOUND_MEDIA_MAX_BYTES;

  return {
    async send(input): Promise<OutboundAttachmentResult> {
      // Re-validated here even when the route already did it: the port is
      // the only thing standing between a caller and a provider upload.
      const validated = validateAttachment({
        channel: input.channel,
        mimeType: input.mimeType,
        size: input.data.byteLength,
        filename: input.filename,
        maxBytes,
      });
      const media: MessageMedia & { link?: string } = {
        type: validated.type,
        mimeType: validated.mimeType,
        filename: validated.filename,
        ...(input.caption ? { caption: input.caption } : {}),
      };

      if (input.channel === "messenger" || input.channel === "instagram") {
        const adapter = deps.getAdapter(input.channel as ChannelKey) as ChannelAdapter &
          Partial<AttachmentUploader>;
        if (typeof adapter.uploadAttachment !== "function") {
          throw new AppError(
            "CONFIGURATION",
            `The ${input.channel} adapter cannot upload attachments; media would need a public URL.`,
            { status: 503 },
          );
        }
        const { attachmentId } = await adapter.uploadAttachment(input.account, {
          data: input.data,
          type: metaAttachmentType(validated.type),
          filename: validated.filename,
          mimeType: validated.mimeType,
        });
        const result = await adapter.send({
          account: input.account,
          toExternalId: input.toExternalId,
          media: { ...media, id: attachmentId },
          ...(input.replyToExternalId ? { replyToExternalId: input.replyToExternalId } : {}),
          idempotencyKey: input.idempotencyKey,
        });
        return {
          externalMessageId: result.externalMessageId,
          strategy: "provider_upload",
          ...(result.warnings ? { warnings: result.warnings } : {}),
        };
      }

      if (input.channel === "whatsapp") {
        const adapter = deps.getAdapter("whatsapp") as ChannelAdapter & Partial<MediaUploader>;
        // Prefer the public URL: one call, and the caption + filename ride
        // along in the same payload. Fall back to a Meta upload when the
        // deployment has no public media base (R2_PUBLIC_BASE_URL unset).
        if (input.publicUrl) {
          const result = await adapter.send({
            account: input.account,
            toExternalId: input.toExternalId,
            media: { ...media, link: input.publicUrl },
            ...(input.replyToExternalId ? { replyToExternalId: input.replyToExternalId } : {}),
            idempotencyKey: input.idempotencyKey,
          });
          return {
            externalMessageId: result.externalMessageId,
            strategy: "public_url",
            ...(result.warnings ? { warnings: result.warnings } : {}),
          };
        }
        if (typeof adapter.uploadMedia !== "function") {
          throw new AppError(
            "CONFIGURATION",
            "WhatsApp media needs either a public media URL (R2_PUBLIC_BASE_URL) or an adapter that can upload; neither is available.",
            { status: 503 },
          );
        }
        const { mediaId } = await adapter.uploadMedia(input.account, {
          data: input.data,
          mimeType: validated.mimeType,
          filename: validated.filename,
        });
        const result = await adapter.send({
          account: input.account,
          toExternalId: input.toExternalId,
          media: { ...media, id: mediaId },
          ...(input.replyToExternalId ? { replyToExternalId: input.replyToExternalId } : {}),
          idempotencyKey: input.idempotencyKey,
        });
        return {
          externalMessageId: result.externalMessageId,
          strategy: "provider_upload",
          ...(result.warnings ? { warnings: result.warnings } : {}),
        };
      }

      if (input.channel === "telegram") {
        if (!input.publicUrl) {
          throw new AppError(
            "CONFIGURATION",
            "Telegram media needs a public media URL: set R2_PUBLIC_BASE_URL so the Bot API can fetch the file.",
            { status: 503 },
          );
        }
        const adapter = deps.getAdapter("telegram");
        const result = await adapter.send({
          account: input.account,
          toExternalId: input.toExternalId,
          media: { ...media, link: input.publicUrl },
          ...(input.replyToExternalId ? { replyToExternalId: input.replyToExternalId } : {}),
          idempotencyKey: input.idempotencyKey,
        });
        return {
          externalMessageId: result.externalMessageId,
          strategy: "public_url",
          ...(result.warnings ? { warnings: result.warnings } : {}),
        };
      }

      // Unreachable through validateAttachment; kept so a new channel key
      // fails loudly instead of silently falling through to text.
      return invalid(`Attachments are not supported on ${input.channel}.`);
    },
  };
}
