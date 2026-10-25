/**
 * Fabricated identifiers.
 *
 * The failure: the agent's prose states an identifier (a commit hash, a UUID,
 * a URL, an opaque record id) that no tool returned. Typically it has
 * paraphrased something from memory or context as if it were observed data,
 * and the invented value then travels downstream as fact.
 *
 * Identifiers are the highest-precision signal there is. A 40-character hash
 * either appears in a tool result or it does not, and ordinary prose almost
 * never contains one by accident.
 *
 * Method (deterministic, no model call):
 *   1. Extract identifier-shaped tokens from the prose: UUIDs, URLs, hex
 *      hashes of 7 to 40 characters, and opaque ids of 16 or more characters.
 *   2. Pass a token if it occurs in the evidence, or it is a URL on an allowed
 *      public host (general documentation the agent may cite unprompted).
 *   3. Report every other token.
 *
 * Prose with no identifier-shaped tokens is reported as `skipped`, so you can
 * tell "nothing to check" apart from "checked and clean".
 */

import { appearsInEvidence, buildEvidenceText, type CitationIndex } from './evidence.js';
import { lower } from './text.js';

export type IdentifierKind = 'sha' | 'uuid' | 'url' | 'long_id';

export interface UnbackedIdentifier {
  /** The token exactly as it appears in the prose. */
  token: string;
  kind: IdentifierKind;
  /** Character offset in the prose. */
  index: number;
  /** Up to 80 characters of surrounding prose. */
  excerpt: string;
}

export interface IdentifierCheckResult {
  /** `skipped` when the prose holds no identifier-shaped token. */
  status: 'passed' | 'failed' | 'skipped';
  /** Identifier-shaped tokens found in the prose. */
  scanned: number;
  /** Tokens with no backing in the evidence, in reading order (at most 8). */
  unbacked: UnbackedIdentifier[];
}

export interface IdentifierCheckInput {
  /** The prose to check. */
  text: string;
  /** Tool results the agent received (strings, or values to JSON-serialise). */
  evidence?: readonly unknown[];
  /** Citation sources; their content counts as evidence. */
  citations?: CitationIndex;
  /**
   * Hosts whose URLs need no evidence. Subdomains are included, so
   * `github.com` also allows `docs.github.com`. Defaults to
   * `DEFAULT_ALLOWED_HOSTS`; pass an empty list to require evidence for every
   * URL.
   */
  allowedHosts?: Iterable<string>;
}

/**
 * Public documentation hosts an agent may reasonably cite without having
 * fetched them. Anything else, such as a URL on your own or a customer's
 * domain, needs evidence.
 */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = Object.freeze([
  'github.com',
  'developer.mozilla.org',
  'mdn.io',
  'stackoverflow.com',
  'wikipedia.org',
  'npmjs.com',
  'nodejs.org',
  'reactjs.org',
  'react.dev',
  'nextjs.org',
  'tailwindcss.com',
  'vercel.com',
  'prisma.io',
  'typescriptlang.org',
]);

const MAX_REPORTED = 8;

// Listed in priority order: the more specific shapes claim their character
// ranges first, so the catch-all long-id pattern never fires on a UUID's body.
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g;
const SHA_RE = /\b[0-9a-fA-F]{7,40}\b/g;
const LONG_ID_RE = /\b[A-Za-z0-9_-]{16,}\b/g;

/** Shorter than this and ordinary English words would match. */
const MIN_LONG_ID_LEN = 16;

