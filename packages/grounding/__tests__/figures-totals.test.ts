import { describe, it, expect } from 'vitest';

import { checkFigures, summariseFigureEvidence } from '../src/index.js';

// The same ledger as figures.test.ts. The replies are from the live account on 2026-10-31, after
// the first release of the figure check let them through.
const OVERDUE = [
  { supplier: 'Calder Lift Services', invoice_number: 'CLS-20418', due_date: '2026-09-30', amount: 4860, status: 'Overdue' },
  { supplier: 'Calder Lift Services', invoice_number: 'CLS-20455', due_date: '2026-10-14', amount: 3125.5, status: 'Overdue' },
  { supplier: 'Harbour Waste Management', invoice_number: 'HWM-7731', due_date: '2026-10-17', amount: 1742.8, status: 'Overdue' },
  { supplier: 'Meadowbank Grounds Care', invoice_number: 'MGC-552', due_date: '2026-10-25', amount: 760, status: 'Overdue' },
];
const OTHERS = [1180, 642.5, 2310, 415.2, 3890, 228, 1575.75, 960, 5120, 396].map((amount, i) => ({
  supplier: `Supplier ${i}`, invoice_number: `INV-${1000 + i}`, due_date: '2026-11-20', amount, status: 'Due',
}));
const ROWS = { success: true, rows: [...OVERDUE, ...OTHERS].map((values, i) => ({ id: `row_${i}`, values })) };
// As an agent chat surface passes it: several results as JSON text, one per line.
const EVIDENCE = [`{"status":"ok"}\n${JSON.stringify(ROWS)}`];

const tokens = (text: string, today?: string) =>
  checkFigures({ text, evidence: EVIDENCE, today }).unsupported.map((u) => u.token);

describe('a percentage is a share of a total', () => {
  it('reports a share that is one amount of an unrelated one ("64%" is £3,125.50 of £4,860)', () => {
    const reply = '- **Calder Lift Services** is the biggest concern:\n'
      + '  - **£4,860** (Invoice **CLS-20418**)\n  - **£3,125.50** (Invoice **CLS-20455**)\n'
      + '  *This supplier accounts for **64% of your overdue value** and has the oldest outstanding invoice.*';
    expect(tokens(reply)).toEqual(['64%']);
  });

  it('reports a share whose part the sentence states, against a total it is not ("47%")', () => {
    expect(tokens('Calder Lift Services accounts for 2 of the 4 overdue invoices, totalling £7,985.50 (47% of the overdue total).'))
      .toEqual(['47%']);
  });

  it('passes the share against the group total, with no total in the reply', () => {
    expect(tokens('Calder Lift Services accounts for 2 of the 4 overdue invoices, totalling £7,985.50 (76% of the overdue amount).'))
      .toEqual([]);
  });

  it('passes a share of a group the sentence names, with no amount in it', () => {
    expect(tokens('Calder Lift Services holds 76% of what is overdue.')).toEqual([]);
  });
});

describe('counts', () => {
  it('reports a count no list or group has, and passes the right one', () => {
    expect(tokens('Calder Lift Services accounts for 3 of the 4 overdue invoices.')).toEqual(['3 of the 4']);
    expect(tokens('Calder Lift Services accounts for 2 of the 4 overdue invoices.')).toEqual([]);
    expect(tokens('There are 5 overdue invoices.')).toEqual(['5 overdue invoices']);
    expect(tokens('There are 4 overdue invoices.')).toEqual([]);
  });

  it('leaves a count of something the evidence does not mention alone', () => {
    expect(tokens('Here are 3 key points to consider.')).toEqual([]);
  });
});

describe('dates and days', () => {
  const TODAY = '2026-10-31';

  it('passes a date the records hold, written any usual way, and reports one they do not', () => {
    expect(tokens('CLS-20418 was due on 30 September 2026, CLS-20455 on 14 Oct.', TODAY)).toEqual([]);
    expect(tokens('CLS-20418 was due on 31 August 2026.', TODAY)).toEqual(['31 August 2026']);
  });

  it('reports a payment date the agent made up, and passes today', () => {
    expect(tokens('It will be paid by Friday, 7 November. Today is 31 October.', TODAY)).toEqual(['7 November']);
  });

  it('passes a date the user wrote in words', () => {
    const r = checkFigures({ text: 'Paid on 3 November, as you said.', evidence: [...EVIDENCE, 'We will pay them on 3 November.'], today: TODAY });
    expect(r.unsupported).toEqual([]);
  });

  it('checks days overdue against today and the records, within a day', () => {
    expect(tokens('CLS-20418 is 31 days overdue; MGC-552 is 6 days late.', TODAY)).toEqual([]);
    const r = checkFigures({ text: 'They are 6 to 60 days overdue.', evidence: EVIDENCE, today: TODAY });
    expect(r.unsupported.map((u) => [u.token, u.value])).toEqual([['6 to 60 days overdue', -60]]);
  });

  it('does not read days without today', () => {
    expect(tokens('They are 6 to 60 days overdue.')).toEqual([]);
  });
});

describe('a later turn checks shares, counts and days against the summary alone', () => {
  it('carries totals, counts and dates', () => {
    const summary = summariseFigureEvidence(EVIDENCE);
    const later = (text: string) => checkFigures({ text, evidence: [summary], today: '2026-10-31' }).unsupported.map((u) => u.token);
    expect(later('Calder Lift Services (£7,985.50) is 76% of what is overdue; CLS-20418 is 31 days overdue, 2 of the 4.')).toEqual([]);
    expect(later('Calder Lift Services (£7,985.50) is 64% of what is overdue; it is 3 of the 4.')).toEqual(['64%', '3 of the 4']);
  });

  it('knows which total a named group is, with only the summary to go on', () => {
    const summary = summariseFigureEvidence(EVIDENCE);
    const later = (text: string) => checkFigures({ text, evidence: [summary] }).unsupported.map((u) => u.token);
    expect(later('Pay CLS-20418 (£4,860) first; Calder Lift Services is 76% of what is overdue.')).toEqual([]);
    expect(later('Pay CLS-20418 (£4,860) first; Calder Lift Services is 64% of what is overdue.')).toEqual(['64%']);
    // As a chat surface passes it: the summary inside a longer text, with the user's message after it.
    const inText = `[Tool evidence]\nFigures: ${summary}\nWhich should we pay first?`;
    expect(checkFigures({ text: 'Pay CLS-20418 (£4,860) first; Calder Lift Services is 76% of what is overdue.', evidence: [inText] }).unsupported).toEqual([]);
  });
});
