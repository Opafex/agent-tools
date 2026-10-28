import { describe, it, expect } from 'vitest';

import {
  checkIdentifiers,
  extractIdentifierTokens,
  runGroundingGate,
  stripEchoedIdentifiers,
  ECHO_MASK,
} from '../src/index.js';

const tokensOf = (text: string, opts = { emails: true, domains: true }) =>
  extractIdentifierTokens(text, opts).map((t) => `${t.kind}:${t.token}`);

// The shape that motivated it: an agent searched, every search was refused, and the reply
// named people with addresses built from a pattern ("format: first.last@firm").
const GUESSED = 'Contact David Dsouza (david.dsouza@cipd.co.uk), all verified as current employees.';
const EVIDENCE_DOMAIN_ONLY = ['{"url":"https://www.cipd.co.uk/about","title":"About the CIPD"}'];

describe('email addresses', () => {
  it('are not extracted unless asked for, so existing callers see no change', () => {
    expect(tokensOf('Write to jo@acme-widgets.co.uk.', { emails: false, domains: true })).toEqual(['domain:acme-widgets.co.uk']);
    expect(checkIdentifiers({ text: GUESSED, evidence: EVIDENCE_DOMAIN_ONLY }).status).toBe('skipped');
  });

  it('are extracted whole, so the domain after "@" is not a second token', () => {
    expect(tokensOf('Write to jo@acme-widgets.co.uk or info@northwind.io.'))
      .toEqual(['email:jo@acme-widgets.co.uk', 'email:info@northwind.io']);
  });

  it('a guessed address is unbacked when only its domain is in the evidence', () => {
    const r = checkIdentifiers({ text: GUESSED, evidence: EVIDENCE_DOMAIN_ONLY, emails: true, domains: true });
    expect(r.status).toBe('failed');
    expect(r.unbacked.map((u) => `${u.kind}:${u.token}`)).toEqual(['email:david.dsouza@cipd.co.uk']);
  });

  it('a published address is backed, case-insensitively', () => {
    const r = checkIdentifiers({
      text: 'Write to David.Dsouza@CIPD.co.uk.',
      evidence: ['Team page: david.dsouza@cipd.co.uk'],
      emails: true,
    });
    expect(r.status).toBe('passed');
  });

  it('reserved example domains are nothing', () => {
    expect(tokensOf('e.g. name@example.com or a@b.test')).toEqual([]);
  });

  it('the gate names it, and tells the model never to guess', () => {
    const g = runGroundingGate({ text: GUESSED, evidence: EVIDENCE_DOMAIN_ONLY }, { emails: true, domains: true });
    const v = g.violations.find((x) => x.code === 'fabricated_identifier');
    expect(v).toBeDefined();
    expect(v!.message).toContain('Never guess an address');
  });

  it('an address the call itself was given is not evidence when the result repeats it', () => {
    const masked = stripEchoedIdentifiers(
      { ok: true, to: 'jane.doe@firm.co.uk', note: 'sent to firm.co.uk' },
      { to: 'jane.doe@firm.co.uk' },
    );
    expect(masked).not.toContain('jane.doe@firm.co.uk');
    expect(masked).not.toContain('firm.co.uk');
    expect(masked).toContain(ECHO_MASK);
  });
});
