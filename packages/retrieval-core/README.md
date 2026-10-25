# @opafex/retrieval-core

Storage-agnostic retrieval for RAG: chunking, IDF-weighted rare-term matching, and a merge that gives keyword hits a reserved share of the results beside vector search. Zero dependencies.

```bash
npm install @opafex/retrieval-core
```

## The problem it solves

Vector search is weakest on exactly what a question is most specific about. Proper nouns, sector words and product names carry little meaning an embedding can use, so a page that answers *"what do you offer accountancy firms?"* can rank below generic pages that merely sound similar, and the model then says it could not find an answer.

`retrieve` runs two searches and merges them by passage id:

1. **Vector**: your embedding search, as usual. It takes the top of the list.
2. **Lexical**: passages containing the question's distinctive words, scored by **inverse document frequency**. A quarter of the slots are reserved for these.

A lexical hit the vector side already found is a duplicate, and its slot goes back to the next vector hit. So a question the embedding already answers well gets the same results as before; only the misses change.

**Rarity is the signal, not presence.** Counting matching words ranks three common words (*services*, *offer*, *business*) above the one rare word that names the right page (*accountancy*). IDF weighting is what makes the rare word win.

## Usage

Implement three small ports over whatever store you have (Postgres + pgvector, SQLite + FTS5, an in-memory array):

```ts
import { retrieve, type Embedder, type VectorIndex, type ChunkStore } from '@opafex/retrieval-core';

const embedder: Embedder = {
  space: () => 'openai:text-embedding-3-small:1536', // vectors only compare within one space
  embed: (texts, purpose) => myEmbed(texts, purpose),  // 'query' | 'document'; null where one fails
};

const vectors: VectorIndex = {
  search: (vector, space, limit) => db.vectorSearch(vector, space, limit), // -> [{ chunk, similarity }]
};

const chunks: ChunkStore = {
  // Passages containing ANY of the terms (case-insensitive substring), at most `limit`.
  lexicalCandidates: (terms, limit) => db.chunksContainingAny(terms, limit),
  // How many passages there are, and how many contain each term.
  lexicalStats: (terms) => db.termCounts(terms), // -> { totalChunks, documentFrequency }
};

const results = await retrieve('What do you offer accountancy firms?', { embedder, vectors, chunks }, { slots: 8 });
// [{ chunk, retrieval: 'vector', similarity: 0.71 }, ..., { chunk, retrieval: 'lexical', similarity: null }]
```

A lexical hit carries `similarity: null`, not `0`: it was never compared by meaning. Do not show a lexical hit to a model as "relevance 0%", or the model will discount the one passage that answers the question.

Pass `embedder: null` and `vectors: null` and retrieval runs on keywords alone, with the lexical ranking taking every slot.

### Options

| Option | Default | |
|---|---|---|
| `slots` | required | Passages to return |
| `minSimilarity` | `0.2` | Vector hits below this are not worth a slot |
| `lexicalCandidateLimit` | `200` | Lexical candidates fetched before scoring |

## Chunking

```ts
import { chunkContent, chunkDocument } from '@opafex/retrieval-core';

chunkContent(text, 2000);   // overlapping ~2,000-character passages, broken at paragraphs or sentences
chunkDocument(markdown);    // [{ ordinal, heading, text }]: each passage labelled with its heading
```

`chunkDocument` reads markdown headings (`#` to `######`) and chunks each section separately, so a passage never straddles two headings. Convert Word headings, slide titles and sheet names to markdown headings first and every format keeps its structure.

## The pieces, separately

Everything `retrieve` uses is exported and pure:

- `lexicalTerms(question, max = 6)`: the distinctive words (4+ characters, minus a short stop list), deduplicated.
- `idfWeight(term, stats)`: `log(1 + totalChunks / documentFrequency)`, or 0 for a term found nowhere.
- `scoreLexical(candidates, textOf, terms, stats)`: candidates scored and sorted, best first.
- `mergeRanked(vector, lexical, slots, lexicalShare = 0.25)`: the merge rule on its own.

## Limits

- Lexical matching is substring, English-oriented, with no stemming. `refurbish` matches `refurbishment`; `refurbished` does not match `refurbishing`.
- The lexical share is fixed per call. It is a recall net for what vector search misses, not a replacement for a full-text ranking such as BM25.

## License

MIT, see [LICENSE](./LICENSE).
