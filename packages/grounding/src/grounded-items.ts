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
 *   3. An item passes when its name was found (see `found-values.ts`: a name on
 *      whole words, and a name that is really an address as an address), or when
 *      the registrable domain of one of its addresses is the registrable domain
 *      of a host in the evidence, so a page on `www.acme.co.uk` grounds
 *      `mail.acme.co.uk`, and a page on `not-acme.co.uk` does not.
 *
 * Refuse the call when the result fails, and send `message` back to the model as
 * the tool result. Never repair the call by dropping the items it named.
 */

import type { ToolCall } from './arguments.js';
import {
  argumentsOf,
  domainFound,
  foundEvidence,
  groundedResult,
  nameCore,
  valueFound,
  type GroundedOptions,
  type GroundedResult,
} from './found-values.js';
import type { TranscriptTurn } from './transcript.js';

export interface GroundedItemsDeclaration {
  /** The array argument whose items must be grounded. */
  param: string;
  /** The item field holding the name, e.g. `name`. A bare-string item is the name. */
  field: string;
  /** Item fields holding a web address or email address; its domain being named grounds the item. */
  addressFields?: readonly string[];
}

export type GroundedItemsOptions = GroundedOptions;

export interface UngroundedItem {
  /** Which item it was, e.g. `firms[2]`. */
  path: string;
  /** Its name, or its address when it had no name. */
  value: string;
}

export type GroundedItemsResult = GroundedResult<UngroundedItem>;

function stringField(item: unknown, field: string): string {
  if (!item || typeof item !== 'object') return '';
  const value = (item as Record<string, unknown>)[field];
  return typeof value === 'string' ? value.trim() : '';
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
  const list = argumentsOf(call?.args)?.[declaration.param];
  const items = Array.isArray(list) ? list : [];
  const evidence = foundEvidence(transcript, call?.tool, options);
  const ungrounded: UngroundedItem[] = [];
  let checked = 0;
  items.forEach((item, i) => {
    const name = typeof item === 'string' ? item.trim() : stringField(item, declaration.field);
    const addresses = (declaration.addressFields ?? []).map((f) => stringField(item, f)).filter(Boolean);
    const named = nameCore(name) !== '';
    if (!named && addresses.length === 0) return;
    checked += 1;
    if (named && valueFound(name, evidence)) return;
    if (addresses.some((a) => domainFound(a, evidence))) return;
    ungrounded.push({ path: `${declaration.param}[${i}]`, value: name || addresses[0] });
  });
  return groundedResult(checked, ungrounded, ungroundedItemsMessage);
}
