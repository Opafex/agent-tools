import { describe, it, expect } from 'vitest';

import { checkAmbiguousTarget, checkRepeatedCall, canonicalArgs, type TranscriptTurn } from '../src/index.js';

// From a real run: "Email Sam to say the revised schedule is attached." The CRM
// holds two Sams. The model searched, took the first, and sent. Every value in
// the call was grounded; it was still a coin toss.
const SAM_ELLERY = {
  id: 'ct_3m7q',
  name: 'Sam Ellery',
  title: 'Fleet Manager',
  email: 'sam.ellery@haldenfreight.co.uk',
  company: 'Halden Freight',
};
const SAM_DELANEY = {
  id: 'ct_2q7z',
  name: 'Sam Delaney',
  title: 'Quantity Surveyor',
  email: 'sam.delaney@mossgatebuilders.co.uk',
  company: 'Mossgate Builders',
};
const search: TranscriptTurn = {
  role: 'tool',
  tool: 'crm_search_contacts',
  args: { query: 'Sam' },
  content: JSON.stringify({ count: 2, results: [SAM_ELLERY, SAM_DELANEY] }),
};
const sendTo = (...to: string[]) => ({ tool: 'email_send', args: { to, subject: 'Revised schedule', body: 'Attached.' } });

describe('checkAmbiguousTarget', () => {
  it('flags a send to one of two people the user named the same way', () => {
    const r = checkAmbiguousTarget({
      call: sendTo('sam.ellery@haldenfreight.co.uk'),
      transcript: [{ role: 'user', content: 'Email Sam to say the revised schedule is attached.' }, search],
    });
    expect(r.status).toBe('ambiguous');
    expect(r.ambiguous[0]?.matchedWords).toEqual(['sam']);
    expect(r.ambiguous[0]?.alternatives).toEqual([SAM_DELANEY]);
    expect(r.ambiguous[0]?.sourceTool).toBe('crm_search_contacts');
    expect(r.message).toMatch(/fits 2 records returned by crm_search_contacts/);
  });

  it('is clear when the user said something only the chosen record has', () => {
    const r = checkAmbiguousTarget({
      call: sendTo('sam.ellery@haldenfreight.co.uk'),
      transcript: [{ role: 'user', content: 'Email Sam at Halden to say the revised schedule is attached.' }, search],
    });
    expect(r.status).toBe('clear');
  });

  it("is clear once the user has answered which one", () => {
    const r = checkAmbiguousTarget({
      call: sendTo('sam.delaney@mossgatebuilders.co.uk'),
      transcript: [
        { role: 'user', content: 'Email Sam to say the revised schedule is attached.' },
        search,
        { role: 'assistant', content: 'Which Sam: Sam Ellery (Halden Freight) or Sam Delaney (Mossgate Builders)?' },
        { role: 'user', content: 'Delaney' },
      ],
    });
    expect(r.status).toBe('clear');
  });

  it('is clear when the call targets every record the words fit', () => {
    const r = checkAmbiguousTarget({
      call: sendTo('sam.ellery@haldenfreight.co.uk', 'sam.delaney@mossgatebuilders.co.uk'),
      transcript: [{ role: 'user', content: 'Email both Sams that the site is closed.' }, search],
    });
    // "sams" is not "sam", so no words match and the check does not apply.
    expect(r.status).not.toBe('ambiguous');
    const plain = checkAmbiguousTarget({
      call: sendTo('sam.ellery@haldenfreight.co.uk', 'sam.delaney@mossgatebuilders.co.uk'),
      transcript: [{ role: 'user', content: 'Email Sam E and Sam D that the site is closed.' }, search],
    });
    expect(plain.status).toBe('clear');
  });

  it('does not apply when the record was chosen by reasoning, not by name', () => {
    const deals = {
      role: 'tool' as const,
      tool: 'deals_list',
      content: {
        deals: [
          { id: 'dl_e8p1', name: 'Corvane platform renewal', amount: 48000, stage: 'negotiation' },
          { id: 'dl_k2m9', name: 'Halden fleet tracking', amount: 62000, stage: 'proposal' },
        ],
      },
    };
    const r = checkAmbiguousTarget({
      call: { tool: 'deals_update_stage', args: { deal_id: 'dl_k2m9', stage: 'won' } },
      transcript: [{ role: 'user', content: 'Mark the largest open deal as won.' }, deals],
    });
    expect(r.status).toBe('skipped');
  });

  it('skips when the value came from a single record, not a list', () => {
    const r = checkAmbiguousTarget({
      call: sendTo('sam.ellery@haldenfreight.co.uk'),
      transcript: [
        { role: 'user', content: 'Email Sam.' },
        { role: 'tool', tool: 'crm_get_contact', content: SAM_ELLERY },
      ],
    });
    expect(r.status).toBe('skipped');
  });

  it('ignores lists from failed calls and from the same tool', () => {
    const failed = checkAmbiguousTarget({
      call: sendTo('sam.ellery@haldenfreight.co.uk'),
      transcript: [{ role: 'user', content: 'Email Sam.' }, { ...search, ok: false }],
    });
    expect(failed.status).toBe('skipped');
    const same = checkAmbiguousTarget({
      call: { tool: 'crm_search_contacts', args: { query: 'sam.ellery@haldenfreight.co.uk' } },
      transcript: [{ role: 'user', content: 'Find Sam.' }, search],
    });
    expect(same.status).toBe('skipped');
  });
});

describe('checkRepeatedCall', () => {
  const day = { tool: 'calendar_list', args: { date: '2026-11-03' } };

  it('refuses the third identical call by default', () => {
    expect(checkRepeatedCall({ call: day, history: [day] }).status).toBe('passed');
    const r = checkRepeatedCall({ call: day, history: [day, day] });
    expect(r.status).toBe('repeated');
    expect(r.previous).toBe(2);
    expect(r.message).toMatch(/already called calendar_list with exactly these arguments 2 times/);
  });

  it('treats key order and JSON-string arguments as the same call', () => {
    const a = { tool: 'deals_get', args: { deal_id: 'dl_x1', expand: true } };
    const b = { tool: 'deals_get', args: '{"expand":true,"deal_id":"dl_x1"}' };
    expect(canonicalArgs(a.args)).toBe(canonicalArgs(b.args));
    expect(checkRepeatedCall({ call: b, history: [a, a] }).status).toBe('repeated');
  });

  it('counts only the same tool with the same arguments', () => {
    const other = { tool: 'calendar_list', args: { date: '2026-11-04' } };
    expect(checkRepeatedCall({ call: day, history: [other, other, { tool: 'inbox_list', args: { date: '2026-11-03' } }] }).status).toBe(
      'passed',
    );
  });

  it('allows a per-tool limit for a tool whose results change', () => {
    const poll = { tool: 'job_status', args: { id: 'job_9a' } };
    const history = [poll, poll, poll];
    expect(checkRepeatedCall({ call: poll, history }).status).toBe('repeated');
    expect(checkRepeatedCall({ call: poll, history }, { perTool: { job_status: 10 } }).status).toBe('passed');
  });
});
