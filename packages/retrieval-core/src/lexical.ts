/**
 * The lexical half of retrieval: which rare words of a question a passage actually contains.
 *
 * Why it exists: embedding similarity is weakest on exactly what a question is most specific
 * about. Proper nouns, sector words and product names carry little distributional information,
 * so a passage that answers "what do you offer accountancy firms?" can rank below generic
 * pages that merely sound similar.
 *
 * **Rarity is the signal, presence is not.** A plain match count ranks three common words over
 * the one rare word that names the page, which brings the miss straight back. `scoreLexical`
 * weights each term by inverse document frequency for that reason.
 */

/**
 * Words too common to say anything about relevance. Deliberately SHORT and closed: the IDF
 * weighting is the general mechanism, and nothing domain-specific belongs here.
 */
const STOP_TERMS = new Set([
  'the', 'and', 'for', 'are', 'you', 'your', 'our', 'with', 'that', 'this', 'from',
  'have', 'has', 'can', 'could', 'would', 'should', 'what', 'when', 'where', 'which',
  'who', 'why', 'how', 'does', 'did', 'was', 'were', 'been', 'but', 'not', 'any',
  'all', 'get', 'got', 'its', 'it\'s', 'about', 'there', 'their', 'them', 'they',
  'into', 'than', 'then', 'some', 'much', 'many', 'more', 'most', 'like', 'just',
]);

/** Shortest term worth scanning for. Below this the term is noise in every corpus. */
const MIN_TERM_CHARS = 4;

/** Default cap on query terms scanned for; each term is one scan per row. */
const MAX_TERMS = 6;

/**
 * The distinctive terms of a question, lowercased and deduplicated.
 *
 * A question made entirely of common short words yields nothing, and the caller then skips
 * the scan rather than running one that can only return arbitrary rows.
 */
export function lexicalTerms(query: string, maxTerms: number = MAX_TERMS): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of String(query ?? '').toLowerCase().split(/[^a-z0-9']+/)) {
    const term = raw.replace(/^'+|'+$/g, '');
    if (term.length < MIN_TERM_CHARS) continue;
    if (STOP_TERMS.has(term)) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= maxTerms) break;
  }
  return terms;
}

/** Corpus statistics the IDF weighting needs, supplied by the store, which can count. */
export interface LexicalStats {
  /** Passages in the scope searched. */
  totalChunks: number;
  /** For each term, how many of those passages contain it. */
  documentFrequency: Record<string, number>;
}

export interface LexicalScored<T> {
  item: T;
  /** Sum of the IDF weights of the terms the passage contains. Not a similarity. */
  score: number;
  termsMatched: number;
}

/** Weight of one term: rare terms count for a lot, a term in every passage for nearly nothing. */
export function idfWeight(term: string, stats: LexicalStats): number {
  const df = stats.documentFrequency[term] ?? 0;
  if (df <= 0) return 0;
  return Math.log(1 + stats.totalChunks / df);
}

/**
 * Score candidate passages against the question's terms, best first.
 *
 * Matching is case-insensitive substring, the same rule a store's `ILIKE`/`LIKE` candidate scan
 * uses, so a passage the store returned is scored by the rule that found it.
 * A candidate containing none of the terms is dropped.
 */
export function scoreLexical<T>(
  candidates: readonly T[],
  textOf: (item: T) => string,
  terms: readonly string[],
  stats: LexicalStats,
): Array<LexicalScored<T>> {
  if (!terms.length) return [];
  const weights = terms.map((t) => ({ term: t, weight: idfWeight(t, stats) }));
  const scored: Array<LexicalScored<T>> = [];
  for (const item of candidates) {
    const text = textOf(item).toLowerCase();
    let score = 0;
    let termsMatched = 0;
    for (const { term, weight } of weights) {
      if (!text.includes(term)) continue;
      score += weight;
      termsMatched += 1;
    }
    if (termsMatched > 0) scored.push({ item, score, termsMatched });
  }
  return scored.sort((a, b) => b.score - a.score || b.termsMatched - a.termsMatched);
}
