import { describe, it, expect, vi } from 'vitest';
import {
  chunkContent,
  chunkDocument,
  CHUNK_OVERLAP,
  idfWeight,
  lexicalTerms,
  mergeRanked,
  retrieve,
  scoreLexical,
  type ChunkStore,
  type Embedder,
  type RankedChunk,
  type RetrievedChunk,
  type VectorIndex,
} from '../src/index.js';

const chunk = (id: string, text: string): RetrievedChunk => ({
  id,
  documentId: `d-${id}`,
  documentTitle: `Doc ${id}`,
  heading: null,
  text,
});

const ranked = (id: string, retrieval: 'vector' | 'lexical'): RankedChunk => ({
  chunk: chunk(id, id),
  retrieval,
  similarity: retrieval === 'vector' ? 0.8 : null,
});

/** An in-memory ChunkStore: substring candidates and true document frequencies. */
function memoryStore(chunks: RetrievedChunk[]): ChunkStore & { calls: number } {
  const store = {
    calls: 0,
    async lexicalCandidates(terms: readonly string[], limit: number) {
      store.calls += 1;
      return chunks.filter((c) => terms.some((t) => c.text.toLowerCase().includes(t))).slice(0, limit);
    },
    async lexicalStats(terms: readonly string[]) {
      return {
        totalChunks: chunks.length,
        documentFrequency: Object.fromEntries(
          terms.map((t) => [t, chunks.filter((c) => c.text.toLowerCase().includes(t)).length]),
        ),
      };
    },
  };
  return store;
}

describe('lexicalTerms', () => {
  it('keeps the distinctive words and drops the common ones', () => {
    expect(lexicalTerms('Which is better for a 20 person accountancy firm, the chatbot or the agent?')).toEqual([
      'better',
      'person',
      'accountancy',
      'firm',
      'chatbot',
      'agent',
    ]);
  });

  it('drops words too short to say anything', () => {
    expect(lexicalTerms('is it any good')).toEqual(['good']);
  });

  it('deduplicates, so a repeated word does not buy two scans', () => {
    expect(lexicalTerms('pricing pricing pricing plans')).toEqual(['pricing', 'plans']);
  });

  it('caps the term count, because each term is one scan per row', () => {
    expect(lexicalTerms('alpha bravo charlie delta echoes foxtrot golfing hotel')).toHaveLength(6);
    expect(lexicalTerms('alpha bravo charlie delta', 2)).toEqual(['alpha', 'bravo']);
  });

  it('returns nothing for a question made only of common words', () => {
    expect(lexicalTerms('what does it do and how')).toEqual([]);
  });
});

describe('idfWeight and scoreLexical: rarity is the signal, presence is not', () => {
  // 10 passages. "services", "offer" and "business" are everywhere; "accountancy" is in one.
  const corpus = [
    chunk('target', 'Accountancy firms: we automate client onboarding.'),
    ...Array.from({ length: 9 }, (_, i) => chunk(`g${i}`, 'Our services offer every business more time.')),
  ];
  const stats = {
    totalChunks: corpus.length,
    documentFrequency: { services: 9, offer: 9, business: 9, accountancy: 1 },
  };

  it('weights a rare term far above a common one', () => {
    expect(idfWeight('accountancy', stats)).toBeGreaterThan(3 * idfWeight('services', stats));
  });

  it('gives a term that appears nowhere no weight', () => {
    expect(idfWeight('missing', stats)).toBe(0);
  });

  it('ranks the one passage with the rare word above passages matching three common words', () => {
    const terms = ['services', 'offer', 'business', 'accountancy'];
    const out = scoreLexical(corpus, (c) => c.text, terms, stats);
    expect(out[0].item.id).toBe('target');
    expect(out[0].termsMatched).toBe(1);
    expect(out[1].termsMatched).toBe(3);
  });

  it('drops a candidate that contains none of the terms', () => {
    const out = scoreLexical([chunk('x', 'nothing relevant')], (c) => c.text, ['accountancy'], stats);
    expect(out).toEqual([]);
  });

  it('matches case-insensitively', () => {
    const out = scoreLexical([chunk('x', 'ACCOUNTANCY')], (c) => c.text, ['accountancy'], stats);
    expect(out).toHaveLength(1);
  });
});

describe('mergeRanked', () => {
  const v = ['1', '2', '3', '4', '5'].map((id) => ranked(id, 'vector'));

  it('reserves a quarter of the slots for lexical hits the vector side missed', () => {
    const l = [ranked('x', 'lexical')];
    expect(mergeRanked(v, l, 4).map((r) => r.chunk.id)).toEqual(['1', '2', '3', 'x']);
  });

  it('reserves at least one slot whenever there is a lexical hit', () => {
    expect(mergeRanked(v, [ranked('x', 'lexical')], 2).map((r) => r.chunk.id)).toEqual(['1', 'x']);
  });

  it('gives a duplicate lexical hit its slot back to the next vector hit', () => {
    const l = [ranked('2', 'lexical')];
    const out = mergeRanked(v, l, 4);
    expect(out.map((r) => r.chunk.id)).toEqual(['1', '2', '3', '4']);
    // The vector copy wins: it carries a real similarity.
    expect(out[1].retrieval).toBe('vector');
  });

  it('leaves the vector ranking unchanged when there are no lexical hits', () => {
    expect(mergeRanked(v, [], 3).map((r) => r.chunk.id)).toEqual(['1', '2', '3']);
  });

  it('returns nothing for zero slots', () => {
    expect(mergeRanked(v, [ranked('x', 'lexical')], 0)).toEqual([]);
  });
});

