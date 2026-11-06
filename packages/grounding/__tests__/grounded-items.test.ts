import { describe, expect, it } from 'vitest';

import {
  checkGroundedItems,
  ungroundedItemsMessage,
  type GroundedItemsDeclaration,
  type GroundedItemsOptions,
  type TranscriptTurn,
} from '../src/index.js';
import { hostOf, registrableDomain } from '../src/domains.js';

// The failure these fixtures are shaped on: every web search in a turn failed,
// and the agent passed a list of firms it had supplied itself to a checking
// tool, which reported each one as new. All names here are invented.
const declaration: GroundedItemsDeclaration = { param: 'firms', field: 'name', addressFields: ['website', 'domain', 'email'] };

const check = (firms: unknown, transcript: readonly TranscriptTurn[], options?: GroundedItemsOptions) =>
  checkGroundedItems({ call: { tool: 'check_firms', args: { firms } }, transcript, declaration }, options);

const values = (r: { ungrounded: Array<{ value: string }> }) => r.ungrounded.map((u) => u.value);

const failedTurn: TranscriptTurn[] = [
  { role: 'user', content: 'Look at the outreach I sent last fortnight and suggest some new targets.' },
  { role: 'assistant', content: 'Your outreach went to firms such as Corvane Freight and Halden Logistics.' },
  { role: 'tool', tool: 'list_sent_outreach', content: { firms: [{ domain: 'brightwater-example.co.uk' }] } },
  { role: 'tool', tool: 'web_search', ok: false, content: { error: 'Web search is unavailable right now.' } },
];

describe('checkGroundedItems: items nothing named are refused before the call runs', () => {
  it("refuses firms only the agent's own prose named", () => {
    const r = check([{ name: 'Corvane Freight', domain: 'corvane-example.co.uk' }, { name: 'Marrowfen Ltd' }], failedTurn);
    expect(r.status).toBe('failed');
    expect(r.checked).toBe(2);
    expect(r.ungrounded).toEqual([
      { path: 'firms[0]', value: 'Corvane Freight' },
      { path: 'firms[1]', value: 'Marrowfen Ltd' },
    ]);
    expect(r.message).toMatch(/^Refused: Corvane Freight, Marrowfen Ltd appear in no message/);
  });

  it('accepts a firm a search returned, by name or by its address', () => {
    const turn: TranscriptTurn[] = [
      ...failedTurn,
      {
        role: 'tool',
        tool: 'web_search',
        content: { results: [
          { title: 'Corvane Freight | UK', url: 'https://www.corvane-example.co.uk/' },
          { title: 'Specialist surveyors', url: 'https://www.kanda-example.co.uk/' },
        ] },
      },
    ];
    const r = check([{ name: 'Corvane Freight plc' }, { name: 'K and A Surveyors', website: 'kanda-example.co.uk' }, { name: 'Marrowfen Ltd' }], turn);
    expect(values(r)).toEqual(['Marrowfen Ltd']);
  });

  it('accepts a firm the person named, and one an earlier result reached', () => {
    const r = check(
      ['Acme and Sons', { name: 'Brightwater Dental', domain: 'brightwater-example.co.uk' }],
      [{ role: 'user', content: 'Have I emailed Acme & Sons?' }, ...failedTurn.slice(1)],
    );
    expect(r.status).toBe('passed');
    expect(r.checked).toBe(2);
    expect(r.message).toBe('');
  });

  it('ignores words that do not tell one firm from another, at either end of the name', () => {
    const transcript: TranscriptTurn[] = [{ role: 'user', content: 'Check Halden Logistics please.' }];
    expect(check(['The Halden Logistics Group Ltd', 'Halden Logistics Limited', 'Halden Logistics UK'], transcript).status).toBe('passed');
  });

  it('a name made only of such words has to occur whole, or any sentence would ground it', () => {
    const transcript: TranscriptTurn[] = [{ role: 'user', content: 'Find the best firms in the UK.' }];
    expect(values(check(['The Group Ltd', 'UK Ltd'], transcript))).toEqual(['The Group Ltd', 'UK Ltd']);
    expect(check(['The Group Ltd'], [{ role: 'user', content: 'Have I emailed The Group Ltd?' }]).status).toBe('passed');
  });

  it('matches a name on word boundaries, not inside a longer word', () => {
    const r = check(['Halden'], [{ role: 'user', content: 'Check Haldenbury Logistics.' }]);
    expect(values(r)).toEqual(['Halden']);
  });

  it('reads a call whose arguments arrived as a JSON string', () => {
    const r = checkGroundedItems({
      call: { tool: 'check_firms', args: JSON.stringify({ firms: [{ name: 'Marrowfen Ltd' }] }) },
      transcript: failedTurn,
      declaration,
    });
    expect(values(r)).toEqual(['Marrowfen Ltd']);
  });

  it('skips a call with nothing to check', () => {
    for (const args of [{}, { firms: 'Marrowfen' }, { firms: [] }, { firms: [{ note: 'x' }, { name: '  ' }, 7, null] }, 'not json', null]) {
      const r = checkGroundedItems({ call: { tool: 'check_firms', args }, transcript: failedTurn, declaration });
      expect(r).toEqual({ status: 'skipped', checked: 0, ungrounded: [], message: '' });
    }
  });

  it('tells the model to say a failed search failed rather than fill in from memory', () => {
    expect(ungroundedItemsMessage([{ path: 'firms[0]', value: 'Marrowfen Ltd' }])).toMatch(/say so to the user and do not fill the gap from memory/);
    expect(ungroundedItemsMessage([{ path: 'firms[0]', value: 'Marrowfen Ltd' }])).toMatch(/^Refused: Marrowfen Ltd appears in no message/);
  });
});

