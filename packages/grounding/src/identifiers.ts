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
 *      With `domains: true`, also bare web addresses written without a scheme
 *      ("acme.co.uk", "www.acme.com/pricing"), which is how a reply usually
 *      writes a website.
 *   2. Pass a token if it occurs in the evidence, or it is a URL on an allowed
 *      public host (general documentation the agent may cite unprompted).
 *   3. Report every other token.
 *
 * Prose with no identifier-shaped tokens is reported as `skipped`, so you can
 * tell "nothing to check" apart from "checked and clean".
 */

import { appearsInEvidence, buildEvidenceText, type CitationIndex } from './evidence.js';
import { lower } from './text.js';

export type IdentifierKind = 'sha' | 'uuid' | 'url' | 'domain' | 'long_id';

/** Which optional token shapes to extract. Every option defaults to off. */
export interface ExtractOptions {
  /**
   * Also extract bare domains ("acme.co.uk", "www.acme.com/pricing"). Off by
   * default because it widens what an existing caller flags: turn it on per
   * surface, and observe before enforcing.
   */
  domains?: boolean;
}

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
  /** Also check bare domains; see `ExtractOptions.domains`. Default false. */
  domains?: boolean;
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
/**
 * A hostname written without a scheme, with an optional path. Whether it is a
 * domain at all is decided by its last label (see `isDomainSuffix`), and the
 * character before it (see `collectDomains`).
 */
const DOMAIN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b(?:\/[^\s<>"'`)\]]*)?/gi;

/**
 * Generic top-level domains a website is commonly under. A last label outside
 * this list and longer than two letters is read as a file extension or a word
 * ("config.json", "Node.js", "next.config.mjs"), never as a domain.
 */
const GENERIC_TLDS = new Set([
  'com', 'net', 'org', 'edu', 'gov', 'int', 'info', 'biz', 'name', 'pro', 'app', 'dev', 'cloud', 'tech',
  'online', 'site', 'website', 'store', 'shop', 'agency', 'digital', 'studio', 'media', 'news', 'blog',
  'global', 'group', 'company', 'solutions', 'services', 'consulting', 'partners', 'legal', 'law',
  'finance', 'capital', 'health', 'care', 'email', 'live', 'life', 'world', 'space', 'xyz', 'design',
  'build', 'works', 'tools', 'systems', 'network', 'software', 'ltd', 'llc', 'inc', 'london', 'scot',
  'wales', 'cymru',
]);

/**
 * Two-letter endings that are far more often file extensions than country
 * domains in an agent's prose ("README.md", "build.sh", "main.py", "lib.rs").
 * A real site under one of these goes unchecked: a miss, never a false alarm.
 */
const FILE_EXTENSIONS_2 = new Set(['md', 'sh', 'py', 'js', 'ts', 'rs', 'rb', 'pl', 'ps', 'so', 'mm', 'ml', 'cc', 'hh', 'db', 'gz', 'xz', 'tf', 'pm', 'vb', 'fs', 'kt']);

/** Reserved names (RFC 2606, RFC 6761) used in examples, never anyone's site. */
const RESERVED_DOMAIN_RE = /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i;

function isDomainSuffix(tld: string): boolean {
  const t = lower(tld);
  if (t.length === 2) return !FILE_EXTENSIONS_2.has(t);
  return GENERIC_TLDS.has(t);
}

/** Shorter than this and ordinary English words would match. */
const MIN_LONG_ID_LEN = 16;

/** Check that every identifier in the prose occurs in the evidence. Pure. */
export function checkIdentifiers(input: IdentifierCheckInput): IdentifierCheckResult {
  const { text } = input;
  if (!text || typeof text !== 'string') {
    return { status: 'skipped', scanned: 0, unbacked: [] };
  }
  const tokens = extractIdentifierTokens(text, { domains: input.domains === true });
  if (tokens.length === 0) {
    return { status: 'skipped', scanned: 0, unbacked: [] };
  }

  const evidence = buildEvidenceText(input.evidence, input.citations);
  const hosts = [...(input.allowedHosts ?? DEFAULT_ALLOWED_HOSTS)].map(lower);
  const unbacked: UnbackedIdentifier[] = [];
  for (const tok of tokens) {
    if (tok.kind === 'url' && isAllowedHost(tok.token, hosts)) continue;
    if (tok.kind === 'domain' && isAllowedHost(`https://${tok.token}`, hosts)) continue;
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
export function extractIdentifierTokens(text: string, options: ExtractOptions = {}): UnbackedIdentifier[] {
  const seen = new Set<string>();
  const claimed: Array<[number, number]> = [];
  const out: UnbackedIdentifier[] = [];

  const overlapsClaimed = (start: number, end: number): boolean =>
    claimed.some(([s, e]) => start < e && end > s);

  const collect = (regex: RegExp, kind: IdentifierKind): void => {
    for (const match of text.matchAll(regex)) {
      if (typeof match.index !== 'number') continue;
      const token = kind === 'url' ? trimUrlToken(match[0]) : match[0];
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

  // A bare domain is claimed after URLs (so the host inside a URL is never a
  // second token) and before hashes and long ids (so "abcdef1234.com" is a
  // domain, not a hash).
  const collectDomains = (): void => {
    for (const match of text.matchAll(DOMAIN_RE)) {
      if (typeof match.index !== 'number') continue;
      const start = match.index;
      // Part of something longer: a path, a dotted name, a file path, a URL
      // the URL pass did not claim. "@" is allowed, so an email's domain counts.
      const before = start > 0 ? text[start - 1] : '';
      if (before && /[A-Za-z0-9._\/:-]/.test(before)) continue;
      const token = trimUrlToken(match[0]);
      const host = token.split('/')[0];
      const labels = host.split('.');
      if (!isDomainSuffix(labels[labels.length - 1])) continue;
      if (RESERVED_DOMAIN_RE.test(host)) continue;
      const end = start + token.length;
      if (overlapsClaimed(start, end)) continue;
      claimed.push([start, end]);
      const key = lower(token);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ token, kind: 'domain', index: start, excerpt: makeExcerpt(text, start, token.length) });
    }
  };

  collect(UUID_RE, 'uuid');
  collect(URL_RE, 'url');
  if (options.domains) collectDomains();
  collect(SHA_RE, 'sha');
  collect(LONG_ID_RE, 'long_id');

  out.sort((a, b) => a.index - b.index);
  return out;
}

/**
 * A URL as a reader would bound it, without the punctuation the prose put
 * after it. The URL pattern runs to the next space, so a markdown link inside
 * parentheses, `([example.com](https://example.com))`, would otherwise yield
 * `https://example.com))`: a string in no tool result, reported as invented.
 * Trailing sentence punctuation and emphasis are dropped; a closing bracket is
 * kept only when the URL itself opened one (`https://en.wikipedia.org/wiki/Foo_(bar)`).
 */
export function trimUrlToken(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url.slice(-1);
    if (last !== '' && '.,;:!?*_~'.includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const opener = last === ')' ? '(' : last === ']' ? '[' : last === '}' ? '{' : '';
    if (opener && url.split(opener).length < url.split(last).length) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

function makeExcerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 30);
  const fragment = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return fragment.length > 80 ? fragment.slice(0, 77) + '…' : fragment;
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