describe('retrieve', () => {
  const CHUNKS = [
    chunk('c1', 'Our contracts manager led 14 school refurbishments in Medway during 2023.'),
    chunk('c2', 'We hold ISO 45001 certification.'),
    chunk('c3', 'Health and safety is reviewed every quarter.'),
  ];

  function vectorPorts(hits: Array<[string, number]>) {
    const embedder: Embedder = {
      space: () => 'test:model:3',
      embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
    };
    const vectors: VectorIndex = {
      search: vi.fn(async () =>
        hits.map(([id, similarity]) => ({ chunk: CHUNKS.find((c) => c.id === id)!, similarity })),
      ),
    };
    return { embedder, vectors };
  }

  it('with no vector side, the lexical ranking gets every slot', async () => {
    const out = await retrieve('school refurbishment Medway', { embedder: null, vectors: null, chunks: memoryStore(CHUNKS) }, { slots: 5 });
    expect(out.map((r) => r.chunk.id)).toEqual(['c1']);
    expect(out[0]).toMatchObject({ retrieval: 'lexical', similarity: null });
  });

  it('merges a vector ranking with a lexical hit the vector cut missed', async () => {
    const ports = { ...vectorPorts([['c3', 0.71], ['c2', 0.65]]), chunks: memoryStore(CHUNKS) };
    const out = await retrieve('refurbishments in Medway', ports, { slots: 4 });
    expect(out.map((r) => [r.chunk.id, r.retrieval])).toEqual([
      ['c3', 'vector'],
      ['c2', 'vector'],
      ['c1', 'lexical'],
    ]);
  });

  it('drops vector hits below the similarity floor', async () => {
    const ports = { ...vectorPorts([['c3', 0.9], ['c2', 0.1]]), chunks: memoryStore(CHUNKS) };
    const out = await retrieve('quarterly review', ports, { slots: 4, minSimilarity: 0.5 });
    expect(out.map((r) => r.chunk.id)).not.toContain('c2');
  });

  it('embeds the question as a QUERY, and searches the embedder’s own space', async () => {
    const vp = vectorPorts([['c2', 0.9]]);
    await retrieve('certification', { ...vp, chunks: memoryStore(CHUNKS) }, { slots: 2 });
    expect(vp.embedder.embed).toHaveBeenCalledWith(['certification'], 'query');
    expect(vp.vectors.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], 'test:model:3', 2);
  });

  it('falls back to lexical when the question cannot be embedded', async () => {
    const vp = vectorPorts([['c2', 0.9]]);
    vp.embedder.embed = vi.fn(async () => [null]);
    const out = await retrieve('Medway refurbishments', { ...vp, chunks: memoryStore(CHUNKS) }, { slots: 3 });
    expect(out.map((r) => r.chunk.id)).toEqual(['c1']);
  });

  it('does not scan the store when the question has no distinctive words', async () => {
    const store = memoryStore(CHUNKS);
    await retrieve('what is it', { embedder: null, vectors: null, chunks: store }, { slots: 3 });
    expect(store.calls).toBe(0);
  });
});

describe('chunkContent', () => {
  it('returns short text whole, and nothing for empty text', () => {
    expect(chunkContent('short')).toEqual(['short']);
    expect(chunkContent('')).toEqual([]);
  });

  it('cuts long text into overlapping chunks no longer than the limit', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} says something useful.`).join(' ');
    const chunks = chunkContent(text, 500);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
    // Consecutive chunks share text, so a fact at a boundary is not cut in half.
    expect(chunks[1]).toContain(chunks[0].slice(-40, -20));
    expect(CHUNK_OVERLAP).toBeGreaterThan(40);
  });

  it('prefers a paragraph break', () => {
    const text = `${'a'.repeat(300)}\n\n${'b'.repeat(300)}`;
    const chunks = chunkContent(text, 400);
    expect(chunks[0]).toBe('a'.repeat(300));
  });

  it('always makes progress on text with no breaks at all', () => {
    const chunks = chunkContent('x'.repeat(5000), 1000);
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.length).toBeLessThan(20);
  });
});

describe('chunkDocument', () => {
  const DOC = [
    'Intro line before any heading.',
    '',
    '# Health and safety',
    'We review every site monthly.',
    '',
    '## Social value',
    'We hire locally and train apprentices.',
  ].join('\n');

  it('labels each passage with the heading it sits under', () => {
    const out = chunkDocument(DOC);
    expect(out.map((c) => [c.heading, c.text])).toEqual([
      [null, 'Intro line before any heading.'],
      ['Health and safety', 'We review every site monthly.'],
      ['Social value', 'We hire locally and train apprentices.'],
    ]);
    expect(out.map((c) => c.ordinal)).toEqual([0, 1, 2]);
  });

  it('never lets a passage straddle two headings', () => {
    const big = `# A\n${'alpha '.repeat(300)}\n# B\n${'bravo '.repeat(300)}`;
    for (const c of chunkDocument(big, 800)) {
      expect(c.text.includes('alpha') && c.text.includes('bravo')).toBe(false);
    }
  });

  it('skips headings with no body, and returns nothing for blank input', () => {
    expect(chunkDocument('# Empty\n\n# Also empty\n')).toEqual([]);
    expect(chunkDocument('   ')).toEqual([]);
  });
});