describe('checkGroundedItems: what grounds nothing', () => {
  const firm = [{ name: 'Marrowfen', domain: 'marrowfen-example.com' }];

  it('an earlier call of the same tool does not ground the names it was given', () => {
    const turn: TranscriptTurn[] = [...failedTurn, { role: 'tool', tool: 'check_firms', content: { verdicts: [{ name: 'Marrowfen', verdict: 'not_found' }] } }];
    expect(values(check(firm, turn))).toEqual(['Marrowfen']);
  });

  it('a refusal from another tool does not ground the names it lists', () => {
    const refusal = { error: 'Refused: Marrowfen appears in no message from the user and in no tool result' };
    expect(values(check(firm, [{ role: 'tool', tool: 'check_registry', ok: false, content: refusal }]))).toEqual(['Marrowfen']);
  });

  it("the agent's own on-screen choices do not ground a name, once the caller marks that turn", () => {
    const shown = { role: 'tool', tool: 'present_choices', content: 'Shown: Marrowfen, Corvane' } as const;
    expect(values(check(firm, [{ ...shown, ok: false }]))).toEqual(['Marrowfen']);
    expect(check(firm, [shown]).status).toBe('passed');
  });

  it('a failed call the caller chose to keep as evidence grounds what it names', () => {
    // A duplicate refusal names a record that really exists: leave `ok` unset.
    const duplicate = { reason: 'duplicate', existing: 'Marrowfen' };
    expect(check(firm, [{ role: 'tool', tool: 'add_firm', content: duplicate }]).status).toBe('passed');
  });

  it('an assistant turn never counts', () => {
    expect(values(check(firm, [{ role: 'assistant', content: 'Marrowfen looks promising, see marrowfen-example.com.' }]))).toEqual(['Marrowfen']);
  });

  it('a system turn does not count unless the caller asks, unlike checkToolArguments', () => {
    const system: TranscriptTurn[] = [{ role: 'system', content: 'Good examples of targets include Marrowfen.' }];
    expect(values(check(firm, system))).toEqual(['Marrowfen']);
    expect(check(firm, system, { systemEvidence: 'first' }).status).toBe('passed');
  });

  it('an address another tool only echoed from its own arguments is not evidence', () => {
    const echoed: TranscriptTurn = { role: 'tool', tool: 'lookup', args: { domain: 'marrowfen-example.com' }, content: { checked: 'marrowfen-example.com', found: false } };
    expect(values(check([{ name: 'Invented Ltd', domain: 'marrowfen-example.com' }], [echoed]))).toEqual(['Invented Ltd']);
  });

  it('the mask an echo leaves behind is not a word that can ground a firm', () => {
    const echoed: TranscriptTurn = { role: 'tool', tool: 'lookup', args: { domain: 'marrowfen-example.com' }, content: { checked: 'marrowfen-example.com' } };
    expect(values(check(['Echo'], [echoed]))).toEqual(['Echo']);
  });

  it('a result the tool really returned is still evidence when its arguments are given', () => {
    const found: TranscriptTurn = { role: 'tool', tool: 'web_search', args: { query: 'marrowfen-example.com' }, content: { url: 'https://www.marrowfen-example.com/about' } };
    expect(check([{ name: 'Invented Ltd', domain: 'marrowfen-example.com' }], [found]).status).toBe('passed');
  });
});

