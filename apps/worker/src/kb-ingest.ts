import { chunkText } from "@botara/ai";

/**
 * KB ingestion processor (Fase 3), queue "kb", job "ingest".
 *
 * Loads a kb_documents row, chunks its text (~800 chars, 100 overlap -
 * @botara/ai chunkText), embeds every chunk through the AI provider port,
 * replaces the document's chunks atomically, and marks the document
 * ready. Any failure marks the document failed with the reason and the job
 * throws, so BullMQ retries surface in the worker logs - ingestion never
 * silently half-completes.
 */

export interface KbIngestJobData {
  workspaceId: string;
  documentId: string;
}

export interface KbDocumentSnapshot {
  id: string;
  workspaceId: string;
  title: string;
  content: string;
}

export interface KbIngestPorts {
  loadDocument(workspaceId: string, documentId: string): Promise<KbDocumentSnapshot | null>;
  /** Embed texts in order; must return exactly one vector per text. */
  embed(texts: string[]): Promise<number[][]>;
  replaceChunks(
    workspaceId: string,
    documentId: string,
    chunks: Array<{ chunkIndex: number; text: string; embedding: number[] }>,
  ): Promise<void>;
  markReady(documentId: string, chunkCount: number): Promise<void>;
  markFailed(documentId: string, error: string): Promise<void>;
}

export async function processKbIngest(
  ports: KbIngestPorts,
  data: KbIngestJobData,
): Promise<{ chunks: number }> {
  const doc = await ports.loadDocument(data.workspaceId, data.documentId);
  if (!doc) throw new Error(`KB document ${data.documentId} not found in workspace ${data.workspaceId}`);
  try {
    const chunks = chunkText(doc.content);
    const embeddings = chunks.length > 0
      ? await ports.embed(chunks.map((c) => c.text))
      : [];
    if (embeddings.length !== chunks.length) {
      throw new Error(
        `embedding provider returned ${embeddings.length} vectors for ${chunks.length} chunks`,
      );
    }
    await ports.replaceChunks(doc.workspaceId, doc.id, chunks.map((c, i) => ({
      chunkIndex: c.index,
      text: c.text,
      embedding: embeddings[i]!,
    })));
    await ports.markReady(doc.id, chunks.length);
    return { chunks: chunks.length };
  } catch (err) {
    await ports.markFailed(doc.id, err instanceof Error ? err.message : String(err))
      .catch(() => undefined);
    throw err;
  }
}
