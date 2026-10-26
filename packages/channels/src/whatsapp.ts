import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError, NotImplementedError } from "@botara/shared";
import {
  MarketingPausedError, ProviderApiError, ProviderAuthError, ProviderRateLimitError,
  TemplateCategoryMismatchError,
} from "./errors";
import {
  CHANNEL_CAPABILITIES, type AdapterHealth, type ChannelAccountRef, type ChannelAdapter,
  type CredentialProvider, type FetchLike, type InboundEvent, type MessageMedia,
  type PublishInput, type SendInput, type SendResult, type SyncedContact,
} from "./types";
import { richToPlainText, type RichBlock, type RichWarning } from "./rich";

/**
 * WhatsApp Cloud API adapter (Fase 1 - real).
 *
 * Design points from the blueprint / ADR-008:
 * - Graph API version is PINNED (default v26.0, overridable per deployment).
 * - Template sends route by the template's LATEST category:
 *     marketing            -> POST /{phone-number-id}/marketing_messages
 *     utility/auth/etc.    -> POST /{phone-number-id}/messages
 *   (Cloud API marketing sunsets 2027-10-13; new accounts lose it 2027-04-13.)
 * - Access tokens come from the injected CredentialProvider keyed by the
 *   account's tokenVaultRef. They are never logged, never persisted here.
 */

export interface WhatsAppAdapterOptions {
  credentials: CredentialProvider;
  fetchFn?: FetchLike;
  graphVersion?: string;
  baseUrl?: string;
}

export type WhatsAppRoute = "messages" | "marketing_messages";

/** Pure routing decision - the heart of ADR-008. */
export function routeForTemplateCategory(latestCategory: string | undefined | null): WhatsAppRoute {
  return (latestCategory ?? "").toLowerCase() === "marketing" ? "marketing_messages" : "messages";
}

interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

/** Map a Graph API error payload onto the shared taxonomy. Exported for tests. */
export function mapWhatsAppError(
  body: GraphErrorBody,
  httpStatus: number,
  attemptedRoute?: WhatsAppRoute,
): ProviderApiError {
  const e = body.error ?? {};
  const details = {
    provider: "whatsapp",
    providerCode: e.code,
    providerSubcode: e.error_subcode,
    fbtraceId: e.fbtrace_id,
    retryable: httpStatus >= 500,
  };
  const message = e.message ?? `WhatsApp Graph API error (HTTP ${httpStatus})`;
  switch (e.code) {
    case 131063:
      return new TemplateCategoryMismatchError(message, {
        ...details, retryable: false, attemptedRoute: attemptedRoute ?? "messages",
      });
    case 131049:
      return new MarketingPausedError(message, details);
    case 130429: // messaging throughput limit
    case 80007: // account-level rate limit
    case 4: // app-level rate limit
      return new ProviderRateLimitError(message, details);
    case 190:
      return new ProviderAuthError(message, details);
    default:
      return new ProviderApiError(message, details);
  }
}

/**
 * Verify an X-Hub-Signature-256 header against the raw request body.
 * MUST be called with the exact raw bytes Meta sent (before JSON parsing).
 */
export function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret) return false;
  const expected = "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** GET webhook verification (hub.mode / hub.verify_token / hub.challenge). */
export function verifyWebhookChallenge(
  params: { mode?: string | null; token?: string | null; challenge?: string | null },
  expectedVerifyToken: string | undefined,
): string | null {
  if (!expectedVerifyToken) return null;
  if (params.mode === "subscribe" && params.token === expectedVerifyToken && params.challenge) {
    return params.challenge;
  }
  return null;
}

const isoFromEpochSeconds = (ts: unknown): string =>
  new Date((typeof ts === "string" ? Number(ts) : (ts as number)) * 1000).toISOString();

const WA_MEDIA_TYPES: readonly string[] = ["image", "video", "document", "audio", "sticker"];

/**
 * Normalize one WhatsApp message-shaped object (inbound message, Business
 * app echo, or history-backfill message - all three share Meta's message
 * shape) into the text/media parts of an InboundEvent.
 */
