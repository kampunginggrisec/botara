/**
 * Knowledge-base primitives (Fase 3): deterministic text chunking for
 * ingestion and cosine-similarity retrieval over stored embeddings.
 *
 * Embeddings are stored as plain number arrays (jsonb in Postgres) so the
 * runtime never depends on the pgvector extension - see the guarded
 * optional pgvector note on kb_chunks in @botara/db. Retrieval ranks in
 * code, which is exact and fast at the document counts a workspace KB
 * realistically holds; the pgvector path is a drop-in optimization later.
 */

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

export interface TextChunk {
  index: number;
  text: string;
}

/**
 * Split text into overlapping chunks of ~`size` chars (default 800) with
 * `overlap` chars carried over (default 100). Breaks prefer paragraph /
 * sentence boundaries near the cut so chunks stay semantically whole.
 * Pure and deterministic - the same input always yields the same chunks.
 */
export function chunkText(
  text: string,
  opts: { size?: number; overlap?: number } = {},
): TextChunk[] {
  const size = Math.max(50, opts.size ?? 800);
  const overlap = Math.min(Math.max(0, opts.overlap ?? 100), size - 1);
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= size) return [{ index: 0, text: normalized }];

  const chunks: TextChunk[] = [];
  let start = 0;
  let index = 0;
  while (start < normalized.length) {
    let end = Math.min(start + size, normalized.length);
    if (end < normalized.length) {
      // Prefer the last paragraph/sentence break in the back half.
      const window = normalized.slice(start + Math.floor(size / 2), end);
      const para = window.lastIndexOf("\n\n");
      const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
      const breakAt = para >= 0 ? para : sentence;
      if (breakAt > 0) end = start + Math.floor(size / 2) + breakAt + 1;
    }
    const piece = normalized.slice(start, end).trim();
    if (piece) chunks.push({ index: index++, text: piece });
    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

/** Cosine similarity of two embedding vectors; 0 for empty/mismatched input. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface RankedChunk<T> {
  item: T;
  score: number;
}

/**
 * Rank stored chunks by cosine similarity to a query embedding and return
 * the top K (default 3) with score > 0 - the retrieval step shared by the
 * flow ai_reply node and the inbox ai-suggest endpoint.
 */
export function rankChunks<T extends { embedding: number[] | null }>(
  chunks: T[],
  queryEmbedding: number[],
  topK = 3,
): Array<RankedChunk<T>> {
  return chunks
    .filter((c): c is T & { embedding: number[] } => Array.isArray(c.embedding) && c.embedding.length > 0)
    .map((item) => ({ item, score: cosineSimilarity(queryEmbedding, item.embedding) }))
    .filter((r) => r.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, topK);
}
