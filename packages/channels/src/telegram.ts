import { AppError } from "@botara/shared";
import { ProviderApiError, ProviderRateLimitError } from "./errors";
import {
  CHANNEL_CAPABILITIES, type AdapterHealth, type ChannelAccountRef, type ChannelAdapter,
  type CredentialProvider, type FetchLike, type InboundEvent, type MessageMedia,
  type PublishInput, type SendInput, type SendResult,
} from "./types";
import { richToPlainText, type RichBlock, type RichButton, type RichWarning } from "./rich";

/**
 * Telegram Bot API adapter (Fase 1 - real).
 * Bot token comes from the injected CredentialProvider (tokenVaultRef-keyed),
 * never from the account row, never logged.
 */

export interface TelegramAdapterOptions {
  credentials: CredentialProvider;
  fetchFn?: FetchLike;
  /** Override for tests / self-hosted Bot API servers. */
  baseUrl?: string;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export class TelegramAdapter implements ChannelAdapter {
  readonly key = "telegram" as const;
  /** Bot API is unversioned; the string records the surface this adapter targets. */
  readonly apiVersion = "bot-api";
  readonly capabilities = CHANNEL_CAPABILITIES.telegram;

  private readonly credentials: CredentialProvider;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;

  constructor(options: TelegramAdapterOptions) {
    this.credentials = options.credentials;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.baseUrl = (options.baseUrl ?? "https://api.telegram.org").replace(/\/$/, "");
  }

  private async tokenFor(account: ChannelAccountRef): Promise<string> {
    const secrets = await this.credentials.resolve(account);
    const token = secrets.botToken ?? secrets.accessToken;
    if (!token) {
      throw new AppError(
        "CONFIGURATION",
        "Telegram bot token is not configured for this account (credential provider returned none)",
        { status: 503 },
      );
    }
    return token;
  }

  private async call<T>(account: ChannelAccountRef, method: string, body?: Record<string, unknown>): Promise<T> {
    const token = await this.tokenFor(account);
    return this.callWithToken<T>(token, method, body);
  }

  /** Same as call(), with the bot token supplied directly (pre-vault / proxy flows). */
  private async callWithToken<T>(botToken: string, method: string, body?: Record<string, unknown>): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const json = (await res.json().catch(() => ({ ok: false }))) as TelegramResponse<T>;
    if (!json.ok) {
      const details = {
        provider: "telegram",
        providerCode: json.error_code,
        retryable: res.status >= 500,
      };
      if (json.error_code === 429) {
        throw new ProviderRateLimitError(json.description ?? "Telegram rate limit", {
          ...details, retryable: true,
        });
      }
      throw new ProviderApiError(json.description ?? `Telegram Bot API error (HTTP ${res.status})`, details, {
        status: res.status === 401 || res.status === 404 ? 401 : 502,
      });
    }
    return json.result as T;
  }

  /**
   * Public bot identity for the connect flow (API layer): validates the
   * configured token against getMe and returns the bot's id + username.
   * Throws ProviderApiError (401) for an invalid token.
   */
  async describeBot(): Promise<{ id: number; username?: string; firstName?: string }> {
    return this.call<{ id: number; username?: string; first_name?: string }>(
      { id: "", externalId: "" },
      "getMe",
    ).then((me) => ({ id: me.id, username: me.username, firstName: me.first_name }));
  }

  /** Register the webhook with an EXPLICIT token (connect flow, pre-vault). */
  async setWebhookWithToken(input: { url: string; secretToken?: string }): Promise<{ ok: true }> {
    return this.setWebhook({ id: "", externalId: "" }, input);
  }

