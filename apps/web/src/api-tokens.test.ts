import { describe, expect, test } from "bun:test";
import {
  TOKEN_RESOURCES, countPickedResources, emptyScopePicks, expiryIsoFromDays,
  picksToScopes, scopeParts, tokenIsExpired,
} from "./api-tokens";

describe("web API token scope helpers", () => {
  test("the resource mirror matches the taxonomy size (11 resources)", () => {
    expect(TOKEN_RESOURCES).toHaveLength(11);
    expect(TOKEN_RESOURCES).toContain("kb");
    expect(TOKEN_RESOURCES).toContain("settings");
  });

  test("picksToScopes: write wins over read, taxonomy order is stable", () => {
    const picks = emptyScopePicks();
    picks.contacts.read = true;
    picks.contacts.write = true;
    picks.flows.read = true;
    picks.kb.write = true;
    expect(picksToScopes(picks)).toEqual(["contacts:write", "flows:read", "kb:write"]);
    expect(countPickedResources(picks)).toBe(3);
    expect(picksToScopes(emptyScopePicks())).toEqual([]);
    expect(countPickedResources(emptyScopePicks())).toBe(0);
  });

  test("scopeParts splits *, read and write scopes", () => {
    expect(scopeParts("*")).toEqual({ resource: "*", level: "all" });
    expect(scopeParts("posts:read")).toEqual({ resource: "posts", level: "read" });
    expect(scopeParts("posts:write")).toEqual({ resource: "posts", level: "write" });
  });

  test("tokenIsExpired compares against now; null never expires", () => {
    const now = new Date("2026-10-27T00:00:00.000Z");
    expect(tokenIsExpired(null, now)).toBe(false);
    expect(tokenIsExpired("2026-10-26T23:59:59.000Z", now)).toBe(true);
    expect(tokenIsExpired("2026-10-28T00:00:00.000Z", now)).toBe(false);
  });

  test("expiryIsoFromDays adds whole days", () => {
    const now = new Date("2026-10-27T00:00:00.000Z");
    expect(expiryIsoFromDays(30, now)).toBe("2026-11-26T00:00:00.000Z");
    expect(expiryIsoFromDays(365, now)).toBe("2027-10-27T00:00:00.000Z");
  });
});
