import { describe, expect, test } from "bun:test";
import {
  API_TOKEN_RESOURCES, API_TOKEN_SCOPES, grantsAnyRead, isApiTokenScope,
  parseApiTokenScopes, scopeCovers, tokenIsRestricted,
} from "./api-tokens";

describe("API token scope taxonomy", () => {
  test("the closed set is * plus read/write per resource", () => {
    expect(API_TOKEN_SCOPES).toHaveLength(1 + API_TOKEN_RESOURCES.length * 2);
    expect(API_TOKEN_SCOPES[0]).toBe("*");
    for (const resource of API_TOKEN_RESOURCES) {
      expect(API_TOKEN_SCOPES).toContain(`${resource}:read`);
      expect(API_TOKEN_SCOPES).toContain(`${resource}:write`);
    }
  });

  test("isApiTokenScope accepts only taxonomy members", () => {
    expect(isApiTokenScope("*")).toBe(true);
    expect(isApiTokenScope("contacts:read")).toBe(true);
    expect(isApiTokenScope("settings:write")).toBe(true);
    expect(isApiTokenScope("contacts:delete")).toBe(false);
    expect(isApiTokenScope("admin:read")).toBe(false);
    expect(isApiTokenScope("CONTACTS:READ")).toBe(false);
    expect(isApiTokenScope("")).toBe(false);
    expect(isApiTokenScope(42)).toBe(false);
    expect(isApiTokenScope(null)).toBe(false);
  });

  test("parseApiTokenScopes validates and dedupes", () => {
    expect(parseApiTokenScopes(["contacts:read", "contacts:read", "*"])).toEqual(["contacts:read", "*"]);
    expect(parseApiTokenScopes([])).toEqual([]);
    expect(parseApiTokenScopes(["contacts:read", "nope:read"])).toBeNull();
    expect(parseApiTokenScopes("contacts:read")).toBeNull();
    expect(parseApiTokenScopes(null)).toBeNull();
    expect(parseApiTokenScopes([42])).toBeNull();
  });

  test("scopeCovers: * covers everything", () => {
    expect(scopeCovers(["*"], "kb:write")).toBe(true);
    expect(scopeCovers(["*"], "contacts:read")).toBe(true);
  });

  test("scopeCovers: exact match, and write implies read of the same resource", () => {
    expect(scopeCovers(["contacts:read"], "contacts:read")).toBe(true);
    expect(scopeCovers(["contacts:write"], "contacts:read")).toBe(true);
    expect(scopeCovers(["contacts:write"], "contacts:write")).toBe(true);
  });

  test("scopeCovers: read does not imply write; nothing crosses resources", () => {
    expect(scopeCovers(["contacts:read"], "contacts:write")).toBe(false);
    expect(scopeCovers(["contacts:write"], "conversations:read")).toBe(false);
    expect(scopeCovers(["conversations:read"], "contacts:read")).toBe(false);
    expect(scopeCovers([], "contacts:read")).toBe(false);
  });

  test("grantsAnyRead treats write as a read-capable grant", () => {
    expect(grantsAnyRead(["*"])).toBe(true);
    expect(grantsAnyRead(["posts:read"])).toBe(true);
    expect(grantsAnyRead(["posts:write"])).toBe(true);
    expect(grantsAnyRead([])).toBe(false);
  });

  test("tokenIsRestricted: binding or scopes restrict; neither means legacy", () => {
    expect(tokenIsRestricted({ workspaceId: null, scopes: null })).toBe(false);
    expect(tokenIsRestricted({ workspaceId: "ws1", scopes: null })).toBe(true);
    expect(tokenIsRestricted({ workspaceId: null, scopes: ["contacts:read"] })).toBe(true);
    expect(tokenIsRestricted({ workspaceId: "ws1", scopes: ["*"] })).toBe(true);
  });
});