/** Check that every identifier in the prose occurs in the evidence. Pure. */
export function checkIdentifiers(input: IdentifierCheckInput): IdentifierCheckResult {
  const { text } = input;
  if (!text || typeof text !== 'string') {
    return { status: 'skipped', scanned: 0, unbacked: [] };
  }
  const tokens = extractIdentifierTokens(text);
  if (tokens.length === 0) {
    return { status: 'skipped', scanned: 0, unbacked: [] };
  }

  const evidence = buildEvidenceText(input.evidence, input.citations);
  const hosts = [...(input.allowedHosts ?? DEFAULT_ALLOWED_HOSTS)].map(lower);
  const unbacked: UnbackedIdentifier[] = [];
  for (const tok of tokens) {
    if (tok.kind === 'url' && isAllowedHost(tok.token, hosts)) continue;
    if (appearsInEvidence(tok.token, evidence)) continue;
    if (unbacked.length < MAX_REPORTED) unbacked.push(tok);
  }

  return {
    status: unbacked.length === 0 ? 'passed' : 'failed',
    scanned: tokens.length,
    unbacked,
  };
}

/**
 * Extract identifier-shaped tokens, sorted by position. A repeated token is
 * reported once, and a character range claimed by one shape is never claimed
 * again by another.
 */
export function extractIdentifierTokens(text: string): UnbackedIdentifier[] {
  const seen = new Set<string>();
  const claimed: Array<[number, number]> = [];
  const out: UnbackedIdentifier[] = [];

  const overlapsClaimed = (start: number, end: number): boolean =>
    claimed.some(([s, e]) => start < e && end > s);

  const collect = (regex: RegExp, kind: IdentifierKind): void => {
    for (const match of text.matchAll(regex)) {
      if (typeof match.index !== 'number') continue;
      const token = match[0];
      const start = match.index;
      const end = start + token.length;
      if (overlapsClaimed(start, end)) continue;
      // Claim the range before the duplicate and English checks. Otherwise a
      // second mention of the same UUID is deduplicated here, but its hex
      // segments fall through to the hash and long-id passes and fire again.
      claimed.push([start, end]);
      if (seen.has(token)) continue;
      if (kind === 'long_id' && looksLikeEnglish(token)) continue;
      // An all-digit "hash" is a decimal number: a timestamp, a count, a
      // numeric id. Real hashes an agent quotes contain the letters a to f.
      if (kind === 'sha' && !/[a-fA-F]/.test(token)) continue;
      seen.add(token);
      out.push({ token, kind, index: start, excerpt: makeExcerpt(text, start, token.length) });
    }
  };

  collect(UUID_RE, 'uuid');
  collect(URL_RE, 'url');
  collect(SHA_RE, 'sha');
  collect(LONG_ID_RE, 'long_id');

  out.sort((a, b) => a.index - b.index);
  return out;
}

function makeExcerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 30);
  const fragment = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return fragment.length > 80 ? fragment.slice(0, 77) + '...' : fragment;
}

/**
 * Does a long token read as an English word or compound rather than an id?
 *
 * - Any digit means an id: English words do not embed digits.
 * - A hyphen or underscore compound is English when every segment is a plain
 *   word (an optional leading capital, then lower case) that has a vowel or is
 *   a short acronym of up to four letters. That passes "well-designed-home",
 *   "London-based" and "rest-api-sql", and still rejects internal-capital ids
 *   like `cus_Qz8Lr` and unpronounceable runs like `xkcd-qwrtp-zxcvbn`.
 * - A single run with mixed case is an id (camelCase or random).
 */
function looksLikeEnglish(token: string): boolean {
  if (token.length < MIN_LONG_ID_LEN) return true;
  if (/[0-9]/.test(token)) return false;
  if (/[_-]/.test(token)) {
    const segments = token.split(/[_-]+/).filter(Boolean);
    return segments.every((s) => /^[A-Z]?[a-z]+$/.test(s) && (/[aeiouy]/i.test(s) || s.length <= 4));
  }
  if (/[A-Z]/.test(token) && /[a-z]/.test(token)) return false;
  return true;
}

function isAllowedHost(url: string, hosts: readonly string[]): boolean {
  let host: string;
  try {
    host = lower(new URL(url).hostname);
  } catch {
    // Unparseable: fall through to the evidence check.
    return false;
  }
  return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
