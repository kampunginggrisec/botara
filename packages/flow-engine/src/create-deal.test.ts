import { describe, expect, test } from "bun:test";
import { buildVariableContext } from "@botara/shared";
import { runFlow, type FlowPorts } from "./executor";
import { flowSchema, type Flow } from "./schemas";

/**
 * Adoption package #6: the create_deal flow step.
 *
 * Discipline mirrors the other action steps (#3): the port performs the
 * mutation in live runtimes; a missing target (false), a throw, or an
 * unwired port all degrade to an actionWarning while the run continues.
 * The title is variable-interpolated with the documented fallback -
 * a created deal never carries an empty title or a raw {{...}} token.
 */

interface DealCall { pipelineId?: string; stageId?: string; title: string; value?: number }

function fakePorts(createDeal?: (input: DealCall) => Promise<boolean>) {
  const sent: string[] = [];
  const deals: DealCall[] = [];
  const ports: FlowPorts = {
    async sendMessage(input) { sent.push(input.text); },
    async scheduleDelay() {},
    async httpWebhook() {},
    async setContactField() {},
    ...(createDeal
      ? { async createDeal(input: DealCall) { deals.push(input); return createDeal(input); } }
      : {}),
  };
  return { ports, sent, deals };
}

const dealFlow = (node: Record<string, unknown>): Flow => ({
  id: "deal-flow",
  version: 1,
  startNodeId: "t1",
  nodes: [
    { id: "t1", type: "trigger", trigger: "manual", config: {}, next: "d1" },
    { id: "d1", type: "create_deal", next: "s1", ...node } as never,
    { id: "s1", type: "send_message", text: "Done", next: null },
  ],
});

const interpolation = buildVariableContext({
  contact: { displayName: "Rina", externalId: "628111", channel: "whatsapp" },
  workspaceName: "Toko Berkah",
});

describe("create_deal node schema", () => {
  test("parses with defaults (title optional, ids optional)", () => {
    const parsed = flowSchema.parse(dealFlow({}));
    const node = parsed.nodes[1]!;
    expect(node.type).toBe("create_deal");
    if (node.type === "create_deal") expect(node.title).toBe("");
    const full = flowSchema.parse(dealFlow({ pipelineId: "p1", stageId: "s1", title: "Big", value: 10 }));
    expect(full.nodes[1]).toMatchObject({ pipelineId: "p1", stageId: "s1", title: "Big", value: 10 });
  });

  test("rejects negative values and empty id strings", () => {
    expect(() => flowSchema.parse(dealFlow({ value: -1 }))).toThrow();
    expect(() => flowSchema.parse(dealFlow({ pipelineId: "" }))).toThrow();
    expect(() => flowSchema.parse(dealFlow({ title: "x".repeat(301) }))).toThrow();
  });
});

describe("create_deal through the executor", () => {
  test("creates with the configured pipeline/stage/value and an interpolated title", async () => {
    const f = fakePorts(async () => true);
    const result = await runFlow(
      f.ports,
      dealFlow({ pipelineId: "p1", stageId: "st9", title: "Order {{contact.name}}", value: 75000 }),
      undefined,
      { type: "manual" },
      { interpolation },
    );
    expect(f.deals).toEqual([{ pipelineId: "p1", stageId: "st9", title: "Order Rina", value: 75000 }]);
    expect(result.actionWarnings).toEqual([]);
    expect(result.state.status).toBe("completed");
    expect(f.sent).toEqual(["Done"]);
    const executed = result.executed.find((a) => a.type === "create_deal");
    expect(executed).toEqual({ type: "create_deal", pipelineId: "p1", stageId: "st9", title: "Order Rina", value: 75000 });
  });

  test("empty title falls back to 'Deal for {{contact.name}}'; no ids = defaults", async () => {
    const f = fakePorts(async () => true);
    const result = await runFlow(f.ports, dealFlow({}), undefined, { type: "manual" }, { interpolation });
    expect(f.deals).toEqual([{ title: "Deal for Rina" }]);
    expect(result.actionWarnings).toEqual([]);
  });

  test("without an interpolation context the fallback never leaks raw braces", async () => {
    const f = fakePorts(async () => true);
    await runFlow(f.ports, dealFlow({}), undefined, { type: "manual" });
    expect(f.deals).toEqual([{ title: "Deal" }]);
  });

  test("missing pipeline (port false) warns and the run continues", async () => {
    const f = fakePorts(async () => false);
    const result = await runFlow(
      f.ports, dealFlow({ pipelineId: "ghost" }), undefined, { type: "manual" }, { interpolation },
    );
    expect(result.actionWarnings).toEqual(['create_deal "Deal for Rina": target not found - skipped']);
    expect(result.state.status).toBe("completed");
    expect(f.sent).toEqual(["Done"]);
    // The step is still recorded in the executed list.
    expect(result.executed.map((a) => a.type)).toEqual(["create_deal", "send_message"]);
  });

  test("a throwing port warns and the run continues", async () => {
    const f = fakePorts(async () => { throw new Error("db down"); });
    const result = await runFlow(f.ports, dealFlow({}), undefined, { type: "manual" }, { interpolation });
    expect(result.actionWarnings).toEqual(['create_deal "Deal for Rina": failed (db down)']);
    expect(result.state.status).toBe("completed");
  });

  test("an unwired port is recorded-only with a warning", async () => {
    const f = fakePorts(undefined);
    const result = await runFlow(f.ports, dealFlow({}), undefined, { type: "manual" }, { interpolation });
    expect(f.deals).toEqual([]);
    expect(result.actionWarnings).toEqual(['create_deal "Deal for Rina": not supported by this runtime (recorded only)']);
    expect(result.executed.map((a) => a.type)).toEqual(["create_deal", "send_message"]);
  });
});
