import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";

/**
 * Adoption package #6 (sales pipelines + deals) at the API seam, run
 * against the REAL repositories over the in-memory fake DB:
 * - pipeline + stage CRUD, default-pipeline rules, stage reorder;
 * - deal CRUD with workspace composition validation (400s) vs
 *   cross-workspace invisibility (404s);
 * - delete semantics: stage-with-deals 409, pipeline-with-deals 409
 *   unless ?force=true;
 * - summary math (open per stage; won/lost apart);
 * - stage_changed_at / closed_at maintenance on PATCH;
 * - scoped-token enforcement for the deals resource (#5 follow-through);
 * - the create_deal flow step is record-only in test-runs.
 */

let fake: FakeDatabase;
const app = createApp(testDeps({
  getDatabase: () => fake.db,
  rateLimits: { authPerMinute: 10000 },
}));
let owner: Registered;
let other: Registered;

interface StageBody { id: string; name: string; position: number }
interface PipelineBody { id: string; name: string; isDefault: boolean; stages: StageBody[] }
interface DealBody {
  id: string; pipelineId: string; stageId: string; contactId: string;
  conversationId: string | null; title: string; value: number | null;
  currency: string; status: string; stageChangedAt: string; closedAt: string | null;
  contactDisplayName: string | null;
}

