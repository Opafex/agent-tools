/**
 * Citation drift.
 *
 * Some agents mark each claim with the tool result it came from, such as
 * "The schema has three tables [tc4]." Checking that `[tc4]` exists is easy
 * and catches invented citation numbers. It does not catch the subtler
 * failure: the citation is real, but the sentence attached to it says things
 * the cited result does not contain. A typical case is an agent that reads a
 * real database schema and then describes a generic boilerplate schema
 * ("users, accounts, sessions") while citing the real one.
 *
 * Method (deterministic, tolerant of paraphrase, no model call):
 *   1. Split the prose into sentences and keep those carrying a citation.
 *   2. Skip sentences with a negation ("does not use X"), which would
 *      otherwise flag every X absent from the source.
 *   3. Extract identifier-like tokens from the sentence: snake_case,
 *      CamelCase, dotted paths, version numbers, quoted strings, and items in
 *      a list of three or more bare words. Ordinary English does not match.
 *   4. Test each token against the content of the cited sources, tolerating
 *      plurals, brand suffixes (`Next.js` against `next`) and CamelCase to
 *      kebab-case (`NextAuth` against `next-auth`).
 *   5. A token missing from the cited source but present in another source is
 *      mis-attribution (real data, wrong citation). It is counted, not flagged.
 *   6. Flag the sentence when two or more tokens are missing, or at least half
 *      of them are.
 *
 * Sentences whose cited sources have no `content` are counted as
 * `skippedNoContent` rather than flagged, so a partially populated index does
 * not fail closed.
 */

import type { CitationIndex } from './evidence.js';
import { lower, splitSentences } from './text.js';

/** The default citation marker: `[tc1]`, `[tc2]`, ... capturing `tc1`. */
export const DEFAULT_CITATION_MARKER = /\[(tc\d+)\]/g;

export interface CitationOptions {
  /**
   * How your citations look in prose. Capture group 1 is the citation id used
   * to look up the `CitationIndex`; without a group, the whole match is the id.
   * Defaults to `DEFAULT_CITATION_MARKER`.
   */
  marker?: RegExp;
}

export interface UnsupportedCitation {
  /** The first cited id in the sentence that had content. */
  citation: string;
  /** The sentence, capped at 200 characters. */
  sentence: string;
  /** Tokens absent from every cited source and from all other sources (at most 6). */
  missingTokens: string[];
  /** How many tokens were extracted from the sentence. */
  extractedTokens: number;
}

export interface CitationCheckResult {
  status: 'passed' | 'failed' | 'skipped';
  unsupported: UnsupportedCitation[];
  /** Sentences carrying at least one citation. */
  scanned: number;
  /** Tokens checked across all scanned sentences. */
  tokensChecked: number;
  /** Sentences skipped because none of their cited sources had content. */
  skippedNoContent: number;
  /** Tokens found in a source other than the one cited. Not flagged. */
  misattributed: number;
}

// Each pattern is narrow enough that generic English does not match:
//   snake_case needs an underscore, CamelCase needs two capitalised segments,
//   a dotted path needs identifier characters on both sides of the dot.
const SNAKE_CASE_RE = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g;
const CAMEL_CASE_RE = /[A-Z][a-z]+(?:[A-Z][a-z]+)+/g;
const DOTTED_PATH_RE = /[a-zA-Z][\w-]*\.[a-zA-Z][\w-]+(?:\.[a-zA-Z][\w-]+)*/g;
const VERSION_RE = /\d+\.\d+(?:\.\d+)?/g;
const QUOTED_RE = /["']([^"'\n]{2,40})["']/g;

/** Tokens that pass the patterns but identify nothing in particular. */
const STOPWORD_TOKENS = new Set([
  'true', 'false', 'null', 'undefined',
  'string', 'number', 'boolean', 'object', 'array',
  'http', 'https', 'json', 'yaml',
  'readme.md', 'license.md',
]);

