import { describe, expect, test } from "bun:test";
import { AppError } from "@botara/shared";
import { createApp } from "./app";
import { testDeps } from "./test-helpers";
import {
  WORKSPACE_ROUTE_PREFIXES, assertApiTokenRouteAccess, requiredScopeForRoute,
} from "./route-scopes";
import type { ApiTokenGrant } from "./auth";

/**
 * Route -> scope map guard (adoption #5). Two layers:
 *  1. Unit expectations for the mapping rules + the enforcer.
 *  2. An enumeration over app.routes (same technique as the parity
 *     guard): every route under a workspace prefix MUST map to a scope
 *     requirement, so a future route family can never silently fall
 *     outside scoped-token enforcement. The only exceptions are the
 *     workspace collection routes, listed explicitly.
 */

const grant = (over: Partial<ApiTokenGrant> = {}): ApiTokenGrant => ({
  tokenId: "tok1", workspaceId: null, scopes: null, expiresAt: null, ...over,
});

describe("requiredScopeForRoute", () => {
  test("families map to their resource; GET reads, mutations write", () => {
    expect(requiredScopeForRoute("GET", "/contacts")).toEqual({ kind: "scope", scope: "contacts:read" });
    expect(requiredScopeForRoute("POST", "/contacts")).toEqual({ kind: "scope", scope: "contacts:write" });
    expect(requiredScopeForRoute("GET", "/contacts/abc/export")).toEqual({ kind: "scope", scope: "contacts:read" });
    expect(requiredScopeForRoute("GET", "/conversations/abc/messages")).toEqual({ kind: "scope", scope: "conversations:read" });
    expect(requiredScopeForRoute("POST", "/conversations/abc/reply")).toEqual({ kind: "scope", scope: "conversations:write" });
    expect(requiredScopeForRoute("GET", "/saved-replies")).toEqual({ kind: "scope", scope: "conversations:read" });
    expect(requiredScopeForRoute("GET", "/segments")).toEqual({ kind: "scope", scope: "contacts:read" });
    expect(requiredScopeForRoute("POST", "/broadcasts")).toEqual({ kind: "scope", scope: "broadcasts:write" });
    expect(requiredScopeForRoute("GET", "/flows")).toEqual({ kind: "scope", scope: "flows:read" });
    expect(requiredScopeForRoute("GET", "/growth-links")).toEqual({ kind: "scope", scope: "flows:read" });
    expect(requiredScopeForRoute("GET", "/sequences")).toEqual({ kind: "scope", scope: "sequences:read" });
    expect(requiredScopeForRoute("PATCH", "/templates/abc/category")).toEqual({ kind: "scope", scope: "templates:write" });
    expect(requiredScopeForRoute("GET", "/channels/accounts")).toEqual({ kind: "scope", scope: "channels:read" });
    expect(requiredScopeForRoute("GET", "/catalog-products")).toEqual({ kind: "scope", scope: "channels:read" });
    expect(requiredScopeForRoute("GET", "/kb/documents")).toEqual({ kind: "scope", scope: "kb:read" });
    expect(requiredScopeForRoute("POST", "/posts")).toEqual({ kind: "scope", scope: "posts:write" });
    expect(requiredScopeForRoute("POST", "/moderation/check")).toEqual({ kind: "scope", scope: "settings:write" });
  });

  test("workspace administration maps to settings; the collection is not a resource route", () => {
    expect(requiredScopeForRoute("GET", "/workspaces")).toEqual({ kind: "none" });
    expect(requiredScopeForRoute("POST", "/workspaces")).toEqual({ kind: "none" });
    expect(requiredScopeForRoute("GET", "/workspaces/ws1/members")).toEqual({ kind: "scope", scope: "settings:read" });
    expect(requiredScopeForRoute("PATCH", "/workspaces/ws1")).toEqual({ kind: "scope", scope: "settings:write" });
    expect(requiredScopeForRoute("DELETE", "/workspaces/ws1/members/u2")).toEqual({ kind: "scope", scope: "settings:write" });
  });

  test("oauth start (GET) requires channels:write; stats overview is any-read", () => {
    expect(requiredScopeForRoute("GET", "/channels/whatsapp/oauth/start")).toEqual({ kind: "scope", scope: "channels:write" });
    expect(requiredScopeForRoute("GET", "/stats/overview")).toEqual({ kind: "any-read" });
  });

  test("non-workspace surfaces are not resource routes", () => {
    for (const path of ["/auth/me", "/auth/tokens", "/admin/users", "/webhooks/whatsapp", "/public/webchat/x/session", "/health", "/config/public", "/"]) {
      expect(requiredScopeForRoute("GET", path), path).toEqual({ kind: "none" });
    }
  });
});

