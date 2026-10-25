import { describe, it, expect } from 'vitest';

import { checkWrites, type WriteCall } from '../src/index.js';

// What the mailbox search actually returned: three receipts from an invented
// supplier. The numbers the agent invents below appear nowhere in it.
const EVIDENCE = [
  'Acme Ltd Receipt £12.22 Paid 21 March 2025 Receipt number 4810-3392-1057 Invoice number 7QX2K9LM-0042 ' +
    'Acme Ltd Receipt £12.30 Paid 28 February 2025 Receipt number 4733-1186-2290 ' +
    'Acme Ltd Receipt £12.64 Paid 16 January 2025 Receipt number 4691-5504-8813',
];

const addRows = (values: Array<Record<string, unknown>>): WriteCall[] => [{ tool: 'add_rows', values }];

describe('checkWrites: invented references', () => {
  it('flags receipt numbers that appear in no evidence', () => {
    const r = checkWrites({
      writes: addRows([
        { date: '2025-03-17', amount: 12.17, receipt_ref: '4802-7719-3346' },
        { date: '2025-03-16', amount: 12.28, receipt_ref: '4799-2054-6631' },
      ]),
      evidence: EVIDENCE,
    });
    expect(r.status).toBe('failed');
    expect(r.ungrounded.map((f) => f.token).sort()).toEqual(['4799-2054-6631', '4802-7719-3346']);
    expect(r.ungrounded[0]?.field).toBe('receipt_ref');
    expect(r.ungrounded.every((f) => f.tool === 'add_rows')).toBe(true);
  });

  it('passes a receipt number that is in the evidence', () => {
    const r = checkWrites({
      writes: addRows([{ date: '2025-03-21', amount: 12.22, receipt_ref: '4810-3392-1057' }]),
      evidence: EVIDENCE,
    });
    expect(r.status).toBe('passed');
    expect(r.ungrounded).toEqual([]);
  });

  it('flags only the invented row in a mixed batch, with its row index', () => {
    const r = checkWrites({
      writes: addRows([
        { receipt_ref: '4810-3392-1057' },
        { receipt_ref: '4756-0381-9924' },
      ]),
      evidence: EVIDENCE,
    });
    expect(r.ungrounded.map((f) => f.token)).toEqual(['4756-0381-9924']);
    expect(r.ungrounded[0]?.row).toBe(1);
  });

  it('checks a single-record write, which carries no row index', () => {
    const r = checkWrites({
      writes: [{ tool: 'update_row', values: { receipt_ref: '4802-7719-3346' } }],
      evidence: EVIDENCE,
    });
    expect(r.status).toBe('failed');
    expect(r.ungrounded[0]?.row).toBeUndefined();
  });

  it('matches alphanumeric invoice references', () => {
    expect(
      checkWrites({ writes: addRows([{ description: 'Top-up, Inv 7QX2K9LM-0042' }]), evidence: EVIDENCE }).status,
    ).toBe('passed');
    const invented = checkWrites({ writes: addRows([{ description: 'Top-up, Inv 7QX2K9LM-0051' }]), evidence: EVIDENCE });
    expect(invented.status).toBe('failed');
    expect(invented.ungrounded[0]?.token).toBe('7QX2K9LM-0051');
  });

  it('treats citation content as evidence', () => {
    const r = checkWrites({
      writes: addRows([{ receipt_ref: '4691-5504-8813' }]),
      citations: { 1: { content: 'Receipt number 4691-5504-8813' } },
    });
    expect(r.status).toBe('passed');
  });
});

describe('checkWrites: precision', () => {
  it('ignores dates, amounts and ordinary text', () => {
    const r = checkWrites({
      writes: addRows([{ date: '2025-03-17', amount: 12.17, category: 'Software & Subscriptions', currency: 'GBP', status: 'Paid' }]),
      evidence: ['no identifiers here at all'],
    });
    expect(r.status).toBe('skipped');
  });

  it('ignores a call that did not execute', () => {
    const r = checkWrites({
      writes: [{ tool: 'add_rows', executed: false, values: [{ receipt_ref: '9999-9999-9999' }] }],
      evidence: EVIDENCE,
    });
    expect(r.status).toBe('skipped');
  });

  it('skips when there are no writes', () => {
    expect(checkWrites({ evidence: EVIDENCE }).status).toBe('skipped');
  });
});
