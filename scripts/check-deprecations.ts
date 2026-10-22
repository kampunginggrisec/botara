#!/usr/bin/env bun
/**
 * Deprecation guard (Fase 3).
 *
 * Reads the Meta deprecation calendar from @botara/config and fails
 * (exit 1) when any item is PAST DUE or lands within the next 90 days -
 * platform removals must be worked on BEFORE they hit, not after. In CI
 * this runs as a non-blocking warning (continue-on-error) so a looming
 * date is visible on every PR without freezing unrelated work; run it
 * locally before releases:
 *
 *   bun scripts/check-deprecations.ts
 *
 * BOTARA_TODAY=YYYY-MM-DD overrides "today" (testing / what-if checks).
 */
// Imported by relative path on purpose: scripts/ sits outside the
// workspaces, and the calendar module is dependency-free data.
import { META_DEPRECATIONS } from "../packages/config/src/meta-deprecations";

const WINDOW_DAYS = 90;
const DAY_MS = 24 * 3600 * 1000;

const todayRaw = process.env.BOTARA_TODAY;
const now = todayRaw ? new Date(`${todayRaw}T00:00:00Z`) : new Date();
if (Number.isNaN(now.getTime())) {
  console.error(`Invalid BOTARA_TODAY: ${todayRaw}`);
  process.exit(2);
}
const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

interface Finding {
  date: string;
  days: number;
  status: "PAST DUE" | "DUE SOON" | "ok";
  surface: string;
  title: string;
  action: string;
}

const findings: Finding[] = META_DEPRECATIONS.map((e) => {
  const at = Date.parse(`${e.date}T00:00:00Z`);
  const days = Math.round((at - todayUtc) / DAY_MS);
  return {
    date: e.date,
    days,
    status: days < 0 ? "PAST DUE" : days <= WINDOW_DAYS ? "DUE SOON" : "ok",
    surface: e.surface,
    title: e.title,
    action: e.action,
  };
}).sort((a, b) => a.days - b.days);

console.log(`Meta deprecation calendar - today ${new Date(todayUtc).toISOString().slice(0, 10)}, warning window ${WINDOW_DAYS} days`);
for (const f of findings) {
  const when = f.days < 0 ? `${-f.days}d ago` : f.days === 0 ? "TODAY" : `in ${f.days}d`;
  console.log(`[${f.status}] ${f.date} (${when}) ${f.surface}: ${f.title}`);
  if (f.status !== "ok") console.log(`         action: ${f.action}`);
}

const urgent = findings.filter((f) => f.status !== "ok");
if (urgent.length > 0) {
  console.error(`\n${urgent.length} deprecation item(s) past due or within ${WINDOW_DAYS} days - action required.`);
  process.exit(1);
}
console.log("\nNo deprecations past due or within the warning window.");
