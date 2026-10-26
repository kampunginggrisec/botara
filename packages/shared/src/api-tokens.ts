/**
 * API token scopes (adoption package #5).
 *
 * Botara's personal API tokens (`bta_...`) were originally all-or-nothing:
 * a token authenticated as its user, everywhere. Scoped tokens narrow
 * that: a token may be BOUND to one workspace and/or restricted to a set
 * of scopes, and may carry an expiry. Legacy tokens (workspace_id NULL,
 * scopes NULL) keep the original behavior bit-for-bit.
 *
 * This module is the single source of truth for the scope taxonomy -
 * the API enforces it, the web Settings UI renders it, and docs mirror
 * it (docs/api-tokens.md). Keep the set small and closed: adding a
 * resource is a deliberate product decision, not a stringly-typed
 * accident.
 */

/** Workspace resource families a token scope can name. */
export const API_TOKEN_RESOURCES = [
  "contacts",
  "conversations",
  "broadcasts",
  "flows",
  "sequences",
  "templates",
  "channels",
  "kb",
  "posts",
  "settings",
] as const;

export type ApiTokenResource = (typeof API_TOKEN_RESOURCES)[number];

export type ApiTokenScopeLevel = "read" | "write";

/**
 * One granted scope: `*` (full access), or `<resource>:read` /
 * `<resource>:write`. A `write` grant implies the matching `read`.
 */
export type ApiTokenScope = "*" | `${ApiTokenResource}:${ApiTokenScopeLevel}`;

/** Every valid scope string, `*` first - the UI renders pickers from this. */
export const API_TOKEN_SCOPES: readonly ApiTokenScope[] = [
  "*",
  ...API_TOKEN_RESOURCES.flatMap((resource): ApiTokenScope[] => [
    `${resource}:read`,
    `${resource}:write`,
  ]),
];

const SCOPE_SET: ReadonlySet<string> = new Set(API_TOKEN_SCOPES);

/** True when `value` is exactly one valid scope string. */
export function isApiTokenScope(value: unknown): value is ApiTokenScope {
  return typeof value === "string" && SCOPE_SET.has(value);
}

/**
 * Validate an untrusted scopes payload (request body, jsonb column).
 * Returns the deduplicated scope list, or null when the value is not an
 * array of valid scope strings. An empty array is valid - it grants
 * nothing (the token authenticates but every scoped route refuses).
 */
export function parseApiTokenScopes(value: unknown): ApiTokenScope[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<ApiTokenScope>();
  for (const entry of value) {
    if (!isApiTokenScope(entry)) return null;
    seen.add(entry);
  }
  return [...seen];
}

/**
 * Does a grant list cover a required scope?
 * - `*` covers everything.
 * - An exact match covers.
 * - `<resource>:write` covers `<resource>:read`.
 * Nothing else implies anything: `contacts:write` does NOT cover
 * `conversations:read`, and `*` is the only cross-resource grant.
 */
export function scopeCovers(granted: readonly string[], required: ApiTokenScope): boolean {
  for (const g of granted) {
    if (g === "*" || g === required) return true;
    if (required.endsWith(":read") && g === `${required.slice(0, -":read".length)}:write`) {
      return true;
    }
  }
  return false;
}

/** True when a grant list covers at least one `:read` scope (or `*`). */
export function grantsAnyRead(granted: readonly string[]): boolean {
  return granted.some((g) => g === "*" || g.endsWith(":read") || g.endsWith(":write"));
}

/**
 * A token is RESTRICTED when it carries a workspace binding or a scope
 * list (either may be present alone). Restricted tokens may only call
 * workspace resource routes - never auth/admin/webhook surfaces, even
 * for routes their scopes would otherwise cover. An expiry alone does
 * NOT restrict (it is orthogonal: checked at resolution time).
 */
export function tokenIsRestricted(grant: {
  workspaceId: string | null;
  scopes: readonly string[] | null;
}): boolean {
  return grant.workspaceId !== null || grant.scopes !== null;
}
