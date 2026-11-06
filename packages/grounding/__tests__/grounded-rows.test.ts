import { describe, expect, it } from 'vitest';

import {
  checkGroundedRows,
  ungroundedRowsMessage,
  type GroundedRowsDeclaration,
  type GroundedRowsOptions,
  type TranscriptTurn,
} from '../src/index.js';

// The failure these fixtures are shaped on: an agent asked for thirty firms found
// about twenty and padded the table to the number asked for. All names are invented.
const declaration: GroundedRowsDeclaration = { param: 'rows' };

const check = (rows: unknown, transcript: readonly TranscriptTurn[], options?: GroundedRowsOptions) =>
  checkGroundedRows({ call: { tool: 'add_rows', args: { rows } }, transcript, declaration }, options);

const values = (r: { ungrounded: Array<{ value: string }> }) => r.ungrounded.map((u) => u.value);

const found: TranscriptTurn[] = [
  { role: 'user', content: 'Find small hauliers and add them to the targets table.' },
  { role: 'assistant', content: 'Marrowfen Freight and Halden Logistics look good.' },
  {
    role: 'tool',
    tool: 'web_search',
    content: { results: [{ title: 'Corvane & Co Haulage - team', snippet: 'Email jane.ellery@corvane-example.co.uk' }] },
  },
];

describe('checkGroundedRows: what a row may not carry', () => {
  it('a found firm and its published address pass', () => {
    const r = check([{ firm: 'Corvane & Co Haulage Ltd', contact_email: 'jane.ellery@corvane-example.co.uk', status: 'to_draft' }], found);
    expect(r.status).toBe('passed');
    expect(r.checked).toBe(2);
    expect(r.message).toBe('');
  });

  it("refuses a firm only the agent's own prose named", () => {
    const r = check([{ firm: 'Marrowfen Freight', status: 'to_draft' }], found);
    expect(r.status).toBe('failed');
    expect(r.ungrounded).toEqual([{ path: 'rows[0].firm', value: 'Marrowfen Freight' }]);
    expect(r.message).toMatch(/^Refused: Marrowfen Freight appears in no message/);
  });

  it('refuses a guessed address at a found domain, whatever the column is called', () => {
    const r = check([{ firm: 'Corvane & Co Haulage', notes_email: 'sam.ellery@corvane-example.co.uk' }], found);
    expect(r.ungrounded).toEqual([{ path: 'rows[0].notes_email', value: 'sam.ellery@corvane-example.co.uk' }]);
  });

  it("leaves free columns alone: notes, a status and a generic name are the agent's to write", () => {
    const r = check([{ name: 'Week 43 review', notes: 'Follow up on Tuesday', status: 'drafted' }], found);
    expect(r).toEqual({ status: 'skipped', checked: 0, ungrounded: [], message: '' });
  });

  it('knows a found column however it is spelled', () => {
    for (const column of ['Company Name', 'company-name', 'COMPANY_NAME', 'companyname', 'Organisation', 'organization_name', 'Contact Person', 'full name']) {
      expect(check([{ [column]: 'Marrowfen Freight' }], found).status).toBe('failed');
    }
  });

  it('reports a value once, however many rows carry it', () => {
    const r = check([{ firm: 'Marrowfen Freight' }, { firm: 'Marrowfen Freight' }, { firm: 'Halden Logistics' }], found);
    expect(values(r)).toEqual(['Marrowfen Freight', 'Halden Logistics']);
    expect(r.checked).toBe(3);
  });

  it('tells the model not to pad a list and not to build an address', () => {
    const message = ungroundedRowsMessage([{ path: 'rows[0].firm', value: 'Marrowfen Freight' }]);
    expect(message).toContain('never pad');
    expect(message).toContain('never construct an address');
    expect(message).toContain('Nothing was run.');
    expect(ungroundedRowsMessage([{ path: 'a', value: 'A' }, { path: 'b', value: 'B' }])).toMatch(/^Refused: A, B appear in no message/);
  });
});

describe('checkGroundedRows: every shape a row arrives in', () => {
  const invented = { firm: 'Marrowfen Freight', status: 'won' };
  const shape = (decl: GroundedRowsDeclaration, args: unknown) =>
    checkGroundedRows({ call: { tool: 'update_rows', args }, transcript: found, declaration: decl });

  it('reads an array of rows, ignoring anything that is not a row', () => {
    const r = check([invented, 'x', 7, null, ['y']], found);
    expect(r.ungrounded).toEqual([{ path: 'rows[0].firm', value: 'Marrowfen Freight' }]);
  });

  it('reads one row', () => {
    const r = shape({ param: 'values', single: true }, { values: invented });
    expect(r.ungrounded).toEqual([{ path: 'values.firm', value: 'Marrowfen Freight' }]);
  });

  it('reads rows held under a field, skipping an item without one', () => {
    const r = shape({ param: 'updates', field: 'values' }, { updates: [{ id: 'r1' }, { id: 'r2', values: invented }, 'x'] });
    expect(r.ungrounded).toEqual([{ path: 'updates[1].values.firm', value: 'Marrowfen Freight' }]);
  });

  it('reads a call whose arguments arrived as a JSON string', () => {
    expect(values(shape({ param: 'rows' }, JSON.stringify({ rows: [invented] })))).toEqual(['Marrowfen Freight']);
  });

  it('skips a call with nothing to check', () => {
    for (const args of [{}, { rows: 'x' }, { rows: [] }, { rows: { firm: 'Marrowfen' } }, 'not json', null]) {
      expect(shape({ param: 'rows' }, args).status).toBe('skipped');
    }
    expect(shape({ param: 'values', single: true }, { values: [invented] }).status).toBe('skipped');
  });

  it('skips a value that is not text, and an empty one', () => {
    expect(check([{ firm: 7 }, { firm: '  ' }, { firm: null }, { firm: true }], found).status).toBe('skipped');
  });
});

