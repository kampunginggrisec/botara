import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AIProvider } from "@botara/ai";
import { createApp, type ApiDeps } from "./app";
import { createFakeDatabase, type FakeDatabase } from "./fake-db";
import { registerUser, testDeps, type Registered } from "./test-helpers";

/**
 * POST /kb/documents/upload: multipart file upload -> server-side text
 * extraction (PDF/DOCX/TXT/MD) -> the SAME document-create + kb-ingest
 * pipeline as typed documents. Original files are never stored; only
 * the extracted text + the source filename (provenance) persist.
 */

const fakeProvider: AIProvider = {
  name: "fake",
  async chatCompletion() { return { text: "ok", model: "fake-1" }; },
  async embedding() { return [0.1, 0.2]; },
};

interface Enqueued { workspaceId: string; documentId: string }

function makeKbApp(overrides: Partial<ApiDeps> = {}) {
  const fake = createFakeDatabase();
  const enqueued: Enqueued[] = [];
  const app = createApp(testDeps({
    getDatabase: () => fake.db,
    getAiProvider: () => fakeProvider,
    kbEnqueuer: { async enqueueKbIngest(input) { enqueued.push(input); } },
    ...overrides,
  }));
  return { app, fake, enqueued };
}

type TestApp = ReturnType<typeof createApp>;

function upload(app: TestApp, reg: Registered, file: File, title?: string) {
  const form = new FormData();
  form.append("file", file);
  if (title !== undefined) form.append("title", title);
  return app.request("/kb/documents/upload", { method: "POST", headers: reg.headers, body: form });
}

const FIXTURES = join(import.meta.dir, "fixtures");
const pdfFixture = readFileSync(join(FIXTURES, "kb-hello.pdf"));
const emptyPdfFixture = readFileSync(join(FIXTURES, "kb-empty.pdf"));
const docxFixture = readFileSync(join(FIXTURES, "kb-hello.docx"));

const TXT_CONTENT = "Jam operasional Botara: Senin-Jumat 09.00-17.00 WIB.";

let fake: FakeDatabase;
let enqueued: Enqueued[];
let app: TestApp;
let owner: Registered;
let other: Registered;
let txtDocumentId: string;

beforeAll(async () => {
  const made = makeKbApp();
  fake = made.fake;
  enqueued = made.enqueued;
  app = made.app;
  owner = await registerUser(app, "kb-owner@example.com", "KB Owner");
  other = await registerUser(app, "kb-other@example.com", "KB Other");
});

