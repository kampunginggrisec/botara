/**
 * API token scopes for the Settings UI (adoption #5).
 *
 * The canonical taxonomy lives in @botara/shared (api-tokens.ts); the
 * web bundle keeps this local mirror - same convention as variables.ts -
 * so the resource list below must stay in sync with API_TOKEN_RESOURCES
 * there. The API re-validates every scope server-side, so drift here
 * can only ever produce a 400, never a wider grant.
 */
export const TOKEN_RESOURCES = [
  "contacts",
  "conversations",
  "broadcasts",
  "flows",
  "sequences",
  "deals",
  "templates",
  "channels",
  "kb",
  "posts",
  "settings",
] as const;

export type TokenResource = (typeof TOKEN_RESOURCES)[number];

/** Per-resource checkbox state in the creation form. */
export type ScopePicks = Record<TokenResource, { read: boolean; write: boolean }>;

export function emptyScopePicks(): ScopePicks {
  return Object.fromEntries(
    TOKEN_RESOURCES.map((r) => [r, { read: false, write: false }]),
  ) as ScopePicks;
}

/**
 * The token creation form's factory defaults (package #7 rider): after
 * a successful create the form returns to EXACTLY this state - name
 * empty, no workspace binding ("All workspaces"), Full access on, no
 * per-resource picks, expiry Never (""). Before this, only the name
 * was cleared and the previous token's workspace/scope/expiry picks
 * silently carried into the next creation. Fresh objects on every
 * call: the picks map must never be shared between resets.
 */
export function defaultTokenFormState(): {
  name: string;
  workspaceId: string;
  fullAccess: boolean;
  picks: ScopePicks;
  expiryDays: string;
} {
  return {
    name: "",
    workspaceId: "",
    fullAccess: true,
    picks: emptyScopePicks(),
    expiryDays: "",
  };
}

/** How many resources have any pick - the form refuses an all-empty scope list. */
export function countPickedResources(picks: ScopePicks): number {
  return TOKEN_RESOURCES.filter((r) => picks[r].read || picks[r].write).length;
}

/**
 * Picks -> wire scopes. `write` implies `read` server-side, so a
 * write pick emits only the `:write` scope (the grant stays minimal
 * and the stored list reads exactly like the form).
 */
export function picksToScopes(picks: ScopePicks): string[] {
  const scopes: string[] = [];
  for (const resource of TOKEN_RESOURCES) {
    if (picks[resource].write) scopes.push(`${resource}:write`);
    else if (picks[resource].read) scopes.push(`${resource}:read`);
  }
  return scopes;
}

/** Split a scope string for display: "*" | resource + level. */
export function scopeParts(scope: string): { resource: string; level: "all" | "read" | "write" } {
  if (scope === "*") return { resource: "*", level: "all" };
  const [resource = scope, level = "read"] = scope.split(":");
  return { resource, level: level === "write" ? "write" : "read" };
}

/** True when the token's expiry is in the past (it now answers 401 TOKEN_EXPIRED). */
export function tokenIsExpired(expiresAt: string | null, now: Date = new Date()): boolean {
  return expiresAt !== null && new Date(expiresAt).getTime() <= now.getTime();
}

/** ISO timestamp `days` from now, for the expiry select (30/90/365). */
export function expiryIsoFromDays(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() + days * 24 * 3600 * 1000).toISOString();
}
