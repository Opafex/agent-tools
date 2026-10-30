import { describe, it, expect } from 'vitest';

import { runGroundingGate, type CheckName, type CitationIndex, type FactPair } from '../src/index.js';

const SHA = '9f1c2e7a5b3d8c4e6a0b1d2f3c4e5a6b7c8d9e0f';

function report(result: ReturnType<typeof runGroundingGate>, check: CheckName) {
  return result.reports.find((r) => r.check === check);
}

describe('runGroundingGate: fabricated identifiers', () => {
  it('fails when a hash in the prose appears in no evidence', () => {
    const r = runGroundingGate({
      text: 'I deployed the build at commit d5d2f4d1f5de51df92760ee86ede809a.',
      evidence: [{ id: 'dep_123', status: 'SUCCESS', createdAt: '2025-06-22' }],
    });
    expect(r.status).toBe('fail');
    const v = r.violations.find((x) => x.code === 'fabricated_identifier');
    expect(v?.severity).toBe('error');
    expect(v?.message).toContain('d5d2f4d1f5de51df92760ee86ede809a');
    expect(report(r, 'identifiers')?.status).toBe('failed');
  });

  it('passes when the hash is in the evidence', () => {
    const r = runGroundingGate({ text: `I deployed the build at commit ${SHA}.`, evidence: [{ commitSha: SHA }] });
    expect(r.status).toBe('pass');
    expect(r.violations).toHaveLength(0);
  });

  it('reports skipped for prose with no identifiers', () => {
    const r = runGroundingGate({ text: 'I checked your dashboard and everything looks healthy.', evidence: ['{"ok":true}'] });
    expect(r.violations).toHaveLength(0);
    expect(report(r, 'identifiers')?.status).toBe('skipped');
  });

  it('works with no citation index at all (evidence only)', () => {
    const r = runGroundingGate({
      text: "Done, I merged it as commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 and it's live.",
      evidence: [JSON.stringify({ pull_request: { number: 42, merged: false } })],
    });
    expect(r.violations.some((v) => v.code === 'fabricated_identifier')).toBe(true);
  });
});

describe('runGroundingGate: citation drift', () => {
  const citations: CitationIndex = {
    4: { content: 'model order_items { id String } model invoice_lines { id String } model stock_levels { id String }' },
  };
  const text = 'Database schema includes users, accounts, sessions, and verification tokens [4].';

  it('fails when a cited sentence drifts from its source', () => {
    const r = runGroundingGate({ text, citations });
    const v = r.violations.find((x) => x.code === 'unsupported_citation');
    expect(v).toBeDefined();
    expect(v?.code === 'unsupported_citation' && v.citation).toBe('4');
    expect(r.status).toBe('fail');
  });

  it('does not run without a citation index', () => {
    const r = runGroundingGate({ text });
    expect(report(r, 'citations')?.status).toBe('skipped');
  });

  it('can be disabled', () => {
    const r = runGroundingGate({ text, citations }, { skip: ['citations'] });
    expect(r.violations.filter((v) => v.code === 'unsupported_citation')).toHaveLength(0);
    expect(report(r, 'citations')?.status).toBe('disabled');
  });

  it('honours a custom marker', () => {
    const r = runGroundingGate(
      { text: text.replace('[4]', '<cite id="s1"/>'), citations: { s1: citations[4] as CitationIndex[string] } },
      { citationMarker: /<cite id="([^"]+)"\/>/ },
    );
    expect(r.violations.some((v) => v.code === 'unsupported_citation')).toBe(true);
  });
});

