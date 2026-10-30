/**
 * Unsupported figures.
 *
 * The failure: the agent states money, a percentage or a reference number that
 * no tool returned. Seen on a live account in one week: two suppliers that do
 * not exist, each with an amount ("BrightLight Electrical (£3,250)"), in a turn
 * that read no data at all; a total of £6,720 for two invoices that sum to
 * £7,985.50; "78% of the overdue amount" where the figures give 76%; and an
 * invoice number "CL-2026-0984" for one the table calls "CLS-20418". The
 * identifier check misses all four (none is identifier-shaped) and the count
 * check misses them too (none is a count of rows).
 *
 * Method (deterministic, no model call):
 *   1. Extract claims from the prose: money with a currency marker (£4,860,
 *      €12.50, $3k is skipped as approximate, GBP 1,200), percentages, and
 *      reference codes (CLS-20418, INV-0042, CL-2026-0984).
 *   2. Collect every number in the evidence, and the money-like ones among
 *      them: values under a money key (`amount`, `total`, `price`, ...),
 *      values written with a currency marker, and values with two decimals.
 *   3. A money claim is supported when it equals an evidence number, the sum
 *      of some of the money-like values (a total the agent added up), or the
 *      difference of two of them. A percentage is supported when it is in the
 *      evidence, or is one amount as a share of another, rounded as written.
 *      Both amounts must be held in the evidence or stated in the reply: never
 *      any derivable sum, which would match nearly any share. A reference code
 *      is supported when it occurs in the evidence.
 *   4. Report every other claim.
 *
 * Conservative in the same way as the count check: a claim matching anything
 * the evidence supports passes, so it under-reports rather than over-reports.
 * The sum search is exhaustive only over a small set of money-like values and
 * bounded beyond it (sums of up to four, and the whole), because over a large
 * set nearly any figure is some sum.
 * A share of a COUNT ("2 of 4, 50%") is not derived: it is reported, and costs
 * one rewrite, rather than being matched against every small fraction (which
 * would pass 62% as 5/8).
 */

import { contextWindow } from './text.js';
import { serialiseEvidence } from './evidence.js';

export type FigureKind = 'money' | 'percent' | 'reference';

export interface UnsupportedFigure {
  /** The claim exactly as it appears in the prose. */
  token: string;
  kind: FigureKind;
  /** Money in minor units (pence, cents); a percentage as written; a code upper-cased. */
  value: number | string;
  /** Up to 120 characters of surrounding prose. */
  context: string;
}

export interface FigureCheckInput {
  text: string;
  /** Tool results (and anything else that may back a claim, such as the user's own messages). */
  evidence?: readonly unknown[];
}

export interface FigureCheckResult {
  /** `skipped`: no figure in the prose, or no number in the evidence to compare against. */
  status: 'passed' | 'failed' | 'skipped';
  scanned: number;
  unsupported: UnsupportedFigure[];
}

const CURRENCY = String.raw`(?:£|€|\$|\b(?:GBP|EUR|USD)\s?)`;
/** `£4,860`, `£ 4860.00`, `GBP 1,200`; a trailing k/m/bn marks an approximation, which is not checked. */
const MONEY_RE = new RegExp(
  CURRENCY + String.raw`\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?![\d.,]*\d)(\s?(?:k|m|bn)\b)?`,
  'gi',
);
const PERCENT_RE = /(\d{1,3}(?:\.\d{1,2})?)\s?%/g;
/** Letters, a hyphen, then digit groups: `CLS-20418`, `INV-0042`, `CL-2026-0984`. */
const REFERENCE_RE = /\b[A-Z]{2,6}-\d{3,}(?:-\d{2,})*\b/g;

