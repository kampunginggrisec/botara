import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError, NotImplementedError } from "@botara/shared";
import { ProviderApiError, ProviderRateLimitError } from "./errors";
import {
  CHANNEL_CAPABILITIES, type AdapterHealth, type ChannelAccountRef, type ChannelAdapter,
  type CredentialProvider, type FetchLike, type InboundEvent, type MessageAttachment,
  type PublishInput, type SendInput, type SendResult,
} from "./types";

/**
 * Email adapter via Resend (Fase 2 - real).
 *
 * Sending: POST https://api.resend.com/emails, ALWAYS with an
 * Idempotency-Key header (Resend honours it for 24h) so worker retries can
 * never double-send. The API key comes from the credential provider
 * (accessToken slot), never from the account row.
 *
 * Receiving: Resend's `email.received` webhook carries METADATA ONLY. The
 * full message (body, headers) is fetched from the Receiving API and the
 * attachment list (with temporary download URLs) from the Attachments API -
 * see fetchInboundEmail. Attachments must be copied into R2 promptly by the
 * worker because those download URLs expire (see apps/worker email-inbound).
 *
 * Webhook authenticity is Svix: verify with verifyResendWebhookSignature.
 */

export interface EmailAdapterOptions {
  credentials: CredentialProvider;
  fetchFn?: FetchLike;
  baseUrl?: string;
  /** Fallback From address when the account externalId is not an email address. */
  defaultFrom?: string;
}

interface ResendErrorBody {
  statusCode?: number;
  name?: string;
  message?: string;
}

function mapResendError(body: ResendErrorBody, httpStatus: number): ProviderApiError {
  const status = body.statusCode ?? httpStatus;
  const message = body.message ?? `Resend API error (HTTP ${status})`;
  const details = { provider: "resend", providerCode: status, retryable: status >= 500 || status === 429 };
  if (status === 429) return new ProviderRateLimitError(message, details);
  return new ProviderApiError(message, details, { status: status === 401 || status === 403 ? 401 : 502 });
}

/**
 * Verify a Resend (Svix) webhook signature.
 * Signed content: `{svix-id}.{svix-timestamp}.{rawBody}`, HMAC-SHA256 keyed
 * by the base64-decoded secret (the part after `whsec_`). The signature
 * header may carry several space-separated `v1,<base64>` candidates.
 */
