import { describe, expect, it } from 'vitest';

import {
  checkGroundedAddresses,
  ungroundedAddressesMessage,
  type GroundedAddressesDeclaration,
  type GroundedAddressesOptions,
  type TranscriptTurn,
} from '../src/index.js';

// An address is the one value that reaches a stranger when it is wrong. All names
// here are invented.
const declaration: GroundedAddressesDeclaration = { params: ['to', 'cc'] };

const check = (args: unknown, transcript: readonly TranscriptTurn[], options?: GroundedAddressesOptions) =>
  checkGroundedAddresses({ call: { tool: 'save_draft', args }, transcript, declaration }, options);

const values = (r: { ungrounded: Array<{ value: string }> }) => r.ungrounded.map((u) => u.value);

const page: TranscriptTurn[] = [
  { role: 'user', content: 'Their team page lists jane.ellery@corvane-example.co.uk and info@corvane-example.co.uk.' },
];
const seen = (content: unknown): TranscriptTurn[] => [{ role: 'tool', tool: 'web_search', content }];

describe('checkGroundedAddresses: an address must be named whole', () => {
  it('accepts a published address, ignoring case', () => {
    const r = check({ to: 'Jane.Ellery@Corvane-Example.co.uk', subject: 'x' }, page);
    expect(r.status).toBe('passed');
    expect(r.checked).toBe(1);
    expect(r.message).toBe('');
  });

  it('refuses a pattern-built address at a domain that was named', () => {
    const r = check({ to: 'sam.ellery@corvane-example.co.uk' }, page);
    expect(r.status).toBe('failed');
    expect(r.ungrounded).toEqual([{ path: 'to[0]', value: 'sam.ellery@corvane-example.co.uk', reason: 'not_named' }]);
    expect(r.message).toMatch(/^Refused: sam\.ellery@corvane-example\.co\.uk appears in no message/);
  });

  it('checks every declared argument and nothing else', () => {
    const r = check({ to: 'info@corvane-example.co.uk', cc: 'sam@corvane-example.co.uk', bcc: 'kit@corvane-example.co.uk' }, page);
    expect(r.ungrounded).toEqual([{ path: 'cc[0]', value: 'sam@corvane-example.co.uk', reason: 'not_named' }]);
    expect(r.checked).toBe(2);
  });

  it('reports an address once', () => {
    expect(values(check({ to: 'sam@corvane-example.co.uk', cc: 'SAM@corvane-example.co.uk' }, page))).toEqual(['sam@corvane-example.co.uk']);
  });

  it('skips a call with nothing to check', () => {
    for (const args of [{}, { to: '' }, { to: '  ' }, { to: ' , ; ' }, { to: null }, { to: [] }, { subject: 'x' }, 'not json', null]) {
      expect(check(args, page)).toEqual({ status: 'skipped', checked: 0, ungrounded: [], message: '' });
    }
  });

  it('reads a call whose arguments arrived as a JSON string', () => {
    expect(values(check(JSON.stringify({ to: 'sam@corvane-example.co.uk' }), page))).toEqual(['sam@corvane-example.co.uk']);
  });
});

describe('checkGroundedAddresses: the ways an address is written', () => {
  it('reads a list split by commas, semicolons or new lines', () => {
    for (const to of [
      'info@corvane-example.co.uk, sam@corvane-example.co.uk',
      'info@corvane-example.co.uk; sam@corvane-example.co.uk',
      'info@corvane-example.co.uk\nsam@corvane-example.co.uk',
    ]) {
      expect(check({ to }, page).ungrounded).toEqual([{ path: 'to[1]', value: 'sam@corvane-example.co.uk', reason: 'not_named' }]);
    }
  });

  it('reads an array of addresses', () => {
    const r = check({ to: ['info@corvane-example.co.uk', 'Sam <sam@corvane-example.co.uk>'] }, page);
    expect(r.ungrounded).toEqual([{ path: 'to[1]', value: 'sam@corvane-example.co.uk', reason: 'not_named' }]);
  });

  it('reads the address behind a display name, and judges that address', () => {
    expect(check({ to: 'Jane Ellery <jane.ellery@corvane-example.co.uk>' }, page).status).toBe('passed');
    expect(values(check({ to: 'info@corvane-example.co.uk <sam@corvane-example.co.uk>' }, page))).toEqual(['sam@corvane-example.co.uk']);
  });

  it('does not split a quoted display name on its comma', () => {
    const r = check({ to: '"Ellery, Jane" <jane.ellery@corvane-example.co.uk>, info@corvane-example.co.uk' }, page);
    expect(r.status).toBe('passed');
    expect(r.checked).toBe(2);
  });

  it('an unclosed quote hides nothing', () => {
    const r = check({ to: '" sam@corvane-example.co.uk, <info@corvane-example.co.uk>' }, page);
    expect(r.status).toBe('failed');
    expect(r.ungrounded[0].reason).toBe('not_an_address');
  });

  it('reads a mailto: address', () => {
    expect(check({ to: 'mailto:info@corvane-example.co.uk' }, page).status).toBe('passed');
  });

  it('reads an international address, whichever way its accents are encoded', () => {
    expect(check({ to: 'jürgen@münchen-example.de' }, seen('Write to Jürgen@münchen-example.de today')).status).toBe('passed');
    expect(check({ to: 'jürgen@münchen-example.de' }, seen('Write to jürgen@münchen-example.de')).status).toBe('passed');
  });
});

