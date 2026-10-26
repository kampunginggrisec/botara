import {
  auditLog, broadcastRecipients, broadcasts, catalogProducts, channelAccounts, contacts, conversations, costLedger, deals, flows, flowWaits, growthLinks,
  kbChunks, kbDocuments,
  messages, pipelines, pipelineStages, processedComments, savedReplies, scheduledPosts, sequenceEnrollments, sequences, templates, webchatSessions,
  workspaceDomains, workspaces,
  type Database,
} from "@botara/db";

/**
 * In-memory fake of the Drizzle `Database` surface, covering exactly the
 * query-builder chains the @botara/db repositories use for the webchat /
 * inbox paths (select with eq filters, inner joins, projections, insert,
 * update, delete). It exists so route-level regression tests can run
 * against the REAL repository code without a Postgres - the bug class it
 * guards (the webchat double-persist) lived precisely in that seam.
 *
 * Conditions are read by walking the Drizzle SQL query chunks: only `=`
 * comparisons between a column and a param (filters) or between two
 * columns (join keys) are supported; anything else throws, so a future
 * repository change fails this fake loudly instead of silently passing.
 * Each createFakeDatabase() is fully independent (state lives in the
 * factory closure, never in module globals).
 */

type Row = Record<string, unknown>;

/** JS property key for a Drizzle column object within its table. */
function columnKey(column: { table: unknown }): string {
  for (const [key, value] of Object.entries(column.table as Record<string, unknown>)) {
    if (value === column) return key;
  }
  throw new Error("fake-db: cannot resolve column key");
}

function isColumn(chunk: unknown): chunk is { table: unknown; name: string } {
  return (
    typeof chunk === "object" && chunk !== null &&
    "columnType" in chunk && "table" in chunk && "name" in chunk
  );
}

type Token =
  | { kind: "text"; text: string }
  | { kind: "column"; table: unknown; key: string }
  | { kind: "param"; value: unknown };

function tokenize(node: unknown, out: Token[] = []): Token[] {
  if (Array.isArray(node)) {
    for (const item of node) tokenize(item, out);
    return out;
  }
  if (typeof node !== "object" || node === null) return out;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.queryChunks)) {
    for (const chunk of obj.queryChunks) tokenize(chunk, out);
    return out;
  }
  if (isColumn(node)) {
    out.push({ kind: "column", table: node.table, key: columnKey(node) });
    return out;
  }
  if (obj.constructor?.name === "Param" && "value" in obj) {
    out.push({ kind: "param", value: obj.value });
    return out;
  }
  if (obj.constructor?.name === "StringChunk" && Array.isArray(obj.value)) {
    out.push({ kind: "text", text: (obj.value as string[]).join("") });
    return out;
  }
  return out;
}

interface EqFilter { table: unknown; key: string; value: unknown }
interface JoinEq { aTable: unknown; aKey: string; bTable: unknown; bKey: string }

function parseCondition(cond: unknown): { filters: EqFilter[]; joins: JoinEq[] } {
  const tokens = tokenize(cond);
  const filters: EqFilter[] = [];
  const joins: JoinEq[] = [];
  for (let i = 0; i + 2 < tokens.length + 1; i++) {
    const a = tokens[i];
    const mid = tokens[i + 1];
    const b = tokens[i + 2];
    if (!a || !mid || !b) break;
    if (a.kind === "column" && mid.kind === "text" && mid.text.includes("=")) {
      if (b.kind === "param") filters.push({ table: a.table, key: a.key, value: b.value });
      else if (b.kind === "column") joins.push({ aTable: a.table, aKey: a.key, bTable: b.table, bKey: b.key });
    }
  }
  return { filters, joins };
}

function parseOrder(orderArg: unknown): { table: unknown; key: string; desc: boolean } | null {
  const tokens = tokenize(orderArg);
  const col = tokens.find((t) => t.kind === "column");
  if (!col || col.kind !== "column") return null;
  const desc = tokens.some((t) => t.kind === "text" && t.text.includes("desc"));
  return { table: col.table, key: col.key, desc };
}

/** Per-instance table registry: table object -> its in-memory rows. */
class FakeCore {
  readonly tables = new Map<unknown, Row[]>();
  register(table: unknown, rows: Row[]): void { this.tables.set(table, rows); }
  rowsOf(table: unknown): Row[] {
    const rows = this.tables.get(table);
    if (!rows) throw new Error("fake-db: unknown table object");
    return rows;
  }
  has(table: unknown): boolean { return this.tables.has(table); }
}

/** A combined result row while joins are in play: one source row per table. */
type JoinedRow = Map<unknown, Row>;

class FakeSelect {
  private fromTable: unknown = null;
  private readonly joinSteps: Array<{ table: unknown; cond: unknown }> = [];
  private whereCond: unknown = null;
  private readonly orders: unknown[] = [];
  private limitCount: number | null = null;

  constructor(
    private readonly core: FakeCore,
    private readonly projection: Record<string, unknown> | undefined,
  ) {}

