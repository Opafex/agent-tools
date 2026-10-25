import { describe, it, expect } from 'vitest';

import { checkCitationCounts, type CitationIndex } from '../src/index.js';

const rows = (entries: Record<string, number | null>): CitationIndex =>
  Object.fromEntries(Object.entries(entries).map(([id, rowCount]) => [id, { content: '[...]', rowCount }]));

describe('checkCitationCounts: one citation', () => {
  it('flags a count that differs from the cited row count', () => {
    const r = checkCitationCounts('The service shipped 5 deployments [tc12] over the past month.', rows({ tc12: 1 }));
    expect(r.status).toBe('failed');
    expect(r.unsupported).toHaveLength(1);
    expect(r.unsupported[0]).toMatchObject({ citation: 'tc12', claimedCount: 5, actualRows: 1, noun: 'deployments' });
  });

  it('passes a matching count', () => {
    const r = checkCitationCounts('The service shipped 5 deployments [tc12] over the past month.', rows({ tc12: 5 }));
    expect(r.status).toBe('passed');
    expect(r.scanned).toBe(1);
    expect(r.patternsChecked).toBe(1);
  });

  it('flags an under-count too', () => {
    const r = checkCitationCounts('Retrieved 1 deployment for the web service [tc6].', rows({ tc6: 5 }));
    expect(r.unsupported).toHaveLength(1);
    expect(r.unsupported[0]).toMatchObject({ claimedCount: 1, actualRows: 5 });
  });

  it('flags a sentence once even when several patterns mismatch', () => {
    const r = checkCitationCounts('Found 5 commits across 3 branches [tc12].', rows({ tc12: 2 }));
    expect(r.unsupported).toHaveLength(1);
  });
});

describe('checkCitationCounts: several citations', () => {
  it('accepts a count equal to the sum', () => {
    const r = checkCitationCounts('Across both environments we found 5 deployments [tc12] [tc13].', rows({ tc12: 2, tc13: 3 }));
    expect(r.unsupported).toHaveLength(0);
  });

  it('accepts a count below the sum (a legitimate subset)', () => {
    const r = checkCitationCounts('We selected 4 deployments [tc12] [tc13] from the timeline.', rows({ tc12: 2, tc13: 3 }));
    expect(r.unsupported).toHaveLength(0);
  });

  it('flags a count above the sum', () => {
    const r = checkCitationCounts(
      'The entry summarises the 5 most recent commits [tc11] [tc13].',
      rows({ tc11: 1, tc13: 0 }),
    );
    expect(r.unsupported).toHaveLength(1);
    expect(r.unsupported[0]).toMatchObject({ claimedCount: 5, actualRows: 1, noun: 'commits' });
  });

  it('skips when any cited source has an unknown count', () => {
    const r = checkCitationCounts(
      'The entry summarises the 5 most recent commits [tc11] [tc13].',
      rows({ tc11: 1, tc13: null }),
    );
    expect(r.unsupported).toHaveLength(0);
    expect(r.skippedUnknownCount).toBe(1);
  });
});

describe('checkCitationCounts: does not fire', () => {
  it('on a negated claim', () => {
    const r = checkCitationCounts('There were not 5 deployments [tc12], only one.', rows({ tc12: 1 }));
    expect(r.unsupported).toHaveLength(0);
  });

  it('on units of time', () => {
    const r = checkCitationCounts('The build took 5 minutes [tc12] from start to finish.', rows({ tc12: 1 }));
    expect(r.unsupported).toHaveLength(0);
    expect(r.patternsChecked).toBe(0);
  });

  it('when the cited row count is unknown', () => {
    const r = checkCitationCounts('We found 5 deployments [tc12] in the timeline.', rows({ tc12: null }));
    expect(r.unsupported).toHaveLength(0);
    expect(r.skippedUnknownCount).toBe(1);
  });

  it('on an empty index or empty text', () => {
    expect(checkCitationCounts('5 deployments [tc12]', {}).scanned).toBe(0);
    expect(checkCitationCounts('', rows({ tc12: 1 })).unsupported).toHaveLength(0);
  });
});
