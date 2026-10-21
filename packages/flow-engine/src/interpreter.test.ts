import { describe, expect, test } from "bun:test";
import { flowSchema } from "./schemas";
import { initialState, step } from "./interpreter";

const flow = flowSchema.parse({
  id: "welcome",
  version: 1,
  startNodeId: "t1",
  nodes: [
    { id: "t1", type: "trigger", trigger: "message.received", next: "s1" },
    { id: "s1", type: "send_message", text: "Halo {{name}}!", next: "c1" },
    { id: "c1", type: "condition", field: "plan", operator: "equals", value: "pro", whenTrue: "s2", whenFalse: null, next: null },
    { id: "s2", type: "send_message", text: "Pro perks incoming", next: null },
  ],
});

describe("flow interpreter (deterministic stub)", () => {
  test("trigger advances without actions", () => {
    const r = step(flow, initialState(flow), { type: "message.received" });
    expect(r.state.currentNodeId).toBe("s1");
    expect(r.actions).toEqual([]);
  });

  test("send_message interpolates variables", () => {
    const s1 = step(flow, initialState(flow), { type: "message.received" }).state;
    const r = step(flow, s1, { type: "message.received", variables: { name: "Romo" } });
    expect(r.actions).toEqual([{ type: "send_message", text: "Halo Romo!", channel: undefined }]);
    expect(r.state.currentNodeId).toBe("c1");
  });

  test("condition branches deterministically", () => {
    const atCond = { flowId: "welcome", currentNodeId: "c1", variables: { plan: "pro" }, status: "running" as const };
    expect(step(flow, atCond, { type: "x" }).state.currentNodeId).toBe("s2");
    expect(step(flow, { ...atCond, variables: { plan: "free" } }, { type: "x" }).state.status).toBe("completed");
  });

  test("schema rejects unknown node types", () => {
    expect(() => flowSchema.parse({ id: "x", version: 1, startNodeId: "a", nodes: [{ id: "a", type: "nope", next: null }] })).toThrow();
  });
});