function waMessageParts(msg: Record<string, any>): { text?: string; media?: MessageMedia } {
  if (msg.type === "text") return { text: msg.text?.body };
  if (WA_MEDIA_TYPES.includes(msg.type as string)) {
    const m = (msg[msg.type] ?? {}) as Record<string, any>;
    const media: MessageMedia = {
      type: msg.type,
      id: m.id,
      caption: m.caption,
      mimeType: m.mime_type,
      filename: m.filename,
    };
    return { media, ...(m.caption ? { text: m.caption } : {}) };
  }
  return {};
}

/** Display name from a state-sync contact: full_name wins, else first + last. */
function syncedContactName(contact: Record<string, any>): string | undefined {
  if (typeof contact.full_name === "string" && contact.full_name) return contact.full_name;
  const parts = [contact.first_name, contact.last_name]
    .filter((p): p is string => typeof p === "string" && p.length > 0);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export class WhatsAppAdapter implements ChannelAdapter {
  readonly key = "whatsapp" as const;
  readonly apiVersion: string;
  readonly capabilities = CHANNEL_CAPABILITIES.whatsapp;

  private readonly credentials: CredentialProvider;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;

  constructor(options: WhatsAppAdapterOptions) {
    this.credentials = options.credentials;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.apiVersion = options.graphVersion ?? "v26.0";
    this.baseUrl = (options.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "");
  }

  // --- account lifecycle -------------------------------------------------

  async connect(): Promise<ChannelAccountRef> {
    // Onboarding is Embedded Signup v4, an API-layer browser flow that ends
    // with a provisioned channel_accounts row - not an adapter call.
    throw new NotImplementedError("whatsapp.connect (Embedded Signup onboarding provisions accounts at the API layer)");
  }

  async disconnect(): Promise<void> {
    // The credential lives in the vault; Fase 1 has no provider-side
    // deregistration (deregistering a number is destructive and out of scope).
  }

  async refreshTokenIfNeeded(): Promise<{ refreshed: boolean }> {
    // WhatsApp Cloud API uses long-lived system-user tokens; nothing rotates
    // on a schedule. Health checks surface dead tokens via error 190 instead.
    return { refreshed: false };
  }

  async health(account?: ChannelAccountRef): Promise<AdapterHealth> {
    if (!account) return { ok: false, detail: "whatsapp: an account is required for a health check" };
    const secrets = await this.credentials.resolve(account);
    return secrets.accessToken
      ? { ok: true, detail: `whatsapp adapter ready (Graph ${this.apiVersion})` }
      : { ok: false, detail: "whatsapp: no access token resolvable for this account (vault/env)" };
  }

  // --- sending -------------------------------------------------------------

  private async tokenFor(account: ChannelAccountRef): Promise<string> {
    const secrets = await this.credentials.resolve(account);
    if (!secrets.accessToken) {
      throw new AppError(
        "CONFIGURATION",
        "WhatsApp access token is not configured for this account (credential provider returned none)",
        { status: 503 },
      );
    }
    return secrets.accessToken;
  }

  private async graphPost(
    account: ChannelAccountRef,
    path: string,
    body: Record<string, unknown>,
    attemptedRoute?: WhatsAppRoute,
  ): Promise<Record<string, unknown>> {
    const token = await this.tokenFor(account);
    const res = await this.fetchFn(`${this.baseUrl}/${this.apiVersion}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as GraphErrorBody & Record<string, unknown>;
    if (!res.ok || json.error) throw mapWhatsAppError(json, res.status, attemptedRoute);
    return json;
  }

  private async graphGet(account: ChannelAccountRef, path: string): Promise<Record<string, unknown>> {
    const token = await this.tokenFor(account);
    const res = await this.fetchFn(`${this.baseUrl}/${this.apiVersion}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = (await res.json().catch(() => ({}))) as GraphErrorBody & Record<string, unknown>;
    if (!res.ok || json.error) throw mapWhatsAppError(json, res.status);
    return json;
  }

  async send(input: SendInput): Promise<SendResult> {
    if (input.rich) return this.sendRich(input, input.rich);
    const phoneNumberId = input.account.externalId;
    let route: WhatsAppRoute = "messages";
    let body: Record<string, unknown>;

    if (input.template) {
      route = routeForTemplateCategory(input.template.latestCategory);
      body = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: input.toExternalId,
        type: "template",
        template: {
          name: input.template.name,
          language: { code: input.template.language },
          ...(input.template.components ? { components: input.template.components } : {}),
        },
      };
    } else if (input.media) {
      const type = input.media.type === "photo" ? "image" : input.media.type;
      const mediaObj: Record<string, unknown> = {};
      if (input.media.id) mediaObj.id = input.media.id;
      else if (input.media.link) mediaObj.link = input.media.link;
      if (input.media.caption && (type === "image" || type === "video" || type === "document")) {
        mediaObj.caption = input.media.caption;
      }
      if (input.media.filename && type === "document") mediaObj.filename = input.media.filename;
      body = { messaging_product: "whatsapp", recipient_type: "individual", to: input.toExternalId, type, [type]: mediaObj };
    } else if (input.text !== undefined) {
      body = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: input.toExternalId,
        type: "text",
        text: { body: input.text },
      };
    } else {
      throw new AppError("VALIDATION", "whatsapp.send requires text, media, or a template");
    }

    const json = await this.graphPost(input.account, `${phoneNumberId}/${route}`, body, route);
    const messages = json.messages as Array<{ id?: string }> | undefined;
    const externalMessageId = messages?.[0]?.id;
    if (!externalMessageId) {
      throw new ProviderApiError("WhatsApp send returned no message id", {
        provider: "whatsapp", retryable: false,
      });
    }
    return { externalMessageId, status: "sent" };
  }

  /**
   * Rich-block renderer (interactive messages). Native: reply buttons
   * (max 3), list messages (max 10 rows total), a single CTA-URL button,
   * single-product and multi-product catalog messages. Everything else
   * (carousels, mixed button kinds, section-less catalogs) degrades to
   * formatted plain text + a typed warning - never silently.
   */
  private async sendRich(input: SendInput, rich: RichBlock): Promise<SendResult> {
    const phoneNumberId = input.account.externalId;
    const warnings: RichWarning[] = [];
    const base = { messaging_product: "whatsapp", recipient_type: "individual", to: input.toExternalId };
    let body: Record<string, unknown> | null = null;

    const truncate = (value: string, max: number): string => {
      if (value.length <= max) return value;
      warnings.push("RICH_TITLES_TRUNCATED");
      return value.slice(0, max);
    };

    if (rich.kind === "buttons") {
      const urlButtons = rich.buttons.filter((b) => b.type === "url");
      if (urlButtons.length === 0) {
        // Reply/postback buttons -> interactive "button" message (max 3).
        let buttons = rich.buttons;
        if (buttons.length > 3) {
          buttons = buttons.slice(0, 3);
          warnings.push("RICH_BUTTONS_TRUNCATED");
        }
        body = {
          ...base, type: "interactive",
          interactive: {
            type: "button",
            body: { text: rich.text },
            action: {
              buttons: buttons.map((b) => ({
                type: "reply",
                reply: { id: b.payload!, title: truncate(b.title, 20) },
              })),
            },
          },
        };
      } else if (rich.buttons.length === 1) {
        // Single CTA-URL button message.
        const button = rich.buttons[0]!;
        body = {
          ...base, type: "interactive",
          interactive: {
            type: "cta_url",
            body: { text: rich.text },
            action: {
              name: "cta_url",
              parameters: { display_text: truncate(button.title, 20), url: button.url! },
            },
          },
        };
      }
      // Mixed reply+url buttons have no single native shape -> text fallback below.
    } else if (rich.kind === "list") {
      let rowsLeft = 10; // WhatsApp caps a list at 10 rows across sections.
      const sections = rich.sections.map((section) => {
        const rows = section.rows.slice(0, Math.max(0, rowsLeft));
        if (rows.length < section.rows.length) warnings.push("RICH_ROWS_TRUNCATED");
        rowsLeft -= rows.length;
        return {
          title: truncate(section.title, 24),
          rows: rows.map((row) => ({
            id: row.id,
            title: truncate(row.title, 24),
            ...(row.description ? { description: truncate(row.description, 72) } : {}),
          })),
        };
      }).filter((s) => s.rows.length > 0);
      if (sections.length > 0) {
        body = {
          ...base, type: "interactive",
          interactive: {
            type: "list",
            body: { text: rich.text },
            action: { button: truncate(rich.buttonText, 20), sections },
          },
        };
      }
    } else if (rich.kind === "product") {
      body = {
        ...base, type: "interactive",
        interactive: {
          type: "product",
          ...(rich.text ? { body: { text: rich.text } } : {}),
          action: { catalog_id: rich.catalogId, product_retailer_id: rich.productId },
        },
      };
    } else if (rich.kind === "catalog" && rich.sections && rich.sections.length > 0) {
      body = {
        ...base, type: "interactive",
        interactive: {
          type: "product_list",
          header: { type: "text", text: truncate(rich.sections[0]!.title, 60) },
          body: { text: rich.text ?? rich.sections[0]!.title },
          action: {
            catalog_id: rich.catalogId,
            sections: rich.sections.map((section) => ({
              title: truncate(section.title, 24),
              product_items: section.productIds.map((id) => ({ product_retailer_id: id })),
            })),
          },
        },
      };
    }

    if (!body) {
      warnings.push("RICH_DEGRADED_TO_TEXT");
      body = { ...base, type: "text", text: { body: richToPlainText(rich) } };
    }
    const json = await this.graphPost(input.account, `${phoneNumberId}/messages`, body, "messages");
    const messages = json.messages as Array<{ id?: string }> | undefined;
    const externalMessageId = messages?.[0]?.id;
    if (!externalMessageId) {
      throw new ProviderApiError("WhatsApp send returned no message id", {
        provider: "whatsapp", retryable: false,
      });
    }
    return { externalMessageId, status: "sent", ...(warnings.length > 0 ? { warnings } : {}) };
  }

  // --- media ---------------------------------------------------------------

  /** Upload media to Meta; returns the media id usable in send(). */
  async uploadMedia(
    account: ChannelAccountRef,
    file: { data: Blob | Uint8Array | ArrayBuffer; mimeType: string; filename?: string },
  ): Promise<{ mediaId: string }> {
    const token = await this.tokenFor(account);
    const blob = file.data instanceof Blob
      ? file.data
      : new Blob(
          // Fresh ArrayBuffer-backed copy: BlobPart requires
          // Uint8Array<ArrayBuffer> under the DOM lib's typings.
          [new Uint8Array(file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data))],
          { type: file.mimeType },
        );
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", file.mimeType);
    form.set("file", blob, file.filename ?? "upload");
    const res = await this.fetchFn(`${this.baseUrl}/${this.apiVersion}/${account.externalId}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const json = (await res.json().catch(() => ({}))) as GraphErrorBody & { id?: string };
    if (!res.ok || json.error) throw mapWhatsAppError(json, res.status);
    if (!json.id) throw new ProviderApiError("WhatsApp media upload returned no id", { provider: "whatsapp", retryable: false });
    return { mediaId: json.id };
  }

  /** Resolve a media id to its (short-lived, auth-required) download URL + metadata. */
  async fetchMediaUrl(account: ChannelAccountRef, mediaId: string): Promise<{ url: string; mimeType?: string; fileSize?: number }> {
    const json = await this.graphGet(account, mediaId);
    return {
      url: json.url as string,
      mimeType: json.mime_type as string | undefined,
      fileSize: json.file_size as number | undefined,
    };
  }

  /** Download media bytes. The URL from fetchMediaUrl requires the same bearer token. */
  async downloadMedia(
    account: ChannelAccountRef,
    mediaId: string,
  ): Promise<{ data: ArrayBuffer; mimeType?: string; fileSize?: number }> {
    const meta = await this.fetchMediaUrl(account, mediaId);
    const token = await this.tokenFor(account);
    const res = await this.fetchFn(meta.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new ProviderApiError(`WhatsApp media download failed (HTTP ${res.status})`, {
        provider: "whatsapp", retryable: res.status >= 500,
      });
    }
    return { data: await res.arrayBuffer(), mimeType: meta.mimeType, fileSize: meta.fileSize };
  }

  // --- webhooks --------------------------------------------------------------

  async parseWebhook(payload: unknown): Promise<InboundEvent[]> {
    const events: InboundEvent[] = [];
    const root = payload as { entry?: Array<Record<string, unknown>> } | null;
    for (const entry of root?.entry ?? []) {
      const changes = (entry.changes as Array<Record<string, unknown>> | undefined) ?? [];
      for (const change of changes) {
        const value = (change.value ?? {}) as Record<string, any>;
        const accountExternalId: string =
          value.metadata?.phone_number_id ?? (entry.id as string) ?? "";
        const field = change.field as string;

        // Meta currently exposes this subscription as
        // `template_category_update`. Keep the former spelling as a
        // compatibility alias for deliveries/subscriptions created before
        // the rename.
        if (field === "template_category_update" || field === "message_template_category_update") {
          events.push({
            type: "template.category_changed",
            channel: "whatsapp",
            templateExternalId: String(value.message_template_id ?? ""),
            templateName: value.message_template_name,
            language: value.message_template_language,
            previousCategory: typeof value.previous_category === "string" ? value.previous_category.toLowerCase() : undefined,
            newCategory: String(value.new_category ?? "").toLowerCase(),
            // entry.id is the WABA (messaging account) id for this event; the
            // API layer persists it on the template row (messaging_account_id).
            accountExternalId: entry.id !== undefined ? String(entry.id) : undefined,
            receivedAt: new Date().toISOString(),
          });
          continue;
        }

        if (field === "smb_message_echoes" || field === "messages") {
          for (const echo of (value.message_echoes as Array<Record<string, any>> | undefined) ?? []) {
            events.push({
              type: "message.echo",
              channel: "whatsapp",
              accountExternalId,
              contactExternalId: String(echo.to ?? ""),
              messageExternalId: String(echo.id ?? ""),
              ...waMessageParts(echo),
              receivedAt: isoFromEpochSeconds(echo.timestamp),
            });
          }
        }

        if (field === "smb_app_state_sync") {
          // Coexistence contact sync: the Business app's address book,
          // as add/update/remove items keyed by phone number. One
          // normalized event carries the whole batch.
          const synced: SyncedContact[] = [];
          let latestTs: number | undefined;
          for (const item of (value.state_sync as Array<Record<string, any>> | undefined) ?? []) {
            if (item.type !== undefined && item.type !== "contact") continue;
            const contact = (item.contact ?? {}) as Record<string, any>;
            const phone = typeof contact.phone_number === "string" ? contact.phone_number : "";
            if (!phone) continue;
            const displayName = syncedContactName(contact);
            const action = item.action === "remove" || item.action === "update" ? item.action : "add";
            synced.push({ externalId: phone, ...(displayName ? { displayName } : {}), action });
            const ts = Number(item.timestamp);
            if (Number.isFinite(ts) && ts > 0) latestTs = Math.max(latestTs ?? 0, ts);
          }
          if (synced.length > 0) {
            events.push({
              type: "contacts.synced",
              channel: "whatsapp",
              accountExternalId,
              contacts: synced,
              receivedAt: latestTs ? new Date(latestTs * 1000).toISOString() : new Date().toISOString(),
            });
          }
          continue;
        }

        if (field === "history") {
          // Coexistence chat-history backfill: chunked replays of up to
          // ~6 months of chats, requested once via smb_app_data after
          // onboarding. Chunks repeat and overlap (dedupe downstream on
          // the wamid); a chunk whose sharing the business declined
          // carries `errors` instead of threads and yields nothing.
          // Direction: history messages have no reliable from-me flag -
          // a message is OUTBOUND when it carries a `to` (only Business
          // app echoes do) or its `from` is not the thread's customer.
          const chunks: Array<Record<string, any>> =
            (value.history as Array<Record<string, any>> | undefined)
            ?? (value.history_chunks as Array<Record<string, any>> | undefined)
            ?? (Array.isArray(value.threads) ? [value] : []);
          for (const chunk of chunks) {
            const threads = (chunk.threads as Array<Record<string, any>> | undefined) ?? [];
            for (const thread of threads) {
              const customer = thread.id !== undefined ? String(thread.id) : "";
              for (const msg of (thread.messages as Array<Record<string, any>> | undefined) ?? []) {
                // Media placeholders are redelivered later with the real
                // media under the same id; reactions are not messages.
                if (msg.type === "media_placeholder" || msg.type === "reaction") continue;
                const parts = waMessageParts(msg);
                // System/unknown shapes carry no inbox content - skip
                // them rather than persisting empty bubbles.
                if (msg.type !== "text" && !parts.media) continue;
                const to = typeof msg.to === "string" && msg.to ? msg.to : undefined;
                const from = typeof msg.from === "string" ? msg.from : "";
                const direction: "in" | "out" =
                  to !== undefined || (from !== "" && from !== customer) ? "out" : "in";
                const contactExternalId = customer || (direction === "in" ? from : (to ?? ""));
                if (!contactExternalId || !msg.id) continue;
                events.push({
                  type: "message.history",
                  channel: "whatsapp",
                  accountExternalId,
                  contactExternalId,
                  messageExternalId: String(msg.id),
                  direction,
                  ...parts,
                  receivedAt: isoFromEpochSeconds(msg.timestamp),
                });
              }
            }
          }
          continue;
        }

        if (field !== "messages") continue;

        for (const msg of (value.messages as Array<Record<string, any>> | undefined) ?? []) {
          const base = {
            channel: "whatsapp" as const,
            accountExternalId,
            contactExternalId: String(msg.from ?? ""),
            messageExternalId: String(msg.id ?? ""),
            receivedAt: isoFromEpochSeconds(msg.timestamp),
          };
          // Click-to-WhatsApp ads attach a referral object to the FIRST
          // message of the conversation - the growth-attribution signal.
          const referral = msg.referral
            ? {
                source: typeof msg.referral.source_type === "string" ? msg.referral.source_type : undefined,
                ctwaClid: typeof msg.referral.ctwa_clid === "string" ? msg.referral.ctwa_clid : undefined,
                sourceId: msg.referral.source_id !== undefined ? String(msg.referral.source_id) : undefined,
              }
            : undefined;
          if (msg.type === "text") {
            events.push({ type: "message.received", ...base, text: msg.text?.body, ...(referral ? { referral } : {}) });
          } else if (["image", "video", "document", "audio", "sticker"].includes(msg.type)) {
            const m = (msg[msg.type] ?? {}) as Record<string, any>;
            const media: MessageMedia = {
              type: msg.type,
              id: m.id,
              caption: m.caption,
              mimeType: m.mime_type,
              filename: m.filename,
            };
            events.push({ type: "message.received", ...base, media, ...(m.caption ? { text: m.caption } : {}), ...(referral ? { referral } : {}) });
          } else {
            events.push({ type: "message.received", ...base, ...(referral ? { referral } : {}) });
          }
        }

        for (const st of (value.statuses as Array<Record<string, any>> | undefined) ?? []) {
          events.push({
            type: "message.status",
            channel: "whatsapp",
            accountExternalId,
            messageExternalId: String(st.id ?? ""),
            status: st.status,
            errors: Array.isArray(st.errors)
              ? st.errors.map((err: Record<string, any>) => ({
                  code: err.code,
                  title: err.title,
                  message: err.error_data?.details ?? err.message,
                }))
              : undefined,
            receivedAt: isoFromEpochSeconds(st.timestamp),
          });
        }
      }
    }
    return events;
  }

  async publish(_input: PublishInput): Promise<{ externalPostId: string }> {
    throw new NotImplementedError("whatsapp.publish (WhatsApp has no post publishing surface)");
  }
}
