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

/** Channels with a Meta-style user-message window for free-form replies. */
const WINDOW_ENFORCED_CHANNELS = new Set(["whatsapp", "instagram", "messenger"]);

export function channelEnforcesWindow(channel: string): boolean {
  return WINDOW_ENFORCED_CHANNELS.has(channel);
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
    input.lastUserMessageAt, input.now, input.windowHours ?? WHATSAPP_FREE_FORM_WINDOW_HOURS,
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