describe("assertApiTokenRouteAccess", () => {
  test("legacy grants (no binding, no scopes) are never restricted", () => {
    expect(() => assertApiTokenRouteAccess(grant(), "GET", "/auth/me")).not.toThrow();
    expect(() => assertApiTokenRouteAccess(grant(), "DELETE", "/contacts/x")).not.toThrow();
  });

  test("restricted tokens are refused outside workspace resource routes", () => {
    for (const g of [grant({ scopes: ["*"] }), grant({ workspaceId: "ws1" })]) {
      let err: unknown;
      try {
        assertApiTokenRouteAccess(g, "GET", "/auth/me");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(403);
      expect((err as AppError).code).toBe("FORBIDDEN");
    }
  });

  test("scope coverage is enforced per route, write implying read", () => {
    const g = grant({ scopes: ["contacts:write"] });
    expect(() => assertApiTokenRouteAccess(g, "GET", "/contacts")).not.toThrow();
    expect(() => assertApiTokenRouteAccess(g, "POST", "/contacts")).not.toThrow();
    expect(() => assertApiTokenRouteAccess(g, "GET", "/conversations")).toThrow();
    expect(() => assertApiTokenRouteAccess(g, "POST", "/broadcasts")).toThrow();
  });

  test("a workspace-bound token without scopes has full resource access", () => {
    const g = grant({ workspaceId: "ws1" });
    expect(() => assertApiTokenRouteAccess(g, "POST", "/broadcasts")).not.toThrow();
    expect(() => assertApiTokenRouteAccess(g, "GET", "/stats/overview")).not.toThrow();
  });

  test("any-read routes accept any read-capable grant and refuse empty grants", () => {
    expect(() => assertApiTokenRouteAccess(grant({ scopes: ["kb:read"] }), "GET", "/stats/overview")).not.toThrow();
    expect(() => assertApiTokenRouteAccess(grant({ scopes: ["kb:write"] }), "GET", "/stats/overview")).not.toThrow();
    expect(() => assertApiTokenRouteAccess(grant({ scopes: [] }), "GET", "/stats/overview")).toThrow();
    expect(() => assertApiTokenRouteAccess(grant({ scopes: [] }), "GET", "/contacts")).toThrow();
  });
});

describe("route map enumeration (app.routes)", () => {
  const app = createApp(testDeps());
  const routes = (app.routes as Array<{ method: string; path: string }>)
    .filter((r) => !["OPTIONS", "HEAD"].includes(r.method));

  test("every workspace-prefixed route maps to a scope requirement", () => {
    const unmapped: string[] = [];
    for (const r of routes) {
      const underWorkspacePrefix = WORKSPACE_ROUTE_PREFIXES.some(
        (p) => r.path === p || r.path.startsWith(`${p}/`),
      );
      if (!underWorkspacePrefix) continue;
      // The workspace collection itself is the one deliberate "none".
      if (r.path === "/workspaces") continue;
      if (requiredScopeForRoute(r.method, r.path).kind === "none") {
        unmapped.push(`${r.method} ${r.path}`);
      }
    }
    expect(unmapped).toEqual([]);
  });

  test("every taxonomy family has at least one live route (map is not aspirational)", () => {
    const mapped = new Set(
      routes.map((r) => {
        const req = requiredScopeForRoute(r.method, r.path);
        return req.kind === "scope" ? req.scope.split(":")[0] : null;
      }).filter(Boolean),
    );
    for (const resource of ["contacts", "conversations", "broadcasts", "flows", "sequences", "templates", "channels", "kb", "posts", "settings"]) {
      expect(mapped.has(resource), resource).toBe(true);
    }
  });
});
