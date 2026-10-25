import { describe, it, expect } from 'vitest';

import { checkCitations, type CitationIndex } from '../src/index.js';

const REAL_SCHEMA =
  'model order_items { id String @id quantity Int } '
  + 'model invoice_lines { id String @id } '
  + 'model stock_levels { id String @id warehouse_id String }';

// Generic boilerplate presented as if it were the schema the agent read. The
// bare nouns match none of the identifier shapes; the list-of-three rule is
// what catches them.
const BOILERPLATE_PROSE =
  'Database schema includes users, accounts, sessions, and verification tokens [tc4].';

describe('checkCitations: content drift', () => {
  it('flags a sentence whose cited source holds something else entirely', () => {
    const citations: CitationIndex = { tc4: { content: REAL_SCHEMA, label: 'read_file' } };
    const r = checkCitations(BOILERPLATE_PROSE, citations);
    expect(r.status).toBe('failed');
    expect(r.scanned).toBe(1);
    expect(r.unsupported).toHaveLength(1);
    expect(r.unsupported[0]?.citation).toBe('tc4');
    expect(r.unsupported[0]?.missingTokens).toEqual(expect.arrayContaining(['users', 'accounts', 'sessions']));
    expect(r.unsupported[0]?.extractedTokens).toBeGreaterThanOrEqual(3);
  });

  it('passes a grounded description of the same source', () => {
    const r = checkCitations(
      'Schema models include order_items and invoice_lines [tc7].',
      { tc7: { content: REAL_SCHEMA } },
    );
    expect(r.status).toBe('passed');
    expect(r.unsupported).toHaveLength(0);
  });
});

describe('checkCitations: mis-attribution is not invention', () => {
  it('does not flag a token found in a different source than the one cited', () => {
    const citations: CitationIndex = {
      tc3: { content: 'tab "Sales" widgets: [w1, w2, w3]' },
      tc5: { content: 'widget_1712345678_ab12cd name="ShopFront Activity - Recent Orders"' },
    };
    const r = checkCitations(
      'ShopFront Activity - Recent Orders (widget_1712345678_ab12cd) covers the requirement [tc3].',
      citations,
    );
    expect(r.unsupported).toHaveLength(0);
    expect(r.misattributed).toBeGreaterThanOrEqual(1);
  });

  it('still flags tokens absent from every source', () => {
    const r = checkCitations(BOILERPLATE_PROSE, {
      tc3: { content: 'tab "Sales" widgets: [w1, w2]' },
      tc4: { content: REAL_SCHEMA },
    });
    expect(r.unsupported).toHaveLength(1);
  });
});

describe('checkCitations: does not fire', () => {
  it('on generic prose with no identifier-like tokens', () => {
    const r = checkCitations('I found three repositories [tc3].', { tc3: { content: 'irrelevant text' } });
    expect(r.scanned).toBe(1);
    expect(r.unsupported).toHaveLength(0);
  });

  it('on a negated sentence', () => {
    const r = checkCitations('The repo does not use users, accounts, or sessions [tc5].', {
      tc5: { content: 'order_items invoice_lines' },
    });
    expect(r.scanned).toBe(1);
    expect(r.unsupported).toHaveLength(0);
  });

  it('on a negated sentence written as a contraction', () => {
    const c = { tc5: { content: 'order_items invoice_lines' } };
    for (const t of ["It doesn't use users, accounts, sessions, roles [tc5].", 'It isn' + String.fromCharCode(0x2019) + 't using users, accounts, sessions, roles [tc5].']) {
      expect(checkCitations(t, c).unsupported).toHaveLength(0);
    }
    // Without the negation the same sentence is flagged.
    expect(checkCitations('It uses users, accounts, sessions, roles [tc5].', c).unsupported).toHaveLength(1);
  });

  it('when the cited source has no content', () => {
    const r = checkCitations('Database has users, accounts, sessions [tc11].', { tc11: { label: 'list_repos' } });
    expect(r.skippedNoContent).toBe(1);
    expect(r.unsupported).toHaveLength(0);
  });

  it('on empty text or an empty index', () => {
    expect(checkCitations('', {}).status).toBe('skipped');
    expect(checkCitations('Some prose [tc1].', {}).unsupported).toHaveLength(0);
  });

  it('when only one token is extracted', () => {
    const r = checkCitations('I read schema_thing [tc4].', { tc4: { content: 'unrelated content' } });
    expect(r.unsupported).toHaveLength(0);
  });

  it('on a sentence with no citation at all', () => {
    const r = checkCitations('Database schema includes users, accounts, sessions.', { tc1: { content: REAL_SCHEMA } });
    expect(r.scanned).toBe(0);
    expect(r.status).toBe('skipped');
  });
});

