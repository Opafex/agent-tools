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
 *      the registrable domain of one of its addresses does, so a page on
 *      `www.acme.co.uk` grounds `mail.acme.co.uk`.
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

/** Lower case, `&` as "and", every other character that is not a letter or digit a space. */
function normalise(text: string): string {
  return lower(text).replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function nameCore(name: string): string {
  const words = normalise(name).split(' ').filter(Boolean);
  while (words.length > 1 && NOISE.has(words[words.length - 1])) words.pop();
  while (words.length > 1 && NOISE.has(words[0])) words.shift();
  return words.join(' ');
}

/** The evidence, padded so a phrase can be matched on word boundaries. */
function itemEvidence(raw: string): string {
  // A mask is not a word, and a newline escaped inside a JSON result would
  // otherwise leave its `n` stuck to the next word.
  const text = raw.split(ECHO_MASK).join(' ').replace(/\\[nrt]/g, ' ');
  return ` ${normalise(text)} `;
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

function addressNamed(address: string, evidence: string): boolean {
  const host = hostOf(address);
  // A host with no dot is a word, and any common word is in the evidence.
  if (host === null || !host.includes('.')) return false;
  return evidence.includes(` ${normalise(registrableDomain(host))} `);
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
  const evidence = itemEvidence(
    argumentEvidence(transcript, call?.tool, { systemEvidence: options.systemEvidence ?? 'none' }),
  );
  const ungrounded: UngroundedItem[] = [];
  let checked = 0;
  items.forEach((item, i) => {
    const name = typeof item === 'string' ? item.trim() : stringField(item, declaration.field);
    const addresses = (declaration.addressFields ?? []).map((f) => stringField(item, f)).filter(Boolean);
    const core = nameCore(name);
    if (!core && addresses.length === 0) return;
    checked += 1;
    if (core && evidence.includes(` ${core} `)) return;
    if (addresses.some((a) => addressNamed(a, evidence))) return;
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
