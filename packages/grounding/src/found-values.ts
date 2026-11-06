/**
 * Found values: how a value in a tool call is compared with what was named.
 *
 * Shared by `checkGroundedItems`, `checkGroundedRows` and
 * `checkGroundedAddresses`, so a value that one of them refuses cannot pass
 * another for being written differently. There are three kinds of value, and
 * each is compared as what it is:
 *
 *   - an email address, whole: `smith@acme.co.uk` is not `john-smith@acme.co.uk`,
 *     and `jo@acme.com` is not `jo@acme.com.au`.
 *   - a web address, by registrable domain: `smith.co.uk` is not
 *     `john-smith.co.uk`, and `invented.com.` is not "any .com".
 *   - a name, on whole words, less the words that do not tell one firm from
 *     another.
 *
 * Comparing an address as words is what those failures have in common: once the
 * punctuation has gone, `smith co uk` sits inside `john smith co uk`. So the
 * evidence is read three ways, and an address never reaches the words.
 */

import { hostOf, registrableDomain } from './domains.js';
import { ECHO_MASK } from './echoes.js';
import { lower } from './text.js';
import { argumentEvidence, type EvidenceOptions, type TranscriptTurn } from './transcript.js';

export interface GroundedOptions extends EvidenceOptions {
  /**
   * Which `system` turns count. Default `'none'`, unlike `checkToolArguments`:
   * an operator's prompt really does hold the owner's address, but a name in it
   * is an example, not something found.
   */
  systemEvidence?: EvidenceOptions['systemEvidence'];
}

export interface GroundedResult<T> {
  /** `skipped` when the call carried nothing to check. */
  status: 'passed' | 'failed' | 'skipped';
  /** Values checked. */
  checked: number;
  ungrounded: T[];
  /** A refusal to send back to the model as the tool result; empty unless `failed`. */
  message: string;
}

/** What was named, read three ways. */
export interface FoundEvidence {
  /** Every word, padded so a phrase can be matched on word boundaries. */
  words: string;
  /** The registrable domain of every host. */
  domains: ReadonlySet<string>;
  /** Every email address, whole. */
  addresses: ReadonlySet<string>;
}

/** Words that do not tell one firm from another. */
const NOISE = new Set(['the', 'ltd', 'limited', 'plc', 'llp', 'llc', 'inc', 'uk', 'group', 'co', 'company']);