describe('checkCitations: paraphrase tolerance', () => {
  it('matches a singular token against plural content', () => {
    const r = checkCitations('Found order_item and invoice_line rows [tc2].', {
      tc2: { content: 'order_items invoice_lines' },
    });
    expect(r.unsupported).toHaveLength(0);
  });

  it('unions the content of every source cited in the sentence', () => {
    const r = checkCitations('Found order_items and invoice_lines [tc1][tc2].', {
      tc1: { content: 'order_items only' },
      tc2: { content: 'invoice_lines only' },
    });
    expect(r.unsupported).toHaveLength(0);
  });

  it('matches "Next.js" against a bare "next" package id', () => {
    const r = checkCitations('The storefront runs on Next.js 14.2.35 [tc8].', {
      tc8: { content: '{"name":"@acme/storefront","dependencies":{"next":"14.2.35","react":"18.3.1"}}' },
    });
    expect(r.unsupported).toHaveLength(0);
  });

  it('matches "Vue.js" against a bare "vue"', () => {
    const r = checkCitations('The frontend uses Vue.js 3.4.0 [tc1].', { tc1: { content: '"dependencies":{"vue":"3.4.0"}' } });
    expect(r.unsupported).toHaveLength(0);
  });

  it('matches CamelCase "NextAuth" against kebab-case "next-auth"', () => {
    const r = checkCitations('Authentication via NextAuth 5.0.0-beta.29 [tc8].', {
      tc8: { content: '{"dependencies":{"next-auth":"5.0.0-beta.29","next":"14.2.35"}}' },
    });
    expect(r.unsupported).toHaveLength(0);
  });

  it('matches "TypeScript" against a bare "typescript"', () => {
    const r = checkCitations('TypeScript 5.4.0 is the strict-mode build [tc1].', {
      tc1: { content: '"devDependencies":{"typescript":"5.4.0"}' },
    });
    expect(r.unsupported).toHaveLength(0);
  });

  it('still flags a brand that is genuinely absent', () => {
    const r = checkCitations('NextAuth 5.0.0-beta.29 powers session management [tc1].', {
      tc1: { content: '"dependencies":{"react":"18.3.1","redux":"5.0.0"}' },
    });
    expect(r.unsupported.length).toBeGreaterThan(0);
  });

  it('ignores punctuation captured inside a quoted span', () => {
    const r = checkCitations('The top story is "Widget 1.0," which reached the front page [tc1].', {
      tc1: { content: 'Top story: Widget 1.0, a library for local-first sync. 342 points.' },
    });
    expect(r.unsupported).toHaveLength(0);
  });

  it('still flags quoted tokens absent from the source', () => {
    const r = checkCitations('The top stories are "Foobar 9.9," and "Quux 2.1," today [tc1].', {
      tc1: { content: 'Top story: Widget 1.0, a sync library. 342 points.' },
    });
    expect(r.unsupported.length).toBeGreaterThan(0);
  });
});

describe('checkCitations: custom marker', () => {
  it('reads citations in a different syntax', () => {
    const r = checkCitations(
      'Database schema includes users, accounts, sessions, and verification tokens [^src-2].',
      { 'src-2': { content: REAL_SCHEMA } },
      { marker: /\[\^(src-\d+)\]/ },
    );
    expect(r.scanned).toBe(1);
    expect(r.unsupported[0]?.citation).toBe('src-2');
  });
});
