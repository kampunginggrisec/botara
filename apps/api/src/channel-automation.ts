import { AppError } from "@botara/shared";
import { getChannelAccount, type Database } from "@botara/db";
import type {
  ChannelAccountRef, ChannelAdapter, ChannelKey, MessengerProfileInput, PersistentMenuItem, WelcomeMessageFlow,
} from "@botara/channels";

/**
 * Instagram automation: welcome message flows (IG-1) and the messaging
 * profile (IG-2 - persistent menu, ice breakers).
 *
 * Both are provider-side resources an operator manages per account, so the
 * shape of the module is: (a) validators that encode Meta's limits, and
 * (b) the port the API routes call. The actual Graph calls live in the
 * channel adapters, which already know which host and token to use - this
 * module must never re-derive that (Instagram alone has two hosts).
 *
 * Why validate at all: Meta's own rejections here are opaque ("(#100)
 * Invalid parameter") and arrive AFTER the operator filled a form. Every
 * limit below is a documented Meta limit, and each message names the limit
 * so the panel can show it verbatim.
 */

/** Listing is bounded: a big ad account can hold many flows. */
export const MAX_WELCOME_FLOW_PAGES = 5;

/** Meta's documented ceilings for these resources. */
export const LIMITS = {
  flowName: 100,
  messageText: 640,
  quickReplies: 11,
  quickReplyTitle: 20,
  menuItems: 3,
  menuTitle: 30,
  iceBreakers: 4,
  iceBreakerQuestion: 80,
} as const;

function invalid(message: string): never {
  throw new AppError("VALIDATION", message, { status: 400 });
}

export function validateFlowName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) invalid("A welcome flow needs a name.");
  if (trimmed.length > LIMITS.flowName) {
    invalid(`Flow name is ${trimmed.length} characters; the limit is ${LIMITS.flowName}.`);
  }
  return trimmed;
}

/**
 * Validate and normalize a welcome-flow body.
 *
 * The provider shape is an array of `{ message: { text, quick_replies? } }`.
 * It is rebuilt key-by-key rather than passed through: an unknown key sent
 * to Meta is either ignored (confusing) or rejected (worse), and the
 * editor only ever produces this subset.
 */
export function validateWelcomeFlow(flow: unknown): unknown[] {
  if (!Array.isArray(flow) || flow.length === 0) {
    invalid("A welcome flow needs at least one message.");
  }
  return (flow as Array<Record<string, unknown>>).map((entry, index) => {
    if (!entry || typeof entry !== "object") invalid(`Flow message ${index + 1} must be an object.`);
    const message = entry.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") {
      invalid(`Flow message ${index + 1} must have a "message" object.`);
    }
    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (text.length === 0) invalid(`Flow message ${index + 1} needs a non-empty text.`);
    if (text.length > LIMITS.messageText) {
      invalid(`Flow message ${index + 1} is ${text.length} characters; the limit is ${LIMITS.messageText}.`);
    }
    const normalized: Record<string, unknown> = { message: { text } };

    if (message.quick_replies !== undefined) {
      const replies = message.quick_replies;
      if (!Array.isArray(replies) || replies.length === 0) {
        invalid(`Flow message ${index + 1}: quick_replies must be a non-empty array when present.`);
      }
      if (replies.length > LIMITS.quickReplies) {
        invalid(`Flow message ${index + 1} has ${replies.length} quick replies; the limit is ${LIMITS.quickReplies}.`);
      }
      const cleaned = (replies as Array<Record<string, unknown>>).map((reply, replyIndex) => {
        const title = typeof reply.title === "string" ? reply.title.trim() : "";
        if (title.length === 0) invalid(`Flow message ${index + 1}, quick reply ${replyIndex + 1} needs a title.`);
        if (title.length > LIMITS.quickReplyTitle) {
          invalid(
            `Quick reply title "${title}" is ${title.length} characters; the limit is ${LIMITS.quickReplyTitle}.`,
          );
        }
        const payload = typeof reply.payload === "string" ? reply.payload.trim() : "";
        if (payload.length === 0) {
          invalid(`Quick reply "${title}" needs a payload: it is what arrives as a postback.`);
        }
        return { content_type: "text", title, payload };
      });
      (normalized.message as Record<string, unknown>).quick_replies = cleaned;
    }
    return normalized;
  });
}

