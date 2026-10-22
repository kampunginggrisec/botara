import { randomBytes } from "node:crypto";
import { AppError } from "@botara/shared";

/**
 * Growth tools (adopted-features package) - pure helpers behind the
 * /growth-links API and the public /r/:slug redirect.
 *
 * Tracking design: wa.me links cannot carry a referral parameter, so EVERY
 * kind routes through Botara's own short link first ({base}/r/:slug): the
 * redirect counts the click, then 302s to the channel target. Channels
 * that DO carry a ref (Messenger ?ref=, Telegram ?start=) get the slug
 * embedded so the inbound dispatcher can attribute the conversion;
 * Instagram (ig.me has no ref support) is counting-only, and WhatsApp
 * conversions attribute through the click-to-WhatsApp referral object /
 * the single-active-link rule in the dispatcher (documented there).
 */

/** Unambiguous slug alphabet (no 0/O/1/l/I confusion). */
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateGrowthSlug(length = 8): string {
  const bytes = randomBytes(length);
  let slug = "";
  for (let i = 0; i < length; i++) {
    slug += SLUG_ALPHABET[bytes[i]! % SLUG_ALPHABET.length];
  }
  return slug;
}

export interface GrowthTargetInput {
  kind: string;
  slug: string;
  prefilledText?: string | null;
  /** Channel-specific target the account row cannot supply (WA number, TG/IG username). */
  targetRef?: string | null;
  /** Full destination URL (webchat widget page). */
  targetUrl?: string | null;
  account: {
    externalId: string;
    displayName?: string | null;
  };
}

/** "@username" display name -> "username" (Telegram/IG connects store it that way). */
function usernameOf(input: GrowthTargetInput): string | null {
  if (input.targetRef?.trim()) return input.targetRef.trim().replace(/^@/, "");
  const display = input.account.displayName?.trim() ?? "";
  if (display.startsWith("@")) return display.slice(1);
  return null;
}

const digitsOnly = (value: string): string => value.replace(/[^\d]/g, "");

/**
 * Build the channel destination for a growth link. Throws a typed
 * VALIDATION error when the target cannot be determined - creating a link
 * that redirects nowhere must fail loudly at creation time, not at click
 * time.
 */
export function buildGrowthTarget(input: GrowthTargetInput): string {
  const text = input.prefilledText?.trim();
  const textParam = text ? `?text=${encodeURIComponent(text)}` : "";
  switch (input.kind) {
    case "whatsapp": {
      const number = input.targetRef ? digitsOnly(input.targetRef) : "";
      if (!number) {
        throw new AppError(
          "VALIDATION",
          "WhatsApp growth links need the destination phone number (targetRef, international format) - the channel account stores Meta's phone-number id, not the number itself.",
          { status: 400 },
        );
      }
      return `https://wa.me/${number}${textParam}`;
    }
    case "messenger": {
      const page = input.targetRef?.trim() || input.account.externalId;
      return `https://m.me/${page}?ref=${encodeURIComponent(input.slug)}`;
    }
    case "telegram": {
      const username = usernameOf(input);
      if (!username) {
        throw new AppError(
          "VALIDATION",
          "Telegram growth links need the bot username (targetRef) when the account has no @username display name.",
          { status: 400 },
        );
      }
      return `https://t.me/${username}?start=${encodeURIComponent(input.slug)}`;
    }
    case "instagram": {
      const username = usernameOf(input);
      if (!username) {
        throw new AppError(
          "VALIDATION",
          "Instagram growth links need the account username (targetRef) when the account has no @username display name.",
          { status: 400 },
        );
      }
      // ig.me deep links support no ref parameter - click counting only.
      return `https://ig.me/m/${username}`;
    }
    case "webchat": {
      const base = input.targetUrl?.trim();
      if (!base) {
        throw new AppError(
          "VALIDATION",
          "Webchat growth links need targetUrl - the page where the widget is embedded.",
          { status: 400 },
        );
      }
      const sep = base.includes("?") ? "&" : "?";
      return `${base}${sep}ref=${encodeURIComponent(input.slug)}`;
    }
    default:
      throw new AppError(
        "VALIDATION",
        `Growth links are not supported for channel "${input.kind}".`,
        { status: 400 },
      );
  }
}

/** The public short URL for a link, from the deployment's public base or the request origin. */
export function growthShortUrl(base: string, slug: string): string {
  return `${base.replace(/\/$/, "")}/r/${slug}`;
}
