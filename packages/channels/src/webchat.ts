import { AppError } from "@botara/shared";
import {
  CHANNEL_CAPABILITIES, type AdapterHealth, type ChannelAccountRef, type ChannelAdapter,
  type InboundEvent, type SendInput, type SendResult,
} from "./types";
import { richToPlainText } from "./rich";

/**
 * Webchat adapter (Fase 2 - real, self-built).
 *
 * Meta's Customer Chat Plugin retired 2024-05-09 with NO replacement, so
 * Botara's website chat is its own widget + its own storage - there is no
 * external API to call. Inbound visitor messages arrive through the public
 * widget endpoints in apps/api and are persisted directly; this adapter
 * covers the OUTBOUND direction: when an agent replies from the inbox, the
 * reply is appended to the visitor's conversation through the injected
 * store port, and the widget picks it up on its next poll.
 *
 * Addressing: a webchat contact's externalId is `webchat-session:{id}`
 * where {id} is the webchat_sessions row id (NOT the secret session token -
 * the token never appears in conversation lists or URLs).
 */
export interface WebchatStore {
  /**
   * Append an agent reply to the conversation behind a visitor session.
   * Implementations resolve the session/conversation from the contact
   * externalId and persist a direction="out" message.
   */
  deliverOutbound(input: {
    toExternalId: string;
    text: string;
    idempotencyKey: string;
  }): Promise<{ messageId: string }>;
}

/** Store used when no persistence is wired: fails honestly, never fakes delivery. */
export class UnconfiguredWebchatStore implements WebchatStore {
  async deliverOutbound(): Promise<{ messageId: string }> {
    throw new AppError(
      "CONFIGURATION",
      "Webchat store is not configured on this process (inbox replies for webchat need the DB-backed store wired by apps/api)",
      { status: 503 },
    );
  }
}

export interface WebchatAdapterOptions {
  store?: WebchatStore;
}

export class WebchatAdapter implements ChannelAdapter {
  readonly key = "webchat" as const;
  readonly apiVersion = "botara-webchat-v1";
  readonly capabilities = CHANNEL_CAPABILITIES.webchat;

  private readonly store: WebchatStore;

  constructor(options: WebchatAdapterOptions = {}) {
    this.store = options.store ?? new UnconfiguredWebchatStore();
  }

  async connect(input: { workspaceId: string }): Promise<ChannelAccountRef> {
    // No external account exists: the "account" is the workspace's widget.
    return { id: "", externalId: `webchat:${input.workspaceId}` };
  }

  async disconnect(): Promise<void> {
    // Disabling the widget is a workspace setting, not an API call.
  }

  async refreshTokenIfNeeded(): Promise<{ refreshed: boolean }> {
    return { refreshed: false }; // No provider tokens on this channel.
  }

  async health(): Promise<AdapterHealth> {
    return this.store instanceof UnconfiguredWebchatStore
      ? { ok: false, detail: "webchat: store not configured on this process (API wires the DB-backed store)" }
      : { ok: true, detail: "webchat adapter ready (self-hosted widget channel)" };
  }

  async send(input: SendInput): Promise<SendResult> {
    // The widget renders plain text: rich blocks degrade to their
    // formatted text rendering with a typed warning (never silently).
    if (input.rich) {
      const { messageId } = await this.store.deliverOutbound({
        toExternalId: input.toExternalId,
        text: richToPlainText(input.rich),
        idempotencyKey: input.idempotencyKey,
      });
      return { externalMessageId: messageId, status: "sent", warnings: ["RICH_DEGRADED_TO_TEXT"] };
    }
    if (input.text === undefined) {
      throw new AppError("VALIDATION", "webchat.send requires text");
    }
    const { messageId } = await this.store.deliverOutbound({
      toExternalId: input.toExternalId,
      text: input.text,
      idempotencyKey: input.idempotencyKey,
    });
    return { externalMessageId: messageId, status: "sent" };
  }

  async parseWebhook(_payload: unknown): Promise<InboundEvent[]> {
    // No external webhooks exist for webchat - visitor messages enter via
    // the widget API endpoints and are persisted there.
    return [];
  }
}
