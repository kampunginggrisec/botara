import {
  AppError, grantsAnyRead, scopeCovers, tokenIsRestricted,
  type ApiTokenResource, type ApiTokenScope,
} from "@botara/shared";
import type { ApiTokenGrant } from "./auth";

/**
 * Route -> scope mapping for scoped API tokens (adoption package #5).
 *
 * Every route family behind the workspace auth middleware (the prefixes
 * below - app.ts registers its auth middleware from THIS list, so the
 * map and the middleware cannot drift apart) maps to exactly one scope
 * resource from the taxonomy in @botara/shared. The enumeration test
 * (route-scopes.test.ts) walks app.routes and fails if a workspace
 * route ever lands outside this map.
 *
 * Level rule: GET/HEAD are reads, everything else is a write - with two
 * deliberate exceptions:
 *   - GET /channels/:channel/oauth/start initiates a connect flow (a
 *     side effect wearing a GET), so it requires channels:write.
 *   - GET /stats/overview is a cross-resource aggregate; it requires
 *     ANY read-capable grant ("any-read") instead of one resource.
 *
 * Anything not mapped here (auth routes, workspace collection CRUD,
 * admin, webhooks, public surfaces) is NOT a workspace resource route:
 * restricted tokens are refused outright, however broad their scopes.
 */
export const WORKSPACE_ROUTE_PREFIXES = [
  "/conversations", "/contacts", "/segments", "/templates", "/broadcasts",
  "/channels", "/posts", "/sequences", "/workspaces", "/kb", "/flows",
  "/stats", "/growth-links", "/catalog-products", "/moderation", "/saved-replies",
] as const;

/** Prefix families -> scope resource. `/workspaces/*` and `/stats` are special-cased below. */
const FAMILY_RESOURCES: ReadonlyArray<readonly [prefix: string, resource: ApiTokenResource]> = [
  ["/conversations", "conversations"],
  ["/saved-replies", "conversations"], // inbox quick replies live in the composer
  ["/contacts", "contacts"],
  ["/segments", "contacts"], // segments are derived contact groupings
  ["/broadcasts", "broadcasts"],
  ["/flows", "flows"],
  ["/growth-links", "flows"], // growth links are flow entry points
  ["/sequences", "sequences"],
  ["/templates", "templates"],
  ["/channels", "channels"],
  ["/catalog-products", "channels"], // Meta catalog data belongs to the channel
  ["/kb", "kb"],
  ["/posts", "posts"],
  ["/moderation", "settings"], // operator utility, no resource of its own
];

export type RouteScopeRequirement =
  | { kind: "scope"; scope: ApiTokenScope }
  | { kind: "any-read" }
  | { kind: "none" };

const scope = (s: ApiTokenScope): RouteScopeRequirement => ({ kind: "scope", scope: s });

/** The scope a route demands from a scoped token. Pure; method + path only. */
export function requiredScopeForRoute(method: string, path: string): RouteScopeRequirement {
  const level = method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD" ? "read" : "write";
  // The workspace COLLECTION (list/create) is account surface, not a
  // workspace resource - restricted tokens stop there. Everything under
  // /workspaces/:id (rename, members) is workspace administration.
  if (path === "/workspaces") return { kind: "none" };
  if (path.startsWith("/workspaces/")) return scope(`settings:${level}`);
  // OAuth connect starts are GET navigations with side effects.
  if (/^\/channels\/[^/]+\/oauth\/start$/.test(path)) return scope("channels:write");
  // Cross-resource dashboard aggregate: any read-capable grant suffices.
  if (path === "/stats" || path.startsWith("/stats/")) return { kind: "any-read" };
  for (const [prefix, resource] of FAMILY_RESOURCES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return scope(`${resource}:${level}`);
  }
  return { kind: "none" };
}

/**
 * Enforce a token grant against the route being called. No-ops for
 * legacy tokens (unrestricted) - and for session auth, which never
 * reaches this function (sessions carry no grant). Throws FORBIDDEN
 * (403) when a restricted token steps outside workspace resource
 * routes or outside its granted scopes.
 */
export function assertApiTokenRouteAccess(grant: ApiTokenGrant, method: string, path: string): void {
  if (!tokenIsRestricted(grant)) return;
  const requirement = requiredScopeForRoute(method, path);
  if (requirement.kind === "none") {
    throw new AppError(
      "FORBIDDEN",
      "This API token is restricted to workspace resources and cannot call this route.",
      { status: 403, details: { reason: "route_not_a_workspace_resource" } },
    );
  }
  // A workspace-bound token without a scope list has full access inside
  // its workspace's resource routes.
  if (grant.scopes === null) return;
  if (requirement.kind === "any-read") {
    if (!grantsAnyRead(grant.scopes)) {
      throw new AppError(
        "FORBIDDEN",
        "This API token lacks any read scope required for this route.",
        { status: 403, details: { requiredScope: "any:read", grantedScopes: grant.scopes } },
      );
    }
    return;
  }
  if (!scopeCovers(grant.scopes, requirement.scope)) {
    throw new AppError(
      "FORBIDDEN",
      `This API token lacks the required scope: ${requirement.scope}.`,
      { status: 403, details: { requiredScope: requirement.scope, grantedScopes: grant.scopes } },
    );
  }
}
