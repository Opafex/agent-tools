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
 *      difference of two of them. A percentage is a share of a TOTAL of the
 *      records (see records.ts and `checkFigures`), rounded as written. A
 *      reference code is supported when it occurs in the evidence. Counts,
 *      dates and days (0.7) are checked against the records' groups and dates.
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
 *
 * 0.7 (2026-10-31): the 0.6 share rule accepted any amount as a share of any
 * other, and across fourteen invoices "64%" and "47%" both passed for a supplier
 * that was 76% of the overdue total. Shares are now of totals; counts ("3 of the
 * 4"), dates and "N days overdue" are checked too.
 */

import { contextWindow } from './text.js';
import { serialiseEvidence } from './evidence.js';
import { collectRecordFacts, type RecordFacts } from './records.js';

export type FigureKind = 'money' | 'percent' | 'reference' | 'count' | 'date' | 'days';

export interface UnsupportedFigure {
  /** The claim exactly as it appears in the prose. */
  token: string;
  kind: FigureKind;
  /**
   * Money in minor units (pence, cents); a percentage as written; a code upper-cased; a count as
   * written ("3/4" for "3 of the 4"); a date as `YYYY-MM-DD` (or `--MM-DD` with no year); days as written.
   */
  value: number | string;
  /** Up to 120 characters of surrounding prose. */
  context: string;
}

export interface FigureCheckInput {
  text: string;
  /** Tool results (and anything else that may back a claim, such as the user's own messages). */
  evidence?: readonly unknown[];
  /**
   * What to do when the evidence holds no number at all. `skip` (the default) treats it as
   * "nothing to compare against", which suits a caller whose evidence may be incomplete.
   * `report` treats it as the answer: no tool returned a figure, so every figure in the prose is
   * unsupported. A turn that read nothing and stated amounts is the case `report` exists for.
   */
  whenNoEvidence?: 'skip' | 'report';
  /**
   * Today, as `YYYY-MM-DD`. With it, "31 days overdue" and "due in 9 days" are checked against the
   * dates in the evidence (within a day either way, for time zones). Without it they are not read.
   */
  today?: string;
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

interface Claim { token: string; kind: FigureKind; value: number | string; index: number; words?: string[] }

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
  for (const c of extractDateClaims(text)) if (claims.length < MAX_CLAIMS) claims.push(c);
  for (const c of extractDayClaims(text)) if (claims.length < MAX_CLAIMS) claims.push(c);
  for (const c of extractCountClaims(text)) if (claims.length < MAX_CLAIMS) claims.push(c);
  return claims;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH = String.raw`(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?`;
const DMY_RE = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+` + MONTH + String.raw`(?:,?\s+(\d{4}))?\b`, 'gi');
const MDY_RE = new RegExp(String.raw`\b` + MONTH + String.raw`\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`, 'gi');
const ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const pad = (n: number) => String(n).padStart(2, '0');
const monthOf = (word: string): number => MONTHS[word.toLowerCase().slice(0, 3)] ?? 0;

/** Calendar dates: "30 September 2026", "30 Sept", "October 14", "2026-10-14". Pure. */
function extractDateClaims(text: string): Claim[] {
  const out: Claim[] = [];
  const taken: Array<[number, number]> = [];
  const push = (token: string, index: number, y: string | undefined, mo: number, d: number) => {
    if (!mo || d < 1 || d > 31 || taken.some(([a, b]) => index < b && index + token.length > a)) return;
    taken.push([index, index + token.length]);
    out.push({ token, kind: 'date', value: y ? `${y}-${pad(mo)}-${pad(d)}` : `--${pad(mo)}-${pad(d)}`, index });
  };
  let m: RegExpExecArray | null;
  ISO_RE.lastIndex = 0;
  while ((m = ISO_RE.exec(text)) !== null) push(m[0], m.index, m[1], Number(m[2]), Number(m[3]));
  DMY_RE.lastIndex = 0;
  while ((m = DMY_RE.exec(text)) !== null) push(m[0], m.index, m[3], monthOf(m[2]), Number(m[1]));
  MDY_RE.lastIndex = 0;
  while ((m = MDY_RE.exec(text)) !== null) push(m[0], m.index, m[3], monthOf(m[1]), Number(m[2]));
  return out;
}

const PAST_DAYS_RE = /\b(\d{1,4})\s*(?:(?:to|–|-)\s*(\d{1,4})\s*)?days?\s*\**\s*(?:overdue|late|past\s+(?:its\s+|the\s+)?due|ago|old)\b/gi;
const FUTURE_DAYS_RE = /\b(?:due\s+)?in\s+(\d{1,4})\s+days?\b/gi;

/** "31 days overdue", "6 to 31 days late", "due in 9 days". The value is signed: negative is past. Pure. */
function extractDayClaims(text: string): Claim[] {
  const out: Claim[] = [];
  let m: RegExpExecArray | null;
  PAST_DAYS_RE.lastIndex = 0;
  while ((m = PAST_DAYS_RE.exec(text)) !== null) {
    out.push({ token: m[0], kind: 'days', value: -Number(m[1]), index: m.index });
    if (m[2]) out.push({ token: m[0], kind: 'days', value: -Number(m[2]), index: m.index });
  }
  FUTURE_DAYS_RE.lastIndex = 0;
  while ((m = FUTURE_DAYS_RE.exec(text)) !== null) out.push({ token: m[0], kind: 'days', value: Number(m[1]), index: m.index });
  return out;
}

const SPELLED: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const NUM = String.raw`(\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;
const OF_RE = new RegExp(String.raw`\b` + NUM + String.raw`\s+of\s+(?:the\s+|your\s+|these\s+|those\s+|its\s+|their\s+)?` + NUM + String.raw`\b`, 'gi');
const NOUN_COUNT_RE = new RegExp(String.raw`\b` + NUM + String.raw`\s+(?:([a-z][\w-]*)\s+)?([a-z][\w-]*s)\b`, 'gi');
/** Plural words that measure rather than count records. */
const UNITS = new Set(['days', 'weeks', 'months', 'years', 'hours', 'minutes', 'seconds', 'times', 'words', 'pages', 'steps', 'percent', 'points', 'characters', 'pounds', 'pence', 'euros', 'dollars']);
const numberOf = (w: string): number => (/^\d+$/.test(w) ? Number(w) : SPELLED[w.toLowerCase()] ?? NaN);

/**
 * Counts of records: "3 of the 4", "2 overdue invoices". The words after the number are kept, so
 * the check reads a count only when they name something in the evidence. Pure.
 */
function extractCountClaims(text: string): Claim[] {
  const out: Claim[] = [];
  const spans: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  OF_RE.lastIndex = 0;
  while ((m = OF_RE.exec(text)) !== null) {
    const n = numberOf(m[1]);
    const of = numberOf(m[2]);
    if (!Number.isFinite(n) || !Number.isFinite(of) || n > of) continue;
    spans.push([m.index, m.index + m[0].length]);
    out.push({ token: m[0], kind: 'count', value: `${n}/${of}`, index: m.index });
  }
  NOUN_COUNT_RE.lastIndex = 0;
  while ((m = NOUN_COUNT_RE.exec(text)) !== null) {
    const n = numberOf(m[1]);
    const at = m.index;
    if (!Number.isFinite(n) || n < 2 || UNITS.has(m[3].toLowerCase())) continue;
    if (spans.some(([a, b]) => at >= a && at < b)) continue;
    // A number that is part of money, a decimal, a range or a code is not a count.
    if (/[£€$.,\-\d]/.test(text.charAt(at - 1))) continue;
    out.push({ token: m[0], kind: 'count', value: String(n), index: at, words: [m[2], m[3]].filter((w): w is string => !!w) });
  }
  return out;
}

interface EvidenceFigures {
  /** Every number in the evidence, in minor units. */
  numbers: Set<number>;
  /** The money-like ones, in minor units, de-duplicated. */
  money: number[];
  /** The evidence upper-cased, for reference codes. */
  upper: string;
  /** Percentages the evidence itself states (written with %, or under a percent/share/rate key). */
  percents: Set<number>;
  /** Amounts the evidence labels as totals (a total-like key, or a `totals:` line of a summary), in minor units. */
  totals: Set<number>;
  /** Counts a summary carries on a `counts:` line. */
  counts: Set<number>;
  /** Every word in the evidence, lower-cased, for deciding whether a count is about it. */
  words: Set<string>;
}

const TOTAL_KEY = /total|balance|outstanding|budget|subtotal|\bsum\b|owed/i;
const PERCENT_FIELD_RE = /"[^"]{0,40}(?:percent|pct|share|rate|ratio)[^"]{0,20}"\s*:\s*"?(-?\d+(?:\.\d+)?)/gi;
const SUMMARY_TOTALS_RE = /\btotals:((?:\s*[£€$][\d.,]+)+)/gi;
const SUMMARY_COUNTS_RE = /\bcounts:((?:\s*\d+)+)/gi;

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

  const percents = new Set<number>();
  PERCENT_RE.lastIndex = 0;
  while ((m = PERCENT_RE.exec(text)) !== null) percents.add(Number(m[1]));
  PERCENT_FIELD_RE.lastIndex = 0;
  while ((m = PERCENT_FIELD_RE.exec(text)) !== null) percents.add(Number(m[1]));

  const totals = new Set<number>();
  MONEY_FIELD_RE.lastIndex = 0;
  while ((m = MONEY_FIELD_RE.exec(text)) !== null) {
    const n = parseNumber(m[2]);
    if (TOTAL_KEY.test(m[1]) && Number.isFinite(n) && n !== 0) totals.add(minor(Math.abs(n)));
  }
  SUMMARY_TOTALS_RE.lastIndex = 0;
  while ((m = SUMMARY_TOTALS_RE.exec(text)) !== null) {
    for (const raw of m[1].trim().split(/\s+/)) { const n = parseNumber(raw); if (Number.isFinite(n)) totals.add(minor(n)); }
  }
  const counts = new Set<number>();
  SUMMARY_COUNTS_RE.lastIndex = 0;
  while ((m = SUMMARY_COUNTS_RE.exec(text)) !== null) for (const raw of m[1].trim().split(/\s+/)) counts.add(Number(raw));

  const words = new Set(text.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3));
  return { numbers, money: [...money], upper: text.toUpperCase(), percents, totals, counts, words };
}

/** The sentence around `at` (or, with `block`, the run of lines up to a blank line), as offsets. */
function spanAround(text: string, at: number, block: boolean): [number, number] {
  if (block) {
    const before = text.lastIndexOf('\n\n', at);
    const after = text.indexOf('\n\n', at);
    return [before < 0 ? 0 : before, after < 0 ? text.length : after];
  }
  let start = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (text[i] === '\n' || (/[.!?]/.test(text[i]) && /\s/.test(text[i + 1] ?? ''))) { start = i + 1; break; }
  }
  let end = text.length;
  for (let i = at; i < text.length; i++) {
    if (text[i] === '\n' || (/[.!?]/.test(text[i]) && /\s/.test(text[i + 1] ?? ''))) { end = i; break; }
  }
  return [start, end];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Whether `name` occurs in `span` as whole words. A name of several words also matches by its first
 * word ("Calder" for "Calder Lift Services") when that word is long and no other name starts with
 * it: "Supplier 0" to "Supplier 9" must not all match "this supplier".
 */
function names(span: string, name: string, firstWordShared: (w: string) => boolean): boolean {
  const hay = span.toLowerCase();
  const has = (w: string) => new RegExp(`(?:^|[^a-z0-9])${escapeRe(w)}(?:$|[^a-z0-9])`).test(hay);
  if (has(name)) return true;
  const words = name.split(/\s+/);
  return words.length > 1 && words[0].length >= 5 && !firstWordShared(words[0]) && has(words[0]);
}

/** Days from `from` to `to` (both YYYY-MM-DD). */
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);

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

