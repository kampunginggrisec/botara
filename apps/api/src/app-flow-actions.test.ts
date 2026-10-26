import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";

/**
 * Adoption package #3 at the API seam:
 * - POST /flows graph validation accepts the new action/collect nodes
 *   and rejects bad shapes (the import path rides this same endpoint);
 * - export -> import round-trip: GET a flow's graph, POST it as a new
 *   flow, the stored graphs are deep-equal;
 * - the test-run (dry-run) records action steps + collect_input in its
 *   action list WITHOUT mutating anything, and reports paused at the
 *   collect step;
 * - resolving a conversation drops its collect-input waits.
 */

let fake: FakeDatabase;
const app = createApp(testDeps({ getDatabase: () => fake.db }));
let owner: Registered;

const actionGraph = {
  startNodeId: "t1",
  nodes: [
    { id: "t1", type: "trigger", trigger: "manual", config: {}, next: "a1", position: { x: 0, y: 0 } },
    { id: "a1", type: "add_tag", tag: "vip", next: "a2", position: { x: 0, y: 80 } },
    { id: "a2", type: "assign", userId: "user-9", next: "a3", position: { x: 0, y: 160 } },
    { id: "a3", type: "sequence_subscribe", sequenceId: "seq-1", next: "c1", position: { x: 0, y: 240 } },
    {
      id: "c1", type: "collect_input", promptText: "Kota apa?", variable: "city",
      saveToContactField: "city", timeoutHours: 24, next: "s1", position: { x: 0, y: 320 },
    },
    { id: "s1", type: "send_message", text: "Kamu dari {{vars.city}}", next: null, position: { x: 0, y: 400 } },
  ],
  edges: [
    { id: "e1", source: "t1", target: "a1" },
    { id: "e2", source: "a1", target: "a2" },
    { id: "e3", source: "a2", target: "a3" },
    { id: "e4", source: "a3", target: "c1" },
    { id: "e5", source: "c1", target: "s1" },
  ],
};

async function createFlow(name: string, graph: unknown) {
  return app.request("/flows", {
    method: "POST",
    headers: { ...owner.headers, "content-type": "application/json" },
    body: JSON.stringify({ name, trigger: { type: "manual", config: {} }, graph }),
  });
}

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(app, "flow-actions@example.com", "Flo Owner");
  fake.seed("channelAccounts", {
    id: "acc-wa", workspaceId: owner.workspaceId, channel: "whatsapp",
    externalId: "15550001", status: "connected", tokenVaultRef: null, authMode: null,
  });
  fake.seed("contacts", {
    id: "contact-1", workspaceId: owner.workspaceId, channel: "whatsapp",
    externalId: "628111", displayName: "Customer One", tags: ["trial"], customFields: {},
  });
  fake.seed("conversations", {
    id: "conv-1", workspaceId: owner.workspaceId, channelAccountId: "acc-wa",
    contactId: "contact-1", status: "open", assignedUserId: null, lastUserMessageAt: new Date(),
  });
});

describe("flow action steps: validation + round-trip via POST /flows", () => {
  test("a graph with action + collect nodes is accepted (201)", async () => {
    const res = await createFlow("Survey", actionGraph);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { flow: { id: string; status: string; graph: unknown } };
    expect(body.flow.status).toBe("draft");
    expect(body.flow.graph).toEqual(actionGraph);
  });

  test("bad action shapes are rejected at the schema edge (400)", async () => {
    const emptyTag = structuredClone(actionGraph);
    (emptyTag.nodes[1] as { tag: string }).tag = "";
    expect((await createFlow("Bad tag", emptyTag)).status).toBe(400);

    const badVariable = structuredClone(actionGraph);
    (badVariable.nodes[4] as { variable: string }).variable = "not a var";
    expect((await createFlow("Bad var", badVariable)).status).toBe(400);

    const badStatus = structuredClone(actionGraph);
    badStatus.nodes[2] = { id: "a2", type: "set_conversation_status", status: "pending", next: "a3", position: { x: 0, y: 160 } } as never;
    expect((await createFlow("Bad status", badStatus)).status).toBe(400);
  });

  test("export -> import round-trip: re-POSTing a fetched graph stores an equal graph", async () => {
    const created = await createFlow("Original", actionGraph);
    const { flow: original } = (await created.json()) as { flow: { id: string; graph: unknown } };

    const fetched = await app.request(`/flows/${original.id}`, { headers: owner.headers });
    const { flow: fetchedFlow } = (await fetched.json()) as { flow: { graph: unknown; trigger: unknown; name: string } };

    const imported = await createFlow(`${fetchedFlow.name} (imported)`, fetchedFlow.graph);
    expect(imported.status).toBe(201);
    const { flow: copy } = (await imported.json()) as { flow: { id: string; graph: unknown } };
    expect(copy.id).not.toBe(original.id);
    expect(copy.graph).toEqual(fetchedFlow.graph);
  });
});

describe("flow test-run with action steps (dry-run)", () => {
  test("actions are recorded in order, nothing mutates, the run pauses at collect_input", async () => {
    const created = await createFlow("Survey TR", actionGraph);
    const { flow } = (await created.json()) as { flow: { id: string } };

    const res = await app.request(`/flows/${flow.id}/test-run`, {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "halo" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string; paused: boolean;
      actions: Array<{ type: string }>;
      actionWarnings: string[];
    };
    expect(body.actions.map((a) => a.type)).toEqual([
      "add_tag", "assign_conversation", "sequence_subscribe", "send_message", "collect_input",
    ]);
    expect(body.paused).toBe(true);
    expect(body.status).toBe("waiting");
    expect(body.actionWarnings).toEqual([]);
    // Dry-run discipline: the contact kept its tags, gained no field,
    // and no wait row exists anywhere.
    const contact = fake.rows.contacts.find((c) => c.id === "contact-1")!;
    expect(contact.tags).toEqual(["trial"]);
    expect(contact.customFields).toEqual({});
    expect(fake.rows.flowWaits).toHaveLength(0);
  });
});

describe("resolving a conversation drops its collect-input waits", () => {
  test("PATCH status resolved deletes waits; other transitions keep them", async () => {
    fake.seed("flowWaits", {
      id: "wait-1", workspaceId: owner.workspaceId, conversationId: "conv-1",
      contactId: "contact-1", channelAccountId: "acc-wa", flowId: "f-1",
      nodeId: "c1", variable: "city", saveToContactField: null,
      resumeState: { flowId: "f-1", currentNodeId: "s1", variables: {}, status: "waiting" },
      deadlineAt: null,
    });
    const pending = await app.request("/conversations/conv-1/status", {
      method: "PATCH",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ status: "pending" }),
    });
    expect(pending.status).toBe(200);
    expect(fake.rows.flowWaits).toHaveLength(1);

    const resolved = await app.request("/conversations/conv-1/status", {
      method: "PATCH",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });
    expect(resolved.status).toBe(200);
    expect(fake.rows.flowWaits).toHaveLength(0);
  });
});
