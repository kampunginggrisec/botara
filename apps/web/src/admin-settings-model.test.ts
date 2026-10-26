import { describe, expect, test } from "bun:test";
import {
  buildGroupUpdates, groupHasChanges, inputValueFor, platformConfigured,
  type SettingLike,
} from "./admin-settings-model";

function setting(key: string, opts: Partial<SettingLike> = {}): SettingLike {
  return { key, secret: false, group: "meta", isSet: false, value: null, source: null, ...opts };
}
const setPlain = (key: string, group = "meta", source: "db" | "env" = "db"): SettingLike =>
  setting(key, { group, isSet: true, value: `value-of-${key}`, source });
const setSecret = (key: string, group = "meta"): SettingLike =>
  setting(key, { group, secret: true, isSet: true, value: null, source: "db" });

describe("platformConfigured", () => {
  test("meta needs app id AND app secret", () => {
    expect(platformConfigured("meta", [])).toBe(false);
    expect(platformConfigured("meta", [setPlain("META_APP_ID")])).toBe(false);
    expect(platformConfigured("meta", [setSecret("META_APP_SECRET")])).toBe(false);
    expect(platformConfigured("meta", [setPlain("META_APP_ID"), setSecret("META_APP_SECRET")])).toBe(true);
  });

  test("instagram: own pair, or the Meta pair as fallback", () => {
    expect(platformConfigured("instagram", [setPlain("INSTAGRAM_APP_ID", "instagram")])).toBe(false);
    expect(platformConfigured("instagram", [
      setPlain("INSTAGRAM_APP_ID", "instagram"), setSecret("INSTAGRAM_APP_SECRET", "instagram"),
    ])).toBe(true);
    // Only the Meta pair set -> configured via fallback.
    expect(platformConfigured("instagram", [setPlain("META_APP_ID"), setSecret("META_APP_SECRET")])).toBe(true);
    // Instagram id + Meta secret alone is NOT a pair.
    expect(platformConfigured("instagram", [
      setPlain("INSTAGRAM_APP_ID", "instagram"), setSecret("META_APP_SECRET"),
    ])).toBe(false);
  });

  test("threads: app id plus own secret or the Meta secret fallback", () => {
    expect(platformConfigured("threads", [setPlain("THREADS_APP_ID", "threads")])).toBe(false);
    expect(platformConfigured("threads", [
      setPlain("THREADS_APP_ID", "threads"), setSecret("THREADS_APP_SECRET", "threads"),
    ])).toBe(true);
    expect(platformConfigured("threads", [
      setPlain("THREADS_APP_ID", "threads"), setSecret("META_APP_SECRET"),
    ])).toBe(true);
    // Secret without the Threads app id is not enough.
    expect(platformConfigured("threads", [setSecret("THREADS_APP_SECRET", "threads")])).toBe(false);
  });

  test("tiktok needs app id AND app secret", () => {
    expect(platformConfigured("tiktok", [setPlain("TIKTOK_APP_ID", "tiktok")])).toBe(false);
    expect(platformConfigured("tiktok", [
      setPlain("TIKTOK_APP_ID", "tiktok"), setSecret("TIKTOK_APP_SECRET", "tiktok"),
    ])).toBe(true);
  });
});

describe("inputValueFor", () => {
  test("untouched: non-secret shows its current value, secret stays empty", () => {
    expect(inputValueFor(setPlain("META_APP_ID"), {})).toBe("value-of-META_APP_ID");
    expect(inputValueFor(setSecret("META_APP_SECRET"), {})).toBe("");
    expect(inputValueFor(setting("AI_MODEL", { group: "ai" }), {})).toBe("");
  });

  test("a recorded draft always wins (including an explicit empty string)", () => {
    expect(inputValueFor(setPlain("META_APP_ID"), { META_APP_ID: "typed" })).toBe("typed");
    expect(inputValueFor(setPlain("META_APP_ID"), { META_APP_ID: "" })).toBe("");
    expect(inputValueFor(setSecret("META_APP_SECRET"), { META_APP_SECRET: "new" })).toBe("new");
  });
});

describe("buildGroupUpdates", () => {
  const settings: SettingLike[] = [
    setPlain("META_APP_ID"),
    setSecret("META_APP_SECRET"),
    setPlain("R2_BUCKET", "storage", "env"),
    setting("AI_MODEL", { group: "ai" }),
  ];

  test("no drafts -> no updates, no changes", () => {
    expect(buildGroupUpdates(settings, "meta", {})).toEqual([]);
    expect(groupHasChanges(settings, "meta", {})).toBe(false);
  });

  test("secret: non-empty draft replaces; empty/whitespace draft keeps", () => {
    expect(buildGroupUpdates(settings, "meta", { META_APP_SECRET: "new-secret" }))
      .toEqual([{ key: "META_APP_SECRET", value: "new-secret" }]);
    expect(buildGroupUpdates(settings, "meta", { META_APP_SECRET: "" })).toEqual([]);
    expect(buildGroupUpdates(settings, "meta", { META_APP_SECRET: "   " })).toEqual([]);
  });

  test("non-secret: unchanged prefilled value is NOT resent", () => {
    expect(buildGroupUpdates(settings, "meta", { META_APP_ID: "value-of-META_APP_ID" })).toEqual([]);
  });

  test("non-secret: a changed value is sent", () => {
    expect(buildGroupUpdates(settings, "meta", { META_APP_ID: "other-id" }))
      .toEqual([{ key: "META_APP_ID", value: "other-id" }]);
    expect(groupHasChanges(settings, "meta", { META_APP_ID: "other-id" })).toBe(true);
  });

  test("non-secret: emptying a panel (db) value sends clear:true", () => {
    expect(buildGroupUpdates(settings, "meta", { META_APP_ID: "" }))
      .toEqual([{ key: "META_APP_ID", clear: true }]);
  });

  test("non-secret: emptying an env value or an unset field is a no-op", () => {
    expect(buildGroupUpdates(settings, "storage", { R2_BUCKET: "" })).toEqual([]);
    expect(buildGroupUpdates(settings, "ai", { AI_MODEL: "" })).toEqual([]);
  });

  test("only the requested group is included", () => {
    expect(buildGroupUpdates(settings, "ai", { AI_MODEL: "gpt-x", META_APP_ID: "zzz" }))
      .toEqual([{ key: "AI_MODEL", value: "gpt-x" }]);
  });
});
