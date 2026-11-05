/**
 * Grounded items: list arguments that must have come from somewhere.
 *
 * `checkToolArguments` looks for identifier-shaped values, so it cannot see a
 * firm's name. This check is for the list a tool declares: each item names
 * something, and the person or another tool must have named it first.
 *
 * The failure: every web search in a turn failed, and the agent passed seventeen
 * firms it had supplied itself to a tool that checks whether a firm has been
 * contacted. The tool reported each one as new, and the reply offered them as
 * targets. No value in the call had an identifier's shape, so nothing stopped it.
 *
 * Method (deterministic, no model call):
 *   1. Read the declared array argument. An item is a bare string (the name) or
 *      an object holding the name in `field` and, optionally, web addresses in
 *      `addressFields`.
 *   2. Build the evidence from the transcript (see `argumentEvidence`), with no
 *      system turns by default: a prompt's examples are not firms anyone found.
 *   3. An item passes when its name, less words that do not tell one firm from
 *      another ("Ltd", "The"), occurs in the evidence on word boundaries, or when
 *      the registrable domain of one of its addresses is the registrable domain
 *      of a host in the evidence, so a page on `www.acme.co.uk` grounds
 *      `mail.acme.co.uk`, and a page on `not-acme.co.uk` does not.
 *
 * Refuse the call when the result fails, and send `message` back to the model as
 * the tool result. Never repair the call by dropping the items it named.
 */

import type { ToolCall } from './arguments.js';
import { hostOf, registrableDomain } from './domains.js';
import { ECHO_MASK } from './echoes.js';
import { lower } from './text.js';
import { argumentEvidence, type EvidenceOptions, type TranscriptTurn } from './transcript.js';

export interface GroundedItemsDeclaration {
  /** The array argument whose items must be grounded. */
  param: string;
  /** The item field holding the name, e.g. `name`. A bare-string item is the name. */
  field: string;
  /** Item fields holding a web address or email address; its domain being named grounds the item. */
  addressFields?: readonly string[];
}

export interface GroundedItemsOptions extends EvidenceOptions {
  /**
   * Which `system` turns count. Default `'none'`, unlike `checkToolArguments`:
   * an operator's prompt really does hold the owner's address, but a name in it
   * is an example, not something found.
   */
  systemEvidence?: EvidenceOptions['systemEvidence'];
}

export interface UngroundedItem {
  /** Which item it was, e.g. `firms[2]`. */
  path: string;
  /** Its name, or its address when it had no name. */
  value: string;
}

export interface GroundedItemsResult {
  /** `skipped` when the call carried no item with a name or an address. */
  status: 'passed' | 'failed' | 'skipped';
  /** Items checked. */
  checked: number;
  ungrounded: UngroundedItem[];
  /** A refusal to send back to the model as the tool result; empty unless `failed`. */
  message: string;
}

/** Words that do not tell one firm from another. */
const NOISE = new Set(['the', 'ltd', 'limited', 'plc', 'llp', 'llc', 'inc', 'uk', 'group', 'co', 'company']);

/**
 * Lower case, one encoding of each accent, `&` as "and", every character that is
 * not part of a word a space. A combining mark is part of its word.
 */
function normalise(text: string): string {
  return lower(text).normalize('NFC').replace(/&/g, ' and ').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

function nameCore(name: string): string {
  const all = normalise(name).split(' ').filter(Boolean);
  const words = [...all];
  while (words.length > 1 && NOISE.has(words[words.length - 1])) words.pop();
  while (words.length > 1 && NOISE.has(words[0])) words.shift();
  // Made only of such words, what is left would be grounded by nearly any sentence.
  return (NOISE.has(words[0]) ? all : words).join(' ');
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

function itemsOf(args: unknown, param: string): unknown[] {
  let root = args;
  if (typeof root === 'string') {
    try {
      root = JSON.parse(root);
    } catch {
      return [];
    }
  }
  if (!root || typeof root !== 'object') return [];
  const items = (root as Record<string, unknown>)[param];
  return Array.isArray(items) ? items : [];
}

function stringField(item: unknown, field: string): string {
  if (!item || typeof item !== 'object') return '';
  const value = (item as Record<string, unknown>)[field];
  return typeof value === 'string' ? value.trim() : '';
}

function addressNamed(address: string, domains: ReadonlySet<string>): boolean {
  const host = hostOf(address);
  return host !== null && domains.has(registrableDomain(host));
}

export function ungroundedItemsMessage(items: readonly UngroundedItem[]): string {
  const list = items.map((i) => i.value).join(', ');
  const one = items.length === 1;
  return (
    `Refused: ${list} ${one ? 'appears' : 'appear'} in no message from the user and in no tool result, ` +
    `so ${one ? 'it was' : 'they were'} supplied by you. Nothing was run. Pass only what the user or a tool actually named. ` +
    'If your searches failed or found nothing, say so to the user and do not fill the gap from memory.'
  );
}

/** Check one proposed tool call's declared list before it runs. Pure. */
export function checkGroundedItems(
  input: { call: ToolCall; transcript: readonly TranscriptTurn[]; declaration: GroundedItemsDeclaration },
  options: GroundedItemsOptions = {},
): GroundedItemsResult {
  const { call, transcript, declaration } = input;
  const items = itemsOf(call?.args, declaration.param);
  const text = evidenceText(
    argumentEvidence(transcript, call?.tool, { systemEvidence: options.systemEvidence ?? 'none' }),
  );
  // Padded so a phrase can be matched on word boundaries.
  const evidence = ` ${normalise(text)} `;
  const domains = declaration.addressFields?.length ? domainsIn(text) : new Set<string>();
  const ungrounded: UngroundedItem[] = [];
  let checked = 0;
  items.forEach((item, i) => {
    const name = typeof item === 'string' ? item.trim() : stringField(item, declaration.field);
    const addresses = (declaration.addressFields ?? []).map((f) => stringField(item, f)).filter(Boolean);
    const core = nameCore(name);
    if (!core && addresses.length === 0) return;
    checked += 1;
    if (core && evidence.includes(` ${core} `)) return;
    if (addresses.some((a) => addressNamed(a, domains))) return;
    ungrounded.push({ path: `${declaration.param}[${i}]`, value: name || addresses[0] });
  });
  if (checked === 0) return { status: 'skipped', checked: 0, ungrounded: [], message: '' };
  return {
    status: ungrounded.length > 0 ? 'failed' : 'passed',
    checked,
    ungrounded,
    message: ungrounded.length > 0 ? ungroundedItemsMessage(ungrounded) : '',
  };
}