export function verifyResendWebhookSignature(input: {
  rawBody: string;
  svixId?: string | null;
  svixTimestamp?: string | null;
  svixSignature?: string | null;
  secret: string;
  toleranceSeconds?: number;
  now?: Date;
}): boolean {
  const { rawBody, svixId, svixTimestamp, svixSignature, secret } = input;
  if (!svixId || !svixTimestamp || !svixSignature || !secret) return false;
  const tolerance = input.toleranceSeconds ?? 300;
  const tsSeconds = Number(svixTimestamp);
  if (!Number.isFinite(tsSeconds)) return false;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - tsSeconds) > tolerance) return false;
  const keyB64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(keyB64, "base64");
  } catch {
    return false;
  }
  if (key.length === 0) return false;
  const expected = createHmac("sha256", key)
    .update(`${svixId}.${svixTimestamp}.${rawBody}`)
    .digest();
  for (const candidate of svixSignature.split(" ")) {
    const [version, sig] = candidate.split(",");
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

/** Full inbound email content, fetched from the Receiving + Attachments APIs. */
export interface InboundEmailContent {
  id: string;
  from: string;
  to: string[];
  subject?: string;
  text?: string;
  html?: string;
  headers: Record<string, string>;
  attachments: Array<MessageAttachment & { downloadUrl: string }>;
}

export class EmailAdapter implements ChannelAdapter {
  readonly key = "email" as const;
  readonly apiVersion = "resend-v1";
  readonly capabilities = CHANNEL_CAPABILITIES.email;

  private readonly credentials: CredentialProvider;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;
  private readonly defaultFrom?: string;

  constructor(options: EmailAdapterOptions) {
    this.credentials = options.credentials;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.baseUrl = (options.baseUrl ?? "https://api.resend.com").replace(/\/$/, "");
    this.defaultFrom = options.defaultFrom;
  }

  async connect(): Promise<ChannelAccountRef> {
    throw new NotImplementedError(
      "email.connect (Resend domain verification + API key setup happen at the API layer)",
    );
  }

  async disconnect(): Promise<void> {
    // Nothing provider-side to tear down in Fase 2.
  }

  async refreshTokenIfNeeded(): Promise<{ refreshed: boolean }> {
    return { refreshed: false }; // Resend API keys do not rotate automatically.
  }

  async health(account?: ChannelAccountRef): Promise<AdapterHealth> {
    if (!account) return { ok: false, detail: "email: an account is required for a health check" };
    const secrets = await this.credentials.resolve(account);
    return secrets.accessToken
      ? { ok: true, detail: "email adapter ready (Resend)" }
      : { ok: false, detail: "email: no Resend API key resolvable for this account (vault/env)" };
  }

  private async apiKeyFor(account: ChannelAccountRef): Promise<string> {
    const secrets = await this.credentials.resolve(account);
    if (!secrets.accessToken) {
      throw new AppError(
        "CONFIGURATION",
        "Resend API key is not configured for this account (credential provider returned none)",
        { status: 503 },
      );
    }
    return secrets.accessToken;
  }

  private async resend(
    account: ChannelAccountRef,
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const apiKey = await this.apiKeyFor(account);
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...extraHeaders,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as ResendErrorBody & Record<string, unknown>;
    if (!res.ok) throw mapResendError(json, res.status);
    return json;
  }

  // --- sending -------------------------------------------------------------------

  async send(input: SendInput): Promise<SendResult> {
    const from = input.account.externalId.includes("@")
      ? input.account.externalId
      : this.defaultFrom;
    if (!from) {
      throw new AppError(
        "CONFIGURATION",
        "email.send needs a From address: set the account externalId to the sending address or configure a default From",
        { status: 503 },
      );
    }
    const text = input.text ?? "";
    const subject = input.subject
      ?? (text.split("\n")[0]?.slice(0, 78).trim() || "Botara message");
    const json = await this.resend(
      input.account,
      "POST",
      "/emails",
      {
        from,
        to: [input.toExternalId],
        subject,
        text,
        html: `<p>${escapeHtml(text).replace(/\n/g, "<br/>")}</p>`,
      },
      // ALWAYS sent - Resend deduplicates retries on this key for 24h.
      { "Idempotency-Key": input.idempotencyKey },
    );
    const id = json.id as string | undefined;
    if (!id) {
      throw new ProviderApiError("Resend send returned no email id", { provider: "resend", retryable: false });
    }
    return { externalMessageId: id, status: "sent" };
  }

  async publish(_input: PublishInput): Promise<{ externalPostId: string }> {
    throw new NotImplementedError("email.publish (email has no post publishing surface)");
  }

  async fetchInsights(): Promise<Record<string, number>> {
    throw new NotImplementedError("email.fetchInsights (Resend delivery stats land in a later phase)");
  }

  // --- receiving ---------------------------------------------------------------------

  /**
   * Fetch the FULL content of a received email. The webhook only carries
   * metadata, so this calls the Receiving API for body/headers and the
   * Attachments API for the attachment list with (temporary!) download URLs.
   */
  async fetchInboundEmail(account: ChannelAccountRef, emailId: string): Promise<InboundEmailContent> {
    const full = await this.resend(account, "GET", `/emails/receiving/${emailId}`);
    const attJson = await this.resend(account, "GET", `/emails/receiving/${emailId}/attachments`);
    const rawAttachments = (attJson.data as Array<Record<string, any>> | undefined)
      ?? (attJson.attachments as Array<Record<string, any>> | undefined)
      ?? [];
    return {
      id: String(full.id ?? emailId),
      from: String(full.from ?? ""),
      to: Array.isArray(full.to) ? full.to.map(String) : [],
      subject: full.subject as string | undefined,
      text: full.text as string | undefined,
      html: full.html as string | undefined,
      headers: (full.headers as Record<string, string> | undefined) ?? {},
      attachments: rawAttachments.map((a) => ({
        id: String(a.id),
        filename: a.filename,
        contentType: a.content_type ?? a.contentType,
        size: a.size,
        downloadUrl: String(a.download_url ?? a.downloadUrl ?? ""),
      })),
    };
  }

  // --- webhooks --------------------------------------------------------------------------

  async parseWebhook(payload: unknown): Promise<InboundEvent[]> {
    const root = payload as { type?: string; created_at?: string; data?: Record<string, any> } | null;
    if (!root?.type || !root.data) return [];
    const data = root.data;
    const receivedAt = root.created_at ?? new Date().toISOString();
    switch (root.type) {
      case "email.received": {
        const attachments: MessageAttachment[] = Array.isArray(data.attachments)
          ? data.attachments.map((a: Record<string, any>) => ({
              id: String(a.id),
              filename: a.filename,
              contentType: a.content_type ?? a.contentType,
              size: a.size,
            }))
          : [];
        return [{
          type: "message.received",
          channel: "email",
          // The route resolves the workspace from the recipient address /
          // receiving domain; the payload itself has no account id.
          accountExternalId: "",
          contactExternalId: String(data.from ?? ""),
          messageExternalId: String(data.email_id ?? data.id ?? ""),
          subject: data.subject,
          attachments,
          // Recipient addresses - the API route routes by their domain
          // (workspace_domains) into the owning workspace's email account.
          recipients: Array.isArray(data.to) ? data.to.map(String) : undefined,
          receivedAt,
        }];
      }
      case "email.delivered":
      case "email.sent":
      case "email.bounced":
      case "email.complained":
      case "email.delivery_delayed": {
        const failed = root.type === "email.bounced" || root.type === "email.complained";
        return [{
          type: "message.status",
          channel: "email",
          messageExternalId: String(data.email_id ?? data.id ?? ""),
          status: failed ? "failed" : root.type === "email.sent" ? "sent" : "delivered",
          receivedAt,
        }];
      }
      default:
        return [];
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
