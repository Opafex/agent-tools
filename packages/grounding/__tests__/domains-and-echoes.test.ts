import { describe, it, expect } from 'vitest';

import {
  checkIdentifiers,
  extractIdentifierTokens,
  runGroundingGate,
  stripEchoedIdentifiers,
  ECHO_MASK,
} from '../src/index.js';

const tokensOf = (text: string) => extractIdentifierTokens(text, { domains: true }).map((t) => `${t.kind}:${t.token}`);

describe('bare domains', () => {
  it('are not extracted unless asked for, so existing callers see no change', () => {
    expect(extractIdentifierTokens('Try **Acme Widgets** (`acme-widgets.co.uk`).')).toEqual([]);
    const r = checkIdentifiers({ text: 'See acme-widgets.co.uk for details.', evidence: ['nothing'] });
    expect(r.status).toBe('skipped');
  });

  it('extracts a website written without a scheme, in brackets, code or plain text', () => {
    expect(tokensOf('1. **Acme Widgets** (`acme-widgets.co.uk`)\n2. Brick Lane (www.bricklane.com/about) and northwind.io.'))
      .toEqual(['domain:acme-widgets.co.uk', 'domain:www.bricklane.com/about', 'domain:northwind.io']);
  });

  it('reads file names, versions, abbreviations and example domains as nothing', () => {
    const text = 'Edit README.md and next.config.mjs, run build.sh, see package.json and Node.js 20.11, '
      + 'e.g. v1.2.3, U.K. law, a 3.5 score, example.com, api.example.org, foo.test and localhost.';
    expect(tokensOf(text)).toEqual([]);
  });

  it('never counts the host inside a URL, or the path of a file, as a second token', () => {
    expect(tokensOf('Read https://www.acme.com/pricing and src/lib/acme.com.ts today.')).toEqual(['url:https://www.acme.com/pricing']);
    // A domain inside a path, or after a key, is part of that value, not a website.
    expect(tokensOf('Saved to reports/acme.co.uk/notes.txt with key tenant:acme.io')).toEqual([]);
  });

  it('counts the domain of an email address', () => {
    expect(tokensOf('Write to jo@acme-widgets.co.uk.')).toEqual(['domain:acme-widgets.co.uk']);
  });

  it('flags a domain no tool returned and passes one a tool did', () => {
    // The 2026-10-27 failure: two of five suggested firms had unregistered domains.
    const r = checkIdentifiers({
      domains: true,
      text: '1. **Recruitment Revolution** (`recruitmentrevolution.com`)\n2. **Elite Recruitment** (`eliterecruitment.co.uk`)',
      evidence: [{ results: [{ url: 'https://www.recruitmentrevolution.com/', title: 'Recruitment Revolution' }] }],
    });
    expect(r.unbacked.map((u) => u.token)).toEqual(['eliterecruitment.co.uk']);
    expect(r.unbacked[0]?.kind).toBe('domain');
  });

  it('honours the allowed hosts for a bare domain as for a URL', () => {
    const r = checkIdentifiers({ domains: true, text: 'Docs are on github.com and docs.github.com.', evidence: [] });
    expect(r.status).toBe('passed');
  });

  it('is switched on in the gate by the domains option', () => {
    const text = 'Contact acme-widgets.co.uk.';
    expect(runGroundingGate({ text, evidence: ['{}'] }).violations).toEqual([]);
    const on = runGroundingGate({ text, evidence: ['{}'] }, { domains: true });
    expect(on.violations.map((v) => v.code === 'fabricated_identifier' && v.kind)).toEqual(['domain']);
  });
});

describe('stripEchoedIdentifiers', () => {
  it('masks a value the tool only repeated from its own arguments', () => {
    const args = { firms: [{ name: 'Elite Recruitment', website: 'eliterecruitment.co.uk' }] };
    const result = { results: [{ name: 'Elite Recruitment', domain: 'eliterecruitment.co.uk', verdict: 'not_found' }] };
    const masked = stripEchoedIdentifiers(result, args)!;
    expect(masked).not.toContain('eliterecruitment.co.uk');
    expect(masked).toContain(`"domain":"${ECHO_MASK}"`);
    // The non-identifier parts of the result are untouched.
    expect(masked).toContain('"verdict":"not_found"');
  });

  it('closes the self-backing loop in the identifier check', () => {
    const args = { website: 'https://eliterecruitment.co.uk' };
    const result = { checked: 'https://eliterecruitment.co.uk', domain: 'eliterecruitment.co.uk' };
    const text = 'Elite Recruitment (eliterecruitment.co.uk) has not been contacted.';
    expect(checkIdentifiers({ domains: true, text, evidence: [result] }).status).toBe('passed');
    expect(checkIdentifiers({ domains: true, text, evidence: [stripEchoedIdentifiers(result, args)] }).status).toBe('failed');
  });

  it('keeps a longer value the tool really returned that contains the argument', () => {
    const masked = stripEchoedIdentifiers(
      { results: [{ url: 'https://www.acme.com/pricing' }, { to: 'jo@acme.com' }, { host: 'acme.com.evil.net' }] },
      { query: 'site:acme.com pricing', domain: 'acme.com' },
    )!;
    expect(masked).toContain('https://www.acme.com/pricing');
    expect(masked).toContain('jo@acme.com');
    expect(masked).toContain('acme.com.evil.net');
  });

  it('masks a whole echoed URL, not just the host in it', () => {
    const masked = stripEchoedIdentifiers({ fetched: 'https://acme.com/a', status: 404 }, { url: 'https://acme.com/a' })!;
    expect(masked).toBe(`{"fetched":"${ECHO_MASK}","status":404}`);
  });

  it('masks echoed ids and hashes, whatever their case', () => {
    const id = 'cus_Qz8Lr3xJ2gExample9';
    expect(stripEchoedIdentifiers(`Customer ${id.toLowerCase()} not found`, { id })).toBe(`Customer ${ECHO_MASK} not found`);
  });

  it('leaves a result alone when the arguments carry no identifier', () => {
    expect(stripEchoedIdentifiers({ url: 'https://acme.com' }, { query: 'top widget makers' })).toBe('{"url":"https://acme.com"}');
    expect(stripEchoedIdentifiers('plain text', undefined)).toBe('plain text');
  });

  it('returns null for a result that cannot be serialised', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(stripEchoedIdentifiers(loop, { id: 'x' })).toBeNull();
  });
});
