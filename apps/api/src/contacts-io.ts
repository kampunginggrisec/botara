import { AppError } from "@botara/shared";

/**
 * Contact import/export (adopted-features package) - pure parsing and
 * serialization logic behind POST /contacts/import and
 * GET /contacts/export. Kept free of DB access so the edge cases (CSV
 * quoting, dedupe, escaping, the row cap) are unit-testable directly.
 *
 * Contact identity in Botara is (workspace, channel, externalId) - there
 * are no separate phone/email columns, so an imported phone number BECOMES
 * the externalId of a whatsapp contact and an email address becomes the
 * externalId of an email contact. Import columns:
 *
 *   channel     - explicit channel key (default derived from the row)
 *   externalId  - explicit identity (wins over phone/email)
 *   phone       - whatsapp identity when no externalId is given
 *   email       - email-channel identity when no externalId/phone is given
 *   name | displayName
 *   tags        - semicolon-separated
 *   field:<key> - any extra column prefixed `field:` lands in customFields
 */

export const MAX_IMPORT_ROWS = 5000;

/**
 * Small robust CSV parser: quoted fields, "" escapes, embedded commas and
 * newlines inside quotes, CRLF or LF line endings. Returns rows of cells;
 * blank trailing lines are dropped.
 */
export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  const pushCell = () => { row.push(cell); cell = ""; };
  const pushRow = () => { pushCell(); rows.push(row); row = []; };
  while (i < content.length) {
    const ch = content[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      cell += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ",") { pushCell(); i += 1; continue; }
    if (ch === "\r") { i += 1; continue; } // CRLF: the \n ends the row
    if (ch === "\n") { pushRow(); i += 1; continue; }
    cell += ch; i += 1;
  }
  if (cell.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
}

/** Escape one CSV cell (quote when it contains a comma, quote, or newline). */
export function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface ImportRow {
  /** 1-based row number in the source (header is row 1 for CSV). */
  row: number;
  channel: string;
  externalId: string;
  displayName?: string;
  tags: string[];
  customFields: Record<string, unknown>;
}

export interface ImportRowError {
  row: number;
  message: string;
}

export interface ParsedImport {
  rows: ImportRow[];
  errors: ImportRowError[];
}

const normalizePhone = (raw: string): string => raw.replace(/[^\d]/g, "");

function rowFromFields(fields: Record<string, string>, rowNumber: number): ImportRow {
  const externalIdRaw = (fields.externalid ?? "").trim();
  const phone = normalizePhone(fields.phone ?? "");
  const email = (fields.email ?? "").trim().toLowerCase();
  let channel = (fields.channel ?? "").trim().toLowerCase();
  let externalId = externalIdRaw;
  if (!externalId && phone) externalId = phone;
  if (!externalId && email) externalId = email;
  if (!channel) {
    channel = externalIdRaw ? "whatsapp" : phone ? "whatsapp" : email ? "email" : "";
  }
  if (!externalId) {
    throw new Error("row has no externalId, phone, or email to identify the contact");
  }
  if (!channel) {
    throw new Error("row has no channel and none could be derived");
  }
  const tags = (fields.tags ?? "")
    .split(";")
    .map((t) => t.trim())
    .filter(Boolean);
  const customFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith("field:") && value.trim() !== "") {
      customFields[key.slice("field:".length)] = value;
    }
  }
  const displayName = (fields.displayname ?? fields.name ?? "").trim();
  return {
    row: rowNumber,
    channel,
    externalId,
    displayName: displayName || undefined,
    tags,
    customFields,
  };
}

