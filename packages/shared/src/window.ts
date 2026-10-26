import { AppError } from "./errors";
import { isWithinWindow } from "./utils";

/**
 * Messaging-window policy (Fase 1).
 *
 * Meta channels (WhatsApp, Instagram, Messenger) only allow free-form replies
 * inside a window opened by the user's last message (24h standard window).
 * Outside the window only pre-approved template messages may be sent.
 * This module is the pure decision function; API/worker call sites enforce it
 * (fail closed: when in doubt, free-form is NOT allowed).
 */

export const WHATSAPP_FREE_FORM_WINDOW_HOURS = 24;

export type ReplyKind = "free_form" | "template";

export interface ReplyWindowDecision {
  allowed: boolean;
  kind: ReplyKind;
  /** true when the channel enforces a user-message window at all. */
  windowEnforced: boolean;
  windowOpen: boolean;
  reason: string;
}

/** Channels with a user-message window for free-form replies. */
const WINDOW_ENFORCED_CHANNELS = new Set(["whatsapp", "instagram", "messenger", "tiktok"]);

/**
 * Per-channel window length in hours when it differs from the Meta 24h
 * default. TikTok Business Messaging allows replies for 48 hours after the
 * customer's last message (TikTok API for Business v1.3 rules) - and unlike
 * Meta there is NO template/utility escape hatch outside the window.
 */
const CHANNEL_WINDOW_HOURS: Record<string, number> = { tiktok: 48 };

export function channelEnforcesWindow(channel: string): boolean {
  return WINDOW_ENFORCED_CHANNELS.has(channel);
}

/** The reply-window length (hours) a channel enforces by default. */
export function channelWindowHours(channel: string): number {
  return CHANNEL_WINDOW_HOURS[channel] ?? WHATSAPP_FREE_FORM_WINDOW_HOURS;
}

/**
 * Decide whether a reply of `kind` may be sent on `channel` given when the
 * user last messaged. Pure: `now` is injected so tests are deterministic.
 */
export function evaluateReplyWindow(input: {
  channel: string;
  kind: ReplyKind;
  lastUserMessageAt: Date | null;
  now: Date;
  windowHours?: number;
}): ReplyWindowDecision {
  const enforced = channelEnforcesWindow(input.channel);
  if (!enforced) {
    return {
      allowed: true, kind: input.kind, windowEnforced: false, windowOpen: true,
      reason: `${input.channel} does not enforce a messaging window`,
    };
  }
  const windowOpen = isWithinWindow(
    input.lastUserMessageAt, input.now, input.windowHours ?? channelWindowHours(input.channel),
  );
  if (input.kind === "template") {
    return {
      allowed: true, kind: input.kind, windowEnforced: true, windowOpen,
      reason: windowOpen
        ? "template replies are allowed inside the window"
        : "template replies are allowed outside the window (that is what templates are for)",
    };
  }
  return {
    allowed: windowOpen, kind: input.kind, windowEnforced: true, windowOpen,
    reason: windowOpen
      ? "free-form reply inside the messaging window"
      : "free-form reply rejected: messaging window is closed (fail closed)",
  };
}

/** Typed error raised when a free-form reply is attempted outside the window. */
export class MessagingWindowClosedError extends AppError {
  constructor(channel: string) {
    super(
      "MESSAGING_WINDOW_CLOSED",
      `Cannot send a free-form ${channel} reply: the messaging window is closed. Send an approved template instead.`,
      { status: 422, details: { channel } },
    );
    this.name = "MessagingWindowClosedError";
  }
}

/**
 * Count the business (outbound) messages sent SINCE the customer's last
 * inbound message, over a conversation's rows in chronological order.
 * TikTok Business Messaging caps this at 10 per reply window: the business
 * may send at most 10 consecutive messages before the customer speaks
 * again. Pure helper - the API reply route and the worker send processor
 * both count through it so the rule can never drift between call sites.
 *
 * Internal notes (kind "note", package #2) are TRANSPARENT to the count:
 * they never reach the customer, so they neither increment the counter
 * nor reset it - the walk simply steps over them. Rows without a `kind`
 * (legacy rows, other callers' projections) count as messages.
 */
export function countConsecutiveOutbound(rows: Array<{ direction: string; kind?: string }>): number {
  let count = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.kind === "note") continue;
    if (rows[i]!.direction !== "out") break;
    count++;
  }
  return count;
}

/** Typed error raised when a channel's consecutive-outbound cap is hit. */
export class ConsecutiveSendCapError extends AppError {
  constructor(channel: string, cap: number, consecutive: number) {
    super(
      "CONSECUTIVE_SEND_CAP",
      `Cannot send on ${channel}: ${consecutive} consecutive business messages already sent since the customer's last message (provider cap: ${cap}). Wait for the customer to reply.`,
      { status: 422, details: { channel, cap, consecutive } },
    );
    this.name = "ConsecutiveSendCapError";
  }
}