describe('runGroundingGate: contradictions', () => {
  const priorFacts: FactPair[] = [
    { noun: 'acmedb', nounDisplay: 'AcmeDB', value: '4.2.0', emissionIndex: 0, context: 'running AcmeDB 4.2.0' },
  ];

  it('fails when this output disagrees with an earlier one, and returns the new facts', () => {
    const r = runGroundingGate({ text: 'The lockfile pins AcmeDB 3.9.1.', priorFacts, emissionIndex: 1 });
    expect(r.violations.some((v) => v.code === 'internal_contradiction')).toBe(true);
    expect(r.newFacts.some((p) => p.noun === 'acmedb' && p.value === '3.9.1')).toBe(true);
  });

  it('passes a consistent output', () => {
    const r = runGroundingGate({ text: 'Confirmed AcmeDB 4.2.0 in production.', priorFacts, emissionIndex: 1 });
    expect(r.violations).toHaveLength(0);
  });
});

describe('runGroundingGate: quantities (warning by default)', () => {
  const evidence = ['{"rows":[{"id":1},{"id":2}],"count":2}'];

  it('reports an unsupported count as a warning and still passes', () => {
    const r = runGroundingGate({ text: 'Your table has 6 rows.', evidence });
    const v = r.violations.find((x) => x.code === 'unsupported_quantity');
    expect(v?.severity).toBe('warning');
    expect(r.status).toBe('pass');
  });

  it('fails when promoted to error', () => {
    const r = runGroundingGate({ text: 'Your table has 6 rows.', evidence }, { severity: { quantities: 'error' } });
    expect(r.status).toBe('fail');
  });

  it('counts rows in citation content', () => {
    const r = runGroundingGate({ text: 'Your table has 2 rows.', citations: { 1: { content: evidence[0] } } });
    expect(report(r, 'quantities')?.status).toBe('passed');
  });
});

describe('runGroundingGate: writes (warning by default)', () => {
  const evidence = ['Receipt number 4810-3392-1057 Paid 21 March 2025'];

  it('reports an invented written value as a warning', () => {
    const r = runGroundingGate({
      text: 'Logged the new expenses.',
      evidence,
      writes: [{ tool: 'add_rows', values: [{ date: '2025-03-17', receipt_ref: '4802-7719-3346' }] }],
    });
    const v = r.violations.find((x) => x.code === 'ungrounded_write_value');
    expect(v?.severity).toBe('warning');
    expect(v?.message).toContain('4802-7719-3346');
    expect(r.status).toBe('pass');
  });

  it('passes a written value that is in the evidence', () => {
    const r = runGroundingGate({
      text: 'Logged the 21 March receipt.',
      evidence,
      writes: [{ tool: 'add_rows', values: [{ receipt_ref: '4810-3392-1057' }] }],
    });
    expect(report(r, 'writes')?.status).toBe('passed');
  });

  it('runs even when there is no prose', () => {
    const r = runGroundingGate({
      text: '',
      evidence,
      writes: [{ tool: 'add_rows', values: [{ receipt_ref: '4771-6620-0185' }] }],
    });
    expect(r.violations.filter((v) => v.code === 'ungrounded_write_value')).toHaveLength(1);
  });
});

describe('runGroundingGate: shape', () => {
  it('returns one report per check, in a fixed order', () => {
    const r = runGroundingGate({ text: '' });
    expect(r.reports.map((x) => x.check)).toEqual(['identifiers', 'citations', 'contradictions', 'quantities', 'writes', 'figures']);
    // figures is opt-in: listed, and disabled unless asked for.
    expect(r.reports.at(-1)?.status).toBe('disabled');
    expect(r.violations).toHaveLength(0);
    expect(r.newFacts).toHaveLength(0);
    expect(r.status).toBe('pass');
  });

  it('isolates a throwing check and reports it as an error', () => {
    // A citation index whose getter throws makes the citation check throw;
    // the other checks must still run.
    const hostile = {} as CitationIndex;
    Object.defineProperty(hostile, '1', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const r = runGroundingGate({ text: `Commit ${SHA} [1].`, citations: hostile });
    expect(report(r, 'citations')?.status).toBe('error');
    expect(report(r, 'citations')?.error).toBe('boom');
    expect(report(r, 'contradictions')?.status).toBe('skipped');
  });
});