describe('checkGroundedAddresses: a value that is not an address is refused, never passed unread', () => {
  it('refuses a name, and says why', () => {
    const r = check({ to: 'Jane Ellery' }, [{ role: 'user', content: 'Write to Jane Ellery.' }]);
    expect(r.ungrounded).toEqual([{ path: 'to[0]', value: 'Jane Ellery', reason: 'not_an_address' }]);
    expect(r.message).toMatch(/^Refused: Jane Ellery is not an email address/);
  });

  it('refuses two addresses written with only a space between them', () => {
    const r = check({ to: 'info@corvane-example.co.uk sam@invented-example.com' }, page);
    expect(r.ungrounded[0].reason).toBe('not_an_address');
  });

  it('refuses an address with no domain, a doubled dot, or no local part', () => {
    for (const to of ['jo@invented', 'jo@invented..com', '@corvane-example.co.uk']) {
      expect(check({ to }, page).ungrounded[0].reason).toBe('not_an_address');
    }
  });

  it('refuses a value that is not text', () => {
    expect(check({ to: { email: 'info@corvane-example.co.uk' } }, page).ungrounded[0]).toEqual({
      path: 'to[0]',
      value: '{"email":"info@corvane-example.co.uk"}',
      reason: 'not_an_address',
    });
    expect(check({ to: [7] }, page).ungrounded[0].reason).toBe('not_an_address');
  });

  it('says both things when a call has both faults', () => {
    const r = check({ to: 'sam@corvane-example.co.uk', cc: 'Jane' }, page);
    expect(r.message).toMatch(/^Refused: sam@corvane-example\.co\.uk appears in no message/);
    expect(r.message).toMatch(/Jane is not an email address/);
  });
});

describe('checkGroundedAddresses: compared as addresses, not as words', () => {
  it('is not grounded by a longer address that ends in the same words', () => {
    for (const longer of ['john-smith', 'john.smith', 'john+smith', "john'smith"]) {
      expect(values(check({ to: 'smith@corvane-example.co.uk' }, seen(`${longer}@corvane-example.co.uk`)))).toEqual(['smith@corvane-example.co.uk']);
    }
  });

  it('is not grounded by the same local part at a longer domain', () => {
    expect(values(check({ to: 'jo@smith-example.co.uk' }, seen('jo@john-smith-example.co.uk')))).toEqual(['jo@smith-example.co.uk']);
    expect(values(check({ to: 'jo@corvane-example.com' }, seen('jo@corvane-example.com.au')))).toEqual(['jo@corvane-example.com']);
    expect(values(check({ to: 'jo@corvane-example.com' }, seen('jo@corvane-example.com.elsewhere.net')))).toEqual(['jo@corvane-example.com']);
  });

  it('is not grounded by its domain, or by a page on it', () => {
    expect(values(check({ to: 'jo@corvane-example.com' }, seen('https://corvane-example.com/team')))).toEqual(['jo@corvane-example.com']);
  });

  it('is not grounded by its own words', () => {
    expect(values(check({ to: 'jo@corvane-example.com' }, [{ role: 'user', content: 'Ask Jo: corvane example com.' }]))).toEqual(['jo@corvane-example.com']);
  });

  it('a trailing full stop is read, not passed unread, and does not change the address', () => {
    expect(values(check({ to: 'jo@invented-example.com.' }, seen('https://real-example.com/')))).toEqual(['jo@invented-example.com']);
    expect(check({ to: 'info@corvane-example.co.uk.' }, page).status).toBe('passed');
  });

  it('finds an address wherever real text puts one', () => {
    for (const content of [
      'Write to jo@corvane-example.com.',
      'Write to jo@corvane-example.com, please',
      "Contact: 'jo@corvane-example.com'",
      '<a href="mailto:jo@corvane-example.com?subject=Hi">Jo</a>',
      'Jo Ellery <jo@corvane-example.com>',
      { snippet: 'Contacts:\njo@corvane-example.com\nother' },
      { email: 'JO@CORVANE-EXAMPLE.COM' },
    ]) {
      expect(check({ to: 'jo@corvane-example.com' }, seen(content)).status).toBe('passed');
    }
  });

  it('keeps an apostrophe that belongs to the address', () => {
    expect(check({ to: "o'neil@corvane-example.com" }, seen("Write to o'neil@corvane-example.com")).status).toBe('passed');
    expect(values(check({ to: 'neil@corvane-example.com' }, seen("Write to o'neil@corvane-example.com")))).toEqual(['neil@corvane-example.com']);
  });

  it('reads an address past the punctuation a person puts around it', () => {
    for (const written of [
      "Use jo@corvane-example.co.uk's inbox",
      "Use jo@corvane-example.co.uk's.",
      'Write to _jo@corvane-example.co.uk_ today',
      'Write to -jo@corvane-example.co.uk- today',
      'Write to jo@corvane-example.co.uk-',
      'Write to _jo@corvane-example.co.uk.',
    ]) {
      expect(check({ to: 'jo@corvane-example.co.uk' }, [{ role: 'user', content: written }]).status).toBe('passed');
    }
  });

  it('keeps an underscore or a dash inside the address', () => {
    const typed: TranscriptTurn[] = [{ role: 'user', content: 'Write to jane_doe@my-firm-example.co.uk today' }];
    expect(check({ to: 'jane_doe@my-firm-example.co.uk' }, typed).status).toBe('passed');
    expect(values(check({ to: 'doe@my-firm-example.co.uk' }, typed))).toEqual(['doe@my-firm-example.co.uk']);
    expect(values(check({ to: 'jane_doe@firm-example.co.uk' }, typed))).toEqual(['jane_doe@firm-example.co.uk']);
  });

  it('what is taken off the ends never leaves a different address', () => {
    expect(values(check({ to: 'smith@corvane-example.co.uk' }, seen('_john-smith@corvane-example.co.uk_')))).toEqual(['smith@corvane-example.co.uk']);
    expect(values(check({ to: 'jo@corvane-example.co' }, seen('jo@corvane-example.co.uk-')))).toEqual(['jo@corvane-example.co']);
    expect(values(check({ to: 'jo@corvane-example.co.uk' }, seen('jo@corvane-example.co.uk-based.net')))).toEqual(['jo@corvane-example.co.uk']);
    expect(values(check({ to: 'jo@corvane-example.co.uk' }, seen("jo@corvane-example.co.uk's.net")))).toEqual(['jo@corvane-example.co.uk']);
  });
});

