import { describe, expect, test } from "bun:test";
import type { Deal, PipelineStage } from "./api";
import { boardTotals, formatDealMoney, groupDealsByStage, movedStageOrder, visibleDeals } from "./deals";

function stage(id: string, position: number): PipelineStage {
  return { id, pipelineId: "p1", name: id, position, createdAt: "", updatedAt: "" };
}

function deal(id: string, stageId: string, status: Deal["status"] = "open", value: number | null = 100): Deal {
  return {
    id, workspaceId: "ws", pipelineId: "p1", stageId, contactId: "c1",
    conversationId: null, title: id, value, currency: "IDR", status,
    expectedCloseDate: null, notes: null, createdByUserId: null,
    stageChangedAt: "", closedAt: null, createdAt: "", updatedAt: "",
    contactDisplayName: "Rina", contactExternalId: "628", contactChannel: "whatsapp",
  };
}

describe("formatDealMoney", () => {
  test("renders currency + amount, trims trailing zeros for whole numbers", () => {
    expect(formatDealMoney(1500000, "IDR")).toBe("IDR 1500000");
    expect(formatDealMoney(250.5, "USD")).toBe("USD 250.50");
    expect(formatDealMoney(0, "IDR")).toBe("IDR 0");
  });

  test("null / non-finite render as an em dash (never a crash)", () => {
    expect(formatDealMoney(null, "IDR")).toBe("—");
    expect(formatDealMoney(undefined, "IDR")).toBe("—");
    expect(formatDealMoney(Number.NaN, "IDR")).toBe("—");
  });
});

describe("groupDealsByStage", () => {
  test("columns follow stage order; deals land in their stage", () => {
    const stages = [stage("s2", 1), stage("s1", 0)]; // unsorted input
    const sorted = [...stages].sort((a, b) => a.position - b.position);
    const groups = groupDealsByStage(sorted, [deal("d1", "s1"), deal("d2", "s2"), deal("d3", "s1", "won")]);
    expect(groups.map((g) => g.stage.id)).toEqual(["s1", "s2"]);
    expect(groups[0]!.deals.map((d) => d.id)).toEqual(["d1", "d3"]);
    expect(groups[1]!.deals.map((d) => d.id)).toEqual(["d2"]);
  });

  test("orphan deals (stage missing) surface in a trailing bucket, never vanish", () => {
    const groups = groupDealsByStage([stage("s1", 0)], [deal("d1", "gone")]);
    expect(groups).toHaveLength(2);
    expect(groups[1]!.deals.map((d) => d.id)).toEqual(["d1"]);
  });
});

describe("visibleDeals", () => {
  test("closed deals show by default and hide on toggle", () => {
    const deals = [deal("a", "s1"), deal("b", "s1", "won"), deal("c", "s1", "lost")];
    expect(visibleDeals(deals, false).map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(visibleDeals(deals, true).map((d) => d.id)).toEqual(["a"]);
  });
});

describe("boardTotals / movedStageOrder", () => {
  test("totals read the summary buckets; null summary is zeros", () => {
    expect(boardTotals(null)).toEqual({ open: 0, won: 0, lost: 0 });
    expect(boardTotals({
      open: { count: 2, value: 300 }, won: { count: 1, value: 999 }, lost: { count: 1, value: 50 },
    })).toEqual({ open: 300, won: 999, lost: 50 });
  });

  test("stage moves swap neighbours and refuse the edges", () => {
    const stages = [stage("a", 0), stage("b", 1), stage("c", 2)];
    expect(movedStageOrder(stages, "b", -1)).toEqual(["b", "a", "c"]);
    expect(movedStageOrder(stages, "b", 1)).toEqual(["a", "c", "b"]);
    expect(movedStageOrder(stages, "a", -1)).toBeNull();
    expect(movedStageOrder(stages, "c", 1)).toBeNull();
    expect(movedStageOrder(stages, "ghost", 1)).toBeNull();
  });
});
