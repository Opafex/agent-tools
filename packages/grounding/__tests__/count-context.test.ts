import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import {
  GROUNDING_VERSION,
  checkFigures,
  checkQuantities,
  collectEvidenceCounts,
  extractQuantityClaims,
  notACount,
} from '../src/index.js';

// Made-up examples of the shapes a live read found flagged wrongly (2026-11-01). The production
// samples themselves are not copied here.

const at = (text: string, needle: string): number => {
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`"${needle}" not in "${text}"`);
  return i;
};
const reason = (text: string, needle: string, claim = needle) => notACount(text, at(text, needle), claim.length);

describe('notACount', () => {
  it('a real count is a count', () => {
    expect(reason('The table has 12 rows.', '12 rows')).toBeNull();
    expect(reason('Found 4 overdue invoices today.', '4 overdue invoices')).toBeNull();
  });

  it('glued: money split at its point, a code, a time', () => {
    const money = 'You spent $213.42 entries worth on fuel.';
    expect(notACount(money, at(money, '42'), '42 entries'.length)).toBe('glued');
    const code = 'Receipt #5310-2271-0094 items were filed.';
    expect(notACount(code, at(code, '5310'), 4)).toBe('glued');
    expect(notACount(code, at(code, '2271'), 4)).toBe('glued');
    expect(reason('Meet at 10:30 results pending.', '10')).toBe('glued');
  });

  it('label: a number used as a name, including the end of a range', () => {
    expect(reason('Go back to step 2 rows first.', '2 rows')).toBe('label');
    const range = 'Repeat steps 6 through 8 rows as before.';
    expect(notACount(range, at(range, '8 rows'), 6)).toBe('label');
    expect(reason('See row 7 entries.', '7 entries')).toBe('label');
  });

  it('rate: the noun is per something', () => {
    expect(reason('It allows 2 entries/day on the free plan.', '2 entries')).toBe('rate');
    expect(reason('Capped at 60 requests per minute.', '60 requests', '60 requests')).toBe('rate');
    expect(reason('We import 3 records a day.', '3 records')).toBe('rate');
  });

  it('bound: a limit is not a count', () => {
    expect(reason('The search returns up to 25 results.', '25 results')).toBe('bound');
    expect(reason('A maximum of 40 rows fits on a sheet.', '40 rows')).toBe('bound');
    expect(reason('There are at least 3 duplicates.', '3 duplicates')).toBe('bound');
  });

  it('a cap earlier in the sentence does not reach a real count after it', () => {
    const s = 'Searches return up to 25 results, and this one returned 9 results.';
    expect(notACount(s, at(s, '25'), 10)).toBe('bound');
    expect(notACount(s, at(s, '9 results'), 9)).toBeNull();
  });
});

describe('checkQuantities with the shared check', () => {
  const rows = (n: number, status = 'Open') => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, status }));

  it('the false shapes are not claims', () => {
    const text =
      'You paid $213.42 entries, receipt #5310-2271-0094 items, see step 1 rows, steps 6 through 8 rows, ' +
      'the free plan allows 1 entry/day, and a search returns up to 25 results.';
    expect(extractQuantityClaims(text)).toEqual([]);
  });

  it('a wrong total still fails', () => {
    const evidence = [JSON.stringify({ a: rows(7) }), JSON.stringify({ b: rows(4) }), JSON.stringify({ c: [] }), JSON.stringify({ count: 10 })];
    const r = checkQuantities({ text: 'Done: the table now contains 31 rows.', evidence });
    expect(r.status).toBe('failed');
    expect(r.unsupported.map((c) => c.number)).toEqual([31]);
  });

  it('a real count beside a cap is still checked', () => {
    const evidence = [JSON.stringify({ results: rows(9) })];
    const ok = checkQuantities({ text: 'Searches return up to 25 results; this one returned 9 results.', evidence });
    expect(ok.status).toBe('passed');
    const bad = checkQuantities({ text: 'Searches return up to 25 results; this one returned 11 results.', evidence });
    expect(bad.unsupported.map((c) => c.number)).toEqual([11]);
  });

  it('a group size the agent counted by grouping rows is backed', () => {
    const list = [...rows(3, 'Overdue'), ...rows(5, 'Paid')];
    expect(collectEvidenceCounts([JSON.stringify(list)])).toEqual(expect.arrayContaining([8, 3, 5]));
    const r = checkQuantities({ text: 'Overdue Invoices (3 items) need chasing.', evidence: [JSON.stringify(list)] });
    expect(r.status).toBe('passed');
  });
});

describe('checkFigures counts with the shared check', () => {
  const evidence = [JSON.stringify([
    { invoice: 'INV-1', supplier: 'Alder Ltd', status: 'Overdue', amount: 100 },
    { invoice: 'INV-2', supplier: 'Birch Ltd', status: 'Overdue', amount: 200 },
    { invoice: 'INV-3', supplier: 'Alder Ltd', status: 'Paid', amount: 300 },
  ])];
  const counts = (text: string) => checkFigures({ text, evidence }).unsupported.filter((u) => u.kind === 'count');

  // The words after the number must name something in the evidence ("overdue"), or figures skips the
  // claim whatever the number is, and these cases would pass without the shared check.
  it('a cap, a label or a rate naming an evidence noun is not read as a count', () => {
    expect(counts('The export holds up to 50 overdue invoices.')).toEqual([]);
    expect(counts('Check pages 4 through 9 overdue invoices again.')).toEqual([]);
    expect(counts('Reminders go out at 7 overdue invoices per day.')).toEqual([]);
  });

  it('a wrong count of the same noun still fails', () => {
    expect(counts('There are 5 overdue invoices.').map((u) => u.token)).toEqual(['5 overdue invoices']);
  });
});

describe('GROUNDING_VERSION', () => {
  it('is the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(GROUNDING_VERSION).toBe(pkg.version);
  });
});
