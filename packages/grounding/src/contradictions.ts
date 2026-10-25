/**
 * Internal contradictions across outputs.
 *
 * The failure: one run produces several outputs (steps of a plan, turns of a
 * conversation, sections of a report) and two of them disagree on a specific
 * named fact, such as two documents giving different versions of the same
 * framework. Each output may look fine on its own.
 *
 * Method (deterministic, no model call):
 *   1. From each output, extract `(noun, value)` pairs. Two shapes today:
 *      a name followed by a version ("Next.js 15.1.0", "Node 20.x"), and a
 *      JSON-style `"name": "version"` pair.
 *   2. Accumulate pairs across outputs, keyed by the lower-cased noun.
 *   3. A noun holding two or more distinct values is a contradiction.
 *
 * `checkContradictions` reports only disagreements the current output
 * introduced, so an output that agreed with the first value is not flagged
 * again every time a later one disagrees.
 */

import { lower } from './text.js';

/** One fact claim extracted from prose. */
export interface FactPair {
  /** Lower-cased noun, the comparison key, such as `next.js`. */
  noun: string;
  /** The noun as written, such as `Next.js`. */
  nounDisplay: string;
  /** The value as written, such as `15.1.0`. */
  value: string;
  /** Which output in the run made the claim (your own numbering). */
  emissionIndex: number;
  /** Up to 120 characters of surrounding prose. */
  context: string;
}

/** A noun claimed with two or more distinct values. */
export interface Contradiction {
  noun: string;
  nounDisplay: string;
  /** Each distinct value with the earliest output that stated it, in order. */
  values: Array<{ value: string; emissionIndex: number; context: string }>;
}

/** A name followed by a version: "Next.js 15.1.0", "Acme v2.4", "Node 20.x". */
const NAME_VERSION_RE =
  /\b([A-Z][\w.-]{1,29})\s+(?:version\s+|v|@)?(?:\^|~)?(\d+(?:\.\d+|\.x){1,2})\b/g;

/** A JSON-style pair: `"left-pad": "^1.3.0"`. */
const JSON_VERSION_RE =
  /["']([@\w./_-]{2,40})["']\s*:\s*["'](?:\^|~)?(\d+\.\d+(?:\.\d+)?)["']/g;

/** Nouns that pair with numbers all the time but are never facts worth tracking. */
const NOUN_STOPWORDS = new Set([
  'step', 'phase', 'iteration', 'task', 'turn',
  'attempt', 'try', 'round', 'pass',
  'figure', 'table', 'section', 'chapter',
  'example', 'note', 'tip',
]);

const NOUN_DISPLAY_MAX = 60;

function contextOf(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 30);
  const end = Math.min(text.length, at + length + 30);
  return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** Extract fact pairs from one output. Pure. */
export function extractFactPairs(text: string, emissionIndex: number): FactPair[] {
  if (!text) return [];
  const pairs: FactPair[] = [];
  for (const re of [NAME_VERSION_RE, JSON_VERSION_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1] as string;
      const noun = lower(raw).trim();
      if (NOUN_STOPWORDS.has(noun)) continue;
      pairs.push({
        noun,
        nounDisplay: raw.slice(0, NOUN_DISPLAY_MAX),
        value: m[2] as string,
        emissionIndex,
        context: contextOf(text, m.index, m[0].length),
      });
    }
  }
  return pairs;
}

/** Every noun whose pairs disagree. Empty when all claims are consistent. Pure. */
export function findContradictions(pairs: readonly FactPair[]): Contradiction[] {
  if (pairs.length < 2) return [];
  const grouped = new Map<string, { display: string; byValue: Map<string, FactPair> }>();
  for (const p of pairs) {
    let entry = grouped.get(p.noun);
    if (!entry) {
      entry = { display: p.nounDisplay, byValue: new Map() };
      grouped.set(p.noun, entry);
    }
    if (!entry.byValue.has(p.value)) entry.byValue.set(p.value, p);
  }

  const out: Contradiction[] = [];
  for (const [noun, entry] of grouped) {
    if (entry.byValue.size < 2) continue;
    const values = [...entry.byValue.values()]
      .sort((a, b) => a.emissionIndex - b.emissionIndex)
      .map((p) => ({ value: p.value, emissionIndex: p.emissionIndex, context: p.context }));
    out.push({ noun, nounDisplay: entry.display, values });
  }
  return out;
}

/** A disagreement introduced by the current output. */
export interface IntroducedContradiction {
  noun: string;
  nounDisplay: string;
  /** What the current output says. */
  value: string;
  /** What an earlier output said. */
  earlierValue: string;
  earlierEmissionIndex: number;
  earlierContext: string;
}

export interface ContradictionCheckResult {
  /** `skipped` when the current output states no fact pairs. */
  status: 'passed' | 'failed' | 'skipped';
  /** Pairs from the current output. Keep them and pass them in next time. */
  newFacts: FactPair[];
  contradictions: IntroducedContradiction[];
}

/**
 * Check one output against the facts earlier outputs stated. Pure: you keep
 * the accumulated `FactPair[]` between calls.
 */
export function checkContradictions(
  text: string,
  options: { priorFacts?: readonly FactPair[]; emissionIndex?: number } = {},
): ContradictionCheckResult {
  const emissionIndex = options.emissionIndex ?? 0;
  const newFacts = extractFactPairs(text, emissionIndex);
  if (newFacts.length === 0) return { status: 'skipped', newFacts, contradictions: [] };

  const contradictions: IntroducedContradiction[] = [];
  for (const c of findContradictions([...(options.priorFacts ?? []), ...newFacts])) {
    const mine = c.values.find((v) => v.emissionIndex === emissionIndex);
    const earlier = c.values.find((v) => v.emissionIndex !== emissionIndex);
    if (!mine || !earlier) continue;
    contradictions.push({
      noun: c.noun,
      nounDisplay: c.nounDisplay,
      value: mine.value,
      earlierValue: earlier.value,
      earlierEmissionIndex: earlier.emissionIndex,
      earlierContext: earlier.context,
    });
  }
  return { status: contradictions.length > 0 ? 'failed' : 'passed', newFacts, contradictions };
}
