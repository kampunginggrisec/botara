import {
  createWebhookReceipt, findChannelAccountByExternal, listWebhookReceipts,
  truncateWebhookPayloadSummary,
  type Database, type WebhookReceiptOutcome,
} from "@botara/db";
import type { InboundEvent } from "@botara/channels";

/**
 * Inbound webhook receipts (Admin → Webhook log).
 *
 * Every provider webhook POST the API handles leaves one receipt row so
 * the platform operator can see - from the panel, not the server
 * journal - what arrived, how it was classified, and what we answered.
 *
 * HARD GUARANTEE: recording is best-effort. `recordWebhookReceipt`
 * swallows every failure (storage down, unresolvable account, bad
 * input) and only logs it server-side: a missing log row is a nuisance,
 * a changed webhook response makes Meta retry-storm the endpoint.
 *
 * Body hygiene: the payload summary is stored ONLY for requests whose
 * signature verified (callers pass `payloadSummary: null` on the
 * rejection paths). Headers, signatures and tokens are never recorded.
 */
export type { WebhookReceiptOutcome };

/** The API view of one receipt (what GET /admin/webhook-log returns). */
export interface WebhookReceiptItem {
  id: string;
  createdAt: string;
  channel: string;
  eventType: string | null;
  outcome: WebhookReceiptOutcome;
  httpStatus: number;
  workspaceId: string | null;
  channelAccountId: string | null;
  payloadSummary: string | null;
  error: string | null;
}

/** What a webhook route reports about one handled POST. */
export interface NewWebhookReceipt {
  channel: string;
  eventType?: string | null;
  outcome: WebhookReceiptOutcome;
  httpStatus: number;
  /** Account external id from the first parsed event, for workspace/account resolution. */
  accountExternalId?: string | null;
  /** Raw body for VERIFIED requests (truncated on store); null/omitted when unverified. */
  payloadSummary?: string | null;
  error?: string | null;
}

/** Write port used by the webhook routes. */
export interface WebhookReceiptRecorder {
  record(input: NewWebhookReceipt): Promise<void>;
}

/**
 * Best-effort recording entry point for the webhook routes: NEVER
 * throws, so a receipt failure can never change the response the
 * provider gets.
 */
export async function recordWebhookReceipt(
  recorder: WebhookReceiptRecorder,
  input: NewWebhookReceipt,
): Promise<void> {
  try {
    await recorder.record(input);
  } catch (err) {
    console.error(
      `[api] webhook receipt recording failed (${input.channel}/${input.outcome}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** First-event summary for a handled payload: principal event type + account external id. */
export function summarizeWebhookEvents(
  events: InboundEvent[],
): { eventType: string | null; accountExternalId: string | null } {
  const first = events[0];
  const withAccount = events.find((e) => "accountExternalId" in e && e.accountExternalId);
  return {
    eventType: first?.type ?? null,
    accountExternalId: withAccount && "accountExternalId" in withAccount
      ? (withAccount.accountExternalId ?? null)
      : null,
  };
}

/** Production recorder over the Drizzle repositories. */
export class DbWebhookReceiptRecorder implements WebhookReceiptRecorder {
  constructor(private readonly getDatabase: () => Database) {}

  async record(input: NewWebhookReceipt): Promise<void> {
    const db = this.getDatabase();
    let workspaceId: string | null = null;
    let channelAccountId: string | null = null;
    if (input.accountExternalId) {
      const account = await findChannelAccountByExternal(db, input.channel, input.accountExternalId);
      if (account) {
        workspaceId = account.workspaceId;
        channelAccountId = account.id;
      }
    }
    await createWebhookReceipt(db, {
      channel: input.channel,
      eventType: input.eventType ?? null,
      outcome: input.outcome,
      httpStatus: input.httpStatus,
      workspaceId,
      channelAccountId,
      payloadSummary: input.payloadSummary ?? null,
      error: input.error ?? null,
    });
  }
}

/** Read side for the admin route (DbAdminStore delegates here). */
export async function listWebhookReceiptItems(
  getDatabase: () => Database,
  filters: { channel?: string; outcome?: string; limit?: number },
): Promise<WebhookReceiptItem[]> {
  const rows = await listWebhookReceipts(getDatabase(), filters);
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    channel: r.channel,
    eventType: r.eventType,
    outcome: r.outcome as WebhookReceiptOutcome,
    httpStatus: r.httpStatus,
    workspaceId: r.workspaceId,
    channelAccountId: r.channelAccountId,
    payloadSummary: r.payloadSummary,
    error: r.error,
  }));
}

/** In-memory recorder for tests: keeps the raw inputs AND the materialized items. */
export class InMemoryWebhookReceiptRecorder implements WebhookReceiptRecorder {
  receipts: WebhookReceiptItem[] = [];
  private seq = 0;

  async record(input: NewWebhookReceipt): Promise<void> {
    this.seq += 1;
    this.receipts.unshift({
      id: `receipt-${this.seq}`,
      createdAt: new Date().toISOString(),
      channel: input.channel,
      eventType: input.eventType ?? null,
      outcome: input.outcome,
      httpStatus: input.httpStatus,
      workspaceId: null,
      channelAccountId: null,
      payloadSummary: input.payloadSummary == null
        ? null
        : truncateWebhookPayloadSummary(input.payloadSummary),
      error: input.error ?? null,
    });
  }

  /** Filtered view, newest first - mirrors the repository list semantics. */
  list(filters: { channel?: string; outcome?: string; limit?: number }): WebhookReceiptItem[] {
    const limit = Math.min(200, Math.max(1, Math.floor(filters.limit ?? 50)));
    return this.receipts
      .filter((r) => !filters.channel || r.channel === filters.channel)
      .filter((r) => !filters.outcome || r.outcome === filters.outcome)
      .slice(0, limit);
  }
}
