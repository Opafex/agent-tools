/**
 * Retrieve the passages most relevant to a question, from any store that implements the ports.
 *
 * Two signals, merged by passage id: the vector ranking takes the top of the list, and a
 * reserved share of the slots goes to rare-term lexical matches the vector cut missed. A
 * lexical hit the vector side already ranked is a duplicate, and the slot goes back to the next
 * vector hit, so a question the embedding answers well is unchanged.
 */
import { lexicalTerms, scoreLexical } from './lexical.js';
import type { ChunkStore, Embedder, RetrievedChunk, VectorIndex } from './ports.js';

/** Fraction of the slots reserved for lexical matches. */
export const LEXICAL_SHARE = 0.25;

/** How a passage came to be in the result. A lexical hit was never compared by meaning. */
export type RetrievalSignal = 'vector' | 'lexical';

export interface RankedChunk {
  chunk: RetrievedChunk;
  retrieval: RetrievalSignal;
  /** Cosine similarity for a vector hit; `null` for a lexical one, which has no such figure. */
  similarity: number | null;
}

export interface RetrievePorts {
  embedder: Embedder | null;
  vectors: VectorIndex | null;
  chunks: ChunkStore;
}

export interface RetrieveOptions {
  /** Passages to return. */
  slots: number;
  /** Vector hits below this similarity are not worth a slot. */
  minSimilarity?: number;
  /** Lexical candidates fetched before scoring. */
  lexicalCandidateLimit?: number;
}

/**
 * Merge a vector ranking and a lexical ranking into `slots` passages.
 *
 * Pure: exported so the merge rule is tested without a store.
 */
export function mergeRanked(
  vector: readonly RankedChunk[],
  lexical: readonly RankedChunk[],
  slots: number,
  lexicalShare: number = LEXICAL_SHARE,
): RankedChunk[] {
  if (slots <= 0) return [];
  const reserved = lexical.length ? Math.max(1, Math.round(slots * lexicalShare)) : 0;
  const out: RankedChunk[] = [];
  const seen = new Set<string>();
  for (const hit of vector) {
    if (out.length >= slots - reserved) break;
    if (seen.has(hit.chunk.id)) continue;
    seen.add(hit.chunk.id);
    out.push(hit);
  }
  for (const hit of lexical) {
    if (out.length >= slots) break;
    if (seen.has(hit.chunk.id)) continue;
    seen.add(hit.chunk.id);
    out.push(hit);
  }
  // Slots a duplicate gave back go to the next vector hits.
  for (const hit of vector) {
    if (out.length >= slots) break;
    if (seen.has(hit.chunk.id)) continue;
    seen.add(hit.chunk.id);
    out.push(hit);
  }
  return out;
}

export async function retrieve(query: string, ports: RetrievePorts, opts: RetrieveOptions): Promise<RankedChunk[]> {
  const minSimilarity = opts.minSimilarity ?? 0.2;
  const terms = lexicalTerms(query);

  const vectorSide = async (): Promise<RankedChunk[]> => {
    if (!ports.embedder || !ports.vectors) return [];
    const [vector] = await ports.embedder.embed([query], 'query');
    if (!vector) return [];
    const hits = await ports.vectors.search(vector, ports.embedder.space(), opts.slots);
    return hits
      .filter((h) => h.similarity >= minSimilarity)
      .map((h) => ({ chunk: h.chunk, retrieval: 'vector' as const, similarity: h.similarity }));
  };

  const lexicalSide = async (): Promise<RankedChunk[]> => {
    if (!terms.length) return [];
    const [candidates, stats] = await Promise.all([
      ports.chunks.lexicalCandidates(terms, opts.lexicalCandidateLimit ?? 200),
      ports.chunks.lexicalStats(terms),
    ]);
    return scoreLexical(candidates, (c) => c.text, terms, stats).map((s) => ({
      chunk: s.item,
      retrieval: 'lexical' as const,
      similarity: null,
    }));
  };

  const [vector, lexical] = await Promise.all([vectorSide(), lexicalSide()]);
  // With no vector side at all (no embedder, or nothing embedded), the lexical ranking IS
  // the ranking, so it gets every slot rather than a quarter of them.
  if (!vector.length) return lexical.slice(0, opts.slots);
  return mergeRanked(vector, lexical, opts.slots);
}
