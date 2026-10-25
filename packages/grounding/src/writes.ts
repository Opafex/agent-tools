/**
 * Invented values in writes.
 *
 * The prose checks only see what the agent says. The real damage is often
 * done through what it writes: a tool call that inserts rows into a table or
 * updates a record persists its values whether or not they came from anywhere.
 * The typical failure is an agent that fetches three receipts, then writes six
 * rows, inventing plausible receipt numbers to fill a gap it assumed was there.
 *
 * Method (deterministic, no model call):
 *   1. Take the write calls you pass in (you decide which tools transcribe
 *      external facts; structural writes such as "create a dashboard" are
 *      usually not worth checking) and skip any that did not execute.
 *   2. Extract reference-shaped tokens from their string values: hyphen-grouped
 *      codes like receipt or invoice numbers, URLs, UUIDs, hex hashes and long
 *      opaque ids. Bare numbers, amounts and dates are deliberately ignored:
 *      they are low-cardinality and coincide with evidence all the time.
 *   3. Report each token that appears in no evidence.
 *
 * A value the agent wrote but cannot point to in any tool result is
 * ungrounded, whether it was invented or truncated out of a result the agent
 * never fully read. Either way it should not be written as fact.
 *
 * The gate gives this check `warning` severity by default. Its evidence is
 * only as complete as what you pass: if you keep truncated tool results, a
 * real value beyond the cut-off will be reported. Promote it to `error` once
 * your evidence is complete for the calls being checked.
 */

import { appearsInEvidence, buildEvidenceText, type CitationIndex } from './evidence.js';
import { lower } from './text.js';

/** One write tool call to check. */
export interface WriteCall {
  /** The tool name, for reporting. */
  tool: string;
  /** The record written, or the batch of records. Top-level string fields are checked. */
  values: Readonly<Record<string, unknown>> | ReadonlyArray<Readonly<Record<string, unknown>>>;
  /** Set `false` for a call that was proposed but did not run. Defaults to `true`. */
  executed?: boolean;
}

export type WrittenTokenKind = 'reference' | 'url' | 'uuid' | 'sha' | 'long_id';

export interface UngroundedWriteValue {
  tool: string;
  /** The token that appears in no evidence. */
  token: string;
  kind: WrittenTokenKind;
  /** The field it was written to. */
  field: string;
  /** 0-based index within a batch, when `values` was an array. */
  row?: number;
}

export interface WriteCheckResult {
  /** `skipped` when no executed call carried a reference-shaped value. */
  status: 'passed' | 'failed' | 'skipped';
  /** Distinct tokens checked. */
  scanned: number;
  /** At most 8. */
  ungrounded: UngroundedWriteValue[];
}

const MAX_REPORTED = 8;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const HYPHEN_GROUP_RE = /\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b/g;
const LONG_ID_RE = /\b[A-Za-z0-9_]{16,}\b/g;
const SHA_RE = /\b[0-9a-fA-F]{7,40}\b/g;
const DATE_SHAPE_RE = /^\d{4}-\d{1,2}-\d{1,2}$|^\d{1,2}-\d{1,2}-\d{2,4}$/;

interface Token {
  token: string;
  kind: WrittenTokenKind;
}

/**
 * Reference-shaped tokens in one written value. A column value is not prose,
 * so there is no English-word guarding here. Each shape claims its character
 * range so the catch-all shapes do not fire twice.
 */
function extractReferenceTokens(value: string): Token[] {
  const out: Token[] = [];
  const claimed: Array<[number, number]> = [];
  const take = (m: RegExpMatchArray, kind: WrittenTokenKind, accept: (t: string) => boolean): void => {
    if (typeof m.index !== 'number') return;
    const s = m.index;
    const e = s + m[0].length;
    if (claimed.some(([cs, ce]) => s < ce && e > cs)) return;
    claimed.push([s, e]);
    if (accept(m[0])) out.push({ token: m[0], kind });
  };

  for (const m of value.matchAll(UUID_RE)) take(m, 'uuid', () => true);
  for (const m of value.matchAll(URL_RE)) take(m, 'url', () => true);
  for (const m of value.matchAll(HYPHEN_GROUP_RE)) {
    take(m, 'reference', (t) => {
      if (DATE_SHAPE_RE.test(t)) return false;
      // Enough digits and length to be an identifier rather than a hyphenated
      // word or a short code that legitimately recurs.
      const digits = (t.match(/\d/g) ?? []).length;
      return digits >= 4 && t.replace(/-/g, '').length >= 8;
    });
  }
  // A long run needs a digit to be an id rather than a word.
  for (const m of value.matchAll(LONG_ID_RE)) take(m, 'long_id', (t) => /\d/.test(t));
  // A hex run needs a letter to be a hash rather than a decimal number.
  for (const m of value.matchAll(SHA_RE)) take(m, 'sha', (t) => /[a-fA-F]/.test(t));
  return out;
}

/** Check reference-shaped written values against the evidence. Pure. */
export function checkWrites(input: {
  writes?: readonly WriteCall[];
  evidence?: readonly unknown[];
  citations?: CitationIndex;
}): WriteCheckResult {
  const found: Array<Token & { tool: string; field: string; row?: number }> = [];
  for (const call of input.writes ?? []) {
    if (!call || call.executed === false) continue;
    const records = Array.isArray(call.values) ? call.values : [call.values];
    const batched = Array.isArray(call.values);
    records.forEach((record, i) => {
      if (!record || typeof record !== 'object') return;
      for (const [field, v] of Object.entries(record)) {
        if (typeof v !== 'string' || !v.trim()) continue;
        for (const t of extractReferenceTokens(v)) {
          found.push({ ...t, tool: call.tool, field, ...(batched ? { row: i } : {}) });
        }
      }
    });
  }
  if (found.length === 0) return { status: 'skipped', scanned: 0, ungrounded: [] };

  const evidence = buildEvidenceText(input.evidence, input.citations);
  const seen = new Set<string>();
  const ungrounded: UngroundedWriteValue[] = [];
  for (const t of found) {
    const key = `${t.tool}:${lower(t.token)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (appearsInEvidence(t.token, evidence)) continue;
    if (ungrounded.length < MAX_REPORTED) ungrounded.push(t);
  }
  return {
    status: ungrounded.length > 0 ? 'failed' : 'passed',
    scanned: seen.size,
    ungrounded,
  };
}
