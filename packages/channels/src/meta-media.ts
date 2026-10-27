import { AppError } from "@botara/shared";
import { mapGraphError, ProviderApiError, type GraphErrorBodyShape } from "./errors";
import type { FetchLike, MessageMedia } from "./types";

/**
 * Media helpers shared by the two Meta MESSAGING channels (Messenger and
 * Instagram). They share the Send API attachment shape, so the type map
 * and the upload call live here instead of being copied into both
 * adapters - the copies would drift.
 *
 * Why the upload exists at all (M-1): the Send API accepts an attachment
 * either as `payload.url` (Meta fetches it - requires a PUBLIC https URL)
 * or as `payload.attachment_id` (Meta already holds the bytes). Botara's
 * media lives in R2, whose public base is optional, so "send a photo" used
 * to be impossible without a public bucket. `POST /{owner-id}/message_attachments`
 * removes that requirement: bytes go up once, Meta returns a reusable id.
 */

/** Meta Send API attachment types (Messenger and Instagram share the set). */
export type MetaAttachmentType = "image" | "video" | "audio" | "file";

/**
 * Outbound media as `SendInput` carries it: `MessageMedia` plus the
 * `link` field (a public URL the provider may fetch). Kept as a local
 * alias because `MessageMedia` itself has no `link`.
 */
export type OutboundMedia = MessageMedia & { link?: string };

/**
 * Normalize our media vocabulary onto Meta's four attachment types.
 * `sticker` is an image; anything we do not model explicitly is a file -
 * Meta's "file" is the honest bucket, not a silent image mislabel.
 */
export function metaAttachmentType(type: MessageMedia["type"]): MetaAttachmentType {
  switch (type) {
    case "image":
    case "photo":
    case "sticker":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    default:
      return "file";
  }
}

/**
 * The `message.attachment.payload` for a media send.
 *
 * `media.id` is the REUSABLE attachment id returned by
 * `uploadMetaAttachment` - the path that needs no public URL. `media.link`
 * (or `media.url`) is the fallback: Meta fetches it itself, which only
 * works for a publicly reachable https URL.
 */
export function metaAttachmentPayload(media: OutboundMedia): Record<string, unknown> {
  if (media.id) return { attachment_id: media.id };
  const link = media.link ?? media.url;
  if (link) return { url: link, is_reusable: true };
  throw new AppError(
    "VALIDATION",
    "Meta messaging media needs either an uploaded attachment id or a public media url.",
  );
}

export interface MetaAttachmentUploadInput {
  /**
   * Graph endpoint base INCLUDING the version when the host wants one
   * (`https://graph.facebook.com/v26.0`) - Instagram's instagram-login
   * host takes no version, so the caller decides (see baseFor()).
   */
  endpointBase: string;
  accessToken: string;
  /** Endpoint owner: the Page id (Messenger) or the IG user id. */
  ownerId: string;
  /** Provider name for error mapping ("messenger" / "instagram"). */
  provider: string;
  data: Uint8Array;
  type: MetaAttachmentType;
  filename?: string;
  mimeType?: string;
}

/**
 * Upload bytes once and get a reusable `attachment_id` (M-1).
 *
 * Multipart on purpose - Graph rejects a JSON body here. The `message`
 * part describes the attachment (`is_reusable: true` is what lets the id
 * be sent to many recipients later), the `filedata` part is the bytes.
 */
export async function uploadMetaAttachment(
  fetchFn: FetchLike,
  input: MetaAttachmentUploadInput,
): Promise<string> {
  const form = new FormData();
  form.append("message", JSON.stringify({
    attachment: { type: input.type, payload: { is_reusable: true } },
  }));
  form.append(
    "filedata",
    new Blob([new Uint8Array(input.data)], { type: input.mimeType ?? "application/octet-stream" }),
    input.filename ?? `attachment.${input.type === "file" ? "bin" : input.type}`,
  );

  const res = await fetchFn(
    `${input.endpointBase.replace(/\/$/, "")}/${input.ownerId}/message_attachments`,
    {
      method: "POST",
      // No Content-Type: the runtime sets multipart/form-data with the
      // boundary it generated. Setting it by hand breaks the upload.
      headers: { Authorization: `Bearer ${input.accessToken}` },
      body: form,
    },
  );
  const json = (await res.json().catch(() => ({}))) as GraphErrorBodyShape & {
    attachment_id?: string;
    id?: string;
  };
  if (!res.ok || json.error) throw mapGraphError(json, res.status, input.provider);
  const id = json.attachment_id ?? json.id;
  if (typeof id !== "string" || !id) {
    throw new ProviderApiError(`${input.provider} attachment upload returned no attachment id`, {
      provider: input.provider,
      retryable: false,
    });
  }
  return id;
}