/**
 * Check money, percentages, reference codes, counts, dates and days in the prose against the
 * evidence. Pure.
 *
 * A percentage is a share of a TOTAL: the sum of a group of records in the evidence (two or more
 * sharing a value, or the whole list), an amount the evidence labels a total, or a total the reply
 * states and the evidence supports. Its part is what the sentence is about: an amount the sentence
 * states, or the total of a group it names ("Calder Lift Services", "overdue"); failing those, the
 * same in its paragraph; failing those, any amount. A count must be the size of a list or group in
 * the evidence, and is read only when the words after it occur in the evidence. A date must be one
 * the evidence holds, or today; a number of days must be the distance from today to one of them.
 */
export function checkFigures(input: FigureCheckInput): FigureCheckResult {
  const claims = extractFigureClaims(input.text);
  if (claims.length === 0) return { status: 'skipped', scanned: 0, unsupported: [] };
  const ev = collectEvidenceFigures(input.evidence);
  const rec: RecordFacts = collectRecordFacts(input.evidence);
  if (ev.numbers.size === 0 && input.whenNoEvidence !== 'report' && !claims.some((c) => c.kind === 'reference')) {
    return { status: 'skipped', scanned: claims.length, unsupported: [] };
  }

  const derivable = derivableAmounts(ev.money);
  const moneySupported = (v: number) => ev.numbers.has(v) || derivable.has(v);
  const supportedMoney = claims.filter((c) => c.kind === 'money' && moneySupported(c.value as number));

  // Totals a share may be of.
  const wholes = new Set<number>([...rec.totals, ...ev.totals]);
  for (const c of supportedMoney) if (!ev.numbers.has(c.value as number)) wholes.add(c.value as number);
  const wholeList = [...wholes];
  const anyPart = [...new Set<number>([...ev.money, ...rec.totals, ...supportedMoney.map((c) => c.value as number)])];
  const firstWords = new Map<string, number>();
  for (const name of rec.namedTotals.keys()) {
    const w = name.split(/\s+/)[0];
    firstWords.set(w, (firstWords.get(w) ?? 0) + 1);
  }
  const firstWordShared = (w: string) => (firstWords.get(w) ?? 0) > 1;
  const partsFor = (at: number): number[] => {
    for (const block of [false, true]) {
      const [a, b] = spanAround(input.text, at, block);
      const span = input.text.slice(a, b);
      const parts = new Set<number>();
      for (const c of supportedMoney) if (c.index >= a && c.index < b) parts.add(c.value as number);
      for (const [name, sums] of rec.namedTotals) if (names(span, name, firstWordShared)) for (const s of sums) parts.add(s);
      if (parts.size > 0) return [...parts];
    }
    return anyPart;
  };

  const counts = new Set<number>([...rec.counts, ...ev.counts]);
  const readsCounts = rec.found || ev.counts.size > 0;
  const aboutEvidence = (words: string[] | undefined) =>
    !!words && words.some((w) => { const l = w.toLowerCase(); return ev.words.has(l) || ev.words.has(l.replace(/e?s$/, '')); });
  // ISO dates in the records, and dates written in words anywhere in the evidence (a user's message).
  const dates = [...rec.dates];
  for (const item of input.evidence ?? []) {
    const t = serialiseEvidence(item);
    if (t) for (const d of extractDateClaims(t)) dates.push(d.value as string);
  }
  const monthDay = (v: string) => v.slice(v.length - 5);
  const dateSupported = (v: string) => {
    const pool = input.today ? [...dates, input.today] : dates;
    return v.startsWith('--')
      ? pool.some((d) => monthDay(d) === monthDay(v))
      : pool.some((d) => d === v || (d.startsWith('--') && monthDay(d) === monthDay(v)));
  };
  const daysSupported = (n: number) =>
    !!input.today && dates.some((d) => !d.startsWith('--') && Math.abs(daysBetween(input.today as string, d) - n) <= 1);

  const unsupported: UnsupportedFigure[] = [];
  for (const c of claims) {
    let ok: boolean;
    if (c.kind === 'money') ok = moneySupported(c.value as number);
    else if (c.kind === 'reference') ok = ev.upper.includes(c.value as string);
    else if (c.kind === 'percent') {
      const pct = c.value as number;
      ok = ev.percents.has(pct) || partsFor(c.index).some((part) => wholeList.some((whole) => isShare(pct, part, whole)));
    } else if (c.kind === 'count') {
      if (!readsCounts) continue;
      if (typeof c.value === 'string' && c.value.includes('/')) {
        const [n, of] = c.value.split('/').map(Number);
        ok = counts.has(n) && counts.has(of);
      } else {
        if (!aboutEvidence(c.words)) continue;
        ok = counts.has(Number(c.value));
      }
    } else if (c.kind === 'date') {
      ok = dateSupported(c.value as string);
    } else {
      if (!input.today) continue;
      ok = daysSupported(c.value as number);
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
  const rec = collectRecordFacts(evidence);
  const gbp = (v: number) => `£${(v / 100).toFixed(2)}`;
  const money = ev.money.map(gbp);
  const refs = new Set<string>();
  REFERENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REFERENCE_RE.exec(ev.upper)) !== null) refs.add(m[0]);
  // Totals, counts and dates on labelled lines, so a later turn can still check a share, a count
  // or "31 days overdue" without the records themselves.
  const totals = [...new Set([...rec.totals, ...ev.totals])];
  const parts = [...money, ...refs];
  if (totals.length) parts.push(`totals: ${totals.map(gbp).join(' ')}`);
  if (rec.counts.size) parts.push(`counts: ${[...rec.counts].join(' ')}`);
  if (rec.dates.size) parts.push(`dates: ${[...rec.dates].join(' ')}`);
  const out = parts.join(' ');
  return out.length > MAX_SUMMARY_CHARS ? out.slice(0, out.lastIndexOf(' ', MAX_SUMMARY_CHARS)) : out;
}