/** One address: a local part, "@" and a dotted domain with no empty label. */
const ADDRESS_RE = /^[^\s@<>,;"]+@[^\s@<>,;".]+(?:\.[^\s@<>,;".]+)+$/u;

/** A host's last label: letters, or the encoded form of an international one. */
const TOP_LEVEL_RE = /\.(?:\p{L}{2,}|xn--[a-z0-9-]+)$/u;

/**
 * Lower case, one encoding of each accent, `&` as "and", every character that is
 * not part of a word a space. A combining mark is part of its word.
 */
function normalise(text: string): string {
  return lower(text).normalize('NFC').replace(/&/g, ' and ').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

/** A name less the words that do not tell one firm from another. Empty when it has no words. */
export function nameCore(name: string): string {
  const all = normalise(name).split(' ').filter(Boolean);
  const words = [...all];
  while (words.length > 1 && NOISE.has(words[words.length - 1])) words.pop();
  while (words.length > 1 && NOISE.has(words[0])) words.shift();
  // Made only of such words, what is left would be grounded by nearly any sentence.
  return (NOISE.has(words[0]) ? all : words).join(' ');
}

/** `value` as one email address, lower-cased, or `null` when it is not one. */
export function addressOf(value: string): string | null {
  // A trailing full stop is punctuation, and leaves the same mailbox.
  const address = value.trim().replace(/^mailto:/i, '').replace(/\.+$/, '').normalize('NFC');
  return ADDRESS_RE.test(address) ? lower(address) : null;
}

/**
 * The recipients in a To or Cc value, each as written: split on commas, semicolons
 * and new lines, and reduced to what is inside `<...>`. A comma in a quoted display
 * name does not split it, unless the quote never closes: a quote left open must not
 * hide the addresses after it.
 */
export function recipientsIn(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && /[,;\n]/.test(ch)) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  const split = quoted ? value.split(/[,;\n]/) : parts;
  return split.map((part) => (part.match(/<([^<>]*)>\s*$/)?.[1] ?? part).trim()).filter(Boolean);
}

/** `value`'s host when the whole of it reads as a web address, or `null`. */
function webAddressOf(value: string): string | null {
  const text = value.trim();
  if (/\s/.test(text)) return null;
  const host = hostOf(text);
  return host !== null && TOP_LEVEL_RE.test(host) ? host : null;
}

/** The evidence as plain text. */
function evidenceText(raw: string): string {
  // A mask is not a word, and a character escaped inside a JSON result would
  // otherwise leave its letter stuck to the next word.
  return raw.split(ECHO_MASK).join(' ').replace(/\\[bfnrt]/g, ' ');
}

/**
 * The registrable domain of every host in the evidence. Compared as domains, not
 * as words: `not-acme.com` and `acme.com.other.net` hold the words of `acme.com`
 * and neither is it. A word at the end of a sentence has a dot and is no host,
 * and a number such as `0.1` names nothing.
 */
function domainsIn(text: string): Set<string> {
  const domains = new Set<string>();
  for (const token of text.split(/[^\p{L}\p{M}\p{N}._-]+/u)) {
    if (!token.includes('.')) continue;
    const host = hostOf(token);
    if (host?.includes('.') && /\p{L}/u.test(host)) domains.add(registrableDomain(host));
  }
  return domains;
}

/**
 * Every email address in the evidence, whole. Split rather than matched with a
 * pattern, so a long run of letters in a tool result costs one pass. A quote or a
 * full stop at either end of a token is punctuation around it.
 */
function addressesIn(text: string): Set<string> {
  const addresses = new Set<string>();
  for (const token of text.split(/[^\p{L}\p{M}\p{N}._%+'@-]+/u)) {
    if (!token.includes('@')) continue;
    const address = addressOf(token.replace(/^['.]+|['.]+$/g, ''));
    if (address) addresses.add(address);
  }
  return addresses;
}

/** Read the evidence a value passed to `tool` may be grounded in. */
export function foundEvidence(
  transcript: readonly TranscriptTurn[],
  tool: string,
  options: GroundedOptions = {},
): FoundEvidence {
  const text = evidenceText(argumentEvidence(transcript, tool, { systemEvidence: options.systemEvidence ?? 'none' }));
  return { words: ` ${normalise(text)} `, domains: domainsIn(text), addresses: addressesIn(text) };
}

/** Does `value`, which has a name core, occur in the evidence as what it is? */
export function valueFound(value: string, evidence: FoundEvidence): boolean {
  const address = addressOf(value);
  if (address) return evidence.addresses.has(address);
  const host = webAddressOf(value);
  if (host) return evidence.domains.has(registrableDomain(host));
  return evidence.words.includes(` ${nameCore(value)} `);
}

/** Was the domain of `address` (a web or email address) named? */
export function domainFound(address: string, evidence: FoundEvidence): boolean {
  const host = hostOf(address);
  return host !== null && evidence.domains.has(registrableDomain(host));
}

/** A call's arguments as an object, or `null`. Arguments may arrive as a JSON string. */
export function argumentsOf(args: unknown): Record<string, unknown> | null {
  let root = args;
  if (typeof root === 'string') {
    try {
      root = JSON.parse(root);
    } catch {
      return null;
    }
  }
  return root && typeof root === 'object' && !Array.isArray(root) ? (root as Record<string, unknown>) : null;
}

/** The result of a check that looked at `checked` values. */
export function groundedResult<T>(
  checked: number,
  ungrounded: T[],
  messageFor: (items: readonly T[]) => string,
): GroundedResult<T> {
  if (checked === 0) return { status: 'skipped', checked: 0, ungrounded: [], message: '' };
  const failed = ungrounded.length > 0;
  return { status: failed ? 'failed' : 'passed', checked, ungrounded, message: failed ? messageFor(ungrounded) : '' };
}
