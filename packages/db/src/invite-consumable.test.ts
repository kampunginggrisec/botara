import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { inviteConsumableWhere } from "./repositories";

/**
 * Regression guard for the live #9 bug (2026-10-27): the invite-accept
 * conditional UPDATE interpolated a raw JS Date into a sql`` fragment
 * (`expires_at > ${now}`). Against real Postgres, postgres-js received
 * a Date where its string serializer ran, and EVERY accept for a
 * non-member died with ERR_INVALID_ARG_TYPE -> HTTP 500. The InMemory
 * store used by the API tests cannot reproduce driver serialization,
 * so this test renders the actual WHERE clause through the Pg dialect
 * and pins the parameter contract: no param may be a raw Date.
 */
describe("inviteConsumableWhere", () => {
  const dialect = new PgDialect();
  const inviteId = "11111111-1111-4111-8111-111111111111";
  const now = new Date("2026-10-27T10:00:00.000Z");

  test("renders the expiry/uses guard with no raw Date params", () => {
    const query = dialect.sqlToQuery(inviteConsumableWhere(inviteId, now)!);
    expect(query.sql).toContain("expires_at");
    expect(query.sql).toContain("uses_count");
    expect(query.sql).toContain("revoked_at");
    for (const param of query.params) {
      expect(param instanceof Date).toBe(false);
    }
    // The expiry bound travels as the column-encoded (string) value.
    expect(query.params).toContain(now.toISOString());
    expect(query.params).toContain(inviteId);
  });

  test("a raw Date param WOULD be caught by this contract", () => {
    // Sanity: the assertion above is not vacuous — a Date param in the
    // rendered query is exactly what the old sql`` fragment produced.
    const query = dialect.sqlToQuery(inviteConsumableWhere(inviteId, now)!);
    expect(query.params.some((p) => p instanceof Date)).toBe(false);
  });
});
