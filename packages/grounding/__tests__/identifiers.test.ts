import { describe, it, expect } from 'vitest';

import { checkIdentifiers, type CitationIndex } from '../src/index.js';

const FULL_SHA = '7c3e9a1f4b2d8e6a0c5f9b3d7e1a4c8f2b6d0e9a';

function sources(...contents: string[]): CitationIndex {
  const out: CitationIndex = {};
  contents.forEach((content, i) => {
    out[`tc${i + 1}`] = { content, label: 'example_tool' };
  });
  return out;
}

describe('checkIdentifiers: hashes', () => {
  it('passes when the hash in the prose appears in the evidence', () => {
    const r = checkIdentifiers({
      text: `The deployment built commit \`${FULL_SHA}\` for the web service.`,
      evidence: [{ id: 'dep_42', status: 'SUCCESS', meta: { commitSha: FULL_SHA } }],
    });
    expect(r.status).toBe('passed');
    expect(r.unbacked).toEqual([]);
  });

  it('flags a hash in the prose that appears in no evidence', () => {
    // The evidence is a deployment record with no hash at all; the agent
    // stated one anyway.
    const invented = '7c3e9a1f4b2d8e6a0c5f9b3d7e1a4c';
    const r = checkIdentifiers({
      text: `The latest deployment used commit \`${invented}\` from main.`,
      evidence: [{ id: 'dep_42', status: 'SUCCESS', createdAt: '2025-03-14T09:30:00Z' }],
    });
    expect(r.status).toBe('failed');
    expect(r.unbacked).toHaveLength(1);
    expect(r.unbacked[0]?.token).toBe(invented);
    expect(r.unbacked[0]?.kind).toBe('sha');
  });

  it('passes a 7-character prefix when the full hash is in the evidence', () => {
    const r = checkIdentifiers({
      text: 'Commit `7c3e9a1` is the latest on main.',
      evidence: [{ sha: FULL_SHA }],
    });
    expect(r.status).toBe('passed');
  });

  it('does not treat an all-digit number as a hash', () => {
    const r = checkIdentifiers({
      text: 'Document DOC-1712345678901 was created at 1712345678901 with 12345678901234 bytes.',
      evidence: [{ ok: true }],
    });
    expect(r.status).not.toBe('failed');
    expect(r.unbacked).toHaveLength(0);
  });

  it('still flags a real hex hash with letters', () => {
    const r = checkIdentifiers({
      text: 'Commit a1b2c3d4e5f6 fixed it.',
      evidence: [{ sha: 'deadbeef' }],
    });
    expect(r.status).toBe('failed');
    expect(r.unbacked[0]?.kind).toBe('sha');
  });
});

describe('checkIdentifiers: UUIDs', () => {
  it('passes when the UUID is in a citation source', () => {
    const r = checkIdentifiers({
      text: 'Connection `fae2e145-1234-4a2b-9c3d-123456789012` is healthy.',
      citations: sources('[{"id":"fae2e145-1234-4a2b-9c3d-123456789012","status":"connected"}]'),
    });
    expect(r.status).toBe('passed');
  });

  it('flags a UUID that appears in no evidence', () => {
    const r = checkIdentifiers({
      text: 'Service `aaaaaaaa-1234-1234-1234-aaaaaaaaaaaa` was redeployed.',
      evidence: [{ id: 'dep_42', status: 'SUCCESS' }],
    });
    expect(r.status).toBe('failed');
    expect(r.unbacked[0]?.kind).toBe('uuid');
    expect(r.unbacked[0]?.token).toBe('aaaaaaaa-1234-1234-1234-aaaaaaaaaaaa');
  });

  it('reports a repeated invented UUID once', () => {
    const r = checkIdentifiers({
      text: 'Record `aaaaaaaa-1234-1234-1234-aaaaaaaaaaaa` was merged into `aaaaaaaa-1234-1234-1234-aaaaaaaaaaaa`.',
      evidence: [{ id: 'dep_42' }],
    });
    expect(r.unbacked).toHaveLength(1);
  });
});

