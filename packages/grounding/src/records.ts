/**
 * What a list of records in the evidence lets a reply say: its totals, its counts and its dates.
 *
 * `checkFigures` used to treat the evidence as a bag of numbers, so a percentage passed when ANY
 * amount was that share of ANY other. Over fourteen invoices that is nearly every whole number:
 * "Calder Lift is 64% of the overdue value" (it is 76%) passed because £3,125.50 happens to be 64%
 * of £4,860. A share is of a TOTAL, and a total is of a group of records, so this module reads the
 * records themselves: every array of objects in the evidence (a JSON string is parsed, including
 * one result per line), and for each, the sum and count of the whole list and of every group of
 * two or more records sharing a value (status "Overdue", supplier "Calder Lift Services") or a pair
 * of values ("Calder Lift Services" and "Overdue").
 *
 * A field is used to group only when it groups: a field unique to every record (an invoice number,
 * an id) or holding dates or numbers is skipped, so the groups are the ones a person would name.
 * Bounded throughout (records, fields, values per field), so a large result costs a fixed amount.
 * Pure.
 */

import { serialiseEvidence } from './evidence.js';

const MONEY_KEY = /amount|total|price|cost|value|balance|net|gross|vat|tax|fee|sum|paid|outstanding|subtotal|charge|owed|spend/i;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;
const NUMERIC = /^-?[£€$]?\s?[\d,]+(?:\.\d+)?$/;

const MAX_RECORDS = 1000;
const MAX_GROUP_FIELDS = 10;
const MAX_VALUES_PER_FIELD = 60;
const MAX_DEPTH = 6;

export interface RecordFacts {
  /** Sums, in minor units, of the whole list and of every group of two or more records. */
  totals: Set<number>;
  /** Group value (lower-cased) to the sums of every group it names, in minor units, groups of one included. */
  namedTotals: Map<string, Set<number>>;
  /** Sizes: of each list and of each group or pair of values. */
  counts: Set<number>;
  /** Every ISO date (YYYY-MM-DD) held anywhere in the evidence. */
  dates: Set<string>;
  /** Whether any list of records was found. */
  found: boolean;
}

type Rec = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const toMinor = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && NUMERIC.test(v.trim()) ? Number(v.replace(/[£€$,\s]/g, '')) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/** The parsed JSON values in one evidence item: the whole of it, or each line that is JSON. */
function parsedValues(item: unknown): unknown[] {
  if (item === null || item === undefined) return [];
  if (typeof item !== 'string') return [item];
  const tryParse = (s: string): unknown => {
    const t = s.trim();
    if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
    try { return JSON.parse(t); } catch { return undefined; }
  };
  const whole = tryParse(item);
  if (whole !== undefined) return [whole];
  const out: unknown[] = [];
  for (const line of item.split('\n')) {
    const v = tryParse(line);
    if (v !== undefined) out.push(v);
  }
  return out;
}

/** A record with one level of nesting lifted (`{ id, values: { supplier } }` reads as `{ id, supplier }`). */
function flatten(rec: Rec): Rec {
  const out: Rec = {};
  for (const [k, v] of Object.entries(rec)) {
    if (isPlainObject(v)) for (const [k2, v2] of Object.entries(v)) { if (!(k2 in out)) out[k2] = v2; }
    else out[k] = v;
  }
  return out;
}

function collectArrays(node: unknown, depth: number, out: Rec[][]): void {
  if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    const recs = node.filter(isPlainObject);
    if (recs.length > 0) out.push(recs.slice(0, MAX_RECORDS).map(flatten));
    for (const v of node) if (typeof v === 'object') collectArrays(v, depth + 1, out);
    return;
  }
  for (const v of Object.values(node)) collectArrays(v, depth + 1, out);
}

function addNamed(map: Map<string, Set<number>>, name: string, sum: number): void {
  const key = name.toLowerCase().trim();
  if (key.length < 3) return;
  let s = map.get(key);
  if (!s) map.set(key, (s = new Set()));
  s.add(sum);
}

export function collectRecordFacts(evidence: readonly unknown[] | undefined): RecordFacts {
  const facts: RecordFacts = { totals: new Set(), namedTotals: new Map(), counts: new Set(), dates: new Set(), found: false };
  for (const item of evidence ?? []) {
    const text = serialiseEvidence(item) ?? '';
    for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) facts.dates.add(`${m[1]}-${m[2]}-${m[3]}`);
    const lists: Rec[][] = [];
    for (const v of parsedValues(item)) collectArrays(v, 0, lists);
    for (const recs of lists) readList(recs, facts);
  }
  return facts;
}

function readList(recs: Rec[], facts: RecordFacts): void {
  facts.found = true;
  facts.counts.add(recs.length);
  const keys = new Set<string>();
  for (const r of recs) for (const k of Object.keys(r)) keys.add(k);

  const moneyKeys = [...keys].filter((k) => MONEY_KEY.test(k) && recs.some((r) => toMinor(r[k]) !== null && typeof r[k] !== 'boolean'));
  const groupKeys: string[] = [];
  for (const k of keys) {
    if (moneyKeys.includes(k) || groupKeys.length >= MAX_GROUP_FIELDS) continue;
    const values = recs.map((r) => r[k]).filter((v) => v !== null && v !== undefined && v !== '');
    if (values.length === 0) continue;
    if (!values.every((v) => typeof v === 'string' || typeof v === 'boolean')) continue;
    if (values.some((v) => typeof v === 'string' && (ISO_DATE.test(v) || NUMERIC.test(v.trim()) || v.length > 80))) continue;
    const distinct = new Set(values.map(String));
    if (distinct.size > MAX_VALUES_PER_FIELD || distinct.size === values.length) continue; // an id, not a group
    groupKeys.push(k);
  }

  const groupOf = (filter: (r: Rec) => boolean): Rec[] => recs.filter(filter);
  const tally = (group: Rec[], names: string[]) => {
    facts.counts.add(group.length);
    for (const mk of moneyKeys) {
      let sum = 0;
      for (const r of group) sum += toMinor(r[mk]) ?? 0;
      if (group.length >= 2) facts.totals.add(sum);
      for (const n of names) addNamed(facts.namedTotals, n, sum);
    }
  };

  tally(recs, []);
  const valuesOf = (k: string) => [...new Set(recs.map((r) => r[k]).filter((v) => v !== null && v !== undefined && v !== '').map(String))];
  for (let i = 0; i < groupKeys.length; i++) {
    const a = groupKeys[i];
    for (const va of valuesOf(a)) {
      tally(groupOf((r) => String(r[a]) === va), [va]);
      for (let j = i + 1; j < groupKeys.length; j++) {
        const b = groupKeys[j];
        for (const vb of valuesOf(b)) {
          const g = groupOf((r) => String(r[a]) === va && String(r[b]) === vb);
          if (g.length > 0) tally(g, [va, vb]);
        }
      }
    }
  }
  for (const r of recs) for (const v of Object.values(r)) {
    if (typeof v === 'string') { const m = v.match(ISO_DATE); if (m) facts.dates.add(`${m[1]}-${m[2]}-${m[3]}`); }
  }
}