  from(table: unknown): this { this.fromTable = table; return this; }
  innerJoin(table: unknown, cond: unknown): this { this.joinSteps.push({ table, cond }); return this; }
  where(cond: unknown): this { this.whereCond = cond; return this; }
  orderBy(...args: unknown[]): this { this.orders.push(...args); return this; }
  limit(n: number): this { this.limitCount = n; return this; }

  private execute(): Row[] {
    if (this.fromTable === null) throw new Error("fake-db: select without from()");
    let combined: JoinedRow[] = this.core.rowsOf(this.fromTable).map((row) => new Map([[this.fromTable, row]]));
    for (const step of this.joinSteps) {
      const { joins } = parseCondition(step.cond);
      const next: JoinedRow[] = [];
      for (const left of combined) {
        for (const right of this.core.rowsOf(step.table)) {
          const ok = joins.every((j) => {
            const lv = (j.aTable === step.table ? right : left.get(j.aTable))?.[j.aKey];
            const rv = (j.bTable === step.table ? right : left.get(j.bTable))?.[j.bKey];
            return lv === rv;
          });
          if (ok) next.push(new Map(left).set(step.table, right));
        }
      }
      combined = next;
    }
    if (this.whereCond !== null && this.whereCond !== undefined) {
      const { filters } = parseCondition(this.whereCond);
      combined = combined.filter((jr) => filters.every((f) => jr.get(f.table)?.[f.key] === f.value));
    }
    for (const orderArg of this.orders) {
      const order = parseOrder(orderArg);
      if (!order) continue;
      combined.sort((a, b) => {
        const av = a.get(order.table)?.[order.key] as string | number | Date | undefined;
        const bv = b.get(order.table)?.[order.key] as string | number | Date | undefined;
        const cmp = av instanceof Date && bv instanceof Date
          ? av.getTime() - bv.getTime()
          : String(av ?? "") < String(bv ?? "") ? -1 : String(av ?? "") > String(bv ?? "") ? 1 : 0;
        return order.desc ? -cmp : cmp;
      });
    }
    if (this.limitCount !== null) combined = combined.slice(0, this.limitCount);
    return combined.map((jr) => this.project(jr));
  }

  private project(jr: JoinedRow): Row {
    if (!this.projection) {
      const base = jr.get(this.fromTable);
      if (!base) throw new Error("fake-db: missing base row");
      if (jr.size > 1) throw new Error("fake-db: joins without projection are unsupported");
      return base;
    }
    const out: Row = {};
    for (const [key, val] of Object.entries(this.projection)) {
      if (isColumn(val)) {
        out[key] = jr.get(val.table)?.[columnKey(val)];
      } else if (this.core.has(val)) {
        out[key] = { ...jr.get(val) };
      } else {
        throw new Error(`fake-db: unsupported projection value for "${key}"`);
      }
    }
    return out;
  }

  then<TResult1 = Row[], TResult2 = never>(
    onFulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve().then(() => this.execute()).then(onFulfilled, onRejected);
  }
}

class FakeInsert {
  private valuesObj: Row = {};
  constructor(private readonly core: FakeCore, private readonly table: unknown) {}
  values(v: Row): this { this.valuesObj = v; return this; }
  returning(): this { return this; }
  then<TResult1 = Row[], TResult2 = never>(
    onFulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => {
        const hasUpdatedAt = Object.keys(this.table as Record<string, unknown>).includes("updatedAt");
        const row: Row = {
          id: crypto.randomUUID(),
          createdAt: new Date(),
          ...(hasUpdatedAt ? { updatedAt: new Date() } : {}),
          ...this.valuesObj,
        };
        // Enforce the conversations_open_unique_idx partial unique index
        // (one NON-RESOLVED conversation per channel account + contact)
        // the way Postgres does: a clashing insert fails with SQLSTATE
        // 23505, so the repository's race fallback is exercised against
        // this fake exactly as it is against a real database.
        if (this.table === conversations && row.status !== "resolved") {
          const clash = this.core.rowsOf(this.table).some(
            (r) => r.channelAccountId === row.channelAccountId
              && r.contactId === row.contactId
              && r.status !== "resolved",
          );
          if (clash) {
            const err = new Error(
              'duplicate key value violates unique constraint "conversations_open_unique_idx"',
            ) as Error & { code: string; constraint_name: string };
            err.code = "23505";
            err.constraint_name = "conversations_open_unique_idx";
            throw err;
          }
        }
        this.core.rowsOf(this.table).push(row);
        return [row];
      })
      .then(onFulfilled, onRejected);
  }
}