describe('checkIdentifiers: URLs', () => {
  it('allows a public documentation host', () => {
    const r = checkIdentifiers({ text: 'See https://github.com/example/widgets/issues for the full list.' });
    expect(r.status).toBe('passed');
  });

  it('allows subdomains of an allowed host', () => {
    const r = checkIdentifiers({ text: 'Reference: https://docs.github.com/en/rest/commits/commits' });
    expect(r.status).toBe('passed');
  });

  it('flags a URL on an unknown host with no evidence', () => {
    const r = checkIdentifiers({ text: 'Dashboard is live at https://internal.acme.example/d/sales-overview' });
    expect(r.status).toBe('failed');
    expect(r.unbacked[0]?.kind).toBe('url');
  });

  it('passes an unknown-host URL that is in the evidence', () => {
    const r = checkIdentifiers({
      text: 'Dashboard is live at https://internal.acme.example/d/sales-overview',
      citations: sources('Widget links to https://internal.acme.example/d/sales-overview'),
    });
    expect(r.status).toBe('passed');
  });

  it('honours a custom host list, including an empty one', () => {
    const text = 'See https://github.com/example/widgets for details.';
    expect(checkIdentifiers({ text, allowedHosts: [] }).status).toBe('failed');
    expect(
      checkIdentifiers({ text: 'See https://wiki.acme.example/x', allowedHosts: ['acme.example'] }).status,
    ).toBe('passed');
  });
});

describe('checkIdentifiers: mixed and edge cases', () => {
  it('flags only the invented identifier when the prose has several', () => {
    const r = checkIdentifiers({
      text: `Commit \`${FULL_SHA}\` is real, but \`aaaaaaaa-1234-1234-1234-aaaaaaaaaaaa\` is invented.`,
      evidence: [{ sha: FULL_SHA }],
    });
    expect(r.status).toBe('failed');
    expect(r.unbacked).toHaveLength(1);
    expect(r.unbacked[0]?.kind).toBe('uuid');
  });

  it('skips prose with no identifier-shaped tokens', () => {
    const r = checkIdentifiers({
      text: 'The deployment completed successfully and the service is now live.',
      evidence: [{ id: 'dep_42' }],
    });
    expect(r.status).toBe('skipped');
    expect(r.scanned).toBe(0);
  });

  it('skips empty or missing text', () => {
    expect(checkIdentifiers({ text: '' }).status).toBe('skipped');
    expect(checkIdentifiers({ text: undefined as unknown as string }).status).toBe('skipped');
  });

  it('does not flag long English words', () => {
    const r = checkIdentifiers({
      text: 'The implementation requires understanding documentation and reading specification carefully.',
    });
    expect(r.status).not.toBe('failed');
  });

  it('does not flag hyphenated English compounds', () => {
    const r = checkIdentifiers({
      text: 'All listings are classified as opportunity-type, each a well-designed-home with a two-bedroom-dwelling.',
      evidence: [{ listings: [{ name: 'Plot A', agent: 'Acme Ltd' }] }],
    });
    expect(r.unbacked).toHaveLength(0);
  });

  it('does not flag capitalised hyphenated compounds', () => {
    const r = checkIdentifiers({
      text: 'There are no Antarctica-related or London-based suppliers in your list.',
      evidence: [{ suppliers: [{ name: 'Plot A' }] }],
    });
    expect(r.unbacked).toHaveLength(0);
  });

  it('does not flag compounds whose segments are short acronyms', () => {
    const r = checkIdentifiers({
      text: 'The repo crud-database-mcp exposes a rest-api-sql surface.',
      evidence: [{ repos: [{ name: 'svc' }] }],
    });
    expect(r.unbacked).toHaveLength(0);
  });

  it('flags an unpronounceable lower-case hyphenated token', () => {
    const r = checkIdentifiers({
      text: 'The shard key is xkcd-qwrtp-zxcvbn-fghjkl in the cluster.',
      evidence: [{ id: 'dep_42' }],
    });
    expect(r.status).toBe('failed');
  });

  it('flags a mixed-case opaque id', () => {
    const r = checkIdentifiers({
      text: 'Customer cus_Qz8Lr3xJ2gExample9 was billed.',
      evidence: [{ id: 'dep_42' }],
    });
    expect(r.status).toBe('failed');
    expect(r.unbacked[0]?.kind).toBe('long_id');
  });

  it('survives unserialisable evidence', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const r = checkIdentifiers({ text: `Commit ${FULL_SHA} shipped.`, evidence: [circular, { sha: FULL_SHA }] });
    expect(r.status).toBe('passed');
  });
});
