import { describe, it, expect } from 'vitest';

import { checkFigures, extractFigureClaims, collectEvidenceFigures, runGroundingGate, summariseFigureEvidence } from '../src/index.js';

// A ledger of 14 invoices, four of them overdue, as a table tool returns it. The failing
// replies below are verbatim from a live account (2026-10-30).
const OVERDUE = [
  { supplier: 'Calder Lift Services', invoice_number: 'CLS-20418', due_date: '2026-09-30', amount: 4860, status: 'Overdue' },
  { supplier: 'Calder Lift Services', invoice_number: 'CLS-20455', due_date: '2026-10-14', amount: 3125.5, status: 'Overdue' },
  { supplier: 'Harbour Waste Management', invoice_number: 'HWM-7731', due_date: '2026-10-17', amount: 1742.8, status: 'Overdue' },
  { supplier: 'Meadowbank Grounds Care', invoice_number: 'MGC-552', due_date: '2026-10-25', amount: 760, status: 'Overdue' },
];
const OTHERS = [1180, 642.5, 2310, 415.2, 3890, 228, 1575.75, 960, 5120, 396].map((amount, i) => ({
  supplier: `Supplier ${i}`, invoice_number: `INV-${1000 + i}`, due_date: '2026-11-20', amount, status: 'Due',
}));
const EVIDENCE = [{ success: true, rows: [...OVERDUE, ...OTHERS].map((values, i) => ({ id: `row_${i}`, values })) }];

const check = (text: string) => checkFigures({ text, evidence: EVIDENCE });

describe('extractFigureClaims', () => {
  it('reads money, percentages and reference codes, and skips approximations', () => {
    const claims = extractFigureClaims('Pay £4,860.00 (CLS-20418), 76% of the £10,488.30 overdue; roughly £3k is due later.');
    expect(claims.map((c) => [c.kind, c.value])).toEqual([
      ['money', 486000], ['money', 1048830], ['percent', 76], ['reference', 'CLS-20418'],
    ]);
  });
});

describe('collectEvidenceFigures', () => {
  it('takes amounts as money and leaves identifiers and dates as plain numbers', () => {
    const ev = collectEvidenceFigures(EVIDENCE);
    expect(ev.money).toContain(486000);
    expect(ev.money).toContain(312550);
    expect(ev.money).not.toContain(2026);
  });
});

describe('checkFigures', () => {
  it('passes a correct reply: amounts, the total, a per-supplier total and the share', () => {
    const r = check(
      '4 invoices are overdue, totalling £10,488.30. Calder Lift Services has two (£7,985.50 combined: £4,860 and £3,125.50), '
      + '76% of the overdue amount. Harbour Waste Management owes £1,742.80 and Meadowbank Grounds Care £760. Pay CLS-20418 first.',
    );
    expect(r.unsupported).toEqual([]);
    expect(r.status).toBe('passed');
  });

  it('reports suppliers and amounts invented in a turn that read nothing like them', () => {
    const r = check('- **BrightLight Electrical** (£3,250) — Due 15 October 2026.\n- **GreenClean Waste** (£4,340) — Due 20 October 2026.');
    expect(r.unsupported.map((u) => u.token)).toEqual(['£3,250', '£4,340']);
  });

  it('reports a wrong total for two invoices', () => {
    expect(check('Supplier with 2 overdue invoices (total £6,720)').unsupported.map((u) => u.token)).toEqual(['£6,720']);
  });

  it('reports a share the figures do not give', () => {
    const r = check('Calder Lift Services accounts for 78% of the overdue amount (£7,985.50 of £10,488.30).');
    expect(r.unsupported.map((u) => u.token)).toEqual(['78%']);
  });

  it('reports an invoice number the table does not hold', () => {
    expect(check('Your invoice CL-2026-0984 (£4,860) will be paid this week.').unsupported.map((u) => u.token)).toEqual(['CL-2026-0984']);
  });

  it('accepts a share written to one decimal place', () => {
    expect(check("Calder's £7,985.50 is 76.1% of the £10,488.30.").unsupported).toEqual([]);
  });

  it('skips prose with no figures, and figures with no evidence to compare against', () => {
    expect(checkFigures({ text: 'Calder Lift is the priority.', evidence: EVIDENCE }).status).toBe('skipped');
    expect(checkFigures({ text: 'It costs £50.', evidence: [] }).status).toBe('skipped');
  });

  it('still reports an invented reference code when the evidence holds no numbers', () => {
    expect(checkFigures({ text: 'See INV-9999.', evidence: ['no figures here'] }).unsupported.map((u) => u.token)).toEqual(['INV-9999']);
  });
});

describe('runGroundingGate with figures', () => {
  it('reports an invented amount only when the figures check is asked for', () => {
    const input = { text: 'Supplier with 2 overdue invoices (total £6,720)', evidence: EVIDENCE };
    expect(runGroundingGate(input).violations).toEqual([]);
    const on = runGroundingGate(input, { figures: true, severity: { figures: 'error' } });
    expect(on.status).toBe('fail');
    expect(on.violations.map((v) => v.code)).toEqual(['unsupported_figure']);
    expect(on.violations[0]?.message).toContain('£6,720');
  });
});

describe('summariseFigureEvidence', () => {
  it('carries the figures forward: a later reply repeating them is backed by the summary alone', () => {
    const summary = summariseFigureEvidence(EVIDENCE);
    expect(summary).toContain('CLS-20418');
    expect(summary.length).toBeLessThan(1000);
    const later = checkFigures({
      text: "Pay CLS-20418 (£4,860) first; Calder's two total £7,985.50, 76% of the £10,488.30 overdue.",
      evidence: [summary],
    });
    expect(later.unsupported).toEqual([]);
    expect(checkFigures({ text: 'Invoice CL-2026-0984 for £6,720.', evidence: [summary] }).unsupported.map((u) => u.token))
      .toEqual(['£6,720', 'CL-2026-0984']);
  });
});