class FakeUpdate {
  private setObj: Row = {};
  private whereCond: unknown = null;
  constructor(private readonly core: FakeCore, private readonly table: unknown) {}
  set(v: Row): this { this.setObj = v; return this; }
  where(cond: unknown): this { this.whereCond = cond; return this; }
  returning(): this { return this; }
  then<TResult1 = Row[], TResult2 = never>(
    onFulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => {
        const { filters } = parseCondition(this.whereCond);
        const affected: Row[] = [];
        for (const row of this.core.rowsOf(this.table)) {
          if (filters.every((f) => row[f.key] === f.value)) {
            Object.assign(row, this.setObj);
            affected.push(row);
          }
        }
        return affected;
      })
      .then(onFulfilled, onRejected);
  }
}

class FakeDelete {
  private whereCond: unknown = null;
  constructor(private readonly core: FakeCore, private readonly table: unknown) {}
  where(cond: unknown): this { this.whereCond = cond; return this; }
  then<TResult1 = void, TResult2 = never>(
    onFulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => {
        const { filters } = parseCondition(this.whereCond);
        const rows = this.core.rowsOf(this.table);
        for (let i = rows.length - 1; i >= 0; i--) {
          if (filters.every((f) => rows[i]![f.key] === f.value)) rows.splice(i, 1);
        }
      })
      .then(onFulfilled, onRejected);
  }
}

export interface FakeDatabase {
  db: Database;
  rows: {
    messages: Row[];
    conversations: Row[];
    contacts: Row[];
    channelAccounts: Row[];
    webchatSessions: Row[];
    catalogProducts: Row[];
    broadcasts: Row[];
    broadcastRecipients: Row[];
    templates: Row[];
    sequences: Row[];
    sequenceEnrollments: Row[];
    processedComments: Row[];
    growthLinks: Row[];
    costLedger: Row[];
    workspaceDomains: Row[];
    scheduledPosts: Row[];
    auditLog: Row[];
    kbDocuments: Row[];
    kbChunks: Row[];
    savedReplies: Row[];
    flowWaits: Row[];
    flows: Row[];
    workspaces: Row[];
    pipelines: Row[];
    pipelineStages: Row[];
    deals: Row[];
  };
  seed(table: keyof FakeDatabase["rows"], row: Row): Row;
}

export function createFakeDatabase(): FakeDatabase {
  const store = {
    messages: [] as Row[],
    conversations: [] as Row[],
    contacts: [] as Row[],
    channelAccounts: [] as Row[],
    webchatSessions: [] as Row[],
    catalogProducts: [] as Row[],
    broadcasts: [] as Row[],
    broadcastRecipients: [] as Row[],
    templates: [] as Row[],
    sequences: [] as Row[],
    sequenceEnrollments: [] as Row[],
    processedComments: [] as Row[],
    growthLinks: [] as Row[],
    costLedger: [] as Row[],
    workspaceDomains: [] as Row[],
    scheduledPosts: [] as Row[],
    auditLog: [] as Row[],
    kbDocuments: [] as Row[],
    kbChunks: [] as Row[],
    savedReplies: [] as Row[],
    flowWaits: [] as Row[],
    flows: [] as Row[],
    workspaces: [] as Row[],
    pipelines: [] as Row[],
    pipelineStages: [] as Row[],
    deals: [] as Row[],
  };
  const core = new FakeCore();
  core.register(messages, store.messages);
  core.register(conversations, store.conversations);
  core.register(contacts, store.contacts);
  core.register(channelAccounts, store.channelAccounts);
  core.register(webchatSessions, store.webchatSessions);
  core.register(catalogProducts, store.catalogProducts);
  core.register(broadcasts, store.broadcasts);
  core.register(broadcastRecipients, store.broadcastRecipients);
  core.register(templates, store.templates);
  core.register(sequences, store.sequences);
  core.register(sequenceEnrollments, store.sequenceEnrollments);
  core.register(processedComments, store.processedComments);
  core.register(growthLinks, store.growthLinks);
  core.register(costLedger, store.costLedger);
  core.register(workspaceDomains, store.workspaceDomains);
  core.register(scheduledPosts, store.scheduledPosts);
  core.register(auditLog, store.auditLog);
  core.register(kbDocuments, store.kbDocuments);
  core.register(kbChunks, store.kbChunks);
  core.register(savedReplies, store.savedReplies);
  core.register(flowWaits, store.flowWaits);
  core.register(flows, store.flows);
  core.register(workspaces, store.workspaces);
  core.register(pipelines, store.pipelines);
  core.register(pipelineStages, store.pipelineStages);
  core.register(deals, store.deals);

  const impl = {
    select: (projection?: Record<string, unknown>) => new FakeSelect(core, projection),
    insert: (table: unknown) => new FakeInsert(core, table),
    update: (table: unknown) => new FakeUpdate(core, table),
    delete: (table: unknown) => new FakeDelete(core, table),
    // No rollback semantics: the callback runs against the same store.
    // Repository code uses transactions for atomicity on real Postgres;
    // the fake only needs the same call shape.
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(impl),
  };

  return {
    db: impl as unknown as Database,
    rows: store,
    seed(table, row) {
      const full: Row = { id: crypto.randomUUID(), createdAt: new Date(), ...row };
      store[table].push(full);
      return full;
    },
  };
}
