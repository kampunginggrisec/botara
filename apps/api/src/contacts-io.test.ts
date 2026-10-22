import { describe, expect, test } from "bun:test";
import {
  MAX_IMPORT_ROWS, contactsToCsv, contactsToJson, dedupeImportRows, parseCsv, parseImport,
  type ExportContact,
} from "./contacts-io";

/**
 * Contact import/export pure logic: CSV edge cases, header mapping,
 * identity derivation (phone -> whatsapp externalId, email -> email
 * externalId), file-level dedupe in both conflict modes, export escaping,
 * and the row cap.
 */

describe("parseCsv", () => {
  test("handles quoted commas, escaped quotes, and CRLF", () => {
    const rows = parseCsv('name,note\r\n"Doe, John","He said ""hi"""\r\nPlain,simple\r\n');
    expect(rows).toEqual([
      ["name", "note"],
      ["Doe, John", 'He said "hi"'],
      ["Plain", "simple"],
    ]);
  });

  test("keeps newlines inside quoted fields", () => {
    const rows = parseCsv('a,b\n"line1\nline2",x\n');
    expect(rows[1]).toEqual(["line1\nline2", "x"]);
  });
});

describe("parseImport (csv)", () => {
  test("maps headers, derives identity from phone, parses tags and field: columns", () => {
    const parsed = parseImport("csv", [
      "name,phone,tags,field:city",
      "Budi,62 812-3456,vip;lead,Jakarta",
    ].join("\n"));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([{
      row: 2,
      channel: "whatsapp",
      externalId: "628123456",
      displayName: "Budi",
      tags: ["vip", "lead"],
      customFields: { city: "Jakarta" },
    }]);
  });

  test("email becomes an email-channel identity; explicit externalId wins", () => {
    const byEmail = parseImport("csv", "email,name\nSiti@Example.com,Siti");
    expect(byEmail.rows[0]).toMatchObject({ channel: "email", externalId: "siti@example.com" });
    const explicit = parseImport("csv", "externalId,channel\nuser-42,telegram");
    expect(explicit.rows[0]).toMatchObject({ channel: "telegram", externalId: "user-42" });
  });

  test("rows without any identity become per-row errors, not a failed batch", () => {
    const parsed = parseImport("csv", "name\nNameless\nBudi,0812\n");
    // header only maps "name" - the second row has an unmapped cell and no identity either.
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors[0]!.row).toBe(2);
  });

  test("cap: more than MAX_IMPORT_ROWS rows is a typed VALIDATION error", () => {
    const lines = ["phone", ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `62812${i}`)];
    try {
      parseImport("csv", lines.join("\n"));
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("VALIDATION");
      expect((err as { status?: number }).status).toBe(400);
    }
  });
});

describe("parseImport (json)", () => {
  test("accepts contact objects with tags arrays and customFields", () => {
    const parsed = parseImport("json", JSON.stringify([
      { channel: "telegram", externalId: "777", name: "Tono", tags: ["a", "b"], customFields: { tier: "gold" } },
      { phone: "+62 813 999", displayName: "Wa User" },
      { nothing: true },
    ]));
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({ channel: "telegram", externalId: "777", tags: ["a", "b"], customFields: { tier: "gold" } });
    expect(parsed.rows[1]).toMatchObject({ channel: "whatsapp", externalId: "62813999" });
    expect(parsed.errors).toEqual([{ row: 3, message: expect.stringContaining("no externalId") }]);
  });

  test("rejects non-array JSON and invalid JSON with row errors", () => {
    expect(parseImport("json", "{}").errors).toHaveLength(1);
    expect(parseImport("json", "not json").errors).toHaveLength(1);
  });
});

describe("dedupeImportRows", () => {
  const rows = [
    { row: 2, channel: "whatsapp", externalId: "1", displayName: "First", tags: [], customFields: {} },
    { row: 3, channel: "whatsapp", externalId: "1", displayName: "Second", tags: [], customFields: {} },
    { row: 4, channel: "email", externalId: "1", displayName: "Other channel", tags: [], customFields: {} },
  ];

  test("skip keeps the first occurrence per (channel, externalId)", () => {
    const { rows: kept, duplicates } = dedupeImportRows(rows, "skip");
    expect(duplicates).toBe(1);
    expect(kept.map((r) => r.displayName)).toEqual(["First", "Other channel"]);
  });

  test("update keeps the last occurrence", () => {
    const { rows: kept, duplicates } = dedupeImportRows(rows, "update");
    expect(duplicates).toBe(1);
    expect(kept.map((r) => r.displayName)).toEqual(["Second", "Other channel"]);
  });
});

describe("export", () => {
  const contacts: ExportContact[] = [
    { channel: "whatsapp", externalId: "62812", displayName: 'Doe, "John"', tags: ["vip", "lead"], customFields: { city: "Jakarta" } },
    { channel: "email", externalId: "a@b.co", displayName: null, tags: [], customFields: {} },
  ];

  test("CSV export escapes commas/quotes and derives phone/email columns", () => {
    const csv = contactsToCsv(contacts);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("channel,externalId,phone,email,name,tags,field:city");
    expect(lines[1]).toBe('whatsapp,62812,62812,,"Doe, ""John""",vip;lead,Jakarta');
    expect(lines[2]).toBe("email,a@b.co,,a@b.co,,,");
  });

  test("an export round-trips through the importer", () => {
    const csv = contactsToCsv(contacts);
    const parsed = parseImport("csv", csv);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      channel: "whatsapp", externalId: "62812", displayName: 'Doe, "John"',
      tags: ["vip", "lead"], customFields: { city: "Jakarta" },
    });
  });

  test("JSON export carries the same identity fields", () => {
    const parsed = JSON.parse(contactsToJson(contacts)) as Array<Record<string, unknown>>;
    expect(parsed[0]).toMatchObject({ channel: "whatsapp", externalId: "62812", phone: "62812" });
    expect(parsed[1]).toMatchObject({ channel: "email", externalId: "a@b.co", email: "a@b.co" });
  });
});