async function api<T>(auth: Registered, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await app.request(path, {
    method,
    headers: { ...auth.headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

async function createPipeline(auth: Registered, body: Record<string, unknown>): Promise<PipelineBody> {
  const res = await api<{ pipeline: PipelineBody }>(auth, "POST", "/pipelines", body);
  expect(res.status).toBe(201);
  return res.body.pipeline;
}

let pipelineA: PipelineBody;
let pipelineB: PipelineBody;
let foreignPipeline: PipelineBody;

beforeAll(async () => {
  fake = createFakeDatabase();
  owner = await registerUser(app, "deals@example.com", "Deal Owner");
  other = await registerUser(app, "deals-other@example.com", "Other Owner");
  fake.seed("contacts", {
    id: "contact-1", workspaceId: owner.workspaceId, channel: "whatsapp",
    externalId: "628111", displayName: "Customer One", tags: [], customFields: {},
  });
  fake.seed("contacts", {
    id: "contact-2", workspaceId: owner.workspaceId, channel: "whatsapp",
    externalId: "628222", displayName: "Customer Two", tags: [], customFields: {},
  });
  fake.seed("contacts", {
    id: "contact-foreign", workspaceId: other.workspaceId, channel: "whatsapp",
    externalId: "628999", displayName: "Foreign Customer", tags: [], customFields: {},
  });
  pipelineA = await createPipeline(owner, { name: "Retail", withDefaultStages: true });
  pipelineB = await createPipeline(owner, { name: "Wholesale" });
  foreignPipeline = await createPipeline(other, { name: "Theirs", withDefaultStages: true });
});

describe("pipelines", () => {
  test("first pipeline gets the five default stages and becomes the default", () => {
    expect(pipelineA.isDefault).toBe(true);
    expect(pipelineA.stages.map((s) => s.name)).toEqual(["New", "Contacted", "Qualified", "Proposal", "Negotiation"]);
    expect(pipelineA.stages.map((s) => s.position)).toEqual([0, 1, 2, 3, 4]);
    expect(pipelineB.isDefault).toBe(false);
    expect(pipelineB.stages).toEqual([]);
  });

  test("PATCH isDefault demotes the previous default", async () => {
    const res = await api<{ pipeline: PipelineBody }>(owner, "PATCH", `/pipelines/${pipelineB.id}`, { isDefault: true });
    expect(res.status).toBe(200);
    expect(res.body.pipeline.isDefault).toBe(true);
    const list = await api<{ pipelines: PipelineBody[] }>(owner, "GET", "/pipelines");
    expect(list.body.pipelines.find((p) => p.id === pipelineA.id)?.isDefault).toBe(false);
    // Restore for the later tests.
    await api(owner, "PATCH", `/pipelines/${pipelineA.id}`, { isDefault: true });
  });

  test("stages: add appends, rename works, reorder validates the full set", async () => {
    const added = await api<{ stage: StageBody }>(owner, "POST", `/pipelines/${pipelineB.id}/stages`, { name: "Lead" });
    expect(added.status).toBe(201);
    expect(added.body.stage.position).toBe(0);
    const added2 = await api<{ stage: StageBody }>(owner, "POST", `/pipelines/${pipelineB.id}/stages`, { name: "Won-ish" });
    expect(added2.body.stage.position).toBe(1);

    const renamed = await api<{ stage: StageBody }>(
      owner, "PATCH", `/pipelines/${pipelineB.id}/stages/${added2.body.stage.id}`, { name: "Closing" },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.stage.name).toBe("Closing");

    const reversed = [added2.body.stage.id, added.body.stage.id];
    const reordered = await api<{ stages: StageBody[] }>(
      owner, "POST", `/pipelines/${pipelineB.id}/stages/reorder`, { stageIds: reversed },
    );
    expect(reordered.status).toBe(200);
    expect(reordered.body.stages.map((s) => s.id)).toEqual(reversed);
    expect(reordered.body.stages.map((s) => s.position)).toEqual([0, 1]);

    const partial = await api(owner, "POST", `/pipelines/${pipelineB.id}/stages/reorder`, { stageIds: [added.body.stage.id] });
    expect(partial.status).toBe(400);
    const foreignStage = await api(owner, "POST", `/pipelines/${pipelineB.id}/stages/reorder`, {
      stageIds: [added.body.stage.id, pipelineA.stages[0]!.id],
    });
    expect(foreignStage.status).toBe(400);
  });
});

describe("deal creation + validation", () => {
  test("happy path: first stage by default, workspace currency, numeric value", async () => {
    const res = await api<{ deal: DealBody }>(owner, "POST", "/deals", {
      pipelineId: pipelineA.id, contactId: "contact-1", title: "First deal", value: 1500000,
    });
    expect(res.status).toBe(201);
    expect(res.body.deal.stageId).toBe(pipelineA.stages[0]!.id);
    expect(res.body.deal.currency).toBe("IDR");
    expect(res.body.deal.value).toBe(1500000);
    expect(typeof res.body.deal.value).toBe("number");
    expect(res.body.deal.status).toBe("open");
    expect(res.body.deal.contactDisplayName).toBe("Customer One");
    expect(res.body.deal.conversationId).toBeNull();
  });

  test("explicit stage + lowercase currency is normalized", async () => {
    const res = await api<{ deal: DealBody }>(owner, "POST", "/deals", {
      pipelineId: pipelineA.id, stageId: pipelineA.stages[2]!.id, contactId: "contact-2",
      title: "Qualified deal", value: 250.5, currency: "usd",
    });
    expect(res.status).toBe(201);
    expect(res.body.deal.stageId).toBe(pipelineA.stages[2]!.id);
    expect(res.body.deal.currency).toBe("USD");
    expect(res.body.deal.value).toBe(250.5);
  });

  test("mis-composed ids are 400 VALIDATION (foreign contact / pipeline / stage / conversation)", async () => {
    const base = { pipelineId: pipelineA.id, contactId: "contact-1", title: "Nope" };
    const foreignContact = await api(owner, "POST", "/deals", { ...base, contactId: "contact-foreign" });
    expect(foreignContact.status).toBe(400);
    const foreignPipelineRes = await api(owner, "POST", "/deals", { ...base, pipelineId: foreignPipeline.id });
    expect(foreignPipelineRes.status).toBe(400);
    const ghostPipeline = await api(owner, "POST", "/deals", { ...base, pipelineId: "no-such-pipeline" });
    expect(ghostPipeline.status).toBe(400);
    // Stage of pipeline B named against pipeline A.
    const stagesB = await api<{ pipelines: PipelineBody[] }>(owner, "GET", "/pipelines");
    const stageB = stagesB.body.pipelines.find((p) => p.id === pipelineB.id)!.stages[0]!;
    const wrongStage = await api(owner, "POST", "/deals", { ...base, stageId: stageB.id });
    expect(wrongStage.status).toBe(400);
    const foreignConversation = await api(owner, "POST", "/deals", { ...base, conversationId: "no-such-conversation" });
    expect(foreignConversation.status).toBe(400);
    // Missing contact entirely is a schema 400 too.
    const noContact = await app.request("/deals", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ pipelineId: pipelineA.id, title: "No contact" }),
    });
    expect(noContact.status).toBe(400);
  });

  test("a pipeline without stages cannot take deals yet", async () => {
    const empty = await createPipeline(owner, { name: "Empty" });
    const res = await api(owner, "POST", "/deals", {
      pipelineId: empty.id, contactId: "contact-1", title: "Nowhere to land",
    });
    expect(res.status).toBe(400);
    await api(owner, "DELETE", `/pipelines/${empty.id}`);
  });
});

describe("cross-workspace invisibility (404)", () => {
  test("another workspace cannot see or touch the deals or pipelines", async () => {
    const list = await api<{ deals: DealBody[]; total: number }>(owner, "GET", `/deals?pipelineId=${pipelineA.id}`);
    const deal = list.body.deals[0]!;
    expect(deal).toBeTruthy();

    expect((await api(other, "GET", `/deals/${deal.id}`)).status).toBe(404);
    expect((await api(other, "PATCH", `/deals/${deal.id}`, { title: "hijack" })).status).toBe(404);
    expect((await api(other, "DELETE", `/deals/${deal.id}`)).status).toBe(404);
    expect((await api(other, "GET", `/pipelines/${pipelineA.id}/summary`)).status).toBe(404);
    expect((await api(other, "PATCH", `/pipelines/${pipelineA.id}`, { name: "hijack" })).status).toBe(404);
    expect((await api(other, "DELETE", `/pipelines/${pipelineA.id}`)).status).toBe(404);
    const otherList = await api<{ pipelines: PipelineBody[] }>(other, "GET", "/pipelines");
    expect(otherList.body.pipelines.map((p) => p.id)).toEqual([foreignPipeline.id]);
  });
});

describe("summary math + patch bookkeeping", () => {
  let summaryPipeline: PipelineBody;
  const dealIds: Record<string, string> = {};

  beforeAll(async () => {
    summaryPipeline = await createPipeline(owner, { name: "Math", stages: ["S1", "S2"] });
    const mk = async (key: string, stageIdx: number, value: number, status?: string) => {
      const res = await api<{ deal: DealBody }>(owner, "POST", "/deals", {
        pipelineId: summaryPipeline.id, stageId: summaryPipeline.stages[stageIdx]!.id,
        contactId: "contact-1", title: key, value,
      });
      expect(res.status).toBe(201);
      dealIds[key] = res.body.deal.id;
      if (status) {
        const patched = await api(owner, "PATCH", `/deals/${dealIds[key]}`, { status });
        expect(patched.status).toBe(200);
      }
    };
    await mk("openA", 0, 100);
    await mk("openB", 0, 250.5);
    await mk("wonA", 0, 999, "won");
    await mk("openC", 1, 50);
    await mk("lostA", 1, 75, "lost");
  });

  test("per-stage open sums exclude won/lost; won/lost totals are apart", async () => {
    const res = await api<{ summary: never }>(owner, "GET", `/pipelines/${summaryPipeline.id}/summary`);
    expect(res.status).toBe(200);
    const summary = res.body.summary as {
      stages: Array<{ openCount: number; openValue: number }>;
      open: { count: number; value: number };
      won: { count: number; value: number };
      lost: { count: number; value: number };
    };
    expect(summary.stages[0]).toMatchObject({ openCount: 2, openValue: 350.5 });
    expect(summary.stages[1]).toMatchObject({ openCount: 1, openValue: 50 });
    expect(summary.open).toEqual({ count: 3, value: 400.5 });
    expect(summary.won).toEqual({ count: 1, value: 999 });
    expect(summary.lost).toEqual({ count: 1, value: 75 });
  });

  test("closing stamps closedAt, reopening clears it", async () => {
    const won = await api<{ deal: DealBody }>(owner, "PATCH", `/deals/${dealIds.openA}`, { status: "won" });
    expect(won.body.deal.status).toBe("won");
    expect(won.body.deal.closedAt).not.toBeNull();
    const reopened = await api<{ deal: DealBody }>(owner, "PATCH", `/deals/${dealIds.openA}`, { status: "open" });
    expect(reopened.body.deal.status).toBe("open");
    expect(reopened.body.deal.closedAt).toBeNull();
  });

  test("a stage move updates stage_changed_at", async () => {
    fake.seed("deals", {
      id: "deal-ancient", workspaceId: owner.workspaceId, pipelineId: summaryPipeline.id,
      stageId: summaryPipeline.stages[0]!.id, contactId: "contact-1", conversationId: null,
      title: "Ancient", value: "10.00", currency: "IDR", status: "open",
      expectedCloseDate: null, notes: null, createdByUserId: null,
      stageChangedAt: new Date("2020-01-01T00:00:00Z"), closedAt: null,
    });
    const before = await api<{ deal: DealBody }>(owner, "GET", `/deals/deal-ancient`);
    expect(before.body.deal.stageChangedAt).toBe("2020-01-01T00:00:00.000Z");
    const moved = await api<{ deal: DealBody }>(owner, "PATCH", "/deals/deal-ancient", {
      stageId: summaryPipeline.stages[1]!.id,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.deal.stageId).toBe(summaryPipeline.stages[1]!.id);
    expect(new Date(moved.body.deal.stageChangedAt).getTime()).toBeGreaterThan(new Date("2020-06-01").getTime());
  });

  test("moving to a stage of another pipeline is a 400", async () => {
    const res = await api(owner, "PATCH", `/deals/${dealIds.openB}`, { stageId: pipelineA.stages[0]!.id });
    expect(res.status).toBe(400);
  });
});

describe("delete semantics", () => {
  test("stage with deals is a 409; after moving the deal out it deletes and positions re-densify", async () => {
    const pipe = await createPipeline(owner, { name: "Stages", stages: ["One", "Two", "Three"] });
    const deal = await api<{ deal: DealBody }>(owner, "POST", "/deals", {
      pipelineId: pipe.id, stageId: pipe.stages[0]!.id, contactId: "contact-1", title: "Blocker",
    });
    expect(deal.status).toBe(201);
    const blocked = await api(owner, "DELETE", `/pipelines/${pipe.id}/stages/${pipe.stages[0]!.id}`);
    expect(blocked.status).toBe(409);
    await api(owner, "PATCH", `/deals/${deal.body.deal.id}`, { stageId: pipe.stages[1]!.id });
    const freed = await api(owner, "DELETE", `/pipelines/${pipe.id}/stages/${pipe.stages[0]!.id}`);
    expect(freed.status).toBe(200);
    const list = await api<{ pipelines: PipelineBody[] }>(owner, "GET", "/pipelines");
    const after = list.body.pipelines.find((p) => p.id === pipe.id)!;
    expect(after.stages.map((s) => s.name)).toEqual(["Two", "Three"]);
    expect(after.stages.map((s) => s.position)).toEqual([0, 1]);
  });

  test("pipeline with deals is a 409 unless ?force=true", async () => {
    const pipe = await createPipeline(owner, { name: "Doomed", stages: ["Only"] });
    const deal = await api(owner, "POST", "/deals", {
      pipelineId: pipe.id, contactId: "contact-1", title: "Doomed deal",
    });
    expect(deal.status).toBe(201);
    expect((await api(owner, "DELETE", `/pipelines/${pipe.id}`)).status).toBe(409);
    expect((await api(owner, "DELETE", `/pipelines/${pipe.id}?force=true`)).status).toBe(200);
    const deals = await api<{ total: number }>(owner, "GET", `/deals?pipelineId=${pipe.id}`);
    expect(deals.body.total).toBe(0);
    const list = await api<{ pipelines: PipelineBody[] }>(owner, "GET", "/pipelines");
    expect(list.body.pipelines.some((p) => p.id === pipe.id)).toBe(false);
  });
});

describe("workspace default currency", () => {
  test("PATCH /workspaces/{id} sets it and deals inherit it", async () => {
    const patched = await app.request(`/workspaces/${owner.workspaceId}`, {
      method: "PATCH",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ defaultCurrency: "usd" }),
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as { workspace: { defaultCurrency: string } };
    expect(body.workspace.defaultCurrency).toBe("USD");

    // The repository reads the DB row: seed the fake's workspace row so
    // the deals path sees the same default the auth store reported.
    fake.seed("workspaces", {
      id: owner.workspaceId, name: "Deal Owner's Workspace", slug: "deal-owner", defaultCurrency: "USD",
    });
    const res = await api<{ deal: DealBody }>(owner, "POST", "/deals", {
      pipelineId: pipelineA.id, contactId: "contact-1", title: "Currency deal",
    });
    expect(res.status).toBe(201);
    expect(res.body.deal.currency).toBe("USD");
  });
});

describe("scoped tokens (#5 follow-through)", () => {
  async function boundToken(scopes: string[]): Promise<string> {
    const res = await app.request("/auth/tokens", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "deals probe", workspaceId: owner.workspaceId, scopes }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { token: string }).token;
  }
  const bearer = (raw: string) => ({ authorization: `Bearer ${raw}` });

  test("deals:read reads the board but cannot write", async () => {
    const raw = await boundToken(["deals:read"]);
    const read = await app.request("/deals", { headers: bearer(raw) });
    expect(read.status).toBe(200);
    const pipes = await app.request("/pipelines", { headers: bearer(raw) });
    expect(pipes.status).toBe(200);
    const write = await app.request("/deals", {
      method: "POST",
      headers: { ...bearer(raw), "content-type": "application/json" },
      body: JSON.stringify({ pipelineId: pipelineA.id, contactId: "contact-1", title: "Nope" }),
    });
    expect(write.status).toBe(403);
  });

  test("a token without the deals scope is refused outright", async () => {
    const raw = await boundToken(["contacts:read"]);
    const read = await app.request("/deals", { headers: bearer(raw) });
    expect(read.status).toBe(403);
  });

  test("deals:write implies deals:read", async () => {
    const raw = await boundToken(["deals:write"]);
    const read = await app.request("/deals", { headers: bearer(raw) });
    expect(read.status).toBe(200);
  });
});

describe("create_deal flow step (record-only test-run)", () => {
  test("test-run records the step with the fallback title and creates nothing", async () => {
    const graph = {
      startNodeId: "t1",
      nodes: [
        { id: "t1", type: "trigger", trigger: "manual", config: {}, next: "d1", position: { x: 0, y: 0 } },
        { id: "d1", type: "create_deal", title: "", value: 5000, next: null, position: { x: 0, y: 80 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "d1" }],
    };
    const created = await app.request("/flows", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Deal flow", trigger: { type: "manual", config: {} }, graph }),
    });
    expect(created.status).toBe(201);
    const flowId = ((await created.json()) as { flow: { id: string } }).flow.id;

    const dealsBefore = fake.rows.deals.length;
    const run = await app.request(`/flows/${flowId}/test-run`, {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "halo" }),
    });
    expect(run.status).toBe(200);
    const result = (await run.json()) as { actions: Array<Record<string, unknown>> };
    const dealAction = result.actions.find((a) => a.type === "create_deal");
    expect(dealAction).toBeTruthy();
    expect(dealAction!.title).toBe("Deal for Test Contact");
    expect(dealAction!.value).toBe(5000);
    expect(fake.rows.deals.length).toBe(dealsBefore);
  });

  test("a negative deal value is rejected at the graph schema edge", async () => {
    const graph = {
      startNodeId: "t1",
      nodes: [
        { id: "t1", type: "trigger", trigger: "manual", config: {}, next: "d1", position: { x: 0, y: 0 } },
        { id: "d1", type: "create_deal", title: "X", value: -5, next: null, position: { x: 0, y: 80 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "d1" }],
    };
    const res = await app.request("/flows", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Bad deal flow", trigger: { type: "manual", config: {} }, graph }),
    });
    expect(res.status).toBe(400);
  });
});