describe('checkGroundedItems: addresses are grounded by registrable domain', () => {
  const seen: TranscriptTurn[] = [{ role: 'tool', tool: 'web_search', content: { url: 'https://www.corvane-example.co.uk/team' } }];

  it('accepts a subdomain of a domain that was named', () => {
    expect(check([{ name: 'Invented Ltd', website: 'https://mail.corvane-example.co.uk/login' }], seen).status).toBe('passed');
  });

  it('refuses a subdomain of a domain nobody named, even under the same suffix', () => {
    expect(values(check([{ name: 'Invented Ltd', website: 'https://mail.marrowfen-example.co.uk' }], seen))).toEqual(['Invented Ltd']);
  });

  it("reads an email field's domain", () => {
    expect(check([{ name: 'Invented Ltd', email: 'jo@corvane-example.co.uk' }], seen).status).toBe('passed');
    expect(values(check([{ name: 'Invented Ltd', email: 'jo@marrowfen-example.co.uk' }], seen))).toEqual(['Invented Ltd']);
  });

  it('a bare word in an address field is not an address', () => {
    const r = check([{ name: 'Invented Ltd', website: 'freight' }], [{ role: 'user', content: 'Find me a freight firm.' }]);
    expect(values(r)).toEqual(['Invented Ltd']);
  });

  it('a word at the end of a sentence is not a host, so a bare word in an address field stays unnamed', () => {
    const r = check([{ name: 'Invented Ltd', website: 'firm' }], [{ role: 'user', content: 'Find me a freight firm.' }]);
    expect(values(r)).toEqual(['Invented Ltd']);
  });

  it('a longer domain that ends in the same words is a different domain', () => {
    const named = (url: string): TranscriptTurn[] => [{ role: 'tool', tool: 'web_search', content: { url } }];
    expect(values(check([{ name: 'Invented Ltd', website: 'smith-example.co.uk' }], named('https://john-smith-example.co.uk/')))).toEqual(['Invented Ltd']);
    expect(values(check([{ name: 'Invented Ltd', website: 'mail.acme-example.com' }], named('https://not-acme-example.com/')))).toEqual(['Invented Ltd']);
  });

  it("a domain inside somebody else's host is not named", () => {
    const r = check([{ name: 'Invented Ltd', website: 'acme-example.com' }], [{ role: 'tool', tool: 'web_search', content: { url: 'https://acme-example.com.elsewhere.net/' } }]);
    expect(values(r)).toEqual(['Invented Ltd']);
  });

  it('a trailing full stop does not reduce an address to its suffix', () => {
    const real: TranscriptTurn[] = [{ role: 'tool', tool: 'web_search', content: { urls: ['https://real-example.com/', 'https://real-example.co.uk/'] } }];
    expect(values(check([{ name: 'Invented Ltd', website: 'marrowfen-example.com.' }], real))).toEqual(['Invented Ltd']);
    expect(values(check([{ name: 'Invented Ltd', website: 'https://marrowfen-example.co.uk./about' }], real))).toEqual(['Invented Ltd']);
    expect(check([{ name: 'Invented Ltd', website: 'real-example.com.' }], real).status).toBe('passed');
  });

  it('a bare suffix is not grounded by a domain under it', () => {
    const r = check([{ name: 'Invented Ltd', website: 'www.co.uk' }], seen);
    expect(values(r)).toEqual(['Invented Ltd']);
  });

  it('an IP address is not grounded by a version number', () => {
    const r = check([{ name: 'Invented Ltd', website: 'http://10.0.0.1/' }], [{ role: 'tool', tool: 'web_search', content: 'Release 0.1 of the app' }]);
    expect(values(r)).toEqual(['Invented Ltd']);
  });

  it('words that look like a domain once punctuation is gone are not one', () => {
    const r = check([{ name: 'Invented Ltd', website: 'acme-example.co.uk' }], [{ role: 'user', content: 'Ask acme example, co. UK office.' }]);
    expect(values(r)).toEqual(['Invented Ltd']);
  });

  it('finds a domain at the end of a sentence, in an email, after an escaped newline and in a percent-encoded link', () => {
    const address = [{ name: 'Invented Ltd', website: 'corvane-example.co.uk' }];
    for (const content of [
      'See corvane-example.co.uk.',
      'Write to jo.bloggs+x@mail.corvane-example.co.uk, please',
      { snippet: 'Links:\ncorvane-example.co.uk\nother' },
      'https://search.example.net/r?u=https%3A%2F%2Fwww.corvane-example.co.uk%2Fteam',
    ]) {
      expect(check(address, [{ role: 'tool', tool: 'web_search', content }]).status).toBe('passed');
    }
  });

  it('reads an international domain the same way on both sides', () => {
    const r = check([{ name: 'Invented Ltd', website: 'https://www.m\u00fcnchen-example.de/' }], [{ role: 'tool', tool: 'web_search', content: 'Site: m\u00fcnchen-example.de' }]);
    expect(r.status).toBe('passed');
    // The same domain with its accent stored as a separate mark.
    const decomposed = check([{ name: 'Invented Ltd', website: 'münchen-example.de' }], [{ role: 'tool', tool: 'web_search', content: 'Site: münchen-example.de' }]);
    expect(decomposed.status).toBe('passed');
  });

  it('an item with an address and no name is checked on the address, and reported by it', () => {
    expect(values(check([{ website: 'marrowfen-example.co.uk' }], seen))).toEqual(['marrowfen-example.co.uk']);
    expect(check([{ website: 'corvane-example.co.uk' }], seen).status).toBe('passed');
  });

  it('only the declared address fields are read', () => {
    const r = checkGroundedItems({
      call: { tool: 'check_firms', args: { firms: [{ name: 'Invented Ltd', website: 'corvane-example.co.uk' }] } },
      transcript: seen,
      declaration: { param: 'firms', field: 'name' },
    });
    expect(values(r)).toEqual(['Invented Ltd']);
  });
});