  /**
   * The bot's OWN profile photo as raw bytes, for the API's authenticated
   * avatar proxy. Telegram file URLs embed the bot token
   * (https://api.telegram.org/file/bot<TOKEN>/...), so they must never be
   * stored on the account row or rendered by a client - the bytes are
   * fetched here and streamed by the API instead. `botId` is the bot's own
   * user id (the channel account's externalId); when omitted it is
   * resolved via getMe. Best-effort: null when the bot has no profile
   * photo or any call fails.
   */
  async fetchOwnAvatar(input: {
    botToken: string;
    botId?: string;
  }): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    try {
      const botId = input.botId
        ?? String((await this.callWithToken<{ id: number }>(input.botToken, "getMe")).id);
      const photos = await this.callWithToken<{
        total_count: number;
        photos: Array<Array<{ file_id: string; width: number; height: number }>>;
      }>(input.botToken, "getUserProfilePhotos", { user_id: Number(botId), limit: 1 });
      const sizes = photos.photos?.[0];
      if (!sizes || sizes.length === 0) return null;
      // PhotoSize entries ascend by dimension. Take the second-smallest
      // when offered (typically 320px - plenty for a 40px avatar) and
      // never the full-size original.
      const size = sizes[Math.min(1, sizes.length - 1)]!;
      const file = await this.callWithToken<{ file_path?: string }>(
        input.botToken, "getFile", { file_id: size.file_id },
      );
      if (!file.file_path) return null;
      const res = await this.fetchFn(`${this.baseUrl}/file/bot${input.botToken}/${file.file_path}`);
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length === 0) return null;
      const contentType = res.headers.get("content-type") ?? telegramFileContentType(file.file_path);
      return { bytes, contentType };
    } catch {
      return null;
    }
  }

  // --- account lifecycle ---------------------------------------------------

  async connect(input: { workspaceId: string }): Promise<ChannelAccountRef> {
    // Validate the configured bot token against getMe and derive the account.
    void input.workspaceId;
    const probe: ChannelAccountRef = { id: "", externalId: "" };
    const me = await this.call<{ id: number; username?: string }>(probe, "getMe");
    return { id: "", externalId: String(me.id), authMode: me.username ? `@${me.username}` : undefined };
  }

  async disconnect(account: ChannelAccountRef): Promise<void> {
    // Removing the webhook stops inbound delivery; the token itself is
    // revoked by the operator in @BotFather, outside this adapter.
    await this.call(account, "deleteWebhook").catch(() => undefined);
  }

  async refreshTokenIfNeeded(): Promise<{ refreshed: boolean }> {
    return { refreshed: false }; // Bot tokens do not expire.
  }

  async health(account?: ChannelAccountRef): Promise<AdapterHealth> {
    if (!account) return { ok: false, detail: "telegram: an account is required for a health check" };
    const secrets = await this.credentials.resolve(account);
    return secrets.botToken || secrets.accessToken
      ? { ok: true, detail: "telegram adapter ready (Bot API)" }
      : { ok: false, detail: "telegram: no bot token resolvable for this account (vault/env)" };
  }

  // --- sending ---------------------------------------------------------------

  async send(input: SendInput): Promise<SendResult> {
    if (input.rich) return this.sendRich(input, input.rich);
    const chatId = input.toExternalId;
    if (input.media && (input.media.type === "image" || input.media.type === "photo")) {
      const photo = input.media.id ?? input.media.link;
      if (!photo) throw new AppError("VALIDATION", "telegram.sendPhoto requires a media id (file_id) or link");
      const result = await this.call<{ message_id: number }>(input.account, "sendPhoto", {
        chat_id: chatId,
        photo,
        ...(input.media.caption ? { caption: input.media.caption } : {}),
      });
      return { externalMessageId: String(result.message_id), status: "sent" };
    }
    if (input.text === undefined) {
      throw new AppError("VALIDATION", "telegram.send requires text or a photo");
    }
    const result = await this.call<{ message_id: number }>(input.account, "sendMessage", {
      chat_id: chatId,
      text: input.text,
    });
    return { externalMessageId: String(result.message_id), status: "sent" };
  }

  /** Map rich buttons onto an inline keyboard (rows of at most 3). */
  private inlineKeyboard(buttons: RichButton[]): { inline_keyboard: Array<Array<Record<string, string>>> } {
    const mapped: Array<Record<string, string>> = buttons.map((b): Record<string, string> => b.type === "url"
      ? { text: b.title, url: b.url! }
      : { text: b.title, callback_data: b.payload! });
    const rows: Array<Array<Record<string, string>>> = [];
    for (let i = 0; i < mapped.length; i += 3) rows.push(mapped.slice(i, i + 3));
    return { inline_keyboard: rows };
  }

  /**
   * Rich-block renderer (Bot API). Native: buttons and card buttons as
   * inline keyboards. A carousel has no native Telegram form - it degrades
   * to a SEQUENCE of card messages (photo + caption + that card's
   * keyboard), a list degrades to text + a one-button-per-row keyboard,
   * and product/catalog blocks degrade to formatted text - each with its
   * typed warning, never silently.
   */
  private async sendRich(input: SendInput, rich: RichBlock): Promise<SendResult> {
    const chatId = input.toExternalId;
    const warnings: RichWarning[] = [];

    if (rich.kind === "buttons") {
      const result = await this.call<{ message_id: number }>(input.account, "sendMessage", {
        chat_id: chatId,
        text: rich.text,
        reply_markup: this.inlineKeyboard(rich.buttons),
      });
      return { externalMessageId: String(result.message_id), status: "sent" };
    }

    if (rich.kind === "list") {
      warnings.push("RICH_LIST_AS_KEYBOARD");
      const lines = [rich.text];
      const rowButtons: RichButton[] = [];
      for (const section of rich.sections) {
        lines.push("", section.title);
        for (const row of section.rows) {
          rowButtons.push({ type: "reply", title: row.title, payload: row.id });
        }
      }
      const result = await this.call<{ message_id: number }>(input.account, "sendMessage", {
        chat_id: chatId,
        text: lines.join("\n"),
        reply_markup: {
          inline_keyboard: rowButtons.map((b) => [{ text: b.title, callback_data: b.payload! }]),
        },
      });
      return { externalMessageId: String(result.message_id), status: "sent", warnings };
    }

    if (rich.kind === "carousel") {
      warnings.push("RICH_CAROUSEL_SEQUENTIAL");
      let firstMessageId = "";
      for (const card of rich.cards) {
        const caption = [card.title, card.subtitle].filter(Boolean).join("\n");
        const markup = card.buttons && card.buttons.length > 0
          ? { reply_markup: this.inlineKeyboard(card.buttons) }
          : {};
        const result = card.imageUrl
          ? await this.call<{ message_id: number }>(input.account, "sendPhoto", {
              chat_id: chatId, photo: card.imageUrl, caption, ...markup,
            })
          : await this.call<{ message_id: number }>(input.account, "sendMessage", {
              chat_id: chatId, text: caption, ...markup,
            });
        if (!firstMessageId) firstMessageId = String(result.message_id);
      }
      return { externalMessageId: firstMessageId, status: "sent", warnings };
    }

    warnings.push("RICH_DEGRADED_TO_TEXT");
    const result = await this.call<{ message_id: number }>(input.account, "sendMessage", {
      chat_id: chatId,
      text: richToPlainText(rich),
    });
    return { externalMessageId: String(result.message_id), status: "sent", warnings };
  }

  async publish(input: PublishInput): Promise<{ externalPostId: string }> {
    // Publishing to a Telegram channel = sending to the channel chat id,
    // which the caller passes as the account's publish target in externalId.
    const result = await this.send({
      account: input.account,
      toExternalId: input.account.externalId,
      text: input.text,
      media: input.mediaUrls?.[0] ? { type: "photo", link: input.mediaUrls[0] } : undefined,
      idempotencyKey: input.idempotencyKey,
    });
    return { externalPostId: result.externalMessageId };
  }

  // --- webhooks ----------------------------------------------------------------

  /** Register (or move) the bot webhook. `secretToken` is echoed back by Telegram in the x-telegram-bot-api-secret-token header. */
  async setWebhook(
    account: ChannelAccountRef,
    input: { url: string; secretToken?: string },
  ): Promise<{ ok: true }> {
    await this.call(account, "setWebhook", {
      url: input.url,
      ...(input.secretToken ? { secret_token: input.secretToken } : {}),
      allowed_updates: ["message", "channel_post"],
    });
    return { ok: true };
  }

  // --- inbound media ---------------------------------------------------------

  /** Resolve a file_id to its downloadable path + size (Bot API getFile). */
  async fetchFilePath(
    account: ChannelAccountRef,
    fileId: string,
  ): Promise<{ filePath?: string; fileSize?: number }> {
    const result = await this.call<{ file_path?: string; file_size?: number }>(
      account, "getFile", { file_id: fileId },
    );
    return { filePath: result.file_path, fileSize: result.file_size };
  }

  /**
   * Download the bytes behind an inbound file_id (the Telegram twin of
   * WhatsApp's downloadMedia): getFile resolves the path, then the file
   * is served from /file/bot<token>/<file_path>. Telegram caps bot
   * downloads at 20 MB - larger files make getFile itself fail, and the
   * caller (the inbound media pipeline) additionally enforces its own
   * byte cap on whatever comes back.
   */
  async downloadFile(
    account: ChannelAccountRef,
    fileId: string,
  ): Promise<{ data: ArrayBuffer; fileSize?: number }> {
    const { filePath, fileSize } = await this.fetchFilePath(account, fileId);
    if (!filePath) {
      throw new ProviderApiError("Telegram getFile returned no file_path", {
        provider: "telegram", retryable: false,
      });
    }
    const botToken = await this.tokenFor(account);
    const res = await this.fetchFn(`${this.baseUrl}/file/bot${botToken}/${filePath}`);
    if (!res.ok) {
      throw new ProviderApiError(`Telegram file download failed (HTTP ${res.status})`, {
        provider: "telegram", retryable: res.status >= 500,
      });
    }
    return { data: await res.arrayBuffer(), fileSize };
  }

  async parseWebhook(payload: unknown): Promise<InboundEvent[]> {
    const update = payload as {
      update_id?: number;
      message?: TelegramMessage;
      channel_post?: TelegramMessage;
    } | null;
    const msg = update?.message;
    if (!msg) return [];
    const receivedAt = new Date(msg.date * 1000).toISOString();
    const base = {
      channel: "telegram" as const,
      accountExternalId: "",
      contactExternalId: String(msg.chat.id),
      messageExternalId: String(msg.message_id),
      receivedAt,
    };
    const media = telegramMediaOf(msg);
    if (media) {
      return [{
        type: "message.received", ...base,
        text: msg.caption,
        media,
      }];
    }
    return [{ type: "message.received", ...base, text: msg.text }];
  }
}