const MIN_TOKEN_LEN = 3;
const SENTENCE_SNIPPET_MAX = 200;
const MISSING_TOKENS_MAX = 6;
/** With fewer tokens than this, a ratio is noise (1 of 1 is 0% or 100%). */
const MIN_EXTRACTED_FOR_RULE = 2;
/**
 * "not", "no", or a contraction ending in n't ("doesn't", "isn\u2019t"). The contraction has
 * no word boundary before the n, so it is matched on its own.
 */
const NEGATION_RE = /\b(?:not|no)\b|n['\u2019]t\b/i;
const FRAMEWORK_BRAND_SUFFIXES = ['.js', '.css', '.ts', '.html', '.md'];

function globalMarker(marker: RegExp | undefined): RegExp {
  const m = marker ?? DEFAULT_CITATION_MARKER;
  return new RegExp(m.source, m.flags.includes('g') ? m.flags : m.flags + 'g');
}

function citedIds(sentence: string, marker: RegExp): string[] {
  const ids: string[] = [];
  marker.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(sentence)) !== null) {
    ids.push(m[1] ?? m[0]);
    if (m[0].length === 0) marker.lastIndex += 1;
  }
  return ids;
}

/**
 * Items from a comma-separated list of three or more bare words. A lone word
 * like "users" is indistinguishable from English, but in a run of three it is
 * almost always a claim: the agent is naming specific things. The last word of
 * each chunk is taken, so the lead-in of the first chunk ("schema includes
 * users") contributes only "users".
 */