/** Parse a CSV import payload: header row + one object per data row. */
export function parseCsvImport(content: string): ParsedImport {
  const table = parseCsv(content);
  if (table.length === 0) return { rows: [], errors: [{ row: 1, message: "empty CSV (a header row is required)" }] };
  const header = table[0]!.map((h) => h.trim().toLowerCase());
  const rows: ImportRow[] = [];
  const errors: ImportRowError[] = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i]!;
    const fields: Record<string, string> = {};
    header.forEach((name, idx) => { fields[name] = cells[idx] ?? ""; });
    try {
      rows.push(rowFromFields(fields, i + 1));
    } catch (err) {
      errors.push({ row: i + 1, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { rows, errors };
}

/** Parse a JSON import payload: an array of contact objects (same field names as CSV). */
export function parseJsonImport(content: string): ParsedImport {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return { rows: [], errors: [{ row: 0, message: "content is not valid JSON" }] };
  }
  if (!Array.isArray(data)) {
    return { rows: [], errors: [{ row: 0, message: "JSON import must be an array of contact objects" }] };
  }
  const rows: ImportRow[] = [];
  const errors: ImportRowError[] = [];
  data.forEach((item, idx) => {
    const rowNumber = idx + 1;
    if (typeof item !== "object" || item === null) {
      errors.push({ row: rowNumber, message: "entry is not an object" });
      return;
    }
    const obj = item as Record<string, unknown>;
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj)) {
      const lower = key.toLowerCase();
      if (lower === "tags" && Array.isArray(value)) {
        fields.tags = value.map(String).join(";");
      } else if (lower === "customfields" && typeof value === "object" && value !== null) {
        for (const [fk, fv] of Object.entries(value as Record<string, unknown>)) {
          fields[`field:${fk}`] = String(fv);
        }
      } else if (typeof value === "string" || typeof value === "number") {
        fields[lower] = String(value);
      }
    }
    // Explicit customFields keys also arrive via `field:` entries already.
    try {
      rows.push(rowFromFields(fields, rowNumber));
    } catch (err) {
      errors.push({ row: rowNumber, message: err instanceof Error ? err.message : String(err) });
    }
  });
  return { rows, errors };
}

export function parseImport(format: "csv" | "json", content: string): ParsedImport {
  const parsed = format === "csv" ? parseCsvImport(content) : parseJsonImport(content);
  if (parsed.rows.length + parsed.errors.length > MAX_IMPORT_ROWS) {
    throw new AppError(
      "VALIDATION",
      `Import exceeds the ${MAX_IMPORT_ROWS}-row cap (${parsed.rows.length + parsed.errors.length} rows). Split the file and import in batches.`,
      { status: 400, details: { maxRows: MAX_IMPORT_ROWS } },
    );
  }
  return parsed;
}

/**
 * Dedupe rows WITHIN one import file by (channel, externalId). "skip"
 * keeps the first occurrence; "update" keeps the last. Returns the kept
 * rows plus how many duplicates were dropped.
 */
export function dedupeImportRows(
  rows: ImportRow[],
  conflict: "skip" | "update",
): { rows: ImportRow[]; duplicates: number } {
  const byKey = new Map<string, ImportRow>();
  let duplicates = 0;
  for (const row of rows) {
    const key = `${row.channel}:${row.externalId}`;
    if (byKey.has(key)) {
      duplicates++;
      if (conflict === "skip") continue;
    }
    byKey.set(key, row);
  }
  return { rows: [...byKey.values()], duplicates };
}

// ------------------------------------------------------------------ export

export interface ExportContact {
  channel: string;
  externalId: string;
  displayName: string | null;
  tags: string[];
  customFields: Record<string, unknown>;
}

/**
 * Serialize the workspace contact set. Columns mirror the import format so
 * an export can be re-imported: channel, externalId, phone/email derived
 * from the channel identity, name, tags (`;`-joined), then one `field:`
 * column per custom-field key present anywhere in the set.
 */
export function contactsToCsv(contacts: ExportContact[]): string {
  const fieldKeys = [...new Set(contacts.flatMap((c) => Object.keys(c.customFields ?? {})))].sort();
  const header = ["channel", "externalId", "phone", "email", "name", "tags", ...fieldKeys.map((k) => `field:${k}`)];
  const lines = [header.join(",")];
  for (const contact of contacts) {
    const cells = [
      contact.channel,
      contact.externalId,
      contact.channel === "whatsapp" ? contact.externalId : "",
      contact.channel === "email" ? contact.externalId : "",
      contact.displayName ?? "",
      (contact.tags ?? []).join(";"),
      ...fieldKeys.map((k) => {
        const v = (contact.customFields ?? {})[k];
        return v === undefined || v === null ? "" : String(v);
      }),
    ];
    lines.push(cells.map(csvEscape).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export function contactsToJson(contacts: ExportContact[]): string {
  return JSON.stringify(
    contacts.map((c) => ({
      channel: c.channel,
      externalId: c.externalId,
      ...(c.channel === "whatsapp" ? { phone: c.externalId } : {}),
      ...(c.channel === "email" ? { email: c.externalId } : {}),
      name: c.displayName ?? undefined,
      tags: c.tags ?? [],
      customFields: c.customFields ?? {},
    })),
    null,
    2,
  );
}