describe('checkGroundedAddresses: what grounds nothing', () => {
  const to = { to: 'jo@marrowfen-example.com' };
  const refused = ['jo@marrowfen-example.com'];

  it('an earlier call of the same tool does not ground it', () => {
    expect(values(check(to, [{ role: 'tool', tool: 'save_draft', content: { saved: 'jo@marrowfen-example.com' } }]))).toEqual(refused);
  });

  it('a failed call does not ground the address it refused', () => {
    expect(values(check(to, [{ role: 'tool', tool: 'lookup', ok: false, content: 'No contact jo@marrowfen-example.com' }]))).toEqual(refused);
  });

  it('an address another tool only echoed from its own arguments is not evidence', () => {
    const echoed: TranscriptTurn = { role: 'tool', tool: 'lookup', args: { email: 'jo@marrowfen-example.com' }, content: { checked: 'jo@marrowfen-example.com' } };
    expect(values(check(to, [echoed]))).toEqual(refused);
  });

  it('an assistant turn never counts', () => {
    expect(values(check(to, [{ role: 'assistant', content: 'I will write to jo@marrowfen-example.com.' }]))).toEqual(refused);
  });

  it('a system turn does not count unless the caller asks', () => {
    const system: TranscriptTurn[] = [{ role: 'system', content: 'Reply to jo@marrowfen-example.com.' }];
    expect(values(check(to, system))).toEqual(refused);
    expect(check(to, system, { systemEvidence: 'first' }).status).toBe('passed');
  });

  it("the person's own addresses count once the caller adds them as a turn", () => {
    const own: TranscriptTurn = { role: 'tool', tool: 'account_addresses', content: ['jo@marrowfen-example.com'] };
    expect(check(to, [{ role: 'user', content: 'Email me the summary.' }, own]).status).toBe('passed');
  });
});

describe('ungroundedAddressesMessage', () => {
  it('says what to do instead of guessing', () => {
    const message = ungroundedAddressesMessage([{ path: 'to[0]', value: 'jo@marrowfen-example.com', reason: 'not_named' }]);
    expect(message).toContain('so it was constructed, not found');
    expect(message).toContain('Nothing was run.');
    expect(message).toContain('say so');
  });

  it('agrees with its subject', () => {
    const two = ungroundedAddressesMessage([
      { path: 'to[0]', value: 'a@marrowfen-example.com', reason: 'not_named' },
      { path: 'to[1]', value: 'b@marrowfen-example.com', reason: 'not_named' },
    ]);
    expect(two).toMatch(/appear in no message/);
    expect(two).toMatch(/so they were constructed, not found/);
  });
});
