import { describe, expect, test } from "bun:test";
import {
  createConversation, findOpenConversation, isUniqueViolation, type Database,
} from "@botara/db";
import { createFakeDatabase } from "./fake-db";

/**
 * One-open-thread invariant (migration 0006): at most one NON-RESOLVED
 * conversation per (channel account, contact), backstopped in Postgres
 * by the partial unique index conversations_open_unique_idx. The fake
 * DB enforces the same index (throwing SQLSTATE 23505 on a clashing
 * insert), so these tests run the REAL repository fallback: a create
 * that loses the race returns the winner's thread instead of throwing
 * or duplicating.
 */

const WS = "ws-dedup";
const ACC = "acc-dedup";
const CONTACT = "contact-dedup";

describe("createConversation race fallback (fake DB enforces the partial unique index)", () => {
  test("a second create for the same account+contact returns the existing open thread", async () => {
    const fake = createFakeDatabase();
    const first = await createConversation(fake.db, {
      workspaceId: WS, channelAccountId: ACC, contactId: CONTACT,
    });
    expect(first.status).toBe("open");

    // Simulates the race loser: its find-open lookup raced the winner's
    // insert, so it goes straight to create and hits the index.
    const second = await createConversation(fake.db, {
      workspaceId: WS, channelAccountId: ACC, contactId: CONTACT,
    });
    expect(second.id).toBe(first.id);
    expect(fake.rows.conversations).toHaveLength(1);
  });

  test("a pending thread blocks a new create the same way an open one does", async () => {
    const fake = createFakeDatabase();
    const pending = await createConversation(fake.db, {
      workspaceId: WS, channelAccountId: ACC, contactId: CONTACT, status: "pending",
    });
    const again = await createConversation(fake.db, {
      workspaceId: WS, channelAccountId: ACC, contactId: CONTACT,
    });
    expect(again.id).toBe(pending.id);
    expect(fake.rows.conversations).toHaveLength(1);
  });

  test("a resolved thread does NOT block a fresh thread for the same contact", async () => {
    const fake = createFakeDatabase();
    const first = await createConversation(fake.db, {
      workspaceId: WS, channelAccountId: ACC, contactId: CONTACT,
    });
    const firstRow = fake.rows.conversations.find((c) => c.id === first.id)!;
    firstRow.status = "resolved";
    // Real Postgres created_at values differ per insert; the fake stamps
    // both rows within the same millisecond, so order them explicitly -
    // findOpenConversation reads the newest thread first.
    firstRow.createdAt = new Date(Date.now() - 60_000);

    const fresh = await createConversation(fake.db, {
      workspaceId: WS, channelAccountId: ACC, contactId: CONTACT,
    });
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.status).toBe("open");
    expect(fake.rows.conversations).toHaveLength(2);

    const open = await findOpenConversation(fake.db, {
      workspaceId: WS, channelAccountId: ACC, contactId: CONTACT,
    });
    expect(open?.id).toBe(fresh.id);
  });

  test("a different contact on the same account is unaffected", async () => {
    const fake = createFakeDatabase();
    const a = await createConversation(fake.db, {
      workspaceId: WS, channelAccountId: ACC, contactId: CONTACT,
    });
    const b = await createConversation(fake.db, {
      workspaceId: WS, channelAccountId: ACC, contactId: "contact-other",
    });
    expect(b.id).not.toBe(a.id);
    expect(fake.rows.conversations).toHaveLength(2);
  });
});

describe("createConversation error discipline (stub DB)", () => {
  const throwingDb = (thrown: unknown, selectRows: unknown[] = []): Database => ({
    insert: () => ({
      values: () => ({
        returning: async () => { throw thrown; },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => selectRows,
          }),
        }),
      }),
    }),
  }) as unknown as Database;

  test("a non-unique-violation error propagates untouched", async () => {
    const boom = Object.assign(new Error("connection lost"), { code: "XX000" });
    await expect(
      createConversation(throwingDb(boom), { workspaceId: WS, channelAccountId: ACC, contactId: CONTACT }),
    ).rejects.toBe(boom);
  });

  test("a 23505 with no existing open thread rethrows instead of swallowing", async () => {
    const violation = Object.assign(new Error("duplicate key"), { code: "23505" });
    await expect(
      createConversation(throwingDb(violation), { workspaceId: WS, channelAccountId: ACC, contactId: CONTACT }),
    ).rejects.toBe(violation);
  });

  test("a 23505 for a resolved insert rethrows (resolved rows sit outside the partial index)", async () => {
    const violation = Object.assign(new Error("duplicate key"), { code: "23505" });
    await expect(
      createConversation(throwingDb(violation), {
        workspaceId: WS, channelAccountId: ACC, contactId: CONTACT, status: "resolved",
      }),
    ).rejects.toBe(violation);
  });
});

describe("isUniqueViolation", () => {
  test("detects a bare PostgresError-shaped object", () => {
    expect(isUniqueViolation(Object.assign(new Error("dup"), { code: "23505" }))).toBe(true);
  });

  test("detects a violation wrapped in a cause chain (drizzle wrapping)", () => {
    const inner = Object.assign(new Error("dup"), { code: "23505" });
    expect(isUniqueViolation(new Error("query failed", { cause: inner }))).toBe(true);
    expect(isUniqueViolation({ cause: { cause: inner } })).toBe(true);
  });

  test("rejects other codes and non-error values", () => {
    expect(isUniqueViolation(Object.assign(new Error("fk"), { code: "23503" }))).toBe(false);
    expect(isUniqueViolation(new Error("plain"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });
});