function extractEnumerationItems(sentence: string): string[] {
  const items: string[] = [];
  const chunks = sentence
    .split(/\s*,\s*|\s+and\s+/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const TAIL_RE = /(?:^|\s)([a-z][a-z0-9_]{3,})\s*$/;

  let run: string[] = [];
  for (const chunk of chunks) {
    const tail = TAIL_RE.exec(chunk)?.[1];
    if (tail) {
      run.push(tail);
    } else {
      if (run.length >= 3) items.push(...run);
      run = [];
    }
  }
  if (run.length >= 3) items.push(...run);
  return items;
}

/**
 * Trim punctuation clinging to the ends of a token. A quoted span in prose can
 * capture the prose's own comma ("Widget 1.0,"), which would then fail to
 * match content holding "Widget 1.0". Internal dots, underscores and hyphens
 * are kept.
 */
function trimBoundaryPunct(tok: string): string {
  return tok.replace(/^[^a-z0-9]+/i, '').replace(/[^a-z0-9]+$/i, '');
}

function keepToken(tok: string): boolean {
  return tok.length >= MIN_TOKEN_LEN && !STOPWORD_TOKENS.has(lower(tok));
}

/** Identifier-like tokens in one sentence, with citation markers removed first. */
function extractTokens(sentence: string, marker: RegExp): string[] {
  const tokens = new Set<string>();
  const stripped = sentence.replace(marker, ' ');

  for (const re of [SNAKE_CASE_RE, CAMEL_CASE_RE, DOTTED_PATH_RE, VERSION_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      if (keepToken(m[0])) tokens.add(m[0]);
    }
  }

  QUOTED_RE.lastIndex = 0;
  let qm: RegExpExecArray | null;
  while ((qm = QUOTED_RE.exec(stripped)) !== null) {
    const tok = trimBoundaryPunct((qm[1] ?? '').trim());
    if (keepToken(tok)) tokens.add(tok);
  }

  for (const tok of extractEnumerationItems(stripped)) {
    if (keepToken(tok)) tokens.add(tok);
  }
  return [...tokens];
}

function camelCaseBoundaries(s: string): number[] {
  const out: number[] = [];
  for (let i = 1; i < s.length; i++) {
    const prev = s.charCodeAt(i - 1);
    const curr = s.charCodeAt(i);
    if (prev >= 97 && prev <= 122 && curr >= 65 && curr <= 90) out.push(i);
  }
  return out;
}

/** Does the token occur in the content, allowing for common rewordings? */
function tokenAppearsIn(rawToken: string, content: string): boolean {
  const token = trimBoundaryPunct(rawToken);
  const t = lower(token);
  const c = lower(content);
  if (t.length === 0) return true;
  if (c.includes(t)) return true;
  // Plurals in either direction.
  if (t.endsWith('s') && t.length > 3 && c.includes(t.slice(0, -1))) return true;
  if (t.endsWith('es') && t.length > 4 && c.includes(t.slice(0, -2))) return true;
  if (!t.endsWith('s') && c.includes(t + 's')) return true;

  // Brand names against package ids: "Next.js" against "next".
  for (const sfx of FRAMEWORK_BRAND_SUFFIXES) {
    if (t.endsWith(sfx)) {
      const base = t.slice(0, -sfx.length);
      if (base.length >= MIN_TOKEN_LEN && c.includes(base)) return true;
    }
  }

  // CamelCase against kebab or snake case: "NextAuth" against "next-auth".
  // Boundaries come from the original token; lower-casing loses them.
  const boundaries = new Set(camelCaseBoundaries(token));
  if (boundaries.size > 0) {
    let kebab = '';
    for (let i = 0; i < t.length; i++) {
      if (boundaries.has(i)) kebab += '-';
      kebab += t[i];
    }
    if (c.includes(kebab)) return true;
    if (c.includes(kebab.replace(/-/g, '_'))) return true;
  }
  return false;
}

/**
 * Check that each cited sentence's identifier-like tokens occur in the content
 * of the sources it cites. Pure.
 */
export function checkCitations(
  text: string,
  citations: CitationIndex,
  options: CitationOptions = {},
): CitationCheckResult {
  const result: CitationCheckResult = {
    status: 'skipped',
    unsupported: [],
    scanned: 0,
    tokensChecked: 0,
    skippedNoContent: 0,
    misattributed: 0,
  };
  if (!text || !citations || Object.keys(citations).length === 0) return result;

  const marker = globalMarker(options.marker);
  // Everything any tool returned. A token absent from the cited source but
  // present here was seen and cited imprecisely: not an invention.
  const allContent = Object.values(citations)
    .map((s) => s?.content || '')
    .filter(Boolean)
    .join('\n');

  for (const sentence of splitSentences(text)) {
    const ids = citedIds(sentence, marker);
    if (ids.length === 0) continue;
    result.scanned += 1;
    if (NEGATION_RE.test(sentence)) continue;

    const parts: string[] = [];
    const idsWithContent: string[] = [];
    for (const id of ids) {
      const content = citations[id]?.content;
      if (content) {
        parts.push(content);
        idsWithContent.push(id);
      }
    }
    if (parts.length === 0) {
      result.skippedNoContent += 1;
      continue;
    }
    const cited = parts.join('\n');

    const tokens = extractTokens(sentence, marker);
    if (tokens.length < MIN_EXTRACTED_FOR_RULE) continue;

    const missing: string[] = [];
    for (const tok of tokens) {
      if (tokenAppearsIn(tok, cited)) continue;
      if (tokenAppearsIn(tok, allContent)) {
        result.misattributed += 1;
        continue;
      }
      missing.push(tok);
    }
    result.tokensChecked += tokens.length;

    if (missing.length >= 2 || missing.length / tokens.length >= 0.5) {
      result.unsupported.push({
        citation: idsWithContent[0] as string,
        sentence: sentence.slice(0, SENTENCE_SNIPPET_MAX),
        missingTokens: missing.slice(0, MISSING_TOKENS_MAX),
        extractedTokens: tokens.length,
      });
    }
  }

  if (result.scanned > 0) result.status = result.unsupported.length > 0 ? 'failed' : 'passed';
  return result;
}

// ---------------------------------------------------------------------------
// Count claims against cited row counts
// ---------------------------------------------------------------------------

export interface UnsupportedCitationCount {
  /** The cited id whose row count disagrees with the claim. */
  citation: string;
  sentence: string;
  /** The number the prose claimed. */
  claimedCount: number;
  /** The cited row count (the sum, for a sentence citing several sources). */
  actualRows: number;
  /** The noun the number was attached to, such as "orders". */
  noun: string;
}

export interface CitationCountCheckResult {
  status: 'passed' | 'failed' | 'skipped';
  unsupported: UnsupportedCitationCount[];
  /** Sentences carrying at least one citation. */
  scanned: number;
  /** `<number> <noun>` patterns compared. */
  patternsChecked: number;
  /** Sentences skipped because a cited source had no known `rowCount`. */
  skippedUnknownCount: number;
}

/**
 * `<number> <noun>`, allowing count-modifying words in between, so "5 most
 * recent commits" binds 5 to "commits". One to three digits keeps hashes and
 * years out.
 */
const COUNT_QUALIFIER_WORDS =
  'most|recent|few|last|all|the|new|additional|other|prior|same|different|top|first|next|previous|latest';
const COUNT_NOUN_RE = new RegExp(
  `\\b(\\d{1,3})(?:\\s+(?:${COUNT_QUALIFIER_WORDS}))*\\s+([a-z][a-z\\-]{3,})\\b`,
  'gi',
);

/** Units and measures: a number before these is not a count of results. */
const NON_COUNT_NOUNS = new Set([
  'minutes', 'minute', 'seconds', 'second', 'hours', 'hour', 'days', 'day',
  'years', 'year', 'months', 'month', 'weeks', 'week',
  'percent', 'percentage', 'pixels', 'kilobytes', 'megabytes', 'gigabytes',
  'milliseconds', 'millisecond',
  'characters', 'character', 'lines', 'line',
]);

/**
 * Check `<number> <noun>` claims in cited sentences against the cited sources'
 * `rowCount`. Pure.
 *
 * - One citation: the claim must equal that source's row count.
 * - Several citations: the claim may not exceed their sum. Equal or fewer is
 *   allowed, since the agent may legitimately pick a subset.
 * - Any cited source without a known `rowCount` skips the sentence.
 * - At most one finding per sentence.
 */
export function checkCitationCounts(
  text: string,
  citations: CitationIndex,
  options: CitationOptions = {},
): CitationCountCheckResult {
  const result: CitationCountCheckResult = {
    status: 'skipped',
    unsupported: [],
    scanned: 0,
    patternsChecked: 0,
    skippedUnknownCount: 0,
  };
  if (!text || !citations || Object.keys(citations).length === 0) return result;
  const marker = globalMarker(options.marker);

  for (const sentence of splitSentences(text)) {
    const ids = citedIds(sentence, marker);
    if (ids.length === 0) continue;
    result.scanned += 1;
    if (NEGATION_RE.test(sentence)) continue;

    const multi = ids.length > 1;
    let bound = 0;
    let unknown = false;
    for (const id of ids) {
      const rows = citations[id]?.rowCount;
      if (rows == null) {
        unknown = true;
        break;
      }
      bound += rows;
    }
    if (unknown) {
      result.skippedUnknownCount += 1;
      continue;
    }

    COUNT_NOUN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let flagged = false;
    while ((m = COUNT_NOUN_RE.exec(sentence)) !== null) {
      const claimed = parseInt(m[1] as string, 10);
      const noun = lower(m[2]);
      if (NON_COUNT_NOUNS.has(noun) || NON_COUNT_NOUNS.has(noun + 's')) continue;
      result.patternsChecked += 1;
      const fires = multi ? claimed > bound : claimed !== bound;
      if (fires && !flagged) {
        result.unsupported.push({
          citation: ids[0] as string,
          sentence: sentence.slice(0, SENTENCE_SNIPPET_MAX),
          claimedCount: claimed,
          actualRows: bound,
          noun,
        });
        flagged = true;
      }
    }
  }

  if (result.patternsChecked > 0) result.status = result.unsupported.length > 0 ? 'failed' : 'passed';
  return result;
}
