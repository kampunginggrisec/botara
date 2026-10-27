import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  WEBHOOK_RECEIPT_SUMMARY_MAX,
  truncateWebhookPayloadSummary,
  webhookReceiptExpiredWhere,
  webhookReceiptListWhere,
} from "./repositories";

/**
 * Inbound webhook receipts (Admin → Webhook log): the pure contracts
 * behind create/list/retention, tested without a Postgres - the same
 * dialect-rendering pattern as invite-consumable.test.ts. Storage
 * failures must never leak raw JS values (Dates/objects) into driver
 * params, and the summary cap is a hard bound (marker included).
 */
describe("truncateWebhookPayloadSummary", () => {
  test("short bodies pass through unchanged", () => {
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    expect(truncateWebhookPayloadSummary(raw)).toBe(raw);
  });

  test("a body exactly at the cap is unchanged", () => {
    const raw = "x".repeat(WEBHOOK_RECEIPT_SUMMARY_MAX);
    expect(truncateWebhookPayloadSummary(raw)).toBe(raw);
  });

  test("an over-cap body is cut to the cap with a clear marker", () => {
    const raw = JSON.stringify({ data: "y".repeat(10_000) });
    const out = truncateWebhookPayloadSummary(raw);
    expect(out.length).toBe(WEBHOOK_RECEIPT_SUMMARY_MAX);
    expect(out.endsWith("…[truncated]")).toBe(true);
    expect(out.startsWith(raw.slice(0, 100))).toBe(true);
  });
});

describe("webhookReceiptListWhere", () => {
  const dialect = new PgDialect();

  test("no filters -> no WHERE clause", () => {
    expect(webhookReceiptListWhere({})).toBeUndefined();
    expect(webhookReceiptListWhere({ limit: 10 })).toBeUndefined();
  });

  test("channel filter renders an equality on the channel column", () => {
    const query = dialect.sqlToQuery(webhookReceiptListWhere({ channel: "whatsapp" })!);
    expect(query.sql).toContain("\"channel\"");
    expect(query.params).toEqual(["whatsapp"]);
  });

  test("channel + outcome filters combine; params stay plain strings", () => {
    const query = dialect.sqlToQuery(
      webhookReceiptListWhere({ channel: "telegram", outcome: "error" })!,
    );
    expect(query.sql).toContain("\"channel\"");
    expect(query.sql).toContain("\"outcome\"");
    expect(query.params).toEqual(["telegram", "error"]);
    for (const param of query.params) expect(typeof param).toBe("string");
  });
});

describe("webhookReceiptExpiredWhere", () => {
  test("the cutoff travels as the column-encoded value, never a raw Date param", () => {
    const cutoff = new Date("2026-10-20T03:30:00.000Z");
    const query = new PgDialect().sqlToQuery(webhookReceiptExpiredWhere(cutoff));
    expect(query.sql).toContain("\"created_at\"");
    for (const param of query.params) expect(param instanceof Date).toBe(false);
    expect(query.params).toContain(cutoff.toISOString());
  });
});
