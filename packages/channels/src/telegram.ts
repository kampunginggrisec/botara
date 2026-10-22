import { AppError } from "@botara/shared";
import { ProviderApiError, ProviderRateLimitError } from "./errors";
import {
  CHANNEL_CAPABILITIES, type AdapterHealth, type ChannelAccountRef, type ChannelAdapter,
  type CredentialProvider, type FetchLike, type InboundEvent, type PublishInput,
  type SendInput, type SendResult,
} from "./types";

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
    const res = await this.fetchFn(`${this.baseUrl}/bot${token}/${method}`, {
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
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1]!;
      return [{
        type: "message.received", ...base,
        text: msg.caption,
        media: { type: "photo", id: largest.file_id },
      }];
    }
    return [{ type: "message.received", ...base, text: msg.text }];
  }
}

interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  chat: { id: number; type?: string; title?: string; username?: string };
  from?: { id: number; username?: string; first_name?: string };
  photo?: Array<{ file_id: string; width: number; height: number }>;
}
