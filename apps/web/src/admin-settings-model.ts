/**
 * Platform-admin settings view-model (pure functions, unit-tested).
 *
 * Backs the Admin → Settings redesign: platform cards with an honest
 * "configured" badge, non-secret inputs prefilled with their current
 * value, and secret inputs that stay empty (masked placeholder only).
 * Draft semantics:
 * - An untouched field (no draft entry) never produces an update.
 * - Secret: a non-empty draft replaces the value; empty means "keep".
 * - Non-secret: a draft that differs from the current value is sent;
 *   emptying a panel-sourced (db) value sends `clear: true` so the env
 *   fallback applies again; emptying an env-sourced value is a no-op
 *   (the panel cannot remove env values).
 */

export interface SettingLike {
  key: string;
  secret: boolean;
  group: string;
  isSet: boolean;
  /** Resolved plaintext for non-secret keys; always null for secrets. */
  value: string | null;
  source: "db" | "env" | null;
}

export type SettingDrafts = Record<string, string>;

export type SettingUpdate = { key: string; value: string } | { key: string; clear: true };

/** Groups rendered as platform cards (URL boxes + credentials merged). */
export type PlatformCardGroup = "meta" | "instagram" | "threads" | "tiktok";

export function settingIsSet(settings: readonly SettingLike[], key: string): boolean {
  return settings.find((s) => s.key === key)?.isSet === true;
}

/**
 * Honest per-platform "configured" test, derived only from which keys
 * are effectively set (panel DB or env). Fallbacks mirror the key
 * registry hints: Instagram rides the Meta app when its own pair is
 * unset; the Threads secret falls back to the Meta app secret.
 */
export function platformConfigured(group: PlatformCardGroup, settings: readonly SettingLike[]): boolean {
  const metaPair = settingIsSet(settings, "META_APP_ID") && settingIsSet(settings, "META_APP_SECRET");
  switch (group) {
    case "meta":
      return metaPair;
    case "instagram":
      return (settingIsSet(settings, "INSTAGRAM_APP_ID") && settingIsSet(settings, "INSTAGRAM_APP_SECRET")) || metaPair;
    case "threads":
      return settingIsSet(settings, "THREADS_APP_ID")
        && (settingIsSet(settings, "THREADS_APP_SECRET") || settingIsSet(settings, "META_APP_SECRET"));
    case "tiktok":
      return settingIsSet(settings, "TIKTOK_APP_ID") && settingIsSet(settings, "TIKTOK_APP_SECRET");
  }
}

/** What an input shows: a recorded draft wins; otherwise the current value (non-secret) or empty (secret). */
export function inputValueFor(setting: SettingLike, drafts: SettingDrafts): string {
  const draft = drafts[setting.key];
  if (draft !== undefined) return draft;
  return setting.secret ? "" : (setting.value ?? "");
}

export function settingHasChange(setting: SettingLike, drafts: SettingDrafts): boolean {
  const draft = drafts[setting.key];
  if (draft === undefined) return false;
  if (setting.secret) return draft.trim() !== "";
  if (draft === (setting.value ?? "")) return false;
  if (draft === "") return setting.source === "db";
  // Whitespace-only drafts carry no intent (mirrors the old trim filter).
  return draft.trim() !== "";
}

/** The updates a Save for one group must send (empty = nothing to save). */
export function buildGroupUpdates(
  settings: readonly SettingLike[],
  group: string,
  drafts: SettingDrafts,
): SettingUpdate[] {
  const updates: SettingUpdate[] = [];
  for (const setting of settings) {
    if (setting.group !== group) continue;
    if (!settingHasChange(setting, drafts)) continue;
    const draft = drafts[setting.key] ?? "";
    if (!setting.secret && draft === "") updates.push({ key: setting.key, clear: true });
    else updates.push({ key: setting.key, value: draft });
  }
  return updates;
}

export function groupHasChanges(
  settings: readonly SettingLike[],
  group: string,
  drafts: SettingDrafts,
): boolean {
  return buildGroupUpdates(settings, group, drafts).length > 0;
}
