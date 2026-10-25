/**
 * @opafex/retrieval-core: storage-agnostic retrieval for RAG.
 *
 * Chunking, rare-term (IDF-weighted) lexical scoring, and a merge that gives lexical hits a
 * reserved share of the slots beside vector search, over three small ports any store can
 * implement.
 */

export { chunkContent, chunkDocument, DEFAULT_CHUNK_SIZE, CHUNK_OVERLAP, type DocumentChunk } from './chunk.js';
export { lexicalTerms, scoreLexical, idfWeight, type LexicalStats, type LexicalScored } from './lexical.js';
export {
  retrieve,
  mergeRanked,
  LEXICAL_SHARE,
  type RankedChunk,
  type RetrievalSignal,
  type RetrievePorts,
  type RetrieveOptions,
} from './retrieve.js';
export type {
  RetrievedChunk,
  Embedder,
  EmbeddingPurpose,
  VectorIndex,
  VectorHit,
  ChunkStore,
} from './ports.js';
