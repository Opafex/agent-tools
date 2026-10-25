import { describe, it, expect } from 'vitest';

import { checkContradictions, extractFactPairs, findContradictions, type FactPair } from '../src/index.js';

describe('extractFactPairs: name and version', () => {
  it('captures "Next.js 15.1.0"', () => {
    const pairs = extractFactPairs('The repo uses Next.js 15.1.0 for rendering.', 0);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ noun: 'next.js', nounDisplay: 'Next.js', value: '15.1.0', emissionIndex: 0 });
  });

  it('strips a v, "version" or @ prefix', () => {
    for (const text of ['Prisma v6.19.1', 'Prisma version 6.19.1', 'Prisma 6.19.1', 'Prisma @6.19.1']) {
      expect(extractFactPairs(text, 0).find((p) => p.noun === 'prisma')?.value).toBe('6.19.1');
    }
  });

  it('extracts several pairs from one text', () => {
    const map = Object.fromEntries(
      extractFactPairs('Stack: Next.js 15.1.0, Prisma 6.19.1, Node 20.x.', 0).map((p) => [p.noun, p.value]),
    );
    expect(map).toMatchObject({ 'next.js': '15.1.0', prisma: '6.19.1', node: '20.x' });
  });

  it('ignores stopword nouns like "Step 3"', () => {
    expect(extractFactPairs('Step 3.1 produced no output.', 0).find((p) => p.noun === 'step')).toBeUndefined();
  });
});

describe('extractFactPairs: JSON-style pairs', () => {
  it('captures "next": "15.1.0"', () => {
    expect(extractFactPairs('The manifest contains "next": "15.1.0" as a dependency.', 0).find((p) => p.noun === 'next')?.value).toBe(
      '15.1.0',
    );
  });

  it('strips a ^ or ~ range prefix', () => {
    const pairs = extractFactPairs('"@acme/client": "^6.19.1", "react": "~18.3.1"', 0);
    expect(pairs.find((p) => p.noun === '@acme/client')?.value).toBe('6.19.1');
    expect(pairs.find((p) => p.noun === 'react')?.value).toBe('18.3.1');
  });
});

describe('findContradictions', () => {
  it('flags two outputs that disagree on a version', () => {
    const contradictions = findContradictions([
      ...extractFactPairs('Confirmed Next.js 15.1.0 in the manifest.', 5),
      ...extractFactPairs('The repo uses Next.js 15.0.3 for routing.', 7),
    ]);
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]?.noun).toBe('next.js');
    expect(contradictions[0]?.values.map((v) => v.value).sort()).toEqual(['15.0.3', '15.1.0']);
    expect(contradictions[0]?.values.find((v) => v.value === '15.1.0')?.emissionIndex).toBe(5);
  });

  it('is case-insensitive on the noun', () => {
    const contradictions = findContradictions([
      ...extractFactPairs('Confirmed Next.js 15.1.0', 0),
      ...extractFactPairs('"next.js": "15.0.3"', 1),
    ]);
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]?.values).toHaveLength(2);
  });

  it('returns nothing when values agree', () => {
    expect(
      findContradictions([
        ...extractFactPairs('Next.js 15.1.0 in output one.', 0),
        ...extractFactPairs('Next.js 15.1.0 in output two.', 1),
        ...extractFactPairs('Prisma 6.19.1 added.', 2),
      ]),
    ).toHaveLength(0);
  });

  it('returns nothing for a single pair or distinct nouns', () => {
    expect(findContradictions(extractFactPairs('Next.js 15.1.0', 0))).toHaveLength(0);
    expect(
      findContradictions([
        ...extractFactPairs('Next.js 15.1.0', 0),
        ...extractFactPairs('Prisma 6.19.1', 1),
        ...extractFactPairs('Node 20.x', 2),
      ]),
    ).toHaveLength(0);
  });

  it('handles empty input', () => {
    expect(extractFactPairs('', 0)).toEqual([]);
    expect(findContradictions([])).toEqual([]);
  });
});

describe('checkContradictions', () => {
  const prior: FactPair[] = [
    { noun: 'acmedb', nounDisplay: 'AcmeDB', value: '4.2.0', emissionIndex: 0, context: 'running AcmeDB 4.2.0' },
  ];

  it('reports a disagreement the current output introduced', () => {
    const r = checkContradictions('The lockfile pins AcmeDB 3.9.1.', { priorFacts: prior, emissionIndex: 1 });
    expect(r.status).toBe('failed');
    expect(r.contradictions[0]).toMatchObject({ value: '3.9.1', earlierValue: '4.2.0', earlierEmissionIndex: 0 });
    expect(r.newFacts.some((p) => p.noun === 'acmedb' && p.value === '3.9.1')).toBe(true);
  });

  it('passes an output that agrees', () => {
    const r = checkContradictions('Confirmed AcmeDB 4.2.0 in production.', { priorFacts: prior, emissionIndex: 1 });
    expect(r.status).toBe('passed');
  });

  it('does not re-flag an output that agreed with the first value', () => {
    // Output 0 says 4.2.0, output 1 says 3.9.1, output 2 says 4.2.0 again.
    // Output 2 introduces no new disagreement with output 0, but the pair set
    // still contains a contradiction. Only output 1 should have been flagged.
    const facts = [...prior, ...extractFactPairs('AcmeDB 3.9.1', 1)];
    const r = checkContradictions('Back on AcmeDB 4.2.0.', { priorFacts: facts, emissionIndex: 2 });
    expect(r.contradictions).toHaveLength(0);
    const unrelated = checkContradictions('Node 20.x is required.', { priorFacts: facts, emissionIndex: 3 });
    expect(unrelated.contradictions).toHaveLength(0);
  });

  it('skips an output that states no facts', () => {
    expect(checkContradictions('Everything looks fine.', { priorFacts: prior }).status).toBe('skipped');
  });
});