describe('checkGroundedItems: an address in the name field is still an address', () => {
  const named = (content: unknown): TranscriptTurn[] => [{ role: 'tool', tool: 'web_search', content }];

  it('is not grounded by a longer domain that ends in its words', () => {
    expect(values(check(['smith-example.co.uk'], named('https://john-smith-example.co.uk/')))).toEqual(['smith-example.co.uk']);
    expect(values(check([{ name: 'smith-example.co.uk' }], named('https://john-smith-example.co.uk/')))).toEqual(['smith-example.co.uk']);
  });

  it('is not grounded by the word it is made of', () => {
    expect(values(check(['smith-example.co.uk'], [{ role: 'user', content: 'Ask smith example about it.' }]))).toEqual(['smith-example.co.uk']);
  });

  it('a trailing full stop does not reduce it to its suffix', () => {
    expect(values(check(['invented-example.com.'], named('https://real-example.com/')))).toEqual(['invented-example.com.']);
  });

  it('passes when its domain was named', () => {
    expect(check(['corvane-example.co.uk', 'https://www.corvane-example.co.uk/team'], named('https://corvane-example.co.uk/')).status).toBe('passed');
  });

  it('an email address there is matched whole', () => {
    expect(values(check(['smith@corvane-example.co.uk'], named('john-smith@corvane-example.co.uk')))).toEqual(['smith@corvane-example.co.uk']);
    expect(check(['jo@corvane-example.co.uk'], named('Write to jo@corvane-example.co.uk.')).status).toBe('passed');
  });

  it('a name with a full stop in it is still a name', () => {
    expect(check(['St. Halden Logistics Inc.'], [{ role: 'user', content: 'Check St Halden Logistics.' }]).status).toBe('passed');
    expect(check(['Halden Logistics.'], [{ role: 'user', content: 'Check Halden Logistics.' }]).status).toBe('passed');
  });
});