describe("POST /kb/documents/upload", () => {
  test("TXT upload: persists via the shared pipeline, enqueues ingest exactly once, keeps provenance", async () => {
    const before = enqueued.length;
    const res = await upload(app, owner, new File([TXT_CONTENT], "faq.txt", { type: "text/plain" }), "FAQ Operasional");
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      document: { id: string; title: string; sourceFilename?: string };
      extraction: { format: string; chars: number; truncated: boolean; sourceFilename: string };
    };
    expect(body.document.title).toBe("FAQ Operasional");
    expect(body.document.sourceFilename).toBe("faq.txt");
    expect(body.extraction.format).toBe("txt");
    expect(body.extraction.chars).toBe(TXT_CONTENT.length);
    expect(body.extraction.truncated).toBe(false);
    expect(body.extraction.sourceFilename).toBe("faq.txt");
    txtDocumentId = body.document.id;

    expect(enqueued.length).toBe(before + 1);
    expect(enqueued[enqueued.length - 1]).toEqual({ workspaceId: owner.workspaceId, documentId: txtDocumentId });

    const row = fake.rows.kbDocuments.find((r) => r.id === txtDocumentId);
    expect(row?.sourceText).toBe(TXT_CONTENT);
    expect(row?.sourceFilename).toBe("faq.txt");
  });

  test("list + single fetch expose sourceFilename; stored content round-trips", async () => {
    const list = await app.request("/kb/documents", { headers: owner.headers });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { documents: Array<{ id: string; sourceFilename?: string }> };
    const listed = listBody.documents.find((d) => d.id === txtDocumentId);
    expect(listed?.sourceFilename).toBe("faq.txt");

    const single = await app.request(`/kb/documents/${txtDocumentId}`, { headers: owner.headers });
    expect(single.status).toBe(200);
    const singleBody = (await single.json()) as { document: { content: string; sourceFilename?: string } };
    expect(singleBody.document.content).toBe(TXT_CONTENT);
    expect(singleBody.document.sourceFilename).toBe("faq.txt");
  });

  test("MD upload without a title derives the title from the filename", async () => {
    const res = await upload(app, owner, new File(["# Harga\n\nPaket mulai Rp99.000."], "panduan-harga.md"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { document: { title: string }; extraction: { format: string } };
    expect(body.document.title).toBe("panduan harga");
    expect(body.extraction.format).toBe("md");
  });

  test("PDF fixture upload extracts the text layer", async () => {
    const res = await upload(app, owner, new File([new Uint8Array(pdfFixture)], "kb-hello.pdf", { type: "application/pdf" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      document: { id: string }; extraction: { format: string; chars: number };
    };
    expect(body.extraction.format).toBe("pdf");
    expect(body.extraction.chars).toBeGreaterThan(0);
    const single = await app.request(`/kb/documents/${body.document.id}`, { headers: owner.headers });
    const singleBody = (await single.json()) as { document: { content: string } };
    expect(singleBody.document.content).toContain("jam operasional 09.00-17.00");
  });

  test("DOCX fixture upload extracts the raw text", async () => {
    const res = await upload(app, owner, new File([new Uint8Array(docxFixture)], "kb-hello.docx"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      document: { id: string }; extraction: { format: string };
    };
    expect(body.extraction.format).toBe("docx");
    const single = await app.request(`/kb/documents/${body.document.id}`, { headers: owner.headers });
    const singleBody = (await single.json()) as { document: { content: string } };
    expect(singleBody.document.content).toContain("Rp99.000");
  });

  test("wrong extension -> 400, nothing stored or enqueued", async () => {
    const docsBefore = fake.rows.kbDocuments.length;
    const enqueuedBefore = enqueued.length;
    const res = await upload(app, owner, new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "notes.png"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
    expect(fake.rows.kbDocuments.length).toBe(docsBefore);
    expect(enqueued.length).toBe(enqueuedBefore);
  });

  test("magic-byte mismatch -> 400 (text named .pdf, PDF named .docx)", async () => {
    const fakePdf = await upload(app, owner, new File(["plain text, not a pdf"], "fake.pdf"));
    expect(fakePdf.status).toBe(400);
    const fakeDocx = await upload(app, owner, new File([new Uint8Array(pdfFixture)], "fake.docx"));
    expect(fakeDocx.status).toBe(400);
  });

  test("empty-text PDF (no text layer) -> 422 explaining OCR is unsupported", async () => {
    const res = await upload(app, owner, new File([new Uint8Array(emptyPdfFixture)], "scan.pdf", { type: "application/pdf" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.message).toContain("OCR");
  });

  test("corrupt PDF (valid magic, garbage body) -> 422", async () => {
    const res = await upload(app, owner, new File(["%PDF-1.4 total garbage not a real pdf"], "broken.pdf"));
    expect(res.status).toBe(422);
  });

  test("missing file field -> 400", async () => {
    const form = new FormData();
    form.append("title", "No file here");
    const res = await app.request("/kb/documents/upload", { method: "POST", headers: owner.headers, body: form });
    expect(res.status).toBe(400);
  });

  test("unauthenticated -> 401", async () => {
    const form = new FormData();
    form.append("file", new File([TXT_CONTENT], "faq.txt"));
    const res = await app.request("/kb/documents/upload", { method: "POST", body: form });
    expect(res.status).toBe(401);
  });

  test("cross-workspace isolation: the other workspace sees neither list entry nor document", async () => {
    const list = await app.request("/kb/documents", { headers: other.headers });
    const listBody = (await list.json()) as { documents: Array<{ id: string }> };
    expect(listBody.documents.map((d) => d.id)).not.toContain(txtDocumentId);
    const single = await app.request(`/kb/documents/${txtDocumentId}`, { headers: other.headers });
    expect(single.status).toBe(404);
  });
});

describe("POST /kb/documents/upload limits + provider gate", () => {
  test("oversize file -> 400 with the injected byte limit", async () => {
    const { app: limited } = makeKbApp({ kbUploadLimits: { maxFileBytes: 10 } });
    const reg = await registerUser(limited, "kb-limit@example.com", "KB Limit");
    const res = await upload(limited, reg, new File(["0123456789ABCDEFGHIJ"], "big.txt"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.message).toContain("too large");
  });

  test("extracted text over the cap is accepted, truncated, and flagged", async () => {
    const { app: capped, enqueued: cappedEnqueued } = makeKbApp({ kbUploadLimits: { maxTextChars: 10 } });
    const reg = await registerUser(capped, "kb-cap@example.com", "KB Cap");
    const res = await upload(capped, reg, new File(["0123456789ABCDEFGHIJ"], "long.txt"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      document: { id: string }; extraction: { chars: number; truncated: boolean };
    };
    expect(body.extraction.truncated).toBe(true);
    expect(body.extraction.chars).toBe(10);
    expect(cappedEnqueued).toHaveLength(1);
    const single = await capped.request(`/kb/documents/${body.document.id}`, { headers: reg.headers });
    const singleBody = (await single.json()) as { document: { content: string } };
    expect(singleBody.document.content).toBe("0123456789");
  });

  test("without an AI provider -> 503 CONFIGURATION, nothing stored or enqueued", async () => {
    const { app: noAi, fake: noAiFake, enqueued: noAiEnqueued } = makeKbApp({ getAiProvider: () => null });
    const reg = await registerUser(noAi, "kb-noai@example.com", "KB NoAI");
    const res = await upload(noAi, reg, new File([TXT_CONTENT], "faq.txt"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFIGURATION");
    expect(noAiFake.rows.kbDocuments).toHaveLength(0);
    expect(noAiEnqueued).toHaveLength(0);
  });
});
