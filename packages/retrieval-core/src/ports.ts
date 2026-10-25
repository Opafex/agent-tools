/**
 * The three things a store must provide for `retrieve` to run on it.
 *
 * Implement them over whatever you have: Postgres + pgvector, SQLite + sqlite-vec + FTS5, an
 * in-memory array in a test. Nothing above these interfaces knows which one it is running on.
 */

/** A passage as retrieval returns it: enough to cite, show and open its source. */
export interface RetrievedChunk {
  id: string;
  documentId: string;
  documentTitle: string;
  heading: string | null;
  text: string;
}

export type EmbeddingPurpose = 'query' | 'document';

export interface Embedder {
  /**
   * The space vectors from this embedder live in (`provider:model:dimension`). Vectors are
   * only comparable within one space, so every stored vector is stamped with it and every
   * search filters to it.
   */
  space(): string;
  /** Positional: one entry per input, `null` where an input could not be embedded. */
  embed(texts: string[], purpose: EmbeddingPurpose): Promise<Array<number[] | null>>;
}

export interface VectorHit {
  chunk: RetrievedChunk;
  /** Cosine similarity, 0..1. */
  similarity: number;
}

export interface VectorIndex {
  search(vector: number[], space: string, limit: number): Promise<VectorHit[]>;
}

export interface ChunkStore {
  /** Passages containing ANY of the terms (case-insensitive substring), at most `limit`. */
  lexicalCandidates(terms: readonly string[], limit: number): Promise<RetrievedChunk[]>;
  /** Corpus counts for the IDF weighting over the same scope. */
  lexicalStats(terms: readonly string[]): Promise<{ totalChunks: number; documentFrequency: Record<string, number> }>;
}
