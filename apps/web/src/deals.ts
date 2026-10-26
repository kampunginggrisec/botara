/**
 * Pure view-model helpers for the Deals board (package #6): grouping
 * deals into stage columns, closed-deal filtering, and money rendering.
 * Kept separate from App.tsx so the logic is unit-testable without
 * rendering - same discipline as broadcast-recipients.ts.
 */
import type { Deal, PipelineStage } from "./api";

/**
 * Render a deal money amount. Values arrive as JSON numbers or null
 * (the API normalizes the drizzle numeric string); anything non-finite
 * renders as an em dash - the broadcast money crash (#4) taught us to
 * never call toFixed on an unguarded value.
 */
export function formatDealMoney(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
  return `${currency} ${text}`;
}

/** Deals grouped under their stage, columns in stage (position) order. */
export function groupDealsByStage(
  stages: PipelineStage[],
  deals: Deal[],
): Array<{ stage: PipelineStage; deals: Deal[] }> {
  const known = new Set(stages.map((s) => s.id));
  const groups = stages.map((stage) => ({
    stage,
    deals: deals.filter((d) => d.stageId === stage.id),
  }));
  // Deals whose stage vanished from the list (stale board state) are not
  // dropped silently - they surface nowhere else, so append a synthetic
  // trailing bucket only when such orphans exist.
  const orphans = deals.filter((d) => !known.has(d.stageId));
  if (orphans.length > 0) {
    groups.push({
      stage: {
        id: "__orphan__", pipelineId: stages[0]?.pipelineId ?? "", name: "—",
        position: Number.MAX_SAFE_INTEGER, createdAt: "", updatedAt: "",
      },
      deals: orphans,
    });
  }
  return groups;
}

/** Won/lost deals stay on the board by default; the toggle hides them. */
export function visibleDeals(deals: Deal[], hideClosed: boolean): Deal[] {
  if (!hideClosed) return deals;
  return deals.filter((d) => d.status === "open");
}

/** Board header totals from the summary endpoint's three buckets. */
export function boardTotals(summary: {
  open: { count: number; value: number };
  won: { count: number; value: number };
  lost: { count: number; value: number };
} | null): { open: number; won: number; lost: number } {
  if (!summary) return { open: 0, won: 0, lost: 0 };
  return { open: summary.open.value, won: summary.won.value, lost: summary.lost.value };
}

/**
 * Order stage ids after moving one stage up/down - the payload for the
 * reorder endpoint, which requires the pipeline's exact stage set.
 */
export function movedStageOrder(stages: PipelineStage[], stageId: string, direction: -1 | 1): string[] | null {
  const ids = stages.map((s) => s.id);
  const idx = ids.indexOf(stageId);
  const target = idx + direction;
  if (idx < 0 || target < 0 || target >= ids.length) return null;
  [ids[idx], ids[target]] = [ids[target]!, ids[idx]!];
  return ids;
}
