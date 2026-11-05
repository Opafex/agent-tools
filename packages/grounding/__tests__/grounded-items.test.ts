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

describe('checkGroundedItems: reading the evidence', () => {
  it('finds a name at the start of a line inside a JSON result', () => {
    const r = check(['Corvane Freight'], [{ role: 'tool', tool: 'web_search', content: { snippet: 'Top hauliers:\nCorvane Freight\nHalden Logistics' } }]);
    expect(r.status).toBe('passed');
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
    expect(hostOf('  ')).toBeNull();
    expect(hostOf('not a domain')).toBeNull();
  });
});