const EVIDENCE_NUMBER_RE = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g;
const MONEY_KEY = /amount|total|price|cost|value|balance|net|gross|vat|tax|fee|sum|paid|outstanding|subtotal|charge|owed|spend/i;
const MONEY_FIELD_RE = /"([A-Za-z_ -]{1,40})"\s*:\s*"?([£€$]?\s?-?[\d,]+(?:\.\d+)?)/g;
const CURRENCY_VALUE_RE = new RegExp(CURRENCY + String.raw`\s?(-?[\d,]+(?:\.\d+)?)`, 'gi');
const TWO_DECIMALS_RE = /(?:^|[^\d.])(-?\d+\.\d{2})(?![\d.])/g;

/** Sizes the sum search may enumerate exhaustively; beyond it, only small subsets and the whole. */
const EXHAUSTIVE_SUM_LIMIT = 18;
const MAX_MONEY_VALUES = 40;
const MAX_CLAIMS = 60;

const minor = (n: number): number => Math.round(n * 100);
const parseNumber = (raw: string): number => Number(raw.replace(/[£€$,\s]/g, ''));

interface Claim { token: string; kind: FigureKind; value: number | string; index: number }

/** Money, percentage and reference claims in prose. Pure. */
export function extractFigureClaims(text: string): Claim[] {
  if (!text) return [];
  const claims: Claim[] = [];
  let m: RegExpExecArray | null;
  MONEY_RE.lastIndex = 0;
  while ((m = MONEY_RE.exec(text)) !== null && claims.length < MAX_CLAIMS) {
    if (m[3]) continue; // £3k, £1.2m: approximate by intent
    const n = parseNumber(m[1]) + (m[2] ? Number(`0.${m[2].padEnd(2, '0')}`) : 0);
    if (Number.isFinite(n)) claims.push({ token: m[0].trim(), kind: 'money', value: minor(n), index: m.index });
  }
  PERCENT_RE.lastIndex = 0;
  while ((m = PERCENT_RE.exec(text)) !== null && claims.length < MAX_CLAIMS) {
    claims.push({ token: m[0], kind: 'percent', value: Number(m[1]), index: m.index });
  }
  REFERENCE_RE.lastIndex = 0;
  while ((m = REFERENCE_RE.exec(text)) !== null && claims.length < MAX_CLAIMS) {
    claims.push({ token: m[0], kind: 'reference', value: m[0].toUpperCase(), index: m.index });
  }
  return claims;
}

interface EvidenceFigures {
  /** Every number in the evidence, in minor units. */
  numbers: Set<number>;
  /** The money-like ones, in minor units, de-duplicated. */
  money: number[];
  /** The evidence upper-cased, for reference codes. */
  upper: string;
}

/** The numbers the evidence holds, and which of them are money. Pure. */
export function collectEvidenceFigures(evidence: readonly unknown[] | undefined): EvidenceFigures {
  const text = (evidence ?? []).map(serialiseEvidence).filter((s): s is string => !!s).join('\n');
  const numbers = new Set<number>();
  for (const raw of text.match(EVIDENCE_NUMBER_RE) ?? []) {
    const n = parseNumber(raw);
    if (Number.isFinite(n)) numbers.add(minor(n));
  }
  const money = new Set<number>();
  const add = (raw: string) => {
    const n = parseNumber(raw);
    if (Number.isFinite(n) && n !== 0 && money.size < MAX_MONEY_VALUES) money.add(minor(Math.abs(n)));
  };
  let m: RegExpExecArray | null;
  MONEY_FIELD_RE.lastIndex = 0;
  while ((m = MONEY_FIELD_RE.exec(text)) !== null) if (MONEY_KEY.test(m[1])) add(m[2]);
  CURRENCY_VALUE_RE.lastIndex = 0;
  while ((m = CURRENCY_VALUE_RE.exec(text)) !== null) add(m[1]);
  TWO_DECIMALS_RE.lastIndex = 0;
  while ((m = TWO_DECIMALS_RE.exec(text)) !== null) add(m[1]);
  return { numbers, money: [...money], upper: text.toUpperCase() };
}