/**
 * Validate a messaging-profile write.
 *
 * All three fields are optional so a caller can update one without
 * clobbering the others - the adapter only sends what is present, because
 * `messenger_profile` REPLACES the fields it receives.
 */
export function validateProfileInput(input: {
  persistentMenu?: { items?: unknown; locale?: string; composerInputDisabled?: boolean };
  iceBreakers?: unknown;
  getStarted?: string;
}): MessengerProfileInput {
  const profile: MessengerProfileInput = {};

  if (input.persistentMenu) {
    const items = input.persistentMenu.items;
    if (!Array.isArray(items) || items.length === 0) {
      invalid("A persistent menu needs at least one item.");
    }
    if (items.length > LIMITS.menuItems) {
      invalid(`A persistent menu allows at most ${LIMITS.menuItems} items.`);
    }
    const cleaned: PersistentMenuItem[] = (items as Array<Record<string, unknown>>).map((item, index) => {
      const type = String(item.type ?? "postback").toLowerCase();
      if (type !== "postback" && type !== "web_url") {
        invalid(`Menu item ${index + 1}: type must be "postback" or "web_url".`);
      }
      const title = typeof item.title === "string" ? item.title.trim() : "";
      if (title.length === 0) invalid(`Menu item ${index + 1} needs a title.`);
      if (title.length > LIMITS.menuTitle) {
        invalid(`Menu title "${title}" is ${title.length} characters; the limit is ${LIMITS.menuTitle}.`);
      }
      if (type === "web_url") {
        const url = typeof item.url === "string" ? item.url.trim() : "";
        if (!/^https?:\/\//i.test(url)) invalid(`Menu item "${title}" needs an http(s) url.`);
        return { type: "web_url", title, url };
      }
      const payload = typeof item.payload === "string" ? item.payload.trim() : "";
      if (payload.length === 0) {
        invalid(`Menu item "${title}" needs a payload: it is what arrives as a postback.`);
      }
      return { type: "postback", title, payload };
    });
    profile.persistentMenu = {
      items: cleaned,
      ...(input.persistentMenu.locale ? { locale: input.persistentMenu.locale } : {}),
      ...(input.persistentMenu.composerInputDisabled !== undefined
        ? { composerInputDisabled: input.persistentMenu.composerInputDisabled }
        : {}),
    };
  }

  if (input.iceBreakers !== undefined) {
    const breaks = input.iceBreakers;
    if (!Array.isArray(breaks) || breaks.length === 0) {
      invalid("Ice breakers must be a non-empty array when present.");
    }
    if (breaks.length > LIMITS.iceBreakers) {
      invalid(`At most ${LIMITS.iceBreakers} ice breakers are allowed.`);
    }
    profile.iceBreakers = (breaks as Array<Record<string, unknown>>).map((entry, index) => {
      const question = typeof entry.question === "string" ? entry.question.trim() : "";
      if (question.length === 0) invalid(`Ice breaker ${index + 1} needs a question.`);
      if (question.length > LIMITS.iceBreakerQuestion) {
        invalid(
          `Ice breaker question is ${question.length} characters; the limit is ${LIMITS.iceBreakerQuestion}.`,
        );
      }
      const payload = typeof entry.payload === "string" ? entry.payload.trim() : "";
      if (payload.length === 0) invalid(`Ice breaker "${question}" needs a payload.`);
      return { question, payload };
    });
  }

  if (input.getStarted !== undefined) {
    const payload = input.getStarted.trim();
    if (payload.length === 0) invalid("getStarted must be a non-empty payload when present.");
    profile.getStarted = payload;
  }

  if (!profile.persistentMenu && !profile.iceBreakers && !profile.getStarted) {
    invalid("Nothing to update: pass persistentMenu, iceBreakers or getStarted.");
  }
  return profile;
}

/** Profile fields a caller may read or delete. */
export const PROFILE_FIELDS = ["persistent_menu", "ice_breakers", "get_started"] as const;

export function validateProfileFields(fields: unknown): string[] {
  if (!Array.isArray(fields) || fields.length === 0) {
    invalid(`fields must be a non-empty array of ${PROFILE_FIELDS.join(", ")}.`);
  }
  const cleaned = [...new Set((fields as unknown[]).map((f) => String(f)))];
  for (const field of cleaned) {
    if (!(PROFILE_FIELDS as readonly string[]).includes(field)) {
      invalid(`Unknown profile field "${field}": expected ${PROFILE_FIELDS.join(", ")}.`);
    }
  }
  return cleaned;
}

/**
 * Resolve the adapter for one automation call.
 *
 * Two rules a route must never skip live here so they cannot be forgotten:
 * the account must belong to the CALLER's workspace (a foreign id is
 * indistinguishable from a missing one), and the channel must actually have
 * the surface being addressed. `getAdapter` is injected so the check is
 * testable without the registry.
 */
export async function resolveAutomationAdapter(
  db: Database,
  workspaceId: string,
  accountId: string,
  allowed: ChannelKey[],
  getAdapter: (key: ChannelKey) => ChannelAdapter,
): Promise<{ account: ChannelAccountRef; adapter: ChannelAdapter }> {
  const account = await getChannelAccount(db, workspaceId, accountId);
  if (!account) throw new AppError("NOT_FOUND", "Channel account not found.", { status: 404 });
  if (!allowed.includes(account.channel as ChannelKey)) {
    throw new AppError(
      "VALIDATION",
      `This action is only available for ${allowed.join(" / ")} accounts (this one is ${account.channel}).`,
      { status: 400 },
    );
  }
  // The DB row keeps nullable columns; the adapter contract wants "absent",
  // not null (a null authMode reads as an unknown mode instead of the
  // documented default).
  const ref: ChannelAccountRef = {
    id: account.id,
    externalId: account.externalId,
    ...(account.authMode ? { authMode: account.authMode } : {}),
    ...(account.tokenVaultRef ? { tokenVaultRef: account.tokenVaultRef } : {}),
  };
  return { account: ref, adapter: getAdapter(account.channel as ChannelKey) };
}

/**
 * The port the routes call. Every method takes the workspace + account and
 * resolves the adapter itself, so the route never needs to know which
 * channel family it is talking to (or which Graph host that channel uses).
 */
export interface ChannelAutomationPort {
  welcomeFlows: {
    list(input: { workspaceId: string; accountId: string }): Promise<WelcomeMessageFlow[]>;
    get(input: { workspaceId: string; accountId: string; flowId: string }): Promise<WelcomeMessageFlow | null>;
    create(input: {
      workspaceId: string;
      accountId: string;
      name: string;
      flow: unknown[];
    }): Promise<{ id: string }>;
    update(input: {
      workspaceId: string;
      accountId: string;
      flowId: string;
      name: string;
      flow: unknown[];
    }): Promise<{ id: string }>;
    remove(input: { workspaceId: string; accountId: string; flowId: string }): Promise<void>;
  };
  profile: {
    get(input: { workspaceId: string; accountId: string; fields: string[] }): Promise<Record<string, unknown>>;
    set(input: { workspaceId: string; accountId: string; profile: MessengerProfileInput }): Promise<void>;
    remove(input: { workspaceId: string; accountId: string; fields: string[] }): Promise<void>;
  };
}
