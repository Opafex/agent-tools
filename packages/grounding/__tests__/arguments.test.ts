import { describe, it, expect } from 'vitest';

import { checkToolArguments, identifierArguments, type TranscriptTurn } from '../src/index.js';

// Shapes taken from a real run: a 4B local model asked to "Email Lena Marsh to
// confirm I've received her message" sent to lena.marsh@example.com without
// looking her up. Her real address is in the CRM.
const OPERATOR: TranscriptTurn = {
  role: 'system',
  content: 'You are the assistant for Jordan Hale (jordan.hale@northwind-ops.co.uk). Use tools to act.',
};
const LENA = {
  id: 'ct_2h6v',
  name: 'Lena Marsh',
  title: 'Practice Manager',
  email: 'lena.marsh@brightwaterdental.co.uk',
  phone: '+44 161 496 0410',
  company: 'Brightwater Dental',
};

const send = (to: string[]) => ({ tool: 'email_send', args: { to, subject: 'Received', body: 'Thanks Lena, invite to follow.' } });

describe('checkToolArguments: invented values are refused before the call runs', () => {
  it('refuses an address the model made up', () => {
    const r = checkToolArguments({
      call: send(['lena.marsh@example.com']),
      transcript: [OPERATOR, { role: 'user', content: "Email Lena Marsh to confirm I've received her message." }],
    });
    expect(r.status).toBe('failed');
    expect(r.ungrounded).toEqual([{ path: 'to[0]', value: 'lena.marsh@example.com', kind: 'email' }]);
    expect(r.message).toMatch(/^Refused: lena\.marsh@example\.com appears in no message/);
  });

  it('passes the address a tool returned', () => {
    const r = checkToolArguments({
      call: send(['lena.marsh@brightwaterdental.co.uk']),
      transcript: [
        OPERATOR,
        { role: 'user', content: "Email Lena Marsh to confirm I've received her message." },
        { role: 'tool', tool: 'crm_search_contacts', args: { query: 'Lena Marsh' }, content: { count: 1, results: [LENA] } },
      ],
    });
    expect(r.status).toBe('passed');
    expect(r.checked).toBe(1);
  });

  it('refuses a pattern-built address even when the domain was seen', () => {
    const r = checkToolArguments({
      call: send(['l.marsh@brightwaterdental.co.uk']),
      transcript: [{ role: 'tool', tool: 'crm_search_contacts', content: JSON.stringify({ results: [LENA] }) }],
    });
    expect(r.status).toBe('failed');
  });

  it("passes the operator's own address from the first system turn, not from later ones", () => {
    const self = checkToolArguments({ call: send(['jordan.hale@northwind-ops.co.uk']), transcript: [OPERATOR] });
    expect(self.status).toBe('passed');

    // A later system turn is the harness quoting the model (a plan it wrote).
    const later = checkToolArguments({
      call: send(['ops@northwind-ops.co.uk']),
      transcript: [OPERATOR, { role: 'system', content: 'Plan: 1. email ops@northwind-ops.co.uk' }],
    });
    expect(later.status).toBe('failed');
    const all = checkToolArguments(
      { call: send(['ops@northwind-ops.co.uk']), transcript: [OPERATOR, { role: 'system', content: 'Escalations go to ops@northwind-ops.co.uk' }] },
      { systemEvidence: 'all' },
    );
    expect(all.status).toBe('passed');
  });

  it("never counts the model's own text", () => {
    const r = checkToolArguments({
      call: send(['lena@brightwater.co.uk']),
      transcript: [{ role: 'user', content: 'Email Lena.' }, { role: 'assistant', content: 'I will email lena@brightwater.co.uk.' }],
    });
    expect(r.status).toBe('failed');
  });

  it('does not let a value ground itself through an echo or a failed call', () => {
    // The same tool echoing what it was given.
    const sameTool = checkToolArguments({
      call: { tool: 'crm_get_contact', args: { contact_id: 'ct_9z9z' } },
      transcript: [{ role: 'tool', tool: 'crm_get_contact', content: { id: 'ct_9z9z', error: 'not found' } }],
    });
    expect(sameTool.status).toBe('failed');

    // An error from another tool quoting the refused value.
    const failed = checkToolArguments({
      call: { tool: 'add_contact_note', args: { contact_id: 'ct_9z9z', text: 'x' } },
      transcript: [{ role: 'tool', tool: 'crm_get_contact', ok: false, content: 'No contact with id "ct_9z9z".' }],
    });
    expect(failed.status).toBe('failed');

    // Another tool echoing its own argument back.
    const echoed = checkToolArguments({
      call: { tool: 'email_send', args: { to: ['sam@kestrelworks.co.uk'] } },
      transcript: [
        { role: 'tool', tool: 'check_address', args: { email: 'sam@kestrelworks.co.uk' }, content: 'sam@kestrelworks.co.uk: format ok' },
      ],
    });
    expect(echoed.status).toBe('failed');
  });

  it('matches ids whole, so a prefix of a real id is not grounded', () => {
    const t: TranscriptTurn[] = [{ role: 'tool', tool: 'deals_list', content: { deals: [{ id: 'dl_e8p1' }] } }];
    expect(checkToolArguments({ call: { tool: 'deals_update_stage', args: { deal_id: 'dl_e8p1' } }, transcript: t }).status).toBe('passed');
    expect(checkToolArguments({ call: { tool: 'deals_update_stage', args: { deal_id: 'dl_e8p' } }, transcript: t }).status).toBe('failed');
    // Guessed ids that look plausible: the real failure was 11 guesses like this.
    expect(checkToolArguments({ call: { tool: 'deals_get', args: { deal_id: 'dl_corvane_2026' } }, transcript: t }).status).toBe('failed');
  });

  it('matches an address whole, so a longer address does not ground a shorter one', () => {
    const t: TranscriptTurn[] = [{ role: 'tool', tool: 'crm_search_contacts', content: { results: [{ email: 'jsam@kestrelworks.co.uk' }] } }];
    expect(checkToolArguments({ call: send(['sam@kestrelworks.co.uk']), transcript: t }).status).toBe('failed');
    expect(checkToolArguments({ call: send(['jsam@kestrelworks.co.uk']), transcript: t }).status).toBe('passed');
  });

  it('compares phone numbers on their digits', () => {
    const t: TranscriptTurn[] = [{ role: 'tool', tool: 'crm_get_contact', content: LENA }];
    const call = (phone: string) => ({ tool: 'sms_send', args: { phone, text: 'Running late' } });
    expect(checkToolArguments({ call: call('0161 496 0410'), transcript: t }).status).toBe('passed');
    expect(checkToolArguments({ call: call('+44 (0)161 496 0410'), transcript: t }).status).toBe('passed');
    expect(checkToolArguments({ call: call('+44 161 496 0411'), transcript: t }).status).toBe('failed');
  });

  it('skips a call with nothing identifier-shaped, and ignores free text', () => {
    const r = checkToolArguments({
      call: { tool: 'tasks_create', args: { title: 'Chase signed contract', due: '2026-11-06', priority: 'high' } },
      transcript: [],
    });
    expect(r.status).toBe('skipped');
    // An address inside the body is prose for the prose checks, not an argument.
    const body = checkToolArguments({
      call: { tool: 'email_send', args: { to: ['jordan.hale@northwind-ops.co.uk'], body: 'cc finance@made-up.co.uk' } },
      transcript: [OPERATOR],
    });
    expect(body.status).toBe('passed');
  });

  it('honours ignorePaths and kinds', () => {
    const call = { tool: 'email_send', args: { to: ['x@made-up.co.uk'], reply_to: 'y@made-up.co.uk' } };
    const ignored = checkToolArguments({ call, transcript: [] }, { ignorePaths: ['reply_to', 'to[]'] });
    expect(ignored.status).toBe('skipped');
    const onlyIds = checkToolArguments({ call, transcript: [] }, { kinds: ['id'] });
    expect(onlyIds.status).toBe('skipped');
  });

  it('accepts arguments as a JSON string, as most model APIs return them', () => {
    const r = checkToolArguments({ call: { tool: 'email_send', args: '{"to":["lena.marsh@example.com"]}' }, transcript: [] });
    expect(r.status).toBe('failed');
  });

  it('does not treat dates, amounts or plain words as identifiers', () => {
    const found = identifierArguments({
      due: '2026-11-06',
      start: '2026-11-03T11:00:00Z',
      amount: '62000',
      stage: 'closed_won',
      title: 'Fleet tracking scoping',
      version: '1.2.3',
    });
    expect(found).toEqual([]);
  });
});