/** Every total the agent could have added up from the money-like values, bounded. */
function derivableAmounts(money: readonly number[]): Set<number> {
  const out = new Set<number>(money);
  const n = money.length;
  if (n <= EXHAUSTIVE_SUM_LIMIT) {
    for (let mask = 1; mask < 1 << n; mask++) {
      let sum = 0;
      for (let i = 0; i < n; i++) if (mask & (1 << i)) sum += money[i];
      out.add(sum);
    }
  } else {
    let all = 0;
    for (let i = 0; i < n; i++) {
      all += money[i];
      for (let j = i + 1; j < n; j++) {
        out.add(money[i] + money[j]);
        for (let k = j + 1; k < n; k++) {
          out.add(money[i] + money[j] + money[k]);
          for (let l = k + 1; l < n; l++) out.add(money[i] + money[j] + money[k] + money[l]);
        }
      }
    }
    out.add(all);
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (money[i] > money[j]) out.add(money[i] - money[j]);
  return out;
}

/** Whether `pct`, rounded as written, is `part` as a share of `whole`. */
function isShare(pct: number, part: number, whole: number): boolean {
  if (whole <= 0 || part <= 0 || part > whole) return false;
  const decimals = String(pct).split('.')[1]?.length ?? 0;
  const tolerance = 0.5 / 10 ** decimals + 1e-9;
  return Math.abs((100 * part) / whole - pct) <= tolerance;
}

/** Check money, percentages and reference codes in the prose against the evidence. Pure. */
export function checkFigures(input: FigureCheckInput): FigureCheckResult {
  const claims = extractFigureClaims(input.text);
  if (claims.length === 0) return { status: 'skipped', scanned: 0, unsupported: [] };
  const ev = collectEvidenceFigures(input.evidence);
  if (ev.numbers.size === 0 && !claims.some((c) => c.kind === 'reference')) {
    return { status: 'skipped', scanned: claims.length, unsupported: [] };
  }

  const derivable = derivableAmounts(ev.money);
  const moneySupported = (v: number) => ev.numbers.has(v) || derivable.has(v);
  // A share is of amounts the evidence holds or the reply states and the evidence supports.
  const shareBases = new Set<number>(ev.money);
  for (const c of claims) if (c.kind === 'money' && moneySupported(c.value as number)) shareBases.add(c.value as number);
  const bases = [...shareBases];

  const unsupported: UnsupportedFigure[] = [];
  for (const c of claims) {
    let ok: boolean;
    if (c.kind === 'money') ok = moneySupported(c.value as number);
    else if (c.kind === 'reference') ok = ev.upper.includes(c.value as string);
    else {
      const pct = c.value as number;
      ok = ev.numbers.has(minor(pct)) || bases.some((part) => bases.some((whole) => isShare(pct, part, whole)));
    }
    if (!ok) {
      unsupported.push({ token: c.token, kind: c.kind, value: c.value, context: contextWindow(input.text, c.index, c.token.length) });
    }
  }
  return { status: unsupported.length > 0 ? 'failed' : 'passed', scanned: claims.length, unsupported };
}

/** Longest summary `summariseFigureEvidence` returns. */
const MAX_SUMMARY_CHARS = 4000;

/**
 * The figures in some evidence, as a short string that is itself valid evidence for
 * `checkFigures`: every money-like value (written with a currency marker so it stays
 * money-like) and every reference code. Store it beside a conversation turn and pass it
 * back as evidence on later turns, so a figure the tools returned earlier still backs a
 * reply that repeats it — without keeping the tool results themselves, and without ever
 * treating the agent's own words as evidence. Pure.
 */
export function summariseFigureEvidence(evidence: readonly unknown[] | undefined): string {
  const ev = collectEvidenceFigures(evidence);
  const money = ev.money.map((v) => `£${(v / 100).toFixed(2)}`);
  const refs = new Set<string>();
  REFERENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REFERENCE_RE.exec(ev.upper)) !== null) refs.add(m[0]);
  const out = [...money, ...refs].join(' ');
  return out.length > MAX_SUMMARY_CHARS ? out.slice(0, out.lastIndexOf(' ', MAX_SUMMARY_CHARS)) : out;
}