describe('checkGroundedItems: reading the evidence', () => {
  it('finds a name at the start of a line inside a JSON result', () => {
    const r = check(['Corvane Freight'], [{ role: 'tool', tool: 'web_search', content: { snippet: 'Top hauliers:\nCorvane Freight\nHalden Logistics' } }]);
    expect(r.status).toBe('passed');
  });

  it('reads a form feed or backspace escaped inside a JSON result the same way', () => {
    expect(check(['Corvane Freight'], [{ role: 'tool', tool: 'web_search', content: { snippet: 'Top:\fCorvane Freight\bHalden' } }]).status).toBe('passed');
  });

  it('reads an accent the same whichever way the text encodes it', () => {
    const composed = 'Caf\u00e9 Noir';
    const decomposed = 'Cafe\u0301 Noir';
    expect(check([composed], [{ role: 'user', content: `Check ${decomposed}` }]).status).toBe('passed');
    expect(check([decomposed], [{ role: 'user', content: `Check ${composed}` }]).status).toBe('passed');
  });

  it('an accent is part of the word, so the unaccented word does not ground it', () => {
    expect(values(check(['Cafe\u0301'], [{ role: 'user', content: 'Check the cafe.' }]))).toEqual(['Cafe\u0301']);
    // A vowel sign is a combining mark, so a shorter word is not a prefix of the name.
    expect(values(check(['\u0915'], [{ role: 'user', content: '\u0915\u093f' }]))).toEqual(['\u0915']);
  });

  it('checks a name with no Latin letters, rather than passing it unread', () => {
    expect(values(check(['株式会社マロウフェン'], failedTurn))).toEqual(['株式会社マロウフェン']);
    expect(check(['株式会社マロウフェン'], [{ role: 'user', content: '株式会社マロウフェン を確認してください' }]).status).toBe('passed');
  });
});

describe('domains', () => {
  it('registrableDomain keeps three labels under a two-part suffix and two otherwise', () => {
    expect(registrableDomain('mail.corvane-example.co.uk')).toBe('corvane-example.co.uk');
    expect(registrableDomain('A.B.Corvane-Example.COM')).toBe('corvane-example.com');
    expect(registrableDomain('corvane-example.com.au')).toBe('corvane-example.com.au');
    expect(registrableDomain('x.corvane-example.ltd.uk')).toBe('corvane-example.ltd.uk');
    expect(registrableDomain('x.corvane-example.com.hk')).toBe('corvane-example.com.hk');
    // An unlisted suffix falls back to two labels: a fixed list, not the public suffix list.
    expect(registrableDomain('x.corvane-example.co.jp')).toBe('co.jp');
    expect(registrableDomain('co.uk')).toBe('co.uk');
  });

  it('hostOf reads a URL, a bare domain, a domain with a path and an email address', () => {
    expect(hostOf('https://www.corvane-example.co.uk/team?x=1')).toBe('corvane-example.co.uk');
    expect(hostOf('WWW2.Corvane-Example.com')).toBe('corvane-example.com');
    expect(hostOf('corvane-example.com/about')).toBe('corvane-example.com');
    expect(hostOf('jo@corvane-example.com')).toBe('corvane-example.com');
    expect(hostOf('https://corvane-example.co.uk./team')).toBe('corvane-example.co.uk');
    expect(hostOf('  ')).toBeNull();
    expect(hostOf('not a domain')).toBeNull();
  });
});