interface TelegramFile {
  file_id: string;
  file_name?: string;
  mime_type?: string;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  chat: { id: number; type?: string; title?: string; username?: string };
  from?: { id: number; username?: string; first_name?: string };
  photo?: Array<{ file_id: string; width: number; height: number }>;
  document?: TelegramFile;
  video?: TelegramFile;
  audio?: TelegramFile;
  voice?: { file_id: string; mime_type?: string };
  animation?: TelegramFile;
  sticker?: { file_id: string };
}

/**
 * The one media item a Telegram message carries, normalized. Photos
 * arrive as a size ladder - the largest is the original. Voice notes
 * and animations fold onto the shared audio/video types.
 */
function telegramMediaOf(msg: TelegramMessage): MessageMedia | undefined {
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]!;
    return { type: "photo", id: largest.file_id };
  }
  if (msg.document) {
    return { type: "document", id: msg.document.file_id, filename: msg.document.file_name, mimeType: msg.document.mime_type };
  }
  if (msg.video) {
    return { type: "video", id: msg.video.file_id, filename: msg.video.file_name, mimeType: msg.video.mime_type };
  }
  if (msg.audio) {
    return { type: "audio", id: msg.audio.file_id, filename: msg.audio.file_name, mimeType: msg.audio.mime_type };
  }
  if (msg.voice) {
    return { type: "audio", id: msg.voice.file_id, mimeType: msg.voice.mime_type };
  }
  if (msg.animation) {
    return { type: "video", id: msg.animation.file_id, filename: msg.animation.file_name, mimeType: msg.animation.mime_type };
  }
  if (msg.sticker) {
    return { type: "sticker", id: msg.sticker.file_id };
  }
  return undefined;
}

/** Content type for a Telegram file download when the response omits one. */
function telegramFileContentType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/jpeg";
}
