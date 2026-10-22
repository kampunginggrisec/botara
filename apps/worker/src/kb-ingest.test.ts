import { describe, expect, test } from "bun:test";
import { processKbIngest, type KbIngestPorts } from "./kb-ingest";

/** Fase 3 KB ingestion with fake ports: chunk -> embed -> store -> ready. */

function fakePorts(content: string, opts: { failEmbed?: boolean } = {}) {
  const stored: Array<{ chunkIndex: number; text: string; embedding: number[] }> = [];
  const marks: Array<{ status: string; detail?: string | number }> = [];
  const ports: KbIngestPorts = {
    async loadDocument() {
      return { id: "doc-1", workspaceId: "ws-1", title: "FAQ", content };
    },
    async embed(texts) {
      if (opts.failEmbed) throw new Error("provider down");
      // Deterministic toy embeddings: [length, first-char code].
      return texts.map((t) => [t.length, t.charCodeAt(0) || 0]);
    },
    async replaceChunks(_ws, _doc, chunks) { stored.push(...chunks); },
    async markReady(_id, count) { marks.push({ status: "ready", detail: count }); },
    async markFailed(_id, error) { marks.push({ status: "failed", detail: error }); },
  };
  return { ports, stored, marks };
}

describe("kb-ingest processor (fake ports)", () => {
  test("a long document is chunked, every chunk embedded, then marked ready", async () => {
    const content = "Panduan pengiriman. ".repeat(200); // ~4200 chars
    const f = fakePorts(content);
    const result = await processKbIngest(f.ports, { workspaceId: "ws-1", documentId: "doc-1" });
    expect(result.chunks).toBeGreaterThan(3);
    expect(f.stored).toHaveLength(result.chunks);
    for (const [i, chunk] of f.stored.entries()) {
      expect(chunk.chunkIndex).toBe(i);
      expect(chunk.embedding).toHaveLength(2);
      expect(chunk.text.length).toBeGreaterThan(0);
    }
    expect(f.marks).toEqual([{ status: "ready", detail: result.chunks }]);
  });

  test("a short document yields exactly one chunk", async () => {
    const f = fakePorts("Jam buka 09.00-17.00.");
    const result = await processKbIngest(f.ports, { workspaceId: "ws-1", documentId: "doc-1" });
    expect(result.chunks).toBe(1);
    expect(f.stored[0]!.text).toBe("Jam buka 09.00-17.00.");
  });

  test("an embedding failure marks the document failed and the job throws (retryable)", async () => {
    const f = fakePorts("isi dokumen", { failEmbed: true });
    await expect(
      processKbIngest(f.ports, { workspaceId: "ws-1", documentId: "doc-1" }),
    ).rejects.toThrow("provider down");
    expect(f.marks).toEqual([{ status: "failed", detail: "provider down" }]);
    expect(f.stored).toHaveLength(0);
  });

  test("a missing document throws without any marks", async () => {
    const f = fakePorts("x");
    f.ports.loadDocument = async () => null;
    await expect(
      processKbIngest(f.ports, { workspaceId: "ws-1", documentId: "doc-x" }),
    ).rejects.toThrow("not found");
    expect(f.marks).toHaveLength(0);
  });
});
