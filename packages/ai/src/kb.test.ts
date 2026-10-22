import { describe, expect, test } from "bun:test";
import { chunkText, cosineSimilarity, rankChunks } from "./kb";

describe("chunkText", () => {
  test("short text is a single chunk; empty text yields none", () => {
    expect(chunkText("halo dunia")).toEqual([{ index: 0, text: "halo dunia" }]);
    expect(chunkText("   ")).toEqual([]);
    expect(chunkText("")).toEqual([]);
  });

  test("long text splits near the size with overlap carried over", () => {
    const text = Array.from({ length: 100 }, (_, i) => `sentence-${i}`).join(" ");
    const chunks = chunkText(text, { size: 200, overlap: 40 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(220);
    }
    // Overlap: the tail of one chunk reappears at the head of the next.
    const tail = chunks[0]!.text.slice(-30);
    expect(chunks[1]!.text).toContain(tail.slice(0, 10).split(" ")[0]!);
    // Indexes are sequential.
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  test("paragraph boundaries are preferred break points", () => {
    const para = "A".repeat(300);
    const text = `${para}\n\n${"B".repeat(300)}\n\n${"C".repeat(300)}`;
    const chunks = chunkText(text, { size: 400, overlap: 50 });
    expect(chunks[0]!.text).toBe(para);
  });

  test("deterministic: same input, same chunks", () => {
    const text = "Lorem ipsum dolor sit amet. ".repeat(80);
    expect(chunkText(text)).toEqual(chunkText(text));
  });
});

describe("cosineSimilarity", () => {
  test("identical vectors score 1, orthogonal 0, opposite -1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1);
  });

  test("degenerate inputs score 0 instead of NaN", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});

describe("rankChunks", () => {
  const chunks = [
    { id: "a", embedding: [1, 0, 0] },
    { id: "b", embedding: [0.9, 0.1, 0] },
    { id: "c", embedding: [0, 1, 0] },
    { id: "d", embedding: null },
    { id: "e", embedding: [-1, 0, 0] },
  ];

  test("returns the top-K most similar embedded chunks in order", () => {
    const ranked = rankChunks(chunks, [1, 0, 0], 2);
    expect(ranked.map((r) => r.item.id)).toEqual(["a", "b"]);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  test("chunks without embeddings and non-positive scores are excluded", () => {
    // Query tilted toward y: b (which has a y component) wins, c has a
    // small positive score, e is negative, d has no embedding.
    const ranked = rankChunks(chunks, [1, 0.2, 0], 10);
    expect(ranked.map((r) => r.item.id)).toEqual(["b", "a", "c"]);
  });
});
