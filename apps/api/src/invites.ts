import { createHash, randomBytes } from "node:crypto";

/**
 * Invite-by-link tokens (adoption package #9).
 *
 * Hygiene mirrors the API-token design (auth.ts): the raw token is
 * minted here, returned to the creator ONCE, and only its SHA-256 ever
 * reaches the database. The `bti_` prefix keeps invite links visually
 * distinct from `bta_` API tokens - an invite token presented as a
 * Bearer credential simply resolves to nothing.
 *
 * Token state is DERIVED, never stored as a status column: an invite is
 * revoked iff revoked_at is set, expired iff expires_at has passed,
 * exhausted iff a max_uses cap is set and uses_count reached it.
 * `inviteState` is the single classifier the preview and accept routes
 * share, so the two can never disagree about what a link means.
 */

export const INVITE_TOKEN_PREFIX = "bti_";

/** Mint a raw invite token: `bti_` + 256 bits of base64url randomness. */
export function generateInviteToken(): string {
  return INVITE_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** The only persisted form of the token: its SHA-256 hex digest. */
export function hashInviteToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Display fragment stored alongside the hash (not a secret). */
export function inviteDisplayPrefix(raw: string): string {
  return raw.slice(0, INVITE_TOKEN_PREFIX.length + 8);
}

/** The SPA path the raw token completes; the SPA prefixes its own origin. */
export function invitePath(raw: string): string {
  return `/invite/${raw}`;
}

/** Roles an invite may grant. Ownership is NEVER granted by a link. */
export const INVITABLE_ROLES = ["admin", "member", "agent"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export interface InviteStateFacts {
  revokedAt: Date | null;
  expiresAt: Date | null;
  maxUses: number | null;
  usesCount: number;
}

export type InviteState = "valid" | "revoked" | "expired" | "exhausted";

/**
 * Classify an invite right now. Precedence when several conditions
 * hold: revoked > expired > exhausted (the admin's explicit revocation
 * is the most meaningful answer, then the clock, then the counter).
 */
export function inviteState(invite: InviteStateFacts, now = new Date()): InviteState {
  if (invite.revokedAt) return "revoked";
  if (invite.expiresAt && invite.expiresAt.getTime() <= now.getTime()) return "expired";
  if (invite.maxUses !== null && invite.usesCount >= invite.maxUses) return "exhausted";
  return "valid";
}