describe('checkGroundedRows: an address is compared as an address', () => {
  const seen = (content: unknown): TranscriptTurn[] => [{ role: 'tool', tool: 'web_search', content }];

  it('a domain in a found column is not grounded by a longer domain that ends in its words', () => {
    const longer = seen('https://john-smith-example.co.uk/');
    expect(values(check([{ company: 'smith-example.co.uk' }], longer))).toEqual(['smith-example.co.uk']);
    expect(values(check([{ company: 'https://www.smith-example.co.uk/' }], longer))).toEqual(['https://www.smith-example.co.uk/']);
  });

  it('a domain in a found column is not grounded by the word it is made of', () => {
    expect(values(check([{ company: 'smith-example.co.uk' }], [{ role: 'user', content: 'Ask smith example about it.' }]))).toEqual(['smith-example.co.uk']);
  });

  it('a trailing full stop does not reduce a domain in a found column to its suffix', () => {
    const real = seen('https://real-example.com/');
    expect(values(check([{ company: 'invented-example.com.' }], real))).toEqual(['invented-example.com.']);
    expect(check([{ company: 'real-example.com.' }], real).status).toBe('passed');
  });

  it('a domain that was named passes, through any of its hosts', () => {
    expect(check([{ company: 'corvane-example.co.uk' }], seen('https://www.corvane-example.co.uk/team')).status).toBe('passed');
  });

  it('an email address is not grounded by a longer one that ends in the same words', () => {
    expect(values(check([{ contact_email: 'smith@corvane-example.co.uk' }], seen('john-smith@corvane-example.co.uk')))).toEqual(['smith@corvane-example.co.uk']);
  });

  it('an email address is not grounded by one at a longer domain', () => {
    expect(values(check([{ contact_email: 'jo@corvane-example.com' }], seen('jo@corvane-example.com.au')))).toEqual(['jo@corvane-example.com']);
    expect(values(check([{ contact_email: 'jo@corvane-example.com' }], seen('jo@corvane-example.com.elsewhere.net')))).toEqual(['jo@corvane-example.com']);
  });

  it('an email address is not grounded by its own words', () => {
    expect(values(check([{ contact_email: 'jo@corvane-example.com' }], [{ role: 'user', content: 'Ask Jo: corvane example com.' }]))).toEqual(['jo@corvane-example.com']);
  });

  it('an address with a trailing full stop is read, in any column, rather than passed as free text', () => {
    const r = check([{ notes: 'jo@invented-example.com.' }], seen('https://invented-example.com/'));
    expect(values(r)).toEqual(['jo@invented-example.com.']);
    expect(check([{ notes: 'jo@corvane-example.com.' }], seen('Write to jo@corvane-example.com.')).status).toBe('passed');
  });

  it('reads an address behind a display name, and a list of addresses, in any column', () => {
    const page = seen('Write to jane.ellery@corvane-example.co.uk');
    expect(check([{ contact: 'Jane Ellery <jane.ellery@corvane-example.co.uk>' }], page).status).toBe('passed');
    expect(values(check([{ notes: 'jane.ellery@corvane-example.co.uk; sam@corvane-example.co.uk' }], page))).toEqual(['sam@corvane-example.co.uk']);
  });

  it('reads a column that holds a list', () => {
    const r = check([{ emails: ['jane.ellery@corvane-example.co.uk', 'sam@corvane-example.co.uk'], firm: ['Marrowfen Freight'] }], found);
    expect(r.ungrounded).toEqual([
      { path: 'rows[0].emails[1]', value: 'sam@corvane-example.co.uk' },
      { path: 'rows[0].firm[0]', value: 'Marrowfen Freight' },
    ]);
  });

  it('prose that mentions an address in a free column stays free', () => {
    expect(check([{ notes: 'Asked jo@invented-example.com for a quote' }], found).status).toBe('skipped');
  });
});

describe('checkGroundedRows: what grounds nothing', () => {
  const row = [{ firm: 'Marrowfen Freight' }];

  it('an earlier call of the same tool does not ground what it was given', () => {
    expect(values(check(row, [{ role: 'tool', tool: 'add_rows', content: { added: ['Marrowfen Freight'] } }]))).toEqual(['Marrowfen Freight']);
  });

  it('a failed call does not ground what it refused', () => {
    expect(values(check(row, [{ role: 'tool', tool: 'lookup', ok: false, content: 'Refused: Marrowfen Freight' }]))).toEqual(['Marrowfen Freight']);
  });

  it('an address another tool only echoed from its own arguments is not evidence', () => {
    const echoed: TranscriptTurn = { role: 'tool', tool: 'lookup', args: { email: 'jo@marrowfen-example.com' }, content: { checked: 'jo@marrowfen-example.com' } };
    expect(values(check([{ contact_email: 'jo@marrowfen-example.com' }], [echoed]))).toEqual(['jo@marrowfen-example.com']);
  });

  it('a system turn does not count unless the caller asks', () => {
    const system: TranscriptTurn[] = [{ role: 'system', content: 'Good examples include Marrowfen Freight.' }];
    expect(values(check(row, system))).toEqual(['Marrowfen Freight']);
    expect(check(row, system, { systemEvidence: 'first' }).status).toBe('passed');
  });
});
