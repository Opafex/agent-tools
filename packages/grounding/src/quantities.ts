/**
 * Unsupported quantities.
 *
 * The failure: a tool returns two rows and the agent reports "6 rows, 8 in
 * total", sometimes listing rows that do not exist. Identifier checks miss it
 * (there is no identifier) and the contradiction check misses it (there is no
 * name and version).
 *
 * Method (deterministic, no model call):
 *   1. Extract count claims about data collections from the prose: "6 rows",
 *      "8 records", "4 clean unique entries". Only collection nouns count, so
 *      "3 days" or "2 reasons" are ignored.
 *   2. Collect every count the evidence supports: array lengths, and numeric
 *      values of count-like fields (`count`, `total`, `row_count`, `deleted`
 *      and so on).
 *   3. A claim matching none of those counts is unsupported.
 *
 * Deliberately conservative. A claim matching any count in the evidence is
 * treated as supported, and evidence with no determinable count skips the
 * check instead of guessing. It under-reports rather than over-reports, which
 * is also why the gate gives it `warning` severity by default.
 */

import { contextWindow, lower } from './text.js';

const COLLECTION_NOUN =
  '(?:rows?|records?|entries|entry|items?|results?|receipts?|charges?|transactions?|expenses?|duplicates?|line items?|line-items?)';

/** `N <up to two qualifiers> <collection noun>`, so "6 clean rows" binds 6 to rows. */
const COUNT_RE = new RegExp(
  String.raw`\b(\d{1,7})\s+((?:[A-Za-z][\w-]*\s+){0,2}` + COLLECTION_NOUN + String.raw`)\b`,
  'gi',
);

/** Keys whose numeric value is the size of a collection. */
const COUNT_KEYS = new Set([
  'count', 'row_count', 'rowcount', 'total', 'totalcount', 'total_count',
  'deleted', 'inserted', 'updated', 'affected', 'matched', 'removed', 'added',
  'rowsaffected', 'rows_affected', 'length', 'size',
]);

/** Count fields found by pattern in evidence that is not parseable JSON. */
const COUNT_FIELD_RE =
  /"(count|row_count|rowCount|total|totalCount|deleted|inserted|updated|affected|matched)"\s*:\s*(\d{1,7})/gi;

const MAX_WALK_DEPTH = 5;
const MAX_EVIDENCE_COUNTS = 200;
const MAX_CLAIMS = 50;

export interface QuantityClaim {
  number: number;
  /** The collection noun phrase, such as "rows" or "clean rows". */
  noun: string;
  /** Up to 120 characters of surrounding prose. */
  context: string;
}

export interface QuantityCheckResult {
  /** `skipped` when there are no claims or no countable evidence. */
  status: 'passed' | 'failed' | 'skipped';
  /** Count claims found in the prose. */
  scanned: number;
  /** Distinct counts the evidence supports. */
  evidenceCounts: number[];
  /** Claims matching no evidence count. */
  unsupported: QuantityClaim[];
}

/** Extract count-of-collection claims from prose. Pure. */
export function extractQuantityClaims(text: string): QuantityClaim[] {
  if (!text) return [];
  const claims: QuantityClaim[] = [];
  COUNT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COUNT_RE.exec(text)) !== null && claims.length < MAX_CLAIMS) {
    const number = Number(m[1]);
    if (!Number.isFinite(number)) continue;
    claims.push({
      number,
      noun: (m[2] as string).replace(/\s+/g, ' ').trim().slice(0, 60),
      context: contextWindow(text, m.index, m[0].length),
    });
  }
  return claims;
}

function walkForCounts(node: unknown, out: Set<number>, depth: number): void {
  if (out.size >= MAX_EVIDENCE_COUNTS || depth > MAX_WALK_DEPTH || node == null) return;
  if (Array.isArray(node)) {
    out.add(node.length);
    for (const el of node) walkForCounts(el, out, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && COUNT_KEYS.has(lower(k))) out.add(v);
      walkForCounts(v, out, depth + 1);
    }
  }
}

function mineString(text: string, out: Set<number>): void {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 1 && (trimmed[0] === '{' || trimmed[0] === '[')) {
      try {
        walkForCounts(JSON.parse(trimmed), out, 0);
      } catch {
        // Not JSON on its own; the field pattern below still reads it.
      }
    }
  }
  COUNT_FIELD_RE.lastIndex = 0;
  let f: RegExpExecArray | null;
  while ((f = COUNT_FIELD_RE.exec(text)) !== null && out.size < MAX_EVIDENCE_COUNTS) {
    out.add(Number(f[2]));
  }
}

/**
 * The counts the evidence supports. Structured values are walked; strings are
 * parsed line by line as JSON where possible and scanned for count fields.
 */
export function collectEvidenceCounts(evidence: readonly unknown[] | undefined): number[] {
  const set = new Set<number>();
  for (const item of evidence ?? []) {
    if (typeof item === 'string') mineString(item, set);
    else if (item !== undefined && item !== null) walkForCounts(item, set, 0);
  }
  return [...set];
}

/** Check count claims in the prose against the evidence. Pure. */
export function checkQuantities(input: { text: string; evidence?: readonly unknown[] }): QuantityCheckResult {
  const claims = extractQuantityClaims(input.text);
  if (claims.length === 0) {
    return { status: 'skipped', scanned: 0, evidenceCounts: [], unsupported: [] };
  }
  const evidenceCounts = collectEvidenceCounts(input.evidence);
  if (evidenceCounts.length === 0) {
    return { status: 'skipped', scanned: claims.length, evidenceCounts: [], unsupported: [] };
  }
  const supported = new Set(evidenceCounts);
  const unsupported = claims.filter((c) => !supported.has(c.number));
  return {
    status: unsupported.length > 0 ? 'failed' : 'passed',
    scanned: claims.length,
    evidenceCounts,
    unsupported,
  };
}
