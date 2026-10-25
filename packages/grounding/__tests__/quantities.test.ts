import { describe, it, expect } from 'vitest';

import { checkQuantities, collectEvidenceCounts, extractQuantityClaims } from '../src/index.js';

describe('extractQuantityClaims', () => {
  it('captures collection counts and ignores other numbers', () => {
    const claims = extractQuantityClaims('Your table has 6 rows and 8 records total, logged over 3 days for £9.15 each.');
    expect(claims.map((c) => c.number).sort((a, b) => a - b)).toEqual([6, 8]);
  });

  it('binds the number to the noun through qualifiers', () => {
    const claims = extractQuantityClaims('leaving you with 4 clean unique rows');
    expect(claims).toHaveLength(1);
    expect(claims[0]?.number).toBe(4);
    expect(claims[0]?.noun).toMatch(/rows$/);
  });

  it('handles "N rows total"', () => {
    expect(extractQuantityClaims('Your Expenses table sits at 8 rows total.').map((c) => c.number)).toEqual([8]);
  });
});

describe('collectEvidenceCounts', () => {
  it('reads array lengths and count fields from structured values', () => {
    expect(collectEvidenceCounts([{ rows: [{ a: 1 }, { a: 2 }], count: 2 }])).toEqual([2]);
  });

  it('mines JSON lines and embedded count fields from strings', () => {
    const counts = collectEvidenceCounts([
      '{"success":true,"rows":[{"id":1},{"id":2}],"row_count":2}\nsome tool text with "deleted": 4 embedded',
    ]);
    expect(counts).toContain(2);
    expect(counts).toContain(4);
  });

  it('returns nothing when nothing is countable', () => {
    expect(collectEvidenceCounts(['just prose, no json, no counts'])).toEqual([]);
    expect(collectEvidenceCounts(undefined)).toEqual([]);
  });
});

describe('checkQuantities', () => {
  // The tool returned two rows; the agent reported six, then eight.
  const evidence = [JSON.stringify({ rows: [{ amount: 12.08, currency: 'USD' }, { amount: 12.28, currency: 'USD' }], count: 2 })];

  it('flags counts no tool result supports', () => {
    const r = checkQuantities({
      text: 'Your Expenses table has 6 rows, 4 GBP and 2 USD, and now sits at 8 rows total.',
      evidence,
    });
    expect(r.status).toBe('failed');
    expect(r.evidenceCounts).toContain(2);
    expect(r.unsupported.map((u) => u.number).sort((a, b) => a - b)).toEqual([6, 8]);
  });

  it('passes a count that matches', () => {
    const r = checkQuantities({ text: 'Your Expenses table has 2 rows, both USD charges.', evidence });
    expect(r.status).toBe('passed');
  });

  it('treats a claim matching any real count as supported', () => {
    const r = checkQuantities({
      text: 'Removed 4 rows; 2 rows remain.',
      evidence: ['{"rows":[{"x":1},{"x":2}],"count":2,"deleted":4}'],
    });
    expect(r.status).toBe('passed');
  });

  it('skips when there are no claims', () => {
    const r = checkQuantities({ text: 'I logged the receipts and everything looks tidy.', evidence: ['{"count":1}'] });
    expect(r.status).toBe('skipped');
  });

  it('skips rather than guesses when the evidence has no count', () => {
    const r = checkQuantities({ text: 'Your table has 6 rows.', evidence: ['a refusal string with no json and no count'] });
    expect(r.status).toBe('skipped');
    expect(r.unsupported).toHaveLength(0);
  });
});
